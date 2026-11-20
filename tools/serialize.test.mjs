/* 序列化 round-trip 自测。运行：node tools/serialize.test.mjs
 *
 * 判据：parse → serialize → parse 之后，每个请求的「方法 / URL / 头 / 体 / 类型 / 名称 / 身份」
 * 必须与原文件完全一致。字节不要求一致（序列化本来就会规范化排版），
 * 但任何字段丢失都算失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

function read(f) { return fs.readFileSync(path.join(DIR, f), 'utf8'); }

/* 只比较「语义字段」：raw / line / id 这类解析产生的临时字段不参与 */
function shape(req) {
  return {
    name: req.name,
    title: req.title || '',
    method: req.method,
    url: req.url,
    headers: (req.headers || []).map((h) => [h.k, h.v]),
    body: req.body || '',
    bodyType: req.bodyType,
    bodyFromFile: req.bodyFromFile || null,
    outputFile: req.outputFile || null,
    preScript: req.preScript || '',
    postScript: req.postScript || '',
    interfaceId: req.interfaceId || null,
  };
}

const files = ['minimal.http', 'handwritten.http', 'with-ids.http', 'messy.http'];

for (const f of files) {
  ok(f + ' round-trip 后请求数不变', () => {
    const a = H.parseHttpFile(read(f), { fileName: f });
    const text2 = H.serializeCollection(a);
    const b = H.parseHttpFile(text2, { fileName: f });
    assert.equal(b.requests.length, a.requests.length, '请求数变了');
  });

  ok(f + ' round-trip 后每个请求字段一致', () => {
    const a = H.parseHttpFile(read(f), { fileName: f });
    const b = H.parseHttpFile(H.serializeCollection(a), { fileName: f });
    for (let i = 0; i < a.requests.length; i++) {
      assert.deepEqual(shape(b.requests[i]), shape(a.requests[i]), '第 ' + (i + 1) + ' 个请求不一致');
    }
  });

  ok(f + ' round-trip 后 fileId / 文件变量一致', () => {
    const a = H.parseHttpFile(read(f), { fileName: f });
    const b = H.parseHttpFile(H.serializeCollection(a), { fileName: f });
    assert.equal(b.fileId, a.fileId);
    assert.deepEqual(b.fileVars, a.fileVars);
  });
}

ok('with-ids.http 的身份注释被原样写回', () => {
  const a = H.parseHttpFile(read('with-ids.http'), { fileName: 'with-ids.http' });
  const text = H.serializeCollection(a);
  assert.match(text, /^# @file_id 7f3a9c21 {2}wpa 文件身份/);
  assert.match(text, /### 登录\n# @interface_id a1b2c3d4 {2}wpa 接口身份/);
  assert.match(text, /### 查询用户\n# @interface_id e5f6a7b8/);
});

ok('说明文字可关：notes:false 时只留 id', () => {
  const a = H.parseHttpFile(read('with-ids.http'), { fileName: 'with-ids.http' });
  const text = H.serializeCollection(a, { notes: false });
  assert.match(text, /^# @file_id 7f3a9c21$/m);
  assert.match(text, /^# @interface_id a1b2c3d4$/m);
});

ok('handwritten.http 的制表符缩进体原样保留', () => {
  const a = H.parseHttpFile(read('handwritten.http'), { fileName: 'handwritten.http' });
  const text = H.serializeCollection(a);
  assert.match(text, /\{\n\t"sku": "A-1001",\n\t"qty": 2,/);
});

ok('# @name 与 ### 标题不同时两者都保留', () => {
  const src = '### 登录\n# @name login\nPOST https://example.com/login\n';
  const a = H.parseHttpFile(src);
  assert.equal(a.requests[0].name, 'login');
  assert.equal(a.requests[0].title, '登录');
  const b = H.parseHttpFile(H.serializeCollection(a));
  assert.equal(b.requests[0].name, 'login');
  assert.equal(b.requests[0].title, '登录');
});

ok('无标题请求序列化后仍然无标题（name 由方法+URL 自动生成）', () => {
  const src = 'GET https://example.com/x\nAccept: */*\n';
  const a = H.parseHttpFile(src);
  const text = H.serializeCollection(a);
  const b = H.parseHttpFile(text);
  assert.equal(b.requests[0].name, a.requests[0].name);
  assert.equal(b.requests[0].title, '');
});

ok('bodyFromFile / outputFile 与脚本都能往返', () => {
  const src = [
    '### 上传',
    'POST https://example.com/up',
    'Content-Type: application/json',
    '',
    '< ./payload.json',
    '> ./out.json',
    '',
    '> {%',
    'client.test("ok", function() { client.assert(response.status === 200); });',
    '%}',
    '',
  ].join('\n');
  const a = H.parseHttpFile(src);
  const b = H.parseHttpFile(H.serializeCollection(a));
  assert.equal(b.requests[0].bodyFromFile, './payload.json');
  assert.equal(b.requests[0].outputFile, './out.json');
  assert.match(b.requests[0].postScript, /client\.test/);
});

ok('新建文件：serializeCollection 产出的文本可被再次解析，行尾为 LF', () => {
  const text = H.serializeCollection({
    fileId: 'abcd1234',
    fileVars: { baseUrl: 'https://api.example.com' },
    requests: [{ title: '登录', method: 'POST', url: '{{baseUrl}}/login', headers: [{ k: 'Content-Type', v: 'application/json' }], body: '{"u":1}', bodyType: 'json' }],
  });
  assert.ok(!text.includes('\r'));
  const doc = H.parseHttpFile(text);
  assert.equal(doc.fileId, 'abcd1234');
  assert.equal(doc.requests.length, 1);
  assert.equal(doc.requests[0].bodyType, 'json');
});

console.log('\n' + pass + ' checks passed');
