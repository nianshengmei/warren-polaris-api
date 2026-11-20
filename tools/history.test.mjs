/* http-history.js 自测。运行：node tools/history.test.mjs
 * S4.2 只验两件事：身份先落盘、历史后落盘；身份写不进去就绝不产生 jsonl。
 * 只读夹具不用 chmod 0444 —— 测试常在 root 下跑，root 无视权限位会写出假绿；
 * 改成注入一个 write 必抛 EACCES 的宿主，语义等价且稳定。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fsHost } from './fs-host.mjs';

const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');
const I = require('../ui/http-identity.js');
const S = require('../ui/http-store.js');
const HIST = require('../ui/http-history.js');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

const SAMPLE = `@baseUrl = https://api.example.com

### 登录
# @name login
POST {{baseUrl}}/login
Content-Type: application/json

{"user":"admin"}

### 取用户
GET {{baseUrl}}/users
`;

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-hist-')); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }
function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function histFiles(dir) {
  const hd = path.join(dir, '_history');
  if (!fs.existsSync(hd)) return [];
  const out = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(p);
    }
  })(hd);
  return out;
}
const resp = (o) => Object.assign({ status: 200, ok: true, timeMs: 42, size: 128, contentType: 'application/json' }, o || {});

/* 一次完整的"发送成功"：path/req/response，其余由 record 自己读磁盘 */
function req(over) {
  return Object.assign({ line: 5, method: 'POST', url: '{{baseUrl}}/login', name: 'login' }, over || {});
}

async function main() {
  await ok('首次记录：先补 file_id + interface_id，再写一行 jsonl，两边 id 一致', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp(), url: 'https://api.example.com/login' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.match(r.fileId, /^[0-9a-z]{8}$/);
    assert.match(r.interfaceId, /^[0-9a-z]{8}$/);

    /* 文件里恰好各一行身份，且能解析回同一个 id */
    const text = fs.readFileSync(p, 'utf8');
    assert.equal((text.match(/@file_id/g) || []).length, 1);
    assert.equal((text.match(/@interface_id/g) || []).length, 1);
    const parsed = H.parseHttpFile(text);
    assert.equal(parsed.fileId, r.fileId);
    assert.equal(parsed.requests.length, 2);
    assert.equal(parsed.requests[0].interfaceId, r.interfaceId);
    assert.equal(parsed.requests[1].interfaceId, undefined);
    assert.deepEqual(parsed.warnings, []);

    /* jsonl 路径与内容 */
    assert.equal(r.historyPath, path.join(dir, '_history', 'demo', r.interfaceId + '.jsonl'));
    assert.equal(r.lines, 1);
    const rows = readJsonl(r.historyPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].interfaceId, parsed.requests[0].interfaceId);   // 验收原句
    assert.equal(rows[0].fileId, parsed.fileId);
    assert.equal(rows[0].status, 200);
    assert.equal(rows[0].method, 'POST');
    assert.equal(rows[0].url, 'https://api.example.com/login');
    assert.equal(rows[0].urlTemplate, '{{baseUrl}}/login');
    assert.equal(rows[0].fingerprint, 'POST {{baseUrl}}/login');
    assert.equal(rows[0].file, 'demo.http');
    assert.equal(rows[0].name, 'login');
    assert.ok(rows[0].at > 1600000000000);
  });

  await ok('第二次记录：身份行不重复插，jsonl 追加到同一文件', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp() });
    const before = fs.readFileSync(p, 'utf8');
    const r2 = await h.record({
      path: p, req: req({ interfaceId: r1.interfaceId }), response: resp({ status: 201 })
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, '第二次不该再改文件');
    assert.equal(fs.readFileSync(p, 'utf8'), before);
    assert.equal(r2.interfaceId, r1.interfaceId);
    assert.equal(r2.lines, 2);
    const rows = readJsonl(r2.historyPath);
    assert.deepEqual(rows.map((x) => x.status), [200, 201]);
  });

  await ok('文件只读：返回 READONLY，一个 jsonl 都不产生，文件原样', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    const ro = fsHost({
      write: async () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    });
    const store = S.createStore(ro, { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'READONLY');
    assert.deepEqual(histFiles(dir), []);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  await ok('写入冲突：重读后重试，第二次成功，且只产生一条历史', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const base = fsHost();
    let stats = 0;
    const tricky = fsHost({
      stat: async (q) => {
        stats++;
        if (stats === 2) {          /* readDoc 之后、writeText 比对之前：把文件改脏 */
          const st = await fsp.stat(q);
          const t = new Date(st.mtimeMs + 5000);
          await fsp.utimes(q, t, t);
        }
        return base.stat(q);
      }
    });
    const store = S.createStore(tricky, { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.ok(stats >= 3, '应当发生过重试');
    assert.equal(readJsonl(r.historyPath).length, 1);
    /* 重试后写进去的身份与历史仍然对得上 */
    const parsed = H.parseHttpFile(fs.readFileSync(p, 'utf8'));
    assert.equal(parsed.requests[0].interfaceId, r.interfaceId);
    assert.equal(readJsonl(r.historyPath)[0].interfaceId, r.interfaceId);
  });

  await ok('没有绑定文件：NOT_FILE，不碰磁盘', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ req: req(), response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NOT_FILE');
    assert.deepEqual(histFiles(dir), []);
  });

  await ok('段找不到：NO_SEGMENT，不写历史也不改文件', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: { line: 3, method: 'DELETE', url: 'x' }, response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_SEGMENT');
    assert.deepEqual(histFiles(dir), []);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  await ok('段里已有别的 id：历史记旧 id，文件不被覆盖', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, `### 甲\n# @interface_id keep0001\nGET https://a/1\n`);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: { line: 3, method: 'GET', url: 'https://a/1' }, response: resp() });
    assert.equal(r.ok, true);
    assert.equal(r.interfaceId, 'keep0001');
    const text = fs.readFileSync(p, 'utf8');
    assert.equal((text.match(/@interface_id/g) || []).length, 1);
    assert.match(text, /@interface_id keep0001/);
    assert.equal(readJsonl(r.historyPath)[0].interfaceId, 'keep0001');
  });

  await ok('历史按 collection 分目录，中文名与空格原样保留', async () => {
    const dir = mkdir();
    const p = path.join(dir, '示例 · 宠物店.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, true);
    assert.equal(r.historyPath, path.join(dir, '_history', '示例 · 宠物店', r.interfaceId + '.jsonl'));
    assert.equal(readJsonl(r.historyPath).length, 1);
  });

  await ok('时间戳可注入，缺省时用当前时间', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: req(), response: resp(), now: 1700000000123 });
    assert.equal(readJsonl(r.historyPath)[0].at, 1700000000123);
    const r2 = await h.record({ path: p, req: req({ interfaceId: r.interfaceId }), response: resp() });
    const rows = readJsonl(r2.historyPath);
    assert.ok(rows[1].at > 1700000000123);
  });

  console.log('\n' + pass + ' 项通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
