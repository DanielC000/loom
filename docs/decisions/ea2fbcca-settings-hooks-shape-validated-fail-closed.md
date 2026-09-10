# ea2fbcca — generated settings.hooks shape is validated in-process, fail-closed

## Narrative

Card ea2fbcca is the CLASS fix for the `cd0c7fee`/`8d158088` double-wrap incident (that ONE-LINE
instance fix is already on main — see `PreToolUse`'s wiring in `writeSessionSettings`, which is
correctly shaped). Loom generates a settings file the `claude` CLI must accept, and nothing checked
that it does — the only detector was the CLI's OWN runtime rejection, which raises a BLOCKING
INTERACTIVE DIALOG inside an unattended session nobody is watching, presenting as a spawn hanging
forever with an empty transcript and `SessionStart` never firing (indistinguishable from a PTY/spawn
fault).

⛔ Deliberately NOT a shell-out to `claude doctor`: measured, in a controlled probe (card ea2fbcca, 3
CLI versions × 2 arms, 2026-08-25), to REPORT an invalid settings file and still EXIT 0 in all six
arms. An rc-based check would pass every malformed file forever — silently, confidently,
indistinguishable from a genuinely clean one. `hooksShapeViolations` instead asserts the OBJECT SHAPE
directly, in-process: every hook-event key must map to an array of "matcher groups",
`{matcher?: string, hooks: [{type: "command", command: string}, ...]}` — the exact invariant the
2026-08-25 incident violated (a well-formed JSON document with the wrong NESTING DEPTH; a bare "is it
JSON" check would have passed it clean). It returns a list of violations (empty ⇒ valid) — ONE
definition, shared by production (`assertValidHooksShape`/`writeSessionSettings`) and its regression
test (`test/settings-hooks-shape.mjs`, which imports this from `dist/`), so a hand-duplicated second
copy can't drift the two apart.

📌 MOVING TARGET (card DoD item 6): this models the ONE nesting-depth invariant the 2026-08-25 incident
actually violated, reverse-engineered from the CLI's own observed rejection message
(`hooks.PreToolUse.0.hooks.0.type: Invalid input`) — not the CLI's full settings schema, which is
undocumented and can tighten on any auto-update (the CLI auto-updates on a schedule nobody controls —
see the card's own timeline). It WILL miss a future CLI-side tightening this shape doesn't cover (e.g.
a new required field, a stricter `matcher` type): that is a known, accepted gap, not an oversight —
hand-mirroring the CLI's full upstream schema would chase a target this daemon doesn't own and would
itself drift silently. When the CLI changes what it accepts in a way this check doesn't model, the
failure mode reverts to today's (a blocking dialog nobody sees) until this validator is deliberately
widened against the NEW rejection message.

**Fail posture** (`assertValidHooksShape`, decided deliberately, DoD item 5): logs distinctively
(`[pty][settings-invalid]`, so this never reads as generic PTY/spawn noise — DoD item 4) and REFUSES
(throws) rather than write/hand back a bad file. Today's only detector for this defect class is the CLI's own blocking
dialog — the process never crashes, `SessionStart` never fires, and the transcript stays empty forever,
indistinguishable from a hung PTY/spawn fault until a human happens to attach and see the dialog.
Throwing HERE instead converts that SILENT hang into an immediate, loud, SYNCHRONOUS failure — and this
throw shape already has a graceful landing spot: `writeSessionSettings` is called from
`PtyHost.createPty`, which is called from `PtyHost.spawn()`, which `SessionsService.spawnWorker` wraps
in a try/catch that reconciles a synchronous `createPty` throw to `processState:'exited'` + a logged
`lastError` (see that catch's own doc in `sessions/service.ts` — the SAME reconciliation an OS-level
process-creation failure already gets). So refusing here doesn't introduce a new failure mode; it
converts an INVISIBLE one (a hang with nothing to grep) into the SAME visible one every other hard spawn
failure already produces. The alternative — writing the bad file anyway and letting the CLI's own
dialog eventually catch it — is strictly worse: it's the exact failure this card exists to eliminate.
(Not every spawn call site has that same catch — an uncaught throw elsewhere still surfaces as a loud
MCP/REST error rather than a silent daemon crash, since Node's async/request error boundaries catch it;
still preferable to a silent hang either way.)

`assertValidHooksShape` is called TWICE by `writeSessionSettings`: once on the in-memory object BEFORE
it reaches disk (DoD item 1), and once on a READ-BACK of what actually landed on disk (DoD item 4's
"read-back check") — the second catches anything that could go wrong between construction and disk (a
stray `JSON.stringify` replacer added later, a corrupted write) that the first can't see, and validates
the exact bytes the CLI will read.

## Do not

- Do not shell out to `claude doctor` as the validity check — measured to exit 0 on an invalid settings
  file across 3 CLI versions × 2 arms (2026-08-25).
- Do not widen `hooksShapeViolations` to hand-mirror the CLI's full undocumented settings schema — it
  would chase an unowned, drifting target. Keep it scoped to the nesting-depth invariant the 2026-08-25
  incident violated, and widen it deliberately, against a newly observed rejection message, only when
  the CLI tightens further.
- Do not let a generated bad-settings file reach disk/the CLI silently — refuse (throw) at both the
  pre-write and read-back checkpoints; do not write it "anyway" and rely on the CLI's own dialog to
  eventually catch it.
- Do not hand-duplicate `hooksShapeViolations`'s shape logic into `test/settings-hooks-shape.mjs` —
  that test imports the production definition from `dist/` specifically to avoid drift.

## Source

Two inline JSDoc comments in `packages/daemon/src/pty/claude-settings.ts` (`hooksShapeViolations`'s and
`assertValidHooksShape`'s own doc comments), commit `d8b03ddf5` (2026-08-26).
