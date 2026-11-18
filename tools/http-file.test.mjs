/* http-file.js 解析与变量求值自测。运行：node tools/http-file.test.mjs */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');

const sample = `@baseUrl = https://api.example.com
@token = abc123

### 登录
# @name login
POST {{baseUrl}}/login HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}
Accept: */*

{"user":"admin","pwd":"123"}

> {%
client.test("status is 200", function() { client.assert(response.status === 200); });
client.global.set("authToken", response.body.$.token);
%}

### 取用户列表
GET {{baseUrl}}/users?token={{login.response.body.$.token}}
Accept: application/json

### 上传
POST {{baseUrl}}/upload
Content-Type: application/json

< ./payload.json
`;

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

const parsed = H.parseHttpFile(sample, { fileName: 'demo.http' });

ok('文件级变量', () => {
  assert.equal(parsed.variables.baseUrl, 'https://api.example.com');
  assert.equal(parsed.variables.token, 'abc123');
});
ok('解析出 3 个请求', () => assert.equal(parsed.requests.length, 3));
ok('# @name 覆盖 ### 名称', () => assert.equal(parsed.requests[0].name, 'login'));
ok('请求行含 HTTP/1.1 被剥离', () => {
  assert.equal(parsed.requests[0].method, 'POST');
  assert.equal(parsed.requests[0].url, '{{baseUrl}}/login');
});
ok('Headers 解析', () => {
  const hs = parsed.requests[0].headers;
  assert.equal(hs.length, 3);
  assert.equal(hs[0].k, 'Content-Type');
  assert.equal(hs[1].v, 'Bearer {{token}}');
  assert.equal(hs[2].k, 'Accept');
});
ok('Body 与 bodyType', () => {
  assert.equal(parsed.requests[0].body, '{"user":"admin","pwd":"123"}');
  assert.equal(parsed.requests[0].bodyType, 'json');
});
ok('多行响应脚本与断言计数', () => {
  assert.match(parsed.requests[0].postScript, /client\.global\.set/);
  assert.equal(parsed.requests[0].tests, 1);
});
ok('跨请求引用保留在 URL', () => {
  assert.equal(parsed.requests[1].url, '{{baseUrl}}/users?token={{login.response.body.$.token}}');
});
ok('< 文件引用', () => assert.equal(parsed.requests[2].bodyFromFile, './payload.json'));
ok('未支持语法给出 warnings', () => {
  assert.ok(parsed.warnings.some(w => /仅解析不执行/.test(w)));
});

const ctx = {
  vars: parsed.variables,
  envs: { dev: { envHost: 'dev.example.com' }, prod: { envHost: 'prod.example.com' } },
  activeEnv: 'dev',
  responses: {
    login: { text: '{"token":"T-8899","data":{"id":7}}', headers: { 'X-Trace': 'tr-1' } }
  }
};
ok('普通变量插值', () => assert.equal(H.resolveVars('{{baseUrl}}/users', ctx), 'https://api.example.com/users'));
ok('env 变量插值', () => assert.equal(H.resolveVars('{{envHost}}', ctx), 'dev.example.com'));
ok('跨请求 body JSONPath', () => assert.equal(H.resolveVars('{{login.response.body.$.token}}', ctx), 'T-8899'));
ok('跨请求嵌套 JSONPath', () => assert.equal(H.resolveVars('{{login.response.body.$.data.id}}', ctx), '7'));
ok('跨请求 header', () => assert.equal(H.resolveVars('{{login.response.headers.X-Trace}}', ctx), 'tr-1'));
ok('内置动态变量', () => assert.match(H.resolveVars('{{$timestamp}}', ctx), /^\d{13}$/));
ok('未命中占位符原样保留', () => assert.equal(H.resolveVars('{{nope}}', ctx), '{{nope}}'));
ok('混合插值', () => {
  assert.equal(H.resolveVars('{{baseUrl}}/u?t={{login.response.body.$.token}}', ctx),
    'https://api.example.com/u?t=T-8899');
});

const merged = H.mergeEnvFiles(
  { dev: { host: 'dev', token: 'public' }, prod: { host: 'prod' } },
  { dev: { token: 'secret' } }
);
ok('env 文件合并（private 覆盖）', () => {
  assert.equal(merged.dev.host, 'dev');
  assert.equal(merged.dev.token, 'secret');
  assert.equal(merged.prod.host, 'prod');
});

ok('脚本位于文件顶部不崩溃', () => {
  const r = H.parseHttpFile('{%\nrequest.variables.set("a", "1");\n%}\n\n### first\nGET https://example.com\n');
  assert.equal(r.requests.length, 1);
  assert.match(r.requests[0].preScript, /request\.variables\.set/);
});

ok('空文件与单请求无 ###', () => {
  assert.equal(H.parseHttpFile('').requests.length, 0);
  assert.equal(H.parseHttpFile('GET https://example.com\nAccept: */*\n').requests.length, 1);
});

console.log('\n' + pass + ' assertions passed');
