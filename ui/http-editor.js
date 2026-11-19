/* http-editor.js — .http / .rest 源码编辑器（v0.4.0）
 *
 * 用户诉求：像 IDEA 一样「以文件格式」打开 .http —— 源码可直接编辑、自动保存 / 手动保存，
 * 每个请求首行左侧一个 ▶ 启动标识，点一下就跑，结果渲染进**原先下方那个响应框**
 * （.res-region / #resPane，由 app.js 的 renderResponse 负责，这里完全不碰）。
 *
 * 实现要点
 *   · 面板注入 .req-region 内部（#fileEditorPane），只隐藏 #reqSubtabs / #reqPane / .reqbar；
 *     .res-region 原封不动 —— 这就是「原先的框」。
 *   · 文本区是 textarea(wrap=off)，左侧 gutter 绝对定位按行高 20px 对齐：
 *     行号 + 请求首行的 ▶。滚动用 transform 同步，输入后 200ms 防抖重解析重绘。
 *   · 每个 ▶ → POLARIS_HTTP.parseHttpFile 重解析当前文本 → 变量/env 插值 →
 *     POLARIS_API.runRaw()（内部 invoke('http/request') + showResponse）→ 结果进原框。
 *   · 保存走 sidecar http/writeFile；输入 900ms 防抖自动保存，Ctrl+S / 「保存」立即写。
 *     「保存」可以反复点：每次成功都刷新计数（✓ 已保存 时间 ×N）；未绑定磁盘时自动转「另存为」，
 *     所以任何时候都不会出现「点了没反应」。
 *   · 打开方式（v0.4.0 起三路）：
 *       1) 顶栏「▤ 打开 .http」/ 面板「📂 打开」→ sidecar http/pickFile 弹**系统文件对话框**
 *          （Windows 资源管理器对话框），拿到绝对路径 → 打开后可原地保存；
 *       2) 宿主 fileTransfer.pick（拿不到路径时退回工作目录副本 / 另存为）；
 *       3) 从应用外拖入文件（HTML5 drop + 宿主 fileTransfer.onDrop）→ 直接打开；
 *          拖入拿不到绝对路径时，先按「同名+同大小」在工作目录认领原文件，认不到才复制到工作目录。
 *
 * 依赖：POLARIS_HTTP(http-file.js) POLARIS_CORE(core.js) DBXBridge POLARIS_API(app.js) PD(dialogs.js)
 */
(function () {
  'use strict';

  var H = window.POLARIS_HTTP;
  var CORE = window.POLARIS_CORE;
  var DBX = window.DBXBridge;
  var PD = window.PD;

  var LINE_H = 20;      /* 必须与 CSS 的 .pa-fe-text / .pa-fe-ln line-height 一致 */
  var PAD_TOP = 10;     /* 必须与 CSS 的 .pa-fe-text padding-top 一致 */
  var ST_KEY = 'warren-polaris-api.editor.v1';
  var TEXT_EXT = /\.(http|rest|txt|md|json|xml|yml|yaml|graphql|gql)$/i;

  var S = {
    ready: false,
    open: false,
    dir: '',
    path: '',
    name: '',
    autoSave: true,
    dirty: false,
    savedAt: 0,
    rev: 0,
    envs: {},
    activeEnv: '',
    parsed: { requests: [], warnings: [], variables: {} },
    responses: {},     /* 请求名 -> 最近响应，供 {{name.response.body.$.x}} 跨请求引用 */
    lastRun: {},       /* 请求行号 -> ''|busy|ok|warn|err */
    files: [],
    gutterSig: '',
    prevLayout: null,
    saveCount: 0,      /* 本次打开后成功保存的次数（UI 上显示 ×N，证明「点多次都能存」） */
    lastOpenAt: 0,     /* 防抖：HTML5 drop 与宿主 onDrop 同时到达 */
    picking: false,    /* 系统文件对话框互斥，避免叠两个框 */
    pickError: ''      /* 原生对话框不可用时的原因，降级时提示用 */
  };

  var pane = null, ta = null, ginner = null, E = {};
  var parseTimer = null, saveTimer = null;

  /* ===================== 小工具 ===================== */
  function $(sel) { return document.querySelector(sel); }
  function byId(id) { return document.getElementById(id); }
  function esc(s) { return CORE && CORE.esc ? CORE.esc(s) : String(s == null ? '' : s); }
  function toast(h) { try { CORE.toast(h); } catch (e) { } }
  function setStatus(m, k) { try { CORE.setStatus(m, k); } catch (e) { } }

  function dirOf(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : '';
  }
  function pathJoin(dir, rel) {
    rel = String(rel || '').trim();
    if (!rel) return dir;
    if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.charAt(0) === '/' || rel.charAt(0) === '\\') return rel;
    var sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/';
    return String(dir).replace(/[\\/]+$/, '') + sep + rel.replace(/^\.?[\\/]/, '');
  }
  function relPath(dir, p) {
    if (!dir) return p;
    var d = String(dir).replace(/[\\/]+$/, '');
    var s = String(p);
    return s.indexOf(d) === 0 ? s.slice(d.length).replace(/^[\\/]/, '') : s;
  }
  function hhmmss() {
    var t = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
  }
  function hostOk() { return !!(DBX && DBX.plugin); }
  async function invoke(method, params, options) {
    if (!hostOk()) throw new Error('未连接 DBX 宿主，文件读写不可用');
    return DBX.invoke(method, params || {}, options);
  }
  /* 宿主 fileTransfer（桌面端原生对话框 / 系统拖放）；Web 宿主没有这个对象 */
  function hostFT() {
    var p = (DBX && DBX.plugin) || window.dbxPlugin;
    return (p && p.fileTransfer) || null;
  }
  function ftDropSupported() {
    var c = ((DBX && DBX.plugin) || window.dbxPlugin || {}).capabilities;
    return !!(c && c.fileTransfer && c.fileTransfer.drop);
  }
  function fileNameOf(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  /* 另存为时补扩展名（用户只写 demo 时变成 demo.http） */
  function ensureHttpExt(p) {
    var s = String(p || '');
    if (!s) return s;
    return /\.[A-Za-z0-9]{1,8}$/.test(fileNameOf(s)) ? s : s + '.http';
  }
  /* 在工作目录扫描结果里按「同名 + 同大小」认领原文件（拖入时没有绝对路径的补救） */
  function matchScanned(name, size) {
    var list = S.files || [];
    var lower = String(name || '').toLowerCase();
    if (!lower) return '';
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (String(f.name || '').toLowerCase() !== lower) continue;
      if (size && f.size && Number(f.size) !== Number(size)) continue;
      return f.path;
    }
    return '';
  }
  /* 把内容写成工作目录下的副本；重名时自动加 (2)(3)…，绝不覆盖已有文件 */
  async function writeCopy(dir, name, text) {
    var base = String(name || 'imported.http');
    var dot = base.lastIndexOf('.');
    var stem = dot > 0 ? base.slice(0, dot) : base;
    var ext = dot > 0 ? base.slice(dot) : '.http';
    for (var i = 0; i < 30; i++) {
      var nm = i === 0 ? base : stem + ' (' + (i + 1) + ')' + ext;
      var p = pathJoin(dir, nm);
      var r = await invoke('http/writeFile', { path: p, content: text, noClobber: true });
      if (r && r.exists) continue;
      return (r && r.path) || p;
    }
    throw new Error('工作目录里同名文件过多');
  }
  /* 文本解码：宿主 fileTransfer 分块读回来是 base64 */
  function b64ToText(b64) {
    var bin = atob(b64 || '');
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    try { return new TextDecoder('utf-8').decode(u8); } catch (e) { return ''; }
  }
  /* 用宿主句柄把整个文件读完（分块，避免大文件一次性进内存） */
  async function readByHandle(handleId) {
    var ft = hostFT();
    if (!ft || !ft.read) throw new Error('宿主不支持分块读取');
    var chunks = [], offset = 0, guard = 0;
    for (;;) {
      var c = await ft.read(handleId, offset, 256 * 1024);
      if (!c) break;
      var text = b64ToText(c.dataBase64);
      chunks.push(text);
      offset += Number(c.length || 0) || 0;
      if (c.eof || ++guard > 4096) break;
    }
    return chunks.join('');
  }

  /* ===================== 样式 ===================== */
  function injectCss() {
    if (byId('paFeCss')) return;
    var css = [
      '.pa-fe{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg,#16181e);color:var(--ink,#d8dae2);font-size:12.5px;overflow:hidden}',
      '.pa-fe[hidden]{display:none}',
      '.pa-fe-bar{display:flex;align-items:center;gap:7px;padding:5px 9px;border-bottom:1px solid var(--line,rgba(255,255,255,.1));background:var(--surface,#1e2028);flex:none;min-height:33px;flex-wrap:wrap}',
      '.pa-fe-dot{width:7px;height:7px;border-radius:50%;background:var(--ok,#3fb950);flex:none;box-shadow:0 0 6px var(--ok,#3fb950)}',
      '.pa-fe-name{font-weight:600;font-size:12.5px;white-space:nowrap;max-width:250px;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-path{font-size:11px;color:var(--dimmer,#6e7282);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%;font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-bar .sp,.pa-fe-foot .sp{flex:1}',
      '.pa-fe-save{font-size:11px;color:var(--dimmer,#6e7282);white-space:nowrap;min-width:96px;text-align:right}',
      '.pa-fe-save.ok{color:var(--ok,#3fb950)}',
      '.pa-fe-save.err{color:var(--err,#f85149)}',
      '.pa-fe-save.busy{color:var(--warn,#d29922)}',
      '.pa-fe-btn{font:inherit;font-size:11.5px;padding:4px 9px;border-radius:5px;border:1px solid var(--line-2,rgba(255,255,255,.18));background:transparent;color:var(--ink,#d8dae2);cursor:pointer;white-space:nowrap;transition:.12s}',
      '.pa-fe-btn:hover{border-color:var(--brand,#ff7a59);color:var(--brand,#ff7a59)}',
      '.pa-fe-btn.on{background:var(--brand,#ff7a59);border-color:transparent;color:#fff}',
      '.pa-fe-btn.primary{border-color:var(--brand,#ff7a59);color:var(--brand,#ff7a59);font-weight:600}',
      '.pa-fe-btn.ghost{opacity:.7}',
      '.pa-fe-btn.flash{background:var(--ok,#3fb950);border-color:transparent;color:#08170c}',
      /* 拖入遮罩：全屏，pointer-events:none 以免自己吃掉 drop */
      '.pa-fe-drop{position:fixed;inset:0;z-index:9998;display:none;pointer-events:none;background:rgba(8,10,14,.62);backdrop-filter:blur(1px);align-items:center;justify-content:center}',
      '.pa-fe-drop.on{display:flex}',
      '.pa-fe-drop .box{border:2px dashed var(--brand,#ff7a59);border-radius:12px;padding:26px 40px;text-align:center;background:var(--surface,#1e2028);box-shadow:0 16px 48px rgba(0,0,0,.45)}',
      '.pa-fe-drop .ico{font-size:30px;color:var(--brand,#ff7a59);line-height:1}',
      '.pa-fe-drop .t1{margin-top:8px;font-size:15px;font-weight:700;color:var(--ink,#d8dae2)}',
      '.pa-fe-drop .t2{margin-top:5px;font-size:11.5px;color:var(--dim,#a8acba)}',
      '.pa-fe-env{font:inherit;font-size:11.5px;padding:3px 6px;border-radius:5px;border:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg-2,#1a1c24);color:var(--ink,#d8dae2);max-width:130px}',
      '.pa-fe-main{flex:1;min-height:0;display:flex;overflow:hidden}',
      '.pa-fe-side{width:216px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg-2,#1a1c24);min-height:0}',
      '.pa-fe-side.collapsed{display:none}',
      '.pa-fe-shead{display:flex;align-items:center;gap:2px;padding:6px 7px 4px;font-size:10.5px;color:var(--dim,#a8acba);letter-spacing:.04em;flex:none}',
      '.pa-fe-shead>span{flex:1}',
      '.pa-fe-mini{font:inherit;font-size:12px;line-height:1;padding:3px 5px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--dim,#a8acba);cursor:pointer}',
      '.pa-fe-mini:hover{color:var(--brand,#ff7a59);border-color:var(--line-2,rgba(255,255,255,.18))}',
      '.pa-fe-dir{margin:0 7px 6px;font:inherit;font-size:11px;padding:4px 6px;border-radius:4px;border:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg,#16181e);color:var(--ink,#d8dae2);flex:none;min-width:0;font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-flist{flex:1;overflow:auto;padding:0 4px 6px;min-height:0}',
      '.pa-fe-empty{padding:12px 9px;font-size:11.5px;color:var(--dimmer,#6e7282);line-height:1.7}',
      '.pa-fe-fitem{display:block;width:100%;text-align:left;font:inherit;font-size:11.5px;padding:5px 7px;border-radius:4px;border:none;background:transparent;color:var(--dim,#a8acba);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-fitem:hover{background:var(--surface-2,#252830);color:var(--ink,#d8dae2)}',
      '.pa-fe-fitem.on{background:var(--surface-3,#2c2f3a);color:var(--brand,#ff7a59)}',
      '.pa-fe-fitem small{display:block;font-size:10px;color:var(--dimmer,#6e7282);margin-top:1px;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-edit{flex:1;position:relative;min-width:0;min-height:0;overflow:hidden}',
      '.pa-fe-gutter{position:absolute;left:0;top:0;width:60px;height:100%;overflow:hidden;border-right:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg-2,#1a1c24);z-index:2;pointer-events:none}',
      '.pa-fe-ginner{position:absolute;left:0;top:0;width:100%;will-change:transform}',
      '.pa-fe-ln{position:absolute;right:5px;height:20px;line-height:20px;font-family:var(--mono,Consolas,monospace);font-size:10.5px;color:var(--dimmer,#6e7282);text-align:right;pointer-events:none;user-select:none}',
      '.pa-fe-ln.on{color:var(--brand,#ff7a59);font-weight:700}',
      '.pa-fe-run{position:absolute;left:2px;width:20px;height:20px;line-height:19px;text-align:center;font-size:9px;color:var(--ok,#3fb950);cursor:pointer;pointer-events:auto;border-radius:3px;user-select:none;transition:.12s}',
      '.pa-fe-run:hover{background:var(--ok,#3fb950);color:#08170c;transform:scale(1.12)}',
      '.pa-fe-run.busy{color:var(--warn,#d29922);animation:paFePulse .8s infinite}',
      '.pa-fe-run.ok{color:var(--ok,#3fb950)}',
      '.pa-fe-run.warn{color:var(--warn,#d29922)}',
      '.pa-fe-run.err{color:var(--err,#f85149)}',
      '@keyframes paFePulse{0%,100%{opacity:.3}50%{opacity:1}}',
      '.pa-fe-text{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;border:none;outline:none;resize:none;background:transparent;color:var(--ink,#d8dae2);font-family:var(--mono,Consolas,monospace);font-size:12.5px;line-height:20px;padding:10px 14px 10px 68px;white-space:pre;overflow:auto;tab-size:2;z-index:1;caret-color:var(--brand,#ff7a59)}',
      '.pa-fe-text::placeholder{color:var(--dimmer,#6e7282)}',
      '.pa-fe-idle{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:7px;color:var(--dimmer,#6e7282);font-size:12.5px;background:var(--bg,#16181e);z-index:3;text-align:center;padding:22px;line-height:1.85}',
      '.pa-fe-idle[hidden]{display:none}',
      '.pa-fe-foot{display:flex;align-items:center;gap:10px;padding:3px 9px;border-top:1px solid var(--line,rgba(255,255,255,.1));font-size:10.5px;color:var(--dimmer,#6e7282);flex:none;min-height:23px;background:var(--surface,#1e2028)}',
      '[data-dbx-theme="light"] .pa-fe{background:#fff;color:#1a1d2e}',
      '[data-dbx-theme="light"] .pa-fe-bar,[data-dbx-theme="light"] .pa-fe-foot{background:#f7f8fa}',
      '[data-dbx-theme="light"] .pa-fe-side,[data-dbx-theme="light"] .pa-fe-gutter{background:#f2f4f8}',
      '[data-dbx-theme="light"] .pa-fe-dir{background:#fff;color:#1a1d2e}',
      '[data-dbx-theme="light"] .pa-fe-idle{background:#fff}',
      '[data-dbx-theme="light"] .pa-fe-fitem:hover{background:#e6e9f0}',
      '[data-dbx-theme="light"] .pa-fe-fitem.on{background:#dde2ec}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'paFeCss';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ===================== DOM ===================== */
  function buildPane() {
    var host = document.querySelector('.req-region');
    if (!host) return null;
    var d = document.createElement('div');
    d.className = 'pa-fe';
    d.id = 'fileEditorPane';
    d.hidden = true;
    d.innerHTML = [
      '<div class="pa-fe-bar">',
      '  <span class="pa-fe-dot"></span>',
      '  <span class="pa-fe-name" id="paFeName">未打开文件</span>',
      '  <span class="pa-fe-path" id="paFePath"></span>',
      '  <span class="sp"></span>',
      '  <select class="pa-fe-env" id="paFeEnv" title="http-client.env.json 环境"></select>',
      '  <span class="pa-fe-save" id="paFeSaveState">—</span>',
      '  <button class="pa-fe-btn primary" id="paFeOpen" title="弹出系统文件对话框（资源管理器）选择 .http 文件">📂 打开</button>',
      '  <button class="pa-fe-btn" id="paFeSave" title="立即写入磁盘（Ctrl+S）；可反复点击，每次都真正落盘">保存</button>',
      '  <button class="pa-fe-btn" id="paFeSaveAs" title="另存为新的 .http 文件（系统保存对话框）">另存为</button>',
      '  <button class="pa-fe-btn" id="paFeRunAll" title="按顺序运行本文件全部请求">▶▶ 全部运行</button>',
      '  <button class="pa-fe-btn on" id="paFeAuto" title="切换自动保存">自动保存：开</button>',
      '  <button class="pa-fe-btn ghost" id="paFeClose" title="返回请求编辑器">✕ 返回</button>',
      '</div>',
      '<div class="pa-fe-main">',
      '  <div class="pa-fe-side" id="paFeSide">',
      '    <div class="pa-fe-shead"><span>工作目录</span>',
      '      <button class="pa-fe-mini" id="paFeScan" title="重新扫描 .http 文件">⟳</button>',
      '      <button class="pa-fe-mini" id="paFeNew" title="在此目录新建 .http">＋</button>',
      '      <button class="pa-fe-mini" id="paFeImport" title="从本机导入 .http（会写入工作目录）">⇣</button>',
      '      <button class="pa-fe-mini" id="paFeHide" title="收起文件栏">‹</button>',
      '    </div>',
      '    <input class="pa-fe-dir" id="paFeDir" spellcheck="false" placeholder="C:\\path\\to\\apis" />',
      '    <div class="pa-fe-flist" id="paFeList"><div class="pa-fe-empty">填写工作目录后点 ⟳ 扫描</div></div>',
      '  </div>',
      '  <div class="pa-fe-edit">',
      '    <div class="pa-fe-gutter"><div class="pa-fe-ginner" id="paFeGinner"></div></div>',
      '    <textarea class="pa-fe-text" id="paFeText" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder=""></textarea>',
      '    <div class="pa-fe-idle" id="paFeIdle"><div style="font-size:13px;font-weight:600;color:var(--dim,#a8acba)">打开本地 .http 文件</div><div>点上方 <b>📂 打开</b>（或顶栏「▤ 打开 .http」）弹出系统文件对话框选择文件；<br>也可以直接把文件<b>从资源管理器拖进来</b>。</div><div style="font-size:11.5px">打开后可直接编辑，<b>自动保存</b>写回原文件、「保存」可反复点；每个请求左侧 ▶ 一点即发，结果显示在下方响应框。</div></div>',
      '  </div>',
      '</div>',
      '<div class="pa-fe-foot"><span id="paFeFoot">—</span><span class="sp"></span><span>▶ 运行该请求 · Ctrl+S 保存 · Tab 缩进</span></div>'
    ].join('\n');
    host.appendChild(d);
    return d;
  }

  /* ===================== 模式切换 ===================== */
  /* 文件模式需要比默认 240px 更大的编辑区：按视口算一个偏大的请求区高度。
   * app.js 的 applyLayout() 会在切换上下/左右布局时重设 --reqH/--reqW，
   * 所以这里单独抽出，布局切换与 resize 后都重新施加一次。 */
  function applyEditorSizes() {
    var split = $('#split');
    if (!split) return;
    var h = Math.round(Math.min((window.innerHeight || 800) * 0.58, 600));
    var w = Math.round((window.innerWidth || 1200) * 0.6);
    split.style.setProperty('--reqH', h + 'px');
    split.style.setProperty('--reqW', w + 'px');
  }

  function enterMode() {
    if (S.open) return;
    var split = $('#split');
    S.prevLayout = {
      reqH: split ? split.style.getPropertyValue('--reqH') : '',
      reqW: split ? split.style.getPropertyValue('--reqW') : ''
    };
    applyEditorSizes();
    var reqSub = byId('reqSubtabs'); if (reqSub) reqSub.style.display = 'none';
    var reqPane = byId('reqPane'); if (reqPane) reqPane.style.display = 'none';
    var reqbar = document.querySelector('.reqbar'); if (reqbar) reqbar.style.display = 'none';
    pane.hidden = false;
    S.open = true;
    setTimeout(syncGutter, 30);
  }

  function exitMode() {
    if (!S.open) return;
    var split = $('#split');
    if (split && S.prevLayout) {
      split.style.setProperty('--reqH', S.prevLayout.reqH || '');
      split.style.setProperty('--reqW', S.prevLayout.reqW || '');
    }
    var reqSub = byId('reqSubtabs'); if (reqSub) reqSub.style.display = '';
    var reqPane = byId('reqPane'); if (reqPane) reqPane.style.display = '';
    var reqbar = document.querySelector('.reqbar'); if (reqbar) reqbar.style.display = '';
    pane.hidden = true;
    S.open = false;
  }

  /* ===================== gutter 渲染 ===================== */
  function syncGutter() {
    if (ginner && ta) ginner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }

  function renderGutter() {
    if (!ginner || !ta) return;
    var lines = ta.value.split('\n');
    var reqs = (S.parsed && S.parsed.requests) || [];
    var byLine = {};
    for (var k = 0; k < reqs.length; k++) byLine[reqs[k].line] = k;

    var sigParts = [lines.length];
    for (var z = 0; z < reqs.length; z++) sigParts.push(reqs[z].line + ':' + (S.lastRun[reqs[z].line] || ''));
    var sig = sigParts.join('|');
    if (sig === S.gutterSig) { syncGutter(); return; }
    S.gutterSig = sig;

    var out = [];
    var showNo = lines.length <= 4000;
    for (var i = 0; i < lines.length; i++) {
      var ln = i + 1;
      var top = PAD_TOP + i * LINE_H;
      var ri = byLine[ln];
      if (ri !== undefined) {
        var st = S.lastRun[ln] || '';
        out.push('<div class="pa-fe-run ' + st + '" style="top:' + top + 'px" data-ri="' + ri + '" title="运行：' +
          esc(reqs[ri].name) + '">▶</div>');
      }
      if (showNo) {
        out.push('<div class="pa-fe-ln' + (ri !== undefined ? ' on' : '') + '" style="top:' + top + 'px">' + ln + '</div>');
      }
    }
    ginner.innerHTML = out.join('');
    syncGutter();
  }

  /* ===================== 解析 / 状态 ===================== */
  function reparse() {
    if (!H || !ta) return S.parsed;
    var parsed;
    try {
      parsed = H.parseHttpFile(ta.value, { fileName: S.name || S.path || '' });
    } catch (e) {
      parsed = { requests: [], warnings: ['解析失败：' + (e.message || e)], variables: {} };
    }
    /* 行结构变了（增删请求/换行）就清空上次运行标记，避免标记错位到别的请求上 */
    var reqSig = (parsed.requests || []).map(function (r) { return r.line; }).join(',');
    if (reqSig !== S.reqSig) {
      S.reqSig = reqSig;
      S.lastRun = {};
      S.gutterSig = '';
    }
    S.parsed = parsed;
    renderGutter();
    updateFoot();
    return parsed;
  }

  function updateFoot() {
    if (!E.foot) return;
    var p = S.parsed || { requests: [], warnings: [] };
    var parts = ['请求 ' + ((p.requests || []).length) + ' 个'];
    var names = Object.keys(S.envs || {});
    if (names.length) parts.push('环境 ' + (S.activeEnv || '未选'));
    if ((p.warnings || []).length) parts.push('⚠ ' + p.warnings.length + ' 条提示');
    parts.push(S.path ? '磁盘已绑定' : '未绑定磁盘');
    E.foot.textContent = parts.join(' · ');
  }

  function setSaveState(kind, info) {
    if (!E.saveState) return;
    if (kind === 'dirty') { E.saveState.className = 'pa-fe-save'; E.saveState.textContent = '● 未保存'; }
    else if (kind === 'busy') { E.saveState.className = 'pa-fe-save busy'; E.saveState.textContent = '⟳ 保存中…'; }
    else if (kind === 'ok') {
      E.saveState.className = 'pa-fe-save ok';
      /* 带次数：反复点「保存」时面板上能直接看到第几次落盘，不会让人以为「点了没反应」 */
      E.saveState.textContent = '✓ 已保存 ' + hhmmss() + (S.saveCount > 1 ? ' ×' + S.saveCount : '');
    }
    else if (kind === 'err') {
      E.saveState.className = 'pa-fe-save err';
      E.saveState.textContent = '✕ 保存失败' + (info && info.message ? '：' + String(info.message).slice(0, 36) : '');
    } else { E.saveState.className = 'pa-fe-save'; E.saveState.textContent = '—'; }
    if (E.saveState) E.saveState.title = S.path ? ('磁盘：' + S.path) : '尚未绑定磁盘路径（保存时会弹出另存为）';
  }

  /* ===================== 原生文件对话框 ===================== */

  /* 弹出系统文件对话框（Windows 是资源管理器那个框），返回：
   *   { path, dir, name }  拿到绝对路径（最优，打开后可原地保存）
   *   { content, name, size }  宿主只给内容/句柄（退回工作目录副本或另存为）
   *   { cancelled: true }  用户取消
   *   null  三种通道都不可用
   */
  async function pickNative(mode) {
    if (S.picking) return { cancelled: true };   /* 同时只允许一个系统对话框 */
    S.picking = true;
    try {
      return await pickNativeInner(mode);
    } finally {
      S.picking = false;
    }
  }

  async function pickNativeInner(mode) {
    var name = S.name || 'new.http';
    var title = mode === 'save' ? '保存 .http 文件' : '选择 .http 文件';

    /* 1) sidecar 原生对话框：唯一能拿到绝对路径的通道 */
    if (hostOk()) {
      var t0 = Date.now();
      try {
        var r = await invoke('http/pickFile', { mode: mode, title: title, name: name, ext: 'http,rest' }, { timeoutMs: 600000 });
        if (r && r.path) return { path: r.path, dir: r.dir || dirOf(r.path), name: r.name || fileNameOf(r.path) };
        if (r && r.cancelled) return { cancelled: true };
      } catch (e) {
        S.pickError = (e && e.message) || String(e);
        /* 调用挂了很久才报错 = 对话框很可能已经弹出来（用户正在里面选），
         * 此时不要再降级弹第二个对话框，否则会出现「两个选择框」。 */
        if (Date.now() - t0 > 2000) {
          toast('系统对话框没有返回结果：' + esc(S.pickError));
          return { cancelled: true };
        }
      }
    }

    /* 2) 宿主 fileTransfer.pick：同样是原生对话框，但只回句柄（没有绝对路径） */
    var ft = hostFT();
    if (ft && ft.pick) {
      try {
        var res = await ft.pick({ multiple: false });
        var f = res && res.files && res.files[0];
        if (!f) return { cancelled: true };
        var p = f.path || f.filePath || '';
        if (p) return { path: p, dir: dirOf(p), name: fileNameOf(p) };
        var text = await readByHandle(f.handleId);
        return { content: text, name: f.name, size: f.size };
      } catch (e2) {
        S.pickError = (e2 && e2.message) || String(e2);
      }
    }

    /* 3) <input type=file> 兜底（纯浏览器 / 宿主没有原生通道时） */
    return await pickByInput();
  }

  /* 隐藏 <input type=file>：最兜底的选择器。取消时 onchange 不触发，
   * 所以用 window focus 兜一次，避免 Promise 永远挂着。 */
  function pickByInput() {
    return new Promise(function (resolve) {
      var inp = byId('paFeImportInput');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id = 'paFeImportInput';
        inp.accept = '.http,.rest,text/plain';
        inp.style.display = 'none';
        document.body.appendChild(inp);
      }
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        window.removeEventListener('focus', onFocus);
        resolve(v);
      }
      function onFocus() {
        setTimeout(function () { if (!done && (!inp.files || !inp.files.length)) finish({ cancelled: true }); }, 400);
      }
      inp.value = '';
      inp.onchange = async function () {
        var f = inp.files && inp.files[0];
        if (!f) { finish({ cancelled: true }); return; }
        var text = '';
        try { text = await f.text(); } catch (e) { }
        var p = f.path || '';
        finish(p ? { path: p, dir: dirOf(p), name: fileNameOf(p) } : { content: text, name: f.name, size: f.size });
        inp.value = '';
      };
      window.addEventListener('focus', onFocus);
      inp.click();
    });
  }

  /* ===================== 保存 ===================== */

  /* 另存为：弹系统保存对话框，写盘后把当前编辑内容绑定到新路径 */
  async function saveAs() {
    var pick = await pickNative('save');
    if (!pick || pick.cancelled) return false;
    if (pick.content != null) {
      /* 宿主只能给内容，没有路径：写进工作目录 */
      var dir0 = S.dir || (E.dir && E.dir.value || '').trim();
      if (!dir0) { toast('没有可用工作目录，无法另存'); return false; }
      try {
        var np = await writeCopy(dir0, ensureHttpExt(pick.name || S.name || 'new.http'), ta.value);
        await bindPath(np, dir0);
        return afterSave(true);
      } catch (e) { setSaveState('err', e); toast('另存为失败：' + esc(e.message || e)); return false; }
    }
    var path = ensureHttpExt(pick.path);
    try {
      var r = await invoke('http/writeFile', { path: path, content: ta.value });
      await bindPath((r && r.path) || path, pick.dir || dirOf(path));
      toast('已另存为 <b>' + esc(fileNameOf(path)) + '</b> ✓');
      return afterSave(true) && true;
    } catch (e) {
      setSaveState('err', e);
      toast('另存为失败：' + esc(e.message || e));
      return false;
    }
  }

  /* 绑定一个新的磁盘路径，刷新标题/目录，并重新扫描该目录 */
  async function bindPath(p, dir) {
    S.path = p;
    S.dir = dir || dirOf(p);
    S.name = fileNameOf(p);
    if (E.name) E.name.textContent = S.name;
    if (E.path) { E.path.textContent = S.path; E.path.title = S.path; }
    if (E.dir) E.dir.value = S.dir;
    if (E.idle) E.idle.hidden = true;
    S.dirty = false;
    S.savedAt = Date.now();
    savePrefs();
    try { await loadEnvs(S.dir); } catch (e) { }
    if (S.dir) scan();
  }

  function afterSave(manual) {
    S.dirty = false;
    S.savedAt = Date.now();
    S.saveCount++;
    setSaveState('ok');
    updateFoot();
    flashSaveBtn();
    if (manual) setStatus('已保存第 ' + S.saveCount + ' 次：' + S.path, 'ok');
    return true;
  }

  function flashSaveBtn() {
    if (!E.save) return;
    E.save.classList.add('flash');
    clearTimeout(E.save._ft);
    E.save._ft = setTimeout(function () { E.save.classList.remove('flash'); }, 320);
  }

  /* 保存：可反复点。未绑定磁盘 → 自动转「另存为」，绝不静默失败 */
  async function doSave(manual) {
    clearTimeout(saveTimer);
    if (!S.path) {
      if (manual) return await saveAs();
      return false;
    }
    var content = ta.value;
    var rev = ++S.rev;
    setSaveState('busy');
    try {
      var r = await invoke('http/writeFile', { path: S.path, content: content });
      if (rev !== S.rev) return false;   /* 保存期间又改过：等下一轮 */
      afterSave(manual);
      if (manual) toast('已保存到 <b>' + esc(S.name || fileNameOf(S.path)) + '</b> ✓（第 ' + S.saveCount + ' 次）');
      savePrefs();
      if (r && r.size >= 0 && E.foot) updateFoot();
      return true;
    } catch (e) {
      setSaveState('err', e);
      if (manual) toast('保存失败：' + esc(e.message || e));
      return false;
    }
  }

  function scheduleSave() {
    if (!S.autoSave || !S.path) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { doSave(false); }, 900);
  }

  function onInput() {
    S.dirty = true;
    setSaveState('dirty');
    clearTimeout(parseTimer);
    parseTimer = setTimeout(reparse, 200);
    scheduleSave();
  }

  /* ===================== 打开 / 文件列表 ===================== */
  async function openPath(p) {
    if (!p) return;
    try {
      var r = await invoke('http/readFile', { path: p });
      S.path = r.path || p;
      S.dir = r.dir || dirOf(S.path);
      S.name = r.name || '';
      ta.value = r.content || '';
      ta.scrollTop = 0;
      S.dirty = false;
      S.savedAt = Date.now();
      S.responses = {};
      S.lastRun = {};
      S.gutterSig = '';
      if (E.name) E.name.textContent = S.name || '(未命名)';
      if (E.path) { E.path.textContent = S.path; E.path.title = S.path; }
      if (E.idle) E.idle.hidden = true;
      if (E.dir) E.dir.value = S.dir;
      S.saveCount = 0;
      await loadEnvs(S.dir);
      reparse();
      setSaveState('ok');
      savePrefs();
      renderFiles(true);
      /* 目录列表可能落后（刚拖入的副本、外部新建的文件）：当前文件不在列表里就重扫一次，
       * 这样「再次拖入同名文件」才能按同名+同大小认领回原文件，而不是又造一份副本。 */
      var known = (S.files || []).some(function (f) { return f.path === S.path; });
      if (!S.files.length || !known) scan();
      if (ta) ta.focus();
    } catch (e) {
      toast('打开失败：' + esc(e.message || e));
    }
  }

  /* 载入一份「只有内容、没有路径」的文本（拖入 / 宿主 fileTransfer / 导入）：
   *   1) 先用「同名 + 同大小」在工作目录里认领原文件 → 命中就原地编辑；
   *   2) 否则写一份工作目录副本（重名自动加序号，绝不覆盖）；
   *   3) 连工作目录都没有 → 纯内存编辑，保存时弹「另存为」。 */
  async function openContent(name, text, opts) {
    opts = opts || {};
    enterMode();
    if (opts.path) { await openPath(opts.path); return; }

    var hit = matchScanned(name, opts.size);
    if (hit) { await openPath(hit); toast('已对应到工作目录里的同名文件，原地编辑'); return; }

    var dir = S.dir || (E.dir && E.dir.value || '').trim();
    /* 列表可能还没扫过或是旧的：先刷一次再认领，能命中就别造副本 */
    if (dir && !hit) {
      await refreshFiles(dir);
      hit = matchScanned(name, opts.size);
      if (hit) { await openPath(hit); toast('已对应到工作目录里的同名文件，原地编辑'); return; }
    }
    if (dir) {
      try {
        var p = await writeCopy(dir, String(name || 'imported.http'), text);
        await openPath(p);
        toast('已复制到工作目录并打开：<b>' + esc(fileNameOf(p)) + '</b>');
        return;
      } catch (e) {
        toast('写入工作目录失败：' + esc(e.message || e));
      }
    }

    /* 纯内存打开：仍可编辑/运行，保存时走另存为 */
    S.path = '';
    S.dir = '';
    S.name = String(name || '未命名.http');
    S.saveCount = 0;
    S.dirty = false;
    S.responses = {};
    S.lastRun = {};
    S.gutterSig = '';
    ta.value = String(text || '');
    ta.scrollTop = 0;
    if (E.name) E.name.textContent = S.name;
    if (E.path) { E.path.textContent = '(未绑定磁盘 — 点「保存」选择保存位置)'; E.path.title = ''; }
    if (E.idle) E.idle.hidden = true;
    await loadEnvs('');
    reparse();
    setSaveState('dirty');
    toast('已载入 <b>' + esc(S.name) + '</b>（未绑定磁盘，保存时会让你选位置）');
    if (ta) ta.focus();
  }

  /* 拉一次目录列表（不做 UI 提示，给拖入时的「认领原文件」用） */
  async function refreshFiles(dir) {
    var d = String(dir || '').trim();
    if (!d) return false;
    try {
      var r = await invoke('http/listFiles', { dir: d, recursive: true });
      S.dir = r.dir || d;
      S.files = r.files || [];
      if (E.dir) E.dir.value = S.dir;
      renderFiles(true);
      savePrefs();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function scan() {
    var dir = (E.dir && E.dir.value || '').trim();
    if (!dir) { toast('请先填写工作目录'); if (E.dir) E.dir.focus(); return; }
    if (E.list) E.list.innerHTML = '<div class="pa-fe-empty">扫描中…</div>';
    try {
      var r = await invoke('http/listFiles', { dir: dir, recursive: true });
      S.dir = r.dir || dir;
      S.files = r.files || [];
      if (E.dir) E.dir.value = S.dir;
      renderFiles();
      savePrefs();
      if (!S.files.length && E.list) E.list.innerHTML = '<div class="pa-fe-empty">该目录下没有 .http / .rest 文件。<br>点 ＋ 新建，或点 📂 打开。</div>';
    } catch (e) {
      S.files = [];
      if (E.list) E.list.innerHTML = '<div class="pa-fe-empty">扫描失败：' + esc(e.message || e) + '</div>';
    }
  }

  function renderFiles(keepEmpty) {
    if (!E.list) return;
    if (!S.files.length) {
      if (!keepEmpty) E.list.innerHTML = '<div class="pa-fe-empty">该目录下没有 .http / .rest 文件。</div>';
      return;
    }
    var out = [];
    S.files.forEach(function (f) {
      var rel = relPath(S.dir, f.path);
      out.push('<button class="pa-fe-fitem' + (f.path === S.path ? ' on' : '') + '" data-path="' + esc(f.path) +
        '" title="' + esc(f.path) + '">' + esc(f.name) + '<small>' + esc(rel) + '</small></button>');
    });
    E.list.innerHTML = out.join('');
  }

  async function loadEnvs(dir) {
    try {
      var r = await invoke('http/readEnvFiles', { dir: dir || S.dir || '' });
      var merged = H.mergeEnvFiles(r.public, r.private) || {};
      S.envs = merged;
      var names = Object.keys(merged);
      if (names.indexOf(S.activeEnv) < 0) S.activeEnv = names[0] || '';
      renderEnvSel();
    } catch (e) {
      S.envs = {};
      renderEnvSel();
    }
  }

  function renderEnvSel() {
    if (!E.env) return;
    var names = Object.keys(S.envs || {});
    if (!names.length) {
      E.env.innerHTML = '<option value="">无环境</option>';
      E.env.disabled = true;
      return;
    }
    E.env.disabled = false;
    E.env.innerHTML = names.map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === S.activeEnv ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    E.env.value = S.activeEnv || names[0];
  }

  /* ===================== 运行 ===================== */
  function hasHeader(lower, name) { return !!lower[String(name).toLowerCase()]; }

  async function runReq(req) {
    if (!req) return;
    var ctx = {
      vars: (S.parsed && S.parsed.variables) || {},
      envs: S.envs || {},
      activeEnv: S.activeEnv || '',
      responses: S.responses || {}
    };
    var rv = function (s) { return H.resolveVars(s == null ? '' : s, ctx); };

    var env = (S.envs && S.activeEnv && S.envs[S.activeEnv]) || {};
    var url = String(rv(req.url) || '').trim();
    if (url.charAt(0) === '/') {
      var base = env.baseUrl || env.host || env.base_url || '';
      if (base) url = String(base).replace(/\/+$/, '') + url;
    }
    if (url && !/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(url)) {
      if (/\{\{/.test(url)) {
        toast('URL 含未解析变量：' + esc(url));
        S.lastRun[req.line] = 'err'; renderGutter();
        return;
      }
      if (url.charAt(0) === '/') {
        toast('相对 URL 需要 env 里配置 baseUrl（http-client.env.json）');
        S.lastRun[req.line] = 'err'; renderGutter();
        return;
      }
      url = 'https://' + url;
    }
    if (!url) {
      toast('请求 URL 为空');
      S.lastRun[req.line] = 'err'; renderGutter();
      return;
    }

    var headers = {}, lower = {};
    (req.headers || []).forEach(function (h) {
      var k = rv(h.k), v = rv(h.v);
      if (!String(k || '').trim()) return;
      headers[k] = v;
      lower[String(k).toLowerCase()] = true;
    });

    var noBody = ['GET', 'HEAD'].indexOf(String(req.method).toUpperCase()) >= 0;
    var body = '', bodyType = req.bodyType || 'text';
    if (!noBody) {
      if (req.bodyFromFile) {
        try {
          var fp = pathJoin(S.dir || dirOf(S.path), req.bodyFromFile);
          var f = await invoke('http/readFile', { path: fp });
          body = rv(f.content || '');
          bodyType = (/^\s*[\[{]/.test(body) || /json/i.test(f.name || '')) ? 'json' : 'text';
        } catch (e) {
          body = rv(req.body || '');
          toast('外部 body 读取失败，改用内联 body：' + esc(e.message || e));
        }
      } else {
        body = rv(req.body || '');
      }
      if (bodyType === 'json' && !hasHeader(lower, 'content-type')) headers['Content-Type'] = 'application/json';
      if (bodyType === 'form' && !hasHeader(lower, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    S.lastRun[req.line] = 'busy';
    renderGutter();
    var resp = null;
    try {
      resp = await window.POLARIS_API.runRaw({
        method: String(req.method || 'GET').toUpperCase(),
        url: url, headers: headers, body: body, bodyType: bodyType, timeoutMs: 120000
      });
      if (req.name) S.responses[req.name] = resp;
      S.lastRun[req.line] = (resp && resp.error) ? 'err' : (resp.status >= 400 ? 'warn' : 'ok');
    } catch (e) {
      S.lastRun[req.line] = 'err';
      toast('运行失败：' + esc(e.message || e));
    }
    S.gutterSig = '';
    renderGutter();
    return resp;
  }

  async function runOne(ri) {
    var parsed = reparse();
    var req = (parsed.requests || [])[ri];
    if (!req) { toast('请求结构已变化，请重试'); return; }
    await runReq(req);
  }

  async function runAll() {
    var parsed = reparse();
    var list = (parsed.requests || []).slice();
    if (!list.length) { toast('文件里没有可运行的请求'); return; }
    S.responses = {};
    for (var i = 0; i < list.length; i++) {
      await runReq(list[i]);
      if (!S.open) break;
    }
    toast('已运行 ' + list.length + ' 个请求');
  }

  /* ===================== 新建 / 打开 / 拖入 ===================== */
  function newFile() {
    var dir = (E.dir && E.dir.value || '').trim();
    if (!dir) { toast('请先填写工作目录'); if (E.dir) E.dir.focus(); return; }
    PD.ask('新建 .http 文件', { label: '文件名（自动补 .http）', value: 'new.http', okText: '创建' }, function (v) {
      if (v == null) return;
      var name = String(v).trim();
      if (!name) return;
      if (!/\.(http|rest)$/i.test(name)) name += '.http';
      var p = pathJoin(dir, name);
      var tpl = '### 新建请求\n# @name request1\nGET https://httpbin.org/get\nAccept: application/json\n\n';
      invoke('http/writeFile', { path: p, content: tpl })
        .then(function () { return scan(); })
        .then(function () { return openPath(p); })
        .catch(function (e) { toast('创建失败：' + esc(e.message || e)); });
    });
  }

  /* 主入口：弹系统文件对话框选一个文件并打开（顶栏按钮 / 面板「📂 打开」都走这里） */
  async function pickAndOpen() {
    enterMode();
    var pick;
    try {
      pick = await pickNative('open');
    } catch (e) {
      toast('打开失败：' + esc(e.message || e));
      return;
    }
    if (!pick) {
      toast('当前环境没有可用的文件选择器，请填写工作目录后点 ⟳ 扫描，或直接拖入文件');
      return;
    }
    if (pick.cancelled) return;
    if (pick.path) { await openPath(pick.path); return; }
    if (pick.content != null) await openContent(pick.name, pick.content, { size: pick.size });
  }

  /* 拖入的一组文件：只开第一个，其余提示 */
  async function dropFiles(list) {
    var arr = [];
    for (var i = 0; i < (list ? list.length : 0); i++) arr.push(list[i]);
    if (!arr.length) return;
    var f = arr[0];
    var name = f.name || f.fileName || '';
    /* 拖文件夹：WebView 里是一个 size 为 0、无类型、无扩展名的项 */
    if (!name) { toast('拖入的内容没有文件名，请拖具体文件'); return; }
    var text = '';
    try {
      if (typeof f.text === 'function') text = await f.text();
    } catch (e) { }
    if (!text && f.handleId) text = await readByHandle(f.handleId);
    if (!text && f.size) { toast('读取失败：<b>' + esc(name) + '</b> 可能不是文本文件'); return; }
    if (!text && !f.size) { toast('拖入的是文件夹或空文件，请拖具体文件'); return; }

    S.lastOpenAt = Date.now();
    await openContent(name, text, { size: f.size, path: f.path || f.filePath || '' });
    if (arr.length > 1) toast('一次只打开一个，已打开 <b>' + esc(name) + '</b>');
  }

  /* 全屏拖入遮罩 + HTML5 drop。
   * 只在 dataTransfer 里有 Files 时才 preventDefault，避免抢掉侧边栏自身的拖拽排序。 */
  function injectDropOverlay() {
    if (byId('paFeDrop')) return;
    var d = document.createElement('div');
    d.id = 'paFeDrop';
    d.className = 'pa-fe-drop';
    d.innerHTML = '<div class="box"><div class="ico">⬇</div>' +
      '<div class="t1">放开即打开</div>' +
      '<div class="t2">支持 .http / .rest / 任意文本文件</div></div>';
    document.body.appendChild(d);
  }
  function showDrop(on) {
    var d = byId('paFeDrop');
    if (d) d.classList.toggle('on', !!on);
  }
  function hasFilesDT(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    var types = dt.types || [];
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }
  function bindDrop() {
    injectDropOverlay();
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!hasFilesDT(e)) return;
      e.preventDefault();
      depth++;
      showDrop(true);
    }, true);
    window.addEventListener('dragover', function (e) {
      if (!hasFilesDT(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { }
      showDrop(true);
    }, true);
    window.addEventListener('dragleave', function (e) {
      if (!hasFilesDT(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) showDrop(false);
    }, true);
    window.addEventListener('drop', function (e) {
      if (!hasFilesDT(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      showDrop(false);
      var files = e.dataTransfer.files;
      if (files && files.length) {
        dropFiles(files);
        return;
      }
      /* 少数宿主把条目放在 items 里，files 为空 */
      var items = e.dataTransfer.items || [];
      var picked = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        var efile = items[i].getAsFile && items[i].getAsFile();
        if (efile) picked.push(efile);
      }
      if (picked.length) dropFiles(picked);
      else toast('没读到拖入的文件，请从资源管理器拖具体文件进来');
    }, true);

    /* 宿主级拖放（桌面端）：有些环境 drop 事件被宿主接管，只把句柄交给插件 */
    var ft = hostFT();
    if (ft && ft.onDrop) {
      try {
        ft.onDrop(function (files) {
          if (!files || !files.length) return;
          if (Date.now() - S.lastOpenAt < 800) return;   /* 与 HTML5 drop 去重 */
          var f = files[0];
          (async function () {
            var text = '';
            try { text = f.handleId ? await readByHandle(f.handleId) : ''; } catch (e) { }
            if (!text && !f.size) { toast('拖入的是文件夹或空文件'); return; }
            S.lastOpenAt = Date.now();
            await openContent(f.name, text, { size: f.size });
          })();
        });
      } catch (e) { }
    }
    if (ft && ft.onDragState) {
      try { ft.onDragState(function (active) { showDrop(!!active); }); } catch (e) { }
    }
  }

  /* ===================== 偏好 ===================== */
  function savePrefs() {
    try {
      DBX.storage.set(ST_KEY, {
        dir: S.dir, autoSave: S.autoSave, activeEnv: S.activeEnv, lastPath: S.path
      });
    } catch (e) { }
  }

  async function loadPrefs() {
    var p = null;
    try { p = await DBX.storage.get(ST_KEY); } catch (e) { }
    if (p && typeof p === 'object') {
      S.autoSave = p.autoSave !== false;
      S.dir = p.dir || '';
      S.activeEnv = p.activeEnv || '';
    }
    updateAutoBtn();
    if (!S.dir) {
      try {
        var d = await invoke('http/defaultDirs', {});
        /* workDir = 主目录下的 warren-polaris-api 子目录（拖入/导入副本的落点） */
        S.dir = d.workDir || d.homeDir || '';
      } catch (e) { }
    }
    if (E.dir && !E.dir.value) E.dir.value = S.dir || '';
    return p;
  }

  function updateAutoBtn() {
    if (!E.auto) return;
    E.auto.textContent = '自动保存：' + (S.autoSave ? '开' : '关');
    E.auto.classList.toggle('on', S.autoSave);
  }

  /* ===================== 打开入口 ===================== */
  async function open() {
    enterMode();
    if (!S.path && E.idle) E.idle.hidden = false;
    if (!S.files.length && S.dir) scan();
    setTimeout(function () {
      if (S.path && ta) ta.focus();
      else if (E.dir) E.dir.focus();
    }, 60);
  }

  /* ===================== 事件绑定 ===================== */
  function bind() {
    E.name = byId('paFeName');
    E.path = byId('paFePath');
    E.saveState = byId('paFeSaveState');
    E.foot = byId('paFeFoot');
    E.env = byId('paFeEnv');
    E.dir = byId('paFeDir');
    E.list = byId('paFeList');
    E.idle = byId('paFeIdle');
    E.auto = byId('paFeAuto');
    E.save = byId('paFeSave');
    E.saveAs = byId('paFeSaveAs');
    E.open = byId('paFeOpen');
    var side = byId('paFeSide');

    /* 工具条 */
    E.open.onclick = function () { pickAndOpen(); };
    E.save.onclick = function () { doSave(true); };
    E.saveAs.onclick = function () { saveAs(); };
    byId('paFeRunAll').onclick = function () { runAll(); };
    byId('paFeClose').onclick = function () { exitMode(); };
    E.auto.onclick = function () {
      S.autoSave = !S.autoSave;
      updateAutoBtn();
      savePrefs();
      toast('自动保存已' + (S.autoSave ? '开启' : '关闭'));
      if (!S.autoSave) clearTimeout(saveTimer);
    };
    E.env.onchange = function () {
      S.activeEnv = E.env.value || '';
      savePrefs();
      updateFoot();
    };

    /* 文件栏 */
    byId('paFeScan').onclick = function () { scan(); };
    byId('paFeNew').onclick = function () { newFile(); };
    byId('paFeImport').onclick = function () { pickAndOpen(); };
    byId('paFeHide').onclick = function () { if (side) side.classList.add('collapsed'); };

    E.dir.addEventListener('change', function () { S.dir = E.dir.value.trim(); savePrefs(); });
    E.dir.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); S.dir = E.dir.value.trim(); scan(); }
    });

    E.list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.pa-fe-fitem') : null;
      if (!b) return;
      var p = b.getAttribute('data-path');
      if (p) openPath(p);
    });

    /* gutter 运行按钮（事件委托） */
    ginner.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.pa-fe-run') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      var ri = Number(b.getAttribute('data-ri'));
      if (isFinite(ri)) runOne(ri);
    });

    /* 编辑器 */
    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', syncGutter, { passive: true });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();     /* 别让 app.js 的全局 Ctrl+S 再存一次请求 tab */
        doSave(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        onInput();
      }
    });
    window.addEventListener('resize', function () {
      if (S.open) applyEditorSizes();
      syncGutter();
    });

    /* 布局切换（上下/左右）后 app.js 会重设 --reqH/--reqW，追加监听把它改回来 */
    var lb = byId('layoutBtn');
    if (lb) {
      lb.addEventListener('click', function () {
        if (!S.open) return;
        setTimeout(function () { applyEditorSizes(); syncGutter(); }, 60);
      });
    }

    /* 顶栏「▤ 打开 .http」→ 打开编辑器并直接弹系统文件对话框 */
    bindTopBtn();
    /* 从应用外部拖入文件（HTML5 + 宿主 fileTransfer.onDrop） */
    bindDrop();
  }

  /* http-workspace.js 的 boot 是 async，绑定时机可能被 await 错开；
   * 单独抽出来并在 boot 末尾再覆盖一次，确保最终由编辑器接管。
   * v0.4.0：点一下就是「拉起文件资源管理器选文件」，不再是单纯的开关。 */
  function bindTopBtn() {
    var btn = byId('httpFileBtn');
    if (!btn) return;
    btn.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      e && e.stopPropagation && e.stopPropagation();
      pickAndOpen();
    };
    btn.title = '从资源管理器选择 .http 文件并编辑（自动保存 · 每个请求 ▶ 一点即发）';
  }

  /* ===================== 启动 ===================== */
  async function boot() {
    if (!H || !CORE) return;
    if (!window.POLARIS_API) return;
    injectCss();
    pane = buildPane();
    if (!pane) return;
    ta = byId('paFeText');
    ginner = byId('paFeGinner');
    bind();
    S.ready = true;

    await DBX.ready;
    var prefs = await loadPrefs();
    renderEnvSel();
    updateFoot();

    /* 恢复上次打开的文件（存在才恢复） */
    if (prefs && prefs.lastPath) {
      try { await openPath(prefs.lastPath); } catch (e) { }
    }

    /* 暴露给调试 / 其他模块 / 自动化验证 */
    window.POLARIS_EDITOR = {
      open: open,
      close: exitMode,
      state: S,
      openPath: openPath,
      openContent: openContent,
      pickAndOpen: pickAndOpen,
      pickNative: pickNative,
      save: function () { return doSave(true); },
      saveAs: saveAs,
      scan: scan,
      matchScanned: matchScanned,
      isOpen: function () { return S.open; }
    };

    /* 二次接管：确保晚于 http-workspace.js 的异步 boot 完成绑定 */
    setTimeout(bindTopBtn, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
