# Serving & capture recipes

The operational recipes for eyeballing artifacts and dev servers, printing PDFs, and persisting
screenshots. The binding safety rules — bundled tracked-pid helpers only, stop the tracked pid before
requesting a merge, never kill by image name or port, absolute screenshot paths under allowed roots —
are in the core doctrine (the loop, step 9); this file carries the how.

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
kill by name or port can reach a process you never spawned — another dev server, an unrelated
project, or even the self-hosting daemon. Launch it through the **bundled** helper instead — it
records the EXACT child pid it spawns and tears down only that pid (never a name/port search):
`node .claude/skills/orchestrate/scripts/dev-server.mjs start <worktree-dir> -- <command...>` prints
the pid and returns immediately (the server keeps running); eyeball via Playwright at whatever URL
the command itself prints, then
`node .claude/skills/orchestrate/scripts/dev-server.mjs stop <worktree-dir>` before requesting a
merge for that worktree. A dev server left running is exactly what makes `worker_merge_confirm`'s
`git worktree remove` fail on Windows (the live process holds the worktree dir open) — stopping it by
tracked handle before you request the merge avoids that. **Never kill by image name
(`taskkill /IM node.exe`) and never kill by port** — a host-wide by-name kill has previously taken
down the entire self-hosting daemon.

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
