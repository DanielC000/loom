# 02f0e8a6 — isolate a companion e2e's config save from a sibling spec's leftover bot token

## Narrative

`packages/web/e2e/companion-heartbeat-prompt-default.spec.ts` failed DETERMINISTICALLY — the "Save button
closed" assertion timing out at `toHaveCount(0)` — whenever any companion-seeding spec ran before it in the
suite, while passing in isolation. Measured pre-existing on mainline (3/3 on merge-base `4c286570`), i.e.
not introduced by the card it was found under (`a6d7bf36`).

The card's opening hypothesis was the Companion page's "focus the most active companion" tie-break: the
shared e2e daemon never drops a `companion_config` row on session-archive alone, so sibling specs'
companions accumulate in the picker, and the spec clicked its own only `if (await pickerBtn.count())`. The
failure's own page snapshot FALSIFIED that: the right companion was focused, `aria-pressed="true"` and all.

The real cause was one line further down that snapshot — the edit form's inline error span:

> this Telegram bot token is already used by another enabled companion (session e2e-comp) — Telegram allows
> only one getUpdates consumer per token; give this companion its own token or disable the other one first

`checkTokenCollision` (`gateway/server.ts`) refuses any config write that arms a Telegram token already
held by another ENABLED companion. The e2e fixture's `seedCompanion()` defaults EVERY companion to the same
`123456:e2e-test-token` and leaves the row enabled, and `companion-chat-close-kind` /
`companion-credential-reattach` deleted neither of theirs. So one un-cleaned sibling was enough to make
every config SAVE in a later spec refuse. The spec's second test passed throughout because it only reads
and renders — it never saves.

The bare `toHaveCount(0)` reported none of this: a refused save is indistinguishable from a slow one, and
the failure read as "the Save button is still there". That opacity, not the bug, is what cost two earlier
sessions a debug cycle each.

## Decision

Three INDEPENDENT layers, verified independently sufficient (control matrix below):

1. **The spec seeds a UNIQUE bot token per companion** (`seedIsolatedCompanion`). Structurally immune to
   the collision guard regardless of what leftovers exist or what order the suite runs in. This is the
   layer that fixes the failure, and the only one that does not depend on a sibling's good behaviour.
2. **The save's own HTTP response is asserted** (`page.waitForResponse` on the `PUT
   /api/companion/config/:id`, `expect(status).toBe(200)` with the body in the failure message). A future
   refusal — for this reason or any other — now fails naming the daemon's own reason.
3. **The focused companion is pinned UNCONDITIONALLY by name** after the necessarily-conditional picker
   click (the picker only renders with 2+ companions), with the chat allowed to settle on its own
   auto-focus first. Closes the silent-wrong-companion shape the hypothesis described, which was real as a
   latent hazard even though it was not this failure.

Separately, `companion-chat-close-kind` and `companion-credential-reattach` now DELETE their seeded
`companion_config` rows in `afterEach` (bearer-gated, `res.ok()` asserted) — fixing the leak at source for
every later spec, not just this one.

## Control matrix

The two fixes are each independently sufficient, so defeating only one proves nothing. Measured on the
2-spec reproducer (`playwright test --config=e2e/playwright.config.ts companion-chat-close-kind
companion-heartbeat-prompt-default`):

| arm | unique token | predecessor cleanup | result |
| --- | --- | --- | --- |
| A | defeated | active | PASS |
| B | active | defeated | PASS |
| C | defeated | defeated | **FAIL**, and layer 2 printed the collision error verbatim |

Arm C is what attributes the failure; arms A and B are what show neither layer is load-bearing alone. Full
fix: 5/5 green on the reproducer.

## Do not

- **Do not collapse the three layers.** Dropping the unique token makes the spec depend on every sibling's
  `afterEach`; dropping the response assertion returns the failure to an opaque button-still-present
  timeout; dropping the unconditional name assertion re-opens the silent-wrong-companion hazard.
- **Do not "simplify" `seedIsolatedCompanion` back to a bare `seedCompanion({ name })`.** The unique NAME
  alone does not help — the collision guard keys on the TOKEN, which the fixture defaults to a shared
  constant.
- **Do not add a companion-seeding e2e spec without deleting its `companion_config` row**, and do not
  leave that DELETE unasserted: it 401s without the loopback bearer header, and a silently no-opping
  cleanup only ever breaks a LATER spec, with nothing pointing back at the cleanup.
- **Do not read "passes in isolation" as attribution.** It is equally consistent with a cross-spec
  interaction and a low-rate flake. Pair the spec with its predecessor, and repeat per version — a single
  run gives the catch point, not the failure mode.

## Source

- `packages/web/e2e/companion-heartbeat-prompt-default.spec.ts` (the anchor)
- `packages/web/e2e/companion-chat-close-kind.spec.ts`, `packages/web/e2e/companion-credential-reattach.spec.ts`
- `checkTokenCollision`, `packages/daemon/src/gateway/server.ts`
- `seedCompanion`, `packages/web/e2e/fixtures/daemon.ts`
