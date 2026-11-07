# 8596ddfb — the identity-wide human clear drops a content keep whose file its own pending sweep deleted, and ByKey's own-sourceFile sweep folds a real failed unlink into `anyWriteFailed`

Found by the final Code Review of `14bdcb2f` (same output on old main). Both items are on `clearMergeQuarantineByRecordedPath` / `tryClearMergeQuarantineByOwnIdentity` (`merge-quarantine.ts`).

## 1. Stale disclosure (fixed)

Fixture: active A {t}; a same-identity pending P {other} whose sourceFile has a same-hash tmp `<P hash>.json.tmp-…` naming the repo's own repoPath and holding only `other`. Before the fix `clearMergeQuarantineByRecordedPath(repo)` returned `latchKept:true` + `contentKeptRepoPaths:[repo]` while the dir was empty and a reboot was unblocked.

**Traced, not inferred.** The keep is pushed by `sweepTmpResidueForHashIfUnreferenced`'s CROSS-HASH loop (`contentKeptEntries.push` in the `excludeIdentities?.has(identity)` branch, which carries NO `blockedBy`), reached through `deleteMergeQuarantineLatchByKey` < `clearMergeQuarantineByKey` < `tryClearMergeQuarantineByOwnIdentityBody` (a trace in a scratch copy of the built module, stack printed at the push). The pending branch's own tmp sweep then deletes the file.

The fix reuses the `2dd97aaa` ghost-drop rule, which ByKey applies at its own end but the identity-wide body never did after ITS later sweep. `1fb27e46`'s `retractContentKeepsBlockedOnlyByClearedIdentity` does NOT apply: its clause (a) needs a `blockedBy` naming the clearing identity, and this keep has none.

- `DeferredClearContext.contentKeptFiles` is an OUT-parameter (never a response field, so no public key set changes): ByKey records, per content-kept repoPath, the file the keep stands on; the body notes its own pending-branch keeps.
- `dropContentKeepsWhoseFilesAreGone` runs ONCE, after the whole matched loop AND the pending branch (just after the `!wasQuarantined` return), so it also covers a file a LATER ByKey call's own pending sweep deleted (Code Review SHOULD; test S4, both a tied-twin and an independent pending P). It drops a keep only when EVERY file recorded for it is gone; a keep with no recorded file stays (fail-closed). It also drops the matching `keptContentBlockedBy` entry. The result, `latchKept` and `reason` are then built from what survives; the `b11056a9` unlinkFailedFiles names already go through `liveUnlinkFailedNames` (existsSync), so a gone file is never named.

### Won't-fix: the tombstone half

`t` and `other` stay un-tombstoned although no file holds them: ByKey pushed its job with `nonFailureOk=false` before the sweep. Fixing it needs the keep set to reach the decider or a pushed job to be mutated, which `14bdcb2f` and `1fb27e46` forbid. It is fail-closed (a reboot is clean, nothing holds the tokens). The test characterizes it, so a future change of that behaviour is a deliberate one.

## 2. Own-sourceFile sweep asymmetry (fixed)

ByKey's own-sourceFile sweep folded a real failed unlink into `anyKeptUnattributed` only. Since `14bdcb2f` the pending branch also feeds `deferred.writeFailed`. Now ByKey sets `anyWriteFailed` from `result.unlinkFailed`, which it already forwards into `deferred.writeFailed`, so a real failed unlink withholds every job of that identity in the call (the lead's identity-keyed fail-closed ruling for `14bdcb2f`/`59f4ebe8`). Other callers of `sweepOwnLatchFileUnlessOwnedElsewhere` are untouched.

Behavioural witness: two active entries share one stored repoPath under two keys; E1 is also a tied pending twin whose file's unlink fails; E2's separate ByKey call used to tombstone its token (RED before, green after).

## 3. OPEN, unreproduced: a retracted keep on a non-canonical armed key

Card `1fb27e46`'s review noted `retractContentKeepsBlockedOnlyByClearedIdentity`'s return value is discarded: a keep retracted for a key the later `7aa9c406` sweep does not revisit could be neither re-added nor armed. The sweep's `freedKeysForClearedPendingEntries` frees only `canonicalKeyOrUndefined(entry.repoPath)`, never `resolvedKey(s)`, so a keep made on a diverted pending's `resolvedKey` has no revisit. NO defensive code was added.

Shapes tried (both routes `recorded` and `path`, a foreign residue Y under repo C whose tmp is misfiled on an unrelated hash, then cleared): (a) P armed active under K_c at boot (P not pending); (b) P a boot-diverted pending twin (a resolvable T holds the degraded key K_d, P carries `resolvedKey` K_c). In both Y ended armed in-process (listed as a live co-occupant) and blocked, with the same tokens, after a reboot. A reproduction needs P to have no surviving own entry (so clause (b) of the helper holds) while a keep blocked by P was classified; in shape (b) P still read `stillQuarantined`.

## Do not

- Do not feed the ghost drop into `deferred.writeFailed`, a job's `nonFailureOk` or a tombstone decision; it only removes a disclosure.
- Do not pass `contentKeptFiles` (or any keep set) into `decideDeferredTombstones` or a job.
- Do not drop a keep that has no recorded file, or any recorded file still on disk.
- Do not add a public response key for the keep's file; it travels in the `DeferredClearContext` out-parameter.
- Do not add a defensive re-add for item 3 without a reproduction; the open question stays open.

## Tests

`merge-quarantine-8596ddfb-human-clear-stale-keep.mjs`: S1 (stale disclosure gone, dir empty, reboot unblocked, tombstone half characterized), S2 control (a surviving keep is still disclosed and re-arms at reboot), S3 (identity-wide withhold, with its no-fault control).
