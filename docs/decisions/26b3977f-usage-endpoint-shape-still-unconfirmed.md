# 26b3977f — the real wire shape REFUTED card 9db2ad8d's nested-`rate_limits` hypothesis; the warn now logs structural shape, not just key names, because the binary schema is an unreliable proxy

## What the deployed 9db2ad8d fix's own warn revealed

9db2ad8d (commit `703bacc4`) shipped `parseUsagePayload` as shape-tolerant between a legacy flat shape
and a hypothesized CLI-2.1.317 nested `rate_limits.{five_hour,seven_day,...}` shape, reconstructed from
the installed `claude.exe`'s own embedded zod schema (binary strings, never executed). That hypothesis
was explicitly flagged in that record as unconfirmed against the real wire.

After deploy, the first real poll fired the throttled warn. The actual daemon log line:

```
[usage-status] usage endpoint schema changed — top-level keys: [five_hour, seven_day, seven_day_oauth_apps,
seven_day_opus, seven_day_sonnet, seven_day_cowork, seven_day_omelette, tangelo, iguana_necktie,
omelette_promotional, nimbus_quill, cinder_cove, copper_kite, brass_thimble, harbor_lantern, wattle_ember,
promo_credits, amber_ladder, granite_teacup, amber_cistern, amber_cistern_offer, juniper_tide, cedar_ember,
starry_waterfall, amber_gauge, pace, extra_usage, limits, spend, member_dashboard_available,
seven_day_breakdown, weekly_scoped_shares]
```

**The nested-`rate_limits` hypothesis is REFUTED.** `five_hour`/`seven_day` are still top-level keys, and
there is NO `rate_limits` key in the real response at all. `parseUsagePayload`'s nested-shape branch never
fires for this account — it falls straight through to the legacy flat path, which still fails, because
`parseWindow(o.five_hour)` itself rejects the real `five_hour` value (its `utilization` field is not a
finite number — the value's actual internal shape is still unknown, since the ORIGINAL warn logged only
TOP-LEVEL key names, never `five_hour`'s own structure).

## The binary schema is now a confirmed-unreliable proxy — not just unconfirmed, actively wrong

Grepping the installed CLI binary for several of the real response's own top-level key names
(`seven_day_breakdown`, `weekly_scoped_shares`, `member_dashboard_available`) returns **zero hits** —
these are not in the binary's bundled schema or code AT ALL. The live backend is returning fields this
installed CLI version doesn't even know about. This means CLI-binary archaeology has a hard ceiling for
this endpoint: the server is ahead of what any one installed client version validates, consistent with
the CLI's own `.describe()` text calling this shape "Experimental — the shape may change." A reconstructed
fixture built from the binary can be refuted by the wire at any time, as it already was once.

## What the binary DOES still offer: a second, different embedded schema, found this round

A second zod schema (distinct from 9db2ad8d's nested-`rate_limits.{five_hour,seven_day,...}` one) exists
in the same binary, describing a ROW-ARRAY shape:

```
rate_limits: {
  limits: Array<{
    kind: string,       // "The server's meter kind, e.g. 'session', 'weekly_all' or 'weekly_scoped'.
                         //  Classify a row on this, never on a label."
    group: string,       // "The server's row group, e.g. 'session' or 'weekly'..."
    percent: number,     // "Share of the window used, 0-100." — NOT "utilization"
    resets_at: string | null,  // "ISO 8601 timestamp when the window resets." (unchanged name)
    scope: { model?: {display_name}, surface?: {display_name} } | null,
    severity: string,    // "'normal', 'warning' or 'critical'"
    is_active: boolean,  // "The server's headline pick: the row a single-value indicator shows."
  }> | null,
  extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency } | null,
} | null
```

Its own `.describe()`: *"Structured twin of a /usage result, carried beside its text: the session's
totals, the plan's usage rows as the server sent them and the extra-usage spend, and nothing else from
the usage body (the get_usage control reply carries the rest). Experimental — the shape may change."*

**This describe string says this is the CLI's own INTERNAL structured twin of a `/usage` slash-command
result (surfaced to the model via a control reply), not necessarily the raw HTTP body Loom's poller reads
from `GET /api/oauth/usage` directly.** So even this better-documented schema is, at best, a second-hand
proxy for the real wire shape, not a confirmed one either. Its real relevance: the real response's
`limits` key being present (seen in the actual warn line above) is consistent with this schema's `limits`
field existing somewhere in the account's usage data — and its explicit field rename, `utilization` →
`percent`, is the single most concrete, well-evidenced clue for why `parseWindow` might now reject
`five_hour`: if the backend applied the same rename to the legacy per-bucket fields it kept for backward
compatibility, `five_hour.utilization` no longer exists and `parseWindow` correctly returns null.

## Do not

- Do not treat `percent` (or any other field name reconstructed from this or any other binary schema) as
  CONFIRMED for the top-level `five_hour`/`seven_day` objects' own shape — it is evidence for a schema
  governing a DIFFERENT, internal structure (the `limits[]` row array), not a direct read of what the real
  HTTP response's `five_hour` value looks like.
- Do not reconstruct a fixture from binary strings and ship it as the assumed real shape again without
  saying so explicitly and naming the real confirmation step (the extended warn's log line, read by the
  lead after the fix is deployed and the first real poll fires).
- Do not assume the real response's top-level key list is now stable or complete — `seven_day_breakdown`/
  `weekly_scoped_shares`/`member_dashboard_available` exist on the wire with zero trace in the installed
  CLI binary, so the server is already ahead of what this client validates; a future poll can reveal yet
  more keys with no CLI update involved at all.

## The remedy: describe structural SHAPE in the warn, not just key names

The warn (`UsageStatusPoller.warnSchemaChanged`) now logs, in addition to the top-level and
`rate_limits`-nested key names 9db2ad8d already added: the TYPE and, for an object, its own key names
plus each field's typeof (an array: its length plus its first item's shape) of `five_hour`, `seven_day`,
and `limits` — via a new pure helper, `describeShape`. Never a value. This directly answers, from the next
real poll alone, whether `five_hour` is still an object with a renamed field, has become something else
entirely (array/string/null), or is missing — closing exactly the gap that made this round's investigation
stop at "refuted, cause unknown" instead of a confirmed fix.

**Who checks it:** the lead, after the next daemon restart that deploys this change — `grep -a
"usage-status" <LOOM_HOME>/logs/daemon-output.log | tail -1` on the first post-restart poll. This record
and the follow-up card are only closed once that line is read and acted on, not once this commit merges —
see project memory `shipping-a-detector-is-not-someone-reading-it`.
