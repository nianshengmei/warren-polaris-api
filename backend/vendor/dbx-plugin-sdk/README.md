# dbx-plugin-sdk（vendored）

这是 DBX 官方 Rust sidecar SDK 的**原样副本**，放在仓库里只为一件事：让
`cd backend && cargo build --release` 在**任何一台干净机器**上都能直接编译通过。

## 为什么不走 crates.io

`dbx-plugin-sdk` 没有发布到 crates.io（`https://index.crates.io/db/xp/dbx-plugin-sdk` → 404）。
之前本地构建靠一条隐式约定：

```bash
cargo build --release --config 'patch.crates-io.dbx-plugin-sdk.path="/root/dbx-sdk"'
```

这条命令只在「那台机器上刚好有一份 SDK 副本」时成立。换台机器 —— 包括 GitHub Actions
的 runner 和用户的 Windows 笔记本 —— 都会在 `cargo build` 第一步报
`no matching package named dbx-plugin-sdk found`。0.9.0 要发 Windows 和 macOS 包，
这条隐式依赖必须先拆掉。

## 来源与同步

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/t8y2/dbx` → `plugins/sdk/rust/dbx-plugin-sdk` |
| 版本 | `0.1.0`（见 `Cargo.toml`） |
| 许可证 | Apache-2.0（与上游一致，本仓库也是 Apache-2.0） |
| 改动 | 仅一处：删掉 `Cargo.toml` 里的 `[workspace]`（它作为 path 依赖嵌进来时会和 backend 的 workspace 冲突，cargo 报 `multiple workspace roots`）。`src/lib.rs` 逐字节原样 |

升级 SDK 时：把上游同名目录的两个文件（`Cargo.toml`、`src/lib.rs`）覆盖过来，
跑 `node tools/all.mjs` 与 `cargo build --release`，两项都绿才算同步完成。

> 协议本身（JSON-RPC over stdio、8 MiB 单消息上限）就是这层 SDK 定的，
> 所以它和插件后端是强绑定的。**锁版本比追新更重要** —— 升级要单独做一轮回归。
