# 对 #557 审查意见的回应（1.0.0 重新提交）

先交代一件事，避免误解：**#557 不是被拒绝，是我们自己撤下的 0.6.4**。当时（11-20）你提的四条我们已经改完并推上去了，
但紧接着我们发现 0.6.x 的数据模型（storage 单键 JSON + `results/*.json`）是过渡形态——一旦有人装上开始攒历史，
1.0.0 改文件真源时就得替用户搬家。既然如此，就没必要让一份要换掉的东西先过签。那版候选**从未签名、从未进 catalog**，
所以现在没有任何用户需要迁移。这次是第一次请签。

## 四条整改，逐条对应

| 上次要求 | 1.0.0 的做法 | 怎么验 |
|---|---|---|
| ① 图标换新，不能同字节同图 | 青绿纸页 + 折角 + 琥珀 ▶ 徽章，与上游的紫蓝横线板无关 | `assets/plugin.svg@v1.0.0` sha256 `e34d0e21…`；上游 `com.polaris.api/0.2.0/icon.svg` 是 `725948b8…`，字节与画法都不同 |
| ② 描述改写、明示 fork | 列表名 `HTTP File Client (.http)`（上游叫 `polaris-api`）；英文描述第一句就是「community fork … this is not an update to the upstream plugin」 | `candidates/com.warren.polaris.api.json` 的 `description` 与 `localizations.zh-CN.description` |
| ③ 版本说明注明派生自 v0.2.0 | releaseNotes 首段明写派生自 misxzaiz `polaris-api v0.2.0`，并写了「版本号是本 fork 自己的历史，与 0.2.0 不可比」 | `releaseNotes` |
| ④ 包内补 LICENSE + 派生署名 | `[package].include` 里加了 `LICENSE`、`NOTICE`；`NOTICE` 保留上游版权、写明基线 v0.2.0、列出改动清单（Apache-2.0 §4） | 解开任一 target 的包，根目录有 `LICENSE` 与 `NOTICE` |

## 关于「29 小时跳 13 版」

那确实是我这边的问题：当时在快速迭代，版本号随手就加了。这次不一样——**0.6.4 撤下到 1.0.0 是三天、一个版本**，
1.0.0 是给这个 fork 自己定的功能收口（此后只修 bug，不再加功能）。版本号的用意从来不是压过 `0.2.0`：
本 fork 的历史是 `0.1 → 1.0.0`，与上游那条线没有可比关系，描述和 releaseNotes 里都写明了。

## 为什么不是换皮：上游停更之后的东西

上游最后一次提交是 `dc4c324`（2026-10-30），最后一个 release 是 `v0.2.0`（11-01 上架）。这之后的工作只在这个 fork 里：

- **文件即真源**：`.http` 文件就是唯一真源，`wpa-workspace.json` 只决定挂哪些文件，不扫盘、不另存一份状态。
  同一份文件在 IDEA / VS Code / DBX 打开是同一批请求。
- **原位编辑 + 自动保存**：语法高亮、JSON 折叠、请求目录、可收起浮层；保存只替换那一个请求的段落
  （其余段字节不变），先写临时文件再 rename；发现文件被外部改过就报冲突而不是覆盖。
- **接口身份与历史**：`# @file_id` / `# @interface_id` 是普通注释（别的工具直接忽略），
  用来给每个请求一个稳定身份；`_history/` 每接口留最近 10 条，`_results/` 每接口留最近 10 份完整请求/响应快照，
  历史面板能点开「当时那次」的完整往返。
- **WebSocket**：连接 / 发送 / 帧列表，与 HTTP 共用同一个 tab；另有 multipart 原样字节文件分片、SSE 流式响应。
- 规模与验证：79 个提交、UI + sidecar 约 12k 行、15 个单测文件 / 68 条静态断言 / 30 个真浏览器 e2e 脚本，tag 上全绿。

## 共存

插件 id、storage 命名空间都与上游不同，两个可以同时装；不写上游任何 key。唯一共享的是 `.http` 格式本身，
而身份注释是普通 `#` 注释，上游读到只会当注释忽略。若有本机开过「允许安装未签名包」装过 0.6.x，
1.0.0 首次启动会把旧 storage 里的数据一次性迁成 `.http` 文件（幂等；目标文件已存在时旧数据留档到 `.warren-migrate/`，绝不覆盖）。

## 本次提交范围

- `publishers/warren.json`（首发）
- `candidates/com.warren.polaris.api.json`（1.0.0，5 个 target：darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 / windows-x64）
- `automation/plugin-sources.json` 加一行 `nianshengmei/warren-polaris-api`（`autoUpdate: true`，元数据取 `.dbx-store.json`）

`plugins/` 与 `catalog/` 没有手改。需要的话我可以补 `windows-arm64`（CI 现在只出这五个）。

CI 起来后 Validate 会按设计报 `open candidate(s) awaiting DBX Store signing`，麻烦你跑一次 `/sign`。
