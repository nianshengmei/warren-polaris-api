# warren-polaris-api

DBX 插件 `com.warren.polaris.api` —— API 请求客户端（Rust sidecar 版）。

基于 [misxzaiz/polaris-api](https://github.com/misxzaiz/polaris-api)（`com.polaris.api`）二次开发并改名。

从 relay-devkit api 模块移植：多 tab、环境变量、cURL 导入导出、Params/Headers/Body 编辑；响应支持表格 / 对象树 / 路径下钻 / 字段筛选 / 图片与时间戳智能渲染。

请求经原生 sidecar（reqwest）发送，无 CORS / 混合内容 / 禁发头限制，等效 cURL。

**v0.3.2 起：`.http` 文件可以「以文件格式」直接打开编辑** —— 源码实时可改、自动保存回原文件，每个请求首行左侧一个 ▶，点一下即发，结果显示在**原来下方的响应框**里。

**v0.4.0：打开与保存都变成「系统对话框 + 可反复点」** —— 点「打开 .http」直接拉起资源管理器选文件；文件支持从应用外拖入；「保存」任意多次点击都真正落盘，并显示第几次。

**v0.9.0：文件成为唯一真源（1.0.0 预发）** —— 目录树只认 `wpa-workspace.json`，打开 `.http` 这个动作本身就是挂载；请求身份写进文件（`# @file_id` / `# @interface_id`），每次发送在 `_history/` 记一条（每个接口 10 条，二进制外置成 `.bin`）；响应体改 64 KiB 分块读，点「停止」两秒内真断。功能齐了，这一版只做自用验收，不上商店。

**v0.6.4：在商店里可辨识为 fork** —— 全新图标（青绿纸页 + 琥珀 ▶，与原作紫蓝横线图不同），列表文案明示「polaris-api 的社区 fork」，包内补 `LICENSE` + `NOTICE` 署名（Apache-2.0 §4）；功能代码与 0.6.3 一致。

**v0.6.3：打开就从第一行看起** —— 之前载入文件后 textarea 的光标落在末尾，`focus()` 把视图滚到最后一行；现在载入后光标与滚动都归零，示例打开即是文件头。

**v0.6.2：自带一份能直接跑的示例** —— 第一次打开时把 `examples.http` 放进默认目录 `~/warren-polaris-api`（8 个请求：GET / POST JSON / 表单 / multipart 上传 / SSE / 跨请求引用 / 动态变量），启动仍然只挂右缘箭头；SSE 支持流式读取（最多 10 秒，收多少显示多少）。

**v0.6.1：`打开 .http` 只弹文件对话框** —— 取消就什么都不发生，选中确认后才展开浮层；启动时若还记得上次的文件，只在右缘留一颗**灰色半透明箭头**作为入口，不主动把界面顶出来。

**v0.6.0：`.http` 变成一个真正的浮层** —— 盖在请求编辑区上、上方 tab 与下方响应框都不动；点「⇥ 收起」或点上方的请求 tab，浮层向右滑走，右缘留一颗灰色半透明悬浮箭头，点它就原样回来（可上下拖动放置位置）。

## .http 源码编辑器

顶栏「▤ 打开 .http」= **只弹系统文件对话框（Windows 是资源管理器那个框）**；选中确认后才展开浮层，取消则界面一点变化都没有。

`.http` 编辑器是**浮层**（`#fileEditorPane`，绝对定位挂在 `.work` 下）：

- 覆盖范围只到响应框上沿 —— 上方 tab 条点得到，下方响应框照样显示结果；
- **下边界可以往下拖**：浮层最底下有一条 9 px 的把手（中间一道小横条），按住往下拖就把响应区吃掉，最多铺满整个工作区；拖回去或**双击把手**复位。左右分栏时浮层本来就贴着工作区底，把手自动隐藏。拖开的量记在偏好里，重启还在；
- 点「⇥ 收起」或**点上方的请求 tab / 左侧集合条目**，浮层向右滑出屏幕，右缘浮出一颗灰色半透明箭头（24×96，磨砂，可上下拖动，位置记在 `host.storage`）；
- 点箭头 → 浮层原样滑回：文件、光标、折叠、未保存内容一个不丢（收起前会把没落盘的改动写掉）；
- 右键箭头 = 彻底关闭浮层；`POLARIS_EDITOR.collapse() / expand() / close()` 也可程序化控制。

### 怎么用（从打开到跑起来）

1. **打开** —— 左侧侧边栏就是工作区：点文件右侧的 `</>` 进源码，点请求行进表单。新文件用侧栏底部「＋ 挂载 .http」（顶栏「▤ 打开 .http」是同一个动作），也可以把文件从资源管理器**直接拖进窗口**。**打开即挂载**：读成功的文件立刻登记进 `wpa-workspace.json`，侧栏里就出现它。取消对话框则界面毫无变化。之后每次打开插件，右缘那颗灰色箭头就是「上次那个文件」的入口，点一下原样回来。
2. **找接口** —— 浮层左栏就是当前文件的**接口一览**（方法标 + 标题）；顶栏「≡ 接口一览」可以整栏收起，编辑器更宽；带过滤框，输入即筛，`Enter` 跳第一条；点一条就跳到源码对应行，行会闪一下。光标在源码里移动，列表也会跟着选中当前请求。
3. **跑一条** —— 请求首行左侧的绿色 ▶，点一下就用**你此刻编辑器里的文本**（不是磁盘上的旧版本）重新解析并发送；结果显示在下方原来的响应框，表格 / 对象树 / 原始 / 预览 / Headers 一套都在。
4. **跑全部** —— 工具条「▶▶ 全部运行」按文件顺序执行，前一个的响应能喂给后一个（`{{login.response.body.$.token}}` 这种引用只有在这个模式下才有值）。
5. **改** —— 直接在右侧源码里编辑，`Tab` 缩进两个空格；停手 900 ms 自动保存，也可以 `Ctrl/⌘ + S` 或点「保存」立刻写盘（**点几次写几次**，状态显示「✓ 已保存 15:04:21 ×3」）。想另存一份用「另存为」。
6. **收起与找回** —— 「⇥ 收起」、点上方的请求 tab、点左侧集合条目，浮层都会向右滑走；右缘灰色箭头可**上下拖动**放到顺手的位置（会记住），单击展开，右键彻底关闭。收起不会丢任何东西：光标、折叠、没保存的改动都在（收起前会顺手落盘）。
7. **变量与环境** —— 文件顶部 `@name = value` 定义文件级变量，正文用 `{{name}}` 插值；同目录放 `http-client.env.json` / `http-client.private.env.json`，右上角下拉切环境。
8. **新建** —— 侧栏顶部 `＋` 新建一个 `.http`（建好即挂到侧栏）；浮层里不再有文件列表，也就没有第二套新建入口。

> 打开的文件记在 `host.storage`，下次打开插件自动恢复；恢复只挂箭头，不主动把界面顶出来。

| 能力 | 说明 |
| --- | --- |
| **打开文件（系统对话框）** | 顶栏「▤ 打开 .http」或侧栏底部「＋ 挂载 .http」→ sidecar `http/pickFile` 调系统文件对话框，拿到**绝对路径**后打开并挂进侧栏；直接原地保存，不需要先配工作目录 |
| **从外部拖入** | 把 `.http` / 任意文本文件从资源管理器**拖进窗口**即可打开（全屏「放开即打开」提示）。拖入拿不到绝对路径时，先在侧栏映射里按文件名认领（命中就直接打开它），认不到才复制一份到映射文件所在目录（重名自动加 `(2)`，绝不覆盖） |
| **以文件格式打开** | 右侧显示 `.http` 原始源码（等宽字体 + 行号），不是拆成一堆 tab；左栏只列**当前文件**的接口一览，文件选择统一在侧栏 |
| **接口一览（当前文件）** | 左侧下半区列出**当前 `.http` 里的全部接口**：`GET/POST/PUT/DELETE…` 彩色方法标 + 名称。有标题就用标题，没有标题就用 **URL 末两段**（`https://api.x.com/api/v1/users/42?x=1` → `users/42`）。点一条即跳到源码对应位置（自动展开挡住它的折叠、整行闪一下），并在列表里高亮；带过滤框（名称 / URL / 方法，`Enter` 跳第一条），光标在编辑器里移动时列表也跟着选中当前请求 |
| **语法高亮** | `### 标题`、方法关键字（按 GET/POST/PUT… 分色）、URL（协议/主机/路径/query 键值分色）、Header 名与值、`{{变量}}`、`< body.json` / `> out.json` 指令、`{% %}` 脚本，各有配色 |
| **Body JSON 着色** | 键（key）与字符串值分色、数字 / `true false` / `null` 各自配色、标点弱化；字符串里的 `{{var}}` 单独上色 |
| **折叠** | 左侧 gutter 的 `▾/▸` 可折叠 JSON 对象/数组，也可折叠整个请求块（`###` 起）；折起来后行尾显示「⋯ N 行已折叠」。**折叠只是视图**——保存/发送始终用完整原文，折叠状态下点「保存」写出去的仍是全文件 |
| **直接编辑** | textarea 自由编辑，Tab 缩进两个空格；解析器 200 ms 防抖跟随，行号与请求标记实时更新 |
| **自动保存** | 停止输入 900 ms 后自动 `http/writeFile` 写回原文件；可在「自动保存：开/关」里关掉 |
| **手动保存（可点多次）** | 「保存」按钮或 `Ctrl/⌘ + S` 立即写盘，**点几次写几次**，状态显示「✓ 已保存 HH:MM:SS ×N」；按钮会闪绿。未绑定磁盘时自动转「另存为」弹保存对话框，不会出现「点了没反应」 |
| **另存为** | 工具条「另存为」→ 系统保存对话框，写盘后把编辑器绑定到新路径继续编辑 |
| **逐请求运行 ▶** | 每个请求首行左侧有绿色 ▶，点一下就用**当前编辑中的文本**重新解析并发送该请求；运行中变黄色脉冲，成功后按状态码变绿/黄/红 |
| **结果显示在原响应框** | 走 `POLARIS_API.runRaw()` 内部的 `showResponse()`，复用原来的表格 / 对象树 / 原始 / 预览 / Headers 视图、路径下钻、字段过滤、美化、下载 —— 一个字都没另做 |
| **全部运行** | `▶▶ 全部运行` 按文件顺序执行，前序响应喂给后续 `{{login.response.body.$.token}}` 引用 |
| **环境** | 自动读取同目录 `http-client.env.json` / `http-client.private.env.json`，工具条下拉切换 |
| **新建** | 侧栏 `＋` 新建 `.http`（建好即挂载），浮层里不再重复提供 |

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

### 调用历史：`_history/`（v1.0.0）

发送成功后，插件会在资源目录下按接口记一条调用历史：

```
<资源目录>/
├─ examples.http
├─ .gitignore            ← 自动补一行 `_history/`，免得历史被提交进仓库
└─ _history/
   ├─ _meta.json         ← 整份历史的格式版本（formatVersion: 1）
   └─ examples/          ← 按 .http 文件名（去掉扩展名）分目录
      ├─ a1b2c3d4.jsonl  ← 一个接口一个文件，一行一次调用
      └─ a1b2c3d4-1700000000000.bin   ← 二进制响应体（仅当响应是图片/音频/压缩包等）
```

- **格式已冻结（v1）**：每行首字段是 `"v":1`，字段表与兼容规则见 [`docs/data-format.md`](docs/data-format.md)。1.0.0 之后只加字段、不改语义、不删字段；装过更新版本又降级时，本版把这些行**只读展示**并提示升级，不会往里追加（旧解释器写新数据只会写坏）。

- **每个接口保留 10 条**，第 11 次发送时自动轮转，只留最近 10 条（旧的不进回收站，直接丢）。
- **只有拿到响应才记**：`4xx` / `5xx` 照样记，`status` 原样留在那一行里；网络异常、DNS 失败、中途点「停止」不记（那时没有响应可记）。
- **身份是历史的前提**：第一次发送会在该段 `###` 下一行插 `# @interface_id`、在文件头插 `# @file_id`。写不进去（资源目录只读、文件被别处改过且重试两次仍冲突）就**不写历史**——历史里绝不允许出现文件里没有的 id；此时状态栏会提示一次，请求本身照常返回。
- **二进制不塞进 jsonl**：`contentType` 是图片 / 音频 / 视频 / 字体 / 压缩包 / `application/octet-stream` 时，正文落到同目录的 `.bin`，jsonl 里只留 `bodyRef` / `bodyEncoding` / `bodyBytes`。宿主只提供文本写，所以 `.bin` 里是 base64（按 `bodyEncoding` 解码即可）。
- **与「结果目录 `_results`」的关系**：两个并存、各写各的。`_results` 仍是完整快照（请求头、请求体、响应体全存），给「◷ 历史结果」面板用；`_history` 是轻量时间线（时间、状态、耗时、大小），给「历史」子页用。1.0.1 会考虑把两者合一。
- **坏行不影响其余**：手改坏了某一行（截断的 JSON），读历史时跳过那一行并计数，不会让整份历史读不出来。

**这两行身份注释的代价（写清楚，别事后才发现）**

- 它**不是** IntelliJ `.http` 的标准语法，只是普通注释。IDEA 打开同一个文件不会报错，但也认不出这两行——换工具时它们只是两行无意义的注释。
- 删掉它们不会损坏文件，只会**断掉历史归属**：那一段会被当成新接口，从零开始记。插件检测到"同一个指纹下还有旧 id"时会提示一句，点了才接回（`# @interface_id` 会被改回旧值，历史合并）。
- 因此本 fork 从 1.0.0 起**不再跟随上游**：上游没有身份与历史这套东西，继续同步等于每次都要重新解冲突。上游的 Apache-2.0 署名与 NOTICE 照旧保留（见下）。

### 停止：`_cancel/`（v1.0.0）

点「■ 停止」不只是把界面复位——它会**让原生请求真的停下来**：

```
<资源目录>/
└─ _cancel/
   └─ qm3k9x2f.flag     ← 点停止时写一笔，请求一结束就删（后端也会兜底删）
```

- **界面立刻回**：按钮复原、显示「已手动中断」都在按下那一帧完成，不等后端。
- **后端早停**：sidecar 读响应体改成 64 KiB 一块，每块之前看一眼 `_cancel/<requestId>.flag` 在不在；在就断开连接，把**已经收到的部分**连同 `cancelled: true` 一起返回。50 MB 的下载中点停止，通常一百多毫秒就断（日志打 `request cancelled at N bytes`）。
- **为什么会多读一点**：最多多读一块（64 KiB）。想再小就把 `READ_CHUNK` 调小，代价是系统调用变多。
- **迟到响应仍然被丢弃**：`invoke` 是同步 RPC，标志只是让后端少干活；界面靠 `sendSeq` 守卫丢掉那次迟到的结果——两道保险互不依赖。
- **什么时候会退化**：对端**完全不发数据**（连头都不回）时，后端阻塞在 `read` 上查不到标志，只能等超时。这种情况界面早已停住（逻辑中断），只是后台连接会多挂一会儿。sidecar 若被配成单线程处理请求，写标志的 RPC 会排在请求后面同样退化成逻辑中断（默认 2–16 个 worker，不会）。
- **`_cancel/` 不用进 `.gitignore`**：里面只有请求存活期间才会存在的瞬时文件，请求结束即删。

### 首次打开：默认目录里带一份示例

第一次用（还没有可恢复的上次文件）时，插件会在默认工作目录 `~/warren-polaris-api` 里放两个文件，并把 `examples.http` 当作默认打开的文件——启动**只挂右缘箭头**，点箭头就能看到：

| # | 请求 | 演示什么 |
| --- | --- | --- |
| 1 | `GET {{baseUrl}}/get?familyId=…` | 查询串 + `Authorization` 头 |
| 2 | `POST {{baseUrl}}/post`（JSON） | OpenAI 兼容对话体、`inputs.userData` 这种「序列化过的 JSON 字符串」 |
| 3 | `POST {{baseUrl}}/post`（表单） | `application/x-www-form-urlencoded` 登录 |
| 4 | `POST {{baseUrl}}/post`（multipart） | 三段式上传：文件 + 文本 + JSON 段；响应里回显 `files.audio`，用来确认附件真的带上了 |
| 5 | `POST {{apiBase}}/v1/chat/completions` | SSE 模板：`stream: true` + `Accept: text/event-stream`，`data:` 逐块、`data: [DONE]` 收尾 |
| 6 | `GET {{sseDemo}}/sse?count=3` | 真 SSE 自测（`httpbingo.org`，每 2.5 s 一条、推 3 条收尾），用来确认流通道通不通 |
| 7 | `GET …?fromLogin={{login.response.body.$.form.username}}` | 跨请求引用（body 字段 / 响应头） |
| 8 | `GET …?guid={{$guid}}&ts={{$timestamp}}` | 内置动态变量 |
| 9 | `GET {{baseUrl}}/get?env={{envTag}}` | 环境切换：`envTag` 只写在 `http-client.env.json` 里，右上角下拉换环境，URL 末尾跟着变 |

- `examples.http` 默认指向 `https://httpbin.org`（6 号 SSE 自测单独用 `https://httpbingo.org`）：**能直接点 ▶ 跑通并回显请求**；要打自己的服务，只改文件顶部 `@baseUrl` / `@apiBase` 两行。
- `sample-upload.txt` 是 4 号请求的示例附件；把 `@audioPath` 换成你自己的 `.wav` 就是真实音频上传。
- `examples.http` / `sample-upload.txt` / `http-client.env.json` 三个文件都用 `noClobber` 写入：**已存在就不动**（你改过的内容不会被覆盖），删掉才会重新生成。
- 环境（`http-client.env.json`）不再存进插件 storage —— 它在磁盘上、跟你走，换台机器复制目录即可。
- 示例里没有任何真实凭据：域名、token、familyId 全是虚构占位值。

### 完整示例：`examples.http`

下面就是启动时写进 `~/warren-polaris-api/examples.http` 的原文（`@audioPath` 那行在真实文件里是本机 `sample-upload.txt` 的绝对路径，这里给个示意值）。想更快上手：整段复制存成 `demo.http`，用「▤ 打开 .http」打开它，从第 1 条开始点 ▶。

<!-- SAMPLE:BEGIN -->
```http
# ============================================================================
#  warren-polaris-api · .http 示例集
#  这个文件是插件第一次打开时自动放到默认目录的样例，可以随便改、随便删。
#
#  怎么玩：
#    1) 顶栏「▤ 打开 .http」选文件；收起后点右缘灰色箭头能回到上次的文件
#    2) 每个请求左侧的 ▶ 一点即发，结果显示在下方的响应框里
#    3) Ctrl+S 保存；默认也会自动保存
#
#  语法速查：
#    ###  标题              分隔请求；标题会出现在左侧「接口一览」，点一条跳到源码
#    # @name xxx            给请求命名，之后可用 {{xxx.response.body.$.field}} 取上次的结果
#    @name = value          文件级变量（下面这几条），优先级高于 http-client.env.json
#    < 路径                 请求体整包来自文件；在 multipart 分段里则是「这一段的附件」
#    {{$guid}} {{$timestamp}} {{$randomInt}} {{$datetimeIso}}   内置动态变量
#
#  关于 # @file_id / # @interface_id（v1.0.0 起）：
#    第一次发送某个请求时，插件会自己往文件里补两行注释 ——
#      文件顶部  # @file_id xxxxxxxx      这个文件的身份
#      请求上面  # @interface_id xxxxxxxx  这个接口的身份
#    它们是**调用历史的钥匙**：每次发送都会往 _history/ 里记一行，靠它归属到具体接口。
#    别手动删这两行：删了就等于换了个身份，历史会断成两份（插件会提示"要接回吗"，点了才接）。
#    示例里**故意一个 id 都没有** —— 你自己发一次，它就有了。
#
#  想指向自己的服务：只改下面 @baseUrl / @apiBase 两行（@sseDemo 只给 6 号自测用）
# ============================================================================

@baseUrl = https://httpbin.org
@apiBase = https://api.example.com
@token = 换成你自己的 Bearer Token
@audioPath = D:\音频\sample-upload.txt
@sseDemo = https://httpbingo.org

### 1. GET · 查询串 + 鉴权头
# @name listTasks
# 最普通的只读接口：查询参数直接跟在 URL 后面，改个值再点 ▶ 就能复跑。
# 有的网关只认裸 token（不加 "Bearer "），按你的服务改这一行即可。
# 发送一次之后，这里会多出一行 # @interface_id —— 那是这个接口的身份，别删（见文件顶部说明）。
GET {{baseUrl}}/get?familyId=1900000000000001&page=1&size=20&verbose=true
Accept: application/json
Authorization: Bearer {{token}}

### 2. POST · JSON 体 · 对话补全（OpenAI 兼容那一套）
# @name chatOnce
# 换成自己的服务：把 URL 改成 {{apiBase}}/v1/chat/completions。
# 注意 inputs.userData 这种字段是「被序列化过的 JSON 字符串」，里面的引号要转义。
POST {{baseUrl}}/post
Content-Type: application/json
Accept: application/json
Authorization: Bearer {{token}}

{
  "model": "gpt-turbo",
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是家里的语音助手，回答不超过两句" },
    { "role": "user", "content": "客厅的热水器今天用了多少水？" }
  ],
  "inputs": {
    "instanceId": "{{$guid}}",
    "channelId": "1",
    "sentenceId": "1",
    "userData": "{\"familyId\":\"1900000000000001\",\"userId\":\"1700000000000001\",\"source\":\"3\",\"language\":\"1\"}"
  }
}

### 3. POST · 表单 application/x-www-form-urlencoded
# @name login
# 登录 / 换 token 最常见的形态：key=value&key=value，不是 JSON。
# 值里有中文或 & 时要先 URL 编码，否则会被切成两个字段。
POST {{baseUrl}}/post
Content-Type: application/x-www-form-urlencoded
Accept: application/json
X-Client: warren-polaris-api

grant_type=password&username=warren&password=123456&remember=true&nonce={{$randomInt}}

### 4. POST · multipart/form-data · 上传音频做声纹
# @name uploadVoice
# 这一节故意打 httpbin：响应里的 files.audio 会回显收到的字节，
# 用来确认「附件到底有没有真的带上」。
# 换成自己的上传接口：URL 改成 {{apiBase}}/voiceprint/uploadAudio?userId=1700000000000001
# 三个必须对齐的点：
#   · boundary 与 Content-Type 里写的一模一样
#   · 分段之间空一行，最后以 --boundary-- 收尾
#   · 附件路径写绝对路径（或本文件里的变量），< 后面留一个空格
POST {{baseUrl}}/post
Content-Type: multipart/form-data; boundary=WarrenBoundary
Accept: application/json

--WarrenBoundary
Content-Disposition: form-data; name="audio"; filename="sample.wav"
Content-Type: audio/wav

< {{audioPath}}
--WarrenBoundary
Content-Disposition: form-data; name="scene"

voiceprint
--WarrenBoundary
Content-Disposition: form-data; name="meta"
Content-Type: application/json

{"familyId":"1900000000000001","sampleRate":16000}
--WarrenBoundary--

### 5. SSE · OpenAI 风格流式对话（data: 逐块 + data: [DONE]）
# @name chatStream
# 这是模板：URL 换成你的 /v1/chat/completions、token 填好就能跑。
# 服务端一行一条 data:，正文是增量 delta，最后一行 data: [DONE]：
#   data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"客"}}]}
#   data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"厅"}}]}
#   data: [DONE]
# 插件最多读 10 秒或读到对端断开，把已收到的行原样贴进响应框；
# 没正常收尾时响应区会标「SSE 已截断」，说明流是通的、只是还没说完。
POST {{apiBase}}/v1/chat/completions
Content-Type: application/json
Accept: text/event-stream
Cache-Control: no-cache
Authorization: Bearer {{token}}

{
  "model": "gpt-turbo",
  "stream": true,
  "messages": [
    { "role": "user", "content": "讲个三十字的小故事" }
  ],
  "inputs": { "instanceId": "{{$guid}}", "channelId": "1", "sentenceId": "1" }
}

### 6. SSE · 不花钱的流式自测（真正的 text/event-stream）
# 想看流是不是真的通，先点这个：httpbingo（httpbin 的 Go 版）每 2.5 秒推一条，
# 推 3 条就正常收尾，不会撞上插件那 10 秒上限，也不会被标成「已截断」。
# 注意：sidecar 是收完（对端断开或到上限）才把整段正文交回界面，
# 所以不是「逐字蹦出来」，而是结束后一次性出现。
GET {{sseDemo}}/sse?count=3
Accept: text/event-stream

### 7. 跨请求引用 · 把上一个请求的结果当变量
# @name reuseLogin
# 语法：{{请求名.response.body.$.字段路径}} · {{请求名.response.headers.头名}}
# 先跑 3 号「表单登录」，再点这里的 ▶，fromLogin 就会变成刚才表单里的用户名。
GET {{baseUrl}}/get?fromLogin={{login.response.body.$.form.username}}&trace={{listTasks.response.headers.X-Amzn-Trace-Id}}
Accept: application/json

### 8. 动态变量 · 每次发都是新的
# 用来造请求 id、幂等键、时间戳，省得手改。
GET {{baseUrl}}/get?guid={{$guid}}&ts={{$timestamp}}&at={{$datetimeIso}}&r={{$randomInt}}
Accept: application/json

### 9. 环境切换 · 变量放哪儿说了算
# @name envSwitch
# 优先级：文件里的 @xxx 最高，其次才是 http-client.env.json 里「当前环境」那一段。
# 所以想按环境换地址，就别在这个文件里写死它 —— 把上面 @baseUrl 那行删掉，
# 改成在 env 文件里给 local / dev 各写一份，右上角下拉一换就跟着变。
# 想藏密钥就用 http-client.private.env.json（同目录，不进 git）。
# 这一条用的是文件里没定义的 {{envTag}}：示例目录的 env 文件给了 local / dev 两个值，
# 切一下环境，发出去就能看到 ?env= 后面变了。
GET {{baseUrl}}/get?env={{envTag}}
Accept: application/json

# ----------------------------------------------------------------------------
#  几个踩过的坑
#   · multipart 的 boundary 必须和 Content-Type 写的一致，分段之间空一行
#   · 附件写绝对路径；相对路径是按插件进程的工作目录解析的，容易踩空
#   · GET / HEAD 不能带 body，写了也不会发出去
#   · 变量没命中会原样发出去（URL 里还留着 {{ }}），点发送前先扫一眼
#   · 想按环境切地址：同目录放 http-client.env.json，右上角下拉能选
# ----------------------------------------------------------------------------
```
<!-- SAMPLE:END -->

### SSE（`text/event-stream`）

- 请求头写了 `Accept: text/event-stream`，或响应 `Content-Type` 是 `text/event-stream` 时按流式处理：边收边攒，**最多读 10 秒 / 512 KiB**，到点或对端断开就收尾；
- 收到的 `data:` 行原样贴进响应框（raw 视图），响应区标「SSE 已结束 / SSE 已截断」；
- 流式只在 sidecar 侧生效，不影响普通请求；SSE 请求固定 10 秒上限，避免长连接把界面一直挂住；
- **界面不是逐字蹦出来的**：sidecar 收完（对端断开或到 10 秒上限）才把整段正文交回，所以看到的是一次性贴好的一段 `data:`；
- 想验证「流是通的」：示例 6 号（`httpbingo.org/sse?count=3`）推 3 条就结束，正常情况下响应区标「SSE 已结束」；标「已截断」说明对端还在推、只是被 10 秒上限收尾了——流本身没问题。

### 支持的 IDEA `.http` 语法

| 语法 | 支持 |
| --- | --- |
| `###` 分隔请求、`### 名称`、`# @name 名称` | ✅ |
| 标题规则：**连续 3 个及以上 `#` + 空格/Tab + 名称**（`###` / `####` / `#####…` 都行，空格可以有多个）；同时写 `# @name` 时，接口一览显示标题，`@name` 留作跨请求引用的键 | ✅ |
| `@var = value` 与 `{{var}}` 插值 | ✅ |
| `http-client.env.json` / `http-client.private.env.json` 环境变量 | ✅ |
| `METHOD URL [HTTP/1.1]`、`Header: Value`、空行后 Body | ✅ |
| `< ./body.json` 外部文件引用（相对 `.http` 文件目录） | ✅ |
| `> ./out.json` 响应另存（解析为元数据） | 解析，不自动执行 |
| `> {% ... %}` 响应脚本、`{% ... %}` 预请求脚本、`client.test(...)` | 解析并保留、给出提示，**不执行** |
| 跨请求引用 `{{login.response.body.$.token}}`、`{{x.response.headers.X-Token}}` | ✅（全部运行时） |
| 内置 `{{$guid}}` `{{$timestamp}}` `{{$randomInt}}` `{{$datetimeIso}}` | ✅ |
| **`multipart/form-data`**：手写 `--boundary` 分段，段内 `< 附件路径` 表示二进制文件（路径可用 `{{变量}}`） | ✅ 按字节拼装，附件原样上传 |
| multipart 的 `<>` 简写、WebSocket / gRPC / GraphQL 专用块、`client.global` | ❌ 暂不支持 |

### multipart / 文件上传

直接按 IDEA 的写法写分段即可，**分段头与内容之间有没有空行都认**：

```http
### 创建音频
POST https://host/AiLinkService/voiceprint/uploadAudio?userId=1&familyId=2
Content-Type: multipart/form-data; boundary=WebAppBoundary
--WebAppBoundary
Content-Disposition: form-data; name="audio"; filename="x.wav"
< D:\音频\x.wav
--WebAppBoundary--
```

- 每个分段的 `< 路径`（绝对路径，或相对 `.http` 文件目录）由 sidecar 以**二进制**读入，按 RFC 7578 拼成 CRLF 实体后整体以原始字节发出——文件不会被当成文本转码。
- 分段没写 `Content-Type` 时按扩展名自动补（`.wav → audio/wav`、`.png → image/png`、`.json → application/json` 等）。
- 请求头里的 `Content-Type` 会与实际 body 的 `boundary` 强制对齐，避免「多头/边界不一致」导致服务端不认。
- 既没写 `Content-Type` 也没关系：body 首行是 `--xxx` 就自动识别为 multipart 并补头。

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

# 示例 .http 自测：8 节全解析、multipart 分段、README 里贴的那份是否同步
node tools/sample.test.mjs

# 改过 ui/sample-http.js 后，把示例原文同步进 README（--check 只校验不写）
node tools/sync-readme-sample.mjs

# 浏览器开发模式（不需 DBX 宿主；可解析 .http 与载入 tab，sidecar 能力不可用）
dbx-plugin dev --path . --port 5190

# 构建本机平台的 .dbxp 候选（需要 Rust 工具链）
dbx-plugin package .

# 没有官方 CLI 时：摊出一份「自用插件目录」（manifest + ui/ + bin/），或给 0.9.0 验收用
cd backend && cargo build --release --config 'patch.crates-io.dbx-plugin-sdk.path="/path/to/dbx-plugin-sdk"' && cd ..
node tools/selfuse-pack.mjs      # → dist/polaris-<version>-<os>-<arch>/
```

本机安装未签名的开发包：DBX → 插件中心 → 设置 → 第三方与开发者选项 → 允许安装未签名开发包，再选择本地 `.dbxp`。

## 发布

GitHub Release published → `.github/workflows/plugin-release.yml` 自动为所有目标平台编译 unsigned candidate，产出 `release-candidates.json`。DBX Store 审查签名后上架。

## 许可与署名

本插件是 [misxzaiz/polaris-api](https://github.com/misxzaiz/polaris-api)（`com.polaris.api`，Apache-2.0 许可）的社区 fork，派生自其 **v0.2.0**。

- `.dbxp` 包内带 `LICENSE`（Apache-2.0 全文）与 `NOTICE`（上游署名 + 本 fork 的改动清单），由 `dbx-plugin.toml` 的 `[package].include` 一并打包；
- 上游版权与许可声明全部保留，没有删除任何 notice；
- 版本号是本 fork 自己的历史序列（0.3.0 起重写为 `.http` 编辑器），与原作的 0.2.0 不可比——商店里两者是不同插件，本插件专注 `.http` 文件的原位编辑；
- 图标 `assets/plugin.svg` 为本 fork 自制，与原作图标无字节复用。
- **自 1.0.0 起不再同步上游**：`.http` 身份注释与调用历史是上游没有的能力，逐版本 rebase 只会反复解同一批冲突；上游的署名、LICENSE 与 NOTICE 继续完整保留，改动清单见 `NOTICE`。

## 版本历史

- **v0.9.0** — **文件成为唯一真源**（1.0.0 的预发版，**不进商店**）：
  - **目录树只认 `wpa-workspace.json`**：侧栏是映射文件的渲染，不扫盘；打开 `.http` 即挂载并登记，这是往侧栏加文件的唯一途径；首启的示例仍保证一开机就在侧栏。
  - **双视图**：请求源码（`.http` 原文、可编辑、自动保存）与响应区并存；`###` 分段、`@变量`、`{{插值}}`、跨请求引用、`http-client.env.json` 全部按 IDEA 语义走。
  - **身份写进文件**：文件头 `# @file_id`、段首 `# @interface_id`（都是普通 `#` 注释，IDEA / VS Code 不受影响）。写不进去就不记历史——历史里绝不出现文件里没有的 id。
  - **调用历史 `_history/`**：每个接口一份 jsonl，保留 10 条自动轮转；二进制响应外置成 `.bin`（base64，宿主没有二进制写通道）；删了 id 行会**问一句**再决定是否接回旧历史；格式已冻结成 v1，见 [`docs/data-format.md`](docs/data-format.md)。
  - **响应体 64 KiB 分块读**：点「停止」写 `_cancel/<requestId>.flag`，后端在下一块之前收手；50 MB 下载中途停止，实测 **160 ms 断开**。
  - 示例扩到 9 节（含只在 env 文件里定义的变量），首次打开会在资源目录种一份 `http-client.env.json`；响应区第 5 个子页就是「历史」。
  - **浮层下边界可拖**：底部把手按住往下拖，就把响应区吃掉（最多铺满工作区），双击复位；位置与拉开量都记偏好。
- **v0.6.4** — **让商店里认得出这是 fork，而不是原作的「新版」**（商店审核要求，代码与 0.6.3 一致）：
  - 换图标：盾形色板从原作的紫蓝渐变改为青绿渐变，构图是「白纸 + 折角 + 琥珀色 ▶ 徽章」，与原作（三行横线 + 黄点）不同字节也不同视觉；
  - 说明文案改为「polaris-api 的社区 fork，专注 .http 文件编辑」，明示派生关系；
  - 包内补 `LICENSE` + `NOTICE`（Apache-2.0 §4：署名 misxzaiz/polaris-api v0.2.0、列出改动清单），`dbx-plugin.toml` 的 `include` 加上这两个文件；
  - 版本号沿用本 fork 自己的历史，不与上游 0.2.0 比较（发布说明里也写了这句）。
- **v0.6.3** — **打开文件停在第一行**：`setDoc()` 赋值后光标落在末尾，随后的 `focus()` 把视图滚到文件末行（示例打开直接看到「踩过的坑」那一节）。现在赋值后 `setSelectionRange(0,0)` 并把 `scrollTop/scrollLeft` 归零。
- **v0.6.2** — **带上能直接跑通的示例，SSE 也能真的看流**：
  - 首次打开自动在默认目录 `~/warren-polaris-api` 写 `examples.http` + `sample-upload.txt`（`noClobber`，不覆盖），并作为默认恢复目标（仍然只挂箭头，不展开浮层）；上次文件失效时回落到示例
  - 示例覆盖 GET / POST JSON / 表单 / multipart 上传 / SSE / 跨请求引用 / 动态变量，共 8 节，默认打 `httpbin.org`，只改两行即可指向自己的服务；不含任何真实凭据
  - **SSE**：`Accept: text/event-stream` 或响应是 `text/event-stream` 时走流式读取，最多 10 秒 / 512 KiB，收多少显示多少；响应区标「SSE 已结束 / 已截断」，OpenAI 风格 `data: … / data: [DONE]` 可直接看
  - multipart 分段里的附件路径支持 `{{变量}}`（`@audioPath` 那样传）
  - 接口一览展示优先用 `###` 标题；`# @name` 仍是跨请求引用的键，两者不再互相顶掉
- **v0.6.1** — **「打开 .http」只弹文件对话框，不再连带把浮层顶出来**：
  - 原来 `pickAndOpen()` 一上来就 `enterMode()`，于是「点一下按钮」等于「浮层 + 资源管理器一起开」，取消后浮层还留在那儿。现在先弹框，`pickNative` 返回并**确认选中**之后才由 `openPath()` 展开浮层；取消 / 没选到文件 → 界面完全不动
  - 启动恢复改成**只挂入口**：还记得上次文件（`lastPath` 能读到）时，只在右缘显示灰色半透明箭头，浮层保持隐藏、也不再顺手把工作目录扫一遍；点箭头才展开，展开时才按需扫描。文件已不存在 / 从没打开过 → 什么都不显示
  - `openPath(p, { restore: true })` 新增恢复模式（不展开、不扫描、不聚焦）；`armEdge()` 单独负责「挂箭头」这一件事
- **v0.6.0** — **`.http` 从「占住请求区」改成真正的浮层 + 可收起的悬浮返回箭头**（打开 `.http` 后上方 tab 条失效的问题就此解决）：
  - 浮层绝对定位挂在 `.work` 下，只盖「tab 条之下、响应框之上」的请求编辑区：上方请求 tab 点得到，下方响应框仍实时显示结果；浮层带左侧圆角与投影，收起/展开有 360 ms 缓动
  - 「✕ 返回」改为「⇥ 收起」；**点上方请求 tab 或左侧集合条目也会自动收起**（不弹提示，直接让位）。收起的只是「藏起来」，`S.open` 仍为真——文件、光标、折叠状态、未保存内容全都留着
  - 收起后右缘浮出**灰色半透明箭头**（24×96、圆角 14、`backdrop-filter` 磨砂；深色主题 `rgba(150,156,172,.32)`，亮色主题 `rgba(0,0,0,.42)`）。单击原样展开、**可上下拖动**放置（位置写进偏好，重启还在）、右键彻底关闭
  - 收起前若有未落盘的改动会顺手保存；`Ctrl+S` / `Ctrl+Enter` 的归属判断改为「浮层是否真的盖在界面上」（`isOpen()`），收起后快捷键回到普通请求编辑器
  - 左右分栏布局下浮层只盖左列，滑出距离按工作区宽度算（`--fe-slide`），不会露出一截压在响应框上
- **v0.5.1** — **multipart/form-data 真正能用了**（原来只是把 body 当文本发出去，附件根本没带上，服务端自然不认 `Content-Type`）：
  - 解析器识别 `--boundary` 分段（分段头与内容之间有没有空行都认），段内 `< 附件路径` 记为二进制附件；`< 文件` 只有在 body 为空时才算「整包 body 来自文件」，不再抢走段内的行
  - UI 按 RFC 7578 用 CRLF 逐字节拼装实体，附件经 sidecar 以 base64 原样传入；sidecar `http/request` 新增 `bodyBase64`，用 `req.body(bytes)` 发原始字节
  - 请求头 `Content-Type` 强制与 body 实际 `boundary` 对齐；分段缺 `Content-Type` 时按扩展名补（`audio/wav` / `image/png` …）
  - 顺带修掉「非 JSON 的文件 body 被误判成 json」和 `<` 行被误当成整包引用的老问题
  - 真机验证：784,420 字节 wav 经真实 HTTP POST 到本地服务器，服务端解出的文件 SHA-256 与原文件完全一致
- **v0.5.0** — `.http` 编辑器补上「看得清」的两件事：
  - **接口一览**：左侧下半区列出当前文件里所有接口（方法标 + 名称），有标题用标题、没标题用 URL 末两段；点一条跳到源码对应位置（自动展开折叠 + 整行闪烁），支持过滤，光标移动时自动选中当前请求。
  - **语法着色**：`###` 标题、方法、URL（协议/主机/路径/query 键值）、Header 名值、`{{变量}}`、`<`/`>` 指令、`{% %}` 脚本分色；Body JSON 的 key / 字符串 / 数字 / 布尔 / null / 标点各自配色。实现方式是 textarea 文字透明 + 底层 `<pre>` 逐行同步绘制（字体度量、行高、宽度完全一致，光标零偏移）。
  - **折叠**：JSON 对象/数组与整段请求可折叠，行尾提示「⋯ N 行已折叠」。折叠是**视图投影**（`S.text` 才是权威文本），保存/发送永远用完整原文；折叠状态下编辑会自动展开，避免写丢内容。
  - 标题规则明确为「连续 3 个及以上 `#` + 空格/Tab + 名称」，`####`、`#####…` 同样生效。
- **v0.4.0** — 打开与保存闭环：顶栏「打开 .http」/ 面板「📂 打开」直接弹**系统文件对话框**（sidecar `http/pickFile`，拿到绝对路径 → 原地保存）；支持**从应用外拖入文件**打开（HTML5 drop + 宿主 `fileTransfer.onDrop`，无路径时按同名+同大小认领工作目录原文件，认不到则复制副本）；「保存」**可反复点**且显示「×N」，未绑定磁盘自动转「另存为」；新增「另存为」；修复 `.http` 模式下 `Ctrl+S` 同时触发请求 tab 保存弹窗的问题；默认工作目录改为 `~/warren-polaris-api`（拖入副本不再落到家目录根下）
- **v0.3.3** — 侧边栏管理能力补齐：非 `.http` 的已保存请求支持**重命名**（悬停 ✎ 或双击名称，并同步已打开的 tab 标题）与**拖拽移动/排序**（拖到其他分组即移动，拖到条目上/下边缘可插入到该位置，拖到分组头或空白区追加到末尾）；修复保存弹窗两个 bug——「＋ 新建分组…」改为**内联输入框**（原先嵌套 `PD.ask` 会被外层 `close()` 连同弹窗一起清空，点了没反应），名称输入在**中文输入法选词时按 Enter** 不再被误当成提交（`isComposing` / `keyCode 229` 保护）
- **v0.3.2** — `.http` 改为「源码编辑器」形态：直接以文件格式打开、可编辑、自动保存 / 手动保存回原文件；每个请求首行左侧 ▶ 一点即发，结果显示在**原响应框**（`POLARIS_API.runRaw` → `showResponse`）；sidecar 新增 `http/writeFile`
- v0.3.1 — 修复 DBX 沙箱内「新建分组 / 重命名 / 删除确认」等全部失效的问题：iframe 无 `allow-modals`，原生 `prompt/confirm` 被禁用，替换为自定义 DOM 模态框（`ui/dialogs.js`，`PD.ask` / `PD.confirm`）
- v0.3.0 — 支持本地 `.http` / `.rest` 文件、环境变量文件、跨请求引用、运行全部；请求结果自动落盘并可在历史面板打开；更名为 `warren-polaris-api`（fork 自 misxzaiz/polaris-api）
- v0.2.0 — 重构为 Rust sidecar 架构，解决 v0.1.x 跨域不可用问题
- v0.1.x — universal 前端插件（API 资产库方向，已被取代）
