# 0f0816e2 — the isolated real-spawn phase is curated by reading each file

## Narrative

`ISOLATED_REAL_SPAWN_BASENAMES` (`test-daemon.mjs`) is a JUDGMENT-CURATED set of real-spawn/daemon-boot-heavy basenames run FIRST and SEQUENTIALLY (pool size 1, `ISOLATED_PHASE_POOL_SIZE`), before the rest run in the existing concurrent pool, unchanged. Same discipline as `STATIC_GUARD_REPO_PATHS` (`git/worktrees.ts`): curated by reading each file, not a name-pattern grep, and it changes the same way over time.

**Scope disclaimer:** does NOT claim to fix the intermittent full-suite timeouts in memory `repo-guard-only-handoff-intermittent-hang` — no mechanism was ever found (a plausible contributing condition, no specimen proving causation), and the internal pool is present in passing runs too (non-discriminating). Stands on its own merit either way: a real-spawn test vs. pool-sized siblings (real OS spawns, in-process daemon boots, real `git worktree add`) is a known-bad scheduling shape.

### Membership (grep counts at card-filing time)

`new Db(`/`new SessionService(` = boot; `createWorktree`/`createPty`/`PtyHost` = real spawns:

- `kickoff-real-spawn` — real node-pty spawns x5, the paradigm file.
- `merge-gate-inert-diff` 11x/15x createWorktree; `emit-compare-gate` 10x/10x; `gate-status` 11x/11x, 920 lines, heaviest of `gate-status-*.mjs` (3 narrower siblings, 121-189 lines, excluded); `merge-confirm-completion-nudge` PtyHost x3/x7; `merge-spawn-tracked` PtyHost x4/x7.
- `gate-timeout-circuit-breaker` — 7x boot, 5x createWorktree; own `TEST_TIMEOUT_OVERRIDES` entry, ~50-52s standalone (3/3).
- `merge-repo-mutex` / `merge-stranded-backstop` / `merge-gate-reuse` — ADDED (not the original 7), each its own `TEST_TIMEOUT_OVERRIDES` specimen (numbers there / `2bb7a114`'s anchor): a production timeout under load, a cap=2/concurrent=2 flake, and (`merge-gate-reuse`, `2bb7a114`) heaviest by git-work volume.
- `merge-canonical-dirty-overlap-backstop` (`4b7ff996`): 1x boot, 4x createWorktree + 2 submodule clones (the (G) gitlink scenario), 6 confirmWorkerMerge scenarios (A/E/S/U/D/G).
- `merge-canonical-untracked-overlap-backstop` (`98d6264d`, sibling): 1x boot, 4x createWorktree, 5 confirmWorkerMerge/mergeBranch scenarios (A/B/U/I/C).
- Both entries: comparable real-git volume to `merge-stranded-backstop`; neither observed to flake, both added proactively. The production preflight each exercises is that card's OWN decision against `git/worktrees.ts` — scheduling classification only.

### Export rationale

Exported (not module-local) so a dependent test can assert basename placement at import time instead of a silent drift later: `test-daemon-gate-timing-sigkill.mjs`'s FAST/SLOW race needs both on the SAME side for its `--concurrency=1` assumption. This card's own verification hit exactly that: adding `merge-repo-mutex` moved it into this phase and broke that race; the sigkill test was fixed alongside this list and now asserts its pairing against this set.

`ISOLATED_PHASE_POOL_SIZE` is fixed at 1, not env-tunable: scheduling SHAPE, not the concurrency BUDGET (`LOOM_GATE_TEST_CONCURRENCY`/`DEFAULT_CONCURRENCY`/`MAX_CONCURRENCY`, unchanged).

## CR follow-up (Loom lead direction, 2026-08-28): opt-in, default OFF

MEASURED, (then-)10 files sequential vs. the 3-lane pool: BEFORE (flat, `--concurrency=3`) aggregate 493.2s/wall-clock 196.7s; AFTER (isolated, pool 1) aggregate 426.0s/wall-clock 426.1s (pool 1 ⇒ wall-clock = aggregate). Net: +229.4s / +117%.

Estimated marginal cost embedded in the real ~774-file gate (not directly measured — standalone sees less lane-backfill contention than a saturated gate, so the true number sits somewhere between this subset's own delta and a poolSize-based saturated estimate): roughly +230-285s, i.e. +24-30% of a ~16-minute gate. **Now stale** (`docs/investigations/07171a13-test-timeout-scaling/findings.md`): measured against the 10-file list; the two `canonical-*-overlap-backstop` members were added after, list is 12 today, so enabling costs MORE.

Either end is a PERMANENT tax on every merge gate on this daemon-global, capped, SHARED resource (other projects queue behind it too) — for a benefit this card's own DoD-4 forbids claiming. Default OFF, byte-identical scheduling to before this card. Set `LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE=1` to opt in deliberately (e.g. a DoD-5 timeout-rate observation) — never as default, never via config (`gate-cap-is-2-by-owner-decision-never-change-silently` posture). Flag off ⇒ `isolatedPhaseFileCount`/`isolatedPhasePoolSize` read 0 on NDJSON rows — honest, not a fabricated 1.

## Do not

- Do not derive membership by a name-pattern grep — curate by reading each file.
- Do not cite this list, or its phase, as a proven fix for the intermittent hang — no mechanism was ever identified, and the pool it targets is present in passes too.
- Do not stop exporting `ISOLATED_REAL_SPAWN_BASENAMES`/`_SET`, or treat `ISOLATED_PHASE_POOL_SIZE` as tunable — a dependent test asserts membership against this set; pool size is a scheduling-shape constant, not a concurrency dial.
- Do not flip `LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE` on by default/via config, or reuse the +229.4s/+230-285s numbers without re-deriving against today's 12-file list.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`, above `ISOLATED_REAL_SPAWN_BASENAMES` (~855-922) and `ISOLATED_REAL_SPAWN_PHASE_ENABLED` (~943-963) — one card, two sites. Prose COMPRESSED to fit `PER_RECORD_MAX_BYTES`, NOT verbatim — specimen numbers omitted here (`merge-gate-reuse`'s 130s/7-runs, `merge-repo-mutex`'s 15 trials x 2) are in `TEST_TIMEOUT_OVERRIDES`' own trailing comments (~836-845) instead. Related: `2bb7a114`, `4b7ff996`, `98d6264d` (separately anchored); `docs/investigations/07171a13-test-timeout-scaling/findings.md` (staleness).
