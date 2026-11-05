# ssh_exec regex worker queue is bounded (card ede5177a)

The regex workers (`connections/sshRegex.ts`) are capped at `SSH_REGEX_MAX_CONCURRENT_WORKERS`, and callers past that used to queue without limit. One agent holding a granted connection with a catastrophic owner regex (`^(a+)+$`) could fill the queue (measured: 40 concurrent calls ⇒ 38 waiters), and an unrelated benign regex call from any session or project then waited 6.6 s. Refusals were also invisible to the rate limit, because `checkSshRateLimit` runs after the policy and counts only dispatches.

## Decision

The wait queue is capped at `SSH_REGEX_MAX_QUEUED_WAITERS` (8). A caller arriving with the queue full is refused immediately, fail closed, with the distinct reason `allowlist-regex-busy` (policy verdict `allowlist-regex-busy`, audited as an ordinary `refused` outcome row exactly like `allowlist-regex-timeout`). The refusal text is the fixed `command refused (allowlist-regex-busy)`; it never echoes the command or a pattern.

8 was picked because 2 workers each spend at most the 250 ms budget, so 8 waiters is about 4 rounds, about 1 s worst case for a benign caller, while still absorbing a normal burst of parallel calls from several agents.

The global cap bounds LATENCY, not AVAILABILITY: one connection with a ReDoS-prone owner regex could keep 10 calls in flight and every other connection's benign call got `allowlist-regex-busy`. So each connection may also hold at most `SSH_REGEX_MAX_PER_CONNECTION` (5, half of the global 2 active + 8 queued = 10) queued+active regex entries (keyed on the connection id, passed by `evaluateSshCommandPolicy`). An over-cap call from that connection is refused with the same audited `allowlist-regex-busy`, never queued; other connections are unaffected. The per-connection counter is incremented before the slot is acquired and decremented exactly once in a `finally` on every exit (ok, timeout, error, busy after increment); a call refused at the per-connection check never incremented.

Trade-off: the per-connection cap buys availability for OTHER connections; a burst above 5 concurrent regex calls on ONE connection is refused fail-closed (a retry works). A cap of 2 was rejected because it refused a benign parallel burst of 4. The key is the connection, so agents sharing one connection share its 5. Residual: several connections granted to one agent can still fill the global queue together; accepted because connections and their regexes are human-only to create (REST), so it takes the owner authoring many bad-regex connections and granting them to one agent.

Refusals are NOT additionally counted against the per-connection rate limit: the cap alone bounds the amplifier, and counting refusals would let one agent exhaust its own connection's budget for legitimate commands.

## Do not

- Do not let an over-cap caller wait (queue or retry loop) instead of refusing.
- Do not raise the cap without re-deriving the worst-case wait above.
- Do not drop the per-connection cap to rely on the global one alone, and do not lower it below a normal parallel burst; the global cap does not stop one tenant starving the rest.
- Do not put the command text or regex source into the busy refusal.
