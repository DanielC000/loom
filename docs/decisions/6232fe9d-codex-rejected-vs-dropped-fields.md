# 6232fe9d — a codex profile field can be DROPPED, REJECTED, or both, and the three cases need different UI

## Narrative

Two independent facts govern what `harness: "codex"` does to a Profile field, and the Profiles editor had collapsed them into one:

- **DROPPED** — the codex spawn path never READS the field. It stores fine and simply has no effect at spawn. This is `CODEX_DROPPED_FIELDS` in `packages/web/src/lib/harnessFields.ts`: `restrictedTools`, `capabilities`, `skills`, `model`, `allowDelta`. The editor annotates and disables each one so nobody newly sets a value that will not apply — the "reads ON, applies nothing" false green cards `0770d916` and `d34dd208` exist to eliminate.
- **REJECTED** — `validateProfile` refuses to STORE the field alongside `harness: "codex"` at all, and the save returns 400. This is the daemon's `profiles/codex-compat.ts` › `codexIncompatibilities`: `restrictedTools`, `browserTesting`, `documentConversion`, and a non-empty `capabilities`.

**Neither set contains the other.** `skills`/`model`/`allowDelta` are dropped but stored happily. `browserTesting`/`documentConversion` are rejected while appearing nowhere in the drop map — they reach the reader only through the `capabilities` control group that backs the two reserved slugs.

The defect: the editor disabled the two overlapping fields (`restrictedTools`, `capabilities`) — so the user could not clear them — while still SENDING their stored values in the save payload. Flipping a rig that legitimately carries them (a QA-Tester- or Web-Designer-shaped profile, where `restrictedTools` and `browserTesting` are exactly the point) onto codex therefore 400'd on every single save, with the one control that could have fixed it greyed out. The rig was unreachable in both directions: it could not be moved onto codex, and the blocker could not be cleared from the only screen that owns the field. `save.error` was never rendered either, so the refusal produced no visible error at all — the editor just stayed dirty.

The fix clears exactly the rejected fields in the save payload, and names them in the editor BEFORE the Save click. Clearing was chosen over the DoD's other branch (leave them editable so the user clears them by hand) because that branch asks the reader to understand a validator rule before they can save at all. The honesty condition attached to clearing is that the removal must be announced, which is why the warning copy and the payload are driven from the same `codexRejectedFields` helper rather than from a hand-copied list at each call site.

The drop summary's own copy was false before this change: it promised all five dropped fields "stay stored and become live again if you switch this rig back to Claude Code." That is true only of the dropped-but-not-rejected three. `CODEX_DROPPED_BUT_STORED_FIELDS` derives that subset from the two sets so the promise can never again claim a field a save actually removes.

**The mirror.** `codexRejectedFields` is a copy of the daemon's `codexIncompatibilities`, not an import: `packages/web` cannot import from `packages/daemon`, and `codex-compat.ts` is pure but lives on the daemon side. The copy is therefore a known staleness surface in the same safe-looking direction as the drop map above it — a field added to the daemon's rejection set and not here produces a save that 400s again. Re-verify at source when touching either.

## Do not

- Do not treat "codex drops this field" and "codex refuses to store this field" as the same condition — disabling a control for the first reason while still sending its value for the second is what made the rig unsaveable.
- Do not send a value the validator is known to reject. Clear it and say so before the click; never silently.
- Do not re-derive the rejection set at a call site, and do not hand-list the dropped-but-stored subset — read `codexRejectedFields` / `CODEX_DROPPED_BUT_STORED_FIELDS`, which are the single source inside the web package.
- Do not state in UI copy that a dropped field "stays stored" without excluding the rejected ones; that claim was false for `restrictedTools` and `capabilities`.
- Do not leave a profile-save rejection unrendered — a 400 with no visible error is indistinguishable from a button that does nothing.
- Do not render it without keeping `meta: { inlineError: true }` on the `save` mutation. The two halves arrived from different cards and only make sense together: rendering alone draws the inline message *and* a blocking modal over it, which is the defect `docs/decisions/ad42a127-single-alert-owner.md` owns. The source scan in `packages/web/test/loopback-credential.mjs` fails the build if the meta goes missing while the render stays; the dialog count in this card's own spec is what proves the user actually sees one message and not two.

## Source

Extracted from an inline block in `packages/web/src/lib/harnessFields.ts` at the `CODEX_REJECTED_FIELDS` declaration. The rejection rule itself is the daemon's `packages/daemon/src/profiles/codex-compat.ts`; the save-time enforcement is `packages/daemon/src/profiles/validate.ts`. Acceptance evidence: `packages/web/e2e/profile-harness-codex-save.spec.ts`.
