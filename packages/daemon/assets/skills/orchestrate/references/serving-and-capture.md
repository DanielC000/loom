# Serving & capture recipes

The operational recipes for eyeballing artifacts and dev servers, printing PDFs, and persisting
screenshots. The binding safety rules — bundled tracked-pid helpers only, stop the tracked pid before
requesting a merge, scope any process match to its worktree path and nothing else (not image name, not
port, not a session or project id), absolute screenshot paths under allowed roots — are in the core
doctrine (the loop, step 9); this file carries the how.

## Serving a static on-disk HTML artifact

To eyeball a **static on-disk HTML artifact** (no dev server) — or when the deliverable *itself* is a
static artifact a worker is building (a CV, a report, a static site) — don't navigate `file://`
(Playwright blocks it) and don't hand-roll a `python -m http.server` per render cycle. Serve its
directory over loopback with the **bundled** helper: `node
.claude/skills/orchestrate/scripts/serve-static.mjs start <dir>` prints the URL + the exact tracked
pid and returns immediately (the server keeps running); eyeball via Playwright at the printed URL,
then `node .claude/skills/orchestrate/scripts/serve-static.mjs stop <dir>` tears down EXACTLY that
tracked pid before you request a merge for that worktree — same tracked-pid discipline as
`dev-server.mjs` below, never a `netstat`/`taskkill` port hunt. It's dependency-free and already ships
in this skill's `scripts/` dir — point a worker producing such an artifact at it rather than letting
them reinvent an ephemeral server.

## Launching a live dev server against a worktree

To eyeball a **live dev server** you launch yourself against a worker's worktree, never hand-hunt
`netstat`/`taskkill` for the listener PID: grepping for a STATE WORD (e.g. `LISTENING`) silently
false-zeros on a non-English locale or an OEM/console codepage mismatch (a port/PID grep is unaffected).
Launch through the **bundled** helper: it records the EXACT child pid and tears down only that pid.
**`<worktree-dir>` must be an ABSOLUTE path in every call (start AND stop)**: a relative one resolves
against the helper's cwd, which can drift between calls and key one worktree under two tracking files;
the helper refuses a relative `<dir>`. `node .claude/skills/orchestrate/scripts/dev-server.mjs start
<worktree-dir> -- <command...>` prints the pid, waits briefly for the command's startup banner (e.g.
Vite's `Local: http://localhost:5173/`), and prints the **actual bound URL**, built from the host the
banner reported and the port it really bound (a dev server commonly steps to the next free port). It is
recorded in the tracking file (`url`, plus raw `host`/`port`). Treat the **recorded URL as the starting
point**, not a given: **it can itself be wrong.** Where OTHER browser-capable workers may run dev
servers, confirm the port is owned by YOUR tracked pid (the startup banner, or the listening socket's
owning pid traced UPWARD via parent pids, hop by hop, to the pid your launcher printed; never
enumerate descendants downward, since on Windows pid recycling can adopt unrelated processes; don't
stop at one hop, since an intermediate shim would falsely prove ownership). **Matching by worktree
path is not available on every OS:** Windows exposes no readable cwd for a running process, so it works
only where `/proc/<pid>/cwd` exists; a working-set/memory-size field is memory, not a path, and the
executable path is identical for every sibling running the same app. Skip this cross-check on a
solo-worker host. **A sibling's instance renders identically, so an unverified port yields a plausible,
screenshot-able, wrong result.** 🔴 **Never reassemble a URL from the bare port**
(`http://127.0.0.1:<port>` / `http://localhost:<port>`): one port can answer at one loopback address
and refuse the other on a healthy server, which reads as "the server didn't start." If an older
tracking file has no `url`, `stop` and `start` again, or read the helper's printed log for the banner.

**A `url: null` can mean three things; check `portDetectionFailed` first:** (1) detection in flight
(`portDetectionFailed` and `detectionEndedAt` both absent): re-read shortly; (2) detection gave up
(`portDetectionFailed: true` + `detectionEndedAt`): nothing will ever fill `url`, don't re-read; (3)
the tracked pid is no longer alive: the child died at spawn. **Fallback for (2): read the helper's own
`logFile` (tracking file field, or the path `start` printed), selected by the launcher's printed id,
never by grepping every `loom-dev-server-*.log` under the OS temp dir for matching CONTENTS**: a stale
log from an unrelated worktree is indistinguishable from confirmation once chosen that way, and any
search narrowed by what you expect (log sweep, board filter, grep scoped to a guess) can't surface
disconfirming evidence. Then `node .claude/skills/orchestrate/scripts/dev-server.mjs stop
<worktree-dir>` before requesting a merge for that worktree. `stop` refuses a recorded pid that is no
longer the supervisor it launched, tree-kills the rest, and prints `Verified: port N is free.`; on
nonzero exit with `STILL IN USE`, something outside the tracked tree (a launcher that already exited)
holds the port: read the pid from that server's own log/tooling and stop it by that pid, never by
port. A dev server left running makes `worker_merge_confirm`'s `git worktree remove` fail on Windows
(the live process holds the dir open). **Scope any process match to its worktree path and nothing
else: not image name (`taskkill /IM node.exe`), not port, not a session id, not a project id** (an id
looks precise but matches every worktree it ever touched). A host-wide by-name kill has taken down an
entire self-hosting daemon, and a killed peer reads as an unrelated failure. **A captured pid is only
good until that process exits:** the OS reuses pid numbers (quickly on Windows), so after any delay (a
graceful-shutdown wait, a retry) re-read that one pid's command line (or image path) immediately before a
force-kill and confirm it still matches what you launched; on a mismatch, refuse and log instead of
killing. The bundled helpers do this for you; a hand-rolled stop script must too.

## Printing served HTML to PDF

To turn that same HTML into a **PDF** deliverable, print it headlessly — no external converter. Drive
Playwright's Chromium to the served loopback URL and call `page.pdf`:
`await page.pdf({ path: 'out.pdf', format: 'A4', printBackground: true })` (`page.pdf` is
Chromium-headless-only; `printBackground` keeps CSS backgrounds/colors). Serve → navigate → `page.pdf`
gives a clean PDF from the exact HTML you eyeball.

## Keeping a screenshot as a file

To keep a screenshot **as a file** (to attach or diff), don't rely on claude-in-chrome `save_to_disk` —
it renders the inline base64 but writes no reachable file (a known claude-in-chrome save-to-disk gap). Use Playwright
`page.screenshot({ path })` against the loopback page (launch with `{ channel: 'chrome' }` to reuse
system Chrome and skip a download), or decode the base64 from the transcript for a shot already captured.
**Always pass an ABSOLUTE path** to the screenshot call (`page.screenshot({ path })` /
`browser_take_screenshot`) — and know **which** absolute root Playwright will accept. It only writes
under the **per-session scratch dir**, `.loom/tmp/scratch/<sessionId>` (exposed to a Playwright-mounted
session as the `$LOOM_SCRATCH_DIR` env var), or the project's configured vault path; a path outside
those roots is rejected ("… is outside allowed roots"). **Never a bare filename** — it defaults to the
session's working directory (the repo tree), risking a stray PNG committed into the repo. When unsure of
the root, pass no path at all and let the tool auto-name into the scratch dir.
