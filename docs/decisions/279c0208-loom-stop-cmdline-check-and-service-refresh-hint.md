# 279c0208 — `loom stop` command-line identity check, and `loom update`'s service-refresh hint

Follow-ups from `0da5a3f7` (worker `d464bf28` flagged both as deliberate scope calls at the time).

## Point 1 — `stop()`'s hard-kill ladder had no command-line check

`stop()`'s pid-identity check (task `a242c747`) resolves a hook timeout with no HTTP response into one of
three port-probe outcomes: `refused` (nothing listening — treat as stale, never signal), `other-error`
(undecidable — refuse), or `timeout` (the port IS held but unresponsive — fall through to the signal
ladder unchanged, on the reasoning that a genuinely wedged real daemon must stay killable).

That `timeout` fall-through had no further identity check: a pid recycled after a crash, whose new owner
happens to still be holding the recorded port (not the daemon itself, but some unrelated listener), would
be signalled exactly like a real wedged daemon — SIGTERM, then SIGKILL/`taskkill /T /F` on Windows, which
kills that stranger's WHOLE process tree.

**The fix (revised after code review — see "Review follow-up" below)**: `isOurDaemon(rec)`
(`bin/loom.mjs`) confirms the pid's LIVE COMMAND LINE actually matches what WE recorded launching it
with, before falling through to the signal ladder. Two tiers: (1) PREFERRED — `rec.entry`, the exact
absolute path recorded in the pid file at spawn time (`writeForegroundPidRecord`/`startDetached`), checked
as a verbatim substring of the live command line; (2) a narrower, package-anchored regex fallback for a
pid record written by a CLI predating this field. A real wedged daemon passes tier 1 trivially (a live
pid's command line is readable regardless of HTTP responsiveness, and every pid record this CLI now
writes carries `entry`), so the "must stay killable" guarantee is preserved.

**Deliberately scoped to the `timeout` branch only, not every signal.** The `hook.status` defined cases
(200/202 that timed out on `waitForDown`, 404, 401) already treat ANY HTTP response on the recorded port as
identity-confirmed — `cli-stop-auth.mjs` pins this: a guarded daemon that correctly 401s a bad credential
still gets stopped by the fallback ladder, because it's speaking the same control-plane protocol a real
daemon does. An early draft of this fix applied the command-line check unconditionally (before every
signal, regardless of `hook.status`) and broke that test: its stand-in daemon is a bare `node -e <script>`
process that behaves exactly like a guarded Loom daemon over HTTP but has no loom-shaped command line.
Scoping the check to the one branch that has no HTTP confirmation at all avoids re-litigating the
already-tested "HTTP response ⇒ identity confirmed" contract.

## Point 2 — `loom update` never touches a registered OS-autostart service

`0da5a3f7` fixed the mac launchd plist's `KeepAlive` to a crash-only (`SuccessfulExit:false`) posture so a
`loom update`-driven graceful stop doesn't race launchd's own auto-respawn. That fix only helps an install
whose on-disk plist actually reflects the new generator — `loom update` upgrades the CLI/daemon code in
place but never touches `bin/service.mjs`'s registered artifact, so an EXISTING install (registered before
this fix shipped) keeps running under its OLD `<true/>` plist, race included, until someone re-runs
`loom service install`.

**Decision: hint, never silently rewrite.** `loom update` now calls `isServiceRegistered()`
(`bin/service.mjs`) after a successful reinstall and, if a service is registered for the current platform,
prints a one-line hint to re-run `loom service install`. It does NOT auto-regenerate and
reload/unload the artifact itself.

Reasoning: silently rewriting (and, on macOS, unload/reload-ing) a registered OS service as a side effect
of an unrelated `update` command is a bigger, more surprising side effect than this command already takes
on, for a fix that is one command away. It would also require diffing generated content against what's on
disk and re-running the OS-tool install sequence — none of which is runtime-verifiable on a non-Mac dev
box for the macOS case this decision is actually about (see "Unverified" below). Detection alone
(`isServiceRegistered`) IS exercised cross-platform via `bin/service.mjs`'s existing hermetic
`servicePlan`/`queryCmd` tests, so the hint only relies on what's actually tested.

## Review follow-up (reviewer 679816fc) — the original command-line match was not an identity check

Code review of commit `eb958016` REPRODUCED a Major: `isOurDaemon`'s original regex
(`DAEMON_CMDLINE_RE = /[\\/](?:dist[\\/]index\.js|loom(?:\.mjs)?)(?:["'\s]|$)/i`) matches ANY path
containing `dist/index.js` (an extremely common bundler output path) or a bare `loom`/`loom.mjs` path
component. A foreign Node app holding the recorded port at `…\some-other-node-app\dist\index.js` got
`taskkill /T /F`'d — exactly the "kill a bystander tree" failure mode this whole card exists to close. The
claim in this record's earlier revision — "only a genuinely unrelated process is now refused" — was FALSE;
the check as originally shipped did not reliably distinguish Loom from an unrelated process at all.

**Fix: record what we launched, match that exactly.** `writeForegroundPidRecord` now records
`entry: process.argv[1]` (the exact path THIS live process was invoked with — the npm global symlink or
the Windows shim's resolved path); `startDetached` records `entry: daemonEntry` (the exact absolute path
the child was spawned with). `isOurDaemon(rec)` requires the pid's live command line to contain that exact
string (case-folded + separator-normalized on win32 only). This is an EXACT match against something WE
ourselves produced, not a generic shape — it cannot mistake a foreign process for the daemon merely
because their paths share a bundler-output name.

**Legacy fallback, tightened, not removed.** A pid record written by a CLI predating the `entry` field has
nothing to match exactly, so it falls back to `LEGACY_DAEMON_CMDLINE_RE =
/loomctl[\\/](?:dist[\\/]index\.js|bin[\\/]loom\.mjs)|[\\/]bin[\\/]loom(?:["'\s]|$)/i` — anchored to this
package's OWN name (`loomctl`) for the two generated-entry shapes, plus the POSIX global-symlink
invocation anchored on the `bin` DIRECTORY (`…/bin/loom`, which has no `loomctl` ancestor to anchor on
instead). This no longer matches an unrelated `dist/index.js` or `loom.mjs` on its own — the reviewer's
first repro (a foreign `…/some-other-node-app/dist/index.js`) is refused under this fallback, while a
genuinely loom-shaped legacy path (`…/loomctl/dist/index.js`) still matches. The corrected claim: **the
command-line check now refuses any process whose path isn't provably ours — either an exact match to what
we recorded launching, or narrowly anchored to this package's own name or its `bin` directory** — not
"mirrors `isOurSupervisor`" (that function's own bare regex-on-script-name shape is closer to only the
LEGACY fallback tier here, and even that tier is tighter than `isOurSupervisor`'s, which has no
package-name anchor at all).

**Second review round — the symlink alternative was STILL too loose.** The first fallback shape above
used a bare `[\/]loom(?:["'\s]|$)` for the symlink case — matching ANY `loom`-named path COMPONENT, not
just a symlink under a `bin` dir. Code review reproduced this too: `vim /home/u/src/loom` and
`git -C /home/u/loom status` both matched (a directory happening to be named `loom`, nothing to do with
the CLI). Anchoring on `[\/]bin[\/]loom` instead — the symlink's actual location (`/usr/local/bin/loom`,
an npm prefix's `bin/loom`) — closes this without losing the shape it exists for. A legacy pid record
vanishes at the next `loom start` regardless (a fresh spawn always writes `entry`), so erring toward
refusal here costs nothing durable.

**`isServiceRegistered`'s OS-query spawn is now bounded** (`SERVICE_QUERY_TIMEOUT_MS = 5000`,
`bin/service.mjs`): `loom update` calls it AFTER already stopping the daemon it might be about to restart,
so a hung/unresponsive query tool must never hang the update with the daemon already down. Scoped to the
query call only — `runStep`'s install/uninstall callers are unchanged (unbounded). A timeout surfaces as
`spawnSync`'s own `status: null` + `error.code: "ETIMEDOUT"`, which the existing `ok` check already treats
as failure — no new branch needed, verified directly against a real hung child process.

**`cli-service-registered-check.mjs`'s "not registered" case is no longer hard-coded to `platform:
"linux"`** — that assumed `systemctl` is always absent, true on this Windows dev box but FALSE on a real
Linux host (incl. `ubuntu-latest` CI, where `systemctl` exists even though no `loom.service` unit is
registered). It now probes `systemctl`/`launchctl` at run time and picks whichever this host actually
lacks, so the test's own hermeticity claim is true on whichever host runs it, not just the one it was
written on.

## Unverified (no Mac available)

Both points touch macOS-specific runtime behavior (`launchctl`, the LaunchAgent plist) that could not be
live-verified on the Windows host this fix was written on:

- `loom service install`; `loom stop` ⇒ stays down; `kill -9` ⇒ respawns; `loom update` ⇒ no respawn race
  — the live Mac check the original card asked for. Still needs an owner run on a Mac.
- The service-refresh hint's exact wording/placement in a real `loom update` run against a real launchd
  registration — verified here only via `bin/service.mjs`'s existing hermetic `servicePlan` unit tests
  (which already assert the plist generator + `queryCmd` shape) plus a new hermetic test of
  `isServiceRegistered`'s registered/not-registered branches using the SAME structural-only posture
  `cli-service.mjs` already documents for the mac/linux paths.

## Do not

- Do not widen the `isOurDaemon` command-line check to run before the `hook.status`-defined signal paths
  (the ones with an actual HTTP response, incl. 404/401) — that re-breaks `cli-stop-auth.mjs`'s guarded-401
  scenario, which is deliberately a bare, non-loom-shaped stand-in process. Keep it scoped to the `timeout`
  branch of the `hook.status === undefined` case.
- Do not revert `isOurDaemon`/`LEGACY_DAEMON_CMDLINE_RE` to the original unanchored
  `dist[\/]index\.js|loom(\.mjs)?` shape, and do not un-anchor the symlink alternative back to a bare
  `[\/]loom(?:["'\s]|$)` — code review reproduced BOTH as false positives (a foreign app's own
  `dist/index.js`; an unrelated `loom`-named directory via `vim`/`git -C`). Any future change here must
  stay anchored to something provably ours (the recorded `entry` path, this package's own `loomctl` name,
  or the symlink's `bin` directory), never a generic bundler, script-name, or bare-directory-name shape.
- Do not stop recording `entry` in the pid file (`writeForegroundPidRecord`/`startDetached`) — that is
  what lets `isOurDaemon` use tier 1 (exact match) instead of falling back to the narrower, legacy regex
  tier for every pid record going forward.
- Do not remove the timeout from `isServiceRegistered`'s query spawn, and do not add one to `runStep`'s
  install/uninstall callers without separately deciding that tradeoff — this fix scoped it to the query
  path only, on purpose.
- Do not hard-code `platform: "linux"` (or any other fixed platform) as the "OS tool is absent" case in
  `cli-service-registered-check.mjs` — probe at run time; which platform's tool is genuinely absent depends
  on the host actually running the test.
- Do not make `loom update` silently rewrite or reload a registered OS-autostart service artifact — see
  the reasoning above. If that decision is revisited, it needs a live Mac round-trip check first, not just
  a code change.
