/* http-file.js — IntelliJ IDEA HTTP Client (.http / .rest) 文件解析与变量求值。
 *
 * 纯函数，无 DOM / 无宿主依赖；IIFE 挂 window.POLARIS_HTTP。
 * 与 curl.js 同风格，可被 Node 直接 require 做单元测试（见 tools/http-file.test.mjs）。
 *
 * 支持的语法子集（v0.3.0）：
 *   ### 分隔请求（### 名称 / # @name 名称）
 *   @name = value 文件级变量、{{name}} 插值
 *   http-client.env.json / http-client.private.env.json 环境变量（由 sidecar 读取后传入）
 *   请求行 METHOD URL [HTTP/1.1]、Header: Value、空行后 Body
 *   < ./body.json 外部文件引用、> ./out.json 响应另存
 *   > {% ... %} 响应脚本、{% ... %} 预请求脚本、client.test 断言（解析并保留，暂不执行）
 *   跨请求引用 {{login.response.body.$.token}} / {{login.response.headers.x-token}}
 *   内置动态变量 {{$guid}} {{$timestamp}} {{$randomInt}} {{$datetimeIso}}
 *
 * 明确不支持（v0.3.0）：脚本实际执行、client.global、multipart(<>)、GraphQL 专用块、
 * WebSocket / gRPC 请求、>< 比较断言。解析时给出 warnings，不静默丢弃。
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
  var METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+(.+?)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/i;
  var pendingPreScript = null;

  function trimRight(s) { return String(s).replace(/\s+$/, ''); }
  function safeName(s, fallback) {
    var t = String(s || '').trim().replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5.]+/g, '_').slice(0, 60);
    return t || fallback;
  }

  /* 解析一个 .http 文件。
   * opts: { fileName, variables }
   * 返回 { variables, requests, warnings, fileName }
   * request: { id, name, method, url, headers:[{k,v}], body, bodyType,
   *            bodyFromFile, outputFile, preScript, postScript, tests, raw, line, sourceFile } */
  function parseHttpFile(text, opts) {
    opts = opts || {};
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var variables = Object.assign({}, opts.variables || {});
    var requests = [];
    var warnings = [];
    var sourceFile = opts.fileName || '';
    pendingPreScript = null;

    var cur = null;
    var phase = 'idle';          // idle | headers | body | preScript | postScript
    var bodyBuf = [];
    var scriptBuf = [];
    var scriptKind = null;
    var pendingName = null;
    var seq = 0;

    function finish() {
      if (!cur) return;
      if (bodyBuf.length) cur.body = bodyBuf.join('\n').replace(/\n+$/, '');
      if (scriptBuf.length) {
        var s = scriptBuf.join('\n').trim();
        if (scriptKind === 'pre') cur.preScript = s; else cur.postScript = s;
      }
      var testHits = cur.postScript.match(/client\.test\s*\(/g);
      if (testHits) cur.tests += testHits.length;
      if (!cur.name) cur.name = pendingName || (cur.method + ' ' + (cur.url || '未命名请求')).slice(0, 48);
      if (!cur.bodyType) {
        var ct = (cur.headers || []).find(function (h) { return /^content-type$/i.test(h.k); });
        if (cur.bodyFromFile || (ct && /json/i.test(ct.v))) cur.bodyType = 'json';
        else if (ct && /x-www-form-urlencoded/i.test(ct.v)) cur.bodyType = 'form';
        else if (cur.body) cur.bodyType = 'text';
        else cur.bodyType = 'none';
      }
      if (cur.tests) warnings.push('请求「' + cur.name + '」含 ' + cur.tests + ' 个 client.test 断言，v0.3.0 仅解析不执行');
      if (cur.preScript) warnings.push('请求「' + cur.name + '」含预请求脚本，v0.3.0 仅解析不执行');
      if (cur.postScript) warnings.push('请求「' + cur.name + '」含响应脚本，v0.3.0 仅解析不执行');
      cur.raw = (cur.rawLines || []).join('\n');
      delete cur.rawLines;
      requests.push(cur);
      cur = null;
    }

    function startRequest(line, lineNo) {
      seq += 1;
      cur = {
        id: 'http-' + seq,
        name: pendingName || '',
        method: line.method,
        url: trimRight(line.url),
        headers: [],
        body: '',
        bodyType: '',
        bodyFromFile: null,
        outputFile: null,
        preScript: '',
        postScript: '',
        tests: 0,
        line: lineNo,
        sourceFile: sourceFile
      };
      cur.rawLines = [];
      pendingName = null;
      phase = 'headers';
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = trimRight(raw);
      var trimmed = line.trim();
      var lineNo = i + 1;

      /* --- 请求分隔 ### --- */
      if (/^###/.test(trimmed)) {
        finish();
        bodyBuf = []; scriptBuf = []; scriptKind = null;
        var nm = trimmed.replace(/^###+\s*/, '').trim();
        if (nm) pendingName = nm;
        phase = 'idle';
        continue;
      }

      /* --- 脚本块收集（> {% ... %} / {% ... %}） --- */
      if (phase === 'preScript' || phase === 'postScript') {
        scriptBuf.push(raw);
        if (trimmed.indexOf('%}') >= 0) {
          var joined = scriptBuf.join('\n').trim();
          if (scriptKind === 'pre') {
            if (cur) cur.preScript = joined;
            else { pendingPreScript = pendingPreScript || []; pendingPreScript.push(joined); }
          } else if (cur) {
            cur.postScript = joined;
          }
          scriptBuf = [];
          phase = cur ? (bodyBuf.length ? 'body' : 'headers') : 'idle';
        }
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* 单行完整脚本 > {% ... %} */
      if (/^>\s*\{%/.test(trimmed)) {
        if (trimmed.indexOf('%}') >= 0) {
          if (cur) cur.postScript = trimmed;
          else warnings.push('第 ' + lineNo + ' 行的响应脚本在任何请求之外，已忽略');
        } else {
          scriptKind = 'post'; scriptBuf = [raw]; phase = 'postScript';
        }
        if (cur) cur.rawLines.push(raw);
        continue;
      }
      if (/^\{%/.test(trimmed) && !cur) {
        if (trimmed.indexOf('%}') >= 0) {
          // 预请求脚本位于第一个请求之前，挂到下一个请求上
          pendingName = pendingName || '';
          if (!pendingPreScript) pendingPreScript = [];
          pendingPreScript.push(trimmed);
        } else {
          scriptKind = 'pre'; scriptBuf = [raw]; phase = 'preScript';
        }
        continue;
      }

      /* --- 文件级变量 @name = value --- */
      if (/^@[\w.\-]+\s*=/.test(trimmed) && (!cur || phase === 'idle')) {
        var vm = trimmed.match(/^@([\w.\-]+)\s*=\s*(.*)$/);
        if (vm) variables[vm[1]] = vm[2];
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 元数据注释 # @name --- */
      if (/^#\s*@name\s+/i.test(trimmed)) {
        var nn = trimmed.replace(/^#\s*@name\s+/i, '').trim();
        if (cur) cur.name = nn; else pendingName = nn;
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 纯注释 --- */
      if (/^(#|\/\/)/.test(trimmed)) {
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 空行：headers → body --- */
      if (trimmed === '') {
        if (phase === 'headers') phase = 'body';
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 请求行 --- */
      var mm = trimmed.match(METHOD_RE);
      if (mm && (phase === 'idle' || (cur && phase === 'headers' && cur.url === ''))) {
        startRequest({ method: mm[1].toUpperCase(), url: mm[2] }, lineNo);
        if (pendingPreScript && pendingPreScript.length) {
          cur.preScript = pendingPreScript.join('\n');
          pendingPreScript = null;
        }
        cur.rawLines.push(raw);
        continue;
      }

      /* --- 请求外的杂项：忽略并提示 --- */
      if (!cur) {
        if (trimmed) warnings.push('第 ' + lineNo + ' 行在任何请求之外，已忽略：' + trimmed.slice(0, 60));
        continue;
      }

      cur.rawLines.push(raw);

      /* --- 外部文件引用 < ./body.json --- */
      if (/^<\s+/.test(trimmed)) {
        var bf = trimmed.replace(/^<\s+/, '').trim();
        if (/^<>/.test(bf)) {
          warnings.push('请求「' + (cur.name || cur.id) + '」使用 multipart(<>)，v0.3.0 暂不支持');
        } else {
          cur.bodyFromFile = bf;
        }
        continue;
      }

      /* --- 响应另存 > ./out.json（排除脚本） --- */
      if (/^>{1,2}\s+/.test(trimmed) && !/\{%/.test(trimmed)) {
        cur.outputFile = trimmed.replace(/^>{1,2}\s+/, '').trim();
        continue;
      }

      /* --- Header 行 --- */
      if (phase === 'headers' && /^[^:\s][^:]*:\s*/.test(line)) {
        var ci = line.indexOf(':');
        cur.headers.push({ k: line.slice(0, ci).trim(), v: line.slice(ci + 1).trim() });
        continue;
      }

      /* --- Body --- */
      if (phase === 'body' || phase === 'headers') {
        if (phase === 'headers') phase = 'body';
        bodyBuf.push(raw);
      }
    }

    finish();
    if (pendingPreScript && pendingPreScript.length) {
      warnings.push('文件末尾前的预请求脚本未关联到请求，已忽略');
    }

    /* 相对 URL 提示 */
    requests.forEach(function (r) {
      if (r.url && !/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(r.url) && r.url.indexOf('{{') !== 0) {
        warnings.push('请求「' + r.name + '」的 URL 为相对地址，需配合 {{baseUrl}} 或完整 URL');
      }
    });

    return { fileName: sourceFile, variables: variables, requests: requests, warnings: warnings };
  }

  /* 简易 JSONPath：仅 $.a.b[0].c / a.b 形式，够用于 IDEA 的 response.body.$.token */
  function jsonPath(obj, path) {
    if (obj == null) return undefined;
    var p = String(path || '').trim().replace(/^\$\.?/, '');
    if (!p) return obj;
    var parts = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    var v = obj;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* 变量求值。
   * ctx: { vars, envs, activeEnv, responses }
   *   vars       — 文件级 @变量（优先级最高）
   *   envs       — { dev: {k:v}, prod: {...} }，来自 http-client.env.json
   *   activeEnv  — 当前环境名
   *   responses  — { 请求名: { status, headers, text, parsed, ... } }，来自本次「运行全部」已完成的请求
   * 未命中的占位符原样保留（与 app.js resolveVars 行为一致）。 */
  function resolveVars(text, ctx) {
    if (text == null || String(text).indexOf('{{') < 0) return text;
    ctx = ctx || {};
    var vars = ctx.vars || {};
    var env = (ctx.envs && ctx.activeEnv && ctx.envs[ctx.activeEnv]) || {};
    var responses = ctx.responses || {};
    return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, key) {
      key = String(key).trim();

      /* 内置动态变量 */
      if (key === '$guid') return uuid();
      if (key === '$timestamp') return String(Date.now());
      if (key === '$datetimeIso') return new Date().toISOString();
      if (key === '$randomInt') return String(Math.floor(Math.random() * 1000000));

      /* 跨请求响应引用：name.response.body.$.path / name.response.headers.X */
      var rm = key.match(/^([\w.\-]+)\.response\.(body|headers)(?:\.\$?\.?(.*))?$/i);
      if (rm) {
        var resp = responses[rm[1]];
        if (!resp) return m;
        if (rm[2].toLowerCase() === 'headers') {
          var hk = (rm[3] || '').toLowerCase();
          var hs = resp.headers || {};
          var found = Object.keys(hs).find(function (k) { return k.toLowerCase() === hk; });
          return found ? String(hs[found]) : m;
        }
        var body = resp.parsed !== undefined ? resp.parsed : (function () {
          try { return JSON.parse(resp.text || ''); } catch (e) { return undefined; }
        })();
        var val = jsonPath(body, rm[3] || '');
        return val === undefined ? m : (typeof val === 'object' ? JSON.stringify(val) : String(val));
      }

      if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
      if (Object.prototype.hasOwnProperty.call(env, key)) return String(env[key]);
      return m;
    });
  }

  /* 把解析出的 request 转成 app.js 的 tab seed（headers 需要 id/on 字段，由调用方注入 uid）。
   * opts: { uid, resolveText, blankRow } */
  function toTab(req, opts) {
    opts = opts || {};
    var uid = opts.uid || function () { return 'r' + Math.random().toString(36).slice(2); };
    var rv = opts.resolveText || function (s) { return s; };
    var headers = (req.headers || []).map(function (h) {
      return { id: uid(), on: true, k: rv(h.k), v: rv(h.v) };
    });
    if (opts.blankRow) headers.push(opts.blankRow());
    var body = rv(req.body || '');
    var bodyType = req.bodyType === 'form' ? 'form' : (req.bodyType === 'json' ? 'json' : (body ? 'text' : 'none'));
    return {
      name: req.name,
      method: req.method,
      url: rv(req.url),
      headers: headers,
      params: opts.blankRow ? [opts.blankRow()] : [],
      formBody: opts.blankRow ? [opts.blankRow()] : [],
      bodyType: bodyType,
      body: body,
      httpSource: { file: req.sourceFile, id: req.id, name: req.name, line: req.line }
    };
  }

  /* 合并 http-client.env.json + http-client.private.env.json（private 覆盖同名 key）。 */
  function mergeEnvFiles(publicEnv, privateEnv) {
    var out = {};
    [publicEnv, privateEnv].forEach(function (doc) {
      if (!doc || typeof doc !== 'object') return;
      Object.keys(doc).forEach(function (envName) {
        var v = doc[envName];
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        out[envName] = Object.assign({}, out[envName] || {}, v);
      });
    });
    return out;
  }

  var api = {
    METHODS: METHODS,
    parseHttpFile: parseHttpFile,
    resolveVars: resolveVars,
    toTab: toTab,
    mergeEnvFiles: mergeEnvFiles,
    jsonPath: jsonPath,
    safeName: safeName
  };
  root.POLARIS_HTTP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
