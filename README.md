# warren-polaris-api

DBX 插件 `com.warren.polaris.api` —— API 请求客户端（Rust sidecar 版）。

基于 [misxzaiz/polaris-api](https://github.com/misxzaiz/polaris-api)（`com.polaris.api`）二次开发并改名。

从 relay-devkit api 模块移植：多 tab、环境变量、cURL 导入导出、Params/Headers/Body 编辑；响应支持表格 / 对象树 / 路径下钻 / 字段筛选 / 图片与时间戳智能渲染。

请求经原生 sidecar（reqwest）发送，无 CORS / 混合内容 / 禁发头限制，等效 cURL。

**v0.3.0 起：支持直接打开本地 IDEA HTTP Client 的 `.http` / `.rest` 文件，请求结果自动保存到本机并在页面上重新打开。**

## .http 文件与结果管理

点击顶栏「▤ 打开 .http」打开工作区：

- **文件目录**：填本地目录后点「扫描」，列出该目录下（递归 3 层，上限 200 个）所有 `.http` / `.rest` 文件；也可直接「选择 .http 文件」从文件选择器导入（此方式没有本地路径，`<` 引用不可用）。
- **环境**：自动读取同目录的 `http-client.env.json` 与 `http-client.private.env.json`（private 覆盖同名字段），下拉切换环境；文件里 `@var = value` 优先级更高。
- **请求列表**：点「载入」把单条请求变成 tab，或「全部载入为 tab」；「运行全部」按文件顺序执行，前序请求的响应会被后续请求的 `{{name.response.body.$.token}}` 引用到。
- **结果目录**：默认 `%LOCALAPPDATA%\DBX\plugins\com.warren.polaris.api\results`（Linux/macOS 为 `~/.local/share/dbx/plugins/com.warren.polaris.api/results`），可手动改。每次点「发送」或「运行全部」都会自动写入一个 JSON 文件，包含完整请求快照与响应体。
- **历史结果**：顶栏「◷ 历史结果」列出本机已保存的结果，点「打开」即用原有响应视图（表格 / 对象 / 原始 / Headers / 预览）重新渲染；也可「删除」或「打开目录」在资源管理器中查看。

> 结果写入本地文件而不是 `host.storage`，因为后者单值 256 KiB、插件总量 1 MiB，装不下真实响应体。sidecar 以当前用户权限运行，本地文件读写无需额外 manifest 权限。

### 支持的 IDEA `.http` 语法

| 语法 | 支持 |
| --- | --- |
| `###` 分隔请求、`### 名称`、`# @name 名称` | ✅ |
| `@var = value` 与 `{{var}}` 插值 | ✅ |
| `http-client.env.json` / `http-client.private.env.json` 环境变量 | ✅ |
| `METHOD URL [HTTP/1.1]`、`Header: Value`、空行后 Body | ✅ |
| `< ./body.json` 外部文件引用（相对 `.http` 文件目录） | ✅ |
| `> ./out.json` 响应另存（解析为元数据） | 解析，不自动执行 |
| `> {% ... %}` 响应脚本、`{% ... %}` 预请求脚本、`client.test(...)` | 解析并保留、给出提示，**不执行** |
| 跨请求引用 `{{login.response.body.$.token}}`、`{{x.response.headers.X-Token}}` | ✅（运行全部时） |
| 内置 `{{$guid}}` `{{$timestamp}}` `{{$randomInt}}` `{{$datetimeIso}}` | ✅ |
| multipart `<>`、WebSocket / gRPC / GraphQL 专用块、`client.global` | ❌ v0.3.0 不支持 |

脚本不执行的原因：DBX 工作台是 `sandbox="allow-scripts"` 的 iframe，CSP 下 `eval` 不可用；擅自执行第三方脚本也不安全。解析出的脚本文本保存在请求对象里，后续可单独做受限求值器。

## 架构

```
warren-polaris-api/
├── manifest.json          # DBX manifest v1，含 backend + ui entrypoint
├── dbx-plugin.toml        # 打包配置（Rust backend）
├── backend/               # Rust sidecar：stdio-jsonl 协议
│   ├── Cargo.toml         # dbx-plugin-sdk + reqwest(rustls-tls-native-roots) + base64
│   └── src/main.rs        # http/request + 文件读取 / 结果仓库方法
├── ui/                    # 沙箱 UI（无网络，经 dbxPlugin.invoke 调 sidecar）
│   ├── index.html         # SPA 骨架
│   ├── app.css            # .pa-root 作用域 + DBX 双主题
│   ├── app.js             # 请求客户端主体（含 v0.3.0 响应钩子与 POLARIS_API 导出）
│   ├── core.js            # DOM/格式化工具
│   ├── json-view.js       # JSON 渲染核心
│   ├── curl.js            # cURL 解析/生成
│   ├── http-file.js       # v0.3.0：IDEA .http 解析与变量求值（纯函数）
│   ├── http-workspace.js  # v0.3.0：文件工作区 / 结果落盘 / 历史面板
│   └── dbx-bridge.js      # dbxPlugin 封装（storage 走 host.storage）
├── tools/http-file.test.mjs # v0.3.0：解析器 21 项 Node 自测
├── assets/plugin.svg
└── .github/workflows/plugin-release.yml  # 多平台编译矩阵
```

sidecar 新增方法：`http/defaultDirs`、`http/listFiles`、`http/readFile`、`http/readEnvFiles`、
`http/saveResult`、`http/listResults`、`http/getResult`、`http/deleteResult`、`http/revealDir`。

## 开发

```bash
# 解析器自测（不需要 DBX / Rust）
node tools/http-file.test.mjs

# 浏览器开发模式（不需 DBX 宿主；可解析 .http 与载入 tab，sidecar 能力不可用）
dbx-plugin dev --path . --port 5190

# 构建本机平台的 .dbxp 候选（需要 Rust 工具链）
dbx-plugin package .
```

本机安装未签名的开发包：DBX → 插件中心 → 设置 → 第三方与开发者选项 → 允许安装未签名开发包，再选择本地 `.dbxp`。

## 发布

GitHub Release published → `.github/workflows/plugin-release.yml` 自动为所有目标平台编译 unsigned candidate，产出 `release-candidates.json`。DBX Store 审查签名后上架。

## 版本历史

- v0.3.1 — 修复 DBX 沙箱内「新建分组 / 重命名 / 删除确认」等全部失效的问题：iframe 无 `allow-modals`，原生 `prompt/confirm` 被禁用，替换为自定义 DOM 模态框（`ui/dialogs.js`，`PD.ask` / `PD.confirm`）
- v0.3.0 — 支持本地 `.http` / `.rest` 文件、环境变量文件、跨请求引用、运行全部；请求结果自动落盘并可在历史面板打开；更名为 `warren-polaris-api`（fork 自 misxzaiz/polaris-api）
- v0.2.0 — 重构为 Rust sidecar 架构，解决 v0.1.x 跨域不可用问题
- v0.1.x — universal 前端插件（API 资产库方向，已被取代）
