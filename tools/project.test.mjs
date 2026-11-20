/* 文件 → 旧 UI 形状的投影自测。运行：node tools/project.test.mjs
 *
 * 这一步是为了让 S1.5 不必重写整棵侧栏：渲染代码继续吃 state.collections，
 * 只是数据来自磁盘。只要投影不丢字段，UI 就能原样切换数据源。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fsHost } from './fs-host.mjs';
const require = createRequire(import.meta.url);
const S = require('../ui/http-store.js');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURES = path.join(HERE, 'fixtures');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-proj-'));
  for (const f of ['handwritten.http', 'with-ids.http']) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  const store = S.createStore(fsHost(), { dir });
  const list = await store.list();
  const groups = S.toLegacyCollections(list, { blankRow: () => ({ id: 'b', on: true, k: '', v: '' }) });

  await ok('一个文件 → 一个分组，id 用路径（跨会话稳定）', () => {
    assert.equal(groups.length, 2);
    const g = groups.find((x) => x.name === 'with-ids');
    assert.equal(g.id, path.join(dir, 'with-ids.http'));
    assert.equal(g.fileId, '7f3a9c21');
    assert.ok(g.mtime > 1e12);
  });

  await ok('请求名取 ### 标题，方法 / URL 原样', () => {
    const g = groups.find((x) => x.name === 'handwritten');
    assert.deepEqual(g.requests.map((r) => r.name), ['查询订单列表', '创建订单', '删除订单', '健康检查']);
    assert.deepEqual(g.requests.map((r) => r.method), ['GET', 'POST', 'DELETE', 'GET']);
    assert.equal(g.requests[0].url, '{{baseUrl}}/orders?page=1&size=20');
  });

  await ok('headers 转成带 id/on 的行，末尾补一条空行（旧编辑器靠它加新行）', () => {
    const g = groups.find((x) => x.name === 'handwritten');
    const rows = g.requests[0].headers;
    assert.equal(rows.length, 3);
    assert.deepEqual([rows[0].k, rows[0].v], ['Accept', 'application/json']);
    assert.deepEqual([rows[1].k, rows[1].v], ['Authorization', 'Bearer {{token}}']);
    assert.equal(rows[2].k, '');
    assert.equal(rows[2].on, true);
    assert.ok(rows.every((r) => typeof r.id === 'string' && r.id.length > 0));
  });

  await ok('bodyType 映射：json→json，无体→none，multipart/file→text（旧编辑器只有这四型）', () => {
    const g = groups.find((x) => x.name === 'handwritten');
    assert.equal(g.requests[1].bodyType, 'json');
    assert.equal(g.requests[2].bodyType, 'none');
    assert.match(g.requests[1].body, /^\{\n\t"sku"/);
  });

  await ok('身份注释带进 httpSource，写回时不用再猜是哪一段', () => {
    const g = groups.find((x) => x.name === 'with-ids');
    assert.equal(g.requests[0].interfaceId, 'a1b2c3d4');
    assert.equal(g.requests[0].httpSource.interfaceId, 'a1b2c3d4');
    assert.equal(g.requests[0].httpSource.file, path.join(dir, 'with-ids.http'));
    assert.ok(g.requests[0].httpSource.line > 0);
  });

  await ok('没有身份的请求：id 退化为「路径#行号」，不会空着', () => {
    const g = groups.find((x) => x.name === 'handwritten');
    assert.equal(g.requests[0].interfaceId, null);
    assert.match(g.requests[0].id, /#\d+$/);
  });

  await ok('form 体被拆成 formBody 行，末尾同样补空行', async () => {
    const p = path.join(dir, 'form.http');
    fs.writeFileSync(p, '### 提交\nPOST https://x/y\nContent-Type: application/x-www-form-urlencoded\n\nsku=A-1&qty=2\n', 'utf8');
    const g = S.toLegacyCollections([(await store.list()).find((c) => c.name === 'form')])[0];
    assert.equal(g.requests[0].bodyType, 'form');
    const rows = g.requests[0].formBody;
    assert.deepEqual([rows[0].k, rows[0].v], ['sku', 'A-1']);
    assert.deepEqual([rows[1].k, rows[1].v], ['qty', '2']);
    assert.equal(rows[rows.length - 1].k, '');
  });

  await ok('解析失败的文件也出现在树里，带 error，不炸整个侧栏', () => {
    const groups2 = S.toLegacyCollections([{ name: 'broken', path: '/x/broken.http', requests: [], error: '读取失败', mtime: 1 }]);
    assert.equal(groups2.length, 1);
    assert.equal(groups2[0].error, '读取失败');
    assert.deepEqual(groups2[0].requests, []);
  });

  await ok('端到端：投影 → 改字段 → 写回 → 再投影，读到的是新值，别的段没动', async () => {
    const p = path.join(dir, 'handwritten.http');
    const before = fs.readFileSync(p, 'utf8');
    const g0 = S.toLegacyCollections((await store.list()).filter((c) => c.name === 'handwritten'))[0];
    const r0 = g0.requests[1]; // 创建订单
    const w = await store.writeRequest(p, {
      line: r0.httpSource.line,
      method: r0.method,
      url: '{{baseUrl}}/orders/v2',
      headers: r0.headers.filter((h) => h.k).map((h) => ({ k: h.k, v: h.v })),
      body: r0.body,
      bodyType: r0.bodyType,
    }, { baseMtime: g0.mtime });
    assert.equal(w.ok, true, JSON.stringify(w));

    const g1 = S.toLegacyCollections((await store.list()).filter((c) => c.name === 'handwritten'))[0];
    assert.equal(g1.requests[1].url, '{{baseUrl}}/orders/v2');
    assert.equal(g1.requests[1].name, r0.name, '名称不能丢');
    assert.ok(Math.abs(g1.requests[1].httpSource.line - r0.httpSource.line) <= 1, '行号只能因换行规范小幅浮动');

    // 其余段：投影出的 name/method/url/body 全等
    [0, 2, 3].forEach((i) => {
      assert.equal(g1.requests[i].name, g0.requests[i].name);
      assert.equal(g1.requests[i].method, g0.requests[i].method);
      assert.equal(g1.requests[i].url, g0.requests[i].url);
      assert.equal(g1.requests[i].body, g0.requests[i].body);
    });
    assert.ok(fs.readFileSync(p, 'utf8').length > before.length - 40, '文件不该被整篇重写变样');
    fs.writeFileSync(p, before, 'utf8'); // 复位，避免影响后续断言
  });

  await ok('端到端：追加一段后投影多一条，前面的请求顺序不变', async () => {
    const p = path.join(dir, 'with-ids.http');
    const g0 = S.toLegacyCollections((await store.list()).filter((c) => c.name === 'with-ids'))[0];
    const w = await store.appendRequest(p, { name: '新接口', method: 'PUT', url: 'https://x/n', body: '', bodyType: 'none' });
    assert.equal(w.ok, true, JSON.stringify(w));
    const g1 = S.toLegacyCollections((await store.list()).filter((c) => c.name === 'with-ids'))[0];
    assert.equal(g1.requests.length, g0.requests.length + 1);
    assert.deepEqual(g1.requests.slice(0, g0.requests.length).map((r) => r.url), g0.requests.map((r) => r.url));
    assert.equal(g1.requests[g1.requests.length - 1].name, '新接口');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' checks passed');
}

main().catch((e) => { console.error('\nFAILED:', e && e.message); console.error(e && e.stack); process.exit(1); });
