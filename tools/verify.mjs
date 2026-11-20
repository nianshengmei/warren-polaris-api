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
const VERSION = '0.9.0';
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
  assert(refs.indexOf('workspace-map.js') >= 0, '缺少 workspace-map.js（侧栏映射）');
  assert(refs.indexOf('workspace-map.js') < refs.indexOf('app.js'), 'workspace-map 应在 app 之前（boot 时要用）');
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
  ['http/defaultDirs', 'http/listFiles', 'http/readFile', 'http/writeFile', 'http/readEnvFiles', 'http/pickFile',
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
  /* 文件真源（v0.9.0）下跨文件搬段会丢注释，暂停拖拽；实现与样式都还在 */
  assert(/item\.draggable\s*=\s*(true|!DOCS\.enabled)/.test(s), '请求项必须可拖拽');
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

ok('v0.4.0：打开（系统对话框）/ 拖入 / 可反复保存 就位', () => {
  const ed = read('ui/http-editor.js');
  ['http/pickFile', 'paFeSaveAs', 'saveAs', 'pickNative', 'dropFiles', 'bindDrop',
    'onDrop', 'matchRegistered', 'writeCopy', 'saveCount'].forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/doSave\([\s\S]{0,200}!S\.path[\s\S]{0,120}saveAs\(\)/.test(ed), '未绑定磁盘时 doSave 必须转另存为');
  assert(ed.includes("noClobber"), '复制副本需 noClobber 防覆盖');
  const bk = read('backend/src/main.rs');
  assert(bk.includes('fn handle_pick_file'), '缺少 sidecar handle_pick_file');
  assert(/fn native_dialog/.test(bk), '缺少 native_dialog 平台实现');
  /* Ctrl+S 不得在 .http 模式下再触发请求 tab 保存 */
  const app = read('ui/app.js');
  assert(/inEditor[\s\S]{0,80}saveCurrent/.test(app), 'app.js 的 Ctrl+S 需为编辑器让路');
});

ok('S2.5c：浮层只剩「接口一览 + 源码」，文件入口收归侧栏', () => {
  const ed = read('ui/http-editor.js');
  const app = read('ui/app.js');
  /* 浮层里不该再有文件列表与被删掉的扫目录 API */
  ['paFeDir', 'paFeList', 'paFeScan', 'paFeNew', 'paFeImport', 'paFeOpen',
    'http/listFiles', 'renderFiles', 'refreshFiles', 'matchScanned'].forEach(k => {
    assert(!ed.includes(k), '浮层里不应再有 ' + k);
  });
  /* 工作目录改为从映射文件所在目录推导，另存为 / 副本仍要有落点 */
  assert(ed.includes('function workspaceDir'), '缺少 workspaceDir()');
  assert(/workspaceDir\(\)[\s\S]{0,80}POLARIS_DOCS/.test(ed), 'workspaceDir 需回落到映射目录');
  /* 侧栏文件分组要有进源码的入口 */
  assert(app.includes('openSourceForFile'), '缺少侧栏 → 源码入口');
  assert(/openSourceForFile[\s\S]{0,200}openPath/.test(app), 'openSourceForFile 需调 openPath');
});

ok('S2.5d：归位与排序只改映射，请求级拖拽走整段搬移', () => {
  const app = read('ui/app.js');
  const st = read('ui/http-store.js');
  const css = read('ui/app.css');
  const mp = read('ui/workspace-map.js');
  /* 文件归位/排序：落点算下标，走 POLARIS_MAP.moveTo，落盘后重渲染 */
  assert(app.includes('function applyFileMove'), '缺少 applyFileMove()');
  assert(/applyFileMove[\s\S]{0,600}POLARIS_MAP|applyFileMove[\s\S]{0,600}M\.moveTo/.test(app), '归位必须走 POLARIS_MAP.moveTo');
  assert(app.includes('function bindFileDrag'), '缺少文件行拖拽绑定');
  assert(app.includes('function dropIndex'), '缺少 dropIndex（先摘后插的下标）');
  assert(app.includes('root-zone'), '缺少拖回根的投放区 .root-zone');
  /* 拖拽手柄只给文件头：请求行自己有 draggable，套在一起会互相抢 */
  assert(/bindFileDrag[\s\S]{0,300}group-head/.test(app), '文件拖拽手柄应是 .group-head');
  assert(!/item\.draggable\s*=\s*!DOCS\.enabled/.test(app), '请求行不应再按 DOCS.enabled 关掉拖拽');
  /* 请求级：同一文件内整段搬移，跨文件仍拒绝 */
  assert(app.includes('function moveRequestInFile'), '缺少 moveRequestInFile()');
  assert(/moveRequestInFile[\s\S]{0,900}moveSegment/.test(app), '同文件调序需走 store.moveSegment');
  assert(/跨文件/.test(app), '跨文件搬段要给出明确提示');
  assert(st.includes('function moveSegmentText'), '缺少 moveSegmentText()');
  assert(/moveSegmentText[\s\S]{0,1200}prefix/.test(st), '整段搬移必须保留文件头（prefix）');
  assert(/moveSegment:\s*async function/.test(st), 'store 需暴露 moveSegment');
  /* 拖拽视觉：文件行上下半区 + 投放高亮 */
  ['dragging-file', 'drop-before', 'drop-after', 'root-zone'].forEach(k => assert(css.includes(k), '缺少样式 ' + k));
  /* 归位原语仍在（不许另起一套） */
  ['function moveTo', 'function relocate', 'function unregister', 'function addFolder'].forEach(k =>
    assert(mp.includes(k), '映射层缺少 ' + k));
});

ok('S3.1：浮层拖拽走位移，位置落偏好、双击复位', () => {
  const ed = read('ui/http-editor.js');
  /* 位置用 --fe-dx/--fe-dy 位移，不改 left/top（改了宽度会被压变形） */
  assert(/\.pa-fe\{--fe-dx:0px;--fe-dy:0px/.test(ed), '浮层需用 --fe-dx/--fe-dy 记位移');
  assert(/transform:translate\(var\(--fe-dx\),var\(--fe-dy\)\)/.test(ed), '浮层定位应走 translate(dx,dy)');
  assert(ed.includes('function applyFePos'), '缺少 applyFePos()');
  assert(ed.includes('function clampFePos'), '缺少 clampFePos()（拖出窗口要夹回）');
  assert(ed.includes('function bindPaneDrag'), '缺少 bindPaneDrag()');
  assert(/bindPaneDrag[\s\S]{0,2000}requestAnimationFrame/.test(ed), '拖拽需 rAF 合帧');
  assert(/bindPaneDrag[\s\S]{0,1400}setPointerCapture/.test(ed), '拖拽需 setPointerCapture');
  assert(/bindPaneDrag[\s\S]{0,3000}dblclick/.test(ed), '双击标题条应复位');
  /* 标题条里的按钮/下拉不能当拖拽手柄 */
  assert(/isCtl[\s\S]{0,160}closest\('button,select,input/.test(ed), '拖拽应跳过按钮/下拉');
  /* 位置持久化 + 启动恢复 + 布局变化后重夹 */
  assert(/feX:\s*Math\.round\(S\.feX\)/.test(ed), 'feX 需写进偏好');
  assert(/isFinite\(p\.feX\)/.test(ed), '启动时需恢复 feX');
  assert(ed.includes('function reclampFe'), '缺少 reclampFe()（窗口缩放后重夹）');
  assert(/setPointerCapture/.test(ed), '拖拽需 setPointerCapture');
  /* 收起态不许拖：off 时本来也点不到，但状态机要拦住 */
  assert(/pointerdown[\s\S]{0,200}S\.collapsed\) return/.test(ed), '收起态不应起拖');
});

ok('v0.5.0：接口一览 + 语法着色 + 折叠 就位', () => {
  const ed = read('ui/http-editor.js');
  /* 一览 */
  ['paFeOList', 'renderOutline', 'gotoLine', 'urlTail', 'reqName', 'nameAuto', 'paFeOCount']
    .forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/function urlTail\([\s\S]{0,600}slice\(-2\)/.test(ed), 'urlTail 需保留末两段');
  /* 着色 */
  ['.t-sepname', '.t-m-get', '.t-jkey', '.t-jstr', '.t-jnum', '.t-jbool', '.t-jnull', '.t-var']
    .forEach(k => assert(ed.includes(k), '缺少样式 ' + k));
  assert(ed.includes('paFeHl') && ed.includes('hl-on'), '缺少高亮代码层');
  assert(/font-variant-ligatures:none/.test(ed), '高亮层需禁用连字，否则与 textarea 错位');
  /* 折叠：文档权威 + 折叠时保存必须写全文 */
  assert(ed.includes('function docText()'), '缺少 docText()');
  assert(/doSave[\s\S]{0,900}docText\(\)/.test(ed), 'doSave 必须用 docText()（折叠时不能写投影）');
  ['paFeGinner', 'toggleFold', 'buildView', 'expandFoldsForEdit']
    .forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(!/var content = ta\.value/.test(ed), '落盘内容不能直接取 ta.value');

  /* 解析器：连续 3 个以上 # + 空格/Tab 才是标题 */
  const hf = read('ui/http-file.js');
  assert(/\/\^#\{3,\}\[ \\t\]\+\(\.\+\)\$\/\.exec/.test(hf), '标题正则应为 ^#{3,}[ \\t]+(.+)$');
  assert(hf.includes('nameAuto'), '缺少 nameAuto 标记');
});

ok('v0.5.1：multipart 按字节拼装 + 附件二进制读取', () => {
  const hf = read('ui/http-file.js');
  const ed = read('ui/http-editor.js');
  const rs = read('backend/src/main.rs');
  const app = read('ui/app.js');

  /* 解析器 */
  ['parseMultipart', "cur.bodyType = 'multipart'", 'filePath', 'multipart/form-data; boundary=']
    .forEach(k => assert(hf.includes(k), '解析器缺少 ' + k));
  assert(/!bodyBuf\.length/.test(hf), '< 文件 只在 body 为空时才算整包引用（段内必须保留）');

  /* UI 组装 */
  ['buildMultipart', 'b64ToBytes', 'bytesToB64', 'TextEncoder', 'mimeOf']
    .forEach(k => assert(ed.includes(k), '编辑器缺少 ' + k));
  assert(/\\r\\n\\r\\n/.test(ed), 'multipart 必须用 CRLF 分隔头与内容');
  assert(/headers\['Content-Type'\] = mp\.contentType/.test(ed), 'Content-Type 必须与实际 boundary 对齐');
  assert(/binary: true/.test(ed), '附件必须以 binary 读取');
  assert(app.includes('bodyBase64'), 'runRaw 需透传 bodyBase64');

  /* sidecar */
  assert(/bodyBase64/.test(rs) && /BASE64_STANDARD\s*\.decode/.test(rs), 'sidecar 需支持 base64 原始 body');
  assert(/params\.get\("binary"\)/.test(rs), 'readFile 需支持 binary 参数');
  assert(/fn handle_read_file[\s\S]{0,1200}BASE64_STANDARD\.encode/.test(rs), 'readFile 的 binary 分支需返回 base64');
  assert(/raw_body[\s\S]{0,600}req\.body\(bytes\)/.test(rs), '原始字节 body 必须按 bytes 发送');
});

ok('v0.6.0：.http 浮层 + 右缘悬浮箭头', () => {
  const ed = read('ui/http-editor.js');

  /* 浮层挂到 .work（绝对定位），不再塞进 .req-region */
  assert(/querySelector\('\.work'\)/.test(ed), '浮层必须挂到 .work 下');
  assert(/\.pa-root \.work\{position:relative\}/.test(ed), '.work 需要 position:relative');
  assert(/\.pa-fe\.off\{transform:translate\(calc\(var\(--fe-dx\) \+ var\(--fe-slide/.test(ed), '收起动画仍应走 --fe-slide（S3.1 后带 --fe-dx 偏移）');
  assert(/--fe-slide/.test(ed), '滑出距离需按工作区宽度算');

  /* 三态 + 箭头 */
  ['function collapse(', 'function expand(', 'function exitMode(']
    .forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/\.pa-root \.pa-edge\.on\{/.test(ed), '箭头缺少 .on 展示态');
  assert(/backdrop-filter:blur/.test(ed), '箭头需要磨砂半透明');
  assert(/edgeTop/.test(ed), '箭头位置需要持久化');
  assert(/pointerdown/.test(ed) && /setPointerCapture/.test(ed), '箭头需要可拖动');
  assert(/contextmenu/.test(ed), '箭头右键应彻底关闭');

  /* 点 tab / 侧栏自动收起 + 快捷键归属 */
  assert(/byId\('tabbar'\)[\s\S]{0,200}collapse\(true\)/.test(ed), '点请求 tab 应自动收起浮层');
  assert(/isOpen: function \(\) \{ return S\.open && !S\.collapsed; \}/.test(ed), 'isOpen 只代表浮层当前可见');
  assert(!/pane\.hidden = /.test(ed), '浮层不应再用 hidden 属性（会吃掉动画）');
});

ok('v0.6.1：打开 .http 只弹对话框；启动只挂箭头', () => {
  const ed = read('ui/http-editor.js');

  /* pickAndOpen 不能先 enterMode */
  const pick = ed.slice(ed.indexOf('async function pickAndOpen'),
                        ed.indexOf('async function pickAndOpen') + 1200);
  assert(!/enterMode\(\)/.test(pick.split('catch')[0].split('pickNative')[0] || ''), 'pickAndOpen 弹框前不能展开浮层');
  assert(!/^\s*enterMode\(\);\s*$/m.test(pick.split('pickNative')[0]), 'pickAndOpen 弹框前不能 enterMode');
  assert(/pick\.cancelled\) return/.test(pick), '取消时应直接返回、不动界面');

  /* openPath 支持恢复模式：不展开、不扫描 */
  assert(/async function openPath\(p, opts\)/.test(ed), 'openPath 需要 opts');
  assert(/opts\.restore[\s\S]{0,300}armEdge\(\)/.test(ed), '恢复模式应只挂箭头');
  assert(/function armEdge\(/.test(ed), '缺少 armEdge');
  assert(/\{ restore: true \}/.test(ed), '启动恢复需要传 restore 标记');

  /* S2.5c：展开也不再扫目录 —— 侧栏是唯一文件入口，浮层只读当前文件 */
  assert(!/function expand\(\)[\s\S]{0,600}scan\(\)/.test(ed), '展开时不应再扫描目录');
});

ok('v0.6.2：自带示例 + SSE 流式', () => {
  const ed = read('ui/http-editor.js');
  const sm = read('ui/sample-http.js');
  const rs = read('backend/src/main.rs');
  const app = read('ui/app.js');
  const hf = read('ui/http-file.js');
  const idx = read('ui/index.html');

  /* 示例随包发布 + 引入顺序 */
  assert(/sample-http\.js/.test(idx), 'index.html 需引入 sample-http.js');
  assert(idx.indexOf('sample-http.js') < idx.indexOf('http-editor.js'), '示例要在编辑器之前加载');
  const headings = (sm.match(/^### /gm) || []).length;
  assert(headings === 8, '示例应有 8 节，实际 ' + headings);
  ['GET ', 'POST ', 'multipart/form-data', 'text/event-stream', 'x-www-form-urlencoded',
   '@baseUrl', '@apiBase', 'data: [DONE]', '{{$guid}}', 'response.body.$.'
  ].forEach(k => assert(sm.includes(k), '示例缺少 ' + k));
  assert(sm.includes('__AUDIO_PATH__'), '示例用占位符注入附件路径');
  assert(/replace\(\/__AUDIO_PATH__\/g, attachPath\)/.test(ed), '写入时替换成本机绝对路径');
  assert(!/sk-[A-Za-z0-9]{20,}/.test(sm), '示例不能夹带真实 Key');
  assert(!/1793933720837243|1776153319097387/.test(sm), '示例不能夹带参考文件里的真实 ID');

  /* 默认位置初始化 */
  assert(/async function ensureDefaultSample/.test(ed), '缺少 ensureDefaultSample');
  assert(/examples\.http/.test(ed), '默认文件名应为 examples.http');
  assert(/noClobber: true/.test(ed), '写示例必须 noClobber，不能覆盖用户文件');
  assert(/ensureDefaultSample\(\)[\s\S]{0,500}openPath\(sample, \{ restore: true \}\)/.test(ed), '示例也要以 restore 方式挂箭头');
  assert(/var sample = await ensureDefaultSample\(\);/.test(ed), '示例应在恢复前就确保存在（老用户也能拿到）');
  assert(/restored = \(await openPath\(prefs\.lastPath, \{ restore: true \}\)\) === true/.test(ed), '上次文件失败要能回落');

  /* SSE 后端 */
  assert(/let wants_sse/.test(rs), '后端需识别 SSE 请求');
  assert(/sse_ms/.test(rs), 'SSE 需要独立的读取上限');
  assert(/resp\.read\(&mut tmp\)/.test(rs), 'SSE 必须流式读，不能一次性 bytes()');
  assert(/sseTruncated/.test(rs), '响应需带 sseTruncated');
  assert(/sseTruncated/.test(app), '前端需展示 SSE 截断状态');

  /* multipart 路径支持变量 + 标题优先 */
  assert(/pathJoin\(base, rv\(p\.filePath\)\)/.test(ed), 'multipart 附件路径要支持变量');
  assert(/title: pendingTitle/.test(hf), '解析器需保留 ### 标题');
  assert(/var ti = String\(\(r && r\.title\)/.test(ed), '接口一览优先显示标题');
});

ok('README 带 .http 操作方式与完整示例', () => {
  const rd = read('README.md').replace(/\r\n/g, '\n');
  assert(/### 怎么用（从打开到跑起来）/.test(rd), 'README 需要「怎么用」操作小节');
  ['打开', '找接口', '跑一条', '跑全部', '收起与找回'].forEach(k => assert(rd.includes(k), '操作小节缺步骤：' + k));
  assert(/### 完整示例：`examples\.http`/.test(rd), 'README 需要完整示例小节');
  assert(/<!-- SAMPLE:BEGIN -->\n```http\n/.test(rd), '示例要放进 http 代码块');
  assert(/<!-- SAMPLE:END -->/.test(rd), '示例代码块缺结束标记');
  assert(/data: \[DONE\]/.test(rd), 'README 示例要含 SSE 的 [DONE]');
  assert(/sync-readme-sample\.mjs/.test(rd), 'README 要说明示例由脚本同步');
});

ok('v0.6.3：打开文件停在第一行', () => {
  const ed = read('ui/http-editor.js');
  const doc = ed.slice(ed.indexOf('function setDoc'), ed.indexOf('function syncScroll'));
  assert(/setSelectionRange\(0, 0\)/.test(doc), 'setDoc 要把光标归零');
  assert(/ta\.scrollTop = 0/.test(doc), 'setDoc 要把滚动归零');
});

ok('v0.6.4：图标/文案/署名与上游可区分', () => {
  const svg = read('assets/plugin.svg');
  assert(!/#6d5dfc|#2b6de8/i.test(svg), '图标不能沿用上游的紫蓝渐变');
  assert(/14b8a6|0b5f57/i.test(svg), '图标应为本 fork 的青绿色板');
  const notice = read('NOTICE');
  assert(/misxzaiz/i.test(notice), 'NOTICE 要署名上游作者');
  assert(/v0\.2\.0/.test(notice), 'NOTICE 要写明派生自 v0.2.0');
  assert(/Apache License, Version 2\.0/i.test(notice), 'NOTICE 要声明 Apache-2.0');
  const toml = read('dbx-plugin.toml');
  assert(/include\s*=\s*\[[^\]]*"LICENSE"[^\]]*\]/.test(toml), 'include 要带 LICENSE');
  assert(/include\s*=\s*\[[^\]]*"NOTICE"[^\]]*\]/.test(toml), 'include 要带 NOTICE');
  const m = JSON.parse(read('manifest.json'));
  assert(/fork/i.test(m.description), 'manifest 描述要说明是 fork');
  const store = JSON.parse(read('.dbx-store.json'));
  assert(/community fork/i.test(store.description), '商店描述要说明 community fork');
  assert(/misxzaiz/i.test(store.releaseNotes) && /0\.2\.0/.test(store.releaseNotes), '版本说明要注明派生来源');
  assert(/许可与署名/.test(read('README.md')), 'README 需要「许可与署名」小节');
});

/* ---------- v0.9.0 / M1：文件真源 ---------- */

ok('http-store.js 已接入 index.html 且排在 http-file.js 之后', () => {
  const html = read('ui/index.html');
  const a = html.indexOf('./http-file.js');
  const b = html.indexOf('./http-store.js');
  assert(a > 0 && b > a, 'http-store.js 必须在 http-file.js 之后加载');
  assert(b < html.indexOf('./app.js'), 'http-store.js 必须在 app.js 之前加载');
});

ok('http-store.js 导出 createStore 与段落级 API', () => {
  const src = read('ui/http-store.js');
  ['createStore', 'invokeHost', 'writeRequest', 'writeText', 'locateSegment', 'segIndexOfRequest', 'replaceSegment', 'sanitizeName'].forEach((k) => {
    assert(src.indexOf(k + ':') > 0 || src.indexOf('function ' + k) > 0, '缺少 ' + k);
  });
  assert(/POLARIS_STORE/.test(src), '要挂 window.POLARIS_STORE');
});

ok('解析器认身份：@file_id / @interface_id 只取首个 token', () => {
  const src = read('ui/http-file.js');
  assert(/ID_LINE_RE/.test(src), '缺少身份行正则');
  assert(/@\(file\|interface\)\[_-\]id/.test(src), '正则要同时接受下划线与短横线');
  assert(/interfaceId/.test(src) && /fileId/.test(src), '返回值要带 fileId / interfaceId');
});

ok('序列化器存在，且只被 store/迁移使用（不接管日常保存）', () => {
  const src = read('ui/http-file.js');
  assert(/function serializeRequest/.test(src), '缺少 serializeRequest');
  assert(/function serializeCollection/.test(src), '缺少 serializeCollection');
  const store = read('ui/http-store.js');
  assert(/serializeRequest\(/.test(store), 'store 的段落写回应当用 serializeRequest');
});

ok('sidecar 新增四个文件命令，UI 调用与实现对齐', () => {
  const rs = read('backend/src/main.rs');
  ['http/statFile', 'http/deleteFile', 'http/renameFile', 'http/ensureDir'].forEach((cmd) => {
    assert(rs.indexOf('"' + cmd + '"') > 0, 'main.rs 缺少 ' + cmd);
  });
  const store = read('ui/http-store.js');
  ['http/statFile', 'http/deleteFile', 'http/renameFile', 'http/ensureDir', 'http/listFiles', 'http/readFile', 'http/writeFile'].forEach((cmd) => {
    assert(store.indexOf(cmd) > 0, 'http-store.js 未调用 ' + cmd);
  });
});

ok('M1 测试夹具与四个测试文件齐全', () => {
  ['minimal.http', 'handwritten.http', 'with-ids.http', 'messy.http'].forEach((f) => {
    assert(fs.existsSync(path.join(root, 'tools/fixtures', f)), '缺少夹具 ' + f);
  });
  ['fixtures.test.mjs', 'serialize.test.mjs', 'store.test.mjs', 'migrate.test.mjs', 'project.test.mjs'].forEach((f) => {
    assert(fs.existsSync(path.join(root, 'tools', f)), '缺少测试 ' + f);
  });
});

/* ---------- v0.9.0 / S1.5：侧栏改文件源 ---------- */

ok('侧栏数据源切到资源目录（DOCS 层 + 投影 + 重绑）', () => {
  const s = read('ui/app.js');
  ['initDocs', 'refreshDocs', 'applyDocs', 'patchGroup', 'rebindTabs', 'findDocRequest',
    'saveToDoc', 'saveToDocNew', 'appendToDoc', 'storeReqFromTab', 'scheduleDocsRefresh'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0 || s.indexOf(k + '=') > 0, 'app.js 缺少 ' + k);
  });
  assert(/POLARIS_STORE/.test(s), 'app.js 要用 window.POLARIS_STORE');
  assert(/toLegacyCollections\(/.test(s), '投影层必须被调用');
  assert(/await initDocs\(\)/.test(s), 'initApi 里要 await initDocs()');
});

ok('集合不再写 storage（文件是唯一真源），旧数据只迁移一次', () => {
  const s = read('ui/app.js');
  assert(/if\(!DOCS\.enabled\) snap\.collections/.test(s), 'persist 在文件真源下不得写 collections');
  assert(/migrateFromStorage\(/.test(s), '缺少旧数据迁移调用');
  assert(/ui\.migratedAt/.test(s), '迁移需要幂等标记');
});

ok('store 具备追加 / 删除一段的能力（侧栏保存与删除依赖）', () => {
  const s = read('ui/http-store.js');
  ['appendRequest', 'deleteRequest'].forEach((k) => {
    assert(s.indexOf(k + ':') > 0, 'http-store.js 缺少 ' + k);
  });
  const app = read('ui/app.js');
  assert(/appendRequest\(/.test(app) && /deleteRequest\(/.test(app), 'app.js 未接到 append/delete');
});

ok('侧栏提供手动重扫入口（外部改动可见）', () => {
  const html = read('ui/index.html');
  assert(/id="refreshDocs"/.test(html), '侧栏缺少重新扫描按钮');
  const s = read('ui/app.js');
  assert(/'#refreshDocs'/.test(s), '按钮未绑定');
  assert(/addEventListener\('focus'/.test(s), '切回窗口时要自动重扫');
});

/* ---------- v0.9.0 / S2.2：反向刷新 + 冲突 ---------- */

ok('S2.2 反向刷新：干净 tab 同步磁盘，脏 tab 挂冲突', () => {
  const s = read('ui/app.js');
  ['syncTabsWithDocs', 'applyRequestToTab', 'renderConflictBar', 'resolveConflict'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/syncTabsWithDocs\(\);/.test(s), 'refreshDocs 里要调 syncTabsWithDocs');
  assert(/if\(t\.dirty\)/.test(s) && /t\.docConflict=\{/.test(s), '脏 tab 必须挂冲突标记而不是覆盖');
});

ok('S2.2 写回基线跟着 tab 走（不能拿刚扫出的 mtime）', () => {
  const s = read('ui/app.js');
  assert(/t\.baseMtime/.test(s), '缺少 tab 级 baseMtime');
  assert(/baseMtime:\s*t\.baseMtime!=null\?t\.baseMtime:f\.g\.mtime/.test(s),
    'saveToDoc 的 baseMtime 必须优先用 tab 基线');
  assert(/function setTabDocRef\(t,path,req,mtime\)/.test(s), 'setTabDocRef 要接收 mtime');
  assert(/CONFLICT/.test(s), '缺少 CONFLICT 分支');
});

ok('S2.2 冲突栏 UI：三选一，不做隐式覆盖', () => {
  assert(/id="docConflict"/.test(read('ui/index.html')), 'index.html 缺少冲突栏容器');
  const s = read('ui/app.js');
  ['加载磁盘版本', '保留我的', '稍后'].forEach((k) => assert(s.indexOf(k) > 0, '冲突栏缺少按钮 ' + k));
  const css = read('ui/app.css');
  assert(/\.doc-conflict/.test(css) && /\.rtab \.conflict/.test(css), '缺少冲突栏 / tab 标记样式');
});

ok('S2.2 编辑器：保存前比对 mtime，冲突停手', () => {
  const ed = read('ui/http-editor.js');
  ['markDiskVersion', 'diskChanged', 'renderConflictHint', 'resolveConflict'].forEach((k) => {
    assert(ed.indexOf('function ' + k) > 0, 'http-editor.js 缺少 ' + k);
  });
  assert(/await diskChanged\(\)/.test(ed), 'doSave 必须先比对磁盘版本');
  assert(/S\.loadedText/.test(ed), '需要 loadedText 排除假冲突（mtime 变了但内容一样）');
  assert(/paFeConflict/.test(ed), '缺少编辑器冲突提示条');
  assert(/S\.conflict\)\s*\{[\s\S]{0,120}return false/.test(ed), '有冲突时自动保存必须停手');
});

/* ---------- v0.9.0 / S2.3：双向跳转 ---------- */

ok('S2.3 表单 → 源码：请求栏「</>」+ 编辑器 openAt', () => {
  assert(/id="srcBtn"/.test(read('ui/index.html')), '请求栏缺少 </> 按钮');
  const s = read('ui/app.js');
  ['openSourceForTab', 'openInFormForDoc', 'locateDocRequest'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/'#srcBtn'/.test(s), '</> 按钮未绑定');
  assert(/POLARIS_EDITOR\.openAt\(/.test(s), '要调编辑器的 openAt');
  assert(/openInSource/.test(s), 'POLARIS_DOCS 要暴露 openInSource');
  const ed = read('ui/http-editor.js');
  ['openAt', 'openInForm', 'ensureFresh'].forEach((k) => {
    assert(ed.indexOf('function ' + k) > 0, 'http-editor.js 缺少 ' + k);
  });
  assert(/openAt: openAt/.test(ed), '编辑器要暴露 openAt');
  /* 同一文件被表单改过：不脏就必须重读，否则跳过去看到的是旧 URL */
  assert(/ensureFresh\(path\)/.test(ed), '同文件跳转前要校验磁盘版本');
});

ok('S2.3 源码 → 表单：gutter ▤ + 接口一览 ▤', () => {
  const ed = read('ui/http-editor.js');
  assert(/pa-fe-form/.test(ed), 'gutter 缺少 ▤ 入口');
  assert(/pa-fe-oif/.test(ed), '接口一览缺少 ▤ 入口');
  assert(/openInForm\(fr\)/.test(ed) && /openInForm\(ifr\)/.test(ed), '▤ 点击未接到 openInForm');
  assert(/openInForm: function/.test(read('ui/app.js')), 'POLARIS_DOCS 要暴露 openInForm');
  /* 认段顺序必须是 id → 行号+方法 → 名称+方法（唯一），不许靠 URL 猜 */
  const s = read('ui/app.js');
  assert(/function locateDocRequest[\s\S]{0,400}interfaceId[\s\S]{0,300}line[\s\S]{0,300}name/.test(s),
    'locateDocRequest 的认段顺序应为 id → 行号 → 名称');
});

/* ---------- v0.9.0 / S2.4：变量统一 ---------- */

ok('S2.4 表单侧不再自己实现一套变量解析', () => {
  const s = read('ui/app.js');
  const fn = s.slice(s.indexOf('function resolveVars(str,t)'), s.indexOf('function resolveVars(str,t)') + 700);
  assert(/POLARIS_HTTP/.test(fn), 'resolveVars 必须复用 http-file.js 的实现');
  assert(/resolveDeep|resolveVars/.test(fn), '要调 resolveDeep/resolveVars');
  assert(/fileVars/.test(fn), '要带文件级变量');
  assert(/envAsVars/.test(s), '缺少 envAsVars（环境 → 变量表）');
  /* 旧实现只认环境，出现「{{baseUrl}} 之外一律原样」的写法即为回退 */
  assert(!/function resolveVars\(str\)\{/.test(s), '旧的单参 resolveVars 应当已经删掉');
});

ok('S2.4 发送链路把 tab 传进 resolveVars', () => {
  const s = read('ui/app.js');
  assert(/resolveVars\(t\.url\.trim\(\),t\)/.test(s), 'URL 求值要带 tab');
  assert(/resolveVars\(r\.v,t\)/.test(s), 'header 值求值要带 tab');
  assert(/body=resolveVars\(t\.body,t\)/.test(s), 'body 求值要带 tab');
});

ok('S2.4 fileVars 跟着 tab 走：打开 / 重绑 / 保存后都对齐', () => {
  const s = read('ui/app.js');
  assert(s.indexOf('function syncTabVars') > 0, '缺少 syncTabVars');
  assert(/function openSaved[\s\S]{0,900}syncTabVars\(t\)/.test(s), 'openSaved 要同步 fileVars');
  assert(/function setTabDocRef[\s\S]{0,500}syncTabVars\(t\)/.test(s), 'setTabDocRef 要同步 fileVars');
  assert(/function rebindTabs[\s\S]{0,600}syncTabVars\(t\)/.test(s), 'rebindTabs 要同步 fileVars');
  assert(/function fileVarsOf[\s\S]{0,200}group\.fileVars|g\.fileVars/.test(s), 'fileVarsOf 应从投影后的分组取');
});

ok('S2.4 投影层透传 fileVars', () => {
  const store = read('ui/http-store.js');
  assert(/fileVars:\s*c\.fileVars\s*\|\|\s*\{\}/.test(store), 'toLegacyCollections 要带 fileVars（默认空对象）');
});

ok('S2.4 环境以 http-client.env.json 为真源', () => {
  const s = read('ui/app.js');
  ['loadEnvsFromFile', 'saveEnvsToFile', 'envsFromFile', 'envsToFile'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/await loadEnvsFromFile\(\)/.test(s), 'initDocs 之后要从文件读环境');
  assert(/function close\(\)\{[\s\S]{0,300}saveEnvsToFile\(\)/.test(s), '环境面板关闭要写回文件');
  assert(/rememberEnv\(/.test(s), '要记住当前环境名，下次启动才找得回来');
});

ok('S2.4 跨请求引用认中文请求名', () => {
  const h = read('ui/http-file.js');
  assert(/\\p\{L\}/.test(h), 'response.body 的正则要用 \\p{L}，否则「登录」这种名字匹配不到');
  assert(/function resolveDeep/.test(h), '缺少 resolveDeep（变量值里套占位符要一次解到底）');
  assert(/resolveDeep:\s*resolveDeep/.test(h), 'resolveDeep 要导出');
});

console.log('\n' + pass + ' checks passed');
