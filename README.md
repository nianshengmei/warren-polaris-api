# warren-polaris-api

DBX 插件 `com.warren.polaris.api` —— API 请求客户端（Rust sidecar 版）。

基于 [misxzaiz/polaris-api](https://github.com/misxzaiz/polaris-api)（`com.polaris.api`）二次开发并改名。

从 relay-devkit api 模块移植：多 tab、环境变量、cURL 导入导出、Params/Headers/Body 编辑；响应支持表格 / 对象树 / 路径下钻 / 字段筛选 / 图片与时间戳智能渲染。

请求经原生 sidecar（reqwest）发送，无 CORS / 混合内容 / 禁发头限制，等效 cURL。

**v0.3.2 起：`.http` 文件可以「以文件格式」直接打开编辑** —— 源码实时可改、自动保存回原文件，每个请求首行左侧一个 ▶，点一下即发，结果显示在**原来下方的响应框**里。

**v0.4.0：打开与保存都变成「系统对话框 + 可反复点」** —— 点「打开 .http」直接拉起资源管理器选文件；文件支持从应用外拖入；「保存」任意多次点击都真正落盘，并显示第几次。

## .http 源码编辑器

顶栏「▤ 打开 .http」= **直接弹出系统文件对话框（Windows 是资源管理器那个框）选文件并打开**。面板占据上方请求区，**下方响应框完全不动**。想回到请求编辑模式点面板右上角「✕ 返回」。

| 能力 | 说明 |
| --- | --- |
| **打开文件（系统对话框）** | 顶栏「▤ 打开 .http」或面板「📂 打开」→ sidecar `http/pickFile` 调系统文件对话框，拿到**绝对路径**后打开；直接原地保存，不需要先配工作目录 |
| **从外部拖入** | 把 `.http` / 任意文本文件从资源管理器**拖进窗口**即可打开（全屏「放开即打开」提示）。拖入拿不到绝对路径时，先按「同名 + 同大小」在工作目录里认领原文件（命中就原地编辑），认不到才复制一份到工作目录（重名自动加 `(2)`，绝不覆盖） |
| **以文件格式打开** | 右侧显示 `.http` 原始源码（等宽字体 + 行号），不是拆成一堆 tab；左侧工作目录列表仍可 `⟳` 扫描 / 点选文件 |
| **直接编辑** | textarea 自由编辑，Tab 缩进两个空格；解析器 200 ms 防抖跟随，行号与请求标记实时更新 |
| **自动保存** | 停止输入 900 ms 后自动 `http/writeFile` 写回原文件；可在「自动保存：开/关」里关掉 |
| **手动保存（可点多次）** | 「保存」按钮或 `Ctrl/⌘ + S` 立即写盘，**点几次写几次**，状态显示「✓ 已保存 HH:MM:SS ×N」；按钮会闪绿。未绑定磁盘时自动转「另存为」弹保存对话框，不会出现「点了没反应」 |
| **另存为** | 工具条「另存为」→ 系统保存对话框，写盘后把编辑器绑定到新路径继续编辑 |
| **逐请求运行 ▶** | 每个请求首行左侧有绿色 ▶，点一下就用**当前编辑中的文本**重新解析并发送该请求；运行中变黄色脉冲，成功后按状态码变绿/黄/红 |
| **结果显示在原响应框** | 走 `POLARIS_API.runRaw()` 内部的 `showResponse()`，复用原来的表格 / 对象树 / 原始 / 预览 / Headers 视图、路径下钻、字段过滤、美化、下载 —— 一个字都没另做 |
| **全部运行** | `▶▶ 全部运行` 按文件顺序执行，前序响应喂给后续 `{{login.response.body.$.token}}` 引用 |
| **环境** | 自动读取同目录 `http-client.env.json` / `http-client.private.env.json`，工具条下拉切换 |
| **新建** | `＋` 在当前工作目录新建 `.http` |

> 打开的文件会记在 `host.storage`，下次打开插件自动恢复上次编辑的文件。
>
> 为什么自己弹对话框：DBX 宿主的 `fileTransfer.pick` 只回**句柄**不回路径（沙箱设计），拿不到路径就无法把编辑结果写回原文件。sidecar 以本机用户身份运行，自己调系统对话框（Windows PowerShell/WinForms、macOS osascript、Linux zenity/kdialog，零额外 crate）即可拿到绝对路径，之后 `http/readFile` / `http/writeFile` 直接可用；这条通道不可用时自动降级到宿主 `fileTransfer.pick` → `<input type=file>`。
>
> 非 `.http` 的请求保存同样可反复点：已保存过的请求再点「保存」= 直接更新，弹「已更新」提示，不再重复弹窗。

### 侧边栏：重命名与拖拽整理（非 `.http` 的已保存请求）

- **重命名**：悬停请求条目点右侧 **✎**，或直接**双击名称**；改完已打开的 tab 标题会同步更新。
- **移动到别的分组**：按住请求条目拖到目标分组，落在分组头上或空白处 = 追加到该组末尾（折叠的分组会自动展开）。
- **调整顺序**：拖到某条目的**上半区** = 插到它前面，**下半区** = 插到它后面，落点有高亮提示。
- **保存弹窗**：选「＋ 新建分组…」时，同弹窗内会展开「新分组名称」输入框（不再弹第二层，避免弹窗互相清空）；名称会 `trim` 后保存。

### 结果保存与历史

- **结果目录**：默认 `%LOCALAPPDATA%\DBX\plugins\com.warren.polaris.api\results`（Linux/macOS 为 `~/.local/share/dbx/plugins/com.warren.polaris.api/results`），可手动改。每次运行都会自动写入一个 JSON 文件，包含完整请求快照与响应体。
- **历史结果**：顶栏「◷ 历史结果」列出本机已保存的结果，点「打开」即用原有响应视图重新渲染；也可「删除」或「打开目录」。
- 结果写入本地文件而不是 `host.storage`，因为后者单值 256 KiB、插件总量 1 MiB，装不下真实响应体。sidecar 以当前用户权限运行，本地文件读写无需额外 manifest 权限。

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
| 跨请求引用 `{{login.response.body.$.token}}`、`{{x.response.headers.X-Token}}` | ✅（全部运行时） |
| 内置 `{{$guid}}` `{{$timestamp}}` `{{$randomInt}}` `{{$datetimeIso}}` | ✅ |
| multipart `<>`、WebSocket / gRPC / GraphQL 专用块、`client.global` | ❌ 暂不支持 |

脚本不执行的原因：DBX 工作台是 `sandbox="allow-scripts"` 的 iframe，CSP 下 `eval` 不可用；擅自执行第三方脚本也不安全。解析出的脚本文本保存在请求对象里，后续可单独做受限求值器。

## 架构

```
warren-polaris-api/
├── manifest.json          # DBX manifest v1，含 backend + ui entrypoint
├── dbx-plugin.toml        # 打包配置（Rust backend）
├── backend/               # Rust sidecar：stdio-jsonl 协议
│   ├── Cargo.toml         # dbx-plugin-sdk + reqwest(rustls-tls-native-roots) + base64
│   └── src/main.rs        # http/request + 文件读写 / 结果仓库方法
├── ui/                    # 沙箱 UI（无网络，经 dbxPlugin.invoke 调 sidecar）
│   ├── index.html         # SPA 骨架
│   ├── app.css            # .pa-root 作用域 + DBX 双主题
│   ├── app.js             # 请求客户端主体（响应钩子 / POLARIS_API.runRaw+showResponse）
│   ├── core.js            # DOM/格式化工具
│   ├── json-view.js       # JSON 渲染核心
│   ├── curl.js            # cURL 解析/生成
│   ├── dialogs.js         # v0.3.1：沙箱内可用的 PD.ask / PD.confirm
│   ├── http-file.js       # v0.3.0：IDEA .http 解析与变量求值（纯函数）
│   ├── http-workspace.js  # v0.3.0：结果落盘 / 历史面板
│   ├── http-editor.js     # v0.4.0：.http 源码编辑器（系统对话框打开 / 拖入 / 可反复保存 / gutter ▶）
│   └── dbx-bridge.js      # dbxPlugin 封装（storage 走 host.storage）
├── tools/http-file.test.mjs # 解析器 21 项 Node 自测
├── tools/verify.mjs         # 交付前静态校验（版本/接线/接口一致性）
├── assets/plugin.svg
└── .github/workflows/plugin-release.yml  # 多平台编译矩阵
```

sidecar 新增方法：`http/defaultDirs`、`http/listFiles`、`http/readFile`、`http/writeFile`、`http/readEnvFiles`、`http/pickFile`、
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

- **v0.4.0** — 打开与保存闭环：顶栏「打开 .http」/ 面板「📂 打开」直接弹**系统文件对话框**（sidecar `http/pickFile`，拿到绝对路径 → 原地保存）；支持**从应用外拖入文件**打开（HTML5 drop + 宿主 `fileTransfer.onDrop`，无路径时按同名+同大小认领工作目录原文件，认不到则复制副本）；「保存」**可反复点**且显示「×N」，未绑定磁盘自动转「另存为」；新增「另存为」；修复 `.http` 模式下 `Ctrl+S` 同时触发请求 tab 保存弹窗的问题；默认工作目录改为 `~/warren-polaris-api`（拖入副本不再落到家目录根下）
- **v0.3.3** — 侧边栏管理能力补齐：非 `.http` 的已保存请求支持**重命名**（悬停 ✎ 或双击名称，并同步已打开的 tab 标题）与**拖拽移动/排序**（拖到其他分组即移动，拖到条目上/下边缘可插入到该位置，拖到分组头或空白区追加到末尾）；修复保存弹窗两个 bug——「＋ 新建分组…」改为**内联输入框**（原先嵌套 `PD.ask` 会被外层 `close()` 连同弹窗一起清空，点了没反应），名称输入在**中文输入法选词时按 Enter** 不再被误当成提交（`isComposing` / `keyCode 229` 保护）
- **v0.3.2** — `.http` 改为「源码编辑器」形态：直接以文件格式打开、可编辑、自动保存 / 手动保存回原文件；每个请求首行左侧 ▶ 一点即发，结果显示在**原响应框**（`POLARIS_API.runRaw` → `showResponse`）；sidecar 新增 `http/writeFile`
- v0.3.1 — 修复 DBX 沙箱内「新建分组 / 重命名 / 删除确认」等全部失效的问题：iframe 无 `allow-modals`，原生 `prompt/confirm` 被禁用，替换为自定义 DOM 模态框（`ui/dialogs.js`，`PD.ask` / `PD.confirm`）
- v0.3.0 — 支持本地 `.http` / `.rest` 文件、环境变量文件、跨请求引用、运行全部；请求结果自动落盘并可在历史面板打开；更名为 `warren-polaris-api`（fork 自 misxzaiz/polaris-api）
- v0.2.0 — 重构为 Rust sidecar 架构，解决 v0.1.x 跨域不可用问题
- v0.1.x — universal 前端插件（API 资产库方向，已被取代）
