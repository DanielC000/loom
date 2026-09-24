# 710a34fa — remote /ws/term takes no input (bar a repaint) for agent sessions and closed to host shells

`/ws/term/:sessionId` is Tier 1 (`gateway/trust-tier.ts`), so a remote gateway-token holder can open it. Before this card its handler accepted raw `stdin` from any peer and attached to any pty id, including the host shells `POST /api/terminals` creates (host RCE by design, loopback-only to create). Verified with `test/ws-term-remote-token-stdin.mjs` (non-loopback socket, valid token): stdin reached both a host shell and an agent session.

Rule now: a non-loopback peer (an empty/undeterminable address counts as non-loopback) can attach to an agent session and request a `repaint` (which writes Ctrl-L into the pty; card 5b4ddca5 bounds it — one honored repaint per remote socket per `REMOTE_REPAINT_MIN_INTERVAL_MS`, excess frames dropped, and `PtyHost.repaint()` skips while a `writeChunked` burst is in flight for the session, for loopback too, so a form feed can never land at a paste chunk seam; tests `pty-repaint-inflight-paste.mjs`, `ws-term-remote-token-stdin.mjs`), but no other input; `stdin` and `resize` are dropped. It is refused outright (socket closed 1008, no subscribe) for a host shell id. Loopback behavior is unchanged. Remote steering of an agent session stays on the governed Tier-1 REST route `POST /api/sessions/:id/input` (busy-gate + owner attestation), which the raw WS passthrough bypassed. This also makes the code match the trust-tier doc's promise of "read-only WS terminals".

REST half (Code Reviewer on the first cut): `POST /api/sessions/:id/input` and `POST /api/sessions/:id/stop` are Tier 1 too and took a HOST SHELL id (no DB session row, so the role gate never fired; `enqueueStdin`/`submit` had no kind guard) — a remote token plus a known shell id typed a bracketed paste + Enter into the host shell. Fixed structurally in `PtyHost`, not per-route: `enqueueStdin` returns `reason:"shell-terminal"` and `submit` no-ops for `kind:"shell"`; `stop()` returns `false` for a shell unless the caller passes `{shell:true}` (only `DELETE /api/terminals/:id`, Tier 0 / loopback, does). The gateway maps both refusals to 409. A shell therefore takes ONLY raw `writeStdin` over the loopback `/ws/term`. Tests: `test/shell-terminal-rest-refusal.mjs` (real PtyHost via the `createShellPty` seam).

Owner-decision status: the read-only choice for agent sessions was made by the manager (reversible), not the owner.

## Do not

- Do not accept `stdin` (or `resize`) from a non-loopback peer on `/ws/term` without an explicit owner decision.
- Do not let a non-loopback peer attach to a host shell (read or write); host shells are loopback-only.
- Do not treat an empty `remoteAddress` as loopback here.
- Do not add a per-route shell check to a session-facing REST route as the fix for a new shell-reachable path; the guard lives in `PtyHost` (`enqueueStdin`/`submit`/`stop`). A new programmatic PtyHost entry point that writes to or kills a pty must refuse `kind:"shell"` too.
