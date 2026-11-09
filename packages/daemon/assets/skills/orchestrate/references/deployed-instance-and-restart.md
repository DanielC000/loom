# A project that runs its own deployed instance — and restart/redeploy notes

Read this when the project runs a live instance off its mainline branch, when you are about to call
`deploy` or `served_status`, when you switch the canonical checkout's branch, or when you write the
free-text reason/note on a shared restart or redeploy that other sessions will read.

## A project that runs its own deployed instance

When the project you orchestrate runs a live instance off its mainline branch (read its name; never
assume it), merged code is **not running** until that instance is rebuilt and redeployed, so merging
alone doesn't let you verify new behavior against the live target.

**Redeploy yourself when a deploy command is configured.** Your **`deploy`** tool rebuilds + redeploys
your OWN project's instance: after a merge that needs to go live, call `deploy`, then run your
integrated pass against the freshly-deployed target instead of parking the change as live-pending.
**`served_status`** is the read-only "what am I serving?" check (which build is live): use it to
confirm a redeploy took and to catch a stale instance. Only with **no** deploy command do you use the
fallback below.

**Fallback: one consolidated deploy ask at SESSION-END (no deploy affordance only).** Don't mint a
deploy command and don't nag per merge. Track "live-pending" merges and surface them as ONE explicit
owner action in your done-report ("these merged changes need a redeploy of <instance>").

**Read-only access to the deploy target is a verification affordance; use it.** If you can reach the
live target read-only at all (SSH, read API, status endpoint, log tail, state/PID file), verify against
the **live process/state** instead of the repo alone. The loop: **diagnose against the live target →
fix in the repo → redeploy (`deploy` yourself, else hand the owner the EXACT command/action, not
"please redeploy") → re-verify against the live target.**

**A "merged but not yet live" claim is true only until the next restart, and nothing expires it for
you.** It describes a running *process*, not the repo. Two disciplines, both required:
- **Stamp it**: "as of `<ISO timestamp>` / build or boot `<id>`", not a bare assertion.
- **Re-verify it whenever you REWRITE a document or card body that carries it forward**: re-check that
  specific claim against the live target before re-saving; don't copy the old sentence across.

**Deploy state is a build artifact's timestamp AND a subsequent boot/restart, never the build
timestamp alone.** A rebuilt-but-not-restarted build has a fresh mtime but nothing serves it. Confirm
the artifact was rebuilt AND the serving process restarted since.

**If your surface lets you switch which branch your project's canonical checkout targets (e.g.
`project_checkout_branch`), a switch changes what the NEXT deploy/restart from that checkout builds.**
Treat it as a deliberate, auditable act: a switch made to compare a side branch silently becomes the
source of the next rebuild on a self-hosted project. **Switch through that tool, never a raw git
command**, whenever your platform tracks which branch it trusts as mainline: a raw checkout/rename
looks like an accident and can flag or refuse the NEXT landing.

## A restart/redeploy note other sessions will read

Some platforms have a shared restart or redeploy path that resumes or notifies sessions beyond the one
that triggered it, relaying your free-text reason/note to them. If yours does:

**Scope your claim to what your own tools can see.** `worker_list` (or your platform's equivalent)
shows only your own direct children; it can't tell you whether a SIBLING manager, in your project or
another, has work in flight. Without a tool that establishes "nobody, anywhere, has live work," don't
write "everything is quiet" or "safe to proceed"; write what you checked ("my own workers are idle and
my own queue is empty"). A merge/gate queue is a narrower, DIFFERENT claim (it may cover pending
merges fleet-wide yet say nothing about workers mid-task). Name which one you checked.

**Know what the note is FOR.** It's a courtesy statement of your own intent, never a clearance another
session should rely on to decide its in-flight work is safe; the reader can't verify it.

**A reassuring measurement of the wrong thing is worse than none.** A session that reads live/busy
through a disruption says nothing about whether its worktree, branch, or in-flight work survived;
liveness and survival are different facts.
