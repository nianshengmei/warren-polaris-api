# 0.9.0 自用验收清单

> 目的：在自己机器上按真实场景跑一遍，确认「文件真源 + 双视图 + 身份 + 历史 + 取消」五件事扎实。
> 这一版**不进商店**；跑完没问题、再把三个待定项拍板，才发 1.0.0。
>
> 每一条写清「怎么做 / 应该看到什么 / 不对时看哪里」。**不用全做**，但标 ★ 的请务必走到。

---

## 0. 装上去

```bash
# A. 有官方 CLI（推荐）
dbx-plugin package .          # 产出 dist/*.dbxp
# DBX → 插件中心 → 设置 → 第三方与开发者选项 → 允许安装未签名开发包 → 选那个 .dbxp

# B. 没有 CLI：开发态
dbx-plugin dev --path . --port 5190

# C. 只想核对包内容（不出 .dbxp）
node tools/selfuse-pack.mjs   # dist/polaris-0.9.0-<os>-<arch>/ 与同名 .zip
```

装完打开插件，工作目录默认是 `~/warren-polaris-api`（首次会自动种 `examples.http`、`sample-upload.txt`、`http-client.env.json`）。

---

## 1. 首启与侧栏（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 第一次打开插件 | 侧栏里已经有 `examples.http`，不需要手动打开任何文件 | `ensureDefaultSample` 两个分支；`wpa-workspace.json` 是否生成 |
| 看右缘 | 一颗灰色半透明箭头（浮层是收起的，不主动弹出来） | `.pa-edge` 的样式与 `state.edgeTop` |
| 把 `examples.http` 改个名（资源管理器里） | 重开后侧栏还是它，历史也还在（文件级 id 没变） | `# @file_id` 是否在文件里 |
| 在资源管理器里新建一个没登记的 `x.http` | 侧栏**不显示**（这是故意的：只认映射文件） | 别改成扫盘 |

## 2. 打开与编辑（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 点某个请求 | 上方出现浮层，显示 `.http` 源码，当前段高亮 | `openPath` → `register` 链路 |
| 改一行，停手 1 秒 | 浮层右上「已保存」；用编辑器打开同一文件，内容已变 | `autoSave` 偏好、`writeText` 的 `baseMtime` |
| 用别的编辑器改同一文件再回来改 | 提示冲突，给「覆盖 / 重新载入」，不静默丢字 | 冲突条 `.pa-fe-cf` |
| 拖动浮层标题条，然后双击标题条 | 浮层跟着走；双击回到原位 | `feX/feY` 与 `clampFePos` |
| Ctrl+滚轮 / Ctrl+0 | 字号变 / 复位 | `fontSize` |
| 在浮层里点折叠箭头 | 只折叠视图，保存回文件仍是全文 | `docText()` 是唯一权威文本 |

## 3. 发送与响应（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 点请求左侧 ▶ | 响应区出状态码 / 耗时 / 大小；5 个子页（结果、原始、头、cURL、历史） | 后端 `http/request` |
| 发一个 404 | 状态码红/橙色，响应体照常显示 | 状态色映射 |
| 改 `@baseUrl` 再发 | 实际 URL 跟着变；历史里的 `url` 是展开后的，`urlTemplate` 保留模板 | `fingerprint` 规则 |
| 发 SSE 那一节 | 事件一条条出现，结束标「SSE 已结束」；超过 10 秒或 512 KiB 标「已截断」 | `sse` / `sseTruncated` |
| 发 multipart 那一节（换成自己的小文件） | 上传成功，服务端收到字节与本地一致 | `bodyType: multipart` |
| 连不上任何地址（把域名改错） | 明确报网络错误，不出现空白的 200 | `PluginError` 文案 |

## 4. 环境与变量（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 顶栏切 `local` / `dev` | 下拉里有这两项（来自 `http-client.env.json`，不是 storage） | `reloadEnvs` / `renderEnv` |
| 在 env 文件里加一个 `envTag`，切环境后发第 9 节 | 请求里带上了对应值 | 文件里的 `@var` 优先级更高，同名会被覆盖 |
| 手动改 env 文件后回到插件 | 下拉里的值跟着变（不需要重启） | 重新打开文件或切 tab 时是否重读 |

## 5. 身份与历史（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 发一次 | `.http` 里多两行 `# @file_id` / `# @interface_id`；`_history/<文件名>/<id>.jsonl` 多一行 | 身份写失败时**不写历史**，状态栏提示一次 |
| 连发 12 次 | jsonl 里恰好 10 行，最旧的被丢掉 | `MAX_LINES` |
| 打开「历史」子页 | 10 条倒序，4xx/5xx 整行标红；页头「最近 N 条 · X ms」 | `viewHistory` |
| 停在历史页再发一次 | 视图**不被顶走**，新行自己出现 | `respView!=='history'` 守卫 |
| 删掉 `# @interface_id` 再发 | 顶部问「要不要接回旧历史（N 条）」，点「接回」后 id 换回、历史合并 | `findByIdentity` / `reuse` |
| 发一个图片接口 | 同目录出现 `<id>-<at>.bin`，jsonl 里只有 `bodyRef/bodyEncoding/bodyBytes` | 宿主无二进制写，`.bin` 里是 base64 |
| 看 `_history/_meta.json` | `formatVersion: 1`、`app: com.warren.polaris.api` | 只建不覆盖 |
| `git status` | `_history/` 被忽略（`.gitignore` 自动补了一行） | `ensureGitignore` |

> 想验证「更新版本只读」：把某个 jsonl 的第一行改成 `"v":2` 再发一次——应出现黄条、状态栏说「本版只读」，且文件一个字节都不动。

## 6. 取消与大响应（★）

| 做什么 | 应该看到 | 不对时看哪 |
|---|---|---|
| 找一个能慢慢吐的接口（或本地 `python3 -m http.server` 拖一个大文件） | 按钮变「停止」，耗时在跳 | `doStop` |
| 下载到一半点停止 | **立刻**变「已手动中断」，按钮复原；1–2 秒内后端日志出现 `request cancelled at N bytes` | `_cancel/<rid>.flag` 是否在 `_cancel/` 下生成又被删 |
| 再发一次 | 正常返回，不会被上次的标志误杀 | 发车前清残留标志 |
| 把超时设成 500 ms 打一个慢接口 | 约 500 ms 报超时，不是卡死 | `timeoutMs` |

## 7. 收尾

```bash
cd warren-polaris-api
git status --short      # 应为空；_history/、_results/ 都不该进仓库
node tools/all.mjs      # 14 个文件全绿
```

---

## 跑完之后：三个待定项，用真实感受拍板

跑的时候顺手留意这三件事，别专门去测：

1. **浮层高度**：在你自己常用的窗口尺寸下，改 `.http` 时是不是「上半屏不够写、下半屏浪费」？
   记下当时的窗口大小与你想要的形态（铺满插件面板 / 只加高一点 / 维持原样）。
2. **大图 / 大文件**：找一个 **5 MB 以上**的响应（图片、PDF、zip），看历史里的 `.bin` 有没有落、
   点历史行会不会卡。这决定 `.bin` 要不要卡 5 MB。
3. **停止文案**：读到「已通知后端断开，正在传输的响应不会再读下去」时，第一反应是「清楚了」还是「太技术」？
   记下你希望的口气（比如只要「已停止」）。

把这三条的感受连同验收结果贴回来，就能定 1.0.0 的最后一版改动。
