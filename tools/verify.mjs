/* 交付前静态校验：node tools/verify.mjs
 * 只做契约与接线层面的检查（不启动宿主、不编译 Rust）：
 *   manifest/Cargo 版本一致、脚本引用存在且顺序正确、POLARIS_API 接口齐备、
 *   sidecar 方法与 UI 调用对齐、编辑器关键实现（gutter ▶ / 自动保存 / writeFile）就位。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.3.3';
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
function assert(c, m) { if (!c) throw new Error(m); }

ok(`manifest.json 是合法 JSON 且版本为 ${VERSION}`, () => {
  const m = JSON.parse(read('manifest.json'));
  assert(m.manifest_version === 1, 'manifest_version');
  assert(m.version === VERSION, 'version=' + m.version);
  assert(m.id === 'com.warren.polaris.api', 'id');
  assert(m.name === 'warren-polaris-api', 'name');
  assert(m.publisher === 'warren', 'publisher');
  assert(m.entrypoints.backend.executable === 'bin/dbx-plugin-warren-polaris-api', 'executable');
  assert(m.entrypoints && m.entrypoints.backend && m.entrypoints.ui, 'entrypoints');
  assert(Array.isArray(m.contributions) && m.contributions.length, 'contributions');
  assert(Array.isArray(m.permissions) && m.permissions.includes('host.storage'), 'permissions');
});

ok('Cargo.toml 版本与插件一致', () => {
  assert(new RegExp('version\\s*=\\s*"' + VERSION + '"').test(read('backend/Cargo.toml')), 'Cargo version');
});

ok('Cargo.lock 的包自身版本与 Cargo.toml 一致', () => {
  const lock = read('backend/Cargo.lock');
  const m = lock.match(/name = "dbx-plugin-warren-polaris-api"\r?\nversion = "([^"]+)"/);
  assert(m, 'Cargo.lock 缺少包条目');
  assert(m[1] === VERSION, `Cargo.lock=${m[1]} 与 Cargo.toml=${VERSION} 不一致（--locked 编译会失败）`);
});

ok('index.html 引用的脚本都存在且顺序正确', () => {
  const html = read('ui/index.html');
  const refs = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
  assert(refs.length >= 8, '脚本数量: ' + refs.length);
  refs.forEach(r => assert(fs.existsSync(path.join(root, 'ui', r)), '缺少 ' + r));
  assert(refs.indexOf('http-file.js') < refs.indexOf('http-workspace.js'), 'http-file 应在 workspace 之前');
  assert(refs.indexOf('http-workspace.js') < refs.indexOf('http-editor.js'), 'http-editor 应在 workspace 之后（覆盖按钮绑定）');
});

ok('编辑器入口与容器已挂载', () => {
  const html = read('ui/index.html');
  ['httpFileBtn', 'httpHistoryBtn', 'http-file.js', 'http-workspace.js', 'http-editor.js']
    .forEach(k => assert(html.includes(k), '缺少 ' + k));
});

ok('所有 ui/*.js 语法可编译', () => {
  const files = fs.readdirSync(path.join(root, 'ui')).filter(f => f.endsWith('.js'));
  files.forEach(f => {
    try { new vm.Script(read('ui/' + f), { filename: f }); }
    catch (e) { throw new Error(f + ': ' + e.message); }
  });
});

ok('app.js 的响应钩子与 POLARIS_API 导出就位（含 runRaw）', () => {
  const s = read('ui/app.js');
  assert(s.includes('window.POLARIS_HTTP_WS') && s.includes('onResponse'), '响应钩子');
  assert(s.includes('window.POLARIS_API'), '导出');
  ['addTab', 'showResponse', 'uid', 'blankRow', 'resolveVars', 'runRaw'].forEach(k => assert(s.includes(k + ':'), '缺少导出 ' + k));
  assert(/runRaw:[\s\S]*?showResponse\(resp\)/.test(s), 'runRaw 必须把结果交给 showResponse（进原响应框）');
});

ok('http-workspace.js 调用的接口与导出一致', () => {
  const s = read('ui/http-workspace.js');
  ['A.addTab', 'A.showResponse', 'A.uid', 'A.blankRow', 'POLARIS_HTTP_WS'].forEach(k => assert(s.includes(k), '缺少 ' + k));
});

ok('http-editor.js 关键实现就位', () => {
  const s = read('ui/http-editor.js');
  /* 源码编辑 + gutter 运行按钮 + 自动保存 + 结果进原响应框 */
  ['pa-fe-run', 'data-ri', 'runOne', 'runRaw', 'writeFile', 'scheduleSave', 'parseHttpFile']
    .forEach(k => assert(s.includes(k), '缺少 ' + k));
  assert(/LINE_H\s*=\s*20/.test(s), 'gutter 行高常量');
  assert(/PAD_TOP\s*=\s*10/.test(s), 'gutter 顶部内边距');
  /* 绝不隐藏 .res-region —— 必须保留「原先下面的框」 */
  assert(!/res-region[\s\S]{0,40}display\s*=\s*['"]none/.test(s), '不得隐藏 .res-region');
});

ok('sidecar 具备全部 10 个扩展方法', () => {
  const s = read('backend/src/main.rs');
  ['http/defaultDirs', 'http/listFiles', 'http/readFile', 'http/writeFile', 'http/readEnvFiles',
    'http/saveResult', 'http/listResults', 'http/getResult', 'http/deleteResult', 'http/revealDir',
    'http/request'].forEach(k => assert(s.includes('"' + k + '"'), '缺少 ' + k));
});

ok('dbx-plugin.toml 的 include 覆盖新文件所在目录', () => {
  const s = read('dbx-plugin.toml');
  assert(/include\s*=\s*\[[^\]]*"ui"/.test(s), 'include ui');
  assert(/language\s*=\s*"rust"/.test(s), 'rust backend');
});

ok('侧边栏：请求可重命名、可拖拽跨分组移动', () => {
  const s = read('ui/app.js');
  ['renameSaved', 'moveSaved', 'nextSavedId', 'dragRid'].forEach(k => assert(s.includes(k), '缺少 ' + k));
  assert(s.includes("'rx rr'"), '缺少请求重命名按钮 .rr');
  assert(/item\.draggable\s*=\s*true/.test(s), '请求项必须 draggable');
  assert(s.includes("'drop-before'") && s.includes("'drop-after'"), '缺少插入位置高亮');
  assert(s.includes("'dragging'"), '缺少拖动中样式');
  assert(s.includes('moveSaved(rid,g.id,null)'), '分组头/空白区需支持追加投放');
});

ok('保存弹窗：内联新建分组（不再嵌套模态）+ 名称 trim', () => {
  const s = read('ui/app.js');
  const body = s.slice(s.indexOf('function saveCurrent'), s.indexOf('function openSaved'));
  assert(body.length > 100, '未找到 saveCurrent');
  assert(body.includes('mNewGroup'), '缺少内联新分组输入框 mNewGroup');
  assert(!body.includes('PD.ask('), 'saveCurrent 内不得再嵌套 PD.ask（会清空外层弹窗导致失效）');
  assert(/return false/.test(body), '校验失败需 return false 保持弹窗');
  assert(/\(vals\.mName\|\|''\)\.trim\(\)/.test(body), '名称需 trim 后再用');
});

ok('输入法保护：合成中的 Enter 不当作确认', () => {
  ['ui/app.js', 'ui/dialogs.js'].forEach((f) => {
    const s = read(f);
    assert(/isComposing\s*\|\|/.test(s) || /e\.isComposing/.test(s), f + ' 缺少 isComposing 判断');
  });
});

ok('侧边栏样式：重命名按钮与拖拽态', () => {
  const css = read('ui/app.css');
  ['.req-item .rr', '.req-item.dragging', '.req-item.drop-before', '.req-item.drop-after', '.drop-on']
    .forEach((k) => assert(css.includes(k), '缺少样式 ' + k));
});

ok('README 记录了编辑器能力与限制', () => {
  const s = read('README.md');
  ['.http', '自动保存', '▶', '结果目录', '历史结果', '运行全部', '不执行'].forEach(k => assert(s.includes(k), '缺少 ' + k));
});

console.log('\n' + pass + ' checks passed');
