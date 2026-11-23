## Plugin submission

- Plugin ID: `com.warren.polaris.api`
- Version: `1.0.0`
- Publisher ID: `warren`

## Source repository and tag

https://github.com/nianshengmei/warren-polaris-api — tag `v1.0.0` (commit `0b45180`), release `v1.0.0`, five unsigned targets built by GitHub Actions.

## What it is

A file-first `.http` / `.rest` client: the file on disk is the only source of truth (`wpa-workspace.json` only decides which files are mounted), edited in place with syntax highlighting, JSON folding, a request outline and autosave that replaces a single request paragraph instead of rewriting the file. One-click ▶ per request through the bundled reqwest sidecar; per-interface history (`_history/`, last 10 calls) and full request/response snapshots (`_results/`, last 10 per interface); multipart bodies with byte-exact parts, SSE streams, WebSocket sessions.

## Relationship to the listed `com.polaris.api` (review on #557)

#557 asked for four changes; all four are in 1.0.0. The 0.6.4 candidate that first carried them was **withdrawn by us** (never signed, never listed) because it still used the transitional 0.6.x data model. 1.0.0 is the first candidate we ask to sign; nothing has to be migrated for existing users.

| Ask on #557 | Status | Where |
|---|---|---|
| New icon, distinct from upstream | Teal page + fold + amber ▶ (`e34d0e21…` vs upstream `725948b8…`) | `assets/plugin.svg@v1.0.0` |
| Rewrite description, state fork | First sentence: community fork, not an update, independent version line | `description` / `zh-CN.description` |
| Note derivation from v0.2.0 | First release-note line, incl. versions not comparable | `releaseNotes` |
| LICENSE + attribution in package | `LICENSE` and `NOTICE` at package root (Apache-2.0 §4) | unzip any target |

Version numbers are this fork's own history (`0.1 → 1.0.0`) and cannot be compared to upstream `0.2.0`; this is one release over three days, not a burst of bumps.

## Why it exists

Upstream's last commit is `dc4c324` (2026-10-30) and its last release is `v0.2.0`. Everything above was built after that, only in this fork.

## Permissions, data access, network

- `host.storage` — window state, last folder, panel sizes. `host.events` — streamed chunks, WS frames, cancellation.
- Files: the `.http` files in the mapping, user-picked multipart files; writes the same file on save, `wpa-workspace.json`, `_history/`, and snapshots in the plugin data dir.
- Network: only hosts in the requests the user sends. No telemetry, no update check.

## Native sidecar behavior

Rust binary over stdio JSON-RPC (reqwest + tungstenite). No listening sockets, no shell commands, no telemetry; outbound HTTP(S)/WS(S) only to user-specified URLs; cancels in-flight requests and streams; WS frames capped at 1 MiB.

## License

Apache-2.0. Derivative of `misxzaiz/polaris-api` v0.2.0; upstream notices kept, changes listed in `NOTICE`.

## Homepage

https://github.com/nianshengmei/warren-polaris-api

## Confirmation

- [x] Candidates are unsigned and match the disclosed source tag.
- [x] No private keys, tokens, credentials or proprietary data.
- [x] Candidates are in `candidates/com.warren.polaris.api.json`; `plugins/` and `catalog/` were not edited.
