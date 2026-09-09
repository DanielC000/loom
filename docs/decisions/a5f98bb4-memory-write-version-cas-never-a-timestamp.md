# a5f98bb4 — memory_write's version-based CAS, never a timestamp

## Narrative

Card a5f98bb4 (Lore audit F3): `upsertProjectMemoryChecked` compares against the existing row's monotonic `version` column, never `updatedAt` — a timestamp is NOT a safe CAS token here. Two distinct writes CAN legitimately compute the identical millisecond, either from OS clock-resolution coarseness or from two calls simply landing in the same tick, which would let a stale write masquerade as fresh and silently clobber; an integer counter, incremented atomically in SQL, cannot collide this way. See the dedicated `project-memory-version-guard.mjs` test, which forces exactly this `updatedAt` collision and proves the version-based guard is unaffected.

This closes a failure OBSERVED live 2026-07-17: two writers 3 minutes apart, neither aware of the other, last-write-wins silently ate the first write. An omitted `baseVersion` on an update to an EXISTING key is deliberately treated the same as a stale one (both REJECT) — neither writer had read the other's version, so an *optional* check would not have caught the incident; only refusing the write outright does.

## Do not

- Do not compare against `updatedAt` (or any timestamp) as a CAS token — millisecond-resolution collisions are real and defeat it.
- Do not treat a missing `baseVersion` on an existing key as "no preference, just write" — it must reject exactly like a stale version, or the 2026-07-17 incident recurs.

## Source

Inline comment in `packages/daemon/src/db.ts` (`upsertProjectMemoryChecked`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
