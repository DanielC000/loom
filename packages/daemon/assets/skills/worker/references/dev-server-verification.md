# UI / dev-server self-verification (`browserTesting`-only)

Read this before driving a browser to verify a UI/visual change — it is unreachable from a task that
never touches a rendered feature. Continues the same numbered doctrine step (self-verify before
reporting `done`) from `SKILL.md`.

For UI/visual work: if your session **mounts
   Playwright** (the `@playwright/mcp` surface — `browserTesting` provisioned + allowlisted, the QA / Web
   Designer rigs), **self-verify** by driving Playwright to the running app and confirming the change
   renders and behaves before reporting done — and **read `references/browser-verification.md` (under
   this skill's own directory) BEFORE driving the browser**: the screenshot/scratch-dir, download, and
   click-arg mechanics live there and are `@playwright/mcp`-specific (short version: capture screenshots
   with NO filename so they auto-name into the out-of-tree scratch dir — a bare or relative path lands
   in the repo working tree and risks an accidental commit). A session on a DIFFERENT browser
   tool (e.g. claude-in-chrome) or with no browser at all gets none of those mechanics — skip them and
   report UI work **up** for your manager to verify instead. For a NEW interactive control (toggle,
   button, input, menu), a render-only check is not enough: **EXERCISE it** and confirm an **observable
   state change** — DOM/network/text differs before vs. after — not just that the page renders without
   console errors. When you self-verify, point Playwright at the dev server's **actual bound URL** —
   assert the bound port from the tracked server process itself, by whatever means your OS exposes (the
   framework's own startup banner, when captured, is one way but not the only one); never assume a
   default (a stale server already holding the default port would silently verify the wrong thing and
   report a false pass). **If you launched via the bundled `dev-server.mjs` tracked-pid helper (see its
   own note below), its recorded `url` is a starting point, not a given — the recorded value can itself be
   wrong.** And a `url` still `null` is not automatically "still starting" — read the tracking file's
   `portDetectionFailed`/`detectionEndedAt` fields: both absent means detection is genuinely still in
   flight (re-read shortly); both present means detection gave up for good and nothing will ever fill
   `url` in, so the sanctioned next step is to read the helper's own `logFile` yourself (the tracking
   file's `logFile` field, or the path `start` printed) — selected by the launcher's own printed id, never
   by content-sweeping every `loom-dev-server-*.log` on the host for one whose contents happen to match
   what you expected (see the log-identity discipline just below — the same trap applies here). On a host
   where OTHER browser-capable workers may be running their own dev servers
   concurrently, confirm the recorded port is actually owned by YOUR tracked pid before trusting what you
   see (the startup banner, or the listening socket's owning pid confirmed to trace UPWARD — via each
   process's parent pid, hop by hop — to the pid your launcher printed; do NOT enumerate the launcher's
   descendants downward instead, since on Windows pid recycling plus a parent pid left uncleared when its
   own parent exits can let a downward closure silently adopt unrelated processes that merely reuse that
   pid number. Don't stop at one hop either: an intermediate shim between the launcher and the real
   listener is common, and a walk that stops early lands on the shim and falsely "proves" ownership of
   the wrong process). **Matching by worktree path is not available on every OS —
   check before relying on it:** Windows exposes no readable current-working-directory for a running
   process (not in the process-listing API, and a launch-time working-directory parameter is not a
   readback of one), so path-matching only works on a platform that exposes it (e.g. Linux's
   `/proc/<pid>/cwd`). And two Windows fields that LOOK like ownership proof aren't: a process's
   working-set/memory-size field is memory, not a path, and its executable/image-path field is identical
   for every sibling running the same app — neither discriminates YOUR instance from a sibling's. Skip
   this cross-check on a solo-worker host where nothing else could own the port. **A sibling's
   instance of the same app renders identically — nothing on screen distinguishes "my fixture" from "a
   sibling's fixture" — so an unverified port yields a plausible, screenshot-able, completely wrong
   result:** a worker has been caught one step from driving another worker's dev server and reporting that
   app's data as its own corpus. **The same identity discipline applies to a dev server's LOG, not just
   its port.** If you need your own dev server's captured output, read it via the tracking file's
   `logFile` field (or the helper's own printed log path) — never grep every `loom-dev-server-*.log` on
   the host and pick whichever one's CONTENTS match what you expected to find. A stale log from a
   different worktree, written hours earlier, is indistinguishable from confirmation once you've selected
   it that way: the sweep can only return an artifact that agrees with the hypothesis you scoped it with,
   so nothing about picking a match ever feels wrong. The same trap catches any search you narrow by what
   you already expect — a log sweep, a board/column filter, a grep pattern scoped to your hypothesis —
   none of them can surface disconfirming evidence, so a clean or matching result proves nothing on its
   own. Identify an artifact by an id you were GIVEN (a tracking file, a pid you recorded, a path you were
   assigned) — never by sweeping the host and matching content. Even the
   right port isn't proof of the right data — a server can fall back onto another live default and serve
   someone else's data with everything still rendering correctly, so **assert the fixture's identity** (a
   count, sentinel, or id) rather than just that the page looks right. **Pick the control by the POLARITY
   of what you're checking — whenever the answer you expect is the same answer a broken check would also
   produce, the check is silent-failing.** Confirming something now PRESENT (≥1): a known-bad-case
   negative control is enough — a zero is surprising and gets investigated. Confirming something now
   ABSENT (zero): a negative control only proves your check CAN return zero, which is what you already
   expected — run the same check where the target is KNOWN PRESENT (e.g. before your change) first, and
   treat a zero THERE as a broken check, never as green. The same trap catches a grep for a
   definition/use-form pattern you only GUESSED at — read the real declaration before relying on one, and
   keep bare-token enumeration (list, don't count, the matches) as the fail-safe. **Stop any dev server
   (or other long-running process) you started, and stop it SAFELY** — but time it right: **the risk
   window opens the moment you run an install that rewrites `node_modules` (`npm ci`, `npm install`, or a
   typecheck/test script that calls one), not "before you report done."** Loom already reaps
   worktree-rooted stray processes for you before the merge gate, on worker stop, and before worktree
   removal — so the gate and the merge-time cleanup are protected, and you never need to hunt a stray for
   THEIR sake. But a live dev server (vite/esbuild and friends) holds OS file locks on binaries inside
   its own `node_modules` (on Windows a live binary can't be unlinked), and — depending on the project's
   own install shape, e.g. a gate step that reinstalls a subdirectory's deps — deleting and reinstalling
   it out from under that running server can fail `EPERM`/lock **in your own foreground shell**, many
   turns before any report. **The collateral tell:** a failed install can leave `node_modules`
   half-removed, so the *next* command dies with an unrelated-looking `Cannot find package …` — if you
   see that right after an install failed, suspect a still-running server of your own before you suspect
   your diff. **The remedy is to stop the server you started, via the handle you started it with** (the
   child process YOU spawned) — not to hunt for it. If your session also has the `/orchestrate` skill's
   doctrine injected (check for `.claude/skills/orchestrate/scripts/dev-server.mjs`), launch your dev
   server through that bundled tracked-pid helper instead of a bare background command, so you always
   hold a clean pid to stop: `node .claude/skills/orchestrate/scripts/dev-server.mjs start
   <your-worktree-dir> -- <command...>` to start, `... stop <your-worktree-dir>` to stop — otherwise just
   stop the child process you spawned directly. Don't re-discover a lost handle by process name or port.
   **If you ever do need to find a stray process to stop it, scope the match to its WORKTREE PATH and
   nothing else — not bare image name (every `node`/`esbuild`), not port, not a session id, not a project
   id.** Image name and port are obviously broad, so they're easy to reject; an id LOOKS precise, which is
   exactly why it's the dangerous one — a match on a shared session or project id segment can surface
   every worktree that id has ever touched, including a different session's still-running process and
   long-dead worktrees that happen to share the prefix. The worktree path is the only selector that is
   actually yours. Getting this wrong reaches the human's own dev servers, unrelated projects, and even
   the host daemon (it has already stopped an unrelated process) — and a killed peer process doesn't
   announce itself as a kill, it reads as an unrelated failure, so the victim misdiagnoses its own work
   instead of catching the real cause.
