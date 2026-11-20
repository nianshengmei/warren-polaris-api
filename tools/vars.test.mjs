/* 变量求值自测（S2.4）。运行：node tools/vars.test.mjs
 *
 * 这一组钉住的是「同一个文件，两种视图给出同一个结果」：
 * 表单侧以前只认环境变量，`.http` 里写的 @base = ... 发出去是字面量（ENOTFOUND）。
 * 现在两侧都走 http-file.js 的 resolveVars，优先级：文件级 @var → 环境 → 内置动态变量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fsHost } from './fs-host.mjs';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');
const S = require('../ui/http-store.js');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURES = path.join(HERE, 'fixtures');

let pass = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); });
}

const ctx = (vars, env, responses) => ({
  vars: vars || {},
  envs: { dev: env || {} },
  activeEnv: 'dev',
  responses: responses || {},
});

async function main() {
  /* ---------- 优先级 ---------- */
  await ok('文件级 @var 覆盖环境同名变量', () => {
    const r = H.resolveVars('{{baseUrl}}/x', ctx({ baseUrl: 'http://file' }, { baseUrl: 'http://env' }));
    assert.equal(r, 'http://file/x');
  });

  await ok('文件没定义时落回环境', () => {
    const r = H.resolveVars('{{baseUrl}}/x', ctx({}, { baseUrl: 'http://env' }));
    assert.equal(r, 'http://env/x');
  });

  await ok('环境里没有 baseUrl 字段时，走 env.vars 里的同名键', () => {
    const r = H.resolveVars('{{baseUrl}}/x', ctx({}, { baseUrl: '' , token: 't' }));
    assert.equal(r, '/x');   /* baseUrl 存在但为空：按空串替换，不再保留字面量 */
  });

  await ok('两边都没有 → 原样保留（不做破坏性替换）', () => {
    assert.equal(H.resolveVars('{{nope}}/x', ctx({}, {})), '{{nope}}/x');
  });

  await ok('没有 {{ 时零拷贝返回原值', () => {
    const s = 'http://a/b';
    assert.equal(H.resolveVars(s, ctx()), s);
  });

  /* ---------- 内置动态变量 ---------- */
  await ok('$guid 是 36 位 UUID 形状，且每次不同', () => {
    const a = H.resolveVars('{{$guid}}', ctx());
    const b = H.resolveVars('{{$guid}}', ctx());
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  });

  await ok('$timestamp 是 13 位毫秒数', () => {
    assert.match(H.resolveVars('{{$timestamp}}', ctx()), /^\d{13}$/);
  });

  await ok('$randomInt / $datetimeIso 形状正确', () => {
    assert.match(H.resolveVars('{{$randomInt}}', ctx()), /^\d+$/);
    assert.match(H.resolveVars('{{$datetimeIso}}', ctx()), /^\d{4}-\d{2}-\d{2}T/);
  });

  /* ---------- 跨请求引用 ---------- */
  await ok('{{名字.response.body.$.a.b}} 取到值', () => {
    const responses = { 登录: { status: 200, headers: {}, parsed: { a: { b: 42 } } } };
    assert.equal(H.resolveVars('{{登录.response.body.$.a.b}}', ctx({}, {}, responses)), '42');
  });

  await ok('{{名字.response.headers.X}} 大小写不敏感', () => {
    const responses = { 登录: { status: 200, headers: { 'Content-Type': 'application/json' }, parsed: {} } };
    assert.equal(H.resolveVars('{{登录.response.headers.content-type}}', ctx({}, {}, responses)), 'application/json');
  });

  await ok('请求名带空格也能认（### 甲 用文件变量）', () => {
    const responses = { '甲 用文件变量': { status: 200, headers: {}, parsed: { total: 7 } } };
    assert.equal(H.resolveVars('{{甲 用文件变量.response.body.$.total}}', ctx({}, {}, responses)), '7');
  });

  await ok('引用了还没跑过的请求 → 保留原文', () => {
    assert.equal(H.resolveVars('{{没跑过.response.body.$.id}}', ctx()), '{{没跑过.response.body.$.id}}');
  });

  await ok('取不到的 JSON 路径 → 保留原文，不产生 undefined', () => {
    const responses = { a: { status: 200, headers: {}, parsed: { x: 1 } } };
    assert.equal(H.resolveVars('{{a.response.body.$.y.z}}', ctx({}, {}, responses)), '{{a.response.body.$.y.z}}');
  });

  /* ---------- 从真文件解析出来的 @var ---------- */
  await ok('解析器把 @var 收进 fileVars（值里的 {{...}} 暂不展开）', () => {
    const text = '@base = http://127.0.0.1:8899\n@token = {{$guid}}\n\n### a\nGET {{base}}/p\n';
    const p = H.parseHttpFile(text, { fileName: 'v.http' });
    assert.equal(p.fileVars.base, 'http://127.0.0.1:8899');
    assert.equal(p.fileVars.token, '{{$guid}}');
  });

  await ok('变量值里套占位符（@token = {{$guid}}）一次就能解到底', () => {
    const text = '@base = http://h\n@token = {{$guid}}\n\n### a\nGET {{base}}/p\n';
    const p = H.parseHttpFile(text, { fileName: 'v.http' });
    const one = H.resolveDeep('{{token}}', ctx(p.fileVars));
    assert.match(one, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(one.indexOf('{{'), -1);
  });

  await ok('@url = {{base}}/v1 这类引用也能一起解开', () => {
    const p = H.parseHttpFile('@base = http://h\n@url = {{base}}/v1\n\n### a\nGET {{url}}/p\n', { fileName: 'v.http' });
    assert.equal(H.resolveDeep('{{url}}/p', ctx(p.fileVars)), 'http://h/v1/p');
  });

  await ok('互相引用不会死循环（a→b→a 三轮后停手）', () => {
    const out = H.resolveDeep('{{a}}', ctx({ a: '{{b}}', b: '{{a}}' }));
    assert.equal(typeof out, 'string');
  });

  /* ---------- 投影层必须把 fileVars 带过去 ---------- */
  await ok('投影到旧 UI 形状时 fileVars 不丢', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-vars-'));
    fs.writeFileSync(path.join(dir, 'v.http'), '@baseUrl = http://127.0.0.1:8899\n\n### 甲\nGET {{baseUrl}}/p\n', 'utf8');
    const store = S.createStore(fsHost(), { dir });
    const list = await store.list();
    assert.deepEqual(list[0].fileVars, { baseUrl: 'http://127.0.0.1:8899' });
    const groups = S.toLegacyCollections(list, {});
    assert.deepEqual(groups[0].fileVars, { baseUrl: 'http://127.0.0.1:8899' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ok('没有 @var 的文件，fileVars 是空对象而不是 undefined', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-vars2-'));
    fs.copyFileSync(path.join(FIXTURES, 'minimal.http'), path.join(dir, 'minimal.http'));
    const store = S.createStore(fsHost(), { dir });
    const groups = S.toLegacyCollections(await store.list(), {});
    assert.deepEqual(groups[0].fileVars, {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n' + pass + ' checks passed');
}

main().catch((e) => { console.error('\nFAILED: ' + (e && e.message || e)); process.exit(1); });
