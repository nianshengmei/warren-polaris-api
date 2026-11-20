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
  var GUT_W = 74;       /* gutter 宽（折叠箭头 + ▶ + 行号）；文字左内边距 = GUT_W + 8 */
  var ST_KEY = 'warren-polaris-api.editor.v1';
  var TEXT_EXT = /\.(http|rest|txt|md|json|xml|yml|yaml|graphql|gql)$/i;
  var MAX_HL_LINES = 8000;
  var METHODS_RE = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT';
  var REQ_LINE_RE = new RegExp('^(\\s*)(' + METHODS_RE + ')([ \\t]+)([^\\n]*)$', 'i');

  var S = {
    ready: false,
    open: false,
    collapsed: false,  /* v0.6.0：浮层是否已收进右缘箭头（状态保留，不是关闭） */
    edgeTop: 20,       /* 右缘箭头垂直位置（%.work 高度）；可拖动，记在这里 */
    feX: 0,            /* S3.1：浮层相对基础盒的位移（px），拖动标题条改这里，双击标题条归零 */
    feY: 0,
    dir: '',
    path: '',
    name: '',
    /* v0.5.0：S.text 是唯一权威文本；折叠只是「视图投影」，ta.value 是投影结果。
     * 任何读写磁盘/解析都走 docText()，绝不直接用 ta.value —— 否则折叠时会把隐藏行丢掉。 */
    text: '',
    fullLines: [''],
    lineOff: [0],
    hl: { html: [''], folds: [], byOpen: {}, plain: false },
    hlKey: null,
    folded: {},        /* 折叠中的 fold.open（0 基行号） */
    view: [0],         /* 视图行 -> 全文行（0 基） */
    hide: {},          /* 被折叠隐藏的全文行 -> 折叠起点行 */
    tags: {},          /* 折叠起点行 -> 折叠了多少行 */
    hitLine: -1,
    q: '',             /* 接口一览过滤词 */
    activeReq: -1,
    autoSave: true,
    dirty: false,
    savedAt: 0,
    rev: 0,
    envs: {},
    activeEnv: '',
    parsed: { requests: [], warnings: [], variables: {} },
    responses: {},     /* 请求名 -> 最近响应，供 {{name.response.body.$.x}} 跨请求引用 */
    lastRun: {},       /* 请求行号 -> ''|busy|ok|warn|err */
    gutterSig: '',
    saveCount: 0,      /* 本次打开后成功保存的次数（UI 上显示 ×N，证明「点多次都能存」） */
    lastOpenAt: 0,     /* 防抖：HTML5 drop 与宿主 onDrop 同时到达 */
    picking: false,    /* 系统文件对话框互斥，避免叠两个框 */
    pickError: '',     /* 原生对话框不可用时的原因，降级时提示用 */
    /* v0.9.0 S2.2：磁盘版本基线。loadedText = 我们读进来（或刚写出去）的那一版文字，
     * 外部改动时用它判断「磁盘变了但内容其实一样」这种假冲突（touch / git checkout）。 */
    mtime: null,
    loadedText: '',
    conflict: null     /* { diskText, mtime } —— 有值时不自动保存，等用户选覆盖还是载入 */
  };

  var pane = null, edge = null, ta = null, ginner = null, hlEl = null, E = {};
  var parseTimer = null, saveTimer = null, hitTimer = null, trackTimer = null;
  var refreshDocsTimer = null;   /* 保存后让侧栏重扫资源目录（合帧） */

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

  /* ===================== 字节工具（multipart / 二进制上传用） ===================== */
  var MIME = {
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    amr: 'audio/amr', flac: 'audio/flac', webm: 'audio/webm',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  function mimeOf(name) {
    var m = /\.([A-Za-z0-9]+)\s*$/.exec(String(name || ''));
    return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
  }
  function b64ToBytes(b64) {
    var bin = atob(String(b64 || ''));
    var n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function bytesToB64(u8) {
    var CH = 0x8000, out = [];
    for (var i = 0; i < u8.length; i += CH) {
      out.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
    }
    return btoa(out.join(''));
  }
  function utf8(s) { return new TextEncoder().encode(String(s == null ? '' : s)); }

  /* 按 RFC 7578 组装 multipart/form-data 实体（字节级拼装，附件原样不动）。
   * 返回 { base64, contentType, parts } —— base64 交给 sidecar 当原始 body 发出去。 */
  async function buildMultipart(req, rv) {
    var mp = req.multipart || { boundary: 'WebAppBoundary', parts: [] };
    var B = String(mp.boundary || 'WebAppBoundary').trim() || 'WebAppBoundary';
    var base = S.dir || dirOf(S.path) || '';
    var chunks = [], total = 0;
    function push(u8) { if (u8 && u8.length) { chunks.push(u8); total += u8.length; } }
    function pushText(s) { if (s) push(utf8(s)); }

    var parts = mp.parts || [];
    if (!parts.length) throw new Error('multipart 里没有分段');

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i] || {};
      var hs = (p.headers || []).slice();
      var hasCd = false, hasCt = false;
      for (var k = 0; k < hs.length; k++) {
        if (/^content-disposition$/i.test(hs[k].k)) hasCd = true;
        if (/^content-type$/i.test(hs[k].k)) hasCt = true;
      }
      var cd = 'form-data; name="' + String(p.name || ('field' + (i + 1))) + '"';
      if (p.filename) cd += '; filename="' + String(p.filename).replace(/"/g, "'") + '"';

      var lines = ['--' + B];
      if (!hasCd) lines.push('Content-Disposition: ' + cd);
      for (var h = 0; h < hs.length; h++) lines.push(hs[h].k + ': ' + rv(hs[h].v));
      if (!hasCt) {
        var guess = p.contentType || (p.filePath || p.filename ? mimeOf(p.filename || p.filePath) : '');
        if (guess) lines.push('Content-Type: ' + guess);
      }
      pushText(lines.join('\r\n') + '\r\n\r\n');

      if (p.filePath) {
        /* 附件路径允许用变量（示例里 @audioPath 就是这么传的）；绝对路径 pathJoin 会原样返回 */
        var fp = pathJoin(base, rv(p.filePath));
        var f = await invoke('http/readFile', { path: fp, binary: true });
        if (!f || !f.base64) throw new Error('读取附件失败：' + fp);
        push(b64ToBytes(f.base64));
      } else if (p.content) {
        pushText(rv(p.content));
      }
      pushText('\r\n');
    }
    pushText('--' + B + '--\r\n');

    var all = new Uint8Array(total), off = 0;
    for (var c = 0; c < chunks.length; c++) { all.set(chunks[c], off); off += chunks[c].length; }
    return { base64: bytesToB64(all), contentType: 'multipart/form-data; boundary=' + B, parts: parts.length };
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
  /* 拖入时拿不到绝对路径的补救：在侧栏映射里按文件名认领已登记的文件。
   * 不扫目录 —— 侧栏只认 wpa-workspace.json，扫描既扫不到外部文件，也会让口径回退。 */
  function matchRegistered(name) {
    var lower = String(name || '').toLowerCase();
    if (!lower) return '';
    var M = window.POLARIS_MAP, D = window.POLARIS_DOCS;
    if (!M || !D || !D.map) return '';
    var map = D.map();
    var dir = D.dir();
    if (!map || !dir) return '';
    var list = M.entries(map);
    for (var i = 0; i < list.length; i++) {
      var abs = M.toAbs(dir, list[i]);
      if (fileNameOf(abs).toLowerCase() === lower) return abs;
    }
    return '';
  }

  /* 工作目录：当前文件所在目录 → 映射文件所在目录（浮层没有「文件目录」输入框了）。 */
  function workspaceDir() {
    if (S.dir) return S.dir;
    var D = window.POLARIS_DOCS;
    if (D && D.dir) { var d = D.dir(); if (d) return d; }
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
      /* ===== .http 浮层（v0.6.0）=====
       * 只盖「顶栏 tab 之下、响应框之上」的请求编辑区：上方 tab 点得到，下方响应框还看得见，
       * 收起时整体向右滑出屏幕，留下右缘一颗灰色半透明箭头。 */
      '.pa-root .work{position:relative}',
      /* S3.1：位置 = 基础盒（贴 .work 左/上/右/下） + --fe-dx/--fe-dy 位移。
       * 用位移而不是改 left/top：宽度高度还是由布局算出来，拖动不会把浮层拉变形。 */
      '.pa-fe{--fe-dx:0px;--fe-dy:0px;position:absolute;left:0;right:0;top:79px;bottom:0;z-index:16;display:flex;flex-direction:column;background:var(--bg,#16181e);color:var(--ink,#d8dae2);font-size:12.5px;overflow:hidden;border-radius:10px 0 0 10px;box-shadow:-18px 0 46px -20px rgba(0,0,0,.62),inset 1px 0 0 var(--line,rgba(255,255,255,.1));transform:translate(var(--fe-dx),var(--fe-dy));opacity:1;visibility:visible;transition:transform .36s cubic-bezier(.22,.61,.36,1),opacity .26s ease,visibility 0s}',
      '.pa-fe.off{transform:translate(calc(var(--fe-dx) + var(--fe-slide,100%)),var(--fe-dy));opacity:0;pointer-events:none;visibility:hidden;transition:transform .36s cubic-bezier(.22,.61,.36,1),opacity .26s ease,visibility 0s .36s}',
      /* 拖动中不要过渡，否则浮层会追着光标慢慢飘 */
      '.pa-fe.dragging{transition:none;box-shadow:0 26px 64px -18px rgba(0,0,0,.74),inset 1px 0 0 var(--line,rgba(255,255,255,.1))}',
      '.pa-fe.dragging,.pa-fe.dragging *{user-select:none}',
      '.pa-fe.dragging .pa-fe-bar{cursor:grabbing}',
      /* 收起后的入口：贴右边缘的灰色半透明箭头（可上下拖动，单击展开，右键彻底关闭） */
      '.pa-root .pa-edge{position:absolute;right:0;top:20%;width:24px;height:96px;z-index:18;margin:0;padding:0;border:0;border-radius:14px 0 0 14px;background:rgba(150,156,172,.32);color:#fff;-webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2);box-shadow:inset 1px 0 0 rgba(255,255,255,.16),-4px 0 18px -6px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;pointer-events:none;transform:translateY(-50%) translateX(110%);transition:opacity .22s ease,background-color .18s,transform .32s cubic-bezier(.22,.61,.36,1);-webkit-tap-highlight-color:transparent;touch-action:none;user-select:none}',
      '.pa-root .pa-edge.on{opacity:1;pointer-events:auto;transform:translateY(-50%) translateX(0);transition-delay:.08s}',
      '.pa-root .pa-edge::before{content:"";position:absolute;inset:0 0 0 -20px}',
      '.pa-root .pa-edge:hover{background:rgba(150,156,172,.46)}',
      '.pa-root .pa-edge.dragging{cursor:grabbing;background:rgba(150,156,172,.55)}',
      '.pa-root .pa-edge svg{display:block;pointer-events:none}',
      '[data-dbx-theme="light"] .pa-root .pa-edge{background:rgba(0,0,0,.42);box-shadow:inset 1px 0 0 rgba(255,255,255,.18),-4px 0 18px -6px rgba(0,0,0,.22)}',
      '[data-dbx-theme="light"] .pa-root .pa-edge:hover{background:rgba(0,0,0,.55)}',
      '.pa-fe-bar{display:flex;align-items:center;gap:7px;padding:5px 9px;border-bottom:1px solid var(--line,rgba(255,255,255,.1));background:var(--surface,#1e2028);flex:none;min-height:33px;flex-wrap:wrap;cursor:grab;touch-action:none;user-select:none}',
      '.pa-fe-dot{width:7px;height:7px;border-radius:50%;background:var(--ok,#3fb950);flex:none;box-shadow:0 0 6px var(--ok,#3fb950)}',
      '.pa-fe-name{font-weight:600;font-size:12.5px;white-space:nowrap;max-width:250px;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-path{font-size:11px;color:var(--dimmer,#6e7282);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%;font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-bar .sp,.pa-fe-foot .sp{flex:1}',
      '.pa-fe-save{font-size:11px;color:var(--dimmer,#6e7282);white-space:nowrap;min-width:96px;text-align:right}',
      '.pa-fe-save.ok{color:var(--ok,#3fb950)}',
      '.pa-fe-save.err{color:var(--err,#f85149)}',
      '.pa-fe-save.busy{color:var(--warn,#d29922)}',
      '.pa-fe-save.conflict{color:var(--warn,#d29922);font-weight:600}',
      '.pa-fe-cf{display:flex;align-items:center;gap:7px;color:var(--warn,#d29922);font-size:10.5px}',
      '.pa-fe-cf[hidden]{display:none}',
      '.pa-fe-cf-btn{height:19px;padding:0 8px;border-radius:4px;border:1px solid rgba(210,153,34,.45);background:transparent;color:var(--ink,#e6e8ee);font-size:10.5px;line-height:1}',
      '.pa-fe-cf-btn:hover{background:rgba(210,153,34,.16)}',
      '.pa-fe-cf-btn.primary{border-color:var(--warn,#d29922);color:var(--warn,#d29922);font-weight:600}',
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
      '.pa-fe-main{flex:1;min-height:0;display:flex;overflow:hidden;position:relative}',
      '.pa-fe-side{width:238px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg-2,#1a1c24);min-height:0}',
      '.pa-fe-side.collapsed{display:none}',
      '.pa-fe-shead{display:flex;align-items:center;gap:2px;padding:7px 7px 4px;font-size:10.5px;color:var(--dim,#a8acba);letter-spacing:.04em;flex:none;user-select:none}',
      '.pa-fe-shead>span{flex:1;display:flex;align-items:center;gap:5px;cursor:pointer;min-width:0}',
      '.pa-fe-shead>span:hover{color:var(--ink,#d8dae2)}',
      '.pa-fe-shead b{font-weight:600;font-size:9.5px;color:var(--dimmer,#6e7282);background:var(--surface-2,#252830);border-radius:8px;padding:0 5px;line-height:14px;flex:none}',
      '.pa-fe-shead .car{font-size:8px;color:var(--dimmer,#6e7282);transition:transform .15s;flex:none}',
      '.pa-fe-shead.closed .car{transform:rotate(-90deg)}',
      '.pa-fe-mini{font:inherit;font-size:12px;line-height:1;padding:3px 5px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--dim,#a8acba);cursor:pointer}',
      '.pa-fe-mini:hover{color:var(--brand,#ff7a59);border-color:var(--line-2,rgba(255,255,255,.18))}',
      '.pa-fe-dir{margin:0 7px 6px;font:inherit;font-size:11px;padding:4px 6px;border-radius:4px;border:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg,#16181e);color:var(--ink,#d8dae2);flex:none;min-width:0;font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-fwrap{display:flex;flex-direction:column;flex:0 1 auto;min-height:0;max-height:40%}',
      '.pa-fe-fwrap.closed .pa-fe-dir,.pa-fe-fwrap.closed .pa-fe-flist{display:none}',
      '.pa-fe-flist{flex:1 1 auto;overflow:auto;padding:0 4px 6px;min-height:0}',
      '.pa-fe-empty{padding:12px 9px;font-size:11.5px;color:var(--dimmer,#6e7282);line-height:1.7}',
      '.pa-fe-fitem{display:block;width:100%;text-align:left;font:inherit;font-size:11.5px;padding:5px 7px;border-radius:4px;border:none;background:transparent;color:var(--dim,#a8acba);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-fitem:hover{background:var(--surface-2,#252830);color:var(--ink,#d8dae2)}',
      '.pa-fe-fitem.on{background:var(--surface-3,#2c2f3a);color:var(--brand,#ff7a59)}',
      '.pa-fe-fitem small{display:block;font-size:10px;color:var(--dimmer,#6e7282);margin-top:1px;overflow:hidden;text-overflow:ellipsis}',
      /* ===== 接口一览（当前 .http 文件里的全部请求） ===== */
      '.pa-fe-owrap{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--line,rgba(255,255,255,.1));margin-top:2px}',
      '.pa-fe-owrap.closed .pa-fe-oq,.pa-fe-owrap.closed .pa-fe-oline{display:none}',
      '.pa-fe-oq{padding:0 7px 5px;flex:none}',
      '.pa-fe-oq input{width:100%;box-sizing:border-box;font:inherit;font-size:11px;padding:3px 6px;border-radius:4px;border:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg,#16181e);color:var(--ink,#d8dae2);font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-oq input::placeholder{color:var(--dimmer,#6e7282)}',
      '.pa-fe-oline{flex:1 1 auto;overflow:auto;padding:0 4px 8px;min-height:0}',
      '.pa-fe-oi{display:flex;align-items:center;gap:7px;width:100%;text-align:left;font:inherit;padding:4px 6px;border-radius:4px;border:none;background:transparent;cursor:pointer;min-height:22px;transition:.1s}',
      '.pa-fe-oi:hover{background:var(--surface-2,#252830)}',
      '.pa-fe-oi.on{background:var(--surface-3,#2c2f3a);box-shadow:inset 2px 0 0 var(--brand,#ff7a59)}',
      '.pa-fe-mb{flex:none;font-size:9px;font-weight:700;letter-spacing:.03em;width:38px;text-align:right;font-family:var(--mono,Consolas,monospace)}',
      '.pa-fe-oin{flex:1;font-size:11.5px;color:var(--ink,#d8dae2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pa-fe-oif{flex:none;font-size:9px;color:var(--dimmer,#6e7282);padding:0 3px;opacity:0;transition:.12s}',
      '.pa-fe-oi:hover .pa-fe-oif{opacity:1}',
      '.pa-fe-oif:hover{color:var(--brand,#ff7a59)}',
      '.pa-fe-oi.on .pa-fe-oif{opacity:.55}',
      '.pa-fe-oi.on .pa-fe-oin{color:var(--brand,#ff7a59)}',
      '.pa-fe-ost{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dimmer,#6e7282)}',
      '.pa-fe-ost.ok{background:var(--ok,#3fb950)}',
      '.pa-fe-ost.warn{background:var(--warn,#d29922)}',
      '.pa-fe-ost.err{background:var(--err,#f85149)}',
      '.pa-fe-ost.busy{background:var(--warn,#d29922);animation:paFePulse .8s infinite}',
      /* ===== 语法着色（代码层） ===== */
      '.pa-fe .t-sep{color:var(--brand,#ff7a59);font-weight:700}',
      '.pa-fe .t-sepname{color:var(--brand-hi,#ff926f);font-weight:700}',
      '.pa-fe .t-com{color:var(--dimmer,#6e7282);font-style:italic}',
      '.pa-fe .t-meta{color:var(--m-patch,#a371f7);font-weight:600}',
      '.pa-fe .t-metav{color:var(--dim,#a8acba)}',
      '.pa-fe .t-def{color:var(--j-bool,#d2a8ff);font-weight:600}',
      '.pa-fe .t-var{color:var(--brand-hi,#ff926f);background:rgba(255,122,89,.10);border-radius:3px}',
      '.pa-fe .t-m{font-weight:700}',
      '.pa-fe .t-m-get{color:var(--m-get,#3fb950)}',
      '.pa-fe .t-m-post{color:var(--m-post,#4493f8)}',
      '.pa-fe .t-m-put{color:var(--m-put,#d29922)}',
      '.pa-fe .t-m-patch{color:var(--m-patch,#a371f7)}',
      '.pa-fe .t-m-delete{color:var(--m-del,#f85149)}',
      '.pa-fe .t-m-head,.pa-fe .t-m-options,.pa-fe .t-m-trace,.pa-fe .t-m-connect{color:var(--m-other,#8b949e)}',
      '.pa-fe .t-usch{color:var(--dimmer,#6e7282)}',
      '.pa-fe .t-uhost{color:var(--j-key,#79c0ff)}',
      '.pa-fe .t-upath{color:var(--ink,#d8dae2)}',
      '.pa-fe .t-uqk{color:var(--dim,#a8acba)}',
      '.pa-fe .t-uqv{color:var(--j-str,#a5d6a4)}',
      '.pa-fe .t-ufrag{color:var(--dimmer,#6e7282)}',
      '.pa-fe .t-hk{color:var(--j-key,#79c0ff)}',
      '.pa-fe .t-hv{color:var(--ink,#d8dae2)}',
      '.pa-fe .t-colon,.pa-fe .t-ver{color:var(--dimmer,#6e7282)}',
      '.pa-fe .t-dir{color:var(--brand,#ff7a59);font-weight:700}',
      '.pa-fe .t-file{color:var(--j-str,#a5d6a4)}',
      '.pa-fe .t-bnd{color:var(--brand,#ff7a59);font-weight:700;letter-spacing:.02em}',
      '.pa-fe .t-script{color:var(--m-patch,#a371f7)}',
      '.pa-fe .t-scriptd{color:var(--dimmer,#6e7282);font-weight:700}',
      '.pa-fe .t-jkey{color:var(--j-key,#79c0ff)}',
      '.pa-fe .t-jstr{color:var(--j-str,#a5d6a4)}',
      '.pa-fe .t-jnum{color:var(--j-num,#ffab70)}',
      '.pa-fe .t-jbool{color:var(--j-bool,#d2a8ff)}',
      '.pa-fe .t-jnull{color:var(--j-null,#8b949e);font-style:italic}',
      '.pa-fe .t-jpunc{color:var(--dimmer,#6e7282)}',
      '.pa-fe .t-fk{color:var(--j-key,#79c0ff)}',
      '.pa-fe .t-fv{color:var(--j-str,#a5d6a4)}',
      '.pa-fe .t-plain{color:var(--dim,#a8acba)}',
      '.pa-fe-edit{flex:1;position:relative;min-width:0;min-height:0;overflow:hidden}',
      '.pa-fe-gutter{position:absolute;left:0;top:0;width:74px;height:100%;overflow:hidden;border-right:1px solid var(--line,rgba(255,255,255,.1));background:var(--bg-2,#1a1c24);z-index:2;pointer-events:none}',
      '.pa-fe-ginner{position:absolute;left:0;top:0;width:100%;will-change:transform}',
      '.pa-fe-ln{position:absolute;right:6px;height:20px;line-height:20px;font-family:var(--mono,Consolas,monospace);font-size:10.5px;color:var(--dimmer,#6e7282);text-align:right;pointer-events:none;user-select:none}',
      '.pa-fe-ln.on{color:var(--brand,#ff7a59);font-weight:700}',
      '.pa-fe-run{position:absolute;left:20px;width:16px;height:20px;line-height:19px;text-align:center;font-size:9px;color:var(--ok,#3fb950);cursor:pointer;pointer-events:auto;border-radius:3px;user-select:none;transition:.12s}',
      /* 双向跳转：请求行左侧「在表单里打开」 */
      '.pa-fe-form{position:absolute;left:3px;width:15px;height:20px;line-height:19px;text-align:center;font-size:10px;color:var(--dim,#a8acba);cursor:pointer;pointer-events:auto;border-radius:3px;user-select:none;transition:.12s}',
      '.pa-fe-form:hover{background:var(--brand,#ff7a59);color:#1a0d08;transform:scale(1.12)}',
      '.pa-fe-fold{position:absolute;left:3px;width:14px;height:20px;line-height:19px;text-align:center;font-size:9px;color:var(--dimmer,#6e7282);cursor:pointer;pointer-events:auto;border-radius:3px;user-select:none;opacity:.5;transition:.12s}',
      '.pa-fe-fold:hover{opacity:1;color:var(--brand,#ff7a59);background:var(--surface-2,#252830)}',
      '.pa-fe-fold.on{opacity:.95;color:var(--brand,#ff7a59)}',
      '.pa-fe-run:hover{background:var(--ok,#3fb950);color:#08170c;transform:scale(1.12)}',
      '.pa-fe-run.busy{color:var(--warn,#d29922);animation:paFePulse .8s infinite}',
      '.pa-fe-run.ok{color:var(--ok,#3fb950)}',
      '.pa-fe-run.warn{color:var(--warn,#d29922)}',
      '.pa-fe-run.err{color:var(--err,#f85149)}',
      '@keyframes paFePulse{0%,100%{opacity:.3}50%{opacity:1}}',
      /* 代码层：高亮绘制在 textarea 背后（textarea 文字透明，只留光标/选区/滚动条） */
      '.pa-fe-code{position:absolute;inset:0;overflow:hidden;z-index:0}',
      '.pa-fe-hl{position:absolute;left:0;top:0;min-width:100%;margin:0;padding:10px 14px 10px 82px;font-family:var(--mono,Consolas,monospace);font-size:12.5px;line-height:20px;white-space:pre;tab-size:2;letter-spacing:normal;font-variant-ligatures:none;pointer-events:none;user-select:none;color:var(--ink,#d8dae2);will-change:transform}',
      '.pa-fe-l{height:20px;min-height:20px;white-space:pre;border-radius:2px}',
      '.pa-fe-l.hit{background:rgba(255,122,89,.13);box-shadow:inset 0 0 0 1px rgba(255,122,89,.18)}',
      '.pa-fe-foldtag{margin-left:10px;padding:0 6px;border-radius:8px;background:var(--surface-3,#2c2f3a);color:var(--dimmer,#6e7282);font-size:10px;letter-spacing:.02em}',
      '.pa-fe-text{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;border:none;outline:none;resize:none;background:transparent;color:var(--ink,#d8dae2);font-family:var(--mono,Consolas,monospace);font-size:12.5px;line-height:20px;padding:10px 14px 10px 82px;white-space:pre;overflow:auto;tab-size:2;z-index:1;caret-color:var(--brand,#ff7a59);letter-spacing:normal;font-variant-ligatures:none}',
      '.pa-fe-edit.hl-on .pa-fe-text{color:transparent}',
      /* 高亮模式下选区只用淡色底，让底下的着色文字透出来（否则选中就全被盖成一种颜色） */
      '.pa-fe-edit.hl-on .pa-fe-text::selection{background:rgba(255,122,89,.30);color:transparent}',
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
      '[data-dbx-theme="light"] .pa-fe-fitem.on{background:#dde2ec}',
      '[data-dbx-theme="light"] .pa-fe-oq input{background:#fff}',
      '[data-dbx-theme="light"] .pa-fe-oi:hover{background:#e6e9f0}',
      '[data-dbx-theme="light"] .pa-fe-oi.on{background:#dde2ec}',
      '[data-dbx-theme="light"] .pa-fe-hl{color:#1a1d2e}',
      '[data-dbx-theme="light"] .pa-fe-foldtag{background:#e6e9f0}',
      '[data-dbx-theme="light"] .pa-fe-l.hit{background:rgba(232,96,42,.10)}',
      '[data-dbx-theme="light"] .pa-fe .t-var{background:rgba(232,96,42,.10)}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'paFeCss';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ===================== DOM ===================== */
  function buildPane() {
    /* v0.6.0：浮层挂在 .work 下（绝对定位），不再挤进 .req-region，
     * 这样上方 tab 条与下方响应框都不会被「顶掉」。 */
    var host = document.querySelector('.work') || document.querySelector('.req-region');
    if (!host) return null;
    var d = document.createElement('div');
    d.className = 'pa-fe off';
    d.id = 'fileEditorPane';
    d.innerHTML = [
      '<div class="pa-fe-bar">',
      '  <span class="pa-fe-dot"></span>',
      '  <span class="pa-fe-name" id="paFeName">未打开文件</span>',
      '  <span class="pa-fe-path" id="paFePath"></span>',
      '  <span class="sp"></span>',
      '  <select class="pa-fe-env" id="paFeEnv" title="http-client.env.json 环境"></select>',
      '  <span class="pa-fe-save" id="paFeSaveState">—</span>',
      '  <button class="pa-fe-btn" id="paFeSave" title="立即写入磁盘（Ctrl+S）；可反复点击，每次都真正落盘">保存</button>',
      '  <button class="pa-fe-btn" id="paFeSaveAs" title="另存为新的 .http 文件（系统保存对话框）">另存为</button>',
      '  <button class="pa-fe-btn" id="paFeRunAll" title="按顺序运行本文件全部请求">▶▶ 全部运行</button>',
      '  <button class="pa-fe-btn on" id="paFeAuto" title="切换自动保存">自动保存：开</button>',
      '  <button class="pa-fe-btn on" id="paFeSideBtn" title="显示/隐藏左侧的接口一览">≡ 接口一览</button>',
      '  <button class="pa-fe-btn ghost" id="paFeClose" title="向右收起成右缘悬浮箭头（点箭头原样回来；右键箭头可彻底关闭）">⇥ 收起</button>',
      '</div>',
      '<div class="pa-fe-main">',
      '  <div class="pa-fe-side" id="paFeSide">',
      '    <div class="pa-fe-owrap">',
      '      <div class="pa-fe-shead"><span id="paFeOToggle" title="当前 .http 文件里的全部接口，点一条跳到对应位置"><i class="car">▾</i>接口一览<b id="paFeOCount">0</b></span></div>',
      '      <div class="pa-fe-oq"><input id="paFeOq" spellcheck="false" placeholder="过滤 名称 / URL / 方法" /></div>',
      '      <div class="pa-fe-oline" id="paFeOList"><div class="pa-fe-empty">打开 .http 文件后，这里列出文件里所有接口</div></div>',
      '    </div>',
      '  </div>',
      '  <div class="pa-fe-edit" id="paFeEdit">',
      '    <div class="pa-fe-gutter"><div class="pa-fe-ginner" id="paFeGinner"></div></div>',
      '    <div class="pa-fe-code"><div class="pa-fe-hl" id="paFeHl"></div></div>',
      '    <textarea class="pa-fe-text" id="paFeText" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder=""></textarea>',
      '    <div class="pa-fe-idle" id="paFeIdle"><div style="font-size:13px;font-weight:600;color:var(--dim,#a8acba)">打开本地 .http 文件</div><div>点上方 <b>📂 打开</b>（或顶栏「▤ 打开 .http」）弹出系统文件对话框选择文件；<br>也可以直接把文件<b>从资源管理器拖进来</b>。</div><div style="font-size:11.5px">打开后可直接编辑，<b>自动保存</b>写回原文件、「保存」可反复点；每个请求左侧 ▶ 一点即发，结果显示在下方响应框。</div></div>',
      '  </div>',
      '</div>',
      '<div class="pa-fe-foot"><span id="paFeFoot">—</span><span class="pa-fe-cf" id="paFeConflict" hidden></span><span class="sp"></span><span>▶ 运行该请求 · Ctrl+S 保存 · Tab 缩进</span></div>'
    ].join('\n');
    host.appendChild(d);

    /* 收起后留在右缘的入口（灰色半透明箭头）。跟浮层是兄弟节点，
     * 所以浮层滑走时它留在原位；浮层展开时它自己滑出屏幕。 */
    var e = document.createElement('button');
    e.type = 'button';
    e.className = 'pa-edge';
    e.id = 'paEdgeTab';
    e.title = '展开 .http 浮层（可上下拖动；右键彻底关闭）';
    e.innerHTML = '<svg width="12" height="30" viewBox="0 0 12 30" aria-hidden="true">' +
      '<path d="M9 2.5 L2.5 15 L9 27.5" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    host.appendChild(e);
    edge = e;
    return d;
  }

  /* ===================== 模式切换 ===================== */
  /* v0.6.0 起不再改 --reqH/--reqW：浮层绝对定位，尺寸由 layoutLayer() 贴着
   * 「请求编辑区」量出来，底下真实布局一点不动，收起后原样可用。 */

  /* ===================== 浮层状态：展开 / 收起 / 彻底关闭 =====================
   * S.open      浮层是否还“在”（收起也算在，状态全保留）
   * S.collapsed 是否已经收进右缘箭头
   * 收起 ≠ 关闭：文件、光标位置、折叠状态、未保存内容都留着，点箭头原样回来。 */
  function enterMode() {
    if (!pane) return;
    layoutLayer();
    pane.classList.remove('off');
    if (edge) edge.classList.remove('on');
    if (S.open) { S.collapsed = false; return; }
    S.open = true;
    S.collapsed = false;
    resetWorkScroll();
    setTimeout(syncGutter, 30);
    setTimeout(syncGutter, 400);
    setTimeout(function () { resetWorkScroll(); reclampFe(); }, 420);
  }

  /* 关键：浮层尺寸跟着「请求编辑区」走 —— 上下分栏时盖到响应框上沿（结果还看得见），
   * 左右分栏时只盖左列。不写死，布局/窗口变化都重算一次。 */
  function layoutLayer() {
    if (!pane) return;
    var work = document.querySelector('.work');
    if (!work) return;
    var tabbar = document.querySelector('.tabbar');
    var res = document.querySelector('.res-region');
    var req = document.querySelector('.req-region');
    if (!edge || !work.contains(edge)) {
      /* 极端情况下浮层被重建过：补挂箭头 */
      if (edge) work.appendChild(edge);
    }
    var wr = work.getBoundingClientRect();
    var top = tabbar ? Math.round(tabbar.getBoundingClientRect().bottom - wr.top) : 79;
    var right = 0, bottom = 0;
    if (res && req) {
      var rr = res.getBoundingClientRect(), qr = req.getBoundingClientRect();
      if (rr.top >= qr.bottom - 2) bottom = Math.round(wr.bottom - rr.top);     /* 上下 */
      else right = Math.round(wr.right - qr.right);                             /* 左右 */
    }
    pane.style.top = Math.max(0, top) + 'px';
    pane.style.bottom = Math.max(0, bottom) + 'px';
    pane.style.right = Math.max(0, right) + 'px';
    /* 收起时要整块滑出 .work 右边界：位移量按工作区宽度算，
     * 左右分栏时浮层比工作区窄，100% 不够（会露出一截盖在响应框上）。 */
    pane.style.setProperty('--fe-slide', Math.round(wr.width) + 'px');
    /* 尺寸重算后位置也要重新夹：窗口变小/分栏切换后，原来的位移可能已经出界 */
    var c = clampFePos(S.feX, S.feY);
    S.feX = c.x; S.feY = c.y;
    applyFePos();
  }

  /* 浮层滑到工作区外面以后，浏览器有时会把 .work 的横向 scrollLeft 顶偏
   * （收起动画/焦点滚动引起），箭头用的是 right:0，一偏就离右缘差一截。
   * 收起后归零，保证箭头真的贴边。 */
  function resetWorkScroll() {
    var w = document.querySelector('.work');
    if (w && w.scrollLeft) w.scrollLeft = 0;
  }

  /* ===================== S3.1：按住标题条拖浮层 =====================
   * 位置只记「相对基础盒的位移」--fe-dx/--fe-dy，不去改 left/top ——
   * 基础盒由 layoutLayer() 贴着请求编辑区算，改 left 会把宽度压变形。
   * 拖动时 pointermove 只记数、rAF 合帧写样式；松手夹回 .work 内并落偏好；
   * 双击标题条归零。 */
  function applyFePos() {
    if (!pane) return;
    pane.style.setProperty('--fe-dx', Math.round(S.feX) + 'px');
    pane.style.setProperty('--fe-dy', Math.round(S.feY) + 'px');
  }

  /* 用 offsetLeft/offsetTop 量基础盒：这两个值不受 transform 影响，
   * 收起动画进行中、或刚从 off 里出来时也量得准。 */
  function paneBaseBox() {
    if (!pane) return null;
    var work = document.querySelector('.work');
    if (!work) return null;
    var wr = work.getBoundingClientRect();
    var bar = pane.querySelector('.pa-fe-bar');
    /* offsetLeft/Top 是相对 padding 盒的，.work 被滚过（overflow:hidden 也能被滚）
     * 就要把滚量减回去，否则量出来的基础盒会整体偏一段。 */
    return {
      l: wr.left - (work.scrollLeft || 0) + pane.offsetLeft,
      t: wr.top - (work.scrollTop || 0) + pane.offsetTop,
      w: pane.offsetWidth,
      h: pane.offsetHeight,
      bar: bar ? bar.offsetHeight : 34,
      work: wr
    };
  }

  /* 允许的位移：整块浮层留在 .work 里。
   * 不采用「只留标题条」的松夹法 —— 那样浮层会露到工作区外面被裁掉，
   * 看着像坏了；宁可夹紧一点，位置也更好预测。 */
  function clampFePos(x, y, box) {
    box = box || paneBaseBox();
    if (!box || !box.w || !box.h) return { x: x, y: y };
    var minX = box.work.left - box.l;
    var maxX = box.work.right - box.l - box.w;
    var minY = box.work.top - box.t;
    var maxY = box.work.bottom - box.t - box.h;
    return {
      x: maxX < minX ? minX : Math.max(minX, Math.min(maxX, x)),
      y: maxY < minY ? minY : Math.max(minY, Math.min(maxY, y))
    };
  }

  /* 布局变了（窗口缩放 / 分栏切换）后把现有位置重新夹一遍 */
  function reclampFe() {
    if (!pane || !S.open || S.collapsed) return;
    var p = clampFePos(S.feX, S.feY);
    if (p.x !== S.feX || p.y !== S.feY) {
      S.feX = p.x; S.feY = p.y;
      applyFePos();
    }
  }

  function resetFePos(silent) {
    S.feX = 0; S.feY = 0;
    applyFePos();
    savePrefs();
    if (!silent) toast('浮层位置已复位');
  }

  function bindPaneDrag() {
    if (!pane) return;
    var bar = pane.querySelector('.pa-fe-bar');
    if (!bar) return;
    bar.title = '按住标题条拖动浮层 · 双击复位';
    /* 标题条里全是按钮 / 下拉，按在它们身上不算拖 */
    var isCtl = function (t) {
      return !!(t && t.closest && t.closest('button,select,input,textarea,a,label'));
    };
    var dg = null, raf = 0, nx = 0, ny = 0;

    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || isCtl(e.target) || !S.open || S.collapsed) return;
      if (!paneBaseBox()) return;
      dg = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: S.feX, dy: S.feY, live: false, box: paneBaseBox() };
      try { bar.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dg || e.pointerId !== dg.id) return;
      var mx = e.clientX - dg.x0, my = e.clientY - dg.y0;
      if (!dg.live) {
        if (Math.abs(mx) < 3 && Math.abs(my) < 3) return;   /* 手指抖不算拖 */
        dg.live = true;
        pane.classList.add('dragging');
      }
      var p = clampFePos(dg.dx + mx, dg.dy + my, dg.box);
      nx = p.x; ny = p.y;
      if (!raf) raf = requestAnimationFrame(function () {
        raf = 0;
        S.feX = nx; S.feY = ny;
        applyFePos();
      });
    });

    var endDrag = function () {
      if (!dg) return;
      var live = dg.live, id = dg.id;
      dg = null;
      if (raf) {   /* 最后一帧还没落地：补上，别丢掉松手前最后那几像素 */
        cancelAnimationFrame(raf); raf = 0;
        S.feX = nx; S.feY = ny;
        applyFePos();
      }
      pane.classList.remove('dragging');
      try { bar.releasePointerCapture(id); } catch (err) { }
      if (live) savePrefs();
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    bar.addEventListener('dblclick', function (e) {
      if (isCtl(e.target)) return;
      resetFePos();
    });
  }

  /* 只把箭头挂上、浮层保持藏起来（v0.6.1）。
   * 用在「启动时恢复了上次的文件」：知道文件在哪，就给一个入口，
   * 但不主动把界面顶出来 —— 用户点箭头才展开。 */
  function armEdge() {
    if (!pane) return;
    layoutLayer();
    S.open = true;
    S.collapsed = true;
    if (pane) pane.classList.add('off');
    if (edge) {
      edge.style.top = (S.edgeTop || 20) + '%';
      edge.title = '展开 ' + (S.name || '.http') + '（可上下拖动；右键彻底关闭）';
      edge.classList.add('on');
    }
    resetWorkScroll();
  }

  /* 收起：向右滑出 → 右缘浮出灰色半透明箭头 */
  function collapse(silent) {
    if (!S.open || S.collapsed) return;
    S.collapsed = true;
    layoutLayer();
    if (pane) pane.classList.add('off');
    if (edge) {
      edge.style.top = (S.edgeTop || 20) + '%';
      edge.title = '展开 ' + (S.name || '.http') + '（可上下拖动；右键彻底关闭）';
      edge.classList.add('on');
    }
    resetWorkScroll();
    setTimeout(resetWorkScroll, 60);
    setTimeout(resetWorkScroll, 420);
    /* 收起前把没落盘的改动写掉，避免“看不见了就不敢改”的心结 */
    if (S.dirty && saveTimer) { clearTimeout(saveTimer); doSave(false); }
    if (!silent) toast('已收起到右侧箭头 · 点箭头回到 .http');
  }

  /* 展开：箭头滑出，浮层从右侧滑回 */
  function expand() {
    if (!S.open) { open(); return; }
    layoutLayer();
    S.collapsed = false;
    if (pane) pane.classList.remove('off');
    if (edge) edge.classList.remove('on');
    /* 展开时浏览器会把焦点滚进视野，.work 的 scrollLeft 可能被顶偏；
     * 滚量一变基础盒就偏，位置也就偏，所以归零后再夹一次。 */
    resetWorkScroll();
    setTimeout(resetWorkScroll, 60);
    setTimeout(function () { resetWorkScroll(); reclampFe(); }, 420);
    setTimeout(function () { if (ta) ta.focus(); }, 140);
    setTimeout(syncGutter, 400);
  }

  /* 彻底关闭：浮层和箭头一起消失，回到普通请求编辑器 */
  function exitMode(silent) {
    var was = S.open;
    S.open = false;
    S.collapsed = false;
    if (pane) pane.classList.add('off');
    if (edge) edge.classList.remove('on');
    if (was && !silent) toast('已关闭 .http 浮层');
  }

  /* ===================== 文本权威：S.text 才是文档 ===================== */
  /* 折叠只是「视图投影」——ta.value 里是被折叠掉若干行的样子。
   * 所有落盘/解析都必须走 docText()，否则折叠状态下会把隐藏行写丢。 */
  function docText() { return S.text; }

  function indexLines() {
    var lines = S.text.split('\n');
    S.fullLines = lines;
    var off = new Array(lines.length), p = 0;
    for (var i = 0; i < lines.length; i++) { off[i] = p; p += lines[i].length + 1; }
    S.lineOff = off;
  }

  function ensure() {
    if (S.hlKey === S.text) return;
    S.hlKey = S.text;
    indexLines();
    S.hl = highlight(S.text, S.fullLines);
    /* 文本变了以后旧的折叠行号可能已失效：只保留仍然可折叠的 */
    var keep = {};
    for (var k in S.folded) if (S.hl.byOpen[k] != null) keep[k] = 1;
    S.folded = keep;
  }

  function hasFolds() { for (var k in S.folded) if (S.folded[k]) return true; return false; }

  /* 视图 = 全文行号序列；hide[行] = 遮住它的折叠起点；tags[起点] = 折掉多少行 */
  function buildView() {
    var n = S.fullLines.length;
    var view = [], hide = {}, tags = {};
    for (var ln = 0; ln < n;) {
      view.push(ln);
      var c = S.hl.byOpen[ln];
      if (S.folded[ln] && c != null && c > ln) {
        tags[ln] = c - ln;
        for (var j = ln + 1; j <= c && j < n; j++) if (!(j in hide)) hide[j] = ln;
        ln = c + 1;
      } else {
        ln++;
      }
    }
    S.view = view; S.hide = hide; S.tags = tags;
  }

  function viewText() {
    var lines = [], i;
    for (i = 0; i < S.view.length; i++) lines.push(S.fullLines[S.view[i]]);
    return lines.join('\n');
  }

  /* 全文 (行, 列) → textarea 里的偏移（None = 这行被折叠了） */
  function viewOffset(fullLine, col) {
    var v = S.view.indexOf(fullLine);
    if (v < 0) return null;
    var off = 0;
    for (var i = 0; i < v; i++) off += (S.fullLines[S.view[i]] || '').length + 1;
    return off + (col || 0);
  }

  /* 当前光标 → 全文 (行, 列) */
  function mapCaret() {
    var pos = ta ? (ta.selectionStart || 0) : 0;
    var before = ta ? ta.value.slice(0, pos) : '';
    var vLine = before.split('\n').length - 1;
    var col = pos - (before.lastIndexOf('\n') + 1);
    var fi = S.view[vLine] != null ? S.view[vLine] : vLine;
    return { line: fi, col: col };
  }

  function paint() {
    if (!hlEl) return;
    if (S.hl.plain) {
      hlEl.innerHTML = '';
      if (E.edit) E.edit.classList.remove('hl-on');
      return;
    }
    if (E.edit) E.edit.classList.add('hl-on');
    var out = [], i;
    for (i = 0; i < S.view.length; i++) {
      var fi = S.view[i];
      var html = S.hl.html[fi] || '';
      var tag = S.tags[fi];
      if (tag) html += '<span class="pa-fe-foldtag">⋯ ' + tag + ' 行已折叠</span>';
      out.push('<div class="pa-fe-l' + (fi === S.hitLine ? ' hit' : '') + '">' + html + '</div>');
    }
    hlEl.innerHTML = out.join('');
    syncScroll();
  }

  /* 大文件（上千行）打字时不让着色拖慢输入：60ms 后补画 */
  var paintTimer = null;
  function paintSoon() {
    if (S.fullLines.length <= 1200) { paint(); return; }
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paint, 60);
  }

  function rebuild() {
    if (!ta) return;
    var st = ta.scrollTop, sl = ta.scrollLeft;
    ensure();
    buildView();
    var vt = viewText();
    if (ta.value !== vt) ta.value = vt;
    paintSoon();
    renderGutter();
    ta.scrollTop = st;
    ta.scrollLeft = sl;
    syncScroll();
  }

  /* 整篇替换（打开文件/新建）：清折叠、清缓存、回到顶部 */
  function setDoc(t) {
    S.text = String(t == null ? '' : t).replace(/\r\n?/g, '\n');
    S.folded = {};
    S.hitLine = -1;
    S.hlKey = null;
    S.activeReq = -1;
    /* 赋值后 textarea 的光标会落到末尾，随后的 focus() 会把视图滚到文件最后一行。
     * 打开一个文件应该从第 1 行看起，所以这里把光标和滚动都归零。 */
    if (ta) {
      ta.value = S.text;
      try { ta.setSelectionRange(0, 0); } catch (e) { }
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    }
    ensure();
    buildView();
    paint();
    renderGutter();
    syncScroll();
  }

  function syncScroll() {
    if (!ta) return;
    if (ginner) ginner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    if (hlEl) hlEl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
  }
  function syncGutter() { syncScroll(); }

  function renderGutter() {
    if (!ginner || !ta) return;
    var reqs = (S.parsed && S.parsed.requests) || [];
    var byLine = {};
    for (var k = 0; k < reqs.length; k++) byLine[reqs[k].line] = k;

    var foldKeys = [];
    for (var fk in S.folded) if (S.folded[fk]) foldKeys.push(fk);
    foldKeys.sort();
    /* 折叠可折叠点也要进签名：换文件后行数一样、但可折叠位置不同时箭头不能留旧的 */
    var openKeys = [];
    for (var ok in S.hl.byOpen) openKeys.push(ok);
    openKeys.sort();
    var sigParts = [S.view.length, foldKeys.join('.'), openKeys.join('.')];
    for (var z = 0; z < reqs.length; z++) sigParts.push(reqs[z].line + ':' + (S.lastRun[reqs[z].line] || ''));
    var sig = sigParts.join('|');
    if (sig === S.gutterSig) { syncScroll(); return; }
    S.gutterSig = sig;

    var out = [];
    var showNo = S.view.length <= 4000;
    for (var i = 0; i < S.view.length; i++) {
      var fi = S.view[i];
      var ln = fi + 1;
      var top = PAD_TOP + i * LINE_H;
      var close = S.hl.byOpen[fi];
      if (close != null && close > fi) {
        var folded = !!S.folded[fi];
        out.push('<div class="pa-fe-fold' + (folded ? ' on' : '') + '" style="top:' + top + 'px" data-fold="' + fi +
          '" title="' + (folded ? '展开' : '折叠') + ' 第 ' + ln + '–' + (close + 1) + ' 行">' +
          (folded ? '▸' : '▾') + '</div>');
      }
      var ri = byLine[ln];
      if (ri !== undefined) {
        var st = S.lastRun[ln] || '';
        out.push('<div class="pa-fe-form" style="top:' + top + 'px" data-ri="' + ri + '" title="在表单里打开：' +
          esc(reqName(reqs[ri])) + '">▤</div>');
        out.push('<div class="pa-fe-run ' + st + '" style="top:' + top + 'px" data-ri="' + ri + '" title="运行：' +
          esc(reqName(reqs[ri])) + '">▶</div>');
      }
      if (showNo) {
        out.push('<div class="pa-fe-ln' + (ri !== undefined ? ' on' : '') + '" style="top:' + top + 'px">' + ln + '</div>');
      }
    }
    ginner.innerHTML = out.join('');
    syncScroll();
  }

  /* 跳到某个全文行（1 基）：必要时先展开遮挡它的折叠，再滚动 + 闪烁 */
  function gotoLine(line1, ri) {
    if (!ta) return;
    var fi = Math.max(0, Number(line1) - 1);
    var hid = S.hide[fi];
    if (hid != null) { delete S.folded[hid]; rebuild(); }
    var vi = S.view.indexOf(fi);
    if (vi < 0) vi = Math.min(fi, Math.max(0, S.view.length - 1));
    var top = PAD_TOP + vi * LINE_H;
    var h = ta.clientHeight || 300;
    if (top < ta.scrollTop + 24 || top > ta.scrollTop + h - 40) {
      ta.scrollTop = Math.max(0, top - Math.round(h * 0.32));
    }
    var vo = viewOffset(fi, 0);
    try {
      ta.focus();
      if (vo != null) ta.setSelectionRange(vo, vo);
    } catch (e) { }
    syncScroll();
    S.hitLine = fi;
    paint();
    clearTimeout(hitTimer);
    hitTimer = setTimeout(function () { S.hitLine = -1; paint(); }, 1300);
    if (ri != null) { S.activeReq = ri; markActive(); }
    var on = E.olist && E.olist.querySelector('.pa-fe-oi.on');
    if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest' }); } catch (e) { } }
  }

  function toggleFold(fi) {
    if (!ta) return;
    var topFull = S.view[Math.max(0, Math.floor((ta.scrollTop - PAD_TOP) / LINE_H))];
    if (S.folded[fi]) delete S.folded[fi]; else S.folded[fi] = 1;
    rebuild();
    if (topFull != null) {
      var vi = S.view.indexOf(topFull);
      if (vi >= 0) ta.scrollTop = PAD_TOP + vi * LINE_H;
    }
    syncScroll();
  }

  /* 折叠状态下 textarea 是投影：任何编辑动作前先展开，绝不把隐藏行写丢 */
  function expandFoldsForEdit() {
    if (!hasFolds() || !ta) return;
    var c = mapCaret();
    S.folded = {};
    buildView();
    ta.value = viewText();
    S.text = ta.value;
    var vo = viewOffset(c.line, c.col);
    if (vo != null) { try { ta.setSelectionRange(vo, vo); } catch (e) { } }
    rebuild();
    toast('已展开折叠区域（折叠时不可编辑）');
  }

  /* ===================== 语法着色 ===================== */
  /* 输出必须「逐字符保真」：所有分支的可见文本加起来要等于原始行，
   * 否则代码层（高亮）与 textarea（光标/选区）会错位。 */

  function sp(cls, txt) {
    if (txt == null || txt === '') return '';
    return '<span class="' + cls + '">' + esc(txt) + '</span>';
  }

  /* 值里的 {{变量}} 单独上色 */
  function hiVal(s, cls) {
    if (s == null || s === '') return '';
    s = String(s);
    if (s.indexOf('{{') < 0) return sp(cls, s);
    var out = '', last = 0, re = /\{\{[^{}]*\}\}/g, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out += sp(cls, s.slice(last, m.index));
      out += sp('t-var', m[0]);
      last = m.index + m[0].length;
    }
    if (last < s.length) out += sp(cls, s.slice(last));
    return out;
  }

  function hiNum(s) {
    var out = '', last = 0, re = /\{\{[^{}]*\}\}/g, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out += sp('t-plain', s.slice(last, m.index));
      out += sp('t-var', m[0]);
      last = m.index + m[0].length;
    }
    if (last < s.length) out += esc(s.slice(last));
    return out;
  }

  /* URL：协议 / 主机 / 路径 / query（键值分色）/ fragment */
  function hiUrl(u) {
    var out = '', s = String(u == null ? '' : u);
    var m = /^([a-zA-Z][\w+.\-]*:\/\/)/.exec(s);
    if (m) { out += sp('t-usch', m[1]); s = s.slice(m[1].length); }
    var h = /^[^\/?#]*/.exec(s)[0];
    if (h) { out += hiVal(h, 't-uhost'); s = s.slice(h.length); }
    var p = /^[^?#]*/.exec(s)[0];
    if (p) { out += hiVal(p, 't-upath'); s = s.slice(p.length); }
    if (s.charAt(0) === '?') {
      var qm = /^\?[^#]*/.exec(s)[0];
      out += sp('t-jpunc', '?');
      var body = qm.slice(1);
      var segs = body.split('&');
      for (var i = 0; i < segs.length; i++) {
        if (i) out += sp('t-jpunc', '&');
        var kv = segs[i], eq = kv.indexOf('=');
        if (eq < 0) out += hiVal(kv, 't-uqk');
        else {
          out += hiVal(kv.slice(0, eq), 't-uqk');
          out += sp('t-jpunc', '=');
          out += hiVal(kv.slice(eq + 1), 't-uqv');
        }
      }
      s = s.slice(qm.length);
    }
    if (s) out += sp('t-ufrag', s);
    return out;
  }

  function hiScript(L) {
    var s = String(L == null ? '' : L), out = '', last = 0, re = /\{%|%\}/g, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out += sp('t-script', s.slice(last, m.index));
      out += sp('t-scriptd', m[0]);
      last = m.index + m[0].length;
    }
    if (last < s.length) out += sp('t-script', s.slice(last));
    return out;
  }

  function hiForm(L) {
    var s = String(L == null ? '' : L), out = '', segs = s.split('&');
    for (var i = 0; i < segs.length; i++) {
      if (i) out += sp('t-jpunc', '&');
      var kv = segs[i], eq = kv.indexOf('=');
      if (eq < 0) { out += hiVal(kv, 't-fk'); continue; }
      out += hiVal(kv.slice(0, eq), 't-fk');
      out += sp('t-jpunc', '=');
      out += hiVal(kv.slice(eq + 1), 't-fv');
    }
    return out;
  }

  /* JSON 单行着色；顺带用括号栈记录跨行区间 → 折叠点 */
  function hiJson(L, ctx) {
    var out = '', i = 0, n = L.length, lineIdx = ctx.idx;

    while (i < n) {
      var c = L[i], start = i;

      if (c === '"') {
        var j = i + 1, closed = false;
        while (j < n) {
          if (L[j] === '\\') { j += 2; continue; }
          if (L[j] === '"') { j++; closed = true; break; }
          j++;
        }
        var raw = L.slice(i, j);
        var k = j;
        while (k < n && (L[k] === ' ' || L[k] === '\t')) k++;
        var isKey = (k < n && L[k] === ':');
        var cls = isKey ? 't-jkey' : 't-jstr';
        if (raw.indexOf('{{') >= 0) {
          out += sp('t-jpunc', '"');
          out += hiVal(raw.slice(1, closed ? raw.length - 1 : raw.length), cls);
          if (closed) out += sp('t-jpunc', '"');
        } else {
          out += sp(cls, raw);
        }
        i = j;
        continue;
      }
      if (c === '{' || c === '[') {
        ctx.stack.push({ line: lineIdx });
        out += sp('t-jpunc', c); i++; continue;
      }
      if (c === '}' || c === ']') {
        var o = ctx.stack.pop();
        if (o && o.line < lineIdx) ctx.folds.push({ open: o.line, close: lineIdx, kind: 'json' });
        out += sp('t-jpunc', c); i++; continue;
      }
      if (c === ':' || c === ',') { out += sp('t-jpunc', c); i++; continue; }
      if (c === ' ' || c === '\t') {
        var w = start + 1;
        while (w < n && (L[w] === ' ' || L[w] === '\t')) w++;
        out += L.slice(start, w); i = w; continue;
      }
      if (c === '-' || (c >= '0' && c <= '9')) {
        var nm = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+\-]?\d+)?/.exec(L.slice(i));
        if (nm && nm[0]) { out += sp('t-jnum', nm[0]); i += nm[0].length; continue; }
      }
      if (L.substr(i, 4) === 'true' || L.substr(i, 5) === 'false') {
        var bl = L.substr(i, 4) === 'true' ? 'true' : 'false';
        out += sp('t-jbool', bl); i += bl.length; continue;
      }
      if (L.substr(i, 4) === 'null') { out += sp('t-jnull', 'null'); i += 4; continue; }
      out += sp('t-plain', c); i++;
    }
    return out;
  }

  /* 一行文本 → 该行的高亮 HTML，并推进解析状态 */
  function hlLine(L, ctx) {
    var T = L.trim();
    var lead = L.slice(0, L.length - L.replace(/^\s+/, '').length);
    ctx.kinds[ctx.idx] = 'text';

    /* 1) 脚本块内（{% ... %} 跨行） */
    if (ctx.script) {
      ctx.kinds[ctx.idx] = 'script';
      if (T.indexOf('%}') >= 0) ctx.script = false;
      return (lead ? esc(lead) : '') + hiScript(L.slice(lead.length));
    }

    /* 2) ### 分隔：连续 3 个以上 #；# 后面（一个或多个空格/Tab）的部分才是标题 */
    if (/^#{3,}/.test(T)) {
      ctx.kinds[ctx.idx] = 'sep';
      ctx.mode = 'idle'; ctx.body = ''; ctx.ctJson = false; ctx.stack = [];
      var hashes = /^#{3,}/.exec(T)[0];
      var out = (lead ? esc(lead) : '') + sp('t-sep', hashes);
      var rest = T.slice(hashes.length);
      var trail = /[ \t]+$/.exec(L);
      var trailS = trail ? trail[0] : '';
      if (!rest) return out + esc(trailS);
      var sname = rest.replace(/^[ \t]+/, '');
      var gap = rest.slice(0, rest.length - sname.length);
      if (gap) out += gap;              /* 多个空格/Tab 原样保留 */
      if (sname) out += sp('t-sepname', sname);
      return out + esc(trailS);
    }

    /* 3) 脚本（单行 / 块首）—— 必须排在 body 之前：> {% %} 常在 body 之后出现 */
    if (/^\{%/.test(T) || /^>\s*\{%/.test(T) || /^%\}/.test(T)) {
      ctx.kinds[ctx.idx] = 'script';
      if (T.indexOf('%}') < 0) ctx.script = true;
      return (lead ? esc(lead) : '') + hiScript(L.slice(lead.length));
    }

    /* 4) body 区域（含以 # 开头的 body 文本） */
    if (ctx.mode === 'body') return bodyLine(L, T, lead, ctx);

    /* 5) 元数据注释 # @name / 普通注释 */
    if (/^#\s*@/.test(T)) {
      ctx.kinds[ctx.idx] = 'meta';
      var mm = /^#\s*(@[\w.\-]+)\s*(.*)$/.exec(T);
      var mo = (lead ? esc(lead) : '') + sp('t-com', '#') + ' ' + sp('t-meta', mm[1]);
      if (mm[2]) mo += ' ' + hiVal(mm[2], 't-metav');
      return mo;
    }
    if (/^#/.test(T) || /^\/\//.test(T)) {
      ctx.kinds[ctx.idx] = 'comment';
      return (lead ? esc(lead) : '') + sp('t-com', L.slice(lead.length));
    }

    /* 6) 文件级变量 @name = value */
    var dm = /^@([\w.\-]+)([ \t]*=[ \t]*)(.*)$/.exec(T);
    if (dm) {
      ctx.kinds[ctx.idx] = 'var';
      return (lead ? esc(lead) : '') + sp('t-def', '@' + dm[1]) + sp('t-jpunc', dm[2]) + hiVal(dm[3], 't-metav');
    }

    /* 7) 请求行 METHOD URL [HTTP/1.1] */
    var rm = REQ_LINE_RE.exec(T);
    if (rm && (ctx.mode === 'idle' || ctx.mode === 'headers')) {
      ctx.kinds[ctx.idx] = 'req';
      ctx.mode = 'headers'; ctx.body = ''; ctx.ctJson = false; ctx.stack = [];
      var meth = rm[2];
      var rest2 = rm[4];
      var url = rest2, ver = '';
      var vmm = /[ \t]+HTTP\/[\d.]+\s*$/.exec(rest2);
      if (vmm) { ver = vmm[0].replace(/\s+$/, ''); url = rest2.slice(0, vmm.index); }
      return (lead ? esc(lead) : '') + sp('t-m t-m-' + meth.toLowerCase(), meth) + rm[3] +
        hiUrl(url) + (ver ? sp('t-ver', ver) : '');
    }

    /* 8) headers 区域 */
    if (ctx.mode === 'headers') {
      if (!T) { ctx.kinds[ctx.idx] = 'blank'; ctx.mode = 'body'; ctx.body = ''; return ''; }
      var dir = /^(<<|<>|>>|<|>)([ \t]*)(.*)$/.exec(T);
      if (dir) {
        ctx.kinds[ctx.idx] = 'dir';
        return (lead ? esc(lead) : '') + sp('t-dir', dir[1]) + (dir[3] ? dir[2] + sp('t-file', dir[3]) : '');
      }
      var hm = /^([^:\s][^:]*)(:)([ \t]*)(.*)$/.exec(L);
      if (hm) {
        ctx.kinds[ctx.idx] = 'hdr';
        if (/^content-type$/i.test(hm[1].trim()) && /json/i.test(hm[4])) ctx.ctJson = true;
        return sp('t-hk', hm[1]) + sp('t-colon', ':') + hm[3] + hiVal(hm[4], 't-hv');
      }
      ctx.kinds[ctx.idx] = 'text';
      return esc(L);
    }

    /* 9) 兜底 */
    if (!T) return '';
    return sp('t-plain', L);
  }

  function bodyLine(L, T, lead, ctx) {
    ctx.kinds[ctx.idx] = 'body';

    /* < ./body.json   > ./out.json —— IDEA 里这两条就写在 body 位置 */
    var dir = /^(<<|<>|>>|<|>)([ \t]+)(\S.*?)\s*$/.exec(T);
    if (dir) {
      ctx.kinds[ctx.idx] = 'dir';
      return (lead ? esc(lead) : '') + sp('t-dir', dir[1]) + dir[2] + sp('t-file', dir[3]);
    }

    if (!ctx.body) {
      if (!T) return '';
      if (/^--\S+/.test(T)) ctx.body = 'multipart';
      else if (ctx.ctJson || /^[\[{]/.test(T)) ctx.body = 'json';
      else if (/^[^\s=&]+=/.test(T) && T.indexOf('{') < 0) ctx.body = 'form';
      else ctx.body = 'text';
    }
    if (ctx.body === 'multipart') {
      var leadH = lead ? esc(lead) : '';
      var bm = /^(--\S+?)(--)?\s*$/.exec(T);
      if (bm) return leadH + sp('t-bnd', bm[1]) + sp('t-meta', bm[2] || '');
      var hm = /^([^:\s][^:]*)(:[ \t]*)(.*)$/.exec(T);
      if (hm) return leadH + sp('t-hk', hm[1]) + sp('t-colon', hm[2]) + sp('t-hv', hm[3]);
      return esc(L);
    }
    if (ctx.body === 'json') return hiJson(L, ctx);
    if (ctx.body === 'form') return (lead ? esc(lead) : '') + hiForm(L.slice(lead.length));
    return esc(L);
  }

  /* 整篇着色 → { html[], folds[] } */
  function highlight(text, lines) {
    var n = lines.length;
    var html = new Array(n);
    var i;
    if (n > MAX_HL_LINES) {
      for (i = 0; i < n; i++) html[i] = esc(lines[i]);
      return { html: html, folds: [], byOpen: {}, plain: true };
    }
    var ctx = {
      idx: 0, mode: 'idle', body: '', ctJson: false,
      stack: [], folds: [], kinds: [], script: false
    };
    /* 整篇就是一个 JSON（.json 文件 / 纯 body）：直接按 JSON 上色 */
    var looksJson = /^\s*[\[{]/.test(text) &&
      !/^#{3,}/m.test(text) &&
      !new RegExp('^\\s*(' + METHODS_RE + ')\\s+\\S', 'm').test(text);
    if (looksJson) { ctx.mode = 'body'; ctx.body = 'json'; ctx.ctJson = true; }
    for (i = 0; i < n; i++) {
      ctx.idx = i;
      html[i] = hlLine(lines[i], ctx);
    }

    /* 请求块折叠：从 ### 到下一个 ### 的前一行（没有 ### 的文件以请求行为界） */
    var starts = [];
    for (i = 0; i < n; i++) if (ctx.kinds[i] === 'sep') starts.push(i);
    if (!starts.length) for (i = 0; i < n; i++) if (ctx.kinds[i] === 'req') starts.push(i);
    for (var b = 0; b < starts.length; b++) {
      var s0 = starts[b];
      var e0 = (b + 1 < starts.length ? starts[b + 1] : n) - 1;
      while (e0 > s0 && !String(lines[e0]).trim()) e0--;
      if (e0 - s0 >= 3) ctx.folds.push({ open: s0, close: e0, kind: 'block' });
    }

    var byOpen = {};
    for (i = 0; i < ctx.folds.length; i++) {
      var f = ctx.folds[i];
      if (!(f.open in byOpen) || f.close > byOpen[f.open]) byOpen[f.open] = f.close;
    }
    return { html: html, folds: ctx.folds, byOpen: byOpen, plain: false };
  }

  /* ===================== 接口一览 ===================== */
  /* URL 末两段（去掉协议/主机/query/hash）：
   * https://api.x.com/api/v1/users/42?x=1 → users/42 */
  function urlTail(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '(无 URL)';
    var hadScheme = /^[a-zA-Z][\w+.\-]*:\/\//.test(s);
    s = s.replace(/^[a-zA-Z][\w+.\-]*:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    var segs = s.split('/').filter(function (x) { return x !== ''; });
    if (!segs.length) return s || '(无 URL)';
    /* 有协议、或首段是 {{baseUrl}} 这类变量 → 首段是主机，去掉它 */
    if ((hadScheme || /^\{\{/.test(segs[0])) && segs.length > 1) segs.shift();
    return segs.slice(-2).join('/') || s;
  }

  /* 名称：有标题（### 空格后 / # @name）用标题，没有就用 URL 末两段 */
  function reqName(r) {
    /* 展示名优先 ### 标题；只有 # @name 时用它；都没有就取 URL 末两段。
     * @name 仍是跨请求引用的键，两者互不干扰。 */
    var ti = String((r && r.title) || '').trim();
    if (ti) return ti;
    var nm = String((r && r.name) || '').trim();
    if (nm && !r.nameAuto) return nm;
    return urlTail(r && r.url);
  }

  function renderOutline() {
    if (!E.olist) return;
    var reqs = (S.parsed && S.parsed.requests) || [];
    var q = String(S.q || '').trim().toLowerCase();
    var html = [], shown = 0;
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      var nm = reqName(r);
      var hay = (nm + ' ' + r.method + ' ' + r.url).toLowerCase();
      if (q && hay.indexOf(q) < 0) continue;
      shown++;
      var st = S.lastRun[r.line] || '';
      html.push('<button class="pa-fe-oi' + (i === S.activeReq ? ' on' : '') +
        '" data-ri="' + i + '" data-line="' + r.line + '" title="' + esc(r.method + ' ' + r.url) + '">' +
        '<span class="pa-fe-mb t-m-' + String(r.method || 'get').toLowerCase() + '">' + esc(r.method) + '</span>' +
        '<span class="pa-fe-oin">' + esc(nm) + '</span>' +
        '<span class="pa-fe-oif" data-ri="' + i + '" title="在表单里打开">▤</span>' +
        (st ? '<i class="pa-fe-ost ' + st + '"></i>' : '') +
        '</button>');
    }
    if (!shown) {
      E.olist.innerHTML = '<div class="pa-fe-empty">' + (reqs.length
        ? '没有匹配的接口'
        : ((S.path || S.name)
          ? '这个文件里还没有解析到请求<br>（请求行形如 <b>GET https://…</b>）'
          : '打开 .http 文件后，这里列出文件里所有接口')) + '</div>';
    } else {
      E.olist.innerHTML = html.join('');
    }
    if (E.ocount) E.ocount.textContent = String(shown);
  }

  function markActive() {
    if (!E.olist) return;
    var nodes = E.olist.querySelectorAll('.pa-fe-oi');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('on', Number(nodes[i].getAttribute('data-ri')) === S.activeReq);
    }
  }

  /* 光标所在行 → 高亮接口一览里对应的那条 */
  function trackCaret() {
    if (!S.open || !ta) return;
    clearTimeout(trackTimer);
    trackTimer = setTimeout(function () {
      var line = mapCaret().line + 1;
      var reqs = (S.parsed && S.parsed.requests) || [];
      var idx = -1;
      for (var i = 0; i < reqs.length; i++) { if (reqs[i].line <= line) idx = i; else break; }
      if (idx !== S.activeReq) { S.activeReq = idx; markActive(); }
    }, 80);
  }

  /* ===================== 解析 / 状态 ===================== */
  function reparse() {
    if (!H || !ta) return S.parsed;
    ensure();
    buildView();
    var parsed;
    try {
      parsed = H.parseHttpFile(docText(), { fileName: S.name || S.path || '' });
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
    renderOutline();
    trackCaret();
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
    }
    else if (kind === 'conflict') {
      E.saveState.className = 'pa-fe-save conflict';
      E.saveState.textContent = '⚠ 磁盘已被外部修改';
      E.saveState.title = '磁盘上的文件在你打开之后被改过（IDE 保存 / git 切换）。点底部的「覆盖」或「载入」决定保留哪一份。';
      return;   /* 冲突态的 title 自己给，不走下面统一的「磁盘：路径」 */
    }
    else { E.saveState.className = 'pa-fe-save'; E.saveState.textContent = '—'; }
    if (E.saveState) E.saveState.title = S.path ? ('磁盘：' + S.path) : '尚未绑定磁盘路径（保存时会弹出另存为）';
  }

  /* ===================== 磁盘版本基线（S2.2） =====================
   * 内外同时编辑同一个文件是这个插件最常见的误伤场景：IDE 里改了、插件里自动保存又把
   * IDE 的改动盖掉（或反过来）。所以保存前先看 mtime，变了再比对内容，真的不一样就停下来问。 */
  async function markDiskVersion() {
    if (!S.path) { S.mtime = null; return null; }
    try {
      var st = await invoke('http/statFile', { path: S.path });
      S.mtime = st && st.exists ? Math.round(st.modified || 0) : null;
    } catch (e) { S.mtime = null; }   /* 宿主不支持 stat 就退化成「不检测」，不能因此保存不了 */
    return S.mtime;
  }

  /* 磁盘确实变了：返回 true 表示「可以继续写」，false 表示要用户决定 */
  async function diskChanged() {
    if (!S.path || S.mtime == null) return false;
    var st;
    try { st = await invoke('http/statFile', { path: S.path }); } catch (e) { return false; }
    if (!st || !st.exists) { S.mtime = null; return false; }   /* 文件被删了：照旧写，等同于新建 */
    var cur = Math.round(st.modified || 0);
    if (cur === Math.round(S.mtime)) return false;
    var diskText = null;
    try { var rd = await invoke('http/readFile', { path: S.path }); diskText = String((rd && rd.content) || '').replace(/\r\n?/g, '\n'); } catch (e) { }
    if (diskText != null && (diskText === S.loadedText || diskText === docText())) {
      S.mtime = cur;            /* 只是 mtime 变了（touch / 同一内容重写），不算冲突 */
      return false;
    }
    S.conflict = { diskText: diskText, mtime: cur };
    setSaveState('conflict');
    renderConflictHint();
    return true;
  }

  /* 冲突提示条：编辑器底部一行，两个按钮把选择权交还用户，不做隐式覆盖 */
  function renderConflictHint() {
    var box = byId('paFeConflict');
    if (!box) return;
    if (!S.conflict) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span class="pa-fe-cf-msg">磁盘上的文件被外部改过</span>' +
      '<button class="pa-fe-cf-btn primary" data-cf="overwrite">用本地覆盖</button>' +
      '<button class="pa-fe-cf-btn" data-cf="reload">载入磁盘版本</button>';
    var o = box.querySelector('[data-cf="overwrite"]');
    var r = box.querySelector('[data-cf="reload"]');
    if (o) o.onclick = function () { resolveConflict('overwrite'); };
    if (r) r.onclick = function () { resolveConflict('reload'); };
  }

  async function resolveConflict(how) {
    if (!S.conflict) return false;
    if (how === 'reload') {
      var disk = S.conflict.diskText;
      if (disk == null) { toast('读不到磁盘内容，无法载入'); return false; }
      S.conflict = null;
      setDoc(disk);
      S.loadedText = S.text;
      S.dirty = false;
      S.savedAt = Date.now();
      await markDiskVersion();
      reparse();
      setSaveState('ok');
      renderConflictHint();
      setStatus('已载入磁盘版本：' + S.path, 'ok');
      return true;
    }
    /* 覆盖：把基线抬到磁盘当前版本，再走一次正常保存 */
    S.mtime = S.conflict.mtime;
    S.conflict = null;
    renderConflictHint();
    return await doSave(true);
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
      var inp = byId('paFePickInput');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id = 'paFePickInput';
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
      var dir0 = workspaceDir();
      if (!dir0) { toast('没有可用工作目录，无法另存'); return false; }
      try {
        var np = await writeCopy(dir0, ensureHttpExt(pick.name || S.name || 'new.http'), docText());
        await bindPath(np, dir0);
        S.loadedText = S.text; S.conflict = null;
        await markDiskVersion();
        renderConflictHint();
        return afterSave(true);
      } catch (e) { setSaveState('err', e); toast('另存为失败：' + esc(e.message || e)); return false; }
    }
    var path = ensureHttpExt(pick.path);
    try {
      var content = docText();
      var r = await invoke('http/writeFile', { path: path, content: content });
      await bindPath((r && r.path) || path, pick.dir || dirOf(path));
      S.loadedText = content;
      S.conflict = null;
      await markDiskVersion();
      renderConflictHint();
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
    if (E.idle) E.idle.hidden = true;
    S.dirty = false;
    S.savedAt = Date.now();
    savePrefs();
    try { await loadEnvs(S.dir); } catch (e) { }
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
    /* 外部改过就停手：自动保存绝不覆盖别人的改动，手动保存也先让用户选（见 resolveConflict） */
    if (S.conflict) {
      if (manual) { setSaveState('conflict'); renderConflictHint(); }
      return false;
    }
    var content = docText();
    if (await diskChanged()) {
      if (manual) toast('磁盘上的文件已被外部修改：用底部「覆盖 / 载入」决定保留哪一份');
      return false;
    }
    var rev = ++S.rev;
    setSaveState('busy');
    try {
      var r = await invoke('http/writeFile', { path: S.path, content: content });
      if (rev !== S.rev) return false;   /* 保存期间又改过：等下一轮 */
      S.loadedText = content;
      await markDiskVersion();           /* 自己写完，基线跟着抬到新版本 */
      afterSave(manual);
      renderConflictHint();
      if (manual) toast('已保存到 <b>' + esc(S.name || fileNameOf(S.path)) + '</b> ✓（第 ' + S.saveCount + ' 次）');
      savePrefs();
      if (r && r.size >= 0 && E.foot) updateFoot();
      /* 源码改了 = 侧栏的请求列表/名称可能变，顺手让它重扫（同一资源目录） */
      if (window.POLARIS_DOCS && window.POLARIS_DOCS.refresh) {
        clearTimeout(refreshDocsTimer);
        refreshDocsTimer = setTimeout(function () { window.POLARIS_DOCS.refresh(true); }, 400);
      }
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
    /* 折叠状态下 textarea 里是投影，直接写回会丢隐藏行：先展开再改 */
    if (hasFolds()) {
      var c = mapCaret();
      S.folded = {};
      buildView();
      ta.value = viewText();
      var vo = viewOffset(c.line, c.col);
      if (vo != null) { try { ta.setSelectionRange(vo, vo); } catch (e) { } }
    }
    S.text = ta.value;
    S.dirty = true;
    setSaveState('dirty');
    rebuild();                 /* 立刻重绘高亮，打字不闪 */
    trackCaret();
    clearTimeout(parseTimer);
    parseTimer = setTimeout(reparse, 200);
    scheduleSave();
  }

  /* ===================== 双向跳转（S2.3） ===================== */
  /* 同一文件被表单写回后，编辑器里还是旧快照。不脏就重读一次（脏了以编辑器为准，
   * 那是用户正在写的东西，不能替他丢掉）。这跟 S2.2 的保存前比对是一对：一个防覆盖别人，一个防看到旧内容。 */
  async function ensureFresh(path) {
    if (S.dirty || S.mtime == null) return false;
    var cur = null;
    try {
      var st = await invoke('http/statFile', { path: path });
      cur = st && st.exists ? Math.round(st.modified || 0) : null;
    } catch (e) { return false; }
    if (cur == null || cur === Math.round(S.mtime)) return false;
    try { await openPath(path); return true; } catch (e) { return false; }
  }

  /* 表单 → 源码：打开（或复用）这个文件，把浮层张开来，滚到第 line 行并选中。
   * 文件已经打开时不再重读 —— 否则会把这边的未保存改动丢掉。 */
  async function openAt(path, line, opts) {
    opts = opts || {};
    if (!path) return false;
    if (S.path !== path) {
      try { await openPath(path); } catch (e) { toast('打开失败：' + esc(e.message || e)); return false; }
    } else {
      await ensureFresh(path);                  /* 同一文件：表单刚写过就重读，否则看到的是旧 URL */
    }
    open();                                     /* 收起状态也一并张开 */
    var li = line == null ? null : Number(line);
    var ri = null;
    if (li) {
      var reqs = (S.parsed && S.parsed.requests) || [];
      for (var i = 0; i < reqs.length; i++) if (reqs[i].line === li) { ri = i; break; }
    }
    var jump = function () { if (li) gotoLine(li, ri); };
    jump();                                     /* 先跳一次：此时解析已完成，选中立刻生效 */
    setTimeout(jump, 90);                       /* 布局刚张开时高度还没算好，再补一次滚动 */
    setTimeout(function () { if (!opts.keepFocus) return; if (ta) ta.focus(); }, 120);
    setTimeout(function () { if (window.POLARIS_DOCS && window.POLARIS_DOCS.refresh) window.POLARIS_DOCS.refresh(true); }, 300);
    return true;
  }

  /* 源码 → 表单：点请求行左侧的 ▭，按 id / 行号 / 名称 认出那一段，交给 app.js 开成 tab */
  async function openInForm(ri) {
    var reqs = (S.parsed && S.parsed.requests) || [];
    var r = reqs[ri];
    if (!r) return false;
    if (S.dirty) {                              /* 先把源码改动落盘，否则表单读到的是旧内容 */
      var ok = await doSave(false);
      if (!ok && S.conflict) { toast('先把磁盘冲突处理掉，再切表单'); return false; }
      reqs = (S.parsed && S.parsed.requests) || [];
      r = reqs[ri] || r;
    }
    var bridge = window.POLARIS_DOCS;
    if (!bridge || !bridge.openInForm) { toast('表单视图不可用（缺少文件真源桥）'); return false; }
    var done = await bridge.openInForm(S.path, {
      line: r.line, interfaceId: r.interfaceId || null, name: reqName(r), method: r.method
    });
    if (done) collapse(true);                   /* 浮层盖着的正是表单那块，切过去就收起来 */
    return done;
  }

  /* ===================== 打开 / 文件列表 ===================== */
  /* opts.restore：启动时恢复上次文件 —— 只备好内容并挂出右缘箭头，不展开浮层、不扫目录 */
  async function openPath(p, opts) {
    opts = opts || {};
    if (!p) return false;
    try {
      var r = await invoke('http/readFile', { path: p });
      S.path = r.path || p;
      S.dir = r.dir || dirOf(S.path);
      S.name = r.name || '';
      setDoc(r.content || '');
      S.dirty = false;
      S.savedAt = Date.now();
      S.responses = {};
      S.lastRun = {};
      S.reqSig = '';
      S.gutterSig = '';
      if (E.name) E.name.textContent = S.name || '(未命名)';
      if (E.path) { E.path.textContent = S.path; E.path.title = S.path; }
      if (E.idle) E.idle.hidden = true;
      S.saveCount = 0;
      S.loadedText = S.text;
      S.conflict = null;
      S.mtime = null;
      await markDiskVersion();     /* 记下这一版的 mtime，之后保存前拿它比对 */
      await loadEnvs(S.dir);
      reparse();
      setSaveState('ok');
      renderConflictHint();
      savePrefs();
      /* 打开 = 挂载：侧栏只认 wpa-workspace.json，读成功的文件立刻登记进去。
       * 已登记过就是 no-op（registerDocFile 去重），不会打乱现有文件夹与顺序。 */
      try { if (window.POLARIS_DOCS && window.POLARIS_DOCS.register) window.POLARIS_DOCS.register(S.path); } catch (e) { }
      if (opts.restore) {
        /* 恢复：只留右缘入口，不展开、不聚焦。 */
        armEdge();
        return true;
      }
      enterMode();
      if (ta) ta.focus();
      return true;
    } catch (e) {
      if (opts.restore) { S.open = false; S.collapsed = false; if (edge) edge.classList.remove('on'); return false; }
      toast('打开失败：' + esc(e.message || e));
      return false;
    }
  }

  /* 自带示例：**每次启动都保证它挂在侧栏上**，一次都不用用户手动打开。
   * 文件已存在就原样用（绝不覆盖用户改过的内容），只是补一次登记；
   * 不存在才种一份。登记走 POLARIS_DOCS.register —— 与「打开即挂载」同一条路径。 */
  async function ensureDefaultSample() {
    var S0 = window.POLARIS_SAMPLE;
    if (!S0 || !hostOk()) return '';
    var dd = null;
    try { dd = await invoke('http/defaultDirs'); } catch (e) { }
    var dir = String((dd && dd.workDir) || (dd && dd.homeDir) || '').trim();
    if (!dir) return '';
    var target = pathJoin(dir, 'examples.http');
    var mount = function () {
      try { if (window.POLARIS_DOCS && window.POLARIS_DOCS.register) window.POLARIS_DOCS.register(target); } catch (e) { }
    };
    try {
      var r = await invoke('http/readFile', { path: target });
      if (r && typeof r.content === 'string') { mount(); return target; }   /* 已存在：直接用 + 挂上 */
    } catch (e) { /* 不存在才写 */ }
    try {
      var attachPath = pathJoin(dir, S0.attachName || 'sample-upload.txt');
      await invoke('http/writeFile', { path: attachPath, content: S0.attach || '', noClobber: true });
      var text = String(S0.http || '').replace(/__AUDIO_PATH__/g, attachPath);
      await invoke('http/writeFile', { path: target, content: text, noClobber: true });
      /* 侧栏只认映射：种出来的示例也要登记，否则它只在磁盘上、侧栏里看不见。
       * 启动期映射可能还没读出来，register 会排队，等映射就绪后补登记。 */
      mount();
      return target;
    } catch (e) {
      return '';
    }
  }

  /* 载入一份「只有内容、没有路径」的文本（拖入 / 宿主 fileTransfer / 导入）：
   *   1) 侧栏映射里已有同名文件 → 直接打开它，不造第二份；
   *   2) 否则写一份工作目录副本（重名自动加序号，绝不覆盖）；
   *   3) 连工作目录都没有 → 纯内存编辑，保存时弹「另存为」。 */
  async function openContent(name, text, opts) {
    opts = opts || {};
    enterMode();
    if (opts.path) { await openPath(opts.path); return; }

    var hit = matchRegistered(name);
    if (hit) { await openPath(hit); toast('侧栏里已有同名文件，直接打开它：<b>' + esc(fileNameOf(hit)) + '</b>'); return; }

    var dir = workspaceDir();
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
    S.reqSig = '';
    S.gutterSig = '';
    setDoc(String(text || ''));
    if (E.name) E.name.textContent = S.name;
    if (E.path) { E.path.textContent = '(未绑定磁盘 — 点「保存」选择保存位置)'; E.path.title = ''; }
    if (E.idle) E.idle.hidden = true;
    await loadEnvs('');
    reparse();
    setSaveState('dirty');
    toast('已载入 <b>' + esc(S.name) + '</b>（未绑定磁盘，保存时会让你选位置）');
    if (ta) ta.focus();
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
        S.lastRun[req.line] = 'err'; renderGutter(); renderOutline();
        return;
      }
      if (url.charAt(0) === '/') {
        toast('相对 URL 需要 env 里配置 baseUrl（http-client.env.json）');
        S.lastRun[req.line] = 'err'; renderGutter(); renderOutline();
        return;
      }
      url = 'https://' + url;
    }
    if (!url) {
      toast('请求 URL 为空');
      S.lastRun[req.line] = 'err'; renderGutter(); renderOutline();
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
    var body = '', bodyType = req.bodyType || 'text', bodyBase64 = '';
    if (!noBody) {
      if (bodyType === 'multipart' || (req.multipart && (req.multipart.parts || []).length)) {
        /* multipart：按字节拼装，附件以二进制读入。Content-Type 一定跟随实际 body 的 boundary，
         * 这样服务端不会再出现「content-type 没生效」的情况。 */
        try {
          var mp = await buildMultipart(req, rv);
          bodyBase64 = mp.base64;
          bodyType = 'multipart';
          headers['Content-Type'] = mp.contentType;
          /* 同名不同大小写只保留一个 */
          Object.keys(headers).forEach(function (k) {
            if (k !== 'Content-Type' && /^content-type$/i.test(k)) delete headers[k];
          });
        } catch (e) {
          toast('multipart 组装失败：' + esc(e.message || e));
          S.lastRun[req.line] = 'err'; renderGutter(); renderOutline();
          return;
        }
      } else if (req.bodyFromFile) {
        try {
          var fp = pathJoin(S.dir || dirOf(S.path), req.bodyFromFile);
          if (bodyType === 'file') {
            var fb = await invoke('http/readFile', { path: fp, binary: true });
            if (!fb || !fb.base64) throw new Error('没有读到字节');
            bodyBase64 = fb.base64;
            if (!hasHeader(lower, 'content-type')) headers['Content-Type'] = mimeOf(fb.name || req.bodyFromFile);
          } else {
            var f = await invoke('http/readFile', { path: fp });
            body = rv(f.content || '');
            bodyType = (/^\s*[\[{]/.test(body) || /\.json$/i.test(f.name || req.bodyFromFile)) ? 'json' : 'text';
          }
        } catch (e) {
          body = rv(req.body || '');
          bodyBase64 = '';
          toast('外部 body 读取失败，改用内联 body：' + esc(e.message || e));
        }
      } else {
        body = rv(req.body || '');
      }
      if (!bodyBase64) {
        if (bodyType === 'json' && !hasHeader(lower, 'content-type')) headers['Content-Type'] = 'application/json';
        if (bodyType === 'form' && !hasHeader(lower, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    S.lastRun[req.line] = 'busy';
    renderGutter(); renderOutline();
    var resp = null;
    try {
      resp = await window.POLARIS_API.runRaw({
        method: String(req.method || 'GET').toUpperCase(),
        url: url, headers: headers, body: body, bodyType: bodyType,
        bodyBase64: bodyBase64 || '', timeoutMs: 120000
      });
      if (req.name) S.responses[req.name] = resp;
      S.lastRun[req.line] = (resp && resp.error) ? 'err' : (resp.status >= 400 ? 'warn' : 'ok');
    } catch (e) {
      S.lastRun[req.line] = 'err';
      toast('运行失败：' + esc(e.message || e));
    }
    S.gutterSig = '';
    renderGutter(); renderOutline();
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

  /* ===================== 打开 / 拖入 ===================== */
  /* 主入口：只弹系统文件对话框选一个文件（顶栏「▤ 打开 .http」与侧栏「＋ 挂载 .http」都走这里）。
   * v0.6.1：**不先展开浮层** —— 取消就什么都不发生，选中确认后才由 openPath 展开。 */
  async function pickAndOpen() {
    var pick;
    try {
      pick = await pickNative('open');
    } catch (e) {
      toast('打开失败：' + esc(e.message || e));
      return;
    }
    if (!pick) {
      toast('当前环境没有可用的文件选择器：请把文件直接拖进来，或用侧栏底部「＋ 挂载 .http」');
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
        dir: S.dir, autoSave: S.autoSave, activeEnv: S.activeEnv, lastPath: S.path,
        edgeTop: S.edgeTop, feX: Math.round(S.feX), feY: Math.round(S.feY)
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
      if (isFinite(p.edgeTop)) S.edgeTop = Math.max(6, Math.min(94, Number(p.edgeTop)));
      /* S3.1：上次拖到的位置；真正的夹取在布局量出来之后（见 init 里的 reclampFe） */
      if (isFinite(p.feX)) S.feX = Number(p.feX);
      if (isFinite(p.feY)) S.feY = Number(p.feY);
    }
    updateAutoBtn();
    if (!S.dir) {
      try {
        var d = await invoke('http/defaultDirs', {});
        /* workDir = 主目录下的 warren-polaris-api 子目录（拖入/导入副本的落点） */
        S.dir = d.workDir || d.homeDir || '';
      } catch (e) { }
    }
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
    setTimeout(function () { if (S.path && ta) ta.focus(); }, 60);
  }

  /* ===================== 事件绑定 ===================== */
  function bind() {
    E.name = byId('paFeName');
    E.path = byId('paFePath');
    E.saveState = byId('paFeSaveState');
    E.foot = byId('paFeFoot');
    E.env = byId('paFeEnv');
    E.idle = byId('paFeIdle');
    E.auto = byId('paFeAuto');
    E.save = byId('paFeSave');
    E.saveAs = byId('paFeSaveAs');
    var side = byId('paFeSide');

    /* 工具条 */
    E.save.onclick = function () { doSave(true); };    E.saveAs.onclick = function () { saveAs(); };
    byId('paFeRunAll').onclick = function () { runAll(); };
    byId('paFeClose').onclick = function () { collapse(); };

    /* S3.1：标题条拖动浮层（双击复位） */
    bindPaneDrag();

    /* ---- 右缘箭头：单击展开 / 上下拖动挪位置 / 右键彻底关闭 ---- */
    if (edge) {
      var drag = null;
      edge.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var box = document.querySelector('.work');
        if (!box) return;
        var wr = box.getBoundingClientRect();
        var er = edge.getBoundingClientRect();
        drag = {
          y0: e.clientY,
          top0: (er.top + er.height / 2 - wr.top) / wr.height * 100,  /* 箭头中心（%） */
          wr: wr, moved: 0, id: e.pointerId, live: false
        };
        try { edge.setPointerCapture(e.pointerId); } catch (err) { }
        e.preventDefault();
      });
      edge.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dy = e.clientY - drag.y0;
        if (!drag.live && Math.abs(dy) > 3) { drag.live = true; edge.classList.add('dragging'); }
        if (!drag.live) return;
        drag.moved = dy;
        var pct = (drag.top0 / 100 * drag.wr.height + dy) / drag.wr.height * 100;
        pct = Math.max(6, Math.min(94, pct));
        edge.style.top = pct.toFixed(2) + '%';
        S.edgeTop = +pct.toFixed(2);
      });
      var endDrag = function () {
        if (!drag) return;
        var moved = Math.abs(drag.moved), id = drag.id;
        drag = null;
        edge.classList.remove('dragging');
        try { edge.releasePointerCapture(id); } catch (err) { }
        if (moved > 3) savePrefs();   /* 只是挪位置 */
        else expand();                /* 单击 → 展开 */
      };
      edge.addEventListener('pointerup', endDrag);
      edge.addEventListener('pointercancel', endDrag);
      edge.addEventListener('contextmenu', function (e) {
        e.preventDefault(); e.stopPropagation(); exitMode();
      });
      edge.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(); }
      });
    }

    /* 点上方 tab / 点左侧集合条目 → 浮层向右收起（不是关闭，点箭头能原样回来） */
    var tb = byId('tabbar');
    if (tb) tb.addEventListener('pointerdown', function () {
      if (S.open && !S.collapsed) collapse(true);
    }, true);
    var tree = byId('tree');
    if (tree) tree.addEventListener('pointerdown', function (e) {
      var it = e.target && e.target.closest ? e.target.closest('.req-item,.group-head') : null;
      /* 点分组头上的 ✎ / 🗑 / </> 不要先收起浮层：前者是重命名删除，后者正要打开源码 */
      var act = e.target && e.target.closest ? e.target.closest('.gact') : null;
      if (it && !act && S.open && !S.collapsed) collapse(true);
    }, true);
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

    /* 左栏只剩接口一览：收起整栏的按钮挂在它的标题上 */
    /* 左栏只有一个「接口一览」，开关放顶栏：收起后仍要有唯一入口，不能靠看不见的细条 */
    var sideBtn = byId('paFeSideBtn');
    function setSide(on) {
      if (side) side.classList.toggle('collapsed', !on);
      if (sideBtn) sideBtn.classList.toggle('on', !!on);
    }
    if (sideBtn) sideBtn.onclick = function () { setSide(!side || side.classList.contains('collapsed')); };

    /* ---- 接口一览 ---- */
    E.olist = byId('paFeOList');
    E.ocount = byId('paFeOCount');
    E.oq = byId('paFeOq');
    E.edit = byId('paFeEdit');
    if (E.oq) {
      E.oq.addEventListener('input', function () {
        S.q = E.oq.value || '';
        renderOutline();
      });
      E.oq.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { E.oq.value = ''; S.q = ''; renderOutline(); e.stopPropagation(); }
        if (e.key === 'Enter') {
          e.preventDefault();
          var first = E.olist && E.olist.querySelector('.pa-fe-oi');
          if (first) first.click();
        }
      });
    }
    if (E.olist) {
      E.olist.addEventListener('click', function (e) {
        var fi2 = e.target && e.target.closest ? e.target.closest('.pa-fe-oif') : null;
        if (fi2) {                              /* ▭：直接去表单，不再只是滚动 */
          e.preventDefault();
          e.stopPropagation();
          var ifr = Number(fi2.getAttribute('data-ri'));
          if (isFinite(ifr)) openInForm(ifr);
          return;
        }
        var b = e.target && e.target.closest ? e.target.closest('.pa-fe-oi') : null;
        if (!b) return;
        var line = Number(b.getAttribute('data-line'));
        var ri = Number(b.getAttribute('data-ri'));
        if (isFinite(line) && line > 0) gotoLine(line, isFinite(ri) ? ri : null);
      });
    }
    /* 两个区块的折叠/展开 */
    var fHead = byId('paFeFHead'), fWrap = byId('paFeFWrap'), fTog = byId('paFeFToggle');
    if (fTog && fWrap) {
      fTog.onclick = function () {
        var closed = fWrap.classList.toggle('closed');
        if (fHead) fHead.classList.toggle('closed', closed);
      };
    }
    var oTog = byId('paFeOToggle'), oWrap = E.olist && E.olist.parentNode;
    if (oTog && oWrap) {
      oTog.onclick = function () {
        var closed = oWrap.classList.toggle('closed');
        var head = oTog.parentNode;
        if (head && head.classList) head.classList.toggle('closed', closed);
      };
    }

    /* gutter 事件委托：折叠箭头 + 运行按钮 */
    ginner.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var fb = t.closest('.pa-fe-fold');
      if (fb) {
        e.preventDefault();
        e.stopPropagation();
        toggleFold(Number(fb.getAttribute('data-fold')));
        return;
      }
      var fb0 = t.closest('.pa-fe-form');
      if (fb0) {
        e.preventDefault();
        e.stopPropagation();
        var fr = Number(fb0.getAttribute('data-ri'));
        if (isFinite(fr)) openInForm(fr);
        return;
      }
      var b = t.closest('.pa-fe-run');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      var ri = Number(b.getAttribute('data-ri'));
      if (isFinite(ri)) runOne(ri);
    });

    /* 编辑器 */
    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', syncScroll, { passive: true });
    ta.addEventListener('click', trackCaret);
    ta.addEventListener('keyup', trackCaret);
    ta.addEventListener('focus', trackCaret);
    /* 折叠时 textarea 里是投影：任何「会改动文本」的入口都先展开 */
    ta.addEventListener('compositionstart', expandFoldsForEdit);
    ta.addEventListener('paste', expandFoldsForEdit);
    ta.addEventListener('cut', expandFoldsForEdit);
    ta.addEventListener('drop', expandFoldsForEdit);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();     /* 别让 app.js 的全局 Ctrl+S 再存一次请求 tab */
        doSave(true);
        return;
      }
      if (hasFolds()) {
        var k = e.key || '';
        var editKey = (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ||
          k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Tab';
        if (editKey) expandFoldsForEdit();
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
      if (S.open) layoutLayer();   /* layoutLayer 里已带位置重新夹取 */
      syncGutter();
    });

    /* 布局从「上下」切「左右」（或反过来）时，浮层要重新贴合请求区 */
    var lb = byId('layoutBtn');
    if (lb) {
      lb.addEventListener('click', function () {
        if (!S.open) return;
        setTimeout(function () { layoutLayer(); syncGutter(); }, 60);
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
    btn.title = '只弹系统文件对话框（资源管理器）；选中确认后才展开 .http 浮层，取消则不出现';
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
    hlEl = byId('paFeHl');
    bind();
    S.ready = true;

    await DBX.ready;
    var prefs = await loadPrefs();
    renderEnvSel();
    updateFoot();
    if (edge) edge.style.top = S.edgeTop + '%';
    /* S3.1：先把上次的位置贴上；布局尺寸还没量准，稍后再夹一次 */
    applyFePos();
    setTimeout(reclampFe, 320);
    setTimeout(reclampFe, 960);

    /* 恢复上次打开的文件（只挂右缘箭头，不展开浮层）。
     * 示例每次都确保存在（noClobber，改过/删前的都不动）——
     * 这样老用户即使还记着别的文件，默认目录里也有一份能直接跑的例子。
     * 入口优先给上次那个文件；它读不到才退回示例。 */
    var sample = await ensureDefaultSample();
    var restored = false;
    if (prefs && prefs.lastPath && prefs.lastPath !== sample) {
      try { restored = (await openPath(prefs.lastPath, { restore: true })) === true; } catch (e) { }
    }
    if (!restored && sample) {
      try { await openPath(sample, { restore: true }); } catch (e) { }
    }
    /* 启动早期 .work 的尺寸可能还没算好：箭头挂上后再贴一次边 */
    setTimeout(function () { if (S.open && S.collapsed) layoutLayer(); }, 300);
    setTimeout(function () { if (S.open && S.collapsed) layoutLayer(); }, 900);

    /* 暴露给调试 / 其他模块 / 自动化验证 */
    window.POLARIS_EDITOR = {
      open: open,
      close: exitMode,
      state: S,
      openPath: openPath,
      openAt: openAt,             /* S2.3：表单 → 源码，定位到某一行 */
      openInForm: openInForm,     /* S2.3：源码 → 表单，把这一段开成请求 tab */
      openContent: openContent,
      pickAndOpen: pickAndOpen,
      pickNative: pickNative,
      save: function () { return doSave(true); },
      saveAs: saveAs,
      /* v0.5.0：接口一览 / 高亮 / 折叠 的调试与验证入口 */
      outline: renderOutline,
      gotoLine: gotoLine,
      toggleFold: toggleFold,
      reqName: reqName,
      urlTail: urlTail,
      docText: docText,
      viewText: viewText,
      /* v0.6.0：浮层展开 / 收起。isOpen 只代表「浮层当前是否真的盖在界面上」，
       * 收起后为 false —— app.js 的 Ctrl+S / Ctrl+Enter 归属判断据此切换。 */
      isOpen: function () { return S.open && !S.collapsed; },
      isLayerOpen: function () { return S.open; },
      isCollapsed: function () { return !!S.collapsed; },
      collapse: collapse,
      expand: expand,
      /* S3.1：浮层位置（拖动 / 复位），给自动化验证用 */
      pos: function () { return { x: S.feX, y: S.feY }; },
      resetPos: resetFePos,
      ensureSample: ensureDefaultSample
    };

    /* 二次接管：确保晚于 http-workspace.js 的异步 boot 完成绑定 */
    setTimeout(bindTopBtn, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
