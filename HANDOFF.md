# 交接单 · warren-polaris-api v0.9.0 → 1.0.0

> 这份文档是给"另一台电脑上的新会话"看的。**它没有上一轮的对话记忆**，
> 所有判断依据都在这里和 `docs/plan-v1.0.0.md` 里。读完这份就能接着干活。
>
> 生成时间：2026-11-20 16:10（Windows 侧中断点）

---

## 0. 一句话现状

1.0.0 的 **M1（文件真源）+ M2（双视图）已完成**，`S2.5a/b/c + S2.6` 全绿，
**下一步是 `S2.5d 归位与排序`**，之后是 M3 → M4 → M5 → M6 → M7。
代码全部提交在本地 `main`（20 个提交未推送），工作树干净。

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

**新会话开场白建议直接说**：
> 读 `warren-polaris-api/HANDOFF.md` 和 `docs/plan-v1.0.0.md`，从 S2.5d 开始。口径不许改。

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
| S2.6 示例自动挂载 | ✅ | 含 `POLARIS_MAP.save` 并发写修复（tmp 名唯一 + 串行） |

测试现状（改完必须保持）：
- `node tools/all.mjs` → 11 文件全绿（`verify.mjs` 48 项、`map.test.mjs` 22 项等）
- `verify-ui/` 七个端到端：s15=17、s22=26、s23=20、s24=10、s25=21、s25c=21、s26=8

---

## 4. 下一步：S2.5d 归位与排序

> 目标：把外部文件拖进文件夹、文件夹内调顺序（写回映射）；恢复 S1.5 因"文件真源"暂停的**请求级拖拽**。
> 验收：拖完 `wpa-workspace.json` 变了；重启后顺序还在。

已有原语（**直接用，别新写**）：`POLARIS_MAP.moveTo / relocate / unregister / addFolder`。
渲染侧要动 `renderSidebarMapped` 的拖拽事件；注意 `.gact`（`</>` 按钮）的 `pointerdown` 不触发折叠，
拖拽 handler 也要跳过它。

之后按 `docs/plan-v1.0.0.md` 顺序：**M3 交互（S3.1 浮层拖拽 / S3.2 字号 / S3.3 身份行配色）→ M4 身份与历史 → M5 示例与文档 → M6 取消 → M7 冻结发版**。

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
| 本机 `git push` 常 502 | 推送技巧在 `tools/push-one.mjs`（走 REST），token 用 `git credential fill` 取、用完删 |
| 无 `package.json`、无 npm 依赖 | 不需要 `npm install`；测试与 dev server 都是 `node xxx.mjs` 直跑 |

---

## 8. 包里有什么

```
polaris-handoff-20261120.zip
├── warren-polaris-api/     完整项目，含 .git（20 个提交，工作树干净）
├── verify-ui/              端到端脚本（不含 node_modules，Mac 上重装）
├── dev-workspace/          本地调试用的示例目录（含 wpa-workspace.json 与两个 .http）
└── .workbuddy/memory/      三天的工作日志 + MEMORY.md（长期约定，值得读 2026-11-20.md）
```

同目录另有 `verify-zip.mjs`（我用来核对包内条目名编码的脚本，可删）。

**关于对话历史**：`~/.workbuddy/projects/<cwd-hash>/*.jsonl`（24 MB）**不能跨机器 resume** ——
目录名是工作区路径算出来的 hash，换机器就挂不上新会话。想要原文只当资料查的话，
拷 `C:\Users\yanming\.workbuddy\projects\c-Users-yanming-WorkBuddy-2026-11-18-13-25-59\58f84e70-*.jsonl`
过去 grep 即可；正常接手读本文件就够。
