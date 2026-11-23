# 商店提交状态（com.warren.polaris.api）

## 事实更正：#557 没有被关闭

2026-11-23 查得 `t8y2/dbx-store#557` 仍是 **open**（2 commits，head `9b0f574`，只含 0.6.4 候选），
`Validate catalog` 一直是 `action_required`——维护者从未批准跑 CI，也从未 `/sign`。
商店 catalog 里没有 `com.warren.polaris.api`，所以**这个包从来没有用户拿到过**。
我们这边也关不掉它：细粒度 PAT 对 `t8y2/dbx-store` 没有写权限（`PATCH pulls/557` → 403）。

## 本次（1.0.0）做了什么

| 项 | 内容 |
|---|---|
| 提交分支 | `nianshengmei/dbx-store` → `submit/com.warren.polaris.api-1.0.0`，head `f8359f2`，基于上游 main `dffd4cd` |
| diff | 3 文件 +75/−0：`publishers/warren.json`、`candidates/com.warren.polaris.api.json`、`automation/plugin-sources.json`（+5，仅登记源） |
| 本地校验 | `node scripts/validate.mjs` → 唯一 error 为 "1 open candidate awaiting signing"，即预期红 |
| 候选 | 5 target，sha256/size 取自 v1.0.0 release 资产 digest，与 `release-candidates.json` 交叉一致 |
| 元数据 | `.dbx-store.json` 已改到 1.0.0（列表名 `HTTP File Client (.http)`、描述首句声明 fork、releaseNotes 写明派生自 v0.2.0） |

## 还差两步（需要你在网页点）

1. 开 PR：见 `PREFILL_URL.txt`（预填标题与精简正文；完整正文在 `PR_BODY.md`）。
2. 关掉 #557：在该 PR 里粘一句「superseded by #<新号>」，然后 Close。细粒度 PAT 做不到，只能你点。

开完 PR 后把 `REVIEW_REPLY.md` 贴到新 PR 评论里（中文，逐条对应上次四条整改 + 版本号节奏 + 上游停更证据）。
维护者批准 workflow 后，Validate 会按设计报 `open candidate awaiting signing`，接着 `/sign`，绿了才会合并。

## 后续版本注意

- 商店同步器读的是 **tag 上的** `.dbx-store.json`。`v1.0.0` 这个 tag 上的还是 0.6.4 文案，
  所以别让自动化去补发 1.0.0（已列版本会跳过，不会覆盖）。下一个 tag 起元数据才是新的。
- 已有版本不会重复上架；`1.0.0` 合并后再发新版只需新 tag + 新候选。
