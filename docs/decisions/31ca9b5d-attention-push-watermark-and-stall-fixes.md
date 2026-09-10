# 31ca9b5d — attention-push watcher: watermark cursor, stall fix, restart-reseed window

## Watermark cursor: `seq`, never sqlite `rowid`

The `AttentionPushWatcher` tail-polls the durable `orchestration_events` log keyed on `Db.listEventsSince`'s `seq` cursor — NOT sqlite's own `rowid`. This is a CR-caught correctness bug, not a style preference: rows are hard-deleted by `deleteProject`/`deleteSession`, and sqlite REUSES a rowid once the row holding the table's current max is gone. Keying the watermark on `rowid` would let it silently retire past a reused id and drop a real alert forever. `seq` is a genuine, never-reused, monotonic column (see its doc in `db.ts`'s SCHEMA) — the only column with the right guarantee for a durable cross-restart cursor.

The watcher is also deliberately NOT built on the single-slot `Db.setEventListener` the alert-webhook emitter (`orchestration/alert-webhook.ts`) already occupies — that slot can hold only one subscriber, and this watcher needs its own per-session watermark anyway (a listener callback has no natural per-companion cursor).

## Immediate-mode watermark: unconditional advance (a real stall bug, build-review fix)

`tickImmediate` advances the watermark to the LAST SCANNED row's `seq` every time, even when nothing qualified that tick. This is a fix, not the original shape: the prior version only advanced the watermark past DELIVERED rows. On a fleet where a companion only subscribes to a slice of `alertClasses`, a run of `EVENT_TAIL_LIMIT` (200) or more consecutive non-qualifying events left `qualifying` permanently empty and the watermark permanently stuck re-scanning the same stalled window — `attention-push` would go silent forever, with no error and no signal that it had wedged.

Every row in `scanned` is TERMINAL by the time `tickImmediate`/`tickDigest` run: a qualifying row is delivered, a non-qualifying row (wrong class or out of scope) is a PERMANENT skip that never re-classifies differently on a later tick. So the watermark must always advance past the whole scanned window regardless of how many rows qualified. The only two cases allowed to hold the watermark are TRANSIENT defers — rate-limit park and no-stacking — and both of those bail the whole tick *before* `scanned` is ever read (see `tick()`), so every row that reaches `tickImmediate`/`tickDigest` is unconditionally consumed one way or another.

## Restart re-seed: a known, accepted narrow window

`seedWatermark` seeds from the MAX `sourceSeq` across this session's own durable `companion_alert_pushed` events (never replay an alert already pushed), else — for a companion that has never pushed one at all — the current global max event seq (`Db.getMaxEventSeq`), so a brand-new grant fires nothing for pre-existing backlog and only reacts to activity going forward.

KNOWN, ACCEPTED per Code Review: a companion that has NEVER pushed an alert AND is re-armed after a daemon restart re-seeds to whatever the CURRENT global max is at that moment, not the max as of its own original `start()`. This is a narrow, rare window — it mirrors the reminder/heartbeat watchers' own conservative-restart posture — and was explicitly not fixed here.

## Source

Inline comments in `packages/daemon/src/companion/attention-push.ts`, as introduced by the file's original commit. Source: commit `31ca9b5d15d604e6737a64d71ec00a6373388d90`, no board card (`git blame` traces the module doc, `tickImmediate`'s doc, and the restart-reseed paragraph of `seedWatermark`'s doc all to this same commit — `feat(companion): attention-push lever — proactive fleet-alert relay to chat`, 2026-07-09). Relocated by card `dc0459d8` (tranche 1 on `companion/attention-push.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*`/bullet comment markers.
