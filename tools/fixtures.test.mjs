/* 测试夹具自检。运行：node tools/fixtures.test.mjs
 *
 * 这四个文件是 M1 之后每一步的靶子：
 *   minimal.http     —— 单请求最简，用来验证「不能因为简单就丢东西」
 *   handwritten.http  —— 手写排版（Tab 缩进、3 个空行、注释混排），用来验证写回不破坏别处
 *   with-ids.http     —— 两级身份齐全，用来验证 id 不丢
 *   messy.http        —— CRLF + 畸形 id + 重复 id，用来验证容错
 *
 * 哈希钉死：谁改了夹具内容，这里会红。这是故意的——夹具变了，依赖它的断言要重新核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures');

const EXPECT = {
  'minimal.http': { bytes: 46, sha256: '78f433d9cbf7ff18b798a29a25b345fb22e2391db44881376df505127d9e4a98', requests: 1, crlf: false },
  'handwritten.http': { bytes: 791, sha256: '168b993f3faa404d674118202e078648727af2b505501ef33c733586fc0f1ced', requests: 4, crlf: false },
  'with-ids.http': { bytes: 515, sha256: '93b9eff3beb2dbc5bcc08ba890cd78babfc60746b2928a6d79dcfee67b8df485', requests: 2, crlf: false },
  'messy.http': { bytes: 436, sha256: '5e9acc48fc817adf9facd1c26e9b2aa0622076528e1d7b8ddfb589ce69f43e25', requests: 4, crlf: true },
};

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

function load(f) {
  const buf = fs.readFileSync(path.join(DIR, f));
  return { buf, text: buf.toString('utf8') };
}

for (const f of Object.keys(EXPECT)) {
  const e = EXPECT[f];

  ok(f + ' 字节与哈希未被改动', () => {
    const { buf } = load(f);
    assert.equal(buf.length, e.bytes, '字节数变了');
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), e.sha256, '内容变了，需同步更新本测试');
  });

  ok(f + ' 换行风格符合预期', () => {
    const { buf } = load(f);
    const crlf = buf.includes(Buffer.from('\r\n'));
    assert.equal(crlf, e.crlf, e.crlf ? '应为 CRLF' : '应为 LF');
  });

  ok(f + ' 解析出 ' + e.requests + ' 个请求', () => {
    const { text } = load(f);
    const doc = H.parseHttpFile(text, { fileName: f });
    assert.equal(doc.requests.length, e.requests);
    assert.equal(doc.fileName, f);
  });
}

ok('handwritten.http 的请求字段完整', () => {
  const { text } = load('handwritten.http');
  const doc = H.parseHttpFile(text, { fileName: 'handwritten.http' });
  assert.deepEqual(doc.requests.map((r) => r.method), ['GET', 'POST', 'DELETE', 'GET']);
  assert.equal(doc.requests[0].url, '{{baseUrl}}/orders?page=1&size=20');
  assert.equal(doc.requests[0].headers.length, 2);
  assert.equal(doc.requests[1].bodyType, 'json');
  assert.match(doc.requests[1].body, /^\{\n\t"sku"/, '制表符缩进必须原样保留');
  assert.equal(doc.variables.token, 'demo-token-123', '= 两侧多余空格被吃掉');
  assert.equal(doc.requests[3].url, 'https://status.example.com/healthz');
});

ok('messy.http 的畸形 id 不产生 fileId（S1.1 生效后）', () => {
  const { text } = load('messy.http');
  const doc = H.parseHttpFile(text, { fileName: 'messy.http' });
  assert.equal(doc.fileId, undefined);
});

ok('夹具目录里只有这四个 .http', () => {
  const files = fs.readdirSync(DIR).filter((n) => /\.http$/.test(n)).sort();
  assert.deepEqual(files, Object.keys(EXPECT).sort());
});

console.log('\n' + pass + ' checks passed');
