# e849a487 — a companion's proactive HOME target is per-session, never one shared value

## The bug

Before the multi-companion runtime, a companion's proactive/outbound "where to reach the owner" target (the HOME route — `{channel, chatId}`) was read and written as a single value. Once the daemon could arm more than one enabled companion at once, that single value was wrong for every companion but one: every heartbeat or proactive message went to the SAME route regardless of which companion session actually armed it, silently cross-delivering messages between companions that were each supposed to reach a different owner-facing destination.

## The fix

`packages/daemon/src/companion/store.ts`'s `resolveAllEnabledConfigs` resolves the HOME for each enabled row independently, via `db.getCompanionHome(row.sessionId)` inside the per-row loop, and passes that row's own home into `buildConfigFromRow` — never a single value read once and reused across the whole set. The home itself is stored PER SESSION (`get/setCompanionHome(sessionId)`), not inside the `companion_config` row, so a REST write to one companion's home can never touch another's.

## Do not

- Do not reintroduce a single, daemon-wide home lookup in `resolveAllEnabledConfigs` or `buildConfigFromRow` — every row must resolve its own home from its own session id, or multi-companion cross-delivery comes back.

## Source

`packages/daemon/src/companion/store.ts`'s file header (was lines 1-22) and the per-row home comment inside `resolveAllEnabledConfigs` (lines ~112-114, untouched — out of this tranche's scope), as of tranche 1 on this file (card `e874a8ba`). No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers. Related documentation of the same fix (the app_meta key layout, and the one-shot backfill migration off the old single-key shape) also exists in `packages/daemon/src/db.ts` and `packages/daemon/src/companion/heartbeat.ts` — read for context, not extracted here (different file fence).
