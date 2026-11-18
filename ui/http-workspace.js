/* http-workspace.js — .http 工作区：打开本地 .http 文件、载入请求、自动保存与查看请求结果。
 *
 * 依赖：window.POLARIS_HTTP（http-file.js）、window.DBXBridge、window.POLARIS_CORE、
 *        window.POLARIS_API（app.js 导出的最小接口）。
 * 设计原则：不改动 app.js 的 780 行主逻辑，只通过 POLARIS_API 与其交互；
 *           所有 sidecar 调用经 invokeSafe 降级，浏览器 dev 模式仍可解析 / 载入请求。
 *
 * sidecar 方法：http/defaultDirs listFiles readFile readEnvFiles
 *               saveResult listResults getResult deleteResult revealDir
 */
(function () {
  var H = window.POLARIS_HTTP;
  var CORE = window.POLARIS_CORE;
  var DBX = window.DBXBridge;
  var esc = function (s) { return CORE && CORE.esc ? CORE.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var ST_KEY = 'warren-polaris-api.httpws.v1';
  var WS = {
    workDir: '',
    resultsDir: '',
    activeEnv: '',
    envs: {},
    files: [],
    current: null,       // { path, dir, name, content, parsed }
    results: [],
    runtimeResponses: {}, // 请求名 -> 最近一次 resp，供跨请求引用
    ready: false
  };

  /* ---------- 宿主调用（浏览器 dev 模式降级） ---------- */
  function hostAvailable() { return !!(DBX && DBX.readyOk !== false && DBX.plugin); }
  async function invokeSafe(method, params) {
    if (!hostAvailable()) throw new Error('浏览器开发模式：未连接 DBX 宿主，sidecar 方法不可用');
    return DBX.invoke(method, params || {});
  }
  async function storeGet(key) { try { return await DBX.storage.get(key); } catch (e) { return null; } }
  async function storeSet(key, val) { try { return await DBX.storage.set(key, val); } catch (e) { /* ignore */ } }

  /* ---------- 小工具 ---------- */
  function fmtTime(ms) {
    if (!ms) return '-';
    try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(ms); }
  }
  function kB(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function msText(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms'; }
  function pathJoin(dir, rel) {
    rel = String(rel || '').trim();
    if (!rel) return dir;
    if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.charAt(0) === '/' || rel.charAt(0) === '\\') return rel;
    var sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/';
    return String(dir).replace(/[\\/]+$/, '') + sep + rel.replace(/^\.[\\/]/, '');
  }
  function b64ToBlob(b64, ct) {
    try {
      var bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: ct || 'application/octet-stream' });
    } catch (e) { return null; }
  }
  function statusClass(s) { return s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2'; }

  /* 把 sidecar 的原始返回转成 app.js 的 response 结构 */
  function respFromRaw(r, url) {
    var ct = r.contentType || '';
    var isBin = (CORE.BINARY.test(ct) || !!r.isBase64);
    var text = r.body || '';
    var blobUrl = null;
    if (isBin && r.isBase64 && text) {
      var blob = b64ToBlob(text, ct);
      if (blob) blobUrl = URL.createObjectURL(blob);
    }
    var parsed = isBin ? { ok: false } : CORE.tryJSON(text);
    return {
      status: r.status, statusText: r.statusText || '', ok: !!r.ok,
      timeMs: r.timeMs || 0, size: r.size || 0, contentType: ct,
      headers: r.headers || {}, text: text, isBinary: isBin, blobUrl: blobUrl,
      url: url, parsed: parsed.ok ? parsed.value : undefined
    };
  }
  /* response -> 可落盘的普通对象（去掉 blobUrl，parsed 可由 text 重建） */
  function serializableResponse(resp) {
    return {
      status: resp.status, statusText: resp.statusText, ok: resp.ok,
      contentType: resp.contentType, headers: resp.headers || {},
      text: resp.text || '', isBase64: !!resp.isBinary,
      size: resp.size || 0, timeMs: resp.timeMs || 0, url: resp.url
    };
  }
  /* 落盘结果 -> app.js response（历史结果重新打开） */
  function respFromSaved(r) {
    var ct = r.contentType || '';
    var isBin = !!r.isBase64 || (CORE.BINARY.test(ct));
    var text = r.text || '';
    var blobUrl = null;
    if (isBin && text) {
      var blob = b64ToBlob(text, ct);
      if (blob) blobUrl = URL.createObjectURL(blob);
    }
    var parsed = isBin ? { ok: false } : CORE.tryJSON(text);
    return {
      status: r.status, statusText: r.statusText || '', ok: !!r.ok,
      timeMs: r.timeMs || 0, size: r.size || 0, contentType: ct,
      headers: r.headers || {}, text: text, isBinary: isBin, blobUrl: blobUrl,
      url: r.url || '', parsed: parsed.ok ? parsed.value : undefined
    };
  }

  /* ---------- 样式（不侵入 app.css） ---------- */
  function injectCss() {
    var css = [
      '.pa-hws{position:fixed;inset:0;z-index:9000;font-size:13px;color:var(--fg,#e6e7eb)}',
      '.pa-hws[hidden]{display:none}',
      '.pa-hws-mask{position:absolute;inset:0;background:rgba(0,0,0,.5)}',
      '.pa-hws-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(940px,94vw);height:min(660px,88vh);display:flex;flex-direction:column;background:var(--bg-2,#1e1f26);border:1px solid var(--line,#2a2b32);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden}',
      '[data-dbx-theme="light"] .pa-hws-box{background:#fff;color:#222;border-color:#d8d9de;box-shadow:0 16px 48px rgba(0,0,0,.18)}',
      '.pa-hws-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line,#2a2b32);flex:none}',
      '[data-dbx-theme="light"] .pa-hws-head{border-color:#e4e5ea}',
      '.pa-hws-title{font-weight:500;font-size:14px;white-space:nowrap}',
      '.pa-hws-tabs{display:flex;gap:4px;margin-left:8px}',
      '.pa-hws-tabs button,.pa-hws button{font:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--line,#35363e);background:transparent;color:inherit;padding:5px 11px}',
      '.pa-hws-tabs button.on{background:var(--brand,#4c8bf5);border-color:transparent;color:#fff}',
      '.pa-hws button:hover{border-color:var(--brand,#4c8bf5)}',
      '.pa-hws button.primary{background:var(--brand,#4c8bf5);border-color:transparent;color:#fff}',
      '.pa-hws button:disabled{opacity:.45;cursor:default}',
      '.pa-hws-close{margin-left:auto;font-size:17px;line-height:1;padding:2px 9px!important}',
      '.pa-hws-body{flex:1;overflow:auto;padding:14px 16px}',
      '.pa-hws-pane[hidden]{display:none}',
      '.pa-hws-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.pa-hws input[type=text],.pa-hws select{font:inherit;padding:6px 9px;border-radius:6px;border:1px solid var(--line,#35363e);background:var(--bg-1,#17181d);color:inherit;min-width:0}',
      '[data-dbx-theme="light"] .pa-hws input[type=text],[data-dbx-theme="light"] .pa-hws select{background:#fafbfc;border-color:#d8d9de;color:#222}',
      '.pa-hws .grow{flex:1;min-width:180px}',
      '.pa-hws label.lbl{color:var(--dim,#9a9ba3);white-space:nowrap;font-size:12px}',
      '.pa-hws h4{margin:14px 0 8px;font-size:13px;font-weight:500;color:var(--dim,#9a9ba3)}',
      '.pa-hws-list{border:1px solid var(--line,#2a2b32);border-radius:8px;overflow:auto;max-height:330px}',
      '[data-dbx-theme="light"] .pa-hws-list{border-color:#e4e5ea}',
      '.pa-hws-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-bottom:1px solid var(--line,#2a2b32)}',
      '.pa-hws-item:last-child{border-bottom:0}',
      '[data-dbx-theme="light"] .pa-hws-item{border-color:#eef0f3}',
      '.pa-hws-item:hover{background:rgba(127,127,127,.08)}',
      '.pa-hws-item .name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-hws-item .url{color:var(--dim,#9a9ba3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px}',
      '.pa-hws-item .m{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(76,139,245,.16);color:var(--brand,#4c8bf5);flex:none}',
      '.pa-hws-item .st{font-size:11px;padding:1px 7px;border-radius:4px;flex:none}',
      '.pa-hws-item .st.s2{background:rgba(61,181,112,.16);color:#3db570}',
      '.pa-hws-item .st.s3{background:rgba(230,170,60,.16);color:#e0aa3c}',
      '.pa-hws-item .st.s4,.pa-hws-item .st.s5{background:rgba(230,90,90,.16);color:#e05a5a}',
      '.pa-hws-empty{padding:26px;text-align:center;color:var(--dim,#9a9ba3);line-height:1.8}',
      '.pa-hws-warn{margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(230,170,60,.10);color:#d39a2c;font-size:12px;line-height:1.7;max-height:110px;overflow:auto}',
      '.pa-hws-foot{flex:none;padding:8px 16px;border-top:1px solid var(--line,#2a2b32);font-size:12px;color:var(--dim,#9a9ba3);display:flex;gap:10px;align-items:center}',
      '[data-dbx-theme="light"] .pa-hws-foot{border-color:#e4e5ea}',
      '.pa-hws-foot .msg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-hws-foot .msg.ok{color:#3db570}',
      '.pa-hws-foot .msg.err{color:#e05a5a}'
    ].join('\n');
    var st = document.createElement('style');
    st.setAttribute('data-pa-hws', '1');
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 面板骨架 ---------- */
  function buildPanel() {
    var root = document.getElementById('root') || document.body;
    var wrap = document.createElement('div');
    wrap.className = 'pa-hws';
    wrap.id = 'paHttpPanel';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="pa-hws-mask"></div>' +
      '<div class="pa-hws-box">' +
      '  <div class="pa-hws-head">' +
      '    <span class="pa-hws-title">.http 工作区</span>' +
      '    <div class="pa-hws-tabs"><button data-tab="files" class="on">.http 文件</button><button data-tab="history">历史结果</button></div>' +
      '    <button class="pa-hws-close" title="关闭">×</button>' +
      '  </div>' +
      '  <div class="pa-hws-body">' +
      '    <div class="pa-hws-pane" data-pane="files">' +
      '      <div class="pa-hws-row"><label class="lbl">文件目录</label><input type="text" id="paHwsDir" class="grow" placeholder="本地目录，例如 D:\\workspace\\api" /><button id="paHwsScan">扫描</button><button id="paHwsPick">选择 .http 文件…</button></div>' +
      '      <div class="pa-hws-row"><label class="lbl">结果目录</label><input type="text" id="paHwsResultsDir" class="grow" placeholder="自动保存到本机" /><button id="paHwsReveal">打开目录</button></div>' +
      '      <div class="pa-hws-row"><label class="lbl">环境</label><select id="paHwsEnv"><option value="">（无环境文件）</option></select>' +
      '        <span class="lbl" id="paHwsEnvHint"></span></div>' +
      '      <h4>扫描到的 .http / .rest 文件</h4>' +
      '      <div class="pa-hws-list" id="paHwsFiles"><div class="pa-hws-empty">设置目录后点「扫描」，或直接「选择 .http 文件」。</div></div>' +
      '      <h4>当前文件的请求 <span id="paHwsReqCount" class="lbl"></span></h4>' +
      '      <div class="pa-hws-row"><button id="paHwsLoadAll" class="primary">全部载入为 tab</button><button id="paHwsRunAll">运行全部（顺序执行）</button></div>' +
      '      <div class="pa-hws-list" id="paHwsReqs"><div class="pa-hws-empty">尚未打开文件。</div></div>' +
      '      <div class="pa-hws-warn" id="paHwsWarn" hidden></div>' +
      '    </div>' +
      '    <div class="pa-hws-pane" data-pane="history" hidden>' +
      '      <div class="pa-hws-row"><button id="paHwsRefresh" class="primary">刷新</button><button id="paHwsReveal2">打开结果目录</button><span class="lbl">每次「发送」或「运行全部」后自动写入本地</span></div>' +
      '      <div class="pa-hws-list" id="paHwsResults"><div class="pa-hws-empty">还没有保存的结果。</div></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="pa-hws-foot"><span class="msg" id="paHwsStatus">就绪</span></div>' +
      '</div>' +
      '<input type="file" id="paHwsFileInput" accept=".http,.rest,text/plain" style="display:none" />';
    root.appendChild(wrap);
    return wrap;
  }

  /* ---------- 面板操作 ---------- */
  var panel = null;
  function $p(sel) { return panel ? panel.querySelector(sel) : null; }
  function setStatus(msg, kind) {
    var e = $p('#paHwsStatus');
    if (!e) return;
    e.textContent = msg;
    e.className = 'msg' + (kind ? ' ' + kind : '');
    if (window.POLARIS_CORE && CORE.setStatus && kind !== 'err') CORE.setStatus(msg, kind || '');
  }
  function show(tab) {
    if (!panel) return;
    panel.hidden = false;
    switchTab(tab || 'files');
    if (tab === 'history') refreshHistory();
  }
  function hide() { if (panel) panel.hidden = true; }
  function switchTab(tab) {
    if (!panel) return;
    panel.querySelectorAll('.pa-hws-tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    panel.querySelectorAll('.pa-hws-pane').forEach(function (p) { p.hidden = p.dataset.pane !== tab; });
  }

  function bind() {
    if (!panel) return;
    $p('.pa-hws-mask').onclick = hide;
    $p('.pa-hws-close').onclick = hide;
    panel.querySelectorAll('.pa-hws-tabs button').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); if (b.dataset.tab === 'history') refreshHistory(); };
    });
    $p('#paHwsScan').onclick = scan;
    $p('#paHwsPick').onclick = function () { $p('#paHwsFileInput').click(); };
    $p('#paHwsFileInput').onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { openByContent(f.name, String(rd.result || ''), WS.workDir); };
      rd.readAsText(f);
      e.target.value = '';
    };
    $p('#paHwsReveal').onclick = revealDir;
    $p('#paHwsReveal2').onclick = revealDir;
    $p('#paHwsResultsDir').onchange = async function () {
      WS.resultsDir = this.value.trim();
      await persistWs();
      await refreshHistory();
    };
    $p('#paHwsDir').onchange = async function () {
      WS.workDir = this.value.trim();
      await persistWs();
    };
    $p('#paHwsEnv').onchange = async function () {
      WS.activeEnv = this.value;
      await persistWs();
      renderReqs();
    };
    $p('#paHwsLoadAll').onclick = loadAll;
    $p('#paHwsRunAll').onclick = runAll;
    $p('#paHwsRefresh').onclick = refreshHistory;

    var b1 = document.getElementById('httpFileBtn');
    var b2 = document.getElementById('httpHistoryBtn');
    if (b1) b1.onclick = function () { show('files'); };
    if (b2) b2.onclick = function () { show('history'); };
  }

  async function persistWs() {
    await storeSet(ST_KEY, {
      workDir: WS.workDir, resultsDir: WS.resultsDir, activeEnv: WS.activeEnv
    });
  }
  async function loadWs() {
    var snap = await storeGet(ST_KEY);
    if (snap && typeof snap === 'object') {
      WS.workDir = snap.workDir || '';
      WS.resultsDir = snap.resultsDir || '';
      WS.activeEnv = snap.activeEnv || '';
    }
  }

  /* ---------- 目录 / 文件 ---------- */
  async function scan() {
    var dir = ($p('#paHwsDir') && $p('#paHwsDir').value.trim()) || WS.workDir;
    WS.workDir = dir;
    if (!hostAvailable()) { setStatus('浏览器开发模式不支持目录扫描，请用「选择 .http 文件」', 'err'); return; }
    try {
      var r = await invokeSafe('http/listFiles', { dir: dir, recursive: true });
      WS.files = r.files || [];
      WS.workDir = r.dir || dir;
      if ($p('#paHwsDir')) $p('#paHwsDir').value = WS.workDir;
      await loadEnvs(WS.workDir);
      renderFiles();
      await persistWs();
      setStatus('扫描到 ' + WS.files.length + ' 个 .http 文件', 'ok');
    } catch (e) { setStatus('扫描失败：' + e.message, 'err'); }
  }

  function renderFiles() {
    var box = $p('#paHwsFiles');
    if (!box) return;
    if (!WS.files.length) {
      box.innerHTML = '<div class="pa-hws-empty">该目录下没有 .http / .rest 文件。<br>换个目录，或直接「选择 .http 文件」。</div>';
      return;
    }
    box.innerHTML = '';
    WS.files.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'pa-hws-item';
      row.innerHTML = '<span class="name">' + esc(f.name) + '</span><span class="url">' + esc(f.path) + '</span><span class="lbl">' + kB(f.size) + '</span>';
      var btn = document.createElement('button');
      btn.textContent = '打开';
      btn.onclick = function () { openByPath(f.path); };
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  async function loadEnvs(dir) {
    WS.envs = {};
    if (!hostAvailable() || !dir) { renderEnvSelect(); return; }
    try {
      var r = await invokeSafe('http/readEnvFiles', { dir: dir });
      WS.envs = H.mergeEnvFiles(r.public, r.private);
      renderEnvSelect();
      var names = Object.keys(WS.envs);
      var hint = $p('#paHwsEnvHint');
      if (hint) hint.textContent = names.length ? '已载入 http-client.env.json：' + names.join(' / ') : '该目录无 http-client.env.json';
    } catch (e) {
      renderEnvSelect();
      var h = $p('#paHwsEnvHint');
      if (h) h.textContent = '环境文件读取失败：' + e.message;
    }
  }

  function renderEnvSelect() {
    var sel = $p('#paHwsEnv');
    if (!sel) return;
    var names = Object.keys(WS.envs || {});
    sel.innerHTML = '<option value="">（默认 / 无环境）</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    if (names.length && names.indexOf(WS.activeEnv) < 0) WS.activeEnv = names[0];
    sel.value = WS.activeEnv || '';
  }

  async function openByPath(path) {
    try {
      var r = await invokeSafe('http/readFile', { path: path });
      WS.workDir = r.dir || WS.workDir;
      if ($p('#paHwsDir')) $p('#paHwsDir').value = WS.workDir;
      await loadEnvs(WS.workDir);
      applyContent(r.name, r.content, r.path);
      await persistWs();
      setStatus('已打开 ' + r.name + '，解析出 ' + WS.current.parsed.requests.length + ' 个请求', 'ok');
    } catch (e) { setStatus('打开文件失败：' + e.message, 'err'); }
  }

  function openByContent(name, content, dir) {
    WS.workDir = dir || WS.workDir;
    applyContent(name, content, '');
    if (hostAvailable() && WS.workDir) loadEnvs(WS.workDir);
    setStatus('已导入 ' + name + '（无本地路径，< 文件引用不可用）', 'ok');
  }

  function applyContent(name, content, path) {
    var parsed = H.parseHttpFile(content, { fileName: path || name });
    WS.current = { path: path, dir: WS.workDir, name: name, content: content, parsed: parsed };
    var warn = $p('#paHwsWarn');
    if (warn) {
      if (parsed.warnings && parsed.warnings.length) {
        warn.hidden = false;
        warn.innerHTML = '兼容提示：<br>· ' + parsed.warnings.map(esc).join('<br>· ');
      } else warn.hidden = true;
    }
    renderReqs();
  }

  function renderReqs() {
    var box = $p('#paHwsReqs');
    var cnt = $p('#paHwsReqCount');
    if (!box) return;
    var reqs = WS.current ? WS.current.parsed.requests : [];
    if (cnt) cnt.textContent = reqs.length ? '(' + reqs.length + ')' : '';
    if (!reqs.length) { box.innerHTML = '<div class="pa-hws-empty">尚未打开文件。</div>'; return; }
    box.innerHTML = '';
    reqs.forEach(function (req) {
      var row = document.createElement('div');
      row.className = 'pa-hws-item';
      row.innerHTML = '<span class="m">' + esc(req.method) + '</span><span class="name">' + esc(req.name) + '</span><span class="url">' + esc(req.url) + '</span>';
      if (req.postScript) {
        var tag = document.createElement('span');
        tag.className = 'lbl'; tag.textContent = '含脚本';
        row.appendChild(tag);
      }
      var b1 = document.createElement('button');
      b1.textContent = '载入';
      b1.onclick = function () { loadReq(req); };
      row.appendChild(b1);
      var b2 = document.createElement('button');
      b2.textContent = '运行';
      b2.onclick = function () { runOneFromPanel(req); };
      row.appendChild(b2);
      box.appendChild(row);
    });
  }

  /* ---------- 变量上下文 ---------- */
  function buildCtx() {
    var p = WS.current;
    return {
      vars: p ? Object.assign({}, p.parsed.variables || {}) : {},
      envs: WS.envs || {},
      activeEnv: WS.activeEnv || '',
      responses: Object.assign({}, WS.runtimeResponses || {})
    };
  }

  function api() { return window.POLARIS_API; }

  async function buildSeed(req, ctx) {
    var A = api();
    var seed = H.toTab(req, {
      uid: A ? A.uid : function () { return 'r' + Math.random().toString(36).slice(2); },
      blankRow: A ? A.blankRow : function () { return { id: 'b', on: true, k: '', v: '' }; },
      resolveText: function (s) { return H.resolveVars(s, ctx); }
    });
    if (req.bodyFromFile && hostAvailable() && WS.current.dir) {
      try {
        var fp = pathJoin(WS.current.dir, req.bodyFromFile);
        var f = await invokeSafe('http/readFile', { path: fp });
        seed.body = H.resolveVars(f.content, ctx);
        seed.bodyType = /^\s*[\[{]/.test(f.content) ? 'json' : 'text';
      } catch (e) { setStatus('读取 < 引用文件失败：' + e.message, 'err'); }
    }
    return seed;
  }

  async function loadReq(req) {
    var A = api();
    if (!A) { setStatus('app.js 尚未就绪', 'err'); return; }
    var seed = await buildSeed(req, buildCtx());
    A.addTab(seed);
    hide();
    setStatus('已载入「' + req.name + '」到新 tab', 'ok');
  }

  async function loadAll() {
    var A = api();
    if (!A || !WS.current) return;
    var ctx = buildCtx();
    var reqs = WS.current.parsed.requests;
    for (var i = 0; i < reqs.length; i++) {
      A.addTab(await buildSeed(reqs[i], ctx));
    }
    hide();
    setStatus('已载入 ' + reqs.length + ' 个请求为 tab', 'ok');
  }

  /* ---------- 执行 ---------- */
  function seedToCall(seed) {
    var url = seed.url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(url)) url = 'https://' + url;
    var headers = {};
    (seed.headers || []).forEach(function (r) { if (r.on && r.k) headers[r.k] = r.v; });
    var body = '';
    if (!['GET', 'HEAD'].includes(seed.method)) {
      if (seed.bodyType === 'json' || seed.bodyType === 'text') body = seed.body || '';
      else if (seed.bodyType === 'form') {
        // .http 里的表单体通常直接写在 body 里（a=1&b=2），优先使用；
        // 只有手动编辑器的 formBody 行才需要拼接。
        body = seed.body || (seed.formBody || []).filter(function (r) { return r.on && r.k; }).map(function (r) { return encodeURIComponent(r.k) + '=' + encodeURIComponent(r.v); }).join('&');
      }
    }
    return { method: seed.method, url: url, headers: headers, body: body, bodyType: seed.bodyType, timeoutMs: 120000 };
  }

  async function saveResult(request, response) {
    if (!hostAvailable()) return null;
    try {
      var r = await invokeSafe('http/saveResult', {
        resultsDir: WS.resultsDir || undefined,
        entry: { request: request, response: response }
      });
      return r;
    } catch (e) { setStatus('结果保存失败：' + e.message, 'err'); return null; }
  }

  function requestFromCall(call, req) {
    return {
      name: req ? req.name : (call.method + ' ' + call.url).slice(0, 60),
      method: call.method, url: call.url, headers: call.headers || {},
      body: call.body || '', bodyType: call.bodyType || 'none',
      sourceFile: (WS.current && WS.current.path) || ''
    };
  }

  async function runOneFromPanel(req) {
    try {
      var call = seedToCall(await buildSeed(req, buildCtx()));
      var raw = await invokeSafe('http/request', call);
      var resp = respFromRaw(raw, call.url);
      await saveResult(requestFromCall(call, req), serializableResponse(resp));
      WS.runtimeResponses[req.name] = resp;
      var A = api();
      if (A) A.showResponse(resp);
      hide();
      await refreshHistory();
      setStatus(req.name + ' → ' + resp.status + ' · ' + msText(resp.timeMs) + '，结果已保存', 'ok');
    } catch (e) { setStatus('运行失败：' + e.message, 'err'); }
  }

  async function runAll() {
    if (!WS.current || !WS.current.parsed.requests.length) return;
    if (!hostAvailable()) { setStatus('运行全部需要 DBX 宿主（sidecar）', 'err'); return; }
    var ctx = buildCtx();
    var reqs = WS.current.parsed.requests;
    var done = 0;
    setStatus('开始顺序运行 ' + reqs.length + ' 个请求…');
    for (var i = 0; i < reqs.length; i++) {
      var req = reqs[i];
      try {
        var seed = await buildSeed(req, ctx);
        var call = seedToCall(seed);
        var raw = await invokeSafe('http/request', call);
        var resp = respFromRaw(raw, call.url);
        ctx.responses[req.name] = resp;
        WS.runtimeResponses[req.name] = resp;
        await saveResult(requestFromCall(call, req), serializableResponse(resp));
        done += 1;
        setStatus('(' + done + '/' + reqs.length + ') ' + req.name + ' → ' + resp.status);
      } catch (e) {
        setStatus('(' + (i + 1) + '/' + reqs.length + ') ' + req.name + ' 失败：' + e.message, 'err');
      }
    }
    await refreshHistory();
    var A = api();
    if (A) {
      var last = reqs.length ? ctx.responses[reqs[reqs.length - 1].name] : null;
      if (last) A.showResponse(last);
    }
    setStatus('运行完成：' + done + '/' + reqs.length + '，结果已自动保存', 'ok');
  }

  /* ---------- 历史结果 ---------- */

  /* 把历史结果里每个请求名最近一次的响应载入运行时上下文，
   * 使单条「载入 / 运行」也能解析 {{login.response.body.$.token}}。 */
  function respLite(r) {
    var text = (r && r.text) ? r.text : '';
    var parsed = (r && r.isBase64) ? { ok: false } : CORE.tryJSON(text);
    return {
      status: r ? r.status : 0, headers: (r && r.headers) || {}, text: text,
      parsed: parsed.ok ? parsed.value : undefined
    };
  }
  async function hydrateRuntimeResponses() {
    if (!hostAvailable()) return;
    var seen = {}, count = 0;
    for (var i = 0; i < WS.results.length && count < 30; i++) {
      var it = WS.results[i];
      var key = it.name || it.id;
      if (!key || seen[key]) continue;
      seen[key] = 1; count += 1;
      try {
        var r = await invokeSafe('http/getResult', { path: it.path });
        var e = r.entry || {};
        if (e.request && e.request.name && e.response) WS.runtimeResponses[e.request.name] = respLite(e.response);
      } catch (e2) { /* 忽略损坏的历史文件 */ }
    }
  }

  async function refreshHistory() {
    try {
      var r = await invokeSafe('http/listResults', { resultsDir: WS.resultsDir || undefined });
      WS.results = r.items || [];
      if (r.dir && !WS.resultsDir) WS.resultsDir = r.dir;
      if ($p('#paHwsResultsDir') && !$p('#paHwsResultsDir').value) $p('#paHwsResultsDir').value = WS.resultsDir;
      renderResults();
      hydrateRuntimeResponses();
      return r;
    } catch (e) {
      var box = $p('#paHwsResults');
      if (box) box.innerHTML = '<div class="pa-hws-empty">' + esc(e.message) + '</div>';
      return null;
    }
  }

  function renderResults() {
    var box = $p('#paHwsResults');
    if (!box) return;
    if (!WS.results.length) { box.innerHTML = '<div class="pa-hws-empty">还没有保存的结果。<br>点「发送」或「运行全部」后会自动写入本地。</div>'; return; }
    box.innerHTML = '';
    WS.results.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'pa-hws-item';
      row.innerHTML = '<span class="st ' + statusClass(it.status) + '">' + esc(it.status || '-') + '</span>' +
        '<span class="m">' + esc(it.method || '') + '</span>' +
        '<span class="name">' + esc(it.name || '未命名') + '</span>' +
        '<span class="url">' + esc(fmtTime(it.savedAt)) + ' · ' + esc(msText(it.timeMs)) + ' · ' + esc(kB(it.size)) + '</span>';
      var open = document.createElement('button');
      open.textContent = '打开';
      open.className = 'primary';
      open.onclick = function () { openResult(it.path); };
      row.appendChild(open);
      var del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = function () { delResult(it.path); };
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  async function openResult(path) {
    try {
      var r = await invokeSafe('http/getResult', { path: path });
      var entry = r.entry || {};
      var resp = respFromSaved(entry.response || {});
      var A = api();
      if (!A) { setStatus('app.js 尚未就绪', 'err'); return; }
      A.showResponse(resp);
      hide();
      setStatus('已在响应区打开历史结果：' + (entry.request ? entry.request.name : ''), 'ok');
    } catch (e) { setStatus('打开结果失败：' + e.message, 'err'); }
  }

  async function delResult(path) {
    try {
      await invokeSafe('http/deleteResult', { path: path });
      await refreshHistory();
      setStatus('已删除结果', 'ok');
    } catch (e) { setStatus('删除失败：' + e.message, 'err'); }
  }

  async function revealDir() {
    try {
      await invokeSafe('http/revealDir', { resultsDir: WS.resultsDir || undefined });
      setStatus('已在文件管理器中打开结果目录', 'ok');
    } catch (e) { setStatus('打开目录失败：' + e.message, 'err'); }
  }

  /* ---------- app.js 的响应钩子：每次「发送」自动落盘 ---------- */
  async function onResponse(t, resp, info) {
    if (!resp || resp.error) return;
    var request = {
      name: t.name || '未命名请求',
      method: (info && info.method) || t.method,
      url: (info && info.url) || t.url,
      headers: (info && info.headers) || {},
      body: (info && info.body) || '',
      bodyType: t.bodyType || 'none',
      sourceFile: (t.httpSource && t.httpSource.file) || ''
    };
    var saved = await saveResult(request, serializableResponse(resp));
    if (saved && resp.url) {
      WS.runtimeResponses[request.name] = resp;
      if (panel && !panel.hidden) refreshHistory();
    }
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    injectCss();
    panel = buildPanel();
    bind();
    window.POLARIS_HTTP_WS = { onResponse: onResponse, show: show, state: WS };
    if (DBX && DBX.ready) await DBX.ready;
    await loadWs();
    if (hostAvailable()) {
      try {
        var d = await invokeSafe('http/defaultDirs', {});
        if (!WS.resultsDir) WS.resultsDir = d.resultsDir || '';
        if (!WS.workDir) WS.workDir = d.homeDir || '';
      } catch (e) { /* 保留已有配置 */ }
    }
    if ($p('#paHwsDir')) $p('#paHwsDir').value = WS.workDir;
    if ($p('#paHwsResultsDir')) $p('#paHwsResultsDir').value = WS.resultsDir;
    renderEnvSelect();
    WS.ready = true;
    if (hostAvailable()) refreshHistory();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
