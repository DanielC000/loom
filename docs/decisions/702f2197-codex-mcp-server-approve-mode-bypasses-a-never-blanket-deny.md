# 702f2197 — a per-server `default_tools_approval_mode=approve` override bypasses codex's `-a never` blanket MCP-tool-call denial

## Finding: `-a never` denies an MCP tool call only if it was ever classified as approval-requiring

Card `702f2197`'s defect: a codex worker's own `worker_report` call was denied ("requires approval and approval policy is never"). Per decision record `d7657543`, `-a never` is deny-by-default, not approve-everything — but the open question that record left unanswered was WHY an MCP tool call requires approval at all, and whether a narrower lever exists than the blanket `-a`/`-s` flags.

VERIFIED at codex-cli 0.153.4 source, tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (same method `d7657543` used — reading `codex-rs/**` directly, not inferring from filenames):

- `codex-rs/core/src/mcp_tool_call.rs:1533` — `request_mcp_tool_user_approval` unconditionally returns a denial when `approval_policy == AskForApproval::Never`. This function contains the exact denial message Loom observed.
- That function is only ever reached from `maybe_request_mcp_tool_approval` (same file, ~line 1441), which returns early (no approval requested at all — the call just proceeds) when `!requires_mcp_tool_approval_for_mode(annotations, policy.mode)`.
- `requires_mcp_tool_approval_for_mode` (same file, ~line 2345) is a `match` on an `AppToolApproval` enum with four variants (`codex-rs/config/src/mcp_types.rs:26`): `Auto` (default — classifies by the MCP server's own declared tool annotations: `destructiveHint`/`readOnlyHint`/`openWorldHint`; a tool with NO annotations at all defaults to requiring approval), `Prompt` (always requires approval), `Writes` (requires approval unless `readOnlyHint` is true), and **`Approve` (returns `false` unconditionally — never requires approval, regardless of annotations)**.
- `policy.mode` (i.e. which `AppToolApproval` variant applies) is resolved per call by `custom_mcp_tool_approval_mode` (same file, ~line 1189): a per-tool override (`mcp_servers.<server>.tools.<tool>.approval_mode`) falling back to a per-server default (`mcp_servers.<server>.default_tools_approval_mode`), both read live from `codex_config::types::McpServerConfig`, deserialized from the SAME `mcp_servers` config table `-c key=value` overrides already populate.

⇒ **The classification is per-tool-call, not a blanket `-a`-flag override.** Setting `mcp_servers.<id>.default_tools_approval_mode = "approve"` for one specific server makes `requires_mcp_tool_approval_for_mode` return `false` for every tool on that server, so `maybe_request_mcp_tool_approval` never even calls the function that contains the `-a never` blanket-deny check — the tool call proceeds without ever entering the approval path. This does NOT touch `-a`/`-s`: the exec/shell sandbox and every other MCP server's approval classification are completely unaffected.

**Evidence tier:** ESTABLISHED (real upstream source at the pinned commit, same tier as `d7657543`'s own findings) for the mechanism. Empirically CONFIRMED (not merely inferred) that the config key itself is accepted: `codex --strict-config -c mcp_servers.<id>.url=http://127.0.0.1:1/x -c mcp_servers.<id>.default_tools_approval_mode=approve -a never -s workspace-write --no-alt-screen < /dev/null` fails with `Error: stdin is not a terminal` — the SAME failure signature as a known-good control key (`check_for_update_on_startup=false`), never the `Error loading config.toml: unknown configuration field ...` signature a genuinely-unknown key produces (verified against both a positive control, a known-valid key, and a negative control, a deliberately bogus key, both checked BEFORE trusting the technique). This proves config-load acceptance, not the full runtime round-trip (an actual MCP tool call succeeding end-to-end) — that would require a real model turn, not attempted here (cost/risk judgment call, see the card's own worker_report for why).

## Why this is narrow, not a blanket widening

- Does not touch `-a never` (still denies every OTHER approval-requiring action — shell commands, patches, anything not on an explicitly-approved MCP server).
- Does not touch `-s workspace-write` (the exec/filesystem sandbox, including the `.git` deny ACE, is completely unaffected).
- Scoped PER MCP SERVER, by server id — `mcpServersToCodexArgs`'s new `autoApproveServerIds` option (codex-host.ts) is applied ONLY to Loom's own first-party server ids (`loom-tasks`, `loom-orchestration`) at the one call site in `createCodexPty` (pty/host.ts). It is never applied to `playwright`, `markitdown`, `codescape`, or any owner capability-catalog server — those CAN be third-party and must keep going through the normal (denied-under-`-a never`) approval classification.

## Do not

- Do not widen `autoApproveServerIds` to include every mounted MCP server indiscriminately — only Loom's own first-party, daemon-local, role-gated server ids belong in that set; a capability-catalog/owner-configured server can be third-party and must not be silently auto-approved.
- Do not read this as proof of the full runtime round-trip (an actual tool call succeeding) — only the config-acceptance half was verified without spending a real model turn. If that's ever needed, budget for a real API call on a real account deliberately, not as a side effect of a test run.
- Do not reach for `-s danger-full-access`/`--dangerously-bypass-approvals-and-sandbox` — unrelated to this finding and still forbidden by `d7657543`.

## Source

`codex-rs/core/src/mcp_tool_call.rs` and `codex-rs/config/src/mcp_types.rs` at tag `rust-v0.153.4` (commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`), read directly via the GitHub API at investigation time. Local empirical confirmation via `codex --strict-config` against the installed codex-cli 0.153.4 binary on this host.
