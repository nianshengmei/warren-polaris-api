## Plugin submission

- Plugin ID: `com.warren.polaris.api`
- Version: `1.0.0`
- Publisher ID: `warren`

## Source repository and tag

- Source: https://github.com/nianshengmei/warren-polaris-api
- Tag: `v1.0.0` (commit `0b45180`), release: https://github.com/nianshengmei/warren-polaris-api/releases/tag/v1.0.0
- Candidates were built by GitHub Actions (`plugin-release.yml` → `t8y2/dbx` reusable workflow, `dbx-plugin package .`), one unsigned `.dbxp` per target, five targets.

## Capabilities and user workflow

A `.http` / `.rest` file client that treats the file as the source of truth, not as an import format.

1. The user points the plugin at a folder; `wpa-workspace.json` in that folder lists the `.http` files to mount (no disk scanning). Opening a folder that has `.http` files but no mapping offers to create one; a bundled `examples.http` ships so the workbench is never empty.
2. Each mounted file opens as an in-place source editor: syntax highlighting, JSON folding, a request outline, a collapsible overlay panel, and autosave back to the same file. Saving replaces only the affected request paragraph (byte ranges outside it are untouched), writes through a temp file plus rename, and aborts with a conflict instead of overwriting when the file changed underneath.
3. Every request shows a ▶ on its first line; clicking it sends that request through the bundled Rust sidecar (reqwest), so CORS, mixed-content and forbidden-header limits do not apply. Response, status, headers and headers/timing render in the normal DBX response pane.
4. Per-interface history: `# @interface_id` / `# @file_id` are ordinary comments (other tools ignore them) that give each request a stable identity. Calls are recorded under `_history/`, last 10 per interface; full request/response snapshots go to `_results/`, last 10 per interface, older ones rotated away. The history panel can reopen the exact snapshot of a past call.
5. Beyond plain HTTP: `multipart/form-data` bodies with byte-exact file parts, streamed `text/event-stream` (SSE) responses, and WebSocket sessions (connect / send / frames) inside the same tab as HTTP.

## Permissions, data access, and network access

- `host.storage` — window state, last opened folder, editor/response panel sizes.
- `host.events` — streaming responses (SSE chunks, WebSocket frames, cancellation) back to the UI.

Filesystem: reads the `.http` files listed in `wpa-workspace.json` and files the user picks for multipart bodies; writes the same `.http` file on save, `wpa-workspace.json` when the mapping changes, `_history/` next to the opened files, and full snapshots in the plugin data directory (`results/`, configurable). No other paths.

Network: only the hosts in the requests the user sends, including WebSocket handshakes. No telemetry, no update check, no third-party endpoints. Environment values (`http-client.env.json`, `@var`) are substituted locally and never sent anywhere except in the request the user authored.

## Native sidecar behavior

Native sidecar: Rust binary `dbx-plugin-warren-polaris-api` (reqwest + tungstenite), one per platform, launched by the host over stdio JSON-RPC.

- No listening sockets or ports; no shell commands; no child processes other than none.
- Outbound HTTP/HTTPS and WS/WSS only to user-specified URLs; redirects followed as reqwest does by default.
- Allowed to cancel in-flight requests and streams; WebSocket frames are capped at 1 MiB, streamed bodies at 256 KiB per chunk with a time/size cap.
- Filesystem access limited to the paths above; no credentials read (no keychain, no env secrets beyond the variables the user defines in `http-client.env.json`).

## Relationship to the listed plugin `com.polaris.api`, and the previous review on #557

#557 asked for four changes before signing. All four are in this submission, and the 0.6.4 candidate that carried them was **withdrawn by us** (never listed, never signed) because it still used the transitional 0.6.x data model. 1.0.0 is the first candidate we ask to sign.

| Ask on #557 | Status in 1.0.0 | Where to check |
|---|---|---|
| New icon, clearly different from upstream | Teal page + folded corner + amber ▶ badge | `assets/plugin.svg` at `v1.0.0` (sha256 `e34d0e21…`), upstream icon at `com.polaris.api/0.2.0/icon.svg` is `725948b8…` — different bytes, different drawing |
| Rewrite the description, state the fork relationship | Listing name is `HTTP File Client (.http)`; first sentence says it is a community fork, not an update, with an independent version line | `candidates/com.warren.polaris.api.json` → `description` / `localizations.zh-CN.description` |
| Say in the release notes that it derives from upstream v0.2.0 | First release note line does exactly that, including that versions are not comparable | `releaseNotes` |
| Ship LICENSE + attribution inside the package | `[package].include = ["assets","ui","LICENSE","NOTICE"]`; `NOTICE` keeps the upstream copyright, names `polaris-api v0.2.0` as the base and lists the changes (Apache-2.0 §4) | unzip any target: `LICENSE` and `NOTICE` at the package root |

On the version-number point: this was never an attempt to outrank `0.2.0`. The fork's own history is `0.1 → 1.0.0`, and 1.0.0 is a self-imposed feature freeze. The gap between the withdrawn candidate and this one is three days with one release, not thirteen versions in 29 hours.

On necessity, for context: upstream's last commit is `dc4c324` (2026-10-30) and its last release is `v0.2.0` (listed 2026-11-01). The file-first workbench, history/results, WebSocket, multipart and SSE work since then exists only in this fork.

## Coexistence

Different plugin id and different storage namespace, so both can be installed side by side; nothing is written into upstream's storage keys, and upstream's settings/history are untouched. The only shared surface is the `.http` file format itself, and the identity comments are plain `#` comments that upstream ignores.

## License

Apache-2.0. Derivative of `misxzaiz/polaris-api` v0.2.0; upstream notices kept, changes listed in `NOTICE`.

## Homepage or support URL

https://github.com/nianshengmei/warren-polaris-api

## Confirmation

- [x] The candidate packages are unsigned and match the disclosed source tag.
- [x] I have not included private keys, tokens, credentials, or proprietary data.
- [x] The candidates are listed in `candidates/com.warren.polaris.api.json`; `plugins/` and `catalog/` were not edited manually.

---

### Reviewer quick checks

```bash
# candidate bytes match the pinned sha256/size
curl -L -o p.dbxp https://github.com/nianshengmei/warren-polaris-api/releases/download/v1.0.0/com.warren.polaris.api-1.0.0-linux-x64.dbxp
sha256sum p.dbxp   # da22fa5f156b292b584d5e81b6cab246981b3f76c57f5a0122272d7d4007acb9

# manifest identity matches the candidate, package root has LICENSE/NOTICE, no signature.json
unzip -l p.dbxp
unzip -p p.dbxp manifest.json | head -20
```

Build: 79 commits, ~12k lines of UI + sidecar Rust, 15 unit-test files, 68 static checks, 30 browser end-to-end scripts (all green on the tagged commit).
