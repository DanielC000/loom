# 35cfcbe0 — every landing squash is pinned to a tip its decision covered, via ONE helper and a discriminated `LandingPin`

Extends 975c774b (gate-ran pin) and 01777ceb (reuse pin). A no-gate decision (a reused `run_gate` self-check, an inert-diff skip) proves something about ONE branch tip; a worker commit landing after that decision but before `mergeBranch`'s lock would otherwise be squashed with no gate covering it (for inert-skip, a non-docs commit the skip would never have allowed).

## What was decided

- `mergeBranch`'s `expectedBranchTip` (checked INSIDE its lock) comes from ONE place, `expectedTipForLanding(pin: LandingPin)` in `git/worktrees.ts`. `LandingPin` is `gate` (tip the real gate ran on) | `skip` (`reuse`|`inert`, each carrying the tip its decision covered) | `unpinned` (an explicit, named reason).
- `unpinned` has exactly two reasons: `no-gate-configured` (a project with no gate command has no verdict about any tip, so nothing to pin) and `gate-disabled` (the human-only `mergeGate:"off"` skip; it verifies nothing about any tip today). **`gate-disabled` is slated for removal by 6f13746c**, which routes that skip through `skipCoveredTip` too, at which point one rule has no exceptions.
- The call site builds the pin from state (`gateRan`, `skipKind`, `skipCoveredTip`); a decision that reaches the squash WITHOUT its tip refuses fail closed (`gateTipMoved`, "could not be verified"), never lands unpinned. The in-lock refusal takes its skip kind from `skipKind`, not by elimination.
- Inertness is classified on the branch SHA that is then pinned (`preWaitBranchHead`, `reclassifyTip`), never on the branch NAME: the name can move between classification and pin (a T1→T2→T1 ABA), so the tip that was classified would not be the tip that was pinned. `isInertMergeDiff` takes `ref: string | undefined` and fails closed to not-inert on `undefined`.

## Do not

- Do not add a skip path without its own `skip` literal AND its decision's tip in the `LandingPin`; omitting the tip is a type error on purpose, and a runtime miss refuses fail closed.
- Do not pass a branch NAME to `isInertMergeDiff` (or classify on one thing and pin another): classify the SHA you pin.
- Do not make `unpinned` a fall-through or a default. Every unpinned landing names its reason; a state that matches no pin refuses.
- Do not resolve the branch tip AFTER the inertness diff it covers (db413510's ordering): capture first, then classify that sha.
- Do not read `gate-disabled`'s unpinned status as intentional design: it is a known gap 6f13746c closes.
