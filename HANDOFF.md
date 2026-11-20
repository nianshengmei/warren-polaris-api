# 交接单 · warren-polaris-api v0.9.0 → 1.0.0

> 这份文档是给"另一台电脑上的新会话"看的。**它没有上一轮的对话记忆**，
> 所有判断依据都在这里和 `docs/plan-v1.0.0.md` 里。读完这份就能接着干活。
>
> 生成时间：2026-11-20 16:10（Windows 侧中断点）

---

## 0. 一句话现状

1.0.0 的 **M1（文件真源）+ M2（双视图）已完成**，`S2.5a/b/c/d + S2.6 + S3.1` 全绿，
**下一步是 M3 交互的 S3.2 字号缩放**，之后是 S3.3 → M4 → M5 → M6 → M7。
S3.1 于 2026-11-20 收官：按住标题条拖浮层，位置落偏好，双击复位，拖出边界自动夹回。

---

## 1. Mac 上怎么接上（按顺序做）

```bash
# 1) 先确认 node 够新（无 npm 依赖，只用内置模块；但 node:test 需要 18+）
node -v        # 需要 >= 18，建议 22

# 2) 在 WorkBuddy 里新建一个任务（会自动生成 ~/WorkBuddy/<日期时间>/ 目录），
#    把 zip 里的这三个目录解压到该工作区根下，保持同级：
#      warren-polaris-api/   verify-ui/   dev-workspace/
#    再把 .workbuddy/memory/ 解压到该工作区的 .workbuddy/ 下
#    （Mac 上双击用「归档实用工具」解压即可；包内中文文件名的 UTF-8 标志已校验过）

# 3) 自检：应当全绿，且 git 历史 20 个提交都在
cd warren-polaris-api
git log --oneline | head -3      # 应为 2a0e263 S2.5c ...
git status --short               # 应为空（或只有 HANDOFF.md）
node tools/all.mjs               # 11 个文件全绿

# 4) 起本地调试环境，浏览器打开 http://127.0.0.1:8899
node dev/dev-server.mjs
```

**为什么必须保持 `warren-polaris-api` 与 `verify-ui` 同级**：
`verify-ui/check-*.mjs` 里写的是 `path.resolve(..., '..', 'warren-polaris-api')`，
靠的是相对位置，不是绝对路径。

> **⚠ 仓库里没有的东西**：`verify-ui/`（七个端到端脚本）和 `dev-workspace/` 一直放在项目目录**外面**，
> 从来没进过 `nianshengmei/warren-polaris-api`。所以：
> - 只想接着写代码 / 跑 `node tools/all.mjs` → `git clone` 就够，什么都不缺；
> - 要跑真浏览器验收（`check-s25*.mjs`）→ 得从迁移包 `polaris-handoff-20261120.zip` 里
>   取 `verify-ui/` 和 `dev-workspace/`，放到与 `warren-polaris-api` 同级。
>   `dev-workspace` 缺失时代码会自己种一份，只是侧栏初始状态跟现在不同。

**新会话开场白建议直接说**：
> 读 `warren-polaris-api/HANDOFF.md` 和 `docs/plan-v1.0.0.md`，从 M3 的 S3.2 开始。口径不许改。

---

## 2. 硬口径（用户纠正过两次，不可回退）

这三条是这一轮反复被强调的，**任何"改进"都不能破坏**：

1. **目录树 = 映射文件的渲染。只认 `wpa-workspace.json`，一个目录都不扫。**
   磁盘上有但没登记的文件不显示，也不做"发现未登记"。
2. **打开 `.http` 这个动作本身就是挂载。** `openPath` 读成功后追加登记（`POLARIS_DOCS.register`），
   这是往侧栏加文件的**唯一**途径。不要造"资源文件夹""扫描导入"之类的东西。
3. **初始 demo 必须一开机就在侧栏里。** `ensureDefaultSample` 两个分支都要 register
   （包括老用户有 `prefs.lastPath`、走不到 `openPath(sample)` 的那条分支）。

映射文件只记「路径 → 归属文件夹 + 顺序」，不记请求/名字/内容 —— 它丢了最多让文件从侧栏消失，
文件本身不受影响。**这是安全边界，别往映射里塞冗余数据。**

---

## 3. 已完成（别再重做）

| 里程碑 | 状态 | 落点 |
|---|---|---|
| S1.0–S1.5 文件真源 | ✅ | `ui/http-file.js` `ui/http-store.js` `app.js` 的 DOCS 层 / 投影层 |
| S2.1 段落级写回 | ✅ | `locateSegment`，只改目标字段，其余字节不变 |
| S2.2 反向刷新 + 冲突 | ✅ | `syncTabsWithDocs` + `baseMtime` + `#docConflict` |
| S2.3 双向跳转 | ✅ | `</>` 表单→源码，`▤` 源码→表单 |
| S2.4 变量统一 | ✅ | 表单侧改走 `POLARIS_HTTP.resolveDeep`；环境以 `http-client.env.json` 为真源 |
| S2.5a 映射层 | ✅ | `ui/workspace-map.js`（`POLARIS_MAP`），无任何扫目录函数 |
| S2.5b 侧栏文件夹树 | ✅ | `renderSidebarMapped / renderFolderNode / renderMapFile` |
| S2.5c 浮层去文件树 | ✅ | 浮层只剩「接口一览 + 源码」，顶栏「≡ 接口一览」是唯一开关 |
| S2.5d 归位与排序 | ✅ | 文件行拖拽：文件夹头归入 / 上下半区插前后 / 根区退回根，全走 `POLARIS_MAP.moveTo` + `saveWorkspaceMap()`，只改映射不动文件；请求级同文件调序 = 整段搬移（`store.moveSegment`），跨文件仍留 1.0.1。`verify-ui/check-s25d.mjs` 23 项 |
| S3.1 浮层拖拽 | ✅ | 标题条拖动 → `--fe-dx/--fe-dy` 位移（不改 left/top，宽度不会被压变形），rAF 合帧 + `setPointerCapture`；整块夹在 `.work` 内，双击标题条归零；`feX/feY` 落偏好、启动恢复、缩放后重夹。顺带把 `.work` 的 `overflow:hidden` 改 `overflow:clip`（原来会变成可滚容器，scrollLeft 被顶偏 26px 导致浮层整体错位）。`verify-ui/check-s31.mjs` 20 项 |
| S2.6 示例自动挂载 | ✅ | 含 `POLARIS_MAP.save` 并发写修复（tmp 名唯一 + 串行） |

测试现状（改完必须保持）：
- `node tools/all.mjs` → 11 文件全绿（`verify.mjs` 50 项、`map.test.mjs` 22 项、`store.test.mjs` 31 项等）
- `verify-ui/` 九个端到端：s15=17、s22=29、s23=20、s24=10、s25=21、s25c=21、s25d=23、s26=8、s31=20

---

## 4. 下一步：M3 交互 · S3.2 字号缩放

> 目标：`Ctrl` + 滚轮改编辑器字号 12–28px，textarea / 行号 / 高亮三层不错位；`Ctrl+0` 复位。
> 验收：缩到 28px 时随便点一行，光标位置与文字对得上（错位是本步唯一的失败形态）。

改动落点：`ui/http-editor.js` 的 `injectCss`（浮层样式其实都在这儿，不在 `ui/app.css`）——
加 `--pa-fs` 并让 `.pa-fe-text` / `.pa-fe-ln`（行号）/ `.pa-fe-hl` 三处同源引用；
`LINE_H` / `PAD_TOP` 两个常量与 CSS 联动，`syncGutter`、`syncScroll`、光标行归属都依赖行高，
改字号时必须一起换算，否则就是「三层错位」。`Ctrl+0` 复位到默认字号；字号落偏好。

之后按 `docs/plan-v1.0.0.md` 顺序：**S3.3 身份行配色 → M4 身份与历史 → M5 示例与文档 → M6 取消 → M7 冻结发版**。

---

## 5. 待用户拍板（**别自己决定，问**）

1. `.pa-fe` 浮层偏矮，是否加「⤢ 铺满」按钮？
2. 历史保留条数：3 / 10 / 30？
3. 二进制响应（`.bin`）单文件 5 MB 上限是否合适？
4. 后端 4 个新命令**只在 Mac/Linux 侧编译验证过吗**——若是，需等 CI 或本机 `cargo` 跑一次。
   Windows 侧没有 `cargo`，产物一直靠 GitHub Actions 构建。

---

## 6. 发版口径（v0.6.x 之后换新序列）

- 版本号：`0.9.0` 当前值，**1.0.0 留待 UX 验收后再定**。之后每次发版 patch 递增（`v1.0.1`、`v1.0.2`…）。
- 发版要同步的版本位：`manifest.json`、`backend/Cargo.toml`、`backend/Cargo.lock`（`dbx-plugin-warren-polaris-api`）、
  `.dbx-store.json` 的 `releaseNotes`、README 版本历史、`tools/verify.mjs` 的 `const VERSION`。
- 派生自上游 `misxzaiz/polaris-api` **v0.2.0**，**承诺不再同步上游任何代码**；1.0.0 要把这句写进 README「许可与署名」与包内 `NOTICE`。
- `v0.6.4` 的商店 PR #557 **已决定撤回**，等 1.0.0 数据格式冻结后一次性上架。

---

## 7. 跨平台迁移会踩的坑（已经踩过）

| 坑 | 处理 |
|---|---|
| `verify-ui/check-*.mjs` 里 `const CHROME = 'C:/Program Files/...'` 是 Windows 硬编码 | Mac 改成 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `verify-ui/node_modules`（playwright-core）是 Windows 装的 | **没打进包里**，Mac 上 `cd verify-ui && npm i playwright-core` |
| 仓库内全是 LF（`i/lf w/lf`），本机 `core.autocrlf=true` | Mac 上设 `git config core.autocrlf input`，否则可能整树显示 modified |
| `tools/fixtures/messy.http` 必须是 CRLF（436 字节），但 blob 里存的是 LF | 已加 `.gitattributes` 指定 `text eol=crlf`；缺了它 Linux/Mac 上 `fixtures` / `store` 两个测试会红 |
| `check-s15/s22/s23.mjs` 里 `ROOT` 曾硬编码成 Windows 工作区绝对路径 | 已改成 `path.resolve(..., '..', 'warren-polaris-api')`，与其余脚本一致；`CHROME` 也改为按平台解析（可用 `CHROME=` 覆盖） |
| 本机 `git push` 常 502 | 推送技巧在 `tools/push-one.mjs`（走 REST），token 用 `git credential fill` 取、用完删 |
| 无 `package.json`、无 npm 依赖 | 不需要 `npm install`；测试与 dev server 都是 `node xxx.mjs` 直跑 |

---

## 8. 怎么拿到代码（二选一）

**A. GitHub（首选，2026-11-20 已推送）**

```bash
git clone https://github.com/nianshengmei/warren-polaris-api.git
cd warren-polaris-api && git log --oneline -1   # 应能看到 a500446 及其后的 S2.5d 提交
```

代码、20 个提交的历史、本交接单全都在这。缺的只有 `verify-ui/` 和 `dev-workspace/`（见第 1 节）。

**B. 迁移包（离线备份 / 补 verify-ui 用）**

```
polaris-handoff-20261120.zip   （6.0 MB，714 条目，已校验 UTF-8 文件名）
├── warren-polaris-api/     完整项目，含 .git
├── verify-ui/              端到端脚本（不含 node_modules，Mac 上 npm i playwright-core）
├── dev-workspace/          调试目录（含 wpa-workspace.json 与两个 .http）
└── .workbuddy/memory/      工作日志 + 长期约定（值得读 2026-11-20.md）
```

**关于对话历史**：`~/.workbuddy/projects/<cwd-hash>/*.jsonl`（24 MB）**不能跨机器 resume** ——
目录名是工作区路径算出来的 hash，换机器就挂不上新会话。想查原话的话，拷
`C:\Users\yanming\.workbuddy\projects\c-Users-yanming-WorkBuddy-2026-11-18-13-25-59\58f84e70-*.jsonl`
过去 grep 即可；正常接手读本文件就够。
