# a1ec70a6 — a `?token=` link is a credential CANDIDATE, and a typed draft is not the app's to delete

Two independent minors from the lane-6 web review (`edc931d8`), both about writing over state the user already had. Two further review rounds (CR `74471968`, then delta CR `fb1532b9`) each found the previous fix half-right, so every section below describes the shipped end state, not an earlier attempt.

## 1. The `?token=` link path stored the loopback secret unverified

`lib/loopbackCredential.ts`'s `captureTokenFromUrl` read `?token=` off the URL and wrote it to storage on sight. Two sibling paths for the same class of credential already did the opposite:

- the banner's PASTE path (`CredentialBanner.unlock`) proved the candidate with `verifyLoopbackToken` first — card `093981dd` wrote that verifier precisely so a wrong paste could not evict a working credential;
- the whole GATEWAY-token path (`captureGatewayTokenFromUrl`, card `4cbbc343`) verified a `?gwtoken=` link before persisting it, and surfaced the rejection without touching the stored token.

So the one path a visitor could trigger with nothing but a URL was the one path that did not check. Any link to `http://127.0.0.1:<port>/?token=x` — a chat message, a bookmark, a README paste, an `<img src>` is enough to navigate nothing but the user clicking a link — replaced the browser's working secret with junk. Reads kept rendering (the loopback guard exempts GET/HEAD), so the page looked healthy; every WRITE 401'd and both WebSocket panes failed their upgrade, until the user happened to know to re-run `loom open`. Nothing in the UI said what had happened, because nothing had observed a refusal yet.

### What ships

One chokepoint per credential — `storeVerifiedLoopbackToken`, `storeVerifiedGatewayToken` — trims, proves the candidate, and only then stores. The loopback writer (`writeLoopbackToken`) is module-PRIVATE and the storage key is named in that one file, so no call site can write the secret at all, verified or not: the rule is enforced by the language rather than by a convention a scan has to police. There is no test-only seed export beside it either — a test-only export is still an exported write path, and nothing but a convention would stop a component importing it, which is the very thing being replaced; the unit tests seed their own fake `localStorage` instead, which also means reaching past the module is what demonstrates the module has no door left open. `test/loopback-token-link.mjs` still scans, for the three ways that could regress — re-exporting the writer, re-deriving the key elsewhere, or re-introducing a seed helper.

Verification is THREE-state (`lib/credentialVerify.ts`'s `CredentialVerifyOutcome`), shared by both credential paths, because a boolean cannot tell "the daemon refused this" from "we never got an answer":

- `invalid` is a 401 and nothing else, plus the ONE non-401 a path's own auth layer can author (below) — the only outcome that licenses the word "refused" anywhere in the UI;
- `unknown` is a thrown request (offline, DNS, CORS), a pre-auth 403 from a reverse proxy's CSRF/Host hook, a bare throttle, a 5xx — nothing about the credential was tested;
- `valid` is decided by the PATH's own passage predicate, because the probes differ: loopback POSTs an empty patch to an UPDATE-by-id route with a fresh uuid, so its 404 IS the proof; the gateway GETs a Tier-1 read, where a 404 means an intermediary answered and proves nothing.

The one non-401 refusal is the gateway's failed-auth 429 carrying `code: "gateway-token-required"`, which the daemon answers only to a request whose token just FAILED verification (verify-first, card `cf9ebab9`) — so it is a refusal the token earned. It is `classifyCredentialProbe`'s optional `provesRefusal`: consulted LAST, only for a response that would otherwise be `unknown`, unable to override a 401 or a proven passage, and reading the BODY (a non-JSON body falls back to `unknown` rather than rejecting). A bare 429, and the same code on a 403 or a 5xx, stay `unknown` — an intermediary can author the status. Misclassifying it was not cosmetic: the refused token was held in sessionStorage and the user offered a Retry of a token already rejected.

On `unknown` the candidate is HELD in sessionStorage (`pendingCandidateStore`) and the banner offers one Retry. The alternative considered was leaving the param in the URL until the outcome was known; it was rejected because it keeps the secret in the address bar and in anything that copies the URL — the exact hygiene `captureTokenFromUrl` strips it for — and because a reload would then re-enter the capture on it. The hold keeps the stripping unconditional while still not punishing the user for the daemon's downtime: `loom open`'s link may be the only copy of that secret they have. A held candidate is not a credential: different store, different key, and nothing ever AUTHENTICATES with it — only an explicit retry re-proves it, while the rest of the app reads it for PRESENCE alone (both modules read it once at module init, so a Retry affordance survives a manual reload). So "never STORE a credential unverified" is intact. Its lifetime is per-TAB, not per-visit: sessionStorage is invisible to other tabs, but the browser re-populates it on a tab restore and copies it into a duplicated tab, so a hold can outlive the navigation that created it — that is the bound it buys over localStorage, not a guarantee of a single read. The gateway path gets the same treatment deliberately: an asymmetry between these two paths is the defect this card exists for.

`captureTokenFromUrl` is `async`, mirrors its gateway twin's shape (injectable `verify`/`reload`), and resolves `"none" | "stored" | "rejected" | "unverified" | "unstorable"`:

- the param is stripped from the visible URL FIRST, unconditionally, good or bad, and best-effort — a `replaceState` that throws is swallowed rather than rejecting a promise `api.ts` fires with a bare `void`;
- the outcome raises `loopbackLinkOutcome`, a signal of its own that the banner words per state (`loopbackLinkCopy`, pure and asserted variant by variant);
- a success clears the lock (and, via `clearCredentialLock`, any stale link outcome) and reloads once, because requests that raced the module-scope capture carried no token.

Both captures therefore need an already-holding-this-token early return BEFORE the verify, and both have one. Swallowing a throwing `replaceState` is not a substitute: a strip that silently NO-OPS returns cleanly and reaches no `catch` at all, and either way the URL still carries the param, so an unconditional reload re-enters the capture on it forever. Measured on the gateway path while it had only the try/catch: 5 reloads for 5 re-entries, for a throwing AND a no-op `replaceState` — i.e. unbounded in a real browser. The guard makes it 1.

### Do not

- **Do not store a candidate secret on anything but a `valid`.** A GET cannot produce one: the loopback guard exempts reads, so a bad secret "verifies" against every read in the app.
- **Do not export the loopback writer, or name its storage key outside its module — and that includes a test-only seed.** A second verify-then-store sequence at a call site is how this asymmetry arose, and it is invisible locally — each path looks correct on its own. A test-only export is still an exported write path; tests seed their own fake storage.
- **Do not report an `unknown` verify as a refusal, in copy or in state.** It is an observation nobody made; it also discards a candidate the user may have no other copy of. Only a real 401, or a path's own non-401 refusal status, refuses.
- **Do not widen `provesRefusal` to a status an intermediary could have authored.** A bare 429, or the gateway code riding a 403 or a 5xx, stays `unknown`. The coded 429 qualifies only because the daemon sends it exclusively to a token whose verification just failed; drop that premise and the whole three-state split is back to fabricating observations.
- **Do not word an `unknown` as "could not reach the daemon".** It also covers answers the daemon itself sent — the pre-auth 403, a throttle — so the honest form says nothing answered ABOUT the credential, and the Retry sentence must not condition on the daemon "being reachable" either.
- **Do not reach a `reload()` without an already-holding-this-token early return ahead of the verify.** On both paths. A `try`/`catch` around `replaceState` is a different fix for a different failure: it stops a throw propagating, and does nothing at all about a strip that silently no-ops. Measured without the guard: 5 reloads for 5 re-entries, both shapes.
- **Do not render a Retry button with nothing explaining it.** When a lock (or a revocation) leads the banner, the link outcome still gets its own line; `gatewayLinkCopy`/`loopbackLinkCopy` take `retryable` so no variant can name a Retry that is not rendered beside it.
- **Do not move a held candidate into localStorage, and do not auto-retry it on a timer.** It is a candidate, not a credential; the retry is a guarded round trip the user asks for, visibly, once.
- **Do not model a link outcome as a `CredentialLockReason`.** Both reasons (`"write"`, `"socket"`) are direct observations of the daemon refusing *this browser*; a link outcome is neither, and the credential the browser holds may well still be working.
- **Do not promise that writes still work.** The banner says a refused link left the held secret "unchanged", which is observed; that it still WORKS is not, and the "Unlock writes" field sits directly below the sentence.
- **Do not let the two paths' copy diverge in SHAPE.** Both banners take their link wording from a pure `*LinkCopy(outcome, holdsToken, retryable)` helper. Leaving one path's variants inlined in JSX is what let the gateway banner keep an unreachability claim and an unexplained Retry through a round where the loopback twin had neither — a pure test cannot read a string trapped in a component.

## 2. Add-to-Inbox cleared the typed title before the create resolved

`Board.tsx`'s `NewTask` ran `onCreate(title, …); setTitle("")` in one statement against a fire-and-forget `mutate`. A 400 (an unknown `repoKey`) or a 401 (the credential case above, which is how the two minors met) therefore left the user looking at an inline error with their text gone.

### What ships

`lib/draftSubmit.ts`'s `submitDraft` owns the ordering AND the scope of the clear: refuse an empty or re-entrant submit, capture the submitted text, `await` the write, and then clear the draft only if it still holds exactly what was submitted. `NewTask` passes `create.mutateAsync`, a `useRef` re-entry guard, and `setTitle` itself as `updateDraft` — the clear is applied as a functional state update, which is the only way to read the draft as it stands after the await.

The equality guard lives in `submitDraft`, not in the component, because a call site that clears unconditionally looks correct in isolation: by the time the write resolves, the submitting closure's view of the draft is stale by definition, so the component has nothing left to compare against. Keeping it in the helper is also what makes it testable — `test/draft-submit.mjs` edits the draft mid-flight and asserts the newer text survives.

### Do not

- **Do not clear a draft before its write resolves, and do not clear text the write did not submit.** Clearing is an effect of SUCCESS, scoped to what succeeded. The owner's standing rule is never to destroy unfinished user input; a write that may fail is not the place to make an exception, and neither is a write the user kept typing past.
- **Do not guard re-entry with React state.** `setBusy(true)` has not re-rendered when a second click in the same tick reads `busy`, so both closures see `false` and both submissions go through. The ref is the guard; `disabled={creating}` is only the visible half.

## Why each half needs two tests

`test/credential-verify.mjs`, `test/loopback-token-link.mjs`, `test/gateway-credential.mjs` and `test/draft-submit.mjs` cover the algebra, the copy, and — for the draft — the ORDERING, which is observable only because the draft update is injected. Neither can see WHEN the real component calls its collaborators (the `654869e2`/`formSync.ts` lesson), so the wiring is proved against a real daemon by `e2e/loopback-token-link.spec.ts` and `e2e/board-inbox-create-failure.spec.ts`. Neither layer substitutes for the other.

Where a string is only reachable from inside a component (a paste error, a Retry error), the unit test scans the component's SOURCE for the claim a round removed, with a negative control proving the pattern matches the bad shape. That is weaker than reading the value — it cannot tell whether the string renders — but it is the only layer that catches the wording at all, and the alternative (noticing by eye) is what let the gateway banner drift from its loopback twin for a whole round.
