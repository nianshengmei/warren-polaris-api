# 商店提交状态（com.warren.polaris.api）

## 事实更正：#557 没有被关闭

2026-11-23 查得 `t8y2/dbx-store#557` 仍是 **open**（2 commits，head `9b0f574`，只含 0.6.4 候选），
`Validate catalog` 一直是 `action_required`——维护者从未批准跑 CI，也从未 `/sign`。
商店 catalog 里没有 `com.warren.polaris.api`，所以**这个包从来没有用户拿到过**。
我们这边也关不掉它：细粒度 PAT 对 `t8y2/dbx-store` 没有写权限（`PATCH pulls/557` → 403）。

## 本次（1.0.0）做了什么

| 项 | 内容 |
|---|---|
| 提交分支 | `nianshengmei/dbx-store` → `submit/com.warren.polaris.api-1.0.0`，head `aaef951`，基于上游 main `dffd4cd`（compare 结果：ahead 1 / behind 0，无冲突） |
| diff | 3 文件 +75/−0：`publishers/warren.json`、`candidates/com.warren.polaris.api.json`、`automation/plugin-sources.json`（+5，仅登记源） |
| 本地校验 | `node scripts/validate.mjs` → 唯一 error 为 "1 open candidate awaiting signing"，即预期红 |
| 候选 | 5 target，sha256/size 取自 v1.0.0 release 资产 digest，与 `release-candidates.json` 交叉一致 |
| 元数据 | `.dbx-store.json` 已改到 1.0.0（列表名 `HTTP File Client (.http)`、描述首句声明 fork、releaseNotes 写明派生自 v0.2.0） |
| PR 正文 | `PR_BODY_1.0.0.md`：按 `PULL_REQUEST_TEMPLATE.md` 的八个标题逐段填（Plugin submission / Source / Capabilities / Permissions / Native sidecar / License / Homepage / Confirmation），并加一节把 #557 的四条要求对应到具体文件 |

## 还差点一下的事：PR 建不了，是权限不是脚本

- 细粒度 PAT 对 `t8y2/dbx-store` 的权限实测为 `pull: true, push: false`；
  `POST /pulls` 与 GraphQL `createPullRequest` 都是 `403 Resource not accessible by personal access token`。
  这不是漏授权项——GitHub 要求「在别人的仓库里建 PR」必须对该仓库有写权限，非协作者拿不到。
- 换成 **classic PAT（勾 `public_repo`）** 即可由脚本一次做完：建 PR → 在 #557 评论 superseded（作者可评论）
  → 关闭 #557（PR 作者可关自己的 PR）。沙箱浏览器访问 github.com 被网络策略拦截（403 Forbidden），网页路线也走不通。
- 不想给新 token 的话，`PREFILL_URL.txt` 是同一份正文的预填链接，点开就是「Create pull request」。


## 后续版本注意

- 商店同步器（`scripts/discover-plugin-releases.mjs`）只取**最新的**正式 release：
  在 `releases?per_page=30` 里找第一个非 draft / 非 prerelease、且带 `release-candidates.json` 资产的，
  然后去 **那个 tag 上**读 `.dbx-store.json`。所以只有「最新 tag」的文案会被商城看到，旧 tag 不影响。
- 2026-11-23 修过一次：`v1.0.0` 原指向 `0b45180`，而 1.0.0 文案的提交 `da51d08` 在它之后，
  同步器会拿到「版本 1.0.0 / 更新说明写着 0.6.4」的条目。已把标签移到 `622eb91`
  （只多两个检查脚本提交，5 个 `.dbxp` 资产与 sha256 未变，候选 JSON 不用改）。
- 现在 `tools/store-meta.mjs` 会拦这类错位：`--tag vX.Y.Z` 校验 tag 快照，
  `tools/all.mjs`（16 个文件）跑 HEAD 档，发版工作流的 `guard` 作业先跑 `--tag`，对不上就不打包。
- 以后发新版：`node tools/store-meta.mjs --tag v新版本` 先过一遍 → 打 tag → publish release（资产里要有 `release-candidates.json`）
  → 同步器下一小时自动开 PR；已列版本会跳过，不会覆盖。
