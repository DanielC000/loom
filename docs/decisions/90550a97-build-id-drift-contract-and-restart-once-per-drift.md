# 90550a97 — build-id drift detection: contract with Codescape, three installed-side outcomes, one restart per drift

## Narrative

Build-id drift detection is layered onto a SUCCESSFUL health probe. It compares the RUNNING serve's `build` (from the `/graph/health` response) against the INSTALLED binary's build (a fresh, bounded read via `readInstalledBuild`) — NEVER `healthJson`'s `version` field, which is the static `CODESCAPE_VERSION` semver and reads identically across commits; wiring drift to it would produce a detector that reports "no drift" forever. `version` is deliberately never even read here.

THREE distinguishable outcomes on the installed side (agreed contract with the Codescape manager, not two): a real SHA (comparable), an HONEST `build: null` at exit 0 (a dist built outside a git checkout — a legitimate answer, never a failure), or a genuine couldn't-read (non-zero exit, or malformed/unparseable stdout at exit 0). The running side keeps its existing two-case fail-safe (absent from the response, or `build: null`). ALL FOUR of these non-comparable states mean "do nothing" — a restart only fires when BOTH sides resolve to non-empty, DIFFERING strings.

On a genuine mismatch this does NOT call `scheduleRestart`/`spawnServe` directly — exactly like the health-probe wedge-kill, it kills the live child ONCE and lets the EXISTING `child.on("exit")` -> `onDeath` -> `scheduleRestart` path own the actual restart, inheriting the same `restartAttempts` budget, backoff, and give-up ceiling (never a second restart channel that could resurrect a serve past an exhausted budget).

One deliberate restart per detected drift: `lastDriftRestartInstalledBuild` remembers the installed build already kicked a restart for, so a serve that keeps reporting a stale/failing `build` after that restart (the installed side hasn't moved) is never kicked again on every subsequent probe tick — that guard is what stops an endless restart cycle when the new build can't come up. A restart fires again once the installed build itself changes to something new — or once the daemon restarts (the guard is a private instance field reset in `start`/`stop`).

A genuine couldn't-read on the installed side is loud, not silent — "no drift" and "can't tell if there's drift" must never look identical (the `16b7c38c` lesson: a `finish([])` that couldn't tell "enumeration failed" from "nothing found" silently disabled worktree reaping for months). An HONEST `build: null` answer is the OPPOSITE case — codescape successfully told us it has no build id — and stays silent, exactly like the running side's own absent/null fail-safe; only a genuine read FAILURE gets the loud diagnostic, latched (via `lastInstalledBuildFailureReason`) to once per distinct reason, not once per 30s tick forever.

`readInstalledBuild` is the ONLY place that asks the installed binary for its build — bounded + async via `runBoundedSplit` (NOT the shared `runBounded` `ingest()` uses, since stdout/stderr must stay separate here), never on any hot path. AGREED CONTRACT with the Codescape manager (superseding an earlier wrong read of the CLI's failure shape): both `codescape version` and `codescape --version` work, resolving the same three outcomes above. Two guarantees this relies on: stdout is clean JSON ONLY (no banners mixed in) at exit 0, and the CLI reads the SAME `buildInfo.generated.ts` source `/graph/health` already serves, so there is no second resolution path that could disagree with the running side. Parsing is therefore STRICT (`JSON.parse` on the whole trimmed stdout) — never lenient/substring; a banner on stdout at exit 0 is a REAL defect on their side and must fail loudly, not get silently rescued. Confirmed live as of 2026-07-28: `codescape version`/`--version` returns `{"version":"<semver>","build":"<sha>"}` at exit 0, validated end-to-end against a genuine drift condition (installed != running, correctly classified). Do NOT read Codescape's internal `dist/buildInfo.generated.js` to make this "work" instead — an unversioned coupling that breaks silently the moment they reshape their build output.

`failed` is true ONLY for a genuine read failure (spawn/exec failure or timeout, or malformed/unparseable stdout at exit 0); it is FALSE for both a real build string AND an honest `build: null` — the two are deliberately kept distinguishable from a read failure.

## Do not

- Do not compare `healthJson.version` for drift detection — it is the static semver and never changes across commits; only `build` (a SHA) is comparable.
- Do not read Codescape's internal `dist/buildInfo.generated.js` or any other undocumented file to resolve the installed build — use `codescape version`/`--version`'s documented JSON contract.
- Do not leniently/substring-parse the `--version` stdout — parse strictly (`JSON.parse` on the whole trimmed output); a banner on stdout at exit 0 is a real defect on Codescape's side and must fail loudly.
- Do not fire a second restart for the same installed build once one has already been kicked for it — `lastDriftRestartInstalledBuild` must gate this, or a stuck new build causes an endless restart cycle.
- Do not let a genuine installed-build read failure stay silent — it must be loud (latched once per distinct reason), never indistinguishable from "no drift".

## Source

JSDoc method comments in `packages/daemon/src/codescape/supervisor.ts`, above the build-id-comparison portion of `checkBuildDrift`'s doc (originally part of lines 1568-1643) and above `readInstalledBuild` (originally lines 1751-1787), as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
