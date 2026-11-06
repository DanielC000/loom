# 4c7e0ed0 — the in-process pending arm files one entry per physical file, as boot does

Found by the `9f387d7e` Code Review (reviewing `e7fc003f`, 2026-11-02). When a foreign identity T is
UNRESOLVABLE, `armForeignOrphanContentInMemoryIfUnenforced`'s pending branch pushed ONE entry
(`sourceFile = basenames[0]`, tokens unioned across every kept file), while a reboot of the same bytes
files one pending entry PER FILE (`sourceFile` = that file, tokens = that file's own).

## What actually diverged (probed, same-snapshot — the reboot leg boots from a disk snapshot of the post-clear
orphan files, never from in-process output)

- The token set and the `assertRepoNotQuarantined` verdict agreed; clear-by-path and clearing both tokens
  agreed. (`stillBlockedEntryFor` is a first-match peek, so it shows the union in-process but one file's
  tokens after a reboot — a view artifact, not a verdict difference.)
- Clear-by-id: the handed-out id depended on the shape (first-sourceFile in-process, readdir-first after a
  reboot), and one id lifted T in-process while the reboot shape needed one clear per file.
- A partial token clear left BOTH files on disk in-process (the cleared token's file survived, covered only
  by the durable tombstone) but deleted the cleared token's own file after a reboot.

## The fix

Canonical shape = boot's: one pending entry per physical file. The PENDING branch pushes
`{ entry: <that file's own armable record + its own basename as self-reference>, sourceFile: <that file> }`
per file, each through the same Step B secondary-key loop. Entries are SEEDED with the file's own tokens; if
two files share a secondary key, `armQuarantineKey`'s same-identity union makes both entries carry both files'
tokens, exactly as a reboot of the same bytes does (pinned as a parity assertion). Distinct keys stay distinct:
clearing tk1 frees R1 while R2 stays blocked, in both shapes. `sweepOrphanLatchFilesUnioned` and
`sweepTmpResidueForHashIfUnreferenced` carry the per-file armable records (`bucket.files`) next to the
union. The RESOLVABLE (active) path is unchanged: still ONE unioned entry, which is also what boot produces.
Both callers are per-file now, including the tmp-residue caller (which also carries `63569b55`'s unarmable
placeholders with their salvaged tokens — still salvaged per file).

After the fix the id route takes one clear per file in BOTH shapes (the first leaves T quarantined and its
refusal names the next entry's id). The first id handed out still depends on pending order (in-process: sweep
order; reboot: readdir order) — harmless now that the shapes match, because the route converges in the same
number of steps either way; the test asserts that for both ref orders.

## Do-nots touched, and why that is allowed

- `9f387d7e` "Do not touch `armForeignOrphanContentInMemoryIfUnenforced`'s own Step B / unresolvable-identity
  union behavior": TOUCHED — only its pending PUSH (one per file instead of one union). Step B's logic
  (`armSecondaryKeys`, now a closure) is byte-for-byte the same per entry. Allowed because that Do-not guarded
  against a drive-by change inside a card about basename assembly; this card exists to align that push with boot.
- `9f387d7e` "Do not re-copy the bucket-then-arm-once shape": respected — the union bucket stays, per-file
  records ride alongside it; no new call-site loop.
- `188ebf31` "Do not replicate PASS 1's freshness/registered-backing decision tree at Step B" and its
  unioned-`resolvedKey` parity: untouched. The unresolvable per-file entry runs the same terminal
  `armQuarantineKey` per file, as boot does.
- `25d0d45b` "Do not revert `armableByIdentity` to a per-file inline arm": respected — arming (the
  `already-enforced` gate) still happens once per identity; only the pending PUSH is per file.

## Do not

- Do not push a union entry under `basenames[0]` for an unresolvable identity again — it re-opens the
  id-route/partial-clear divergence above.
- Do not drop the per-file entry's own-basename `orphanLatchFiles` self-reference: `028837ad`'s reduce-write
  persists it (`merge-quarantine-028837ad-pending-arm-mid-clearbytoken.mjs` fails without it).
- Do not compare unarmable-tmp TOKENS across shapes: boot mints its own placeholder token for an unarmable
  tmp while `63569b55` salvages the file's tokens in-process by design; compare the per-file entry shape only.

## Tests

`test/merge-quarantine-4c7e0ed0-pending-per-file-parity.mjs`: same-snapshot in-process vs reboot for
orphan files (both ref orders): pending list/sourceFiles/tokens, partial-clear disk state, clear-by-path,
id route step count, no resurrection after a reboot; the doubled `63569b55` tmp-residue shape; a resolvable
control (still one active union). `negative-control --mutant` (restoring the union push): RED BEHAVIOURAL
(11 failing assertions incl. the TMP one), GREEN after, restore verified.
