# 5b22b262 — the Requests inbox shows the immutable filer alongside the mutable routing target

## Narrative

Every identity/history meta line on this surface used to render `agent <sessionId>`, but `sessionId` is the MUTABLE routing target (`reparentQuestions` rewrites it onto a successor on every recycle), never provenance — so after any recycle the inbox attributed the ask to a seat that never made it. Owner's decision (Request 68b06c50): show BOTH, visibly distinguished — "filed by 3f2a · now routed to 9b1c".

## Do not

- Do not render only `sessionId` on an identity/history meta line — after a recycle it names a seat that never filed the request.
- Do not let a legacy row whose `filedBySessionId` is permanently null fall back to `sessionId` — that re-creates the exact bug this decision fixes; render it as "filer unknown" instead.

## Source

Inline comment in `packages/web/src/components/requests.tsx` (the `RequestProvenance` component's top-of-block doc), as of this tranche's HEAD. Relocated by this tranche (`docs(web): extract decision prose from web components and lib, tranche 2`); wording unchanged beyond joining wrapped source lines into a flowing paragraph and stripping `//` comment markers.
