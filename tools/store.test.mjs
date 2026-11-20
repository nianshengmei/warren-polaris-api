/* HttpStore 自测（临时目录 + fs 假宿主）。运行：node tools/store.test.mjs
 *
 * 最重要的一条断言是「改 A 段之后，B 段的每一个字节都没变」——
 * 这是这套设计对用户手写文件的唯一承诺；破了它，用户就会在 git 里看到满屏红色 diff。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const S = require('../ui/http-store.js');
const H = require('../ui/http-file.js');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURES = path.join(HERE, 'fixtures');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

/* 假宿主：签名与 sidecar 完全一致，只回 sidecar 会回的那些字段 */
function fsHost() {
  return {
    list: async (dir) => {
      const names = await fsp.readdir(dir).catch(() => []);
      const files = [];
      for (const n of names) {
        if (!/\.(http|rest)$/i.test(n)) continue;
        const p = path.join(dir, n);
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        files.push({ path: p, name: n, size: st.size, modified: Math.round(st.mtimeMs) });
      }
      return { dir, files };
    },
    read: async (p) => ({ path: p, content: await fsp.readFile(p, 'utf8'), name: path.basename(p), dir: path.dirname(p) }),
    stat: async (p) => {
      try {
        const st = await fsp.stat(p);
        return { path: p, exists: true, isDir: st.isDirectory(), size: st.size, modified: Math.round(st.mtimeMs) };
      } catch {
        return { path: p, exists: false, isDir: false, size: 0, modified: 0 };
      }
    },
    write: async (p, content) => { await fsp.writeFile(p, content, 'utf8'); return { path: p, written: true }; },
    rename: async (from, to, o) => {
      if (!o || !o.overwrite) {
        const st = await fsp.stat(to).catch(() => null);
        if (st) return { path: to, exists: true, renamed: false };
      }
      await fsp.rename(from, to);
      return { path: to, exists: false, renamed: true };
    },
    remove: async (p) => { await fsp.rm(p, { force: true }); return { path: p, removed: true }; },
    ensureDir: async (d) => { await fsp.mkdir(d, { recursive: true }); return { dir: d, ok: true }; },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-store-'));
}

function segTexts(text) {
  const g = S.segments(text);
  return g.segs.map((s) => g.lines.slice(s.start, s.end + 1).join(g.eol));
}

async function main() {
  const dir = tmpDir();
  for (const f of ['minimal.http', 'handwritten.http', 'with-ids.http', 'messy.http']) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  }
  const store = S.createStore(fsHost(), { dir });

  /* ---------- 列表 ---------- */
  await ok('list() 扫出 4 个 collection，按名排序，带解析结果', async () => {
    const list = await store.list();
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((c) => c.name), ['handwritten', 'messy', 'minimal', 'with-ids']);
    const hw = list.find((c) => c.name === 'handwritten');
    assert.equal(hw.requests.length, 4);
    assert.equal(list.find((c) => c.name === 'with-ids').fileId, '7f3a9c21');
  });

  await ok('list() 的 mtime 是毫秒级数字', async () => {
    const list = await store.list();
    for (const c of list) assert.ok(Number.isInteger(c.mtime) && c.mtime > 1e12, c.name + ' 的 mtime 异常');
  });

  /* ---------- 读 ---------- */
  await ok('read() 返回 text / parsed / mtime / eol', async () => {
    const r = await store.read(path.join(dir, 'messy.http'));
    assert.equal(r.parsed.requests.length, 4);
    assert.equal(r.eol, '\r\n', 'CRLF 文件要认出换行风格');
    assert.ok(r.text.includes('\r\n'));
  });

  /* ---------- 段落写回：核心断言 ---------- */
  await ok('改 A 段的 URL：只有 A 段变化，B 段字节完全一致', async () => {
    const p = path.join(dir, 'handwritten.http');
    const before = fs.readFileSync(p, 'utf8');
    const doc = H.parseHttpFile(before, { fileName: 'handwritten.http' });
    const target = doc.requests[1]; // 创建订单
    const res = await store.writeRequest(p, { line: target.line, method: 'POST', url: '{{baseUrl}}/orders/v2' });
    assert.equal(res.ok, true, JSON.stringify(res));

    const after = fs.readFileSync(p, 'utf8');
    assert.ok(after.includes('POST {{baseUrl}}/orders/v2'), '新 URL 要写进去');
    assert.ok(!after.includes('POST {{baseUrl}}/orders\n'), '旧 URL 要消失');

    const a = segTexts(before);
    const b = segTexts(after);
    assert.equal(b.length, a.length, '段数不能变');
    assert.notEqual(a[1], b[1], '目标段应当变化');
    [0, 2, 3].forEach((i) => assert.equal(b[i], a[i], '第 ' + (i + 1) + ' 段被误改'));
  });

  await ok('段落写回保留该段末尾原有的空行数量', async () => {
    const p = path.join(dir, 'handwritten.http');
    const before = fs.readFileSync(p, 'utf8');
    const doc = H.parseHttpFile(before, { fileName: 'handwritten.http' });
    const res = await store.writeRequest(p, { line: doc.requests[0].line, method: 'GET', url: '{{baseUrl}}/orders?page=2' });
    assert.equal(res.ok, true);
    const after = fs.readFileSync(p, 'utf8');
    assert.match(after, /Authorization: Bearer \{\{token\}\}\n\n\n\n### 创建订单/, '第一段后面原有的 3 个空行要留着');
  });

  await ok('CRLF 文件写回后仍然是 CRLF，且不混用 LF', async () => {
    const p = path.join(dir, 'messy.http');
    const doc = H.parseHttpFile(fs.readFileSync(p, 'utf8'), { fileName: 'messy.http' });
    const res = await store.writeRequest(p, { line: doc.requests[3].line, method: 'GET', url: 'https://example.com/d2' });
    assert.equal(res.ok, true);
    const buf = fs.readFileSync(p);
    const text = buf.toString('utf8');
    assert.ok(text.includes('https://example.com/d2'));
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length;
    assert.equal(crlf, lf, '所有换行都必须是 CRLF，不能混进裸 LF');
  });

  await ok('补身份行：写回时带 interfaceId，请求数与身份都可读回', async () => {
    const p = path.join(dir, 'minimal.http');
    const doc = H.parseHttpFile(fs.readFileSync(p, 'utf8'), { fileName: 'minimal.http' });
    const target = doc.requests[0];
    const res = await store.writeRequest(p, { line: target.line, method: target.method, url: target.url }, { interfaceId: 'if000123' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = H.parseHttpFile(fs.readFileSync(p, 'utf8'), { fileName: 'minimal.http' });
    assert.equal(after.requests.length, 1, '补 id 不能多出/少掉请求');
    assert.equal(after.requests[0].interfaceId, 'if000123');
    assert.equal(after.requests[0].url, 'https://example.com/ping');
    assert.match(fs.readFileSync(p, 'utf8'), /^### 最简请求\n# @interface_id if000123/m);
  });

  await ok('mtime 冲突：baseMtime 过期直接 CONFLICT，且文件不被改', async () => {
    const p = path.join(dir, 'with-ids.http');
    const doc = H.parseHttpFile(fs.readFileSync(p, 'utf8'), { fileName: 'with-ids.http' });
    const before = fs.readFileSync(p, 'utf8');
    const res = await store.writeRequest(p, { line: doc.requests[0].line, method: 'POST', url: 'https://x/y' }, { baseMtime: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'CONFLICT');
    assert.equal(fs.readFileSync(p, 'utf8'), before, '冲突时一个字节都不能动');
  });

  await ok('定位不到段：NOT_FOUND，不乱改别的段', async () => {
    const p = path.join(dir, 'with-ids.http');
    const before = fs.readFileSync(p, 'utf8');
    const res = await store.writeRequest(p, { method: 'PUT', url: 'https://nope/nope' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'NOT_FOUND');
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  await ok('原子写：写完后同目录不残留 .tmp', async () => {
    const p = path.join(dir, 'handwritten.http');
    const doc = H.parseHttpFile(fs.readFileSync(p, 'utf8'), { fileName: 'handwritten.http' });
    await store.writeRequest(p, { line: doc.requests[2].line, method: 'DELETE', url: '{{baseUrl}}/orders/9002' });
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  /* ---------- CRUD ---------- */
  await ok('createCollection：中文名保留，重名不覆盖', async () => {
    const a = await store.createCollection('用户中心');
    assert.equal(a.ok, true);
    assert.ok(fs.existsSync(a.path));
    assert.equal(path.basename(a.path), '用户中心.http');
    const b = await store.createCollection('用户中心');
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'EXISTS');
    const list = await store.list();
    assert.ok(list.some((c) => c.name === '用户中心'));
  });

  await ok('createCollection：非法字符被替换成下划线', async () => {
    const a = await store.createCollection('a/b:c*?');
    assert.equal(a.ok, true);
    assert.equal(path.basename(a.path), 'a_b_c__.http');
  });

  await ok('renameCollection：改名后内容不变、旧文件消失', async () => {
    const p = path.join(dir, 'minimal.http');
    const before = fs.readFileSync(p, 'utf8');
    const r = await store.renameCollection(p, 'Ping 测试');
    assert.equal(r.ok, true);
    assert.equal(path.basename(r.path), 'Ping 测试.http');
    assert.equal(fs.readFileSync(r.path, 'utf8'), before);
    assert.ok(!fs.existsSync(p));
  });

  await ok('renameCollection：目标已存在则拒绝，两个文件都还在', async () => {
    const r = await store.renameCollection(path.join(dir, 'Ping 测试.http'), '用户中心');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'EXISTS');
    assert.ok(fs.existsSync(path.join(dir, 'Ping 测试.http')));
    assert.ok(fs.existsSync(path.join(dir, '用户中心.http')));
  });

  await ok('deleteCollection 删掉文件，list 里消失', async () => {
    const p = path.join(dir, 'Ping 测试.http');
    const r = await store.deleteCollection(p);
    assert.equal(r.ok, true);
    const list = await store.list();
    assert.ok(!list.some((c) => c.name === 'Ping 测试'));
  });

  await ok('empty 文件（0 个请求）也能列出来，不报错', async () => {
    await store.createCollection('空集合');
    const list = await store.list();
    const c = list.find((x) => x.name === '空集合');
    assert.ok(c);
    assert.equal(c.requests.length, 0);
    assert.equal(c.error, null);
  });

  await ok('sanitizeName / joinPath 的边界', () => {
    assert.equal(S.sanitizeName('  ..a  '), 'a');
    assert.equal(S.sanitizeName(''), 'collection');
    assert.equal(S.joinPath('C:\\a\\b\\', 'x.http'), 'C:\\a\\b\\x.http');
    assert.equal(S.joinPath('/a/b', 'x.http'), '/a/b/x.http');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' checks passed');
}

main().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
