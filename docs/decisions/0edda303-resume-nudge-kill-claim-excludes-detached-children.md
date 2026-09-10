# 0edda303 — the resume nudge's "background shells killed" claim excludes a DELIBERATELY DETACHED child

## Narrative

Filed by the Platform Lead 2026-08-24 from a Codescape manager's escalation, relaying an unprompted finding from worker `b13153a5` (Codescape card `80044b85`): mid-task during a 12:28Z restart, the worker's detached dev server SURVIVED even though the `[loom:daemon-restarted]` notice said "it also killed any background shells you had running." The server was launched through the tracked dev-server helper (`.claude/skills/orchestrate/scripts/dev-server.mjs`), whose whole design is a DETACHED, separately-tracked supervisor child that deliberately outlives the launching shell — so the notice's universal "any background shells" claim (established by `a305669e`) was true of ordinary shells and false of the one thing that helper produces.

This is operational, not cosmetic: a worker that trusts "background shells were killed" proceeds as if no dev server is running. On one project this meant a live vite holding `web/node_modules/@esbuild/win32-x64/esbuild.exe` open, so a subsequent `npm ci` failed `EPERM` and left `node_modules` half-removed — a failure that looks nothing like its cause (measured separately, card `f57e4922`).

Fix: drop the universal quantifier. The tail now scopes the kill claim to shells tied to the OLD pty and tells the agent to check for a detached process before relying on it being gone, instead of asserting a state the daemon never verified for that case. The fix does NOT kill detached children too — the helper is detached by design so it survives; the defect was the false claim, not the child's survival.

## Do not

- Do not restate "background shells were killed" as an unqualified universal claim anywhere in the resume nudge — it excludes a deliberately detached child (e.g. the tracked dev-server helper).
- Do not fix an over-broad kill claim by widening what gets killed (killing detached children too) — the detachment is deliberate; narrow the CLAIM, not the behavior.

## Source

JSDoc comment above `RESUME_NUDGE_TAIL` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 25-33 as of this tranche's HEAD (tranche 1). Card merged as commit `3d1d1c5`.
