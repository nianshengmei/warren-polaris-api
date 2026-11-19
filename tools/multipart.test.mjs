/* multipart 解析自测：node tools/multipart.test.mjs */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' → ' + e.message); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg || '') + ' 期望 ' + B + ' 实际 ' + A);
}

/* 用户真实用例：分段头与内容之间没有空行 */
const USER = [
  '###  创建音频',
  'POST https://ailinkapp-dev.hotwater.com.cn/AiLinkService/voiceprint/uploadAudio?userId=1661820715164342&familyId=1743472246132812',
  'Content-Type: multipart/form-data; boundary=WebAppBoundary',
  '--WebAppBoundary',
  'Content-Disposition: form-data; name="audio"; filename="2122216927546840134.wav"',
  '< D:\\转音频声纹测试\\2122216927546840134.wav',
  '--WebAppBoundary--',
  ''
].join('\n');

/* IDEA 规范写法：空行 + 多个分段 */
const CANON = [
  '### 上传',
  'POST {{baseUrl}}/upload',
  'Content-Type: multipart/form-data; boundary=----Boundary',
  '',
  '------Boundary',
  'Content-Disposition: form-data; name="title"',
  '',
  '你好',
  '------Boundary',
  'Content-Disposition: form-data; name="file"; filename="a.png"',
  'Content-Type: image/png',
  '',
  '< ./a.png',
  '------Boundary',
  'Content-Disposition: form-data; name="meta"',
  'Content-Type: application/json',
  '',
  '{ "k": 1 }',
  '------Boundary--',
  ''
].join('\n');

console.log('multipart 解析');

ok('用户用例：识别为 multipart，body 类型正确', () => {
  const r = H.parseHttpFile(USER, {});
  eq(r.requests.length, 1);
  eq(r.requests[0].bodyType, 'multipart');
  eq(r.requests[0].name, '创建音频');
  eq(r.requests[0].bodyFromFile, null, '尖括号行不能被当成整包 body');
});

ok('用户用例：boundary 与分段数正确', () => {
  const mp = H.parseHttpFile(USER, {}).requests[0].multipart;
  eq(mp.boundary, 'WebAppBoundary');
  eq(mp.parts.length, 1);
  eq(mp.parts[0].name, 'audio');
  eq(mp.parts[0].filename, '2122216927546840134.wav');
});

ok('用户用例：附件路径完整（含中文、反斜杠）', () => {
  const p = H.parseHttpFile(USER, {}).requests[0].multipart.parts[0];
  eq(p.filePath, 'D:\\转音频声纹测试\\2122216927546840134.wav');
  eq(p.content, '');
});

ok('规范写法：3 个分段 + 文本 / 二进制 / JSON', () => {
  const mp = H.parseHttpFile(CANON, {}).requests[0].multipart;
  eq(mp.boundary, '----Boundary');
  eq(mp.parts.length, 3);
  eq(mp.parts[0].name, 'title');
  eq(mp.parts[0].content, '你好');
  eq(mp.parts[1].filePath, './a.png');
  eq(mp.parts[1].contentType, 'image/png');
  eq(mp.parts[2].content, '{ "k": 1 }');
});

ok('没有 Content-Type 但 body 是 --boundary 形式：自动补并给 warning', () => {
  const src = ['POST https://a.com/u', '--B', 'Content-Disposition: form-data; name="x"', '', '1', '--B--', ''].join('\n');
  const r = H.parseHttpFile(src, {});
  eq(r.requests[0].bodyType, 'multipart');
  eq(r.requests[0].multipart.boundary, 'B');
  eq(r.requests[0].headers.filter(h => /content-type/i.test(h.k)).length, 1);
  eq(r.warnings.length > 0, true);
});

ok('普通 JSON body 不被误判为 multipart', () => {
  const src = ['POST https://a.com/u', 'Content-Type: application/json', '', '{ "a": 1 }', ''].join('\n');
  eq(H.parseHttpFile(src, {}).requests[0].bodyType, 'json');
});

ok('单行 body 来自文件（< ./body.json）仍是 file/json 语义', () => {
  const src = ['POST https://a.com/u', 'Content-Type: application/json', '', '< ./body.json', ''].join('\n');
  const rq = H.parseHttpFile(src, {}).requests[0];
  eq(rq.bodyFromFile, './body.json');
  eq(rq.bodyType, 'json');
});

ok('非 JSON 的文件 body 判为 file（走二进制）', () => {
  const src = ['POST https://a.com/u', '', '< ./pic.png', ''].join('\n');
  eq(H.parseHttpFile(src, {}).requests[0].bodyType, 'file');
});

ok('parseMultipart 直接调用也能解析（含空 boundary 推断）', () => {
  const body = ['--XyZ', 'Content-Disposition: form-data; name="a"', '', 'v', '--XyZ--'].join('\n');
  const mp = H.parseMultipart(body, '');
  eq(mp.boundary, 'XyZ');
  eq(mp.parts[0].content, 'v');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
