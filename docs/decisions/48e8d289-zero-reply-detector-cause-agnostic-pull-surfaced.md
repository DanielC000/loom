# 48e8d289 — the zero-reply detector: cause-agnostic, stateless-per-turn, reuses the watcher-family shape

## Narrative

Card `48e8d289` (split from card `dbba993f`'s DoD-4): this module is the CAUSE-AGNOSTIC DETECTABILITY half of the response to the incident that motivated it — not a fix for any particular cause — a companion session emitted 113 turns and called `chat_reply` zero times, and the first sign anything was wrong was the owner typing "Hello?"; nothing in the system had noticed. Whatever CAUSES a companion to go silent (an MCP tool-list caching gap, a prompt bug, a genuinely-thinking-not-replying stretch that never resolves), `companion/reply-watch.ts` makes the silence itself VISIBLE instead of relying on a human eventually noticing — it is deliberately CAUSE-AGNOSTIC, diagnosing nothing about WHY a companion went quiet, only THAT it did.

The hook is `pty/host.ts`'s existing `onTurnCompleted` (card `343441bd`'s completed-turn counter), consumed by `checkCompanionReplyHealth`, which is a no-op for any session with no `companion_config` row — so wiring it unconditionally into `onTurnCompleted` (`index.ts`) is fully additive: every non-companion session's path stays byte-identical.

This deliberately reuses the existing per-tick-watcher FAMILY's conventions (`idle-watcher.ts`, `busy-worker-watcher.ts`, `companion/heartbeat.ts`) — a durable once-per-streak event, dedup state that survives a restart — but is itself a STATELESS FUNCTION called from a turn-completion hook, not a `setInterval` watcher: there is no natural "tick" for "did this session's turns stop replying", only "a turn just completed".

DEFAULT-need-not-be-armed: this runs for every companion session with NO configuration of its own (no cadence to set, unlike the heartbeat) — `enabled` on the `companion_config` row is the only gate, matching "per ENABLED companion session" in the card's DoD.

## Lazy baseline (avoiding a false trip on upgrade)

`checkCompanionReplyHealth` treats a row whose `lastChatReplyTurnSeq` is NULL (a brand-new companion's first-ever completed turn, or a pre-migration legacy row that backfilled to NULL) as "first observation" — seeded to the session's CURRENT `turn_seq` and returned early, WITHOUT alerting. This is what keeps an upgraded long-lived companion from instantly tripping the detector on its very first post-migration turn (it would otherwise read `turnSeq - NULL` as a huge, spurious streak).

`console.warn` fires alongside the durable `companion_zero_reply_detected` orchestration event on every genuine (non-deduped) trip — an operational log line, mirroring the daemon's other swallowed-fault console warnings (e.g. `alert-webhook.ts`).

## Do not

- Do not wire this into a `setInterval` watcher — there is no natural "tick" for this signal, only "a turn just completed"; it must stay a stateless function called from `onTurnCompleted`.
- Do not treat a NULL `lastChatReplyTurnSeq` as a huge spurious streak — seed it as a first observation instead, or an upgraded long-lived companion trips the detector on its very first post-migration turn.

## Source

Inline comments in `packages/daemon/src/companion/reply-watch.ts`: the module header (lines 1-32) and `checkCompanionReplyHealth`'s doc comment (lines 59-73, introduced by commit `af7ca1f9c1cd5200f3f02b7244c0e7799897f217`), as of tranche 1 on this file (card `53d65688`). No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
