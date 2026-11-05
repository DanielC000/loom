# ssh_exec regex worker queue is bounded (card ede5177a)

The regex workers (`connections/sshRegex.ts`) are capped at `SSH_REGEX_MAX_CONCURRENT_WORKERS`, and callers past that used to queue without limit. One agent holding a granted connection with a catastrophic owner regex (`^(a+)+$`) could fill the queue (measured: 40 concurrent calls ⇒ 38 waiters), and an unrelated benign regex call from any session or project then waited 6.6 s. Refusals were also invisible to the rate limit, because `checkSshRateLimit` runs after the policy and counts only dispatches.

## Decision

The wait queue is capped at `SSH_REGEX_MAX_QUEUED_WAITERS` (8). A caller arriving with the queue full is refused immediately, fail closed, with the distinct reason `allowlist-regex-busy` (policy verdict `allowlist-regex-busy`, audited as an ordinary `refused` outcome row exactly like `allowlist-regex-timeout`). The refusal text is the fixed `command refused (allowlist-regex-busy)`; it never echoes the command or a pattern.

8 was picked because 2 workers each spend at most the 250 ms budget, so 8 waiters is about 4 rounds, about 1 s worst case for a benign caller, while still absorbing a normal burst of parallel calls from several agents.

Refusals are NOT additionally counted against the per-connection rate limit: the cap alone bounds the amplifier, and counting refusals would let one agent exhaust its own connection's budget for legitimate commands.

## Do not

- Do not let an over-cap caller wait (queue or retry loop) instead of refusing.
- Do not raise the cap without re-deriving the worst-case wait above.
- Do not put the command text or regex source into the busy refusal.
