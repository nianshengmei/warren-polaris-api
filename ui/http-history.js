/* http-history.js — 调用历史：先落身份，再落一行 jsonl。
 *
 * 这一版（S4.2）只做两件事：
 *   1. record() 的两步走 —— 先把 # @file_id / # @interface_id 写进 .http 并等写盘成功，
 *      **再**把这一条调用追加进 `_history/<collection>/<interfaceId>.jsonl`；
 *   2. 写身份失败（只读 / 冲突重试 2 次仍失败 / 段找不到）就**不写历史**，
 *      把原因回给调用方去提示 —— 历史里绝不能出现"文件里没有的 id"。
 *
 * 轮转、读取、二进制外置、.gitignore 属 S4.3，这里先留最简单的追加实现。
 *
 * 依赖注入：store 由调用方给（浏览器里是 POLARIS_DOCS.store，Node 里是 createStore(fsHost)），
 * 目录 dir 也由调用方给，所以本文件不读宿主、不碰 DOM，可以直接 require 做单测。
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  var HISTORY_DIR = '_history';
  var MAX_RETRY = 2;                 /* 冲突后最多再试 2 次（共 3 次写） */

  function requireFile() {
    if (root.POLARIS_HTTP) return root.POLARIS_HTTP;
    if (typeof require === 'function') return require('./http-file.js');
    throw new Error('http-file.js 未加载');
  }
  function requireIdentity() {
    if (root.POLARIS_IDENTITY) return root.POLARIS_IDENTITY;
    if (typeof require === 'function') return require('./http-identity.js');
    throw new Error('http-identity.js 未加载');
  }
  function requireStore() {
    if (root.POLARIS_STORE) return root.POLARIS_STORE;
    if (typeof require === 'function') return require('./http-store.js');
    throw new Error('http-store.js 未加载');
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* 文件名 → collection 名（去掉 .http / .rest 后缀） */
  function collectionName(path) {
    var s = String(path || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (i >= 0 ? s.slice(i + 1) : s).replace(/\.(http|rest)$/i, '') || 'collection';
  }

  /* `_history/<collection>/<interfaceId>.jsonl`（绝对路径由 dir 拼出来） */
  function historyPath(dir, filePath, interfaceId) {
    var S = requireStore();
    var base = S.joinPath(S.joinPath(dir, HISTORY_DIR), S.sanitizeName(collectionName(filePath)));
    return S.joinPath(base, String(interfaceId || 'unknown') + '.jsonl');
  }

  /* 读一个 .http 的当前磁盘状态。读不到就抛，交给 record 变成 NOT_FOUND。 */
  async function readDoc(store, path) {
    var H = requireFile();
    var rd = await store.host.read(path);
    var st = await store.host.stat(path);
    var text = String(rd && rd.content != null ? rd.content : '');
    var name = String(path).split(/[\\/]/).pop();
    return {
      text: text,
      mtime: Math.round((st && st.modified) || 0),
      parsed: H.parseHttpFile(text, { fileName: name })
    };
  }

  /* 追加一行。目录由调用方先 ensureDir；文件不存在就当空文件。 */
  async function appendLine(store, path, line) {
    var prev = '';
    try {
      var rd = await store.host.read(path);
      prev = String((rd && rd.content) || '');
    } catch (e) { prev = ''; }
    if (prev && prev.charAt(prev.length - 1) !== '\n') prev += '\n';
    var next = prev + line;
    var w = await store.writeText(path, next, {});
    if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
    var n = 0;
    for (var i = 0; i < next.length; i++) if (next.charCodeAt(i) === 10) n++;
    return { ok: true, lines: n };
  }

  /* 历史条目。字段名就是将来读出来给人看的名字，别缩写。 */
  function entryFor(o) {
    var I = requireIdentity();
    var resp = o.response || {};
    var tpl = String(o.urlTemplate != null ? o.urlTemplate : (o.url || ''));
    return {
      at: num(o.at) || Date.now(),
      status: num(resp.status),
      ok: !!resp.ok,
      timeMs: num(resp.timeMs),
      size: num(resp.size),
      method: String(o.method || 'GET').toUpperCase(),
      url: String(o.url || tpl),
      urlTemplate: tpl,
      fingerprint: I.fingerprint({ method: o.method, url: tpl }),
      interfaceId: o.interfaceId || null,
      fileId: o.fileId || null,
      file: String(o.file || ''),
      name: String(o.name || '')
    };
  }

  function createHistory(opts) {
    opts = opts || {};

    async function record(input) {
      input = input || {};
      var store = input.store || opts.store;
      var dir = input.dir || opts.dir;
      var path = input.path;
      if (!store || !dir || !path) return { ok: false, reason: 'NOT_FILE' };

      var H = requireFile(), I = requireIdentity(), S = requireStore();
      var req = input.req || {};
      var resp = input.response || {};
      var attempt = 0;

      while (attempt <= MAX_RETRY) {
        var cur;
        try { cur = await readDoc(store, path); }
        catch (e) { return { ok: false, reason: 'NOT_FOUND' }; }

        /* 先定位段（用磁盘上的原始行号），再插 file_id —— 反过来的话行号已经漂了 */
        var idx = S.locateSegment(cur.parsed, req);
        if (idx < 0) return { ok: false, reason: 'NO_SEGMENT' };

        var f = I.insertFileId(cur.text);
        var parsed2 = f.changed ? H.parseHttpFile(f.text, { fileName: String(path).split(/[\\/]/).pop() }) : cur.parsed;
        var target = parsed2.requests[idx];
        if (!target) return { ok: false, reason: 'NO_SEGMENT' };

        var i2 = I.insertInterfaceId(f.text, { line: target.line }, target.interfaceId || undefined);
        var next = i2.text;
        var ifaceId = i2.id || target.interfaceId || null;
        var fileId = f.id || parsed2.fileId || null;
        var changed = next !== cur.text;
        var mtime = cur.mtime;

        if (changed) {
          var w = await store.writeText(path, next, { baseMtime: cur.mtime });
          if (!w || !w.ok) {
            var why = (w && w.reason) || 'WRITE_FAILED';
            if (why === 'READONLY') return { ok: false, reason: 'READONLY', wrote: false };
            if (why === 'CONFLICT' && attempt < MAX_RETRY) { attempt++; continue; }
            return { ok: false, reason: why, wrote: false };
          }
          try {
            var st2 = await store.host.stat(path);
            mtime = Math.round((st2 && st2.modified) || 0);
          } catch (e) { /* 拿不到 mtime 不影响记历史 */ }
        }

        /* ---- 到这一步身份已经在磁盘上了（或本来就有），才开始写历史 ---- */
        if (!ifaceId) return { ok: false, reason: 'NO_ID' };

        var entry = entryFor({
          at: input.now,
          response: resp,
          method: req.method || target.method,
          url: input.url || req.url || target.url,
          urlTemplate: req.url || target.url,
          interfaceId: ifaceId,
          fileId: fileId,
          file: String(path).split(/[\\/]/).pop(),
          name: req.name || target.name
        });
        var hp = historyPath(dir, path, ifaceId);
        try { await store.host.ensureDir(S.dirName(hp)); } catch (e) { /* 写的时候还会再失败一次，由 append 报 */ }
        var app = await appendLine(store, hp, JSON.stringify(entry) + '\n');

        return {
          ok: true,
          changed: changed,
          text: next,
          mtime: mtime,
          fileId: fileId,
          interfaceId: ifaceId,
          historyPath: hp,
          lines: app.ok ? app.lines : 0,
          historyWritten: !!app.ok,
          historyReason: app.ok ? null : (app.reason || 'WRITE_FAILED')
        };
      }
      return { ok: false, reason: 'CONFLICT', wrote: false };
    }

    return { record: record, dir: function () { return opts.dir; } };
  }

  var api = {
    createHistory: createHistory,
    HISTORY_DIR: HISTORY_DIR,
    collectionName: collectionName,
    historyPath: historyPath,
    appendLine: appendLine,
    entryFor: entryFor
  };
  root.POLARIS_HISTORY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
