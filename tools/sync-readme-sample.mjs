/* 把 ui/sample-http.js 里的示例原文同步进 README 的代码块，避免文档和包里那份走偏。
 * 用法：node tools/sync-readme-sample.mjs          （写入）
 *       node tools/sync-readme-sample.mjs --check  （只校验，CI/自测用）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
global.window = global;
require('../ui/sample-http.js');

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const README = path.join(ROOT, 'README.md');
const BEGIN = '<!-- SAMPLE:BEGIN -->';
const END = '<!-- SAMPLE:END -->';

const raw = String(window.POLARIS_SAMPLE.http || '').replace(/__AUDIO_PATH__/g, 'D:\\音频\\sample-upload.txt');
/* 代码块里不能出现未转义的三反引号；示例本身没有，兜底替换一下更稳 */
const body = raw.replace(/```/g, '``\u200b`').replace(/\s+$/, '');

const mdRaw = fs.readFileSync(README, 'utf8');
/* README 是 CRLF：统一在 LF 空间里改，写回时再还原，避免整文件换行被刷 */
const EOL = mdRaw.includes('\r\n') ? '\r\n' : '\n';
const md = mdRaw.replace(/\r\n/g, '\n');

const b = md.indexOf(BEGIN);
const e = md.indexOf(END);
if (b < 0 || e < b) {
  console.error('README 里找不到 SAMPLE 标记，先手工放一对 ' + BEGIN + ' / ' + END);
  process.exit(2);
}

const block = `${BEGIN}\n\`\`\`http\n${body}\n\`\`\`\n${END}`;
const nextLf = md.slice(0, b) + block + md.slice(e + END.length);
const changed = nextLf !== md;

if (process.argv.includes('--check')) {
  if (changed) {
    console.error('README 里的示例与 ui/sample-http.js 不一致，跑一次 node tools/sync-readme-sample.mjs');
    process.exit(1);
  }
  console.log('README 示例与 sample-http.js 一致（' + body.split('\n').length + ' 行）');
} else if (changed) {
  fs.writeFileSync(README, nextLf.replace(/\n/g, EOL), 'utf8');
  console.log('README 示例已同步（' + body.split('\n').length + ' 行）');
} else {
  console.log('无需改动');
}
