# 8b194419 — fold every live-flip catch onto the shared `reconcileFailedSpawn` helper

## Narrative

Code Review follow-up on [[6ca4155f-reconcile-a-live-flip-spawn-to-exited-on-any-synchronous-throw]] (item
3): before this card, `spawnWorker`'s own catch (from card `fa1b77c1`) duplicated the reconcile logic
inline rather than calling the shared `reconcileFailedSpawn` helper every OTHER live-flip site already
used — the two differed only in the `lastError` message's prefix ("worker spawn failed…" vs "session spawn
failed…"), and a repo-wide grep found zero consumers of either exact prefix (nothing outside this file's
own source matches either string), so folding onto the shared wording changed no observable behavior.

This card's own DoD went beyond the fold: it also (1) added a `createPty`-throws test (the
[[bc91e86c-a-synchronous-createpty-throw-is-not-only-a-pre-pty-step-failure]] specimen, previously
untested at 6 live-flip sites whose try contains only `pty.spawn`), (2) closed a `startRun` run-row leak
(the catch reconciled the SESSION row but left the RUN row `starting` until next boot, holding a
concurrency slot and leaking its snapshot dir), and (3) considered but explicitly declined a single
helper owning flip+try+reconcile together, and declined adding a static guard for the invariant to
`STATIC_GUARD_REPO_PATHS` — reasoned AST-reading, so only a behavioural `.ts` edit can invalidate it,
which the full gate's corpus walk already re-runs (same reasoning as `emit-compare-soundness-guard`).

## Do not

- Do not reintroduce a per-site copy of the reconcile logic with its own `lastError` prefix — nothing
  outside `sessions/service.ts` consumed either prefix string (verified by repo-wide grep at the time),
  so the shared helper's wording is safe to standardize on.
- Do not add the live-flip/catch invariant guard to `STATIC_GUARD_REPO_PATHS` — it is AST-reading, so only
  a behavioural `.ts` edit can invalidate it, and the full merge gate's corpus walk already re-runs it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`spawnWorker`'s catch, ~line 6304, and the
`reconcileFailedSpawn` helper's own header, ~line 6374, as of this tranche's HEAD). Board card `8b194419`
(merged `8248c89`, verification: content).
