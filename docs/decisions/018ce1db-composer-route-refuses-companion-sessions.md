# 018ce1db — `POST /api/sessions/:id/input` refuses a Companion (role:"assistant") session outright

## Narrative

`POST /api/sessions/:id/input`'s `ownerText:text` argument makes it a Primitive-A owner-attestation writer, but that attestation is only trustworthy for the route's actual audience: whichever human/manager session the web UI's own Composer is bound to (`Terminals.tsx` deliberately excludes assistant-role sessions from ever rendering that Composer — "a companion is driven ONLY through its chat surface `/ws/companion/:id`, never a raw pty tile + STDIN Composer"). That client-side exclusion is NOT a security boundary — Loom's default (non-remote) gateway trusts loopback wholesale (`gateway/trust-tier.ts`'s own doc: "there is no per-route auth"), and a loopback peer is any co-resident process, including a project MANAGER's own spawned Claude Code session with Bash — not only the human's browser.

Before this fix, that manager could `curl` this exact route with the companion's sessionId and author words that land as `ownerText`, i.e. in the OWNER's role slot for the Companion's very next turn — the privilege-escalation path this card exists to close. The fix: a Companion (`role:"assistant"`) session is REFUSED here, full stop — never even reaches `enqueueStdin`. The Companion's OWN authenticated inbound path (`chat-gateway.ts`'s `handleInbound`, reached via `/ws/companion/:sessionId` or an external channel adapter) is untouched by this check and keeps attesting `ownerText` exactly as before — this only removes a SECOND, unintended route into the same role slot. `GET /ws/term/:sessionId`'s stdin path got the identical sibling fix for the same reason (the same defect reached both inbound surfaces).

The refusal uses owner-facing wording (not internals-facing "assistant-role"/"generic composer route" jargon) — sibling card `9ccedbee`'s client fix (`api.ts`'s post/del/put parsing a REST `{error}` body via `errorMessageFrom`, instead of throwing a bare status) is what actually surfaces this text to the owner once both land.

## Do not

- Do not let `POST /api/sessions/:id/input` (or `GET /ws/term/:sessionId`'s stdin path) reach `enqueueStdin`/`ownerText` for a `role:"assistant"` session — refuse it outright before any downstream write, closing the co-resident-manager-curl privilege-escalation path.
- Do not treat the web UI's Composer exclusion (`Terminals.tsx`) as a security boundary — it's client-side only; the server-side role check is what actually closes the gap.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`POST /api/sessions/:id/input`, lines 5200-5216 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
