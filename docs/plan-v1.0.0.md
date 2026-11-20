# v0.9.0 → v1.0.0 动工计划 —— 分步骤、每步可回滚

> 配套：`docs/design-v1.0.0.md`（16 节，设计依据）。
> 本文只排步骤，不含代码。每一步是一次独立提交，**做完必须能跑**（现有 0.6.4 功能不退化）。

## 版本口径（2026-11-20 定）

本轮按设计稿实现，但**发出去的版本号是 `0.9.0`**，不是 `1.0.0`。

- 原因：这套改动同时动了数据真源、侧栏、双视图和交互，**打包出来的实际手感没人验证过**。如果直接挂 1.0.0，一旦体验不达预期，要么带着缺陷当正式版，要么发 1.0.1 打补丁，两种都难看。
- `0.9.0` 是「功能齐了、等验收」的预发版：功能与 1.0.0 目标一致，装到自己机器上按真实场景跑一遍；确认顺手之后再发 `1.0.0`（必要时只改文案/默认值）。
- 数据格式不再等版本号：**格式冻结跟着 0.9.0 走**（S7.1），否则 0.9.0 装过之后改格式又要搬家——这正是撤回 0.6.4 的原因。
- 发版路径：`0.9.0` 本地/自用为主，**不进商店**；`1.0.0` 才新开商店 PR。

## 进度（截至 2026-11-20 14:xx）

| 步骤 | 状态 | 落地 |
|---|---|---|
| S1.0 测试夹具 | ✅ | `tools/fixtures/` 四件 + `fixtures.test.mjs`（15 项，哈希钉死） |
| S1.1 解析器认身份 | ✅ | `http-file.js` 的 `@file_id` / `@interface_id`；`http-file.test.mjs` +7 项（共 28） |
| S1.2 序列化器 | ✅ | `serializeRequest` / `serializeCollection`；`serialize.test.mjs` 19 项 |
| S1.3 HttpStore | ✅ | `ui/http-store.js`；sidecar 补 `statFile/deleteFile/renameFile/ensureDir`；`store.test.mjs` 22 项（含 append/delete 一段） |
| S1.4 旧数据迁移 | ✅ | `migrateFromStorage` / `mirrorRequest`；`migrate.test.mjs` 9 项 |
| S1.5 侧栏改文件源 | ✅ | `app.js` 新增 DOCS 层（`initDocs/refreshDocs/applyDocs/patchGroup/rebindTabs`）；保存走 `writeRequest`、新建走 `appendRequest`、删除走 `deleteRequest`、改名走 `writeRequest(title)`；`persist()` 不再写 collections；资源目录与 `.http` 面板共用（`POLARIS_DOCS.setDir`）；`verify-ui/check-s15.mjs` 17 项真机端到端（假宿主 + 真 fs） |
| S2.1 字段隔离验收 | ✅ | `store.test.mjs` +4 项（只改 URL / 只改 header / 只改 body / 方法大小写；`<` `>` 行与 Tab 缩进逐字节保留）、`locateSegment` 方法比对统一大写；共 26 项 |
| S2.2 反向刷新 + 冲突 | ✅ | `app.js` 的 `syncTabsWithDocs`（扫完目录对齐 tab）+ `baseMtime`（基线跟着 tab 走，不再用刚扫出的 mtime，否则外部改动会被静默覆盖）+ `#docConflict` 冲突栏（加载磁盘版本 / 保留我的并覆盖 / 稍后）+ tab ⚠ 标记；`http-editor.js` 记 `mtime` + `loadedText`，保存前比对、冲突停手，底部「用本地覆盖 / 载入磁盘版本」；`verify-ui/check-s22.mjs` 26 项真机端到端（表单侧 + 编辑器侧） |
| S2.3 双向跳转 | ✅ | 表单 → 源码：请求栏 `</>`（`openSourceForTab`，脏了先落盘）→ `POLARIS_EDITOR.openAt`（同一文件且磁盘变了会先 `ensureFresh` 重读）；源码 → 表单：gutter 请求行左侧 `▤` + 接口一览 `▤`（`openInForm` → `POLARIS_DOCS.openInForm`，按 id → 行号+方法 → 名称+方法 认段，切过去自动收起浮层）；`verify-ui/check-s23.mjs` 20 项 |
| S2.4 变量统一 | ✅ | 表单侧 `resolveVars(str,t)` 不再自己实现一套，改走 `POLARIS_HTTP.resolveDeep`：文件级 `@var` → 环境 → 内置动态变量（`$guid/$timestamp/...`）→ 跨请求引用；`syncTabVars` 在打开/重绑/保存后对齐 `fileVars`；投影层透传 `fileVars`；跨请求引用正则改 `\p{L}`（`\w` 不认中文，也认空格）；**环境也以 `http-client.env.json` 为真源**（`loadEnvsFromFile` 启动读、`saveEnvsToFile` 改完写）；`vars.test.mjs` 19 项 + `verify-ui/check-s24.mjs` 10 项 |
| S2.5a 映射层 | ✅ | `ui/workspace-map.js`（`POLARIS_MAP`）：读写 `wpa-workspace.json`（原子写）、目录内相对 / 目录外绝对路径归一、`register()` 挂载、`resolve()` 侧栏树（带 `exists`/`outside`）、`moveTo/relocate/unregister` 归位原语。**没有任何扫目录函数**；`app.js` boot 调 `loadWorkspaceMap()`（映射不存在就写一份空映射；坏 JSON 先留档 `.broken.json` 再重建），新建/改名/删除文件时同步映射；`tools/map.test.mjs` 22 项 |
| S2.5b 侧栏文件夹树 | ✅ | `renderSidebar` 拆成 `renderSidebarMapped / renderFolderNode / renderMapFile / renderFileGroup`：文件夹 → 文件 → 请求，顺序与归属全来自映射；折叠态写回 `collapsed`；外部文件带「外部」标；找不到的显示灰色占位（↻ 重新定位 / ✕ 移除登记）；底部「＋ 挂载 .http」+「＋ 新建文件夹」，文件夹可改名/删除（文件退回根）。`collectDocsList()` 改成**只遍历映射**逐个 `store.readOne()`，一个目录都不扫。`verify-ui/check-s25.mjs` 21 项 |
| S2.6 初始示例自动挂载 | ✅ | `ensureDefaultSample` 两个分支都调 `POLARIS_DOCS.register`（已存在也补登记，不再依赖「打开过一次」）；`loadWorkspaceMap` 首启建映射时若示例已在磁盘上就一并写进去，侧栏第一帧就有东西。顺带修 `POLARIS_MAP.save` 并发写：tmp 名唯一 + 写操作串行（启动期「首启建映射」与「示例挂载」会同时写，共用 tmp 会把映射文件撞掉）。`verify-ui/check-s26.mjs` 8 项 |
| S2.5c 面板去文件树 | ✅ | 浮层左栏只剩「接口一览」，文件列表 / 目录输入框 / ⟳ 扫描 / ＋ 新建 / ⇣ 导入 / 📂 打开全部删除，扫目录逻辑（`scan`/`renderFiles`/`refreshFiles`/`matchScanned`/`S.files`）连根拔掉；工作目录改由 `workspaceDir()` 推导（当前文件 → 映射目录）；侧栏文件头新增 `</>` 进源码；顶栏新增「≡ 接口一览」开关（收起后仍有唯一入口）。`verify-ui/check-s25c.mjs` 21 项 |
| S2.5d 归位与排序 | ✅ | **文件级**：文件夹头 = 归入（追加到末尾）、文件行上/下半区 = 插到前/后（同组即排序）、根区 `.root-zone` = 退回根；落点下标按「先摘后插」算（`dropIndex`），一律 `POLARIS_MAP.moveTo` → `saveWorkspaceMap()`，**只改映射、不碰文件**；拖进折叠的文件夹会顺手展开；拖拽手柄只给 `.group-head`（`.gact` 上的按下不算拖拽，也不触发折叠）。**请求级**：恢复 S1.5 暂停的拖拽 —— 同一文件内调序 = 整段搬移（新增 `store.moveSegment` / 纯函数 `moveSegmentText`，按字符偏移切段重排，文件头与段内字节逐字节不变，`baseMtime` 冲突照旧）；跨文件搬段仍拒绝并提示（会丢注释，留 1.0.1）。`store.test.mjs` +5 项、`verify.mjs` +1 项、`verify-ui/check-s25d.mjs` 23 项 |

| S3.1 浮层拖拽 | ✅ | 按住标题条拖浮层，位置记在 `--fe-dx/--fe-dy`（**不改 left/top** —— 基础盒贴着请求区算，改 left 会把宽度压变形），`pointerdown/move/up` + rAF 合帧，`setPointerCapture` 保证拖出标题条也不丢；夹取按「整块留在 `.work` 里」算，拖过头贴边；双击标题条归零；位置写进偏好 `feX/feY`，启动恢复、窗口缩放后重夹。顺带修掉两处既有毛病：`.work` 的 `overflow:hidden` 会变成可滚容器（`scrollLeft` 被顶偏 26px，浮层整体错位）→ 改 `overflow:clip`；标题条上的按钮/下拉不作为拖拽手柄。`verify.mjs` +1 项、`verify-ui/check-s31.mjs` 20 项 |

一键自测：`node tools/all.mjs`（11 个文件全绿）+ `node verify-ui/check-s15.mjs`（17 项）+ `check-s22.mjs`（29 项）+ `check-s23.mjs`（20 项）+ `check-s24.mjs`（10 项）+ `check-s25.mjs`（21 项）+ `check-s25c.mjs`（21 项）+ `check-s25d.mjs`（23 项）+ `check-s26.mjs`（8 项）+ `check-s31.mjs`（20 项）。

### 本地浏览器调试（`dev/`）

不必每次等 CI 出包才能看效果，用本地假宿主直接跑：

```bash
node dev/dev-server.mjs        # 打开 http://127.0.0.1:8899/ ；换端口用 PORT=9000
```

- `dev/mock-host.js` 顶替 DBX 注入的 `window.dbxPlugin`：`invoke` 发到本地服务，
  `storage` 落 localStorage；`ready` 里先从 `http-client.env.json` 灌好环境（省得每次手填）。
- `dev/dev-server.mjs`：静态托管 `ui/`、`/__dev/invoke` 落到真实文件系统、真发 HTTP 请求，
  外加 `/api/*` 几个假接口（`/api/pets`、`/api/slow?ms=3000`、`/api/500`、`/api/big?n=200`），不联网也能点。
- 数据目录在仓库外：`../dev-workspace`，首启种 `本地自测.http`、`示例 · 宠物店.http`、`http-client.env.json`。
- **只用来验界面与交互**：安装、签名、商店、真后端权限这些必须用真包验。

**S1.5 留下的三件事**（不影响往下走，记着别忘）：
1. **拖拽移动暂停**：文件真源下跨文件搬段要保住段落原文，`moveSaved()` 现在直接提示"暂不支持"，`item.draggable=!DOCS.enabled`。要做就得写「原文搬段」（读 src 段行 → 删 → 插到 dst），留 1.0.1。
2. **首次启动会写 `示例 · DEMO.http`**：0.6.x 的 seed 集合被迁移成文件。迁移出来的文件由 `register()` 挂载（与「打开即挂载」同一条路径），最终只留 `examples.http`。
3. **`.http` 面板与侧栏各扫一遍目录**：现在同目录但各自缓存，改了源码靠 `POLARIS_DOCS.refresh()` 合帧重扫。真做 watch（S2.2）时合并成一处。


## 0. 不可违反的三条

| # | 约束 | 违反后果 |
|---|---|---|
| 1 | **文件是唯一真源**，storage 只存偏好 | 两处数据打架，双视图解析不一致 |
| 2 | **段落级替换**写回，不整文件重写 | 用户手写排版/注释被抹掉，`git diff` 全红 |
| 3 | **不引入新指令语法**，身份只用 `#` 注释 | 审阅方质疑、IDEA 兼容性风险 |

**每一步的 gate**：本步验收命令跑绿 + 手工回归"打开→发送→保存"三件事没坏，才进下一步。任何一步红，就停在原地修，不往下堆。

## 1. 阶段总览

| 阶段 | 步骤 | 目标一句话 | 依赖 |
|---|---|---|---|
| **M1 文件真源** | S1.0–S1.5 | 集合从 storage 搬到磁盘，读写不破坏用户文件 | — |
| **M2 双视图** | S2.1–S2.4 | 表单与源码读写同一个文件，可互跳 | M1 |
| **M3 交互** | S3.1–S3.3 | 浮层可拖、字号可缩、身份行可辨 | 可与 M1 并行 |
| **M4 身份与历史** | S4.1–S4.6 | 每次调用落一行 jsonl，接口身份可追溯 | M1（需文件写入） |
| **M5 示例与文档** | S5.1–S5.4 | 一套 demo、README 写明代价、seed 退役 | M4 |
| **M6 取消** | S6.1–S6.3 | 点停止能在 2 秒内断开大响应 | 独立 |
| **M7 格式冻结与发版** | S7.0–S7.4 | 撤回 0.6.4 上架、冻结数据格式、1.0.0 出包并新开商店 PR | 全部 |

并行建议：M3 与 M1/M2 无代码交集（一个动 `http-editor.js`/`app.css`，一个动 `http-store.js`/`http-file.js`），可穿插做。

---

## M1 文件真源

### S1.0 测试夹具先行

- **目标**：先把"会被写坏的文件"造出来，后面每一步都拿它们当靶子。
- **改动**：新增 `tools/fixtures/` 四个文件 —— `minimal.http`（单请求最简）、`handwritten.http`（手写排版、注释混排、空行不规则、Tab 缩进）、`with-ids.http`（两级 id 齐全）、`messy.http`（畸形 id、重复 id、CRLF 换行）。
- **验收**：新增 `tools/fixtures.test.mjs`，四个文件都能解析出预期请求数；`handwritten.http` 记录当前字节哈希，供后续断言"没被改坏"。
- **量级**：约 +50 行（含夹具文本）。

### S1.1 解析器认身份

- **目标**：`parseHttpFile()` 能读出 `fileId` 与每个请求的 `id`，读不出就是 `undefined`，绝不猜。
- **改动**：`ui/http-file.js` —— 新增 `readIdentityLine()`；`parseHttpFile` 返回值加 `fileId`，每个 `request` 加 `id`、`idLine`（行号）。
- **规则**：`^#\s*@file[_-]id\s+([A-Za-z0-9_-]{4,32})`，**只取第一个 token，行尾说明丢弃**；短横线下划线等价。
- **验收**：`node tools/http-file.test.mjs` 新增 6 项 —— 带 id / 无 id / 畸形 id / 带说明文字 / 短横线写法 / `@file_id` 在第一个 `###` 之后（应识别为无 fileId 且有请求级误放警告）。
- **量级**：约 +60 行。

### S1.2 序列化器

- **目标**：`parse → serialize → parse` 后请求数量、方法、URL、头、体、id 全部一致（round-trip）。
- **改动**：`ui/http-file.js` —— 新增 `serializeRequest(req, opts)` / `serializeCollection(doc)`。
- **注意**：序列化只用于"新建/迁移"，**日常改字段走段落替换，不走整文件序列化**（否则违反约束 2）。
- **验收**：新文件 `tools/serialize.test.mjs`，用 S1.0 的四个夹具跑 round-trip，断言 0 差异。
- **量级**：约 +120 行。

### S1.3 `HttpStore`

- **目标**：目录里每个 `.http` 就是一个 collection，能扫、能读、能新建、能改名、能删；写文件是**原子**的。
- **改动**：新增 `ui/http-store.js`，纯函数 + 宿主调用分离（可在 Node 里注入假 `invoke` 跑测）。
  - `list()` 扫目录 → `[{name, path, mtime, requests}]`
  - `read(path)` → `{text, parsed, mtime}`
  - `writeRequest(path, req, {baseMtime})` → 段落级替换；返回 `{ok:true}` 或 `{ok:false, reason:'READONLY'|'CONFLICT'|'NOT_FOUND'}`
  - `createCollection(name)` / `renameCollection` / `deleteCollection`
  - 写入实现：`tmp` 同目录 → `rename` 覆盖
- **验收**：新增 `tools/store.test.mjs`（临时目录）：CRUD 各 1 项 + **"改 A 段后 B 段字节完全不变"** + mtime 冲突拒绝 + 原子写（写一半断电模拟：预置 tmp 残留不影响读）。
- **量级**：约 +300 行。
- **风险**：Windows 上 `rename` 覆盖已存在文件要 `fs::rename` 允许；后端需补 `http/renameFile`（S1.3 一并做）。

### S1.4 旧数据迁移

- **目标**：storage 里已有的 collections JSON → 每个 collection 一个 `.http` 文件，**幂等**（跑两次结果一样，不重复建）。
- **改动**：`ui/http-store.js` 加 `migrateFromStorage()`；`ui/app.js` boot 时调用一次，成功后写 `ui.migratedAt`。
- **冲突规则**：目标文件已存在 → 不覆盖，改写 `名称.json` 到 `.warren-migrate/` 留档，并在界面提示。
- **验收**：`tools/migrate.test.mjs`：构造 3 collection / 12 请求的旧 JSON，迁移后断言"请求数、方法、URL、body 一字不差"，再跑一次断言文件数不变。
- **量级**：约 +90 行。

### S1.5 侧栏改文件源

- **目标**：侧栏树来自 `HttpStore.list()`，不再是 storage；外部改动文件后刷新可见。
- **改动**：`ui/app.js` 的 `renderSidebar()` 数据源；`persist()` 不再写 `state.collections`。
- **验收**：手工 —— 用记事本加一个 `### 新接口` 保存 → 侧栏刷新后出现；删文件 → 树里消失。
- **量级**：约 ±80 行。

---

## M2 双视图

### S2.1 表单写回（最高风险步）

> **状态调整**：S1.5 已经把「保存 = 段落级写回」这条路接通（`saveToDoc`），否则侧栏一重扫就会把改动丢掉。
> S2.1 剩下的不是接线，而是**把风险按住**：逐字段验收 + 边界用例。

- **目标**：表单里任何一个字段（方法 / URL / 每条 header / body / bodyType）改完保存 → 文件里**只有那一段**变化。
- **改动**：以测试与边界修补为主（`tools/store.test.mjs` + `verify-ui/check-s15.mjs` 扩用例），必要时修 `serializeRequest` 的边角。
- **验收**：`git diff` 只见该段；逐个字段过一遍：只改 header 不动 body 段、只改 body 不动 header、方法大小写、空 body、CRLF 文件、单请求无 `###` 的文件、`< 文件引用` 与 `>` 输出文件这两行不丢。
- **风险**：这是最容易写坏用户文件的点。先写测试再改实现；先在 fixtures 上跑通，再开 UI。

### S2.2 反向刷新 + 冲突

> **已落地**：干净 tab 静默同步；脏 tab 挂 `docConflict`，由 `#docConflict` 栏三选一（加载磁盘版本 / 保留我的并覆盖 / 稍后）。
> 关键坑：写回基线必须用 `t.baseMtime`（打开/上次写回时的那一版），**不能用刚扫出来的 `g.mtime`** —— 后者一刷新就等于「承认外部改动」，保存会静默覆盖别人的内容。编辑器同理，用 `S.loadedText` 排除「mtime 变了但内容一样」的假冲突。

- **目标**：文件被外部改了（IDEA 保存），切回插件时表单显示新内容，且**不静默覆盖**用户正在编辑的草稿。
- **改动**：`ui/http-editor.js` 打开时记 mtime；`ui/app.js` 收到 `CONFLICT` 时弹「已重载 / 保留我的」二选一。
- **验收**：外部改 URL → 切回有提示；选"重载"后表单是新值。

### S2.3 双向跳转

> **已落地**：`</>` 在请求栏（表单 → 源码），`▤` 在 gutter 与接口一览（源码 → 表单）。
> 关键坑：同一个文件被表单写回后，编辑器手里还是旧快照 —— `openAt` 发现「同一路径 + 不脏 + mtime 变了」必须重读，
> 否则跳过去看到的是旧 URL。反过来，编辑器脏着的时候不重读，那是用户正在写的东西。

- **目标**：api → 源码滚到该段并选中；源码 → api 定位到对应请求 tab。
- **改动**：`ui/http-editor.js`（`scrollToLine` 已有基础）、请求 tab 右上角 `</>`、▶ 旁「表单」图标。
- **验收**：手工 —— 300 行的文件里点第 20 个请求的 `</>`，落点行号正确。

### S2.4 变量统一

> **已落地**（2026-11-20）。原文写的「只有一份环境」做到了两层：
> ① 求值规则统一（文件级 → 环境 → 动态 → 跨请求），② 环境来源统一到 `http-client.env.json`。
> 踩到的两个坑：跨请求引用的名字用 `\w` 匹配不到中文（`登录.response...` 直接失效），
> 变量值里套占位符（`@token = {{$guid}}`）只解一层会发出字面量 → 补 `resolveDeep`（最多叠 3 层，无变化即停）。

- **目标**：两个视图解析 `{{baseUrl}}` 得到同值；只有 `http-client.env.json` 一份。
- **改动**：`resolveVars` 复用 `http-file.js`；`fileVars` 跟着 tab 走；环境读写走文件。
- **验收**：改 env 文件里的 baseUrl → 表单发送与源码发送的 URL 完全一致。

### S2.5 侧栏唯一入口（新，2026-11-20 定）

> **决定（2026-11-20 二次收紧）**：**目录树 = 映射文件的渲染**。侧栏只认 `wpa-workspace.json`，
> 一个目录都不扫；磁盘上有但没登记的文件不显示，也不做「发现未登记」。
> **打开 `.http` 这个动作本身就是挂载** —— `openPath` 读成功后追加登记，这是往侧栏加文件的唯一途径。
> 映射只记「路径 → 文件夹」，不记请求/名字/内容 —— 它丢了最多让文件从侧栏消失，文件本身不受影响；
> 再打开一次就重新挂上。

拆四步，每步一次提交：

| 步 | 目标 | 验收 |
|---|---|---|
| **S2.5a 映射层** | `ui/workspace-map.js`：读写 `wpa-workspace.json`、相对/绝对路径归一、`register()` 挂载、**不提供任何扫目录函数** | `tools/map.test.mjs`：路径归一、挂载幂等、磁盘上有但没登记的不进树、丢失文件标 missing、不覆盖已有 folders |
| **S2.5b 侧栏文件夹树** | 渲染改成「文件夹 → 文件 → 请求」；折叠态进映射；映射里找不到的文件显示灰色「找不到」+ 重新定位；底部「＋ 挂载 .http」入口 | `verify-ui/check-s25.mjs`：两个文件夹 + 外部文件 + 缺失文件 + 「未登记不出现 → 挂载后出现」 |
| **S2.5c 面板去文件树** ✅ | 删掉 `.http` 浮层里的文件列表与「文件目录」输入框，只留「接口一览 + 源码」；所有打开入口收归侧栏 | 面板全程 `http/listFiles` 调用数为 0；侧栏 `</>` 能直接把文件开成源码视图 |
| **S2.5d 归位与排序** ✅ | 把外部文件拖进文件夹、文件夹内调顺序（写回映射）；恢复 S1.5 暂停的拖拽（同文件整段搬移，跨文件留 1.0.1） | 拖完映射文件变了、重启后顺序还在 |

- **风险**：侧栏从扁平数组变树，牵动搜索 / 折叠 / tab 重绑 / 拖拽，是 M2 里改动面最大的一步。先做 a（纯数据层，可单测）再做 b（渲染），c 最后收口。
- **与旧计划冲突处**：设计稿原写「不需要注册表」，已改为「映射为权威」；再收紧为「只认映射、打开即挂载」。
  `S1.5 留下的三件事` 第 2 条（首启写 `示例 · DEMO.http`）由 `register()` 一并解决。

---

## M3 交互

### S3.1 浮层拖拽 ✅

- **目标**：按住标题条拖到任意位置，重启后位置还在；双击复位。
- **落地**：不在 `ui/app.css`（浮层样式其实在 `ui/http-editor.js` 的 `injectCss` 里），而是位移式定位：`--fe-dx/--fe-dy` + `translate()`，宽度高度仍由 `layoutLayer()` 贴着请求区算。夹取用 `offsetLeft/offsetTop` 量基础盒（不受 transform 影响，收起动画中量得准），范围是「整块留在 `.work` 内」——`上下` 分栏只有纵向余量、`左右` 分栏只有横向余量，拖过头就贴边，绝不露出去被裁。位置存偏好 `feX/feY`，`Ctrl+0` 无关；双击标题条归零。
- **验收**：`verify-ui/check-s31.mjs` —— 拖 140px 位移跟着变、拖到 900px 外夹回、刷新后位置一致、双击归零且归零也落盘、按在「保存」按钮上起手不拖走。

### S3.2 字号缩放

- **目标**：`Ctrl` + 滚轮改编辑器字号 12–28px，textarea / 行号 / 高亮三层不错位。
- **改动**：`ui/app.css` 加 `--pa-fs` 并在三处引用；`ui/http-editor.js` 挂 `wheel`（`passive:false`）+ `Ctrl+0` 复位。
- **验收**：缩到 28px 时随便点一行，光标位置与文字对得上（错位是本步唯一的失败形态）。

### S3.3 身份行配色

- **目标**：`@file_id` / `@interface_id` 行紫色斜体加粗 + 淡底 + 左竖线 + 行号栏锚点，与普通注释一眼可分。
- **改动**：`ui/http-editor.js` 高亮层按行判定；`ui/app.css` 加 `.pa-line-id`。
- **验收**：截图对比 —— 同屏同时有普通注释、`@name`、`@interface_id` 三种，颜色层级正确。

---

## M4 身份与历史

### S4.1 `HttpIdentity`

- **目标**：生成、插入、去重、指纹四件事各自独立可测。
- **改动**：新增 `ui/http-identity.js`
  - `newId()` → 8 位 base36
  - `insertFileId(text)` → 插到**第一个 `###` 之前**（空文件就是第 1 行）
  - `insertInterfaceId(text, req)` → 插到该 `###` 的**紧下一行**
  - `dedupe(doc)` → 同文件重复 id，后一个换新
  - `fingerprint(req)` → `METHOD + 归一化URL`（变量保留原文，不展开）
- **验收**：`tools/identity.test.mjs` —— 9 项，含"插完再解析能读回同一个 id"、"插 file_id 后请求数不变"、"两段同 id 时第二个被换掉"。

### S4.2 赋予时机（编排）

- **目标**：只有"要落历史"才写身份；**先插 id 并等写盘成功，再写历史**；失败则不写历史。
- **改动**：`ui/http-history.js` 的 `record()` 内部两步走；`ui/app.js` 发送成功后调它。
- **只读 / 失败路径**：`writeRequest` 返回 `READONLY` 或 `CONFLICT` 重试 2 次仍失败 → 不写历史 + 状态栏提示一次。
- **验收**：`tools/history.test.mjs` 用只读夹具（Node 里 `chmod 0444`）断言"没有产生 jsonl"；正常路径断言"文件里 id 行 == jsonl 里的 interfaceId"。

### S4.3 `HttpHistory`

- **目标**：一个接口一个 jsonl，追加第 11 条时轮转为 10 条，二进制不外置就不撑爆。
- **改动**：新增 `ui/http-history.js`
  - `append(entry)` → 路径 `_history/<collection>/<接口>.jsonl`
  - `rotate()` → 取后 10 行，tmp + rename
  - `read(collection, iface)` → 解析 jsonl 为数组（坏行跳过不报错）
  - 二进制判定：`contentType` 命中 image/audio/octet-stream/zip → 落 `.bin`，jsonl 记 `bodyRef`
  - `ensureGitignore()` → 只追加 `_history/` 一行
- **验收**：`tools/history.test.mjs` —— 追加 12 条后行数 == 10 且首条是第 3 次；写入 2 MB 二进制断言 jsonl 行 < 8 KB 且 `.bin` 存在；坏行（截断的 JSON）不影响其余行解析。

### S4.4 接入发送链路

- **目标**：每次成功发送都落一条，且不影响主流程（写历史失败不能导致请求失败）。
- **改动**：`ui/app.js` 的 `send()` 里 `t.response=resp` 之后调用；`http-workspace.js` 的 `onResponse` 保留为兼容路径（1.0.0 先并存，1.0.1 再删）。
- **验收**：连发 5 次 → 文件里 5 行；把资源目录设成只读 → 请求正常返回、只有一次提示。

### S4.5 历史面板

- **目标**：请求 tab 第 5 子页「历史」，本地读该接口的 jsonl，10 条倒序，失败行标红。
- **改动**：`ui/app.js` 加子页渲染；`ui/http-workspace.js` 的旧「历史结果」tab 文案改为「调用历史」并标注"全局"。
- **验收**：300 接口 fixtures 下切到历史页 < 100ms（本地计时打点）。

### S4.6 询问式接回

- **目标**：某段无 id 但指纹命中历史里某个旧 id → 顶部一行提示，点了才接。
- **改动**：`ui/http-identity.js` 加 `findByIdentity(fingerprint)`；面板顶部提示条。
- **验收**：删掉 id 行 → 再发一次 → 提示出现；点"接回" → 历史条数恢复。

---

## M5 示例与文档

### S5.1 示例扩到 9 节

- **目标**：9 节各带 1–2 行导语；第一节说明身份注释；**不预置任何 id**。
- **改动**：`ui/sample-http.js`。
- **验收**：`node tools/sample.test.mjs` 更新为 9 节 + 新增"示例里不含 `@file_id` / `@interface_id`"断言。

### S5.2 README / NOTICE

- **目标**：README 「许可与署名」补"不再同步上游"；新增「关于 `# @file_id` / `# @interface_id`」代价小节；NOTICE 加同句。
- **改动**：`README.md`（CRLF，改完保持）、`NOTICE`、`tools/sync-readme-sample.mjs` 跑一次。
- **验收**：`node tools/sync-readme-sample.mjs --check` 通过；`node tools/verify.mjs` 全绿（含新增 1.0.0 断言）。

### S5.3 seed 退役 + 示例种子

- **目标**：首次启动只生成 `examples.http` + `http-client.env.json`，不再写 storage 的 collection/env。
- **改动**：删 `ui/app.js` 的 `seed()` 两块；`ensureDefaultSample()` 改为同时写 env 文件。
- **验收**：清空资源目录 + 清 storage 后首启 → 目录里有 2 个文件、侧栏有 1 个 collection、能直接发第 1 节。

### S5.4 校验脚本收口

- **目标**：一条命令跑全部。
- **改动**：`tools/verify.mjs` 加 v1.0.0 断言组；新增 `tools/all.mjs` 串跑 6 个测试文件。
- **验收**：`node tools/all.mjs` 全绿。

---

## M6 取消（L1）

### S6.1 backend 分块读

- **目标**：普通响应不再 `to_vec()` 一次读完，改 64 KB 分块，每块检查取消标志。
- **改动**：`backend/src/main.rs` —— `handle_request` 的普通分支（SSE 分支已有循环，加同样检查）。
- **验收**：本地起一个慢速大文件服务（`/big?mb=50`），中途写标志 → 2 秒内连接断开，日志打印 `cancelled at N bytes`。

### S6.2 UI 写标志

- **目标**：停止按钮写 `_cancel/<requestId>.flag`，请求结束删掉。
- **改动**：`ui/app.js` 的 `doStop()`；`ui/http-workspace.js` 提供路径。
- **验收**：手工 —— 下载 50 MB 时点停止，`netstat` 看不到持续连接。

### S6.3 回归

- **目标**：SSE、multipart、超时三条不退化。
- **验收**：`verify-multipart` 21/21；真机 784 KB wav 上传 SHA-256 一致；SSE 11 事件完整。

---

## M7 数据格式冻结与发版

> **上架策略（2026-11-20 定）**：`v0.6.4` 的商店 PR #557 **撤回**，不公开。0.6.x 的数据格式（storage 里的 collections JSON + `results/` 目录）是过渡形态，一旦有人装了它、开始攒历史，1.0.0 的文件化就要替他们搬家。现在没有真实用户，成本最低的做法是**先不发布，等 1.0.0 的数据格式定稿再一次性上架**。

| 步骤 | 内容 | 验收 |
|---|---|---|
| S7.0 | 撤回 PR #557（close，不合并）；fork 分支 `submit/com.warren.polaris.api-0.6.3` 保留作参考，不发新版本 | PR 状态 closed、未 merged；商店 catalog 里没有 `com.warren.polaris.api` |
| S7.1 | **数据格式冻结**（见下），写进 `docs/data-format.md` 并作为 1.0.0 的一部分发布 | 文档里每个字段都有「类型 / 必填 / 语义 / 兼容规则」；`tools/history.test.mjs` 用 `tools/fixtures/history-v1/*.jsonl` 断言向后兼容 |
| S7.2 | 版本位齐改：`manifest.json`、`Cargo.toml`、`Cargo.lock`、`.dbx-store.json`、README 历史、`verify.mjs` 的 `VERSION` | `grep -r 0.6.4 src ui backend manifest.json` 无残留 |
| S7.3 | tag `v1.0.0` + Release → CI 5 平台 | 6 个产物齐全 |
| S7.4 | **新开**商店 PR（不复活 #557）：`candidates/com.warren.polaris.api.json` 指向 v1.0.0 五平台产物 + `publishers/warren.json` | 候选 sha256/size 与 release 一致；PR 里只有一个候选版本 |

### 数据格式冻结清单（1.0.0 之后只增不改）

| 载体 | 冻结内容 | 兼容承诺 |
|---|---|---|
| `.http` 文件 | 只使用 `#` 注释：`# @file_id`（文件级，首个 `###` 之前）、`# @interface_id`（段落级，`###` 下一行）。**不引入任何新指令语法**，IDEA / VS Code 一律按注释处理 | 后续新增元信息也只能用 `# @key value` 形态；已有两个 key 的语义永不变 |
| `http-client.env.json` | 沿用 IDEA 原生结构（`{ "envName": { "k": "v" } }`），不扩展字段 | 只读兼容；写回时保持原排版 |
| `_history/<collection>/<接口>.jsonl` | 一行一条调用记录，**每条首字段 `v`（格式版本，1.0.0 = 1）**，字段集见设计稿 13.4 | **只加字段、不改字段语义、不删字段**；读到未知字段原样保留，读到 `v` 大于自身则只读展示并提示升级 |
| `_history/_meta.json` | `{ "formatVersion": 1, "app": "com.warren.polaris.api", "createdAt": "…" }` | 迁移时据此判断是否需要升级，避免逐文件嗅探 |
| `_history/**.bin` | 原始响应字节，文件名 `2026-11-20T12-56-01.bin`，jsonl 里用 `bodyRef` 引用 | 只增不删；缺失时降级为「响应体未保存」 |
| 资源目录 | `.gitignore` 自动写入 `_history/` | 不覆盖用户已有行 |

冻结的意义：这四条里任何一条在 1.0.0 之后被改动，都会让已经攒了历史的用户数据对不上。所以**上架前必须先把它们写死**，此后只能靠新增字段来演进。`v0.6.4` 的 `results/*.json` 属于被淘汰的过渡格式，不纳入冻结范围、不承诺迁移（有旧数据的人只在设置里手动导入一次）。

---

## 8. 风险排序（按"会伤到用户"）

| 风险 | 步骤 | 兜底 |
|---|---|---|
| 段落替换写坏用户文件 | S2.1 / S1.3 | 写前备份 `.bak`（同目录，仅首次），断言其余段字节不变；失败一律不落盘 |
| 并发写回 id 冲突 | S4.2 | mtime + 指纹定位，重试 2 次；仍失败则不记历史 |
| 改分块读打破 SSE/multipart | S6.1 | 两条分支各留一条回归用例，改完立刻跑 |
| 迁移重复执行 | S1.4 | 幂等标记 `ui.migratedAt` + 目标存在即跳过 |
| 300 接口渲染慢 | S1.5 | 侧栏虚拟滚动留到 1.0.1，1.0.0 先测 300 目录首屏 < 300ms |

## 9. 明确不做（防止范围膨胀）

预请求脚本、断言执行、两次调用 diff、Cookie jar、OpenAPI 导入、CSV 导出、tab 拖拽排序、跨接口全文搜索、WebSocket/gRPC。全部留给 1.0.1 之后，1.0.0 只保证「文件真源 + 双视图 + 身份 + 历史 + 取消」五件事扎实。
