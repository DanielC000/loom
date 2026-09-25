# 35cfcbe0 — every landing squash is pinned to a tip its decision covered, via ONE helper and a discriminated `LandingPin`

Extends 975c774b (gate-ran pin) and 01777ceb (reuse pin). A no-gate decision (a reused `run_gate` self-check, an inert-diff skip) proves something about ONE branch tip; a worker commit landing after that decision but before `mergeBranch`'s lock would otherwise be squashed with no gate covering it (for inert-skip, a non-docs commit the skip would never have allowed).

## What was decided

- `mergeBranch`'s `expectedBranchTip` (checked INSIDE its lock) comes from ONE place, `expectedTipForLanding(pin: LandingPin)` in `git/worktrees.ts`. `LandingPin` is `gate` (tip the real gate ran on) | `skip` (`reuse`|`inert`, each carrying the tip its decision covered) | `unpinned` (an explicit, named reason).
- `unpinned` has exactly ONE reason: `no-gate-configured` (a project with no gate command has no verdict about any tip, so nothing to pin). The human-only `mergeGate:"off"` skip (`gate-disabled`) and the gate-interval skip (`gate-interval`, card 6f13746c) are `skip` variants carrying the tip their decision covered (the worktree stamp taken once the repo guard is held), so every no-gate landing that has a decision is pinned — one rule, no exceptions.
- The call site builds the pin from state (`gateRan`, `skipKind`, `skipCoveredTip`); a decision that reaches the squash WITHOUT its tip refuses fail closed (`gateTipMoved`, "could not be verified"), never lands unpinned. The in-lock refusal takes its skip kind from `skipKind`, not by elimination.
- Inertness is classified on the branch SHA that is then pinned (`preWaitBranchHead`, `reclassifyTip`), never on the branch NAME: the name can move between classification and pin (a T1→T2→T1 ABA), so the tip that was classified would not be the tip that was pinned. `isInertMergeDiff` takes `ref: string | undefined` and fails closed to not-inert on `undefined`.

## Do not

- Do not add a skip path without its own `skip` literal AND its decision's tip in the `LandingPin`; omitting the tip is a type error on purpose, and a runtime miss refuses fail closed.
- Do not pass a branch NAME to `isInertMergeDiff` (or classify on one thing and pin another): classify the SHA you pin.
- Do not make `unpinned` a fall-through or a default. Every unpinned landing names its reason; a state that matches no pin refuses.
- Do not resolve the branch tip AFTER the inertness diff it covers (db413510's ordering): capture first, then classify that sha.
- Do not reintroduce an `unpinned` reason for a skip that made a decision: `gate-disabled` used to be one (a known gap), and 6f13746c closed it.
