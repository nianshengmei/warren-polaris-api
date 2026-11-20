/* wpa-workspace.json 映射层自测（临时目录 + fs 假宿主）。运行：node tools/map.test.mjs
 *
 * 核心承诺：
 *   1. 映射只记「路径 → 文件夹」，读写它不许碰任何 .http；
 *   2. 首启登记是全量补齐，**绝不覆盖**用户已经排好的 folders；
 *   3. 目录外用绝对路径、目录内用相对路径，来回转换不丢信息。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const M = require('../ui/workspace-map.js');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

function fsHost() {
  return {
    list: async (dir) => {
      const names = await fsp.readdir(dir).catch(() => []);
      const files = [];
      for (const n of names) {
        const p = path.join(dir, n);
        const st = await fsp.stat(p).catch(() => null);
        if (!st || !st.isFile()) continue;
        files.push({ path: p, name: n, size: st.size, modified: Math.round(st.mtimeMs) });
      }
      return { dir, files };
    },
    read: async (p) => ({ path: p, content: await fsp.readFile(p, 'utf8') }),
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
      return { path: to, renamed: true };
    },
    remove: async (p) => { await fsp.rm(p, { force: true }); return { path: p, removed: true }; },
    ensureDir: async (d) => { await fsp.mkdir(d, { recursive: true }); return { dir: d, ok: true }; },
  };
}

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), tag)); }

function seed(dir, names) {
  for (const n of names) fs.writeFileSync(path.join(dir, n), '### ' + n + '\nGET https://example.com/' + n + '\n', 'utf8');
}

async function main() {
  const dir = tmpDir('wpa-map-');
  const ext = tmpDir('wpa-map-ext-');
  const host = fsHost();
  const outside = path.join(ext, 'pay.http');
  fs.writeFileSync(outside, '### 外部\nGET https://pay.example.com/ping\n', 'utf8');

  /* ---------- 路径归一 ---------- */
  await ok('目录内 → 相对路径（正斜杠），目录外 → 绝对路径原样', () => {
    const inside = path.join(dir, 'orders.http');
    assert.equal(M.toEntry(dir, inside), 'orders.http');
    assert.equal(M.toEntry(dir, path.join(dir, 'sub', 'users.http')), 'sub/users.http');
    assert.equal(M.toEntry(dir, outside), outside, '外部文件必须保持绝对路径');
  });

  await ok('绝对路径 ↔ 相对路径来回转换不丢信息', () => {
    for (const e of ['orders.http', 'sub/users.http']) {
      const abs = M.toAbs(dir, e);
      assert.equal(M.pathKey(M.toEntry(dir, abs)), M.pathKey(e));
    }
    assert.equal(M.pathKey(M.toAbs(dir, M.toEntry(dir, outside))), M.pathKey(outside));
  });

  await ok('isAbs 认盘符、UNC、Unix 根，不认相对路径', () => {
    assert.equal(M.isAbs('C:\\a\\b.http'), true);
    assert.equal(M.isAbs('/a/b.http'), true);
    assert.equal(M.isAbs('\\\\server\\share\\a.http'), true);
    assert.equal(M.isAbs('a/b.http'), false);
    assert.equal(M.isAbs('./a.http'), false);
  });

  /* ---------- 读 ---------- */
  await ok('没有映射文件：返回空映射，exists=false，不算错误', async () => {
    const r = await M.load(host, dir);
    assert.equal(r.exists, false);
    assert.equal(r.error, null);
    assert.deepEqual(r.map.folders, []);
    assert.deepEqual(r.map.unfiled, []);
    assert.equal(r.map.version, 1);
  });

  await ok('映射被手改坏：不抛异常，回空映射 + BAD_JSON', async () => {
    const p = path.join(dir, M.FILE);
    fs.writeFileSync(p, '{ "folders": [ 坏掉了', 'utf8');
    const r = await M.load(host, dir);
    assert.equal(r.exists, true);
    assert.match(r.error, /^BAD_JSON/);
    assert.deepEqual(r.map.unfiled, []);
    fs.rmSync(p);
  });

  /* ---------- 首启登记 ---------- */
  seed(dir, ['orders.http', 'users.http', 'examples.http', 'notes.txt']);
  fs.writeFileSync(path.join(dir, M.FILE), '{}\n', 'utf8');

  await ok('首启全量登记：目录里 4 个 .http 进 unfiled，按名排序，.txt 与映射文件自己不算', async () => {
    const { map } = await M.load(host, dir);
    const r = await M.ensureRegistered(host, dir, map);
    assert.equal(r.changed, true);
    assert.deepEqual(r.added.slice().sort(), ['examples.http', 'orders.http', 'users.http'],
      '目录里只有 3 个 http 文件');
    assert.deepEqual(r.map.unfiled, ['examples.http', 'orders.http', 'users.http']);
    assert.deepEqual(r.map.folders, []);
    assert.equal(r.scanned, 3);
  });

  await ok('登记结果落盘后能原样读回（version/folders/unfiled 都在）', async () => {
    const { map } = await M.load(host, dir);
    const r = await M.ensureRegistered(host, dir, map);
    const w = await M.save(host, dir, r.map);
    assert.equal(w.ok, true, JSON.stringify(w));

    const txt = fs.readFileSync(path.join(dir, M.FILE), 'utf8');
    assert.ok(txt.trim().endsWith('}'), '应以 JSON 收尾');
    assert.ok(txt.endsWith('\n'), '文件末尾要有换行');

    const again = await M.load(host, dir);
    assert.equal(again.error, null);
    assert.deepEqual(again.map.unfiled, ['examples.http', 'orders.http', 'users.http']);
  });

  await ok('幂等：同一份目录再登记一次，added 为空且文本一字不变', async () => {
    const before = fs.readFileSync(path.join(dir, M.FILE), 'utf8');
    const { map } = await M.load(host, dir);
    const r = await M.ensureRegistered(host, dir, map);
    assert.deepEqual(r.added, []);
    assert.equal(r.changed, false);
    assert.equal(M.stringify(r.map), before);
  });

  /* ---------- 不覆盖已有 folders ---------- */
  await ok('已有 folders 不被覆盖：只往 unfiled 补缺，名字/顺序/折叠/文件顺序全保留', async () => {
    const preset = {
      version: 1,
      folders: [
        { name: '订单服务', collapsed: true, files: ['orders.http'] },
        { name: '用户中心', collapsed: false, files: [] },
      ],
      unfiled: ['examples.http'],
    };
    const r = await M.ensureRegistered(host, dir, preset);
    assert.deepEqual(r.added, ['users.http'], '只补没登记的那一个');
    assert.deepEqual(r.map.folders.map((f) => f.name), ['订单服务', '用户中心']);
    assert.equal(r.map.folders[0].collapsed, true);
    assert.deepEqual(r.map.folders[0].files, ['orders.http'], '已排好的顺序不能动');
    assert.deepEqual(r.map.unfiled, ['examples.http', 'users.http']);
  });

  await ok('外部文件登记后仍是绝对路径，resolve 能标出 outside', async () => {
    const preset = { version: 1, folders: [], unfiled: [M.toEntry(dir, outside)] };
    let r = await M.ensureRegistered(host, dir, preset);
    assert.equal(r.map.unfiled[0], outside, '绝对路径不许被改写成相对');

    await M.save(host, dir, r.map);
    const rd = await M.load(host, dir);
    assert.equal(rd.map.unfiled[0], outside);

    const tree = M.resolve(rd.map, dir, [outside, path.join(dir, 'orders.http')]);
    const node = tree.unfiled.find((x) => x.entry === outside);
    assert.equal(node.outside, true);
    assert.equal(node.exists, true);
    assert.equal(node.name, 'pay');
  });

  /* ---------- 未登记发现 ---------- */
  await ok('discover 只报磁盘上有、映射里没有的 .http', async () => {
    const { map } = await M.load(host, dir);
    seed(dir, ['newone.http']);
    const miss = await M.discover(host, dir, map);
    assert.deepEqual(miss.map((f) => f.name), ['newone.http']);
    fs.rmSync(path.join(dir, 'newone.http'));
  });

  /* ---------- 丢失文件 ---------- */
  await ok('映射指向的文件不存在 → exists=false 且计入 missing，绝不静默删除登记', async () => {
    const map = {
      version: 1,
      folders: [{ name: '旧的', collapsed: false, files: ['gone.http', 'orders.http'] }],
      unfiled: [],
    };
    const tree = M.resolve(map, dir, [path.join(dir, 'orders.http')]);
    assert.equal(tree.folders[0].files[0].exists, false);
    assert.equal(tree.folders[0].files[1].exists, true);
    assert.equal(tree.missing, 1);
    assert.equal(map.folders[0].files.length, 2, '原始映射不能被就地改掉');
  });

  await ok('不传磁盘清单时 exists=null（不知道 ≠ 找不到），不误报 missing', async () => {
    const tree = M.resolve({ folders: [{ name: 'a', files: ['x.http'] }], unfiled: [] }, dir, null);
    assert.equal(tree.folders[0].files[0].exists, null);
    assert.equal(tree.missing, 0);
  });

  /* ---------- 归位 / 排序 / 重新定位 ---------- */
  await ok('moveTo：拖进文件夹后原位置消失、新位置按 index 插入', () => {
    const m = { folders: [{ name: 'A', files: ['1.http', '2.http'] }], unfiled: ['3.http'] };
    const r = M.moveTo(m, '3.http', 'A', 1);
    assert.equal(r.ok, true);
    assert.deepEqual(r.map.unfiled, []);
    assert.deepEqual(r.map.folders[0].files, ['1.http', '3.http', '2.http']);
    assert.deepEqual(m.unfiled, ['3.http'], '传入的映射不该被就地改');
  });

  await ok('moveTo：folder=null 拖回根；未登记的文件返回 NOT_REGISTERED', () => {
    const m = { folders: [{ name: 'A', files: ['1.http'] }], unfiled: [] };
    const back = M.moveTo(m, '1.http', null);
    assert.deepEqual(back.map.unfiled, ['1.http']);
    const no = M.moveTo(m, 'nope.http', null);
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'NOT_REGISTERED');
  });

  await ok('relocate：找不到的旧路径换成新路径，位置不变', () => {
    const m = { folders: [{ name: 'A', files: ['old.http', '2.http'] }], unfiled: [] };
    const r = M.relocate(m, 'old.http', 'new.http');
    assert.equal(r.ok, true);
    assert.deepEqual(r.map.folders[0].files, ['new.http', '2.http']);
  });

  await ok('unregister 只摘登记，不碰文件', () => {
    const before = fs.readFileSync(path.join(dir, 'orders.http'), 'utf8');
    const m = { folders: [{ name: 'A', files: ['orders.http'] }], unfiled: [] };
    const r = M.unregister(m, 'orders.http');
    assert.equal(r.ok, true);
    assert.deepEqual(r.map.folders[0].files, []);
    assert.equal(fs.readFileSync(path.join(dir, 'orders.http'), 'utf8'), before);
  });

  /* ---------- 归一化的容错 ---------- */
  await ok('重复登记只留第一次；脏字段不炸；字符串以外的值被忽略', () => {
    const m = M.normalize({
      version: 99,
      folders: [{ files: ['a.http', 'a.http', '', null] }, null, { name: ' B ', files: 'not-array' }],
      unfiled: ['a.http', 'c.http'],
    });
    assert.deepEqual(m.folders[0].files, ['a.http']);
    assert.equal(m.folders[0].name, '未命名 1');
    assert.equal(m.folders[2].name, 'B');
    assert.deepEqual(m.folders[2].files, []);
    assert.deepEqual(m.unfiled, ['c.http'], '跨文件夹去重，先到先得');
    assert.equal(m.version, 1, 'version 永远是本版认识的 1');
  });

  await ok('Windows 形态路径比对不区分大小写', () => {
    assert.equal(M.pathKey('C:\\Work\\A.http'), M.pathKey('c:/work/a.http'));
    assert.equal(M.pathKey('/tmp/A.http') === M.pathKey('/tmp/a.http'), false);
  });

  /* ---------- 落盘细节 ---------- */
  await ok('save 是原子写：同目录不残留 .tmp，且不动任何 .http', async () => {
    const before = fs.readFileSync(path.join(dir, 'orders.http'), 'utf8');
    const r = await M.save(host, dir, { folders: [], unfiled: ['orders.http', 'users.http'] });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(fs.readFileSync(path.join(dir, 'orders.http'), 'utf8'), before);
  });

  await ok('stringify 固定键顺序：version → folders → unfiled，折叠态是布尔', () => {
    const txt = M.stringify({ folders: [{ name: 'A', files: ['a.http'] }], unfiled: [] });
    assert.match(txt, /^\{\n  "version": 1,\n  "folders": \[\n/);
    assert.match(txt, /"collapsed": false/);
    assert.ok(JSON.parse(txt).folders[0].files[0] === 'a.http');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
  console.log('\n' + pass + ' checks passed');
}

main().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
