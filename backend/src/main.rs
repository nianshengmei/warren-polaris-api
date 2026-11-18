// backend/src/main.rs — warren-polaris-api sidecar：原生 HTTP 请求代理 + 本地 .http 文件 / 结果仓库。
//
// 沙箱 UI 受 CSP/CORS 限制，无法发任意 URL 请求、也无法直接读本地文件。
// 本 sidecar 以本机 OS 用户权限运行：reqwest 发请求、std::fs 读写 .http 与结果文件。
// 结果落盘绕开 host.storage 的 1 MiB 上限，响应体可以完整保存并在页面上重新打开。
//
// 方法一览：
//   http/request          原有：reqwest 发送任意 HTTP 请求
//   warren-polaris-api/ping  健康检查
//   http/defaultDirs       返回默认结果目录与用户主目录
//   http/listFiles         扫描目录下的 .http / .rest 文件
//   http/readFile          读取一个文本文件（.http、外部 body 文件等）
//   http/readEnvFiles      读取 http-client.env.json 与 http-client.private.env.json
//   http/saveResult        把一次请求 + 响应写入 results/*.json
//   http/listResults       列出历史结果（只读元信息，不载入响应体）
//   http/getResult         读取某次完整结果
//   http/deleteResult      删除某次结果
//   http/revealDir         在系统文件管理器中打开结果目录

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

#[derive(Default)]
struct PolarisApi;

impl PluginHandler for PolarisApi {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "http/request" => handle_request(params),
            "warren-polaris-api/ping" => Ok(json!({
                "ok": true,
                "plugin": "com.warren.polaris.api",
                "version": env!("CARGO_PKG_VERSION"),
            })),
            "http/defaultDirs" => handle_default_dirs(),
            "http/listFiles" => handle_list_files(params),
            "http/readFile" => handle_read_file(params),
            "http/readEnvFiles" => handle_read_env_files(params),
            "http/saveResult" => handle_save_result(params),
            "http/listResults" => handle_list_results(params),
            "http/getResult" => handle_get_result(params),
            "http/deleteResult" => handle_delete_result(params),
            "http/revealDir" => handle_reveal_dir(params),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

/* ===================== 本地目录与文件 ===================== */

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_nanos() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// 默认结果目录：DBX 插件数据区。可用 DBX_PLUGIN_DATA_DIR 或 UI 显式覆盖。
fn default_results_dir() -> PathBuf {
    if let Ok(p) = std::env::var("DBX_PLUGIN_DATA_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p).join("com.warren.polaris.api").join("results");
        }
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(p).join("DBX").join("plugins").join("com.warren.polaris.api").join("results");
    }
    if let Ok(p) = std::env::var("HOME") {
        return PathBuf::from(p)
            .join(".local").join("share").join("dbx").join("plugins")
            .join("com.warren.polaris.api").join("results");
    }
    PathBuf::from("results")
}

fn resolve_results_dir(params: &Value) -> PathBuf {
    if let Some(d) = params.get("resultsDir").and_then(Value::as_str) {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    default_results_dir()
}

fn user_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn handle_default_dirs() -> Result<Value, PluginError> {
    Ok(json!({
        "resultsDir": default_results_dir().to_string_lossy().to_string(),
        "homeDir": user_home().to_string_lossy().to_string(),
    }))
}

fn param_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn io_err(context: &str, e: impl std::fmt::Display) -> PluginError {
    PluginError::new(-32000, format!("{context}: {e}"))
}

/// 扫描目录下的 .http / .rest 文件。默认递归 3 层，最多 200 个，跳过隐藏与构建目录。
fn handle_list_files(params: Value) -> Result<Value, PluginError> {
    let raw = param_str(&params, "dir").unwrap_or("");
    let recursive = params.get("recursive").and_then(Value::as_bool).unwrap_or(true);
    let base = if raw.is_empty() { user_home() } else { PathBuf::from(raw) };
    if !base.is_dir() {
        return Err(PluginError::new(-32602, format!("目录不存在: {}", base.display())));
    }
    let mut files: Vec<Value> = Vec::new();
    collect_http_files(&base, recursive, 0, &mut files);
    files.sort_by(|a, b| {
        a.get("path").and_then(Value::as_str).unwrap_or("")
            .cmp(b.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "dir": base.to_string_lossy().to_string(), "files": files }))
}

fn collect_http_files(dir: &Path, recursive: bool, depth: u32, out: &mut Vec<Value>) {
    if out.len() >= 200 || depth > 3 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in entries.flatten() {
        if out.len() >= 200 {
            break;
        }
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !recursive
                || name.starts_with('.')
                || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "vendor" | "AppData")
            {
                continue;
            }
            collect_http_files(&path, recursive, depth + 1, out);
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if ext != "http" && ext != "rest" {
                continue;
            }
            let meta = ent.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(json!({
                "path": path.to_string_lossy().to_string(),
                "name": name,
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "modified": modified,
            }));
        }
    }
}

fn handle_read_file(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    let content = fs::read_to_string(&path).map_err(|e| io_err("读取文件失败", e))?;
    let dir = path.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let name = path.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "dir": dir,
        "name": name,
        "content": content,
    }))
}

fn read_json_or_null(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// 读取 IDEA HTTP Client 的环境变量文件；private 文件由 UI 侧合并时覆盖同名字段。
fn handle_read_env_files(params: Value) -> Result<Value, PluginError> {
    let raw = param_str(&params, "dir").unwrap_or("");
    let base = if raw.is_empty() { user_home() } else { PathBuf::from(raw) };
    Ok(json!({
        "dir": base.to_string_lossy().to_string(),
        "public": read_json_or_null(&base.join("http-client.env.json")),
        "private": read_json_or_null(&base.join("http-client.private.env.json")),
    }))
}

/* ===================== 请求结果仓库 ===================== */

fn safe_file_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
        if out.len() >= 48 {
            break;
        }
    }
    if out.is_empty() { "request".to_string() } else { out }
}

fn handle_save_result(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    fs::create_dir_all(&dir).map_err(|e| io_err("创建结果目录失败", e))?;

    let mut obj = match params.get("entry").cloned() {
        Some(Value::Object(o)) => o,
        _ => return Err(PluginError::new(-32602, "缺少 entry 对象")),
    };

    let ts = now_millis();
    let nanos = now_nanos() % 1_000_000;
    let id = format!("{ts}-{nanos:06}");
    let name = obj
        .get("request")
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("request");
    let filename = format!("{}-{}-{}.json", ts, nanos, safe_file_name(name));

    obj.insert("id".to_string(), json!(id));
    obj.insert("savedAt".to_string(), json!(ts));
    let data = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| io_err("序列化结果失败", e))?;

    // 先写临时文件再 rename，避免 UI 在半写状态下读到不完整 JSON。
    let path = dir.join(&filename);
    let tmp = dir.join(format!("{filename}.tmp"));
    fs::write(&tmp, data.as_bytes()).map_err(|e| io_err("写入结果失败", e))?;
    fs::rename(&tmp, &path).map_err(|e| io_err("提交结果文件失败", e))?;

    Ok(json!({
        "id": id,
        "path": path.to_string_lossy().to_string(),
        "dir": dir.to_string_lossy().to_string(),
        "savedAt": ts,
    }))
}

fn handle_list_results(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            let is_json = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                .unwrap_or(false);
            if !is_json {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let req = v.get("request");
            let resp = v.get("response");
            items.push(json!({
                "path": path.to_string_lossy().to_string(),
                "id": v.get("id").and_then(Value::as_str).unwrap_or(""),
                "savedAt": v.get("savedAt").and_then(Value::as_u64).unwrap_or(0),
                "name": req.and_then(|r| r.get("name")).and_then(Value::as_str).unwrap_or(""),
                "method": req.and_then(|r| r.get("method")).and_then(Value::as_str).unwrap_or(""),
                "url": req.and_then(|r| r.get("url")).and_then(Value::as_str).unwrap_or(""),
                "sourceFile": req.and_then(|r| r.get("sourceFile")).and_then(Value::as_str).unwrap_or(""),
                "status": resp.and_then(|r| r.get("status")).and_then(Value::as_u64).unwrap_or(0),
                "timeMs": resp.and_then(|r| r.get("timeMs")).and_then(Value::as_u64).unwrap_or(0),
                "size": resp.and_then(|r| r.get("size")).and_then(Value::as_u64).unwrap_or(0),
                "ok": resp.and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false),
            }));
        }
    }
    // 文件名以时间戳开头，路径倒序即时间倒序。
    items.sort_by(|a, b| {
        b.get("path").and_then(Value::as_str).unwrap_or("")
            .cmp(a.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    if items.len() > 300 {
        items.truncate(300);
    }
    Ok(json!({ "dir": dir.to_string_lossy().to_string(), "items": items }))
}

fn handle_get_result(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    let text = fs::read_to_string(&path).map_err(|e| io_err("读取结果失败", e))?;
    let entry: Value = serde_json::from_str(&text).map_err(|e| io_err("解析结果失败", e))?;
    Ok(json!({ "path": path.to_string_lossy().to_string(), "entry": entry }))
}

fn handle_delete_result(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    match fs::remove_file(Path::new(p)) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => Err(io_err("删除结果失败", e)),
    }
}

fn handle_reveal_dir(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| io_err("创建结果目录失败", e))?;
    }
    let target = dir.to_string_lossy().to_string();
    let result = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&target).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&target).spawn()
    };
    match result {
        Ok(_) => Ok(json!({ "ok": true, "dir": target })),
        Err(e) => Err(io_err("打开文件管理器失败", e)),
    }
}

/* ===================== HTTP 请求（原有逻辑） ===================== */

/// 处理 http/request：用 reqwest 发送任意 URL 请求。
fn handle_request(params: Value) -> Result<Value, PluginError> {
    let method = params.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, "缺少 url"))?;
    let body = params.get("body").and_then(Value::as_str).unwrap_or("");
    let body_type = params.get("bodyType").and_then(Value::as_str).unwrap_or("text");
    let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64).unwrap_or(120_000);

    // headers: { "Name": "value", ... }
    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(h) = params.get("headers").and_then(Value::as_object) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                headers.insert(k.clone(), s.to_string());
            }
        }
    }

    // 构建 reqwest 请求
    let client = reqwest::blocking::Client::builder()
        .timeout(if timeout_ms > 0 { Duration::from_millis(timeout_ms) } else { Duration::from_secs(900) })
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| PluginError::new(-32000, format!("client build: {e}")))?;

    let m = parse_method(&method)?;
    let mut req = client.request(m, url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    // body
    if !["GET", "HEAD"].contains(&method.as_str()) && !body.is_empty() {
        req = req.body(body.to_string());
        // 若未声明 Content-Type 且为 json/form，自动补
        let has_ct = headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
        if !has_ct {
            match body_type {
                "json" => req = req.header("Content-Type", "application/json"),
                "form" => req = req.header("Content-Type", "application/x-www-form-urlencoded"),
                _ => {}
            }
        }
    }

    let start = Instant::now();
    let resp = req.send().map_err(|e| PluginError::new(-32000, format!("send: {e}")))?;
    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
    let ok = resp.status().is_success();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // 收集响应头
    let mut res_headers = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            res_headers.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    // 判断二进制：image/audio/video/font/octet-stream/pdf/zip 等
    let is_binary = is_binary_content_type(&content_type);
    let bytes = resp.bytes().map_err(|e| PluginError::new(-32000, format!("read body: {e}")))?;
    let time_ms = start.elapsed().as_millis() as u64;

    let (body_out, is_base64) = if is_binary {
        (BASE64_STANDARD.encode(&bytes), true)
    } else {
        let text = String::from_utf8_lossy(&bytes).to_string();
        (text, false)
    };

    Ok(json!({
        "status": status,
        "statusText": status_text,
        "ok": ok,
        "contentType": content_type,
        "headers": Value::Object(res_headers),
        "body": body_out,
        "isBase64": is_base64,
        "size": bytes.len(),
        "timeMs": time_ms,
    }))
}

fn parse_method(s: &str) -> Result<reqwest::Method, PluginError> {
    match s {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "HEAD" => Ok(reqwest::Method::HEAD),
        "OPTIONS" => Ok(reqwest::Method::OPTIONS),
        _ => Err(PluginError::new(-32602, format!("不支持的方法: {s}"))),
    }
}

fn is_binary_content_type(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("font/")
        || ct == "application/octet-stream"
        || ct == "application/pdf"
        || ct == "application/zip"
        || ct.starts_with("application/x-")
}

// base64 编码（避免引入额外 crate）—— base64 0.22 用 BASE64_STANDARD 引擎
use base64::prelude::{BASE64_STANDARD};
use base64::Engine;

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("com.warren.polaris.api", env!("CARGO_PKG_VERSION"));
    PluginServer::new(metadata, PolarisApi).serve()
}
