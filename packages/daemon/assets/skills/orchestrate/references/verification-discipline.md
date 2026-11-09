# Verifying the whole — detail

Read this when you or a worker verify UI/served output, launch or stop a dev server, pick a control for a
check, report a count derived from a grep, scope a build/cache folder in a kickoff, or review a "verified
live" claim. The core doctrine (loop, step 9) keeps the always-needed rules: the integrated pass is
yours, prefer the Playwright/`browserTesting` path, and the process-scoping safety line. Neighbouring
references: `serving-and-capture.md` (launch/stop helpers, static HTML, PDF, screenshots) and
`live-verification.md` (run-shaped features).

## Which browser, and who verifies

claude-in-chrome is Lead-only / special-case (the real
authenticated browser); a heavy page that mounts a live-session terminal can freeze its CDP
renderer, so eyeball only a LIGHT, non-terminal page (the project's `CLAUDE.md` names which routes
qualify). Division of labor keys on the provisioned capability, not the role name: any worker WITH
the Playwright surface **self-verifies** UI work before reporting done; only a worker WITHOUT it
reports UI work **up** for you to verify. You still own the integrated pass either way.

## Deployed target, bound URL, and port ownership

When the project runs its own deployed instance, a worker's dev-server self-verify can PASS while the
*deployed* build is stale, so your post-deploy pass must hit the **deployed/served** target (see *A
project that runs its own deployed instance*, in `deployed-instance-and-restart.md`). Workers must assert the bound URL from the tracked
server process itself: **start from the tracked-pid helper's own tracking file**
(`references/serving-and-capture.md`), never assume a default port and never rebuild a URL from the
bare port (one port can answer at one loopback host and refuse another on a healthy server). **A
`url` still `null` after `start` returns is not automatically "still starting"**: check the
tracking file's `portDetectionFailed`/`detectionEndedAt` first (the reference has the three-way
read and the fallback: the helper's own `logFile`, selected by the launcher's printed id, never a
content-sweep of the host's `loom-dev-server-*.log` files). **The recorded value can itself be
wrong: where other browser-capable workers may run dev servers on the same host, confirm the port is
owned by YOUR tracked pid** (the server's startup banner, or the listening socket's owning pid
traced UPWARD via parent pids, hop by hop, to the pid your launcher printed; never enumerate
descendants downward, since on Windows pid recycling can adopt unrelated processes, and don't stop
at one hop, since a shim between launcher and listener would falsely prove ownership). **Matching by
worktree path is not available on every OS:** Windows exposes no readable cwd for a running process,
so it works only where `/proc/<pid>/cwd` exists; and a memory-size field or the executable path
(identical across sibling instances of the same app) doesn't discriminate your instance from a
sibling's. Skip this cross-check on a solo-worker host. **A sibling's instance renders identically,
so an unverified port yields a plausible, screenshot-able, wrong result** (a worker was caught one
step from reporting another worker's data as its own). Hold all three when reviewing a
browser-capable worker's "verified live."

**The same identity discipline applies to the dev server's LOG.** Read the tracking file's `logFile`
(or the helper's printed log path) for the pid the worker holds; never grep every
`loom-dev-server-*.log` on the host and pick the one whose contents match. A stale log from an
unrelated worktree is indistinguishable from confirmation once chosen that way. The same trap
catches any search narrowed by what you already expect (a log sweep, a board/column filter, a grep
scoped to a hypothesis): none can surface disconfirming evidence. Identify an artifact by an id you
were GIVEN (tracking file, recorded pid, assigned path), never by sweeping the host and matching
content.

**Even the right bound URL isn't proof of the right data**: a dev server can fall back onto another
live default and serve another instance's data. **Assert the fixture's identity** (a count, a
sentinel string, an id that fails loudly if the data swapped), not just that the page rendered.

## Picking the control, and reporting a grep-derived claim

**Pick the control by the POLARITY of the check.** Whenever the answer you expect is the answer a
BROKEN instrument would also produce (including an absence-asserting test), the check is
silent-failing. Checking something **added** (expect ≥1): a known-bad-case negative control
suffices, since a zero is surprising. Checking something **removed** (expect zero): a negative
control only shows your query CAN return zero. **Run the pattern first where the token is KNOWN
PRESENT (the pre-change state); a zero there means the pattern is broken, not the target gone.** Use
a definition/use-form pattern only when you've READ the real declaration; keep bare-token
enumeration (list, don't count) as the fail-safe.

**A claim derived by grepping logs or files must state the files searched and the pattern matched,
and compare the filtered count to the raw count.** Report the broad marker's count (the population)
AND your filter's count: a filter that silently discards most of its population looks identical to
a clean one. **Sanity-check the raw side too**: an inflated broad count swaps a silent under-count
for a silent over-count. Both must measure the population you mean.
- **A right-answer instrument is more dangerous than a wrong one**, because only the wrong one gets
  caught by its consequences. A broken filter that still lands on the correct conclusion is never
  contradicted downstream; re-read the pattern against its label. A conclusion holding up is not
  evidence the method was sound.
- **Cross-review agreement is evidence only when the two checks covered different ground.** When
  both inherit the SAME narrow slice (one file, one filtered query), agreement multiplies
  *confidence* while coverage stays flat. Check what ground a second confirmation covered.

## Static HTML, live servers, PDF, screenshots, and process scoping

To eyeball a **static on-disk HTML artifact**, launch a **live dev server** against a worker's
worktree, print served HTML to **PDF**, or keep a screenshot **as a file**, read
`references/serving-and-capture.md` FIRST; its tracked-pid helpers (`serve-static.mjs` /
`dev-server.mjs`) ship in this skill's `scripts/` dir, so never hand-roll an ephemeral server or a
`netstat`/`taskkill` port hunt. The binding rules hold whether or not you open it: launch such
servers ONLY through the bundled helpers (they record the exact child pid); **stop that tracked pid
before you request a merge for the worktree** (a live process holds the worktree dir open and fails
the merge's cleanup on Windows); **scope any process match to its WORKTREE PATH and nothing else:
not image name (`taskkill /IM node.exe`), not port, not a session id, not a project id** (an id
LOOKS precise, which is why it's dangerous: a shared session or project id segment can match every
worktree it ever touched). A host-wide by-name kill has taken down an entire self-hosting daemon,
and a killed peer doesn't announce itself: it reads as an unrelated failure. **A captured pid is
also only valid until that process exits** (the OS reuses pids, fast on Windows): after any delay,
re-read that pid's command line right before a force-kill and refuse on a mismatch. Pass screenshot calls
an **ABSOLUTE path under an allowed root** (the per-session scratch dir, the project's vault path,
or, when set, `LOOM_PROJECT_WORK_DIR`) or no path at all; a bare filename lands in the repo working
tree.

**Never instruct a worker to create a test/build/cache folder at a drive root or loose in its home
directory.** When the project has a `LOOM_PROJECT_WORK_DIR` (your "Where things live" block or
`CLAUDE.md` names it), name it in the kickoff of a build/cache-heavy task so the worker doesn't
improvise a folder.

⚠️ **Don't tell a worker to share a real BUILD OUTPUT dir (`target/`/`build/`/`out/`) bare at the
project work dir's top level across branches; that differs from a shared dependency/download cache.**
Two branches on one bare build-output dir can compile, link, or run the OTHER branch's binaries
(false green or red). Say explicitly that build OUTPUT goes in a dir keyed to that worker's own
branch/worktree underneath it; only a content-addressed cache (package download cache,
`sccache`-style object cache) is safe to share bare.

(A worker's own stray process has an on-demand path, `worker_reap`: see `worker-steering-and-recovery.md`.)

## Interactive controls, run-shaped features, design notes

**A render-only eyeball is necessary but not sufficient for an interactive control.** For every NEW
interactive control (toggle, button, input, menu), verification must **EXERCISE it** and confirm an
**observable state change** (DOM/network/text differs before vs. after); "renders clean / 0 console
errors" only proves the page *drew*. Require the before/after diff as acceptance evidence, whether
you or a browser-capable worker verifies.

**Run-shaped features need a REAL end-to-end smoke run; hermetic gates alone are insufficient.**
When a feature's *runtime crosses a boundary a unit test stubs out*, a passing hermetic gate proves
the wiring, NOT that it works live. Two shapes, each a hard DoD:
- **Agent-turn runtimes** (agent runs, dispatch, tool-IO driven by a live model call): **≥1
  real-agent smoke run**.
- **Subprocess / spawn / hook boundaries** (shells out, spawns a child, fires an OS hook): **≥1 real
  spawn on the target OS**, confirming the observable side effect happened, not just that the exec
  was called.
The failure modes behind each shape and the hermetic-test cases they imply are in
`references/live-verification.md`; read it when carding or reviewing such a feature. Require the
worker to run whichever applies and report the live trace, or run the integrated pass yourself.

**Multi-requirement design note → explicit gate checklist.** When a task derives from a design note
with several distinct requirements, enumerate them as a checklist in the DoD and verify the merge
against *each* line; a requirement that isn't a checkbox silently slips.
