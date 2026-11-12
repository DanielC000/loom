# daa5d02f — a `sharedVaultRoots` PATCH starts the boot-refused vaults it now recognizes, with no restart

Card `daa5d02f`, from the code review of `f098fbd9`. A vault refused at boot (`unrecognized-ancestor-root`) has no watcher, so listing its root under Settings only took effect after a daemon restart.

## The decision

`PATCH /api/platform/config` (the only, human-only writer) calls the `onSharedVaultRootsChanged` gateway dep, awaited and best-effort, only when the stored `sharedVaultRoots` actually changed. `index.ts` wires it to `startVaultVersioners(db, { rescan: { watched: vaultVersioners } })`, serialized on a promise chain, and pushes the returned versioners onto the live `vaultVersioners` array (shutdown flush, push-status watcher and lock-alert lookups already read that array lazily).

Rescan mode of `startVaultVersioners` reuses the boot loop and its `isUnrecognizedAncestorRoot`/`isRecognizedVaultRoot` check, with three differences:
- it only considers projects whose vault has an OPEN durable refusal (the latest `unrecognized-ancestor-root` not superseded by a `-cleared`), so a PATCH never walks or starts any other vault;
- every commit root already in `watched` is pre-seeded into the dedupe set, so a root is never started twice;
- a still-unrecognized root files no new refusal event (it keeps its existing one).

The `unrecognized-ancestor-root-cleared` event is filed through the same path as at boot, so the owner's "VAULT NOT COMMITTING" item clears. The refusal warning and that item no longer tell the owner to restart.

## Removing a root

Removing a root does NOT stop a running watcher. Its per-tick `commit()` re-checks `isRecognizedVaultRoot` live and refuses (`f098fbd9`), so no stop is needed and none was added.

## Do not

- Do not start a watcher for a root that `isRecognizedVaultRoot` still rejects; never add a second recognition signal.
- Do not let a rescan walk every project: it is bounded to open refusals.
- Do not start a root that is already watched; do not run rescans concurrently.
- Do not make a removed root stop or tear down a running watcher; `commit()`'s live check already refuses.
