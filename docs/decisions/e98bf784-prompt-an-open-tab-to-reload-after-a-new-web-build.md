# e98bf784 — prompt an open tab to reload after a new web build is deployed

## Narrative

A tab that had loaded the old JS bundle before a `daemon_restart` rebuilt web kept running it. The owner reported "I switched to atlas but I cant see the changes I asked for"; the changes were live and the lead had verified the served build. Only a hard refresh fixed it. Nothing told the owner a newer build existed. On a self-hosted fleet that restarts several times a day, a long-lived tab silently showing stale UI recurs, and it reads as "my change wasn't done" rather than as a stale tab.

`NewBuildNotice` (`packages/web/src/components/NewBuildNotice.tsx`) compares the bundle filename this tab actually loaded against the one the daemon is serving now, and offers a reload when they differ.

### Identity, on both sides

The production `index.html` carries exactly one `<script type="module" src>`, pointing at `/assets/index-<hash>.js`. Both sides read that same tag: the tab reads its own document's, and `currentWebBundle()` reads the served `index.html`'s. So the comparison is a plain string compare with no build-time plumbing — no `define`, no vite config change, and no dependency on `import.meta.url` (which appears zero times in the built bundle).

**Not a readdir of `assets/`.** The first `/^index-.*\.js$/` match on disk is not necessarily the entry `index.html` references, and two can legitimately coexist: a turbo cache restore that skipped vite's `emptyOutDir` (card `61fa0950`, whose orphan guard in `scripts/build-npm-package.mjs` exists for exactly that), or a future code-split chunk whose source is named `index.*`. Picking the wrong one is not a near-miss — it pins every tab to a notice that Reload can never clear, because the hash it compares against is not the one it will load, and the dismissal then keys to a constant wrong hash so even dismissing doesn't stick across builds. Caught in review, not in testing; `test/web-bundle-route.mjs` check (5) now stages both with the stale one sorting first.

`build-npm-package.mjs` prefers the vite manifest over "a regex scrape of index.html" — the opposite choice, and not in conflict. That guard needs EVERY emitted file, so it must see dynamic-import chunks `index.html` never names. This needs EXACTLY the entry a tab runs, which is what `index.html` names and all a tab can observe about itself. Reading the same file the browser reads is what makes the two sides comparable by construction rather than by coincidence; the manifest would also be a second source free to disagree with the document actually served.

### Why a new route rather than `GET /api/deploy-status`

The card proposed reusing `/api/deploy-status`. It is not suitable, and `served-status.ts` says so itself: `buildServedStatus` does a recursive disk walk (`measureScratchRootBytes`) plus a git call (`skillAssetsGitStatus`) plus a full session list per request, and its own doc comment states it is "called on-demand … never polled on an interval".

`GET /api/web-bundle` returns `{ webBundle }` and nothing else. Both surfaces call one extracted helper, `currentWebBundle()`, so they cannot drift — the same by-construction guarantee card f26339d7 already demands of `served_status` and `/api/deploy-status`. `test/web-bundle-route.mjs` pins that agreement across a simulated rebuild, which is what makes it a real guarantee rather than a static equality that a cache would satisfy trivially.

Putting the value on the `/ws/fleet` `hello` frame was considered and rejected: free, and the reconnect is the right trigger, but it means editing `ServerFleetMessage` in `packages/shared` — a shared-contract change — and still leaves the focus path needing a second surface.

### Trust tier

Registered Tier-1 in `gateway/trust-tier.ts`, alongside `GET /api/update-status`, under that file's existing "reads a remote read-only UI legitimately needs" group. It is a pure read that writes, executes and lifecycles nothing, and a remote tab needs it for the same reason a loopback one does — more so, being likelier to be long-lived. An unregistered route would have been default-DENY on a remote bind, so this is required, not optional.

On exposure: it discloses no more than `GET /api/version` (also Tier-1) already does — a build fingerprint. An earlier draft of this record and of both code comments justified it as "already in the `index.html` the client just loaded", which is **false for the direct-remote listener**: there `/*` is Tier 0, because `isStaticShellRoute`'s exemption is granted only to `cls.via === "proxy"` (`gateway/server.ts`), so a direct-remote token holder never loaded that `index.html` at all. The `index.html` argument holds for the trusted-proxy class only; the `/api/version` comparison is the one that carries in both.

### When it checks

On ws reconnect (not first connect) and on window focus. No `refetchInterval` at all. A daemon restart always drops the socket, so the reconnect covers the incident case exactly; a web-only rebuild with no restart is caught on next focus. The reconnect hook is one line in `FleetSocketProvider`'s `onopen`, which already held both the `reconnecting` flag and the `QueryClient` in scope.

## Do not

- Do not widen this into a daemon-staleness proxy. It compares WEB BUNDLES, so it is correctly silent after a daemon-`src`-only deploy — the tab's JS genuinely is current then. `version`/`webBundle` are provably blind to that case; that is the whole subject of card 5e30c4bd, whose own prohibition stands. This fixes the stale-JS-bundle half of "my change isn't live", not the general question, and a future reader finding it silent after a daemon-side deploy is seeing correct behaviour, not a bug.
- Do not answer a repeated "is my bundle current?" check via `buildServedStatus` or `GET /api/deploy-status`. Both cost a recursive disk walk plus a git call per request. Call `currentWebBundle()`.
- Do not derive the served bundle from a readdir of `assets/` (nor from the vite manifest). It must come from the served `index.html`'s own module-script tag — the same thing the tab reads about itself. See the Identity section above for why a readdir is wrong and why this does not contradict `build-npm-package.mjs`'s opposite choice.
- Do not cache `currentWebBundle()`. The filename only moves when the dist is rebuilt, which is precisely the event a caller is asking about — a cache delays the detection this exists to provide. `test/web-bundle-route.mjs` check (3) fails if either surface freezes.
- Do not auto-reload, on any trigger or timer. The owner may have unsent composer text, and destroying unfinished input is a standing red line. The reload is a button the user presses — the same reason `AtlasSwitchNotice` offers a cross-tab UI change rather than applying it.
- Do not drop either dev gate (`import.meta.env.DEV` and the `/^index-.*\.js$/` shape check on the tab's own script). Under `pnpm web` the tab's script is `/src/main.tsx` while the daemon still reports its own unrelated dist build; without the gates every dev tab false-alarms permanently, which would train the owner to ignore the banner this exists to make them trust.
- Do not resolve an "unknown" side into a notice. An unbuilt dist (`webBundle: null`), an unreadable document, or a non-production script name must all mean NO notice. A false "you are stale" is worse than a missed one.

- Do not reorder `e2e/new-build-notice.spec.ts` so a leg asserts the notice's markup before proving the tab and the server genuinely disagree about the bundle. The disagreement is the precondition, and it holds under both the pre- and post-change code, so gating on it keeps the control measuring the defect. Assert the element first and a revert reds with "element not found" — a shape failure that `git diff` already told you, and one that reads identically whether the comparison logic is missing, present, or present and wrong. The measured control for this card was 3 RED naming the defect with real bundle hashes, alongside 2 deliberately-GREEN false-positive legs; that split is what shows the legs are scoped to one behaviour rather than to the code's mere presence.

## Source

Card e98bf784. Anchors: `packages/daemon/src/served-status.ts` (`currentWebBundle`), `packages/web/src/lib/newBuild.ts`.
