/* http-editor.js — .http / .rest 源码编辑器（v0.3.2）
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
 *   · 文件来源：工作目录扫描（sidecar http/listFiles）或本机导入（写入工作目录后绑定磁盘路径）。
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
    prevLayout: null
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
  async function invoke(method, params) {
    if (!hostOk()) throw new Error('未连接 DBX 宿主，文件读写不可用');
    return DBX.invoke(method, params || {});
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
      '.pa-fe-btn.ghost{opacity:.7}',
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
      '  <button class="pa-fe-btn" id="paFeSave" title="立即写入磁盘（Ctrl+S）">保存</button>',
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
      '    <div class="pa-fe-idle" id="paFeIdle"><div style="font-size:13px;font-weight:600;color:var(--dim,#a8acba)">打开本地 .http 文件</div><div>填写工作目录 → 点 ⟳ 扫描 → 左侧选文件；<br>或点 ⇣ 直接从本机导入。</div><div style="font-size:11.5px">打开后可直接编辑，<b>自动保存</b>写回原文件；每个请求左侧 ▶ 一点即发，结果显示在下方响应框。</div></div>',
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
    else if (kind === 'ok') { E.saveState.className = 'pa-fe-save ok'; E.saveState.textContent = '✓ 已保存 ' + hhmmss(); }
    else if (kind === 'err') {
      E.saveState.className = 'pa-fe-save err';
      E.saveState.textContent = '✕ 保存失败' + (info && info.message ? '：' + String(info.message).slice(0, 36) : '');
    } else { E.saveState.className = 'pa-fe-save'; E.saveState.textContent = '—'; }
  }

  /* ===================== 保存 ===================== */
  async function doSave(manual) {
    clearTimeout(saveTimer);
    if (!S.path) {
      if (manual) {
        toast('尚未绑定磁盘路径' + (S.dir ? '，点 ⇣ 重新导入或 ＋ 新建' : '：请先填写工作目录'));
        if (E.dir) E.dir.focus();
      }
      return;
    }
    var content = ta.value;
    var rev = ++S.rev;
    setSaveState('busy');
    try {
      var r = await invoke('http/writeFile', { path: S.path, content: content });
      if (rev !== S.rev) return;           /* 保存期间又改过：等下一轮 */
      S.dirty = false;
      S.savedAt = Date.now();
      setSaveState('ok');
      if (manual) { toast('已保存到 <b>' + esc(S.name || S.path) + '</b> ✓'); setStatus('已保存 ' + S.path, 'ok'); }
      savePrefs();
      if (r && r.size >= 0 && E.foot) updateFoot();
    } catch (e) {
      setSaveState('err', e);
      if (manual) toast('保存失败：' + esc(e.message || e));
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
      await loadEnvs(S.dir);
      reparse();
      setSaveState('ok');
      savePrefs();
      renderFiles(true);
      if (!S.files.length) scan();   /* 恢复上次文件时列表还没扫过：顺手补一次 */
      if (ta) ta.focus();
    } catch (e) {
      toast('打开失败：' + esc(e.message || e));
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
      if (!S.files.length && E.list) E.list.innerHTML = '<div class="pa-fe-empty">该目录下没有 .http / .rest 文件。<br>点 ＋ 新建，或点 ⇣ 导入。</div>';
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

  /* ===================== 新建 / 导入 ===================== */
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

  function importFile() {
    var inp = byId('paFeImportInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'paFeImportInput';
      inp.accept = '.http,.rest,text/plain';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = async function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var text = '';
      try { text = await f.text(); } catch (e) { toast('读取文件失败：' + esc(e.message || e)); return; }
      S.name = f.name;
      ta.value = text;
      ta.scrollTop = 0;
      S.dirty = true;
      S.responses = {};
      S.lastRun = {};
      S.gutterSig = '';
      if (E.name) E.name.textContent = f.name;
      if (E.idle) E.idle.hidden = true;

      var dir = (E.dir && E.dir.value || '').trim();
      if (dir) {
        var p = pathJoin(dir, f.name);
        try {
          await invoke('http/writeFile', { path: p, content: text, backup: true });
          S.path = p; S.dir = dir;
          if (E.path) { E.path.textContent = p; E.path.title = p; }
          S.dirty = false; S.savedAt = Date.now();
          setSaveState('ok');
          await loadEnvs(dir);
          reparse();
          scan();
          toast('已导入并写入 <b>' + esc(f.name) + '</b> ✓');
          return;
        } catch (e) {
          S.path = ''; S.dir = '';
          if (E.path) E.path.textContent = '(写入失败，仅内存编辑)';
          toast('写入失败，仅内存编辑：' + esc(e.message || e));
        }
      } else {
        S.path = ''; S.dir = '';
        if (E.path) E.path.textContent = '(未绑定磁盘 — 填写工作目录后可保存)';
        toast('已导入到编辑器（未绑定磁盘路径）');
      }
      setSaveState('dirty');
      await loadEnvs('');
      reparse();
    };
    inp.click();
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
        S.dir = d.homeDir || '';
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
    var side = byId('paFeSide');

    /* 工具条 */
    byId('paFeSave').onclick = function () { doSave(true); };
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
    byId('paFeImport').onclick = function () { importFile(); };
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

    /* 顶栏「▤ 打开 .http」接管为源码编辑器（覆盖 http-workspace 的绑定） */
    bindTopBtn();
  }

  /* http-workspace.js 的 boot 是 async，绑定时机可能被 await 错开；
   * 单独抽出来并在 boot 末尾再覆盖一次，确保最终由编辑器接管。 */
  function bindTopBtn() {
    var btn = byId('httpFileBtn');
    if (!btn) return;
    btn.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (S.open) exitMode(); else open();
    };
    btn.title = '打开/编辑本地 .http 源码（自动保存 · 逐请求运行）';
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

    /* 暴露给调试 / 其他模块 */
    window.POLARIS_EDITOR = {
      open: open,
      close: exitMode,
      state: S,
      openPath: openPath,
      scan: scan,
      isOpen: function () { return S.open; }
    };

    /* 二次接管：确保晚于 http-workspace.js 的异步 boot 完成绑定 */
    setTimeout(bindTopBtn, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
