# b625a6ed — the decision-record injection counter is a local, metadata-only JSONL append

`decision-records.mjs` (a PostToolUse hook inside the Claude CLI) appends one line per record it injects to `<LOOM_HOME>/tmp/decision-records/injections.jsonl`; `decisions_for` (no-query mode) aggregates it per repo as `injections`, next to `recordCount`/`recordsByStore`.

Sink choice: a plain local file append rather than a POST through `hook-relay.mjs` -> `/internal/hook`. The relay is a network call with a timeout that can fail or delay, and would make the counter depend on a live daemon; the append is one sub-millisecond synchronous write, works with the daemon down, and the daemon reads the file on demand. It runs AFTER the injected output has flushed.

A line is `{ts, session, repo, anchorId, store, truncated, bytes}`. `repo` is the MAIN checkout root (a worker's linked worktree resolves through its `.git` file), so worker injections count against the project's repoPath.

## Do not

- Do not add a record's title, text, path or any other content to a line — the log is shared across every tenant on the host (the `LOOM_LOG_MESSAGE_CONTENT` posture); `store` is a fixed three-value enum, never a path.
- Do not let a sink failure alter, delay or block the Read's output — every write is wrapped and swallowed, and happens after the emit.
- Do not switch the sink to a network POST without a bounded timeout and a fail-open path; the file append was chosen precisely because it has neither failure mode.
