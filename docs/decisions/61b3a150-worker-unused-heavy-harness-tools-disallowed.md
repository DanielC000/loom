# 61b3a150 — heavy harness tools a worker never uses are disallowed at spawn (prompt size, not hazard)

`disallowedToolsForRole` (`pty/host.ts`) appends `WORKER_UNUSED_HARNESS_TOOLS` (`Artifact`, `Workflow`) for `role:"worker"` only, riding the same `--disallowedTools` flag as the human-prompt (8dd1dd1c) and harness-scheduling (7a624213) lists. Unlike those, nothing here is a hazard: `Artifact` and `Workflow` are inline (non-deferred) tool schemas that sit in every call's cached prefix for nothing.

## Why these two, and why only these

- Source: research card `65e1fc5d` found the median first call carries ~137K tokens, 43% of all input tokens across 300 transcripts, and that dropping unused heavy tools is a baseline cut.
- Verified absent from reliance: no mention in the `/worker` skill, in `packages/daemon/src`, or in any of the six worker briefs (Dev, Bugfix, QA, Web Designer, Code Reviewer, Research Analyst; checked by the manager via `/api/agents`, with `worker_report` as the positive control). Only the real-spawn scheduling test mentions these names, and not as a dependency.
- Rejected: `ReportFindings` (a Code Reviewer worker may load the code-review skill), `SendFeedback` (tiny, no gain), `ListAgents`/`ReadNotifications` (small, possibly load-bearing). Deferred tools (`ArtifactComments`, `ArtifactData`, `DesignSync`, `SendToProject*`, `PushNotification`, `Monitor`, web tools) appear only as name lines, so disallowing them saves about nothing.

## Mechanism and saving

`--disallowedTools` removes a tool from the model's tool list (CLAUDE.md human-prompt bullet); `disallow-harness-scheduling-tools-real-spawn.mjs` is the live proof of that mechanism and was deliberately NOT run for this card. Saving is ESTIMATED at ~5-6K tokens per call (Artifact ~4K, Workflow ~1.3K, from char counts of the schemas in a worker's prompt) and is UNMEASURED until the Lead compares worker first-call medians before and after with the `02cc2fbb` script.

## Codex parity

None needed: `createCodexPty` has no per-tool lever and never reads `disallowedTools` (see the 7a624213 record).

## Do not

- Do not add these tools to any other role without a per-role check of its brief and doctrine; this list is worker-only.
- Do not add a deferred tool here expecting a saving; it is only a name line.
- Do not quote the saving as measured before the Lead's first-call comparison exists.
