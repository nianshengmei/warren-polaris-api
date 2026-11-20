/* http-identity.js 自测。运行：node tools/identity.test.mjs
 * 身份四个能力各自独立可测：生成 / 插入 / 去重 / 指纹。
 * 插入类的断言一律"插完再解析读回同一个 id"，只断字符串会漏掉位置错的情况。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');
const I = require('../ui/http-identity.js');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

/* 固定注入源，让 newId 可复现；同时验证它只吃 [0,1) 的输入。 */
function seq() {
  let n = 0;
  return () => (n++ % 36) / 36;
}

const twoSeg = `@baseUrl = https://api.example.com

### 登录
# @name login
POST {{baseUrl}}/login
Content-Type: application/json

{"user":"admin"}

### 取用户
GET {{baseUrl}}/users
Accept: application/json
`;

ok('newId：8 位 base36，可注入且不重复', () => {
  const a = I.newId();
  assert.match(a, /^[0-9a-z]{8}$/);
  assert.match(I.newId(seq()), /^[0-9a-z]{8}$/);
  assert.equal(I.newId(seq()), '01234567');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(I.newId());
  assert.ok(seen.size > 1990, '2000 次生成重复过多：' + seen.size);
});

ok('insertFileId：空文件落在第 1 行，解析读回同一 id，请求数为 0', () => {
  const r = I.insertFileId('', 'abcd1234', { notes: false });
  assert.equal(r.changed, true);
  assert.equal(r.line, 1);
  assert.equal(r.text, '# @file_id abcd1234\n');
  const p = H.parseHttpFile(r.text, { fileName: 'a.http' });
  assert.equal(p.fileId, 'abcd1234');
  assert.equal(p.requests.length, 0);
  assert.deepEqual(p.warnings, []);
});

ok('insertFileId：有 ### 时插在第一个 ### 之前，请求数与每段内容不变', () => {
  const r = I.insertFileId(twoSeg, 'abcd1234', { notes: false });
  const lines = r.text.split('\n');
  assert.equal(lines[0], '@baseUrl = https://api.example.com');
  assert.equal(lines[1], '# @file_id abcd1234');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '### 登录');

  /* 原文每一行都按原序还在（只多出插入行），段内字节一个没动 */
  const orig = twoSeg.split('\n');
  let j = 0;
  for (const l of lines) if (j < orig.length && l === orig[j]) j++;
  assert.equal(j, orig.length, '原文有行被改动或丢失');
  assert.ok(lines.length === orig.length + 1 || lines.length === orig.length + 2);

  const p = H.parseHttpFile(r.text, { fileName: 'a.http' });
  assert.equal(p.fileId, 'abcd1234');
  assert.equal(p.fileIdLine, 2);
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[0].url, '{{baseUrl}}/login');
  assert.equal(p.requests[1].url, '{{baseUrl}}/users');
  assert.deepEqual(p.warnings, []);
});

ok('insertFileId：已有合法 id 时幂等，文本一字不动', () => {
  const once = I.insertFileId(twoSeg, 'abcd1234', { notes: false }).text;
  const twice = I.insertFileId(once, 'ffff9999', { notes: false });
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
  assert.equal(twice.id, 'abcd1234');
  assert.equal(H.parseHttpFile(twice.text).fileId, 'abcd1234');
  /* 值不合法的那行就地改正，不留两行重复声明 */
  const bad = '# @file_id !!\n\n### 甲\nGET https://a/1\n';
  const fix = I.insertFileId(bad, 'abcd1234', { notes: false });
  assert.equal(fix.changed, true);
  assert.equal((fix.text.match(/@file_id/g) || []).length, 1);
  assert.equal(H.parseHttpFile(fix.text).fileId, 'abcd1234');
});

ok('insertFileId：CRLF 文件插入后仍是纯 CRLF，不混裸 LF', () => {
  const crlf = '@baseUrl = https://a\r\n\r\n### 甲\r\nGET https://a/1\r\n';
  const r = I.insertFileId(crlf, 'aaaa1111', { notes: false });
  assert.equal(r.text, '@baseUrl = https://a\r\n# @file_id aaaa1111\r\n\r\n### 甲\r\nGET https://a/1\r\n');
  assert.ok(!/(^|[^\r])\n/.test(r.text), '混进了裸 LF');
  assert.equal(H.parseHttpFile(r.text).fileId, 'aaaa1111');
});

ok('insertInterfaceId：插在目标 ### 的紧下一行，只动这一段', () => {
  const r1 = I.insertInterfaceId(twoSeg, { line: 11 }, 'if111111', { notes: false });   /* 第 11 行 = GET {{baseUrl}}/users */
  const l1 = r1.text.split('\n');
  assert.equal(l1[9], '### 取用户');
  assert.equal(l1[10], '# @interface_id if111111');
  assert.equal(l1[11], 'GET {{baseUrl}}/users');

  const p1 = H.parseHttpFile(r1.text);
  assert.equal(p1.requests.length, 2);
  assert.equal(p1.requests[0].interfaceId, undefined);
  assert.equal(p1.requests[1].interfaceId, 'if111111');
  assert.equal(p1.requests[1].url, '{{baseUrl}}/users');

  /* index 定位等价于 line 定位 */
  const r2 = I.insertInterfaceId(twoSeg, { index: 1 }, 'if111111', { notes: false });
  assert.equal(r2.text, r1.text);
  const r3 = I.insertInterfaceId(twoSeg, { index: 0 }, 'aa000000', { notes: false });
  const p3 = H.parseHttpFile(r3.text);
  assert.equal(p3.requests[0].interfaceId, 'aa000000');
  assert.equal(p3.requests[0].interfaceIdLine, 4);
  assert.equal(p3.requests[1].interfaceId, undefined);
  assert.equal(I.insertInterfaceId(twoSeg, { line: 99 }, 'x').reason, 'NO_SEGMENT');
});

ok('insertInterfaceId：同 id 幂等，异 id 不覆盖', () => {
  const once = I.insertInterfaceId(twoSeg, { index: 0 }, 'aa000000', { notes: false }).text;
  const same = I.insertInterfaceId(once, { index: 0 }, 'aa000000', { notes: false });
  assert.equal(same.changed, false);
  assert.equal(same.text, once);
  const other = I.insertInterfaceId(once, { index: 0 }, 'bb111111', { notes: false });
  assert.equal(other.changed, false);
  assert.equal(other.reason, 'EXISTS_OTHER');
  assert.equal(other.text, once);
  assert.equal(H.parseHttpFile(other.text).requests[0].interfaceId, 'aa000000');
});

ok('dedupe：两段同 id 时第二个换掉，第一个保持，解析后全文件唯一', () => {
  const dup = `### 甲\n# @interface_id same0001\nGET https://a/1\n\n### 乙\n# @interface_id same0001\nGET https://a/2\n`;
  const doc = H.parseHttpFile(dup);
  const r = I.dedupe(dup, doc);
  assert.equal(r.replaced.length, 1);
  assert.equal(r.replaced[0].line, 6);
  assert.equal(r.replaced[0].from, 'same0001');

  const after = H.parseHttpFile(r.text);
  assert.equal(after.requests[0].interfaceId, 'same0001');
  assert.match(after.requests[1].interfaceId, /^[0-9a-z]{8}$/);
  assert.notEqual(after.requests[1].interfaceId, 'same0001');
  /* 段内容与请求数不变 */
  assert.equal(after.requests.length, 2);
  assert.equal(after.requests[1].url, 'https://a/2');
  /* 行数不变（是替换不是插入） */
  assert.equal(r.text.split('\n').length, dup.split('\n').length);
  /* 没有重复时原样返回 */
  const clean = I.dedupe(r.text, after);
  assert.deepEqual(clean.replaced, []);
  assert.equal(clean.text, r.text);
});

ok('fingerprint：METHOD 大写 + URL 归一化，变量不展开、query 不排序', () => {
  assert.equal(
    I.fingerprint({ method: 'get', url: 'HTTPS://API.Example.COM:443/users/?b=2&a=1#x' }),
    'GET https://api.example.com/users?b=2&a=1'
  );
  assert.equal(I.fingerprint({ method: 'post', url: 'http://a.com:80//v1//x' }), 'POST http://a.com/v1/x');
  /* 末尾斜杠、重复斜杠不改变身份 */
  assert.equal(I.fingerprint({ url: '{{baseUrl}}/users/' }), I.fingerprint({ url: '{{baseUrl}}/users' }));
  assert.equal(I.fingerprint({ url: '{{baseUrl}}//users' }), I.fingerprint({ url: '{{baseUrl}}/users' }));
  /* 变量保留原文：与展开后的地址不是同一个指纹，换环境不会漂 */
  assert.notEqual(I.fingerprint({ url: '{{baseUrl}}/users' }), I.fingerprint({ url: 'https://api.example.com/users' }));
  /* query 顺序算语义，不排序 */
  assert.notEqual(I.fingerprint({ url: 'https://a/x?a=1&b=2' }), I.fingerprint({ url: 'https://a/x?b=2&a=1' }));
  assert.equal(I.fingerprint({ method: 'GET', url: '' }), 'GET ');
});


/* ---- S4.6：把某段的身份改回旧 id（只在用户点「接回」后调用） ---- */
ok('改回旧身份：段里已有 id 就换值，行尾说明原样保留', () => {
  const t = `### 甲\n# @interface_id new00001  接口身份，改了就会断历史\nGET https://a/1\n`;
  const r = I.retagInterfaceId(t, { line: 3 }, 'old00001');
  assert.equal(r.changed, true);
  assert.equal(r.id, 'old00001');
  const lines = r.text.split('\n');
  assert.equal(lines[1], '# @interface_id old00001  接口身份，改了就会断历史');
  assert.equal(lines.length, t.split('\n').length, '换值不该多出/少掉行');
  assert.equal(H.parseHttpFile(r.text).requests[0].interfaceId, 'old00001');
});

ok('改回旧身份：段里没有 id 行就在 ### 下一行插一行', () => {
  const t = `### 甲\nGET https://a/1\n\n### 乙\nGET https://a/2\n`;
  const r = I.retagInterfaceId(t, { line: 5 }, 'old00002');
  assert.equal(r.changed, true);
  const lines = r.text.split('\n');
  assert.equal(lines[3], '### 乙');
  assert.ok(lines[4].startsWith('# @interface_id old00002'), lines[4]);   /* 后面可能带说明文字，与 record 首次插入保持一致 */
  const doc = H.parseHttpFile(r.text);
  assert.equal(doc.requests.length, 2, '插身份不许改变请求数');
  assert.equal(doc.requests[1].interfaceId, 'old00002');
});

ok('改回旧身份：id 已经就是它 → 一个字节都不动', () => {
  const t = `### 甲\n# @interface_id same0001\nGET https://a/1\n`;
  const r = I.retagInterfaceId(t, { line: 3 }, 'same0001');
  assert.equal(r.changed, false);
  assert.equal(r.text, t);
});

ok('改回旧身份：定位不到段 → NO_SEGMENT，原文返回', () => {
  const t = `### 甲\nGET https://a/1\n`;
  const r = I.retagInterfaceId(t, { line: 99 }, 'x0000001');
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'NO_SEGMENT');
  assert.equal(r.text, t);
});

console.log('\n' + pass + ' 项通过');
