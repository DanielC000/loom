# 9e27f4d2 — Give-up hold deadline rides RestartIntent's separate additive `holds` map, never on the entry

## Narrative

Card 9e27f4d2: an entry still within its post-give-up hold window carries a `giveUpHeldUntil` deadline, returned in the snapshot's SEPARATE, additive `holds` half (see its doc on RestartIntent for why `pending` itself must stay a bare `string[]`) rather than on the entry. `holds` is keyed by each entry's INDEX into `texts` — the filter/truncate below has to keep `rawHolds`' indices lined up against `rawTexts` before re-deriving them against the FINAL (filtered + truncated) array, since a dropped-for-length or truncated-away entry must not leave a stale index pointing at the wrong (or a nonexistent) surviving entry.

## Do not

- Do not put a `giveUpHeldUntil` hold deadline directly on a pending entry in `RestartIntent` — `pending` must stay a bare `string[]`; carry holds in the snapshot's separate, additive `holds` map keyed by index into `texts`.
- Do not re-derive `holds`' indices against the raw (pre-filter) `texts` array — re-derive them against the FINAL filtered/truncated array, or a dropped or truncated entry leaves a stale index pointing at the wrong surviving entry.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`): lines 4306-4312, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. "The snapshot" this paragraph continues is `docs/decisions/2ca18433-restart-pending-snapshot-excludes-durable-messages.md` (the immediately preceding paragraph at this same site).
