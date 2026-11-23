## Plugin submission

- Plugin ID: `com.warren.polaris.api`
- Version: `1.0.0`
- Publisher ID: `warren`
- Files in this PR: `publishers/warren.json` (new), `candidates/com.warren.polaris.api.json` (new), and one entry added to `automation/plugin-sources.json` so later releases of this plugin arrive as catalog PRs instead of being submitted by hand each time. `plugins/` and `catalog/` are untouched.

## Source repository and tag

https://github.com/nianshengmei/warren-polaris-api — tag `v1.0.0` (commit `622eb91`), release `v1.0.0`. All five unsigned targets were built by GitHub Actions from that tag; the `sha256`/`size` values in the candidate pin those exact bytes. `LICENSE` and `NOTICE` are at the package root.

## Capabilities and user workflow

A file-first `.http` / `.rest` client. The file on disk is the only source of truth; a `wpa-workspace.json` next to it decides only which files are mounted, so the same file opened in IDEA, VS Code or DBX holds the same requests.

- In-place source editing with syntax highlighting, JSON folding, a request outline and autosave. Autosave writes atomically and replaces a single request paragraph — the rest of the file is never rewritten, and a concurrent external edit aborts the save instead of clobbering it. The caret in the editor lands on the character you see (the highlight layer does not change glyph advance).
- One-click ▶ per request, sent through the bundled reqwest sidecar. Per-interface call history in `_history/` (last 10 calls) and full request/response snapshots in `_results/` (last 10 per interface, older ones rotated); opening an entry whose snapshot was rotated away says so instead of failing.
- `multipart/form-data` with byte-exact file parts, streamed `text/event-stream` responses, and WebSocket sessions in the same tab as HTTP.

## Relationship to the earlier 0.6.3 submission (#557)

#557 asked for four changes. All four are in 1.0.0; the 0.6.4 candidate that first carried them was **withdrawn by us** (never signed, never listed) because it still used the transitional 0.6.x data model — 1.0.0 is the first candidate we ask to sign, so nothing has to be migrated for users, of whom there are none yet.

| Ask on #557 | Status | Where |
|---|---|---|
| New icon, distinct from upstream | Teal page + fold + amber ▶ (`e34d0e21…`, upstream is `725948b8…`) | `assets/plugin.svg@v1.0.0` |
| Rewrite description, state the fork | First sentence: community fork, not an update, independent version line | `description`, `zh-CN.description` |
| Note derivation from v0.2.0 | First release-note line, including that versions are not comparable | `releaseNotes` |
| LICENSE + attribution inside the package | `LICENSE` and `NOTICE` at package root (Apache-2.0 §4), NOTICE keeps the upstream copyright | unzip any target |

On the version numbers: `0.1 → 1.0.0` is this fork's own history, not comparable to upstream `0.2.0`, and it is one release over three days rather than a burst of bumps. From here it is feature-frozen; fixes only.

## Permissions, data access, and network access

Manifest permissions: `host.storage` (window state, last folder, panel sizes) and `host.events` (streamed chunks, WebSocket frames, cancellation).

- Files: reads only the `.http` files in the mapping plus multipart files the user picks; writes the same `.http` file on save, `wpa-workspace.json` in the same folder, `_history/`, and snapshots in the plugin data directory.
- Network: only the hosts of the requests the user sends. No telemetry, no update check, no background traffic.
- Credentials: none stored. Variables in the file are plain text; no keychain access.

## Native sidecar behavior

Yes — one native executable per target: a Rust binary (`reqwest` + `tungstenite`) speaking JSON-RPC over stdio.

- No listening sockets, no shell commands, no child processes, no telemetry.
- Outbound HTTP(S) / WS(S) only to URLs from the user's own requests; in-flight requests and streams can be cancelled; WebSocket frames are capped at 1 MiB.

## License

Apache-2.0. Derivative of `misxzaiz/polaris-api` v0.2.0 (Apache-2.0); upstream copyright is kept in `NOTICE`, and the list of changes is recorded there as §4 requires.

## Homepage or support URL

https://github.com/nianshengmei/warren-polaris-api

## Confirmation

- [x] The candidate packages are unsigned and match the disclosed source tag.
- [x] I have not included private keys, tokens, credentials, or proprietary data.
- [x] The candidates are listed in `candidates/com.warren.polaris.api.json`; `plugins/` and `catalog/` were not edited manually.
