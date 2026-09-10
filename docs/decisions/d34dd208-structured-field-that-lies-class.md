# d34dd208 — the "structured field that lies" class, and why it got a machine-readable registry

## Narrative

"The structured field that lies" names a defect class: a Profile field the validator accepts (and the UI shows as set) that has no real consumer on some supported harness's spawn/runtime path — the toggle reads ON, and quietly does nothing.

By card `d34dd208`'s own opening, three instances of this class existed before this registry: `cb7d6998` and `6d5a6280` (see their own records — `docs/decisions/cb7d6998-loomsessionid-is-routing-not-provenance.md` and `docs/decisions/6d5a6280-permission-scope-hint-is-not-the-decision.md`), plus codex silently dropping the `model`/`restrictedTools` profile fields on its spawn path (the narrow fix, card `0770d916`) — were each caught by a HUMAN reading the artifact, none by CI.

This card was absorbed from the Platform Lead's own board card `4ce976f6`, at their explicit offer ("I would rather it live where it gets done than where I filed it"), 2026-09-07. The originating analysis and the pre-registered trigger are theirs; this card is a relocation, not an independent discovery.

The trigger that fired was a standing rule the Lead had already committed to: both earlier structured-field-that-lies instances (`cb7d6998`, `6d5a6280`) were caught by eye, neither by a test — a third instance earns a schema-wide pass, not a third card. `restrictedTools`/`model` silently dropped on the codex spawn path was that third instance, and it was judged the worst of the three: the first two lie about PROVENANCE; this one lies about CONFINEMENT — a field that reads ON in the UI and does nothing at spawn is a safety control that isn't one.

This card (the schema-wide pass/bound) is deliberately NOT a duplicate of `0770d916` (the narrow two-field fix): `0770d916` fixes the two known fields; this card asks whether the whole class is bounded, sweeping every profile/session field a UI surfaces or a validator accepts, per harness, for paths that silently ignore it. The two are siblings and were not to be merged into one branch.

## The DoD-4 hardening — how "silence, not asymmetry" got its teeth

The card's DoD originally read (Platform Lead's version): "a field with no consumer on a path IS an instance." The Loom lead who absorbed the card judged that too strong — it would fire on fields that are legitimately claude-only or codex-only — and replaced it with "the defect is SILENCE, not ASYMMETRY."

The Platform Lead agreed the original was overreach, but identified a hole the looser version opened: whatever declares "this field is legitimately harness-scoped" must be MACHINE-READABLE by the guard, not prose. If the answer lives in a doc comment, the test cannot consult it — that's back to a human deciding case-by-case, the exact state that produced three instances caught by eye and zero by CI.

The merged, adopted rule — and the one this registry (`profiles/field-consumers.ts`) actually implements — replaces the original DoD-4 option ("documented as harness-scoped"): a field exempt from consumption on a given harness must carry a declaration IN CODE that the guard reads (the `exempt`/`gaps` shapes) — an unexplained absence FAILS. A doc comment is not a declaration. The supporting rule behind this, worth carrying past this one card: a doc comment's correctness and whether a reader acts on it are independent variables — see project memory `shipping-a-detector-is-not-someone-reading-it` and `a-comment-is-a-claim-grep-them-when-you-fix`.

## Do not

- Do not treat a doc-comment explanation of "this field is fine on harness X" as satisfying this registry — only a `proofs`/`exempt`/`gaps` entry the guard itself reads counts.
- Do not fold a temporary, fixable gap into `exempt` (permanent) or vice versa — `gaps` requires a live, carded id; `exempt` requires the harness to structurally have no analogous mechanism at all.
- Do not re-merge the two siblings (`d34dd208`, `0770d916`) — one is the narrow point fix, one is the schema-wide bound; they were deliberately kept apart.

## Source

Inline comment in `packages/daemon/src/profiles/field-consumers.ts`, header block above `export type ProfileHarness` (lines 1-34, pre-tranche-1 numbering), introduced whole-file by commit `8fabafa56e1ab205f054aba8dbd79fc432e677f9` ("test(profiles): bound the 'structured field that lies' class with a guard"). Board card `d34dd208` body (absorbed from Platform card `4ce976f6`). Relocated by card `612cb81c` (tranche 1).
