/* http-identity.js — 接口身份（# @file_id / # @interface_id）的纯函数工具。
 *
 * 为什么单独一个文件：身份"写进文件才算数"，落盘由 http-store 负责；
 * 这里只做「给定文本 → 新文本」的纯变换，不碰 DOM、不读宿主、不碰 POLARIS_MAP，
 * 所以能直接在 Node 里 require 做单元测试（tools/identity.test.mjs）。
 *
 * 四条不能破的约定（破了会让历史归到错的接口上）：
 *   1. 一律在原文上做行级拼接，不整文件重序列化 —— 用户手写的排版、注释、
 *      混用的行尾都得原样留着；插入行用文件自己的行尾。
 *   2. 插入行必须带 `# ` 前缀：S3.3 的高亮只认这个形状，少了就不上色。
 *   3. file_id 必须落在第一个 ### 之前（解析器对段内的 @file_id 直接告警忽略）。
 *   4. 指纹里变量保留原文（{{baseUrl}} 不展开）—— 展开会让同一接口换个环境就变指纹。
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  var ID_LEN = 8;
  var ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
  var ID_LINE_RE = /^\s*#\s*@(file|interface)[_-]id\b/i;
  var DELIM_RE = /^\s*#{3,}/;
  var ID_TOKEN_RE = /(^\s*#\s*@(?:file|interface)[_-]id\s+)([^\s]+)/i;
  var ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

  /* 与 http-file.js 的 ID_NOTE 保持一致；不直接 require 那个模块，
   * 是为了让本文件在 http-file.js 之前加载也能用。 */
  var NOTE = {
    file: 'wpa 文件身份，用于关联本 collection 的历史目录',
    interface: 'wpa 接口身份，用于关联调用历史'
  };

  /* 8 位 base36。rnd 可注入（返回 [0,1)），测试里用来造确定值。 */
  function newId(rnd) {
    var pick = typeof rnd === 'function' ? rnd : null;
    var bytes = null;
    if (!pick && root.crypto && root.crypto.getRandomValues) {
      try { bytes = root.crypto.getRandomValues(new Uint8Array(ID_LEN)); } catch (e) { bytes = null; }
    }
    var s = '';
    for (var i = 0; i < ID_LEN; i++) {
      var v = pick ? pick() : (bytes ? bytes[i] / 256 : Math.random());
      v = v - Math.floor(v);                       /* 注入的 rnd 返回 1 时不越界 */
      s += ALPHABET.charAt(Math.floor(v * 36) % 36);
    }
    return s;
  }

  /* 按行切，每行带上自己的行尾 —— 混用 CRLF/LF 的文件重拼回去不能变样。 */
  function splitLines(src) {
    var out = [];
    var start = 0;
    for (var i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) {
        var t = src.slice(start, i);
        var eol = '\n';
        if (t.charAt(t.length - 1) === '\r') { t = t.slice(0, -1); eol = '\r\n'; }
        out.push({ text: t, eol: eol });
        start = i + 1;
      }
    }
    if (start < src.length) out.push({ text: src.slice(start), eol: '' });
    return out;
  }

  function joinLines(rows) {
    var s = '';
    for (var i = 0; i < rows.length; i++) s += rows[i].text + rows[i].eol;
    return s;
  }

  function eolOf(src) { return src.indexOf('\r\n') >= 0 ? '\r\n' : '\n'; }

  function idLine(kind, id, opts) {
    var notes = !opts || opts.notes !== false;
    return '# @' + (kind === 'file' ? 'file_id' : 'interface_id') + ' ' + id +
      (notes ? '  ' + NOTE[kind] : '');
  }

  /* 找某类身份行（可限定行区间，0-based、含头不含尾）。
   * 返回 { row, id, valid } 或 null；值不合法也返回，交给调用方就地改正。 */
  function findIdRow(rows, kind, from, to) {
    from = from == null ? 0 : Math.max(0, from);
    to = to == null ? rows.length : Math.min(rows.length, to);
    for (var i = from; i < to; i++) {
      var m = ID_LINE_RE.exec(rows[i].text);
      if (!m || m[1].toLowerCase() !== kind) continue;
      var rest = rows[i].text.replace(/^\s*#\s*@[A-Za-z_-]+id\b/i, '').trim();
      var val = rest ? rest.split(/\s+/)[0] : '';
      return { row: i, id: val, valid: ID_RE.test(val) };
    }
    return null;
  }

  function delimIndex(rows, from) {
    for (var i = from || 0; i < rows.length; i++) if (DELIM_RE.test(rows[i].text)) return i;
    return -1;
  }

  /* ---- 插入 file_id ----
   * 有 ### 时插到「第一个 ### 之前的最后一个非空行」之后，并保证与 ### 之间有一个空行；
   * 没有 ###（含空文件）时插到第 1 行。
   * 幂等：已有一个合法 file_id 就原样返回 changed:false。 */
  function insertFileId(text, id, opts) {
    var src = String(text == null ? '' : text);
    var rows = splitLines(src);
    var want = id ? String(id) : newId();
    var exist = findIdRow(rows, 'file');
    if (exist && exist.valid) {
      return { text: src, changed: false, id: exist.id, line: exist.row + 1 };
    }
    var eol = eolOf(src);
    var line = idLine('file', want, opts);
    if (exist) {                                   /* 有这行但值不合法：就地改正，不留两行 */
      rows[exist.row].text = line;
      return { text: joinLines(rows), changed: true, id: want, line: exist.row + 1, fixed: true };
    }

    var head = delimIndex(rows, 0);
    var at, add;
    if (head >= 0) {
      var tail = head;
      while (tail > 0 && rows[tail - 1].text.trim() === '') tail--;
      at = tail;
      add = [{ text: line, eol: eol }];
      if (tail === head) add.push({ text: '', eol: eol });   /* ### 前本来没空行，补一个 */
    } else {
      at = 0;
      add = [{ text: line, eol: eol }];
      if (rows.length && rows[0].text.trim() !== '') add.push({ text: '', eol: eol });
    }
    rows.splice.apply(rows, [at, 0].concat(add));
    return { text: joinLines(rows), changed: true, id: want, line: at + 1 };
  }

  /* ---- 插入 interface_id ----
   * req 用 { line }（方法行，1-based，解析结果里的 r.line）或 { index }（0-based 第几段）定位；
   * 插在该段 ### 的紧下一行。
   * 已有同 id → changed:false；已有别的 id → 不覆盖，reason:'EXISTS_OTHER'（接回是显式操作）。 */
  function insertInterfaceId(text, req, id, opts) {
    var src = String(text == null ? '' : text);
    var rows = splitLines(src);
    req = req || {};
    var at = -1, i, j;

    if (req.line != null) {
      var from = Math.floor(Number(req.line)) - 1;
      /* 行号要在文件里真实存在，越界就是调用方拿错了快照，别猜 */
      if (!(from >= 0) || from >= rows.length) return { text: src, changed: false, reason: 'NO_SEGMENT' };
      for (i = from; i >= 0; i--) if (DELIM_RE.test(rows[i].text)) { at = i; break; }
    } else if (req.index != null) {
      var n = -1;
      for (j = 0; j < rows.length; j++) {
        if (!DELIM_RE.test(rows[j].text)) continue;
        n++;
        if (n === Number(req.index)) { at = j; break; }
      }
    }
    if (at < 0) return { text: src, changed: false, reason: 'NO_SEGMENT' };

    var end = rows.length;
    for (i = at + 1; i < rows.length; i++) if (DELIM_RE.test(rows[i].text)) { end = i; break; }

    var exist = findIdRow(rows, 'interface', at + 1, end);
    if (exist && exist.valid) {
      return {
        text: src, changed: false, id: exist.id, line: exist.row + 1,
        existing: exist.id, reason: id && String(id) !== exist.id ? 'EXISTS_OTHER' : 'EXISTS'
      };
    }
    if (exist) {                                   /* 值不合法：就地改正 */
      var fixId = id ? String(id) : newId();
      rows[exist.row].text = idLine('interface', fixId, opts);
      return { text: joinLines(rows), changed: true, id: fixId, line: exist.row + 1, fixed: true };
    }

    var want = id ? String(id) : newId();
    if (rows[at].eol === '') rows[at].eol = eolOf(src);     /* 最后一行没换行时先补齐 */
    rows.splice(at + 1, 0, { text: idLine('interface', want, opts), eol: rows[at].eol || eolOf(src) });
    return { text: joinLines(rows), changed: true, id: want, line: at + 2 };
  }

  /* ---- 改回旧身份（S4.6 的「接回」） ----
   * 与 insertInterfaceId 的区别：段里已经有别的 id 时不返回 EXISTS_OTHER，而是**换掉**。
   * 只在用户明确点了「接回」之后调用 —— 自动流程绝不会走到这里。
   * 换值时只动 id 那一段 token，行尾的说明文字（`# 接口身份…`）原样保留。 */
  function retagInterfaceId(text, req, id) {
    var src = String(text == null ? '' : text);
    var rows = splitLines(src);
    req = req || {};
    var want = String(id || '').trim();
    if (!want) return { text: src, changed: false, reason: 'NO_ID' };
    var at = -1, i;

    if (req.line != null) {
      var from = Math.floor(Number(req.line)) - 1;
      if (!(from >= 0) || from >= rows.length) return { text: src, changed: false, reason: 'NO_SEGMENT' };
      for (i = from; i >= 0; i--) if (DELIM_RE.test(rows[i].text)) { at = i; break; }
    } else if (req.index != null) {
      var n = -1;
      for (i = 0; i < rows.length; i++) {
        if (!DELIM_RE.test(rows[i].text)) continue;
        n++;
        if (n === Number(req.index)) { at = i; break; }
      }
    }
    if (at < 0) return { text: src, changed: false, reason: 'NO_SEGMENT' };

    var end = rows.length;
    for (i = at + 1; i < rows.length; i++) if (DELIM_RE.test(rows[i].text)) { end = i; break; }

    var exist = findIdRow(rows, 'interface', at + 1, end);
    if (exist) {
      if (exist.id === want && exist.valid) return { text: src, changed: false, id: want, line: exist.row + 1 };
      rows[exist.row].text = rows[exist.row].text.replace(
        /^(\s*#\s*@interface_id\s+)\S+/i, '$1' + want
      );
      return { text: joinLines(rows), changed: true, id: want, line: exist.row + 1, retagged: true };
    }
    if (rows[at].eol === '') rows[at].eol = eolOf(src);
    rows.splice(at + 1, 0, { text: idLine('interface', want, {}), eol: rows[at].eol || eolOf(src) });
    return { text: joinLines(rows), changed: true, id: want, line: at + 2, retagged: true, inserted: true };
  }

  /* ---- 去重 ----
   * doc 为 POLARIS_HTTP.parseHttpFile 的结果（带 text 字段），也可直接传 text 让它自己解析。
   * 同一文件里 id 重复时，后面那个换新；第一个保持原样（它才是历史的归属）。 */
  function dedupe(text, doc) {
    var src;
    if (text && typeof text === 'object') { doc = text; src = doc && doc.text; }
    else src = String(text == null ? '' : text);
    if (src == null) return { text: '', replaced: [] };
    if (!doc) {
      if (!root.POLARIS_HTTP || !root.POLARIS_HTTP.parseHttpFile) {
        return { text: src, replaced: [], skipped: 'NO_PARSER' };
      }
      doc = root.POLARIS_HTTP.parseHttpFile(src);
    }
    var rows = splitLines(src);
    var seen = Object.create(null);
    var replaced = [];

    (doc.requests || []).forEach(function (r) {
      var id = r && r.interfaceId;
      if (!id) return;
      if (!seen[id]) { seen[id] = 1; return; }     /* 第一次出现：留住 */
      var row = (r.interfaceIdLine || 0) - 1;
      if (row < 0 || row >= rows.length) return;
      var next = newId();
      while (seen[next]) next = newId();
      var before = rows[row].text;
      rows[row].text = before.replace(ID_TOKEN_RE, '$1' + next);
      if (rows[row].text === before) return;       /* 行里找不到 token 就不算换过 */
      seen[next] = 1;
      replaced.push({ line: row + 1, from: id, to: next });
    });

    return { text: joinLines(rows), replaced: replaced };
  }

  /* ---- 指纹 ----
   * METHOD + 归一化 URL。只做「不改变语义」的归一：
   *   scheme / host 小写、去掉 http:80 与 https:443 的默认端口、
   *   路径里的重复斜杠压成一个、去掉末尾斜杠与 #fragment，
   *   query 原样保留（排序会改变某些后端的语义，不做）。
   * 变量 {{baseUrl}} 不展开 —— 展开等于把环境焊进指纹。 */
  function normUrl(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '';
    var hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);

    var query = '';
    var qi = s.indexOf('?');
    if (qi >= 0) { query = s.slice(qi); s = s.slice(0, qi); }

    var scheme = '';
    var sm = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(s);
    if (sm) {
      scheme = sm[1].toLowerCase();
      var rest = s.slice(sm[0].length);
      var slash = rest.indexOf('/');
      var host = slash < 0 ? rest : rest.slice(0, slash);
      var path = slash < 0 ? '' : rest.slice(slash);
      host = host.toLowerCase();
      var port = /:(\d+)$/.exec(host);
      if (port && ((scheme === 'http' && port[1] === '80') || (scheme === 'https' && port[1] === '443'))) {
        host = host.slice(0, port.index);
      }
      s = scheme + '://' + host + path;
    }

    var head2 = '';
    var sm2 = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*)([\s\S]*)$/.exec(s);
    if (sm2) { head2 = sm2[1]; s = sm2[2]; }
    s = s.replace(/\/{2,}/g, '/');
    if (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.replace(/\/+$/, '');
    if (s === '' && head2) s = '/';
    if (query === '?') query = '';

    return head2 + s + query;
  }

  function fingerprint(req) {
    var method = String((req && req.method) || 'GET').trim().toUpperCase() || 'GET';
    return method + ' ' + normUrl(req && req.url);
  }

  var api = {
    newId: newId,
    insertFileId: insertFileId,
    insertInterfaceId: insertInterfaceId,
    retagInterfaceId: retagInterfaceId,
    dedupe: dedupe,
    fingerprint: fingerprint,
    normUrl: normUrl,
    ID_RE: ID_RE,
    ID_NOTE: NOTE
  };
  root.POLARIS_IDENTITY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
