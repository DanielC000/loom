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

To eyeball a **live dev server** you launch yourself against a worker's worktree (not a static
artifact) — never hand-hunt `netstat`/`taskkill` for the listener PID afterward: that output is
locale-dependent to parse (a non-English OS locale renders different column headers/states), and a
kill scoped to anything but the worktree path — name, port, session id, or project id — can reach a
process you never spawned — another dev server, an unrelated project, or even the self-hosting daemon.
An id looks precise, which is exactly why it's the dangerous one: it matches every worktree that id
has ever touched, not just the one you mean. Launch it through the **bundled** helper instead — it
records the EXACT child pid it spawns and tears down only that pid (never a name/port/id search):
`node .claude/skills/orchestrate/scripts/dev-server.mjs start <worktree-dir> -- <command...>` prints
the pid, then waits briefly for the command's own startup banner (e.g. Vite's `Local:
http://localhost:5173/`) to appear in its captured log and prints the **actual bound URL** — built from
the host the command's own banner reported, not a guessed one, and the port it really bound, not
necessarily the one it was asked for (a dev server commonly steps to the next free port under
contention). That URL is recorded to the helper's tracking file (`url`, alongside the raw `host`/`port`
it was built from) — treat that **recorded URL as the starting point** for eyeballing via Playwright, not
as a given: **the recorded value can itself be wrong.** On a host where OTHER browser-capable workers may
be running their own dev servers concurrently, confirm the recorded port is actually owned by YOUR tracked
pid before trusting what you see (the printed startup banner, or the listening socket's owning pid
confirmed to be a DESCENDANT of the pid your launcher printed — walk the FULL process tree, not one hop;
an intermediate shim between the launcher and the real listener is common, and a walk that stops early
lands on the shim and falsely "proves" ownership of the wrong process). **Matching by worktree path is not
available on every OS — check before relying on it:** Windows exposes no readable
current-working-directory for a running process (not in the process-listing API, and a launch-time
working-directory parameter is not a readback of one), so path-matching only works on a platform that
exposes it (e.g. Linux's `/proc/<pid>/cwd`). And two Windows fields that LOOK like ownership proof aren't:
a process's working-set/memory-size field is memory, not a path, and its executable/image-path field is
identical for every sibling running the same app — neither discriminates YOUR instance from a sibling's.
Skip this cross-check on a solo-worker host where nothing else could own the port. **A sibling's instance
of the same app renders identically — nothing on screen distinguishes
"my fixture" from "a sibling's fixture" — so an unverified port yields a plausible, screenshot-able,
completely wrong result:** a worker has been caught one step from driving another worker's dev server and
reporting that app's data as its own corpus. 🔴 **Never
reassemble a URL from the bare port yourself** (`http://127.0.0.1:<port>` or `http://localhost:<port>`) —
the host a server actually answers on is that server's own choice, not something a consumer can safely
guess: the same port can be reachable at one loopback address and refuse the other on a perfectly healthy
server, so a guessed host can fail with a connection error that reads as "the server didn't start" against
a server that's fine. If an older tracking file has no `url` (written before this helper recorded one),
`stop` the tracked server and `start` it again for a fresh tracking file that includes one, or read the
helper's own printed log directly for the server's startup banner in the meantime. Then
`node .claude/skills/orchestrate/scripts/dev-server.mjs stop <worktree-dir>` before requesting a
merge for that worktree. A dev server left running is exactly what makes `worker_merge_confirm`'s
`git worktree remove` fail on Windows (the live process holds the worktree dir open) — stopping it by
tracked handle before you request the merge avoids that. **Scope any process match to its worktree
path and nothing else — not image name (`taskkill /IM node.exe`), not port, not a session id, not a
project id.** Image name and port are obviously broad; an id looks precise, which is exactly why it's
the dangerous one — a match on a shared session or project id segment can surface every worktree that
id has ever touched, not just the one you mean. A host-wide by-name kill has previously taken down the
entire self-hosting daemon, and a killed peer process doesn't announce itself as a kill — it reads as
an unrelated failure and gets misdiagnosed as one.

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
