# dbx-plugin-sdk（vendored）

这是 DBX 官方 Rust sidecar SDK 的**原样副本**，放在仓库里只为一件事：让
`cd backend && cargo build --release` 在**任何一台干净机器**上都能直接编译通过。

## 它怎么被用上

这里有两套路径，**别混**：

| 场景 | 谁提供 SDK | 命令 |
|---|---|---|
| 官方发布构建（GitHub Actions） | `dbx-plugin` CLI 自带的 `sdk-root` | `dbx-plugin package .`（CLI 自己注入 patch + `--locked`） |
| 本地 / CI 裸构建（没有 CLI） | 本目录这份副本 | `cargo build --release --locked --config 'patch.crates-io.dbx-plugin-sdk.path="vendor/dbx-plugin-sdk"'` |

两条路都要求 `backend/Cargo.toml` 里写成 **版本依赖** `dbx-plugin-sdk = { version = "0.1.0" }`。
改成 path 依赖会让 CLI 注入的那条 patch 变成「未使用」，cargo 于是要重写 `Cargo.lock`，
而 CLI 又传了 `--locked` —— 直接报 `cannot update the lock file`，五个平台全红。
2026-11-21 的 v0.9.0 发布首跑就是这么挂的，别再改成 path。

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
