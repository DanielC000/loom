# 9db2ad8d — the plan-usage endpoint's response shape changed upstream; `parseUsagePayload` is now shape-tolerant instead of patched against one captured body

## What changed upstream

The owner reported Loom's plan-usage query ("Mission Control strip") had stopped working. Live check via
Loom's own `GET /api/usage/limits` (the daemon's cached poller result — no fresh authenticated call) showed:

```
{"available":false,"reason":"usage endpoint schema changed","fetchedAt":"..."}
```

The installed `claude` CLI had auto-updated to 2.1.317 (binary mtime ~16h before the report, confirmed via
`claude --version` and the file's own `LastWriteTimeUtc`). Grepping that binary's strings (`grep -a`,
never executing it for this part) surfaced the CLI's own embedded zod schema for this endpoint's
response. Reconstructed (minified identifiers elided), the windows now live nested under a `rate_limits`
object, gated by a new `rate_limits_available` boolean, instead of at the top level:

```
rate_limits_available: boolean  // "False when plan rate limits do not apply (API key, Bedrock, Vertex,
                                 //  or missing profile scope) — rate_limits will be null."
rate_limits: {
  five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet: { utilization, resets_at, status? },
  model_scoped: [{ display_name, utilization, resets_at }],  // per-model weekly windows
  extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency },
} | null
```

The CLI's own `.describe()` text on the enclosing object: **"Structured /usage data: session cost/usage
totals plus claude.ai plan rate-limit utilization. Experimental — the shape may change."** — i.e. this is
not a one-off break; Anthropic's own code documents this endpoint as liable to keep moving.

`git log` on `usage-status.ts` showed no change to `parseUsagePayload`'s parsing logic since the original
feature commit (2026-06) — this is an upstream break, not a Loom-side regression.

## Why shape-tolerant + key-name logging, not a captured-body patch

The manager's instruction, and the reasoning behind it: patching the parser against ONE reverse-engineered
shape (from binary strings, not a live response) risks shipping a fix for a guessed shape that doesn't
match the real wire format, with no way to notice the guess was wrong — the poller's failure modes are
deliberately silent (see the module doc comment), so a wrong patch would just degrade to a DIFFERENT
silent `available:false`, and nobody would know. Making an authenticated call to confirm the real shape
(even though Loom's poller already makes this exact call every 60s regardless of us) was ruled out for
this card as an unnecessary action to approve, given a self-confirming alternative exists.

The fix instead:
1. **Shape-tolerant parsing** (`parseWindowsFrom` + `parseUsagePayload`): accept windows at the top level
   (legacy) OR nested under `rate_limits` (CLI 2.1.317+), and honour `rate_limits_available:false` /
   `rate_limits:null` with its own distinct reason ("plan rate limits not available for this account")
   BEFORE falling through to "usage endpoint schema changed" — an account the endpoint legitimately
   doesn't serve plan limits for (API key / Bedrock / Vertex / missing OAuth scope, per the CLI's own
   schema description) must never be confused with "Loom's parser is out of date," which is what "schema
   changed" means and is reserved for.
2. **Throttled, content-free diagnostic logging** (`UsageStatusPoller`'s schema-changed branch only): on
   the FIRST "usage endpoint schema changed" result (then at most once per `SCHEMA_WARN_THROTTLE_MS`),
   `console.warn` the response's top-level key names and (if present) the nested `rate_limits` key names —
   never values, never tokens. This makes the daemon's own log self-confirming: after this ships and the
   daemon restarts, the NEXT real poll against the account's actual current shape writes its key names to
   `daemon-output.log` on its own, with zero marginal authenticated calls (the poller was already going to
   make that call) and zero manual intervention. If the real shape differs from what's implemented here,
   that log line is what tells a future reader exactly how, rather than another investigation.
3. **Recorded fixtures** (`test/usage-status.mjs`): the legacy flat shape (already covered), the nested
   shape built from this record's own reconstructed schema (cited by CLI version in the test's own
   comment), a `rate_limits_available:false` fixture, and a genuinely unknown shape — each with its own
   RED-before-GREEN mutant proof, so a regression in any one branch is caught.

## Do not

- Do not read "usage endpoint schema changed" and "plan rate limits not available for this account" as
  the same failure — the first means Loom's parser needs an update; the second means the account genuinely
  has no plan rate limits to show (expected, not a bug). Conflating them routes a real parser gap through
  a reason that reads as "nothing to see here."
- Do not remove or shortcut the throttled key-name warn's throttle — it exists so a sustained real schema
  break (which polls every 60s) logs once per window, not once a minute, forever.
- Do not log response VALUES (window utilization numbers, reset timestamps, credentials, tokens) from the
  schema-changed warn — key names only. This endpoint's response is the user's own account data; the warn
  exists to diagnose shape drift, not to exfiltrate plan usage into a shared log file.
