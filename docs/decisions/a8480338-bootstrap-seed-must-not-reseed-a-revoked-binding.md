# a8480338 — the companion bootstrap-seed must fire only on genuine first provisioning, never on a revoke

## Context

From the d3f9b4d2 review (reviewer 07988add): `factory.ts`'s `createCompanionGateway` re-seeds a Telegram
binding from `companion_config.allowed_chat_id` whenever a token companion's session has ZERO bindings at
gateway build time (`bindings.length === 0 && cfg.botToken`) — on every build, boot or reconcile.

"Zero bindings right now" is not "never provisioned." An owner who DELETEs every binding for a session
(`DELETE /api/companion/bindings/:sessionId`) also leaves zero `companion_bindings` rows —
`db.deleteCompanionBinding` never touches `companion_config` (the cascade is one-way), so `allowed_chat_id`
survives the revoke untouched, and the next restart/reconcile re-seeds the exact binding just revoked.

## Decision

A new durable fact, `companion_config.bindings_seeded` (`CompanionConfigRow.bindingsSeeded`), records "this
session's binding has genuinely been seeded once before" — independent of whether a binding currently
exists. `factory.ts`'s bootstrap-seed condition becomes `bindings.length === 0 && cfg.botToken &&
!cfg.bindingsSeeded`. **Updated by 3d19ecc7**: the mark is now set by `db.upsertCompanionBinding` itself,
at its own write chokepoint, the instant ANY writer's binding write lands — not by each caller
individually (the original shape here: factory's own mark + the provision endpoint's explicit flag) — see
that record for the two-path asymmetry this closed and why.

The env-bootstrap re-upsert in `store.ts`'s `resolveAllCompanionConfigs` (runs on EVERY boot for an
env-configured companion) deliberately omits `bindingsSeeded` on its `upsertCompanionConfig` call —
preserve-on-omit semantics (mirroring `provisioned`/`name`) mean that call can never reset the flag to false.

**Migration**: a pre-existing `companion_config` row backfills to `bindings_seeded = 1`, not 0 — by
definition it already went through its one genuine bootstrap in the past, so treating it as "already
seeded" closes this bug for an upgraded install too. A fresh `CREATE TABLE` defaults to 0.

**Fix round (Code Review, MAJOR 1): the blanket backfill is wrong for a row whose seed was REFUSED.** A
token companion whose `allowed_chat_id` is non-numeric (dm scope — the 94754bbe `InvalidTelegramChatIdError`
class) never wrote a binding at bootstrap, so it was never genuinely seeded — yet the blanket backfill-to-1
marked it "already seeded," which (a) permanently blocked the seed from retrying once the chat id was
fixed, and (b) silenced that branch's own refusal SETUP log (gated on `!cfg.bindingsSeeded`).
`migrateCompanionConfig`'s `narrowBindingsSeededBackfillForRefusedRows` (db.ts) now runs once, right after
the blanket ADD COLUMN backfill, narrowing exactly `chat_scope = 'dm'` AND
`isNonNumericTelegramChatId(channel, allowed_chat_id)` (the SAME validator `factory.ts` triggers) back to 0;
everything else stays 1. Separately, `factory.ts` now ALSO logs one disclosure-safe SETUP line (no chat id,
no content) whenever a token companion has zero bindings AND `bindingsSeeded:true` — see below for why it
can't distinguish WHY.

## Known, accepted limitations: two stranded shapes share one `bindingsSeeded:true` + zero-bindings state

The MAJOR 1 SETUP log fires on `bindings.length === 0 && cfg.bindingsSeeded` without naming which of two
shapes produced it — distinguishing them would require logging the chat id itself:

**Shape 1 — a deliberate owner revoke.** The expected, common case this record exists to protect: no
further action needed, the log is purely informational.

**Shape 2 — an interrupted env-bootstrap row.** `store.ts`'s `resolveAllCompanionConfigs` (boot sequence)
writes the `companion_config` row SYNCHRONOUSLY, hundreds of lines before `companionController.startInitial`
(which reaches `factory.ts`'s bootstrap-seed) runs later in the same boot — not uniformly wrapped in one
top-level try/catch, so a crash in between leaves a real row (token + `allowed_chat_id` set) with ZERO
bindings, byte-identical in storage to a genuine revoke. (The provision endpoint is NOT exposed: its config
write and binding write share one try block.) Reachable in principle; not observed live in this project's
own `~/.loom/loom.db` backup as of 2026-10-01. DELIBERATE trade-off: biasing the backfill toward "already
seeded" rarely stymies a one-time-interrupted provision (recoverable with one `POST
/api/companion/bindings` call), whereas biasing it the other way would silently re-arm a genuinely revoked
chat on every pre-existing row, unrecoverable by an owner who'd never know. Do not self-heal this case.

## Do not

- Do not revert the bootstrap-seed condition to `bindings.length === 0 && cfg.botToken` alone — that
  reopens the exact revoke-then-restart replay this record exists to close.
- Do not let the env-bootstrap re-upsert (`store.ts`'s `resolveAllCompanionConfigs`) pass an explicit
  `bindingsSeeded` value — it must stay omitted so `upsertCompanionConfig`'s preserve-on-omit path can never
  reset an already-seeded session back to false on a later boot.
- Do not key this off `companion_config.provisioned` instead — that field tracks SESSION origin, a different
  question from "has this session's binding ever been seeded." An env-bootstrapped companion is
  `provisioned:false` forever by design, yet still needs its own one-time seed guarded.
- Do not duplicate the "is this chat id refused" predicate — the migration's
  `narrowBindingsSeededBackfillForRefusedRows` and `db.upsertCompanionBinding`'s write-chokepoint throw
  (94754bbe) must both call the SAME `isNonNumericTelegramChatId`. `factory.ts` never evaluates it itself —
  only catches the throw — and the MAJOR 1b stranded-row warn also requires `cfg.botToken` (see 3d19ecc7).
