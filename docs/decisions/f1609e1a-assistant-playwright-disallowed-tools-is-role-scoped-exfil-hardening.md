# f1609e1a — companion-only Playwright file-path exfiltration hardening, scoped to the assistant role

## Narrative

Security hardening (card f1609e1a, a residual the Code Reviewer surfaced OUTSIDE card 7159466a's RCE scope): beyond `browser_run_code_unsafe`, `@playwright/mcp`'s default tool set also mounts two tools that take ABSOLUTE HOST FILE PATHS and read them into a page — verified against the installed `@playwright/mcp` README (`browser_file_upload`'s and `browser_drop`'s `paths` params) — `browser_file_upload` and `browser_drop`. (`browser_drag` was checked and excluded: it takes only page-snapshot element refs, no host path.) Combined with `browser_navigate` to an attacker-controlled page, that's a host-secret EXFILTRATION primitive (read `~/.ssh/id_rsa` / `.env`, POST from a cooperating page) — NOT RCE, but the same threat model as `PLAYWRIGHT_DISALLOWED_TOOLS`: a human enabling `browserTesting` on the untrusted-chat-facing companion (`assistant`) profile.

UNLIKE `browser_run_code_unsafe` (which no legitimate workflow needs and is disallowed for EVERY role), these two ARE legitimately needed for upload/drag-drop testing on the worker rigs (QA Tester / Web Designer) — so this set is ROLE-SCOPED: `disallowedToolsForSpawn` unions it in ONLY when `role === "assistant"` AND the Playwright MCP is mounted, leaving worker/manager/other roles byte-identical (they keep `file_upload`/`drop`). Same posture as `RESTRICTED_NATIVE_TOOLS` — blast-radius control scoped to the chat-reachable companion, not a blanket restriction.

## Do not

- Do not disallow `browser_file_upload`/`browser_drop` for every role — they're legitimately needed on worker rigs (QA Tester/Web Designer) for upload/drag-drop testing; the restriction is scoped to `role === "assistant"` only.
- Do not add `browser_drag` to this list — it was checked and excluded (page-snapshot element refs only, no host path).
- Do not treat this as covering the same threat as `PLAYWRIGHT_DISALLOWED_TOOLS`'s RCE scope (card 7159466a) — this is a separate, file-path exfiltration residual the Code Reviewer surfaced outside that scope.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`ASSISTANT_PLAYWRIGHT_DISALLOWED_TOOLS`'s top-of-const doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
