/* workspace-map.js — 侧栏映射 `wpa-workspace.json` 的读写与归一（S2.5a）
 *
 * 这份映射**只回答一个问题**：资源目录里的哪些文件、挂在侧栏的哪个文件夹、什么顺序。
 * 它不记请求、不记名字、不记内容 —— 内容真源永远是 `.http` 文件本身。
 * 因此它丢了最坏后果只是「外部文件从侧栏消失」，文件与内容毫发无损。
 *
 * 路径约定：
 *   - 资源目录**内**的文件写相对路径（`orders.http`、`sub/x.http`），跟着仓库走；
 *   - 资源目录**外**的一律写绝对路径（`D:\work\pay.http`），UI 上标「外部」。
 * 归一化只做展示与比对用，写回映射时保持调用方给的形态，不乱改写用户的绝对路径。
 *
 * 宿主访问与 http-store.js 一致，全部走注入的 host，方便在 Node 里用 fs 跑单测：
 *   host.list(dir) -> { files: [{ path, name, size, modified }] }
 *   host.read(p)   -> { content }
 *   host.stat(p)   -> { exists, modified }
 *   host.write(p, content)
 *   host.rename(from, to, { overwrite })
 *   host.remove(p)
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  var FILE = 'wpa-workspace.json';
  var VERSION = 1;

  /* ---------- 小工具 ---------- */

  function str(v) { return String(v == null ? '' : v); }

  function normSlash(p) { return str(p).replace(/\\/g, '/'); }

  function isAbs(p) { return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|[\\/])/.test(str(p)); }

  /* 目录去掉尾部分隔符；盘符根 `C:/` 与 Unix `/` 要保住 */
  function trimDir(dir) {
    var d = str(dir);
    if (!d) return '';
    var s = d.replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(s)) return s + '/';
    return s || '/';
  }

  function sepOf(dir) {
    var d = str(dir);
    if (/^[A-Za-z]:\\/.test(d) || (d.indexOf('\\') >= 0 && d.indexOf('/') < 0)) return '\\';
    return '/';
  }

  function baseName(p) {
    var s = normSlash(p);
    return s.slice(s.lastIndexOf('/') + 1);
  }

  function stripExt(name) { return str(name).replace(/\.(http|rest)$/i, ''); }

  /* 比对键：分隔符统一 + 去尾斜杠；Windows 形态（盘符 / UNC）不区分大小写 */
  function pathKey(p) {
    var s = normSlash(p).replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(s) || s.indexOf('//') === 0) s = s.toLowerCase();
    return s;
  }

  /* 绝对路径是否在目录内：在就返回相对路径（`/` 分隔），不在返回 null */
  function relOf(dir, absPath) {
    var d = trimDir(dir);
    if (!d) return null;
    var dn = normSlash(d).replace(/\/+$/, '');
    var an = normSlash(absPath).replace(/\/+$/, '');
    if (!dn || !an) return null;
    var dk = pathKey(dn), ak = pathKey(an);
    if (ak === dk) return null;
    if (ak.indexOf(dk + '/') !== 0) return null;
    return an.slice(dn.length + 1);
  }

  /* 写进映射的形态：目录内 → 相对；目录外 → 原样保留（绝对路径） */
  function toEntry(dir, absPath) {
    var p = str(absPath);
    if (!isAbs(p)) return p;
    var rel = relOf(dir, p);
    return rel == null ? p : rel;
  }

  /* 映射里的形态 → 绝对路径 */
  function toAbs(dir, entry) {
    var e = str(entry);
    if (!e) return '';
    if (isAbs(e)) return e;
    var d = trimDir(dir);
    if (!d) return e;
    return d.replace(/[\\/]+$/, '') + sepOf(d) + e.replace(/^[\\/]+/, '');
  }

  /* ---------- 归一化 ---------- */

  function blank() { return { version: VERSION, folders: [], unfiled: [] }; }

  /* 把任意输入收拾成合法形状：丢弃空串、去重（先到先得）、补默认值。
   * 坏数据不抛异常 —— 侧栏宁可少几行，也不能因为一个手改坏的 JSON 打不开。 */
  function normalize(input) {
    var src = input && typeof input === 'object' ? input : {};
    var seen = Object.create(null);
    var dupes = [];

    function take(v) {
      var e = str(v).trim();
      if (!e) return null;
      var k = pathKey(e);
      if (seen[k]) { dupes.push(e); return null; }
      seen[k] = 1;
      return e;
    }

    var folders = [];
    var rawFolders = Array.isArray(src.folders) ? src.folders : [];
    for (var i = 0; i < rawFolders.length; i++) {
      var f = rawFolders[i] || {};
      var files = [];
      var rf = Array.isArray(f.files) ? f.files : [];
      for (var j = 0; j < rf.length; j++) {
        var e = take(rf[j]);
        if (e) files.push(e);
      }
      folders.push({
        name: str(f.name).trim() || ('未命名 ' + (i + 1)),
        collapsed: !!f.collapsed,
        files: files
      });
    }

    var unfiled = [];
    var ru = Array.isArray(src.unfiled) ? src.unfiled : [];
    for (var m = 0; m < ru.length; m++) {
      var u = take(ru[m]);
      if (u) unfiled.push(u);
    }

    var out = { version: VERSION, folders: folders, unfiled: unfiled, dupes: dupes };

    /* 顶层未知字段原样带走，避免以后加字段时被这一步抹掉 */
    Object.keys(src).forEach(function (k) {
      if (k === 'version' || k === 'folders' || k === 'unfiled' || k === 'dupes') return;
      out[k] = src[k];
    });
    return out;
  }

  /* ---------- 读写 ---------- */

  function stripBom(t) { return str(t).replace(/^\uFEFF/, ''); }

  /* 读映射：不存在 → 空映射（exists:false），不认为是错误；解析失败 → 空映射 + error */
  async function load(host, dir) {
    var p = toAbs(dir, FILE);
    var st = await host.stat(p);
    if (!st || !st.exists) return { map: blank(), path: p, exists: false, error: null };
    var rd;
    try {
      rd = await host.read(p);
    } catch (e) {
      return { map: blank(), path: p, exists: true, error: 'READ_FAILED: ' + str(e && e.message || e) };
    }
    var obj;
    try {
      obj = JSON.parse(stripBom(rd && rd.content));
    } catch (e2) {
      return { map: blank(), path: p, exists: true, error: 'BAD_JSON: ' + str(e2 && e2.message || e2) };
    }
    var map = normalize(obj);
    map.path = p;
    map.mtime = Math.round((st && st.modified) || 0);
    return { map: map, path: p, exists: true, error: null };
  }

  /* 映射文件的文本形态：固定键顺序 + 2 空格缩进 + 末尾换行（diff 好看，人也好手改） */
  function stringify(map) {
    var m = normalize(map);
    var out = { version: VERSION, folders: [], unfiled: m.unfiled };
    out.folders = m.folders.map(function (f) {
      return { name: f.name, collapsed: !!f.collapsed, files: f.files.slice() };
    });
    Object.keys(m).forEach(function (k) {
      if (k === 'version' || k === 'folders' || k === 'unfiled' || k === 'dupes') return;
      if (k === 'path' || k === 'mtime') return;
      out[k] = m[k];
    });
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* 原子写：tmp → rename 覆盖。失败时清掉 tmp，不留垃圾 */
  async function save(host, dir, map) {
    var p = toAbs(dir, FILE);
    var text = stringify(map);
    var tmp = p + '.tmp';
    try {
      await host.write(tmp, text);
    } catch (e) {
      return { ok: false, reason: 'READONLY', error: str(e && e.message || e) };
    }
    try {
      await host.rename(tmp, p, { overwrite: true });
    } catch (e2) {
      try { await host.remove(tmp); } catch (e3) { /* 清不掉就留着，不阻塞 */ }
      return { ok: false, reason: 'WRITE_FAILED', error: str(e2 && e2.message || e2) };
    }
    return { ok: true, path: p };
  }

  /* ---------- 登记 / 发现 ---------- */

  function entries(map) {
    var out = [];
    (map.folders || []).forEach(function (f) { (f.files || []).forEach(function (e) { out.push(e); }); });
    (map.unfiled || []).forEach(function (e) { out.push(e); });
    return out;
  }

  async function httpFiles(host, dir) {
    var res = await host.list(dir);
    var files = (res && res.files) || [];
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {};
      var name = f.name || baseName(f.path);
      if (!/\.(http|rest)$/i.test(name)) continue;
      if (String(name).toLowerCase() === FILE) continue;
      out.push({ path: f.path || toAbs(dir, name), name: name, size: f.size || 0, modified: Math.round(f.modified || 0) });
    }
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    return out;
  }

  /* 未登记清单：磁盘上有、映射里没有 */
  async function discover(host, dir, map) {
    var files = await httpFiles(host, dir);
    var have = Object.create(null);
    entries(map).forEach(function (e) { have[pathKey(toAbs(dir, e))] = 1; });
    return files.filter(function (f) { return !have[pathKey(f.path)]; });
  }

  /* 首启全量登记 + 增量补登记。
   * 规则：**只往 unfiled 追加**，绝不动已有 folders 的名字、顺序、折叠态与文件顺序。
   * 幂等：跑第二次 added 为空、文本不变。 */
  async function ensureRegistered(host, dir, map) {
    var m = normalize(map);
    var files = await httpFiles(host, dir);
    var have = Object.create(null);
    entries(m).forEach(function (e) { have[pathKey(toAbs(dir, e))] = 1; });

    var added = [];
    files.forEach(function (f) {
      var k = pathKey(f.path);
      if (have[k]) return;
      have[k] = 1;
      var entry = toEntry(dir, f.path);
      m.unfiled.push(entry);
      added.push(entry);
    });
    return { map: m, added: added, changed: added.length > 0, scanned: files.length };
  }

  /* ---------- 侧栏树（S2.5b 渲染用） ----------
   * existing：当前磁盘上存在的绝对路径数组。传 null 表示「不知道」，此时不标 missing。 */
  function resolve(map, dir, existing) {
    var m = normalize(map);
    var set = null;
    if (existing) {
      set = Object.create(null);
      (existing || []).forEach(function (p) { set[pathKey(p)] = 1; });
    }
    var seen = Object.create(null);
    var missing = 0;

    function node(entry) {
      var abs = toAbs(dir, entry);
      var k = pathKey(abs);
      var dup = !!seen[k];
      seen[k] = 1;
      var exists = set ? !!set[k] : null;
      if (exists === false) missing++;
      return {
        entry: entry,
        path: abs,
        name: stripExt(baseName(abs)),
        fileName: baseName(abs),
        outside: relOf(dir, abs) == null,
        exists: exists,
        dup: dup
      };
    }

    return {
      folders: m.folders.map(function (f) {
        return { name: f.name, collapsed: !!f.collapsed, files: f.files.map(node) };
      }),
      unfiled: m.unfiled.map(node),
      missing: missing
    };
  }

  /* ---------- 归位与排序（S2.5d 用） ---------- */

  function detach(map, entry) {
    var k = pathKey(entry);
    var hit = null;
    (map.folders || []).forEach(function (f) {
      f.files = (f.files || []).filter(function (e) {
        if (!hit && pathKey(e) === k) { hit = e; return false; }
        return true;
      });
    });
    var keep = [];
    (map.unfiled || []).forEach(function (e) {
      if (!hit && pathKey(e) === k) { hit = e; return; }
      keep.push(e);
    });
    map.unfiled = keep;
    return hit;
  }

  /* folder 为 null → 放回根（unfiled）；index 省略则追加到末尾 */
  function moveTo(map, entry, folder, index) {
    var m = normalize(map);
    var hit = detach(m, entry);
    if (!hit) return { ok: false, reason: 'NOT_REGISTERED' };
    var list;
    if (folder == null) {
      list = m.unfiled;
    } else {
      var f = null;
      for (var i = 0; i < m.folders.length; i++) if (m.folders[i].name === folder) { f = m.folders[i]; break; }
      if (!f) return { ok: false, reason: 'NO_FOLDER' };
      list = f.files;
    }
    var at = (index == null || index < 0 || index > list.length) ? list.length : index;
    list.splice(at, 0, hit);
    return { ok: true, map: m };
  }

  function unregister(map, entry) {
    var m = normalize(map);
    var hit = detach(m, entry);
    return { ok: !!hit, map: m };
  }

  /* 重新定位：把找不到的旧路径换成新路径，位置与顺序不变 */
  function relocate(map, oldEntry, newEntry) {
    var m = normalize(map);
    var k = pathKey(oldEntry);
    var done = false;
    function swap(list) {
      return list.map(function (e) {
        if (!done && pathKey(e) === k) { done = true; return newEntry; }
        return e;
      });
    }
    m.folders.forEach(function (f) { f.files = swap(f.files); });
    m.unfiled = swap(m.unfiled);
    return { ok: done, map: m };
  }

  function addFolder(map, name) {
    var m = normalize(map);
    var n = str(name).trim();
    if (!n) return { ok: false, reason: 'EMPTY_NAME' };
    if (m.folders.some(function (f) { return f.name === n; })) return { ok: false, reason: 'EXISTS', map: m };
    m.folders.push({ name: n, collapsed: false, files: [] });
    return { ok: true, map: m };
  }

  var api = {
    FILE: FILE,
    VERSION: VERSION,
    blank: blank,
    normalize: normalize,
    load: load,
    save: save,
    stringify: stringify,
    toEntry: toEntry,
    toAbs: toAbs,
    relOf: relOf,
    isAbs: isAbs,
    pathKey: pathKey,
    entries: entries,
    discover: discover,
    ensureRegistered: ensureRegistered,
    resolve: resolve,
    moveTo: moveTo,
    unregister: unregister,
    relocate: relocate,
    addFolder: addFolder,
    baseName: baseName,
    stripExt: stripExt
  };

  root.POLARIS_MAP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
