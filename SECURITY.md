# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Loom, please report it **privately** — do not open a public GitHub issue:

- Use GitHub's **[private vulnerability reporting](https://github.com/DanielC000/loom/security/advisories/new)**
  (the **Report a vulnerability** button on the repository's **Security** tab).
- Public issues are for ordinary bugs and feature requests only.

Please include enough detail to reproduce the issue (affected version/commit, environment, and steps). We'll acknowledge your report and work with you on a fix and coordinated disclosure. As a small, pre-1.0 project, response is best-effort — thank you for your patience and for reporting responsibly.

## Supported versions

Loom is **pre-1.0** and under active development. Only the latest released version receives security fixes; there are no long-term support branches at this stage.

| Version | Supported |
|---|---|
| Latest `0.y.z` release | ✅ |
| Older `0.y.z` releases | ❌ |

## Threat model (what to keep in mind)

Loom is a **local-first, single-user tool**, and its security posture reflects that. Reports are most useful when they account for this design:

- **Loopback-only daemon.** The daemon binds `127.0.0.1` (port `4317` by default) — it is not
  designed to be exposed to a network or run multi-tenant. Exposing it beyond loopback (e.g. via a reverse proxy or port forward) is outside the supported posture.
- **It drives real interactive `claude` sessions.** Loom spawns and drives the real interactive
  `claude` CLI under a server-owned PTY, with a `--permission-mode acceptEdits` posture plus a tool **allowlist** (not `--dangerously-skip-permissions`). Sessions can read and edit files within their working tree. Treat the machine running Loom as you would any environment where an AI agent has filesystem and tool access.
- **Privileged actions are human-only by design.** The trust-boundary surfaces — vault writes, git
  writes (checkout/commit/push/create-branch), and `gateCommand`/shell — are reachable only through a **human-only REST surface**. No agent MCP tool exposes them; a session can never commit, push, or run gated shell commands on its own. Git writes are bounded and non-interactive (`GIT_TERMINAL_PROMPT=0` + timeouts).

This is an honest description of the current design, **not** a claim of hardening or a security audit. If you find a way to cross one of these boundaries — e.g. an agent reaching a human-only surface, the daemon binding beyond loopback, or the allowlist/permission posture being bypassed — that's exactly the kind of report we want.
