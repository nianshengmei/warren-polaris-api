/* 跨平台路径契约（Windows / macOS / Linux 同一套断言）。运行：node tools/fs-contract.test.mjs
 *
 * 为什么单独一个文件：0.9.0 之前所有真机验证都在 Linux 上做的，而用户实际是
 * Windows + macOS。路径这块出事的形态又特别恶心 —— 不报错，只是「文件不在侧栏了」
 * 或者「另存为之后原文件没了」。这里把能靠纯函数钉死的先钉死，剩下必须真机的
 * （大小写不敏感、rename 覆盖语义）按 platform 条件断言，并在三个系统上都跑。
 *
 * 钉住的四件事：
 *   1. 分隔符：`\` 与 `/` 混着来，归一之后指向同一个文件；写回时保留目录自己的风格。
 *   2. 绝对/相对：目录内写相对、目录外写绝对；跨盘符绝不硬算相对路径。
 *   3. 文件名：Windows 非法字符（: * ? " < > |）必须换掉，中文与空格原样保留。
 *   4. 换行：CRLF 文件读写往返一个字节都不许变（Windows 用户的仓库里全是 CRLF）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const M = require('../ui/workspace-map.js');
const S = require('../ui/http-store.js');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

/* ---------------- 1. 比对键：同一文件的不同写法 ---------------- */

await ok('pathKey：分隔符、尾斜杠、重复斜杠、盘符大小写都归一到同一个键', () => {
  const k = 'c:/work/api/orders.http';
  assert.equal(M.pathKey('C:\\work\\api\\orders.http'), k);
  assert.equal(M.pathKey('c:/WORK/api/Orders.HTTP'), k);
  assert.equal(M.pathKey('C:\\work\\api\\orders.http\\'), k);
  assert.equal(M.pathKey('C:/work//api///orders.http'), k);
  assert.equal(M.pathKey('C:\\work\\\\api\\orders.http'), k);
});

await ok('pathKey：UNC 开头的双斜杠不被折叠成单斜杠', () => {
  assert.equal(M.pathKey('//nas//share//a.http'), '//nas/share/a.http');
  assert.equal(M.pathKey('\\\\nas\\share\\a.http'), '//nas/share/a.http');
});

await ok('pathKey：UNC 共享路径也按不区分大小写比对', () => {
  assert.equal(M.pathKey('\\\\NAS\\Share\\a.http'), M.pathKey('//nas/share/A.HTTP'));
});

await ok('pathKey：POSIX 路径保留大小写（Linux 上 a.http 与 A.http 是两个文件）', () => {
  assert.notEqual(M.pathKey('/work/a.http'), M.pathKey('/work/A.http'));
});

/* ---------------- 2. 绝对 / 相对 ---------------- */

await ok('toEntry：目录内 → 相对路径（统一 /），目录外 → 原样绝对', () => {
  assert.equal(M.toEntry('C:\\work', 'C:\\work\\sub\\a.http'), 'sub/a.http');
  assert.equal(M.toEntry('C:\\work', 'C:\\work\\a.http'), 'a.http');
  assert.equal(M.toEntry('C:\\work', 'D:\\other\\a.http'), 'D:\\other\\a.http');
  assert.equal(M.toEntry('/work', '/work/sub/a.http'), 'sub/a.http');
  assert.equal(M.toEntry('/work', '/elsewhere/a.http'), '/elsewhere/a.http');
});

await ok('toAbs：相对路径按目录自己的分隔符拼回去', () => {
  assert.equal(M.toAbs('C:\\work', 'sub/a.http'), 'C:\\work\\sub/a.http');
  assert.equal(M.toAbs('C:\\work', 'a.http'), 'C:\\work\\a.http');
  assert.equal(M.toAbs('/work', 'sub/a.http'), '/work/sub/a.http');
  assert.equal(M.toAbs('/work', '/abs/a.http'), '/abs/a.http');
});

await ok('toEntry → toAbs 往返不丢信息（Windows 与 POSIX 各一遍）', () => {
  const cases = [
    ['C:\\work', 'C:\\work\\deep\\a.http'],
    ['C:\\work', 'D:\\else\\a.http'],
    ['/work', '/work/deep/a.http'],
    ['/work', '/etc/a.http'],
  ];
  for (const [dir, abs] of cases) {
    const back = M.toAbs(dir, M.toEntry(dir, abs));
    assert.equal(M.pathKey(back), M.pathKey(abs), dir + ' + ' + abs + ' → ' + back);
  }
});

await ok('relOf：前缀相同但不是子目录，不许当相对路径', () => {
  assert.equal(M.relOf('/work', '/workshop/a.http'), null);
  assert.equal(M.relOf('C:\\work', 'C:\\workshop\\a.http'), null);
  assert.equal(M.relOf('/work', '/work/a.http'), 'a.http');
});

await ok('relOf：跨盘符返回 null（Windows 无法表达相对路径）', () => {
  assert.equal(M.relOf('C:\\work', 'D:\\work\\a.http'), null);
});

await ok('isAbs：盘符 / UNC / 根都是绝对，裸名字不是', () => {
  ['C:\\a', 'C:/a', '\\\\srv\\share', '//srv/share', '/a', '\\a'].forEach((p) => {
    assert.equal(M.isAbs(p), true, p);
  });
  ['a.http', 'sub/a.http', './a.http', '..\\a.http'].forEach((p) => {
    assert.equal(M.isAbs(p), false, p);
  });
});

/* ---------------- 3. 拼接与取名 ---------------- */

await ok('joinPath：沿用目录原有的分隔符，并去掉重复尾斜杠', () => {
  assert.equal(S.joinPath('C:\\work', 'a.http'), 'C:\\work\\a.http');
  assert.equal(S.joinPath('C:\\work\\', 'a.http'), 'C:\\work\\a.http');
  assert.equal(S.joinPath('/work//', 'a.http'), '/work/a.http');
  assert.equal(S.joinPath('', 'a.http'), 'a.http');
});

await ok('baseName / dirName：两种分隔符都认', () => {
  assert.equal(S.baseName('C:\\a\\b.http'), 'b.http');
  assert.equal(S.baseName('/a/b.http'), 'b.http');
  assert.equal(S.dirName('C:\\a\\b.http'), 'C:\\a');
  assert.equal(S.dirName('/a/b.http'), '/a');
  assert.equal(S.baseName('b.http'), 'b.http');
});

await ok('sanitizeName：Windows 非法字符换掉，中文与空格保留', () => {
  assert.equal(S.sanitizeName('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h');
  assert.equal(S.sanitizeName('订单 服务'), '订单 服务');
  assert.equal(S.sanitizeName('  ..hidden'), 'hidden');
  assert.equal(S.sanitizeName('x'.repeat(200)).length, 80);
  assert.equal(S.sanitizeName(''), 'collection');
  /* 反斜杠也在名单里：它既是分隔符又是 Windows 的路径分隔符，不能留在文件名里 */
  assert.equal(S.sanitizeName('a\\b'), 'a_b');
});

/* ---------------- 4. 换行 ---------------- */

await ok('splitLines：CRLF 原样保留，纯 LF 也是 LF，混用时以 CRLF 为准', () => {
  assert.equal(S.splitLines('a\r\nb\r\n').eol, '\r\n');
  assert.equal(S.splitLines('a\nb\n').eol, '\n');
  assert.equal(S.splitLines('a\r\nb\nc').eol, '\r\n');
  assert.deepEqual(S.splitLines('a\r\nb\r\n').lines, ['a', 'b', '']);
});

/* ---------------- 5. 真文件系统往返（三个平台真跑） ---------------- */

await ok('真磁盘：中文 + 空格 + CRLF 的文件名写进去再读回来，逐字节一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-fsc-'));
  const name = '订单 服务 · 测试.http';
  const p = path.join(dir, name);
  const body = '# 头部\r\n### 一条\r\nGET https://demo.local/a\r\n';
  fs.writeFileSync(p, body, 'utf8');
  assert.equal(fs.readFileSync(p, 'utf8'), body);
  /* 同一个文件用另一套分隔符/大小写写法也要能 stat 到（win/mac 不敏感，linux 敏感） */
  const alt = p.replace(/\\/g, '/');
  assert.equal(fs.existsSync(alt), true, '正斜杠写法应能访问同一个文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok('真磁盘：目录里的 .tmp 不会被误当成 .http（列表只看扩展名）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-fsc-'));
  fs.writeFileSync(path.join(dir, 'a.http'), 'GET https://x/a\r\n');
  fs.writeFileSync(path.join(dir, 'a.http.1-abc.tmp'), 'half');
  const names = fs.readdirSync(dir).filter((n) => /\.(http|rest)$/i.test(n));
  assert.deepEqual(names, ['a.http']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 6. 只有真机才能回答的两件事 ---------------- */

await ok('文件系统大小写敏感度（按平台断言，macOS 只记录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-fsc-'));
  fs.writeFileSync(path.join(dir, 'CaseProbe.http'), 'x');
  const hit = fs.existsSync(path.join(dir, 'caseprobe.http'));
  fs.rmSync(dir, { recursive: true, force: true });
  if (IS_WIN) assert.equal(hit, true, 'Windows 应不区分大小写');
  if (process.platform === 'linux') assert.equal(hit, false, 'Linux 应区分大小写');
  if (IS_MAC) console.log('        macOS 现场：' + (hit ? '不区分大小写（APFS 默认）' : '区分大小写（敏感卷）'));
});

await ok('rename 覆盖语义：Windows 上原生 rename 拒绝覆盖已存在目标', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-fsc-'));
  const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B');
  let err = null;
  try { fs.renameSync(a, b); } catch (e) { err = e; }
  fs.rmSync(dir, { recursive: true, force: true });
  if (IS_WIN) {
    assert.ok(err, 'Windows 上应当抛错——这正是 sidecar 覆盖前必须先腾开目标的原因');
  } else {
    assert.equal(err, null, 'POSIX 上 rename 可以直接覆盖');
  }
});

console.log('\n' + pass + ' passed');
