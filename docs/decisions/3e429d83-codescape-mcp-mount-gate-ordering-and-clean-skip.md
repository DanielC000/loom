# 3e429d83 / 369dde3c / 088afc94 — the Codescape MCP mount's gate ordering is load-bearing, and it clean-skips on failure

## Narrative

Card C2 (Codescape wiring epic `369dde3c`), P4 REWRITE (card 088afc94): mounting the Codescape MCP is a per-PROJECT opt-in (NOT a profile capability grant, hence outside the `resolveProfileCapabilities` loop). `o.codescapeEnabled` is the RAW project flag — `isLoomDev()` is re-checked HERE (not pre-baked by the caller) so this pure seam can assert the LOOM_DEV-off negative case directly.

GATE ORDERING IS LOAD-BEARING (card 3e429d83) — keep the cheap checks (`o.codescapeEnabled`, `isLoomDev()`) first; don't reorder or hoist them behind `isCodescapeSupervisorEnabled`. `isCodescapeSupervisorEnabled` bottoms out in `resolveExecutable`, a SYNCHRONOUS walk of every PATH dir × PATHEXT extension (measured ~17-20ms on a real Windows PATH) — exactly the kind of blocking work the spawn hot path (`createPty` → `buildMcpServers`) must never do (see `CLAUDE.md`'s "no blocking work on the hot path" invariant).

TWO INDEPENDENT LAYERS keep that walk off the hot path for a normal spawn, not one: this outer ordering, AND `isCodescapeSupervisorEnabled` itself re-checking `isLoomDev()` before touching the filesystem (`paths.ts`). A regression has to defeat BOTH to actually reach `resolveExecutable`.

`test/pty-hot-path-no-path-walk.mjs` guards the INVARIANT — "no PATH walk on the hot path for a normal spawn" — not this specific ordering: it reddens on anything that actually causes the walk (e.g. removing/inlining `isCodescapeSupervisorEnabled`'s own `isLoomDev()` short-circuit, confirmed by fail-first testing), but it will NOT catch a reorder of just this outer gate — the inner short-circuit still prevents the walk, so that alone is harmless and the test correctly stays green. Keep this ordering as defense-in-depth anyway; just don't read the test's silence on a reorder as proof nothing changed.

P4: the per-session mount is now a streamable-HTTP entry pointed at the SHARED `codescape serve` process (`codescapeHttpMcpServer`) — no per-session spawn at all. This SUPERSEDES the C2/C3-era per-session stdio `codescape mcp --graph <graph.json>` process (which read a Loom-maintained snapshot file); that mechanism is gone. `isCodescapeSupervisorEnabled(dbPath)` (`isLoomDev()` AND a codescape CLI actually detected on the host) stays the daemon-wide master switch for the whole Codescape feature. `o.integrationPaths?.codescape` (the DB-persisted path) is passed through so THIS gate check honors the same DB-first precedence the supervisor's own detection uses — a daemon with the DB path set but no `LOOM_CODESCAPE_BIN`/bare-PATH binary still detects correctly.

Ruling (card 088afc94): when serve isn't up (`codescapePort` null) or `resolveCodescapeProjectId` can't resolve an id for this repo, this CLEAN-SKIPS — no stdio-snapshot fallback — a silent stale/absent mount masquerading as fresh is the exact defect this card exists to fix, and a permanent second code path is exactly the "weaker architecture" avoided by not duplicating codescape's own server-side staleness/single-flight machinery.

CR fix: the "serve down" vs "id unresolved" log warnings are split, not merged — both facts (port vs id) are already in hand at the call site, and `codescapeHttpMcpServer` checks port BEFORE id (see its own body), so a null result with a null port can ONLY be the serve-is-down case. The whole design premise of a clean skip is that it's distinguishable from a silent failure — a merged message defeats that for anyone reading the log, since "serve down" (self-heals once serve restarts) and "id unresolved" (self-heals once this repo is registered/ingested) point at different fixes.

## Do not

- Do not reorder or hoist `o.codescapeEnabled`/`isLoomDev()` behind `isCodescapeSupervisorEnabled` — that check bottoms out in a synchronous PATH walk that must never run on the spawn hot path. `test/pty-hot-path-no-path-walk.mjs` will NOT catch a reorder of just this outer gate (the inner short-circuit still saves it), so its silence is not proof nothing changed.
- Do not merge the "serve down" and "id unresolved" log warnings back into one message — they point at different self-healing fixes.
- Do not add a stdio-snapshot fallback for a failed Codescape mount — the clean skip (no mount) is deliberate; a fallback would reintroduce silent staleness.

## Source

Inline `//` comment block in `packages/daemon/src/pty/host.ts` (immediately above the Codescape MCP-mount `if (o.codescapeEnabled && o.repoPath)` block), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
