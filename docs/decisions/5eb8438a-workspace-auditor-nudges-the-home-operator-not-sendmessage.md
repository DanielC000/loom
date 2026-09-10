# 5eb8438a — workspace-auditor suggestions get a confined live nudge, never the generic harness SendMessage

## Narrative

The owner's #1 complaint about the Workspace Auditor was that it could SUGGEST an improvement but
never reach an actor to ACTION it — a filed suggestion card just sat on the board until the user
happened to look. `workspaceAuditSuggest` (and `workspaceAuditHandoff`, the "I'm done filing, please
review" nudge after a batch) close that gap with a CONFINED, best-effort live nudge to the user's
home operator (`nudgeHomeOperator`), mirroring the nudge `platformEscalate` already sends a live
Lead.

The board task stays the DURABLE source of truth, so the nudge's floor is `boarded` — a missed or
absent live operator loses nothing; the suggestion is still sitting on the board. A live operator
upgrades the outcome to `delivered-live`/`queued`.

This is deliberately NOT the generic harness SendMessage: SendMessage has no Loom routing, which is
the exact reason an earlier attempt to have the auditor "message Platform" directly failed as "not
addressable". `nudgeHomeOperator` instead resolves its ONE reachable target server-side — the live
operator of the user's own reserved "Getting Started" home — so the auditor can never address any
other session; there is no arbitrary cross-session messaging path here.

## Source

`packages/daemon/src/sessions/service.ts` — `workspaceAuditSuggest` (extraction tranche 33).
