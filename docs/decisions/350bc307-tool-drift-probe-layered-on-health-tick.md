# 350bc307 — tool-drift probe is a live `tools/list` round-trip, layered onto a successful health tick

## Narrative

`checkToolDrift` is the ONE live-introspection caller of `codescapeUnclassifiedTools` (`pty/host.ts`) — a real `tools/list` round-trip against the RUNNING mounted server, not just the two in-memory arrays it partitions. Layered onto a SUCCESSFUL health probe, mirroring `checkBuildDrift`'s own placement and discipline: async, bounded (`toolsProbeTimeoutMs`), best-effort, NEVER throws, and NEVER blocks a spawn/boot/gate (DoD-3 — fail soft) — a probe failure just means "couldn't check this tick," identical in effect to a probe that never ran.

It needs a resolvable Codescape PROJECT id to build the `/mcp/<id>` URL `probeAdvertisedTools` hits — `tools/list` is a property of the served MCP APPLICATION (which tools it registers), not of per-project graph DATA, so ANY currently-registered project id observes the same tool registration a genuinely drifted server would expose on every scope; this instance's own `projectIds` cache (populated by `registerProjectWithRetry` at boot) is reused rather than re-resolving anything. A no-args case (nothing registered yet) is a clean skip: nothing to probe against yet, not a failure.

On a successful round-trip, it ALWAYS persists the result via `writeToolDriftState` (even an EMPTY unclassified set) — so the state file's `checkedAt` stays fresh and a since-cleared drift doesn't linger stale in what `readCodescapeToolDriftNote` reads back. The in-memory `lastToolDriftUnclassified` latch exists purely so a TRANSITION logs once (a new/changed finding, or a recovery back to clean) rather than spamming this line every ~30s tick forever — the persisted file (read by the Platform Lead's kickoff note) is the real addressed signal; the console line is a supplementary breadcrumb, not the mechanism itself.

## Narrative — the read side (`drift-notice.ts`)

`readCodescapeToolDriftNote` is the ONLY reader of the persisted state file, called from `composeResumeDocOperationalNotes` (`sessions/platform-lead-prompt.ts`) — the SAME `[loom:*]` operational-note channel that already carries the resume-doc size/staleness warnings into EVERY Platform Lead spawn's own kickoff prompt. Named actor: the Platform Lead — the standing, human-driven operator whose doctrine already owns "platform-wide concerns" (`CLAUDE.md`) and already reads `[loom:*]` kickoff nudges as directives, not FYI. When: every Lead spawn (fresh or recycle-successor) while the finding is non-empty — not a one-time notice a restart can silently outlive.

This is deliberately NOT a board-card escalation (`platform_escalate`): that surface requires a live MANAGER session as its caller (`sessions/service.ts`, off-limits to card `350bc307` — see its own `caller.role !== "manager"` guard) and has no headless/daemon-internal entry point. Reusing this already-established prompt-injection channel avoids either reimplementing that machinery's dedupe/severity/attention-push wiring by hand from unrelated code, or bypassing it.

## Narrative — speaking the handshake (`tools-probe.ts`)

`probeAdvertisedTools` speaks the real MCP handshake (`initialize` then `tools/list`) via the SAME `@modelcontextprotocol/sdk` streamable-HTTP CLIENT class — already a daemon dependency, backing every `mcp/*.ts` SERVER this daemon runs — against a mounted Codescape entry: the same `/mcp/<codescapeId>` shape `codescapeHttpMcpServer` in `pty/host.ts` builds, and the same shape a real `claude` spawn's own MCP client talks to. This is deliberately NOT a hand-rolled single-shot POST — a prior fixture stand-in (`fake-codescape-cli.mjs`'s `POST /mcp/*` route, used by `codescape-mcp-spawn.mjs`) explicitly disclaims itself as "not a real MCP handshake"; speaking the protocol via the SDK is what makes this probe trustworthy against whatever the peer's real server actually requires (session negotiation included), without reading a line of their source.

## Do not

- Do not skip persisting the tool-drift state file just because the unclassified set is empty — always persist on a successful round-trip, so `checkedAt` stays fresh.
- Do not log the drift-finding line on every probe tick — only on a TRANSITION (new/changed finding, or recovery to clean).
- Do not read the persisted tool-drift state file anywhere except `readCodescapeToolDriftNote` — it is the ONLY reader by design.
- Do not route this notice through `platform_escalate` — that surface needs a live manager caller and has no headless/daemon-internal entry point; reuse the `[loom:*]` Platform Lead kickoff channel instead.
- Do not replace the SDK streamable-HTTP client with a hand-rolled POST to speak this handshake — a fixture stand-in already disclaims that shape as "not a real MCP handshake".

## Source

JSDoc method comment in `packages/daemon/src/codescape/supervisor.ts`, above `checkToolDrift`: originally lines 1500-1523, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The read-side section above was relocated from a top-of-file block comment in `packages/daemon/src/codescape/drift-notice.ts` (originally lines 4-19, as of this tranche's HEAD) by card `e8798881` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The handshake-mechanism section above was relocated from a JSDoc module comment in `packages/daemon/src/codescape/tools-probe.ts` (originally lines 5-20, as of this tranche's HEAD; the module-purpose paragraph in that same block stayed inline as Class C) by card `9490f6a7` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
