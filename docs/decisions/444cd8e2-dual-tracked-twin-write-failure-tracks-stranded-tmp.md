# 444cd8e2 — two twin-write failure branches now track their own stranded tmp

Observed (not reproduced) by the `e1572b69` investigation (worker `1b81f738`), widened by that card's
Code Review (reviewer `bc7d387f`, by trace only). Same missing-tracking defect class `5332762e` fixed for
`clearTokenFromPendingIndices`' primary write, and `8d80b736` for the 3 raise callers' triple-fault "keep"
branches — at two sites neither card's scope covered.

## The bug

Two `writePendingDivertFile` failure branches in `merge-quarantine.ts` kept their own stranded tmp
(correctly, per `59e758e5`'s "never unlink" rule) but never referenced its basename in `orphanLatchFiles`:

1. `clearActiveEntryTokenAtKey`'s dual-tracked pending-twin write (`collectPendingIndices((p) => p.entry
   === updated)` — an 883e29bc twin: the SAME object armed in both tiers).
2. `clearMergeQuarantineByKey`'s reduce-branch tied-twin write (`pendingPlan`'s `"reduce"` — a
   same-identity pending twin P kept, not removed, holding a token outside the cleared entry — card
   `64119847`'s shape).

A LATER clear of the remaining token(s) narrowed/swept only the tracked `sourceFile`, never the untracked
tmp (still holding its stale set). Boot's tmp-recovery pass later armed it as a separate, fail-closed
duplicate — resurrecting the cleared token(s), same shape as `5332762e`/`8d80b736`.

Reproduced hermetically (`merge-quarantine-444cd8e2-twin-write-tracking.mjs`):

- **Site A**: a real dual-tracked twin (`setActiveQuarantineTestOnly`/`pushPendingQuarantineTestOnly`,
  same object reference — the sanctioned hermetic construction), tokens `[t1,t2,t3]`. Fail the twin's
  rename clearing `t1`: stranded tmp holds `[t2,t3]`, untracked. Clear `t2`,`t3` cleanly — survives the
  full lift; a real reboot re-arms `[t2,t3]`.
- **Site B**: active W (token `s`) + a tied pending twin P sharing W's identity/armed key, tokens `[s,v]`
  (pendingPlan requires the SAME identity — P must share W's, never merely an armed key elsewhere). Fail
  P's rename fully clearing W: stranded tmp holds `[v]`, untracked; P correctly reduces, keeping `w`
  blocked by `v` alone. Clearing `v` cleanly sweeps only P's tracked `sourceFile`; a reboot re-arms `[v]`.

## Fix

At each failure branch, when `strandedTmp` is truthy, collect `path.basename(strandedTmp)`; AFTER (never
before) that branch's own `rewriteOrphanLatchFilesAfterPartialClear` call, track it into
`orphanLatchFiles` (Set-deduped, mirroring `5332762e`), via `replaceEntryEverywhere` so a dual-tracked
twin stays one object (the exact split `8d80b736` Round 2 found in its first draft).

Site A's loop can process more than one tied twin per call, but its rewrite call runs once, after the
whole loop — every failed twin's basename collects into one `Set` and tracks together after that single
rewrite. Site B tracks right after its own conditionally-run rewrite line, regardless of whether it ran;
`p.entry` is also explicitly reassigned (defensive — `replaceEntryEverywhere` already does this by
reference). No new sweep/narrowing logic needed (existing `orphanLatchFiles` machinery already handles a
`.json.tmp-` name once referenced).

Both branches' misleading comment ("Keep the tmp; boot's recovery pass re-arms it as a duplicate" — true
as mechanism, silent on the real consequence, resurrection) was corrected to say the tmp is now tracked
and boot recovery is a backstop only, mirroring the equivalent comment at `clearTokenFromPendingIndices`'s
own `5332762e`-fixed site.

## Verification

- Both scenarios assert by CONTENT (never a resolve-aware query — `59e758e5`'s "Do not"): tmp tracked
  right after the failed write; `d`/`w` stay correctly blocked by ONLY the outstanding token between
  clears; tmp durably narrows on a later partial clear; DELETED on the full lift; a real reboot leaves the
  identity genuinely unblocked. Site B also confirms, by reading (never assuming): exactly one live
  record survives for `w` post-removal, it IS the reduced P (`[v]` alone), and the tracked tmp lives on
  THAT record's `orphanLatchFiles`.
- Mutation-tested: an API-keeping mutant at each site (Site A: `false &&`; Site B: a runtime env-var gate,
  since a literal `false` there drops TS narrowing in the "unreachable" block, failing the build) — both
  together turn exactly the 7 `*** THE FIX ***`/sweep/reboot assertions RED, every other GREEN. Restored
  byte-identical before re-verifying GREEN.
- Negative-controlled (explicit `--ref 9db97dcc2758c47873d115da999f0e22eefd3808`): RED (7 failed) against
  that sha, GREEN after, tree restored byte-identical.
- Full named regression sweep (5332762e, all 4 59e758e5, both 8d80b736, 64119847, e1572b69,
  clear-by-path, orphan-sweep-content-aware) — green. `guards` (33/33) + lesson-299 list — green. New
  test's solo runtime <1s (no TEST_TIMEOUT_OVERRIDES).

## Do not

- Do not unlink either stranded tmp — `59e758e5` forbids unlinking without proof content is secured
  elsewhere; here nothing is.
- Do not track before calling the branch's own `rewriteOrphanLatchFilesAfterPartialClear` (Site A: before
  the loop's single post-loop call) — tracking first manufactures `e1572b69`'s own nested-tmp defect.
- Do not forget `replaceEntryEverywhere` when reassigning — `8d80b736` Round 2 found exactly this
  omission, splitting a dual-tracked twin into two same-identity objects.
- Do not store `strandedTmp` itself (an absolute path) — always `path.basename(strandedTmp)`.
- Do not use a literal `false` (or nested `if (false)`) for an API-keeping mutant against code accessing a
  discriminated-union member narrowed by an outer condition — TS drops that narrowing inside code it judges
  unreachable, failing the build. Use a runtime-opaque condition (an env var check) instead.
- Do not fix card `d2592cd5` (reboot-between-clears over-blocking) here — deferred, not touched.
