# c870618c — PASS 1's migrate branch folds a failed source-latch unlink into orphanLatchFiles instead of ignoring it

From the Code Review of `8a1bc2ef` (reviewer `44742bf1`, 2026-10-06). Fixed together with `4480b077` (same
migrate branch, same commit) — see `docs/decisions/4480b077-migrate-branch-unions-fresh-hash-target.md`
for the sibling fix (unioning with the fresh-hash target before writing) this record's own fix sits right
next to in the code.

## The bug

`8a1bc2ef` item 2 made `deleteSourceLatchIfSuperseded` return success/failure (`false` only for a
genuinely attempted-and-failed unlink, e.g. EBUSY — ENOENT/already-gone/self-target-skip all return
`true`) and folded a failed unlink into the armed entry's own `orphanLatchFiles` at
`consumeMatchedPendingsIntoArmedEntry`'s graduation call site. PASS 1's migrate branch in
`reenterMergeQuarantinesAtBoot` (`merge-quarantine.ts`, ~:1253 at `c2df1ad5`) calls the SAME function but
ignored its boolean return entirely.

An EBUSY unlink there left the stale source file `f` on disk, untracked by anything: not folded into
`orphanLatchFiles`, so a later legitimate clear of the real (fresh-hash) entry never swept it away. The
next boot then found this still-cleanly-parsing leftover file and re-armed the quarantine the human had
just legitimately cleared — fail-closed (never open), same class `be79f4d5`/`9cabd143` exist to close,
reached through a fifth call site neither of those cards touched.

## The fix

Mirrors `consumeMatchedPendingsIntoArmedEntry`'s own SUCCESS-branch fold exactly: on a `false` return from
`deleteSourceLatchIfSuperseded`, fold `f` into `entry.orphanLatchFiles` (deduped) and re-persist via
`writeMergeQuarantineLatch` again. If that re-persist itself fails too, a loud log names it explicitly and
the surviving tmp stays able to re-arm the quarantine at the next boot — today's pre-existing, safe
(fail-closed, never open) posture for any failed durable write, not a new risk this fix introduces.

**Round 2** (see `docs/decisions/4480b077-migrate-branch-unions-fresh-hash-target.md` for the full
restructuring): the write this fold sits on top of moved from a per-file write inside PASS 1's own read
loop to a single per-key write AFTER every file is read, collecting every migrating source for that key
first. The fold itself is unchanged in shape, just generalized from one source filename to N: every
source that fails to unlink is folded into the SAME `orphanLatchFiles` set and re-persisted once, not one
re-persist per failing source.

## Verification

An EBUSY-injected scenario (`test/merge-quarantine-pass1-migrate-union.mjs`, scenario
`ebusy-fold-and-sweep`, single-source) and a SEPARATE N-source scenario (`stale-id-clear-keeps-folded-file`
— two independent migrating siblings, one's own unlink injected to fail) both assert: (a) the armed
entry's `orphanLatchFiles` names the stale source file(s) after the injected failure, (b) a clear-by-id on
one failing source's own (real, 24-hex) stale hash KEEPS it (still referenced), (c) a later legitimate
clear of the real entry sweeps it, and (d) a reboot-sim (a fresh, cache-busted module re-import in the
same process — never an actual OS restart) after that clear finds nothing left to re-arm. A no-injection
scenario (`ebusy-no-injection-control`) is the negative control for (c)/(d) — proving the ordinary
(non-EBUSY) path still cleanly deletes the source file with nothing left to fold. All proven RED against
the pre-`4480b077` code, GREEN after, via `scripts/negative-control.mjs`.

## Do not

- Do not ignore `deleteSourceLatchIfSuperseded`'s boolean return at this (or any) call site that writes a
  migrated/graduated latch — fold a `false` into `orphanLatchFiles` and re-persist, never swallow it, for
  every source in an N-source fold.
- Do not read a `false` return as "the file is gone" — it means the OPPOSITE: an unlink was attempted and
  genuinely failed, and the file is still there, now needing to be tracked.
- Do not assume this closes every `deleteSourceLatchIfSuperseded` call site in this module — it closes the
  ONE PASS 1's (now deferred) write pass reaches; `8a1bc2ef` already closed the graduation site
  separately. **PASS 1b's own tmp-promotion write pass has NO fold at all** — its own tmp unlink is a bare
  `try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }`, swallowing a failure outright with
  nothing tracked. Left as-is: benign only because a human clear's own `sweepTmpResidueForHashIfUnreferenced`
  independently sweeps any same-hash tmp residue regardless of whether THIS code ever tracked it — not
  because it has an equivalent fold, which it does not.
- Do not construct a test id for `clearMergeQuarantineLatchFile` from an arbitrary filename — it requires
  a genuine 24-hex-character id (`QUARANTINE_LATCH_ID_PATTERN`); use the same legacy-hash technique
  (`oldHashFor`, realpath + lowercase-on-win32, no toplevel walk) the sibling test files already use.

Tests: `test/merge-quarantine-pass1-migrate-union.mjs`.
