# 8f050b79 — inbox attachment serving: headers, the Origin/CORS check, and the SVG decision

Card `8f050b79`, child 2 of epic `7d1d66ab` (Direction B "Manifest"). Builds on child `432765ab`'s store
(`<LOOM_HOME>/attachments/<questionId>/<n>-<name>`). Anchored from `packages/daemon/src/gateway/server.ts`
(the two new routes), `packages/daemon/src/mcp/attachments.ts` (the serving helpers), and
`packages/daemon/src/gateway/trust-tier.ts`.

## Auth posture — mirrors the sibling Requests routes exactly

`GET /api/questions/:id/attachments/:attachmentId` and `POST .../opened` are both added to
`TIER_1_ROUTES`, same class as `GET /api/questions/:id` and `POST /api/questions/:id/answer` — viewing or
acknowledging one attachment is part of reading/acting on that Request. No per-project ownership check
beyond "can reach this daemon at all": the whole daemon is single-owner, same as the sibling reads. The
POST route is automatically covered by the loopback-secret bearer guard (`gateway/server.ts`'s
`isGuardedApiWrite`, decision `9ccedbee`) for free — it's a non-GET `/api/*` route and not in
`LOOPBACK_GUARD_KEY_AUTHED_EXEMPT` — nothing extra was needed for that. The GET route is deliberately NOT
covered by that guard (settled policy, decision `214caa53`: GET reads add no material barrier over
existing filesystem access).

## The HTML CSP: `sandbox allow-scripts; form-action 'none'; connect-src 'none'`, derived from the SERVED type

The page runs in an opaque origin without `allow-same-origin`, so its scripts can't reach the daemon
origin's `localStorage` (the exfiltration path decision `68bef69c` closed for `/vault/raw`) even if they
run. No `default-src`/`script-src`/`style-src` is set, deliberately — those directives would fall back to
`'none'` and block the inline `<script>`/`<style>` an interactive mockup needs, independent of the
sandbox token. `form-action 'none'` closes form submission (the sandbox token never includes
`allow-forms` either, so this is additive hardening against a future edit that adds that token without
revisiting the CSP). `connect-src 'none'` (Code Review round 1 decision) closes `fetch()`/`XHR`/
`WebSocket`/`sendBeacon` as an exfiltration path for anything typed into the mockup — it does **not**
affect inline scripts or CDN script/style/font loads (those aren't gated by `connect-src`), and the cost
(a mockup that calls an external API breaks) is accepted as rare and acceptable to lose. **Residual
`connect-src 'none'` does NOT close:** CSP has no `navigate-to` enforcement in any shipping browser, so a
script-driven top-level navigation (`window.location = …`) or a `<form>`-free, CSP-untouched exfiltration
shape like an `<img src>`/`<link>` "beacon" (a GET whose URL itself carries the stolen data, no response
ever read) still reaches an attacker's own server. Narrowing, not closing.

**Every response from this route now carries a sandbox CSP — never none.** Code Review round 1 found the
CSP was chosen by `record.kind` while the inline `Content-Type` was derived from the SERVED file's real
extension (`attachmentServeContentType`) — a different value. A probe with `kind:"image"` and
`storedFilename:"0-x.html"` served real `text/html` with **no CSP at all** (the `"image"` branch never
set one). Fixed structurally: `resolveAttachmentHeaders` (`gateway/server.ts`) computes the served
Content-Type FIRST, then picks the CSP from `isActiveDocumentContentType(contentType)` (`vault/browser.ts`
— the SAME predicate `/vault/raw` already uses for "is this served type a scriptable document", reused
rather than re-derived) — never from `record.kind`. A scriptable served type gets the HTML sandbox policy
above; everything else gets `sandbox; default-src 'none'` (images and downloads lose nothing by it — the
`sandbox` token has no effect on how an `<img>`/download consumer uses the bytes). `record.kind` still
decides ONLY the inline-vs-download `Content-Disposition` choice, which is independent and safe either
way: a kind/extension mismatch now gets the html sandbox-with-scripts CSP either way, same protection as
a genuine html attachment.

## The Origin/CORS verification (manager condition 2)

The threat raised: an opaque-origin sandboxed page can still attempt network requests against the daemon
at `127.0.0.1`. Verified against code rather than assumed, two legs — **leg (a) below was corrected in
Code Review round 1; the original draft overstated what the CSRF hook actually blocks.**

**(a) What does the CSRF/DNS-rebind `onRequest` hook actually refuse?** `gateway/server.ts` ~lines
595-601 (the hook registered right after the websocket plugin, inherited by every route) refuses a
**PRESENT** `Origin` header that doesn't resolve to a loopback hostname — including the literal string
`"null"` (a sandboxed-iframe CSRF sends `Origin: null`), which fails `new URL()` parsing and so is treated
as disallowed, 403. This runs for every method, not just non-GET. **What this does NOT cover:** a browser
sends **NO `Origin` header at all** on a `"no-cors"`-mode `fetch()`/`<img src>`/`<script src>` subresource
load, nor on a top-level GET navigation — and an absent Origin is the hook's deliberate fail-safe ALLOW
path (non-browser clients send none and must keep working). So **every `"cors"`-mode request and every
non-GET method IS refused by this hook** (a `"cors"` fetch always sends a real Origin; a non-GET request
from the sandboxed page would too, per the hook's own top comment about `mode:'no-cors'` side-effect
POSTs still carrying Origin) — **but a bare `"no-cors"` GET/HEAD from the sandboxed page is NOT refused by
this hook and reaches the route.** It cannot **read** the response: no `Access-Control-Allow-Origin`
header exists anywhere in this daemon (leg (b) below), so the browser enforces an opaque/blocked response
for a cross-origin `no-cors` fetch, and Chromium's ORB (Opaque Response Blocking) additionally strips the
body from script's reach for a cross-origin no-cors load whose content-type doesn't match the requesting
context. **Named residual, NOT closed by this card:** a GET the sandboxed page can fire blind still
creates (1) a load/error **oracle** (did the fetch/img resolve — binary signal, e.g. "does attachment N
exist") and (2) reaches any **side-effecting GET** this daemon might expose (none are known to exist on
this surface today, but the hook's own absent-Origin design doesn't structurally prevent one). Tracked by
follow-up card `b49e7983` ("refuse cross-site no-cors GET subresource loads on /api", Sec-Fetch-Site
hardening) — NOT implemented by this card.

**(b) Does any daemon response carry a CORS grant that would let an opaque-origin page READ a response
even if the request lands?** No — `grep -rn "Access-Control-Allow-Origin" packages/daemon/src`
and `grep -rn "@fastify/cors\|fastify-cors" packages/daemon/src` both return zero hits. No CORS plugin is
registered and no response ever sets an `Access-Control-Allow-Origin` header.

Conclusion: no pre-existing hole for **reading** a response — closed by the simple absence of any CORS
surface, independent of (a). Leg (a) narrows which **requests** reach a handler at all (every `cors`-mode
request and every non-GET method, refused; a bare no-cors GET is not) — the residual named above (load/
error oracles, a future side-effecting GET) is real and tracked, not closed by this card.

## SVG — decided upstream, not by this route

`deriveAttachmentKind` (`mcp/attachments.ts`, card `432765ab`) classifies by extension at copy time, and
its `IMAGE_EXTENSIONS` set (`.png/.jpg/.jpeg/.gif/.webp`) deliberately excludes `.svg` — an SVG is
scriptable, so it is already stored as `kind:"other"`, server-derived, never client-supplied. By the time
this route serves it, SVG falls into the same "other → download" branch as any other binary: forced
`Content-Disposition: attachment`, `application/octet-stream` Content-Type (this route's
`attachmentServeContentType` only maps the `"image"`/`"html"` extensions to a real type; everything else
— including `.svg` — falls back to octet-stream). No special-casing was added in this route for SVG
specifically; doing so would duplicate a classification decision `432765ab` already made.

## Content-Disposition: header-injection hardening + RFC 5987

`attachmentContentDisposition` (`mcp/attachments.ts`) strips every control character (including CR/LF)
from the attachment's `label` FIRST, unconditionally, before either encoding step runs. **Accurately
stated (Code Review round 1 nit):** this strip is DEFENCE IN DEPTH, not the thing that stops injection —
both encoders that run after it already neutralize a CR/LF independently (the ASCII fallback only emits
printable ASCII, collapsing CR/LF to `_` on its own; the RFC 5987 encoder percent-encodes every byte
outside `attr-char`, which CR/LF are not in). The strip's actual value is making the EMITTED value legible
(no stray control bytes even inside the already-escaped forms) and giving a single, early, unconditional
place to reason about every downstream byte, not uniquely preventing the header split. It then emits BOTH
an ASCII `filename="…"` fallback (non-ASCII collapsed to `_`, `"`/`\` backslash-escaped) and the RFC 5987
`filename*=UTF-8''…` extended form (percent-encoding every byte outside the RFC 5987 `attr-char` set,
byte-wise over the UTF-8 encoding — not `encodeURIComponent`, which leaves `* ' ( )` unescaped and those
are not in `attr-char`).

## openedAt: first-open-wins, atomic

`markQuestionAttachmentOpened` (db.ts) reads and rewrites the whole `attachments_json` column inside one
`db.transaction()` — a concurrent second "open" call observes the first's already-set stamp and no-ops on
it rather than racing a lost update. No response-shape change: `QuestionAttachment.openedAt` already
existed in the public type (previously always `null`, now genuinely written); no new field was added, so
none of the FIELD-bullet projection guards (`worker-status-projection-guard.mjs`,
`entity-row-fields-guard.mjs`, etc.) apply to this change.

## Do not

- Do not add `default-src`/`script-src`/`style-src` to the HTML attachment's CSP — it will block the
  inline `<script>`/`<style>` the feature exists to render. The localStorage/cookie exfiltration path is
  closed by omitting `allow-same-origin`; the connect-out path is narrowed (not closed) by
  `connect-src 'none'`; reaching the daemon's own API at all is narrowed (not closed) by the pre-existing
  CSRF hook — see "The Origin/CORS verification" above for exactly what that hook does and does not cover.
- Do not derive the CSP from `record.kind` — derive it from the SERVED Content-Type via
  `isActiveDocumentContentType`. A `kind`/extension mismatch (tampered row, future bug upstream) must
  still get a sandbox CSP matching what the browser will actually render; keying on `kind` let exactly
  that case ship with NO CSP at all (Code Review round 1 finding).
- Do not special-case `.svg` in the serving route — its classification as `kind:"other"` is decision
  `432765ab`'s, made at copy time; duplicating it here would let the two drift.
- Do not accept a client-supplied path for either route — only `(questionId, attachmentId)`, validated
  against `QUESTION_ID_RE`/`ATTACHMENT_ID_RE` before any DB/fs access, resolved to a store file via
  `resolveStoredAttachmentFile`'s realpath containment check.
- Do not use `encodeURIComponent` for the RFC 5987 `filename*=` value — it leaves `* ' ( )` unescaped,
  which are outside RFC 5987's `attr-char`; use the byte-wise percent-encoder in
  `attachmentContentDisposition`.
- Do not let `markQuestionAttachmentOpened` overwrite an existing `openedAt` — first-open-wins is the
  contract; a repeat call must return the original stamp unchanged.
- Do not overstate the CSRF hook as closing the daemon-reach threat outright — it refuses every
  `cors`-mode request and every non-GET method, but a bare `no-cors` GET/HEAD from the sandboxed page
  still reaches the route (unreadable, not unreachable). See the named residual above; tracked by
  follow-up card `b49e7983` (Sec-Fetch-Site hardening), not implemented here.

Test: `packages/daemon/test/question-attachment-serving.mjs` (real-HTTP via `app.inject` against a
throwaway `Db`/`buildServer`).
