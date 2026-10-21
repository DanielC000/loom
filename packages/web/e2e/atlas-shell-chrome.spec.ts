// The cross-cutting chrome, under BOTH Atlas switch states (card a045bec3, Atlas build plan P1-5 —
// docs/plans/atlas-ui/03-decomposition.md row P1-5). Six elements: the Command Palette, UpdateBanner,
// CredentialBanner, GatewayTokenBanner, ToastContainer and FirstRunWelcome.
//
// WHY THIS SPEC EXISTS AT ALL, and what P1-0's fingerprint could not do. atlas-switch.spec.ts compares a
// shell skeleton against a pre-change baseline, but five of these six render NULL on a healthy throwaway
// daemon — no credential fault, no gateway lock, a from-source daemon reporting packaged:false, no
// attention arrival, the welcome modal pre-dismissed by the harness — so they contribute no DOM node and
// dropping or reordering one would not move that fingerprint. It forces `UpdateBanner` alone, which pins
// the banner SLOT and nothing else. So every test below first SEEDS the state that makes its element
// genuinely render, then asserts it is visible AND exercises it to an observable before/after change: a
// render-only check only proves the page drew.
//
// 🔴 THE CHROME IS NOT MOUNTED ONCE AT THE APP ROOT — it REMOUNTS when the switch is toggled. The P1-5
// plan row and 02-architecture.md both used to say it "stays mounted exactly where App.tsx mounts it
// today, at the shell root"; the P1-0 Code Review found that is not what landed. App.tsx defines each
// element ONCE (`ShellOverlays` / `ShellBanners`) but passes them as `overlays`/`banners` PROPS into
// whichever shell is live, and exactly one shell is ever mounted — so a toggle unmounts the whole chrome
// subtree and mounts a fresh one. Harmless today (`useNewAttention` re-seeds its seen-set on remount
// without replaying the backlog — lib/attention.ts's `seen.current === null` branch), but it is a real
// property, so the last test below PROVES it rather than asserting it in prose. Both docs are corrected
// in this card's commit; this spec is what keeps them honest.
//
// So what is verified here is PER-SHELL mounting, not a single root mount: each element is driven
// independently under each switch state, and every test asserts up front that exactly ONE shell is
// mounted, so a green can never come from the other shell's copy.
//
// Seeding, and the no-real-claude invariant: everything is either a client-side `page.route` answer (the
// three banners — fiction the browser alone can see) or a real seeded daemon row via the shared
// `loomDaemon` fixture (the toast's live manager + orchestration event, through POST /internal/test/seed).
// Nothing here spawns a pty, and nothing clicks an action that would reach a real daemon write — the
// UpdateBanner's "Update & restart" (POST /internal/update) is deliberately never clicked; its × dismiss,
// which is per-version localStorage and touches nothing, is the exercise instead.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/loopbackCredential.ts and App.tsx own the
// other two. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so
// a spec cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes them too.
const ATLAS_KEY = "loom.atlasUi";
const WELCOME_DISMISSED_KEY = "loom.setupWelcomeDismissed";

// The fake release the UpdateBanner is answered with. Its version is what the banner's own per-version
// dismiss key is built from, so the dismiss-persists assertion can name that key exactly.
const FAKE_LATEST = "99.0.1";
const UPDATE_DISMISS_KEY = `loom.updateDismissed.${FAKE_LATEST}`;

// The bottom-right toast stack (App.tsx › ToastContainer). There is no testid on it, and this card is a
// verification card that should not need to add one — so it is addressed by the three inline-style
// properties that make it unique: `z-index: 2000` is shared with AtlasSwitchNotice, but that notice is
// bottom-CENTRE (`left: 50%`, no `right`), so adding right+bottom disambiguates. Scoping matters here:
// Mission Control renders the SAME attention item as a row inside <main> (components/fleet.tsx ›
// AttentionRow, which prints `item.kind` verbatim), so an unscoped text match would pass on the row and
// never notice a missing toast.
const TOAST_STACK = '#root div[style*="right: 16px"][style*="bottom: 16px"][style*="z-index: 2000"]';

const rail = (page: Page) => page.locator(".loom-rail");
const atlasShell = (page: Page) => page.getByTestId("atlas-shell");

// Pre-seed the switch ON for the page's FIRST paint — the switch is read synchronously at module load, so
// the init script has to land before that. There is deliberately no "seed OFF" counterpart: OFF is the
// default (an untouched context has empty storage), and an init script is the wrong tool for it anyway —
// `addInitScript` re-runs on EVERY navigation, `reload()` included, so a "seed off" script would silently
// re-clear the key across the reloads two tests below depend on (measured on card 757c80dd, and again in
// the other polarity on card e47df20a).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

/**
 * Land on `path` under the requested switch state and prove EXACTLY ONE shell is mounted.
 *
 * Presence-first, deliberately: the positive half (`toBeVisible` on the shell that should be there) is
 * asserted BEFORE the negative half (`toHaveCount(0)` on the other), because a leading count-0 also
 * passes on a page that has not rendered anything yet — it would make every "the other shell is gone"
 * claim vacuous on a slow load.
 */
async function openShell(page: Page, baseURL: string, atlas: boolean, path: string): Promise<void> {
  if (atlas) await seedAtlasOn(page);
  await page.goto(baseURL + path);
  await expect(atlas ? atlasShell(page) : rail(page)).toBeVisible();
  await expect(atlas ? rail(page) : atlasShell(page)).toHaveCount(0);
}

/** Answer the UpdateBanner's own status read with a packaged install that is behind its channel. Pure
 *  client-side fiction: the real daemon is built from source and reports `packaged:false`, so without
 *  this the banner is null. */
async function fakeUpdateAvailable(page: Page) {
  await page.route((url) => url.pathname === "/api/update-status", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        packaged: true, channel: "stable", installed: "0.0.1", latest: FAKE_LATEST,
        updateAvailable: true, checkedAt: new Date().toISOString(),
      }),
    }),
  );
}

const updateBanner = (page: Page) =>
  page.locator('[role="status"]').filter({ hasText: "A new Loom release is available" });

const SHELLS = [
  { name: "switch OFF", atlas: false },
  { name: "switch ON", atlas: true },
] as const;

for (const shell of SHELLS) {
  test.describe(`cross-cutting chrome — ${shell.name} (card a045bec3)`, () => {
    // ── 1. Command Palette ──────────────────────────────────────────────────────────────────────────
    // Nothing to seed: the palette is keyboard-summoned. Both accelerators are exercised because the
    // handler accepts either modifier (`e.metaKey || e.ctrlKey`, components/CommandPalette.tsx) and a
    // single-modifier test would pass with the other half broken.
    test("⌘K and Ctrl+K open the Command Palette, and running a command navigates", async ({ page, loomDaemon }) => {
      await openShell(page, loomDaemon.baseURL, shell.atlas, "/");

      // The palette's own input is the open/closed witness — it exists only while `open` is true. The
      // count-0 below is meaningful precisely because the SAME locator resolves to 1 immediately after
      // the keypress: the instrument is shown to fire on this page, at this moment.
      const field = page.getByPlaceholder(/^Jump to/);
      await expect(field).toHaveCount(0);

      await page.keyboard.press("Meta+k");
      await expect(field).toBeVisible();
      // Escape closes it (the handler's other branch), so the Ctrl+K press below is a genuine open.
      await page.keyboard.press("Escape");
      await expect(field).toHaveCount(0);

      await page.keyboard.press("Control+k");
      await expect(field).toBeVisible();

      // RUN a command, to an observable: filter to one page row and click it. A palette row is a
      // <button> whose accessible name is its label plus its "page" hint — the classic rail and the
      // Atlas tree both reach Settings through an <a>, so this name can only be the palette's row.
      await field.fill("Settings");
      const row = page.getByRole("button", { name: "Settings page" });
      await expect(row).toHaveCount(1);
      await row.click();

      await expect(page).toHaveURL(/\/settings$/);
      // ...and the palette closed itself on the way (`go()` resets open + query).
      await expect(field).toHaveCount(0);
      // The navigation happened INSIDE the live shell — it did not fall out of it.
      await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
    });

    // ── 2. UpdateBanner ─────────────────────────────────────────────────────────────────────────────
    test("the UpdateBanner renders and its per-version dismiss sticks across a reload", async ({ page, loomDaemon }) => {
      await fakeUpdateAvailable(page);
      await openShell(page, loomDaemon.baseURL, shell.atlas, "/");

      const banner = updateBanner(page);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(`v${FAKE_LATEST}`);
      if (shell.atlas) {
        // The `banners` slot is really wired in this shell, not merely declared — nothing else in this
        // spec would notice AtlasShell silently dropping the prop.
        await expect(atlasShell(page).locator('[role="status"]').filter({ hasText: "A new Loom release is available" })).toBeVisible();
      }

      // EXERCISE the dismiss ×. Deliberately not "Update & restart": that POSTs /internal/update, a real
      // daemon stop→install→start, and no interception should be the only thing standing between a test
      // and that.
      expect(await page.evaluate((k) => localStorage.getItem(k), UPDATE_DISMISS_KEY)).toBeNull();
      await banner.getByTitle("dismiss until the next release").click();
      await expect(banner).toHaveCount(0);
      expect(await page.evaluate((k) => localStorage.getItem(k), UPDATE_DISMISS_KEY)).toBe("1");

      // PERSISTS: the dismissal is per-offered-version, so the same offer stays dismissed on a reload
      // (and this re-proves it through a fresh mount of the chrome, not just a React state flag).
      await page.reload();
      await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
      await expect(banner).toHaveCount(0);
    });

    // ── 3. CredentialBanner ─────────────────────────────────────────────────────────────────────────
    // Driven down its `?token=` link path (lib/loopbackCredential.ts › captureTokenFromUrl): the capture
    // verifies a candidate before storing it, so answering that verify probe with the loopback guard's
    // own coded 401 makes the link outcome "rejected" and the banner render — the real recovery surface
    // the parity checklist flags as never individually shown (§J.7). The probe is a POST to
    // /api/agents/<fresh uuid>; every other request on that prefix falls through to the real daemon.
    test("the CredentialBanner renders for a refused link and its paste field reports a refusal", async ({ page, loomDaemon }) => {
      let probes = 0;
      await page.route((url) => url.pathname.startsWith("/api/agents/"), async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        probes++;
        await route.fulfill({
          status: 401, contentType: "application/json",
          // The guard's own shape: `isCredentialGuardMessage` keys on the `loom open` pointer, and only
          // that makes a 401 a REFUSAL rather than an unanswered check (@decision f53eaa57).
          body: JSON.stringify({ error: "unauthorized — see `loom open` for how to obtain the local access credential" }),
        });
      });

      if (shell.atlas) await seedAtlasOn(page);
      // A hex candidate, distinct from the real secret this browser already holds (the fixture seeds it),
      // so the capture genuinely proceeds to the verify instead of short-circuiting on "already held".
      await page.goto(`${loomDaemon.baseURL}/?token=deadbeefcafe0123456789ab`);
      await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
      await expect(shell.atlas ? rail(page) : atlasShell(page)).toHaveCount(0);

      const banner = page.getByTestId("credential-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("A link's access credential was refused.");
      // The secret never sits in the address bar, and the refused candidate never evicted the working one.
      expect(page.url()).not.toContain("token=");
      expect(await page.evaluate(() => localStorage.getItem("loom.loopbackToken"))).toBe(loomDaemon.loopbackSecret);

      // EXERCISE the recovery field: a paste that the (faked) daemon refuses must say so, and must not
      // clear the banner. This is the one chrome element whose whole purpose is an input, so a
      // render-only check would prove nothing about it.
      await banner.getByLabel("Local access credential").fill("not-the-real-secret");
      await banner.getByRole("button", { name: "Unlock writes" }).click();
      await expect(banner).toContainText("The daemon refused that credential");
      await expect(banner).toBeVisible();
      expect(probes, "the verify probe never ran, so the refusal above proves nothing").toBeGreaterThan(1);

      // ...and Dismiss (offered because this is a link outcome, not an observed lock) clears it.
      await banner.getByTestId("loopback-link-dismiss").click();
      await expect(page.getByTestId("credential-banner")).toHaveCount(0);
      await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
    });

    // ── 4. GatewayTokenBanner ───────────────────────────────────────────────────────────────────────
    // A DIFFERENT credential and a DIFFERENT banner from the one above (lib/gatewayCredential.ts's own
    // header says why they must never share one). Raised the way production raises it: api.ts's
    // `guardedFetch` chokepoint sees a 401 carrying `code: "gateway-token-required"` and calls
    // noteGatewayLock(). Any api read will do, so the UpdateBanner's own status read is reused — which
    // also means the two banners never both render here, keeping each test's subject unambiguous.
    test("the GatewayTokenBanner renders on a coded 401 and its paste field reports a refusal", async ({ page, loomDaemon }) => {
      const codedUnauthorized = {
        status: 401, contentType: "application/json",
        body: JSON.stringify({ error: "gateway token required", code: "gateway-token-required" }),
      };
      await page.route((url) => url.pathname === "/api/update-status", (route) => route.fulfill(codedUnauthorized));

      await openShell(page, loomDaemon.baseURL, shell.atlas, "/");

      const banner = page.locator('[role="status"]').filter({ hasText: "This address needs a gateway token." });
      await expect(banner).toBeVisible();
      // The loopback banner must NOT be the one that answered — the two are keyed apart on purpose, and a
      // green here would otherwise be satisfiable by the wrong component entirely.
      await expect(page.getByTestId("credential-banner")).toHaveCount(0);

      // EXERCISE the paste field. Its verify probe is `GET /api/version` (a Tier-1 read a remote-class
      // request must authenticate), answered with the daemon's own coded 401 so the outcome is a genuine
      // refusal rather than an unanswered check.
      let probes = 0;
      await page.route((url) => url.pathname === "/api/version", (route) => { probes++; return route.fulfill(codedUnauthorized); });
      await banner.getByLabel("Gateway token").fill("not-a-real-gateway-token");
      await banner.getByRole("button", { name: "Use token" }).click();
      await expect(banner).toContainText("The daemon refused that token");
      expect(probes, "the verify probe never ran, so the refusal above proves nothing").toBeGreaterThan(0);
      // A refused token is never stored, so the banner stays up — there is no Dismiss under a real lock.
      expect(await page.evaluate(() => localStorage.getItem("loom.gatewayToken"))).toBeNull();
      await expect(banner).toBeVisible();
    });

    // ── 5. ToastContainer ───────────────────────────────────────────────────────────────────────────
    // The operational-alert lane (App.tsx › ToastContainer): a transient toast per NEW attention item
    // that is not a pending Request. Driven with a real seeded `board_quiet_cause` event on a real live
    // manager, so the item is derived by the production code path (lib/attention.ts › latestQuiet).
    test("a toast fires on a newly-arriving attention item, and clicking it opens the item's target", async ({ page, loomDaemon }) => {
      // The item lands ~4s after seeding (the per-manager events query's refetchInterval) and the toast
      // then lives 6s, so this test needs more than the 30s file default.
      test.setTimeout(90_000);

      const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `ChromeToastMgr-${shell.atlas ? "atlas" : "classic"}` });
      const short = mgr.sessionId.slice(0, 8);

      // A FIRST episode, seeded BEFORE the load. `useNewAttention` seeds its seen-set from the first
      // RESOLVED attention render and never replays the backlog (@decision 3157a563), so this one must
      // NOT toast — and its appearance as a row is what proves the event lane has resolved, which is the
      // precondition the second episode's toast depends on. Without that witness, a missing toast below
      // would be indistinguishable from "the seen-set had not been seeded yet".
      await loomDaemon.seedOrchestrationEvent({
        managerSessionId: mgr.sessionId, kind: "board_quiet_cause",
        detail: { reason: "nothing-actionable", totalNonTerminal: 0, causeCounts: {}, questionIds: [], releasable: [] },
      });

      // Mission Control renders the attention queue itself, so the row witness is available here.
      await openShell(page, loomDaemon.baseURL, shell.atlas, "/");
      const row = page.locator('main [data-testid="attention-row"][data-kind="QUIET BOARD"]').filter({ hasText: short });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText("quiet: 0 cards");
      await page.waitForLoadState("networkidle");
      // Nothing has toasted for the backlog item.
      await expect(page.locator(TOAST_STACK)).toHaveCount(0);

      // A SECOND episode. `latestQuiet` is keyed per manager, so this replaces the first item with a new
      // key — a genuine arrival. Its cause phrase is deliberately different from the first's, so the
      // assertions below cannot be satisfied by the already-absorbed backlog item.
      await loomDaemon.seedOrchestrationEvent({
        managerSessionId: mgr.sessionId, kind: "board_quiet_cause",
        detail: { reason: "nothing-actionable", totalNonTerminal: 7, causeCounts: { managerDeferred: 7 }, questionIds: [], releasable: [] },
      });

      const stack = page.locator(TOAST_STACK);
      const toast = stack.getByText("QUIET BOARD", { exact: true });
      await expect(toast).toBeVisible({ timeout: 30_000 });
      await expect(stack).toContainText("quiet: 7 deferred (manager)");
      // Bottom-right, i.e. genuinely in the fixed overlay rather than somewhere in page flow — the one
      // thing a text match alone could not tell apart (the same item is also a row inside <main>).
      const viewport = page.viewportSize()!;
      const box = (await stack.boundingBox())!;
      expect(box.x).toBeGreaterThan(viewport.width / 2);
      expect(box.y).toBeGreaterThan(viewport.height / 2);

      // EXERCISE it: the toast body is clickable for an openable item and navigates to its target — the
      // overlay's `useNavigate` resolving against whichever shell's Router is live.
      await toast.click();
      await expect(page).toHaveURL(new RegExp(`/session/${mgr.sessionId}$`));
      await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
    });

    // ── 6. FirstRunWelcome ──────────────────────────────────────────────────────────────────────────
    // The first-run modal. Two things have to be undone to see it at all: the shared worker daemon has
    // real projects by now while the modal is gated on the ordinary project list being EMPTY, and the
    // fixture's own context init script pre-dismisses it for EVERY spec (fixtures/daemon.ts INVARIANT 1,
    // because an un-dismissed full-viewport overlay makes every other spec's first click time out).
    //
    // 🔴 WHY THIS ONE TEST BUILDS ITS OWN CONTEXT instead of taking the `page` fixture. Undoing that
    // invariant with a page-level `removeItem` init script does NOT work, and the failure is silent in the
    // interesting direction: `addInitScript` re-runs on EVERY navigation, `reload()` included (measured on
    // cards 757c80dd and e47df20a, both polarities), so on the reload the fixture's script re-writes the
    // key and this one re-removes it — wiping the dismissal the app had just persisted and bringing the
    // modal straight back. Guarding the removal to fire once would fix THAT, but then the fixture's own
    // re-write is what keeps the modal hidden after the reload, so the persistence leg would pass without
    // the app persisting anything at all. A context with no welcome-key script in it is the only shape
    // where "it stayed dismissed" is a statement about App.tsx. The loopback token IS still seeded (copied
    // from the fixture) so an incidental UI write can't raise the credential banner into this test.
    test("the FirstRunWelcome modal renders on an empty install and its dismiss sticks across a reload", async ({ browser, loomDaemon }) => {
      const context = await browser.newContext();
      await context.addInitScript((token: string) => {
        try { localStorage.setItem("loom.loopbackToken", token); } catch { /* storage unavailable */ }
      }, loomDaemon.loopbackSecret);
      try {
        const page = await context.newPage();
        // Answered, not seeded: emptying the real daemon's project list would wreck every sibling spec on
        // this shared worker. `api.projects` is already archived-filtered + reserved-excluded server-side,
        // so an empty array is exactly what a genuinely fresh install serves.
        await page.route((url) => url.pathname === "/api/projects", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
        );

        // A fresh context starts with empty storage, so the welcome key is absent for the first paint
        // without anything having to clear it.
        await openShell(page, loomDaemon.baseURL, shell.atlas, "/");
        expect(await page.evaluate((k) => localStorage.getItem(k), WELCOME_DISMISSED_KEY)).toBeNull();

        const welcome = page.getByRole("dialog", { name: "Welcome to Loom" });
        await expect(welcome).toBeVisible();
        await expect(welcome).toContainText("Start guided setup");

        // EXERCISE the dismiss. "Maybe later" rather than the two CTAs: "Start guided setup" opens the
        // SetupWizard (its own surface, and P2-11's subject) and "Open Platform" navigates — whereas this
        // one is the path with a persisted consequence, which is what the reload leg can actually check.
        await welcome.getByRole("button", { name: "Maybe later" }).click();
        await expect(welcome).toHaveCount(0);
        expect(await page.evaluate((k) => localStorage.getItem(k), WELCOME_DISMISSED_KEY)).toBe("1");

        // PERSISTS, for the app's own reason: nothing in this context writes that key but App.tsx.
        await page.reload();
        await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Welcome to Loom" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

// ── The remount, asserted rather than described ───────────────────────────────────────────────────
// The property the P1-0 Code Review found and this card's triage note records: the chrome is NOT a single
// root mount that both shells share. Toggling the switch swaps the whole shell, so the chrome subtree is
// destroyed and rebuilt. Proven by DOM IDENTITY, not by appearance: a marker set on the live banner node
// before the toggle must be gone from the banner node after it — a surviving marker would mean the same
// element had been reparented (what a true root mount would look like), and an absent one that a fresh
// element was created.
test("toggling the switch REMOUNTS the chrome rather than carrying one root mount across (card a045bec3)", async ({ page, loomDaemon }) => {
  const MARK = "data-loom-chrome-identity";
  await fakeUpdateAvailable(page);
  await page.goto(loomDaemon.baseURL + "/settings");
  await expect(rail(page)).toBeVisible();

  const banner = updateBanner(page);
  await expect(banner).toBeVisible();

  // Mark the live node, then READ THE MARK BACK through the same locator — so "the mark is gone" later is
  // a statement about a real, previously-observable mark, not about a selector that never worked.
  await banner.evaluate((el, mark) => el.setAttribute(mark, "1"), MARK);
  await expect(banner).toHaveAttribute(MARK, "1");

  // The switch itself, through its own testid + case-insensitive names: the Segmented kit uppercases its
  // labels in CSS and Chromium folds text-transform into the accessible name, so an exact-case match here
  // would be matching a presentation detail (measured on card 757c80dd).
  await page.getByTestId("atlas-ui-switch").getByRole("tab", { name: /^atlas preview$/i }).click();
  await expect(atlasShell(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);

  // The chrome is present in the new shell...
  const atlasBanner = atlasShell(page).locator('[role="status"]').filter({ hasText: "A new Loom release is available" });
  await expect(atlasBanner).toBeVisible();
  // ...and it is a DIFFERENT element: the marker did not come with it.
  expect(await atlasBanner.getAttribute(MARK), "the banner node survived the shell swap — the chrome is a single root mount after all, and this spec's premise (plus the P1-5 plan note) needs rewriting").toBeNull();
  expect(await page.locator(`[${MARK}]`).count(), "the marked node is still somewhere in the document").toBe(0);
});
