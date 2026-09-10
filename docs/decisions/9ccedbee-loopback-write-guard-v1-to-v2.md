# 9ccedbee — loopback human-only-write guard rewritten v1 -> v2, closing a real exploited gap

## Narrative

v1 gated `routeTier===0` only, which left every Tier-1 route open. Tier 1 is exactly where the human's AUTHORITY lives, not just configuration: `POST /api/sessions/:id/input` tags text `source:"human"` and feeds it to `ownerText` (`mcp/questionTool.ts`'s "ANTI-FABRICATION INVARIANT", whose entire basis is "ownerText comes from the SAME loopback-only, human-authenticated REST composer" — a premise v1 left false), `POST /api/questions/:id/answer` is a direct human decision, and `/ws/term`'s `{type:"stdin"}` writes raw bytes into ANY session's pty, including an elevated one. Tier 1 means "safe to expose to an authenticated REMOTE human" — a materially different predicate from "safe from an unauthenticated co-resident agent", and v1 conflated them.

v2 does NOT inherit `trust-tier.ts`'s classification at all: it asks its own question — "does an agent legitimately need this from a shell?" — and the answer is no for every non-GET `/api/*` route and for `/ws/term`'s stdin capability, so it gates ALL of them, uniformly, with no per-route allowlist to drift.

The trust-tier wall is deliberately INERT unless a non-loopback bind is configured (`isTrustTierHookActive`) — on the DEFAULT loopback-only daemon it never even registers, so every writer in this file reaches its handler with ZERO check beyond the CSRF/Host hook at the top of `buildServer` — which a same-host `curl` trivially satisfies (Host defaults to loopback; an absent Origin is the fail-safe ALLOW path). Any co-resident process that can open a TCP connection to this port — including an agent session's own Bash tool — was therefore exactly as privileged as the human at the browser. **This is NOT hypothetical: a Loom agent did it.** This hook closes that gap, UNCONDITIONALLY (registered regardless of `isTrustTierHookActive` — it must hold on the default daemon, which is precisely the case the trust-tier wall ships inert for).

`/ws/companion` was originally a SEPARATE known gap this card deliberately left open (v1/v2's own notes said so) — closed later by card `351e89af`, which reuses this exact hook + mechanism rather than inventing a second scheme (see `docs/decisions/351e89af-in-app-companion-chat-ws-loopback-guarded.md`).

## Do not

- Do not gate this hook by `routeTier`/Tier classification again — that is the exact v1 defect: Tier 1 means "safe for an authenticated remote human," not "safe from a co-resident agent," and conflating the two reopens a gap a real agent already exploited.
- Do not assume the trust-tier wall above covers the default (loopback-only) daemon — it is inert there by design; this hook is the only check standing between a co-resident process and every non-GET `/api/*` route on that configuration.
- Do not add a new non-GET `/api/*` route, or a new WS upgrade with a write capability, without adding it to this hook's scope — there is no per-route allowlist to fall back on.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (the loopback human-only-write guard registration, lines 489-537 as of commit `1d2e8e78`). Extracted by card `33347ca0` (tranche 3); wording condensed, no substantive detail dropped.
