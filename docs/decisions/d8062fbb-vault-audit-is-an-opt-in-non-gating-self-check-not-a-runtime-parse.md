# d8062fbb — the vault-drift detector is an opt-in, non-gating self-audit, never a runtime parse of the vault

## Narrative

`--audit-vault <path>` / `LOOM_ROTATION_GATE_VAULT_PATH` (card `d8062fbb`, 2026-09-03) is a DRIFT DETECTOR for the `MARKERS` array / `LIVE_COMMITMENTS_FLOOR` constant against the vault §ROTATION-GATE section they were copied from.

**DoD-0 decision:** the card's parent proposed making the vault AUTHORITATIVE at runtime — a `--markers <path>` flag that PARSES the vault section into the marker list, replacing the hardcoded array. REJECTED: this file's own history already shows what a runtime parse of a prose section costs — `countLiveCommitments`'s end-boundary broke TWICE from exactly this shape (a name-anchor silently falling back to end-of-file, cards `d78a6d5d` and `a681aed5`), and that was parsing a STRUCTURED numbered list, an easier target than a heading section listing markers in free prose. Making the PRIMARY gate's pass/fail depend on that parse succeeding would trade a known, documented, occasionally-stale copy for a script that can silently mis-gate every real rotation the moment someone reformats a vault heading — worse, not better, since a rotation is time-pressured and this script's whole job is to be reliable exactly then.

INSTEAD: keep the hardcoded copy unchanged (still the thing `--active`/`--archive` are checked against), and add a SEPARATE, OPT-IN, NON-GATING-BY-DEFAULT self-audit that checks the copy against the vault on demand — detectable mechanically, but never able to turn a vault reformat into a blocked rotation.

**DoD-1 (machine-specific vault path):** this cannot be an unconditional repo test — no worktree can read a real vault path, and the path differs per host — so instead of a test, it's a flag (`--audit-vault <path>`, explicit, one-off) PLUS an ambient env var (`LOOM_ROTATION_GATE_VAULT_PATH`) that, once set ONCE on a host that actually has the vault mounted (e.g. the owner's/lead's own machine), makes the audit run on EVERY future invocation with zero further action — closing the "manual re-check nobody is obliged to run" gap without a human needing to remember per-edit. A host that never sets it (CI, a fresh worktree) sees byte-identical behavior to before this card — the env var is read but never required.

**What it actually checks:** reusing the SAME structural (heading-depth, never name) anchor already proven for LIVE COMMITMENTS (see `a681aed5`), it locates the vault's §ROTATION-GATE heading section and checks (a) every `MARKERS[]` token is still present there (respecting per-marker case-sensitivity), and (b) the current `LIVE_COMMITMENTS_FLOOR` value appears in that section as a standalone number — this is DoD-4's coverage: the floor is part of the same copy problem and gets the same detector, never silently left out. Both checks are exact-substring, proves-presence style, with the same honest limit as the primary gate: a REWORDED (not removed) rule can still false-negative, and the floor check can false-negative too (a coincidental digit elsewhere in the section reads as "confirmed"). Neither direction is claimed to be more than what it is.

**DoD-3 (why it only gates `--lint`'s exit code, never a real rotation's):** `--lint` is already the free, run-anytime, no-consequence mode — exactly the safe place to let a NEW, heuristic check affect the exit code. A live rotation stays governed only by the pre-existing `--active`/`--archive`/`--was` checks, unchanged; the vault audit's result is still PRINTED on a rotation run (never silent), it just can't block one. This is a deliberate, NAMED trade-off, not an oversight: making this new heuristic gate the live path would risk exactly the failure mode DoD-0's decision above already rejected for the alternative design, on the one path that can least afford it.

**Unreadable path:** given explicitly via `--audit-vault`, an unreadable file is a real error (exit 1, same convention as `--rules`/`--active`). Given only via the ambient env var, an unreadable file is a SILENT (visibly-noted, never fatal) SKIP — the env var is best-effort ambient state, not a caller asserting "this path must work," so a stale/unmounted vault path must never turn into a spurious rotation refusal.

## Do not

- Do not make the primary gate's pass/fail depend on a runtime parse of the vault's free-prose §ROTATION-GATE section — `countLiveCommitments`'s own history (two separate breaks, `d78a6d5d` and `a681aed5`) shows exactly this cost, on an easier (structured-list) target than free prose.
- Do not let the vault audit block a real rotation, ever — only `--lint`'s exit code may reflect it; a rotation run still only prints the result.
- Do not treat a stale/unmounted `LOOM_ROTATION_GATE_VAULT_PATH` as an error — it is best-effort ambient state and must skip silently (though visibly-noted), never refuse a rotation on that basis. An explicit `--audit-vault` path is different: an unreadable file there is a real error.

## Source

Condensed/paraphrased from the inline file-header comment ("--audit-vault <path> / LOOM_ROTATION_GATE_VAULT_PATH" through the "⭐ DECISION" block) in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`).
