// First-run, credential-lock and browser-notification states under BOTH Atlas switch states (card
// 19683d2f, Atlas build plan P2-11 — docs/plans/atlas-ui/03-decomposition.md row P2-11). Closes parity
// gaps §J.6–§J.8 of docs/plans/atlas-ui/01-parity-checklist.md.
//
// WHAT P1-5 ALREADY PROVED, AND WHAT IS LEFT. atlas-shell-chrome.spec.ts (card a045bec3) drives all six
// chrome elements under both shells, so "does it mount at all" is settled and is NOT re-asserted here.
// What it deliberately left open, in its own words, is every surface BEHIND those elements:
//   • §J.6 — it exercises `Maybe later` only ("'Start guided setup' opens the SetupWizard (its own
//     surface, and P2-11's subject) and 'Open Platform' navigates"). Both CTAs are below.
//   • §J.7 — it raises the banner down the `?token=` LINK path, whose headline is "A link's access
//     credential was refused." and which offers a Dismiss. The OBSERVED-write lock — "Writes are locked
//     in this browser.", the state §J.7 is actually about, and the one with no Dismiss — is a different
//     branch of the same component (`reason` vs `linkOutcome`, components/CredentialBanner.tsx) and is
//     below.
//   • §J.8 — not covered there at all. The permission ask and the mute are below.
//
// WHY THESE ARE ATLAS QUESTIONS AND NOT A RE-TEST OF THE FEATURES. Each state's own mechanism already has
// a classic-shell spec (setup-wizard.spec.ts, loopback-token-link.spec.ts, notification-mutes.spec.ts).
// What no spec covers is that each still works through the ATLAS FRAME, where three things genuinely
// differ and could regress it:
//   1. The welcome's CTAs leave the overlay and land on Atlas's own route table. `Open Platform` navigates
//      to /platform, and an address the Atlas shell has not mounted falls through to `AtlasEmptyNode`
//      (components/AtlasShell.tsx) — a plausible, silent "the button works, the destination is a stub"
//      failure that the classic shell cannot have.
//   2. The banners sit OUTSIDE `<Routes>` in both shells, but the Atlas frame re-derives its tree, crumbs
//      and heading on every navigation where the classic rail re-derives almost nothing. A remount there
//      would wipe a half-pasted credential — the owner's standing "never destroy a user's unfinished
//      input" rule — so the draft is pinned by a test rather than by that structural argument.
//   3. The mute toggles MOVED. P2-12 (card 595e2a47) split Settings by scope, and "Browser notifications"
//      lives inside the Global/Daemon section, which is `scope: "workspace"` — so under Atlas it is at
//      /workspace-settings, not /settings. That is the "Settings mute toggle's own new location" the P2-11
//      plan row names. P2-12's own spec proved the SECTION lands on the workspace node (witnessed on
//      "Rate Limits"); it did not touch these toggles, and nothing proved a mute set there is still
//      honoured by the Atlas-mounted ToastContainer.
//
// Seeding, and the no-real-claude invariant: every refusal is a client-side `page.route` answer (fiction
// only this browser sees), and every attention item is a real seeded daemon row through the shared
// `loomDaemon` fixture (`seedLiveSession` / `seedQuestion`, both POST /internal/test/seed — the existing
// endpoint, nothing new daemon-side). Nothing here spawns a pty, and no control that would reach a real
// outward daemon write is ever clicked: the SetupWizard is opened and closed, never applied.
import { expect, test, type Page } from "./fixtures/daemon";

// Owned by lib/atlasUi.ts, App.tsx and lib/loopbackCredential.ts respectively. Hardcoded rather than
// imported for the same reason atlas-shell-chrome.spec.ts hardcodes them: tsconfig.e2e.json covers `e2e/`
// only, so a spec cannot pull a `src/` module in.
const ATLAS_KEY = "loom.atlasUi";
const WELCOME_DISMISSED_KEY = "loom.setupWelcomeDismissed";
const LOOPBACK_TOKEN_KEY = "loom.loopbackToken";
// lib/activeProject.tsx owns this one. The project node's own queue is project-FILTERED, so the
// `/project` case below has to pin which project the tree is open on.
const PROJECT_KEY = "loom.projectId";

// The loopback guard's own 401 shape. `isCredentialGuardMessage` (lib/loopbackCredential.ts) keys on the
// literal `loom open` pointer, and ONLY that makes a 401 this banner's business — @decision 093981dd
// explains at length why it must not be widened to a bare status check, and this spec depends on exactly
// that coupling rather than working around it.
const GUARD_401 = {
  status: 401,
  contentType: "application/json",
  body: JSON.stringify({ error: "unauthorized — see `loom open` for how to obtain the local access credential" }),
};

const rail = (page: Page) => page.locator(".loom-rail");
const atlasShell = (page: Page) => page.getByTestId("atlas-shell");
const credentialBanner = (page: Page) => page.getByTestId("credential-banner");
const welcomeDialog = (page: Page) => page.getByRole("dialog", { name: "Welcome to Loom" });

const SHELLS = [
  { name: "switch OFF", atlas: false },
  { name: "switch ON", atlas: true },
] as const;

/**
 * Where the browser-notification mute toggles live in THIS shell.
 *
 * The whole point of the §J.8 half: classic renders every section on one page, while Atlas splits them by
 * `scope` and these toggles are inside a `workspace` section. Derived here once so every test below is
 * driven through the shell's REAL location, and a wrong answer fails as a missing toggle rather than as a
 * silently skipped assertion.
 */
const settingsPathFor = (atlas: boolean) => (atlas ? "/workspace-settings" : "/settings");

/**
 * The Global/Daemon section's own wrapper (pages/Settings.tsx › SettingsColumn stamps
 * `settings-section-<key>` on each), which is the section the "Browser notifications" toggles live inside.
 *
 * Everything below is scoped to it rather than reached page-wide: this page renders several `Save` buttons
 * and several sections, so a page-wide `.last()` would be a bet on declaration order — and the order
 * DIFFERS between the two shells here, since Atlas filters the section list by scope. Scoping makes the
 * locator say which Save it means.
 */
const globalSection = (page: Page) => page.getByTestId("settings-section-global-daemon");
const notifySave = (page: Page) => globalSection(page).getByRole("button", { name: "Save", exact: true });

/** Seed the switch ON for the FIRST paint — lib/atlasUi.ts reads it synchronously at module load. There is
 *  deliberately no OFF counterpart: OFF is what empty storage already means. */
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

/**
 * Land on `path` under the requested switch state and prove EXACTLY ONE shell is mounted.
 *
 * Presence before absence, same as atlas-shell-chrome.spec.ts: a leading `toHaveCount(0)` on the other
 * shell also passes on a page that has rendered nothing yet, which would make every "the other shell is
 * gone" claim vacuous on a slow load.
 */
async function openShell(page: Page, baseURL: string, atlas: boolean, path: string): Promise<void> {
  if (atlas) await seedAtlasOn(page);
  await page.goto(baseURL + path);
  await expect(atlas ? atlasShell(page) : rail(page)).toBeVisible();
  await expect(atlas ? rail(page) : atlasShell(page)).toHaveCount(0);
}

/** Read the STORED platform override's muted list. `null` is the default — "nothing muted" is stored as an
 *  absent key, not as `[]`. */
async function readMuted(baseURL: string): Promise<string[] | null> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  if (!res.ok) throw new Error(`GET /api/platform/config -> ${res.status}`);
  const body = (await res.json()) as { override?: { mutedBrowserNotifications?: string[] } };
  return body?.override?.mutedBrowserNotifications ?? null;
}

/** Fail LOUDLY on a bad write: this key is DAEMON-GLOBAL on the shared worker daemon, so a cleanup that
 *  fails quietly would silence a later spec's notifications where nobody would look for the cause. */
async function patchMuted(baseURL: string, muted: string[] | null): Promise<void> {
  const res = await fetch(`${baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { mutedBrowserNotifications: muted } }),
  });
  if (!res.ok) throw new Error(`PATCH /api/platform/config -> ${res.status} ${await res.text()}`);
}

/** Answer PATCH /api/platform/config with the loopback guard's coded 401, leaving reads alone — the
 *  Settings page cannot render its toggles at all without that GET, and the banner's own claim is
 *  "reading works; writes do not". */
async function refuseConfigWrites(page: Page): Promise<void> {
  await page.route((url) => url.pathname === "/api/platform/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill(GUARD_401);
  });
}

for (const shell of SHELLS) {
  test.describe(`first-run / credential / notification states — ${shell.name} (card 19683d2f)`, () => {
    // The mute tests below write a DAEMON-GLOBAL key. Always clear it back to the all-on default, even on
    // a failure, or a leftover mute silences a later spec file's notifications.
    test.afterEach(async ({ loomDaemon }) => {
      await patchMuted(loomDaemon.baseURL, null);
    });

    // ── §J.6a — the welcome's "Start guided setup" CTA ──────────────────────────────────────────────
    //
    // 🔴 WHY THE WELCOME TESTS BUILD THEIR OWN CONTEXT, copied from atlas-shell-chrome.spec.ts's own
    // finding rather than re-derived: the `page` fixture pre-dismisses this modal for EVERY spec
    // (fixtures/daemon.ts INVARIANT 1, because an un-dismissed full-viewport overlay times out every other
    // spec's first click), and undoing that with a page-level `removeItem` init script does not work —
    // `addInitScript` re-runs on every navigation, so the two scripts fight and either wipe the dismissal
    // the app just persisted or keep the modal hidden for the FIXTURE's reason, making any claim about it
    // vacuous. A context with no welcome-key script in it is the only shape where the modal's behaviour is
    // a statement about App.tsx. The loopback token IS seeded (copied off the fixture) so an incidental UI
    // write cannot raise the credential banner into a test about the welcome.
    test("the welcome's Start guided setup opens the SetupWizard, and closing it returns to the welcome", async ({ browser, loomDaemon }) => {
      const context = await browser.newContext();
      try {
        await context.addInitScript(([tokenKey, token, atlasKey, on]: string[]) => {
          try {
            localStorage.setItem(tokenKey!, token!);
            if (on === "1") localStorage.setItem(atlasKey!, "1");
          } catch { /* storage unavailable — assertions will say so */ }
        }, [LOOPBACK_TOKEN_KEY, loomDaemon.loopbackSecret, ATLAS_KEY, shell.atlas ? "1" : "0"]);
        const page = await context.newPage();
        // Answered, never seeded: emptying the real daemon's project list would wreck every sibling spec on
        // this shared worker. `api.projects` is already archived-filtered and reserved-excluded
        // server-side, so `[]` is exactly what a genuinely fresh install serves — and it is what gates this
        // modal (App.tsx).
        await page.route((url) => url.pathname === "/api/projects", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
        );

        await page.goto(loomDaemon.baseURL + "/");
        await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
        await expect(shell.atlas ? rail(page) : atlasShell(page)).toHaveCount(0);

        const welcome = welcomeDialog(page);
        await expect(welcome).toBeVisible();

        // The CTA carries a trailing arrow glyph, so it is matched by prefix rather than exactly — the
        // glyph is presentation, and pinning it would make this a test about punctuation.
        await welcome.getByRole("button", { name: /^Start guided setup/ }).click();

        // THE OBSERVABLE: the wizard takes over, and the welcome YIELDS rather than stacking under it.
        // FirstRunWelcome returns ONLY the wizard while it is open (App.tsx), deliberately, so that one
        // Escape handler is in play — a welcome still mounted here would mean two overlays fighting for it.
        const wizard = page.getByRole("dialog", { name: "Set up a new project" });
        await expect(wizard).toBeVisible();
        await expect(welcome).toHaveCount(0);

        // Opening the wizard is NOT a dismissal: back out of it and the welcome must still be there, so a
        // user who opened it by accident has not silently lost their one first-run entry point.
        expect(await page.evaluate((k) => localStorage.getItem(k), WELCOME_DISMISSED_KEY)).toBeNull();

        // Closed with the wizard's own × — never completed, since applying it would create a real project
        // on the shared daemon.
        await wizard.getByLabel("Close setup").click();
        await expect(wizard).toHaveCount(0);
        await expect(welcome).toBeVisible();

        // All of it happened inside the live shell; neither overlay fell out of it.
        await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
        await expect(shell.atlas ? rail(page) : atlasShell(page)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    // ── §J.6b — the welcome's "Open Platform" CTA ──────────────────────────────────────────────────
    // The one CTA that leaves the overlay for the shell's own route table, which is where Atlas can differ
    // from classic: an address AtlasShell has not mounted renders `AtlasEmptyNode` instead of the page, so
    // "the button navigated" and "the destination exists" are two separate claims here and both are made.
    test("the welcome's Open Platform lands on the real Platform node and dismisses the welcome", async ({ browser, loomDaemon }) => {
      const context = await browser.newContext();
      try {
        await context.addInitScript(([tokenKey, token, atlasKey, on]: string[]) => {
          try {
            localStorage.setItem(tokenKey!, token!);
            if (on === "1") localStorage.setItem(atlasKey!, "1");
          } catch { /* storage unavailable — assertions will say so */ }
        }, [LOOPBACK_TOKEN_KEY, loomDaemon.loopbackSecret, ATLAS_KEY, shell.atlas ? "1" : "0"]);
        const page = await context.newPage();
        await page.route((url) => url.pathname === "/api/projects", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
        );

        await page.goto(loomDaemon.baseURL + "/");
        await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
        await expect(shell.atlas ? rail(page) : atlasShell(page)).toHaveCount(0);
        await expect(welcomeDialog(page)).toBeVisible();

        await welcomeDialog(page).getByRole("button", { name: "Open Platform" }).click();

        await expect(page).toHaveURL(/\/platform$/);
        // `goSetup` navigates AND dismisses (App.tsx), so a user handed to the Platform agent is not asked
        // again on their next load.
        await expect(welcomeDialog(page)).toHaveCount(0);
        expect(await page.evaluate((k) => localStorage.getItem(k), WELCOME_DISMISSED_KEY)).toBe("1");

        // THE REAL PAGE, not the frame's fallback.
        //
        // ⚠️ Witnessed on a SHARED SECTION, not on a panel wrapper. `platform-panel-*` exists only in
        // `AtlasPlatformLayout`'s `Panels` (pages/PlatformView.tsx) — the classic layout stacks the same
        // five sections down one column with no panel wrapper at all — so it is NOT a both-shell locator.
        // An earlier revision of this spec asserted it under both and went red on the classic leg for
        // exactly that reason. "Operator session" is inside the shared `home` section, which Atlas puts on
        // its default tab and classic puts in the stack, so it reads under either — the same witness
        // atlas-platform.spec.ts uses on BOTH of its own legs. Scoped to `main` because the classic rail
        // draws NAV_PAGES labels as exact text.
        await expect(page.locator("main").getByText("Operator session", { exact: true })).toBeVisible();
        await expect(page.getByTestId("atlas-empty"),
          "Open Platform landed on AtlasShell's fallback node — /platform is not mounted in the Atlas route table").toHaveCount(0);

        await expect(shell.atlas ? atlasShell(page) : rail(page)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    // ── §J.7 — the OBSERVED write lock, and a wrong paste against it ───────────────────────────────
    // A different branch from P1-5's link outcome: this is `reason === "write"`, armed by api.ts's
    // `guardedFetch` chokepoint when a real UI write comes back as the guard's coded 401. Driven from the
    // mute toggles' own save, so the write is one a user genuinely makes at this address under this shell —
    // which also makes this test the place where §J.7's state and §J.8's new location meet.
    test("a refused write locks writes from this shell's Settings, and a wrong paste keeps it locked with no Dismiss", async ({ page, loomDaemon }) => {
      await refuseConfigWrites(page);
      await openShell(page, loomDaemon.baseURL, shell.atlas, settingsPathFor(shell.atlas));

      // The toggle proves the mute panel really is at THIS address under THIS shell before anything else is
      // asserted — on a wrong guess the rest of the test would fail for an unrelated reason.
      const quietBoard = globalSection(page).getByTestId("notify-quiet-board");
      await expect(quietBoard).toBeVisible();
      await expect(credentialBanner(page)).toHaveCount(0);

      await quietBoard.uncheck();
      await notifySave(page).click();

      // THE OBSERVED LOCK. Its headline is the state §J.7 names, and it is NOT the link-outcome wording
      // P1-5 pinned — so a green here cannot come from that other branch.
      const banner = credentialBanner(page);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Writes are locked in this browser.");
      // The fixture seeded a real token, so this is the stale/wrong-credential wording rather than the
      // no-credential one (components/CredentialBanner.tsx picks on `holdsToken`).
      await expect(banner).toContainText("the credential this browser holds was refused");
      // @decision 093981dd — the copy names the credential's FILE PATH, never the secret value.
      await expect(banner).toContainText("gateway-loopback.key");
      // A REAL lock has no Dismiss (only a link outcome, where nothing is actually broken, offers one).
      // This is the single assertion that separates this state from the one P1-5 already covers.
      await expect(banner.getByTestId("loopback-link-dismiss"),
        "a real lock offered a Dismiss — that is only ever for a link outcome").toHaveCount(0);

      // EXERCISE the recovery through the guarded verify-then-store path, unchanged: the probe is a POST to
      // /api/agents/<fresh uuid> (@decision 093981dd — never a GET, since the guard exempts reads and a
      // wrong paste would then clear the banner while claiming it was fixed).
      let probes = 0;
      await page.route((url) => url.pathname.startsWith("/api/agents/"), async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        probes++;
        await route.fulfill(GUARD_401);
      });

      await banner.getByLabel("Local access credential").fill("not-the-real-secret");
      await banner.getByRole("button", { name: "Unlock writes" }).click();
      await expect(banner).toContainText("The daemon refused that credential");
      expect(probes, "the verify probe never ran, so the refusal above proves nothing").toBeGreaterThan(0);
      // Still locked, still no way to wave it away, and the working credential was never evicted by the bad
      // paste — which is exactly what the verify-BEFORE-store order buys.
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Writes are locked in this browser.");
      await expect(banner.getByTestId("loopback-link-dismiss")).toHaveCount(0);
      expect(await page.evaluate((k) => localStorage.getItem(k), LOOPBACK_TOKEN_KEY)).toBe(loomDaemon.loopbackSecret);
    });

    // ── §J.7 — the half-pasted credential survives moving around the shell ─────────────────────────
    // The owner's standing rule: never destroy a user's unfinished input. The banner sits outside `<Routes>`
    // in both shells, so this SHOULD hold — but the Atlas frame re-derives its tree, crumbs and node
    // heading on every navigation, which is exactly the kind of change that remounts a sibling by accident,
    // and a wiped field would be silent. The field also self-clears on a FRESH lock by design
    // (components/CredentialBanner.tsx's `visible` effect), so this pins the one polarity that is a bug.
    test("a half-typed credential survives navigating between destinations", async ({ page, loomDaemon }) => {
      await refuseConfigWrites(page);
      await openShell(page, loomDaemon.baseURL, shell.atlas, settingsPathFor(shell.atlas));

      await globalSection(page).getByTestId("notify-quiet-board").uncheck();
      await notifySave(page).click();

      const banner = credentialBanner(page);
      await expect(banner).toBeVisible();

      // Mid-entry: a partial paste, the state a user is in when they go off to find the file.
      const field = banner.getByLabel("Local access credential");
      const PARTIAL = "half-pasted-credenti";
      await field.fill(PARTIAL);
      await expect(field).toHaveValue(PARTIAL);

      // Navigate WITHIN the shell, by the shell's own means — the classic rail's link and the Atlas tree's
      // node both reach a destination through an `<a href>`, so one locator serves both. /platform is a
      // destination every shell mounts, and is not where we started.
      await page.locator('a[href="/platform"]').first().click();
      await expect(page).toHaveURL(/\/platform$/);
      // A shared section, so this reads under either layout — see the note in the Open Platform test
      // above for why a `platform-panel-*` wrapper is Atlas-only and cannot be used here.
      await expect(page.locator("main").getByText("Operator session", { exact: true })).toBeVisible();

      // THE ASSERTION: the banner came along, and so did what the user had typed.
      await expect(banner).toBeVisible();
      await expect(field, "the credential field was wiped by navigating — the banner remounted").toHaveValue(PARTIAL);
    });

    // ── §J.8a — the one-time permission ask ────────────────────────────────────────────────────────
    // `ToastContainer` asks once on mount, gated on `Notification.permission === "default"` (App.tsx).
    // Replaced with a recorder before any page script runs, so no real OS prompt can appear and the ask is
    // countable. The count is asserted EXACTLY, not ">= 1": asking repeatedly is its own defect, and under
    // Atlas the chrome is a per-shell mount (card a045bec3), which is precisely where a double-mount would
    // show up.
    test("the browser-notification permission is asked exactly once, and nothing is announced before it is granted", async ({ page, loomDaemon }) => {
      await page.addInitScript(() => {
        const asks: string[] = [];
        const raised: string[] = [];
        const w = window as unknown as { __loomAsks: string[]; __loomRaised: string[]; Notification: unknown };
        w.__loomAsks = asks;
        w.__loomRaised = raised;
        class AskRecordingNotification {
          // "default" is the state the ask is gated on — a granted or denied browser is never asked again.
          static permission = "default";
          static requestPermission() { asks.push("asked"); return Promise.resolve("default"); }
          constructor(title: string) { raised.push(title); }
          close() { /* no-op */ }
        }
        w.Notification = AskRecordingNotification;
      });

      await openShell(page, loomDaemon.baseURL, shell.atlas, "/");

      await expect.poll(() => page.evaluate(() => (window as unknown as { __loomAsks: string[] }).__loomAsks.length),
        { message: "ToastContainer never asked for notification permission under this shell" }).toBe(1);
      // An unanswered ask must not be read as consent: nothing is announced while permission is "default".
      expect(await page.evaluate(() => (window as unknown as { __loomRaised: string[] }).__loomRaised)).toEqual([]);
    });

    // ── §J.8b — a mute set at THIS shell's Settings location is honoured ───────────────────────────
    // Both polarities on one page, following notification-mutes.spec.ts's proven shape, because "no
    // notification fired" is unfalsifiable alone — a muted phase recording zero only means something next
    // to an unmuted phase, on the same stub, that records one. The mute is set THROUGH THE UI at this
    // shell's own address (not over REST) because the location is the thing under test; the unmute is over
    // REST, since by then the UI write has already been proven.
    test("a kind muted from this shell's Settings fires no browser Notification, while the same kind unmuted fires one", async ({ page, loomDaemon }) => {
      // The attention item lands on the openQuestions poll (3s, lib/attention.ts) and each phase waits for
      // its own witness, so this needs more than the 30s file default.
      test.setTimeout(120_000);

      const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `P211Mgr-${shell.atlas ? "atlas" : "classic"}` });
      const stamp = Date.now();
      const mutedTitle = `P2-11 muted decision ${stamp}`;
      const unmutedTitle = `P2-11 unmuted decision ${stamp}`;

      // Recorder for the real `new Notification(...)` calls. Re-runs on every reload, which also resets the
      // log — so phase B counts only what was raised under the unmuted config.
      await page.addInitScript(() => {
        const recorded: { title: string; body: string | null }[] = [];
        (window as unknown as { __loomNotifications: typeof recorded }).__loomNotifications = recorded;
        class RecordingNotification {
          static permission = "granted";
          static requestPermission() { return Promise.resolve("granted"); }
          constructor(title: string, opts?: { body?: string }) { recorded.push({ title, body: opts?.body ?? null }); }
          close() { /* no-op */ }
        }
        (window as unknown as { Notification: unknown }).Notification = RecordingNotification;
      });

      // Matched on a per-test stamp in the BODY: the daemon is shared, so filtering on the kind label alone
      // would let a neighbouring spec's pending request count as ours in either direction.
      const matching = (needle: string) => page.evaluate((n) =>
        (window as unknown as { __loomNotifications: { title: string; body: string | null }[] })
          .__loomNotifications.filter((rec) => (rec.body ?? "").includes(n)), needle);

      // Set the mute where THIS shell actually puts it, and confirm it reached the daemon-global override.
      // A render-only or localStorage-only implementation would fail right here.
      await openShell(page, loomDaemon.baseURL, shell.atlas, settingsPathFor(shell.atlas));
      const quietBoard = globalSection(page).getByTestId("notify-quiet-board");
      await expect(quietBoard).toBeVisible();
      await expect(quietBoard).toBeChecked();
      // "request" is the category a pending decision resolves to (lib/attention.ts) and is the one under
      // test; "quiet-board" above is only the witness that this panel is the real one.
      await globalSection(page).getByTestId("notify-request").uncheck();
      await notifySave(page).click();
      await expect.poll(() => readMuted(loomDaemon.baseURL),
        { message: `saving the mute at ${settingsPathFor(shell.atlas)} never reached the platform override` }).toEqual(["request"]);

      // ── PHASE A: muted. The item arrives, the pill proves the toast surface processed it, NO Notification.
      // /platform is outside the pill's suppression set (App.tsx — the routes whose own page renders the
      // queue), so the pill is available here as the witness under either shell.
      await page.goto(`${loomDaemon.baseURL}/platform`);
      const pill = page.getByTestId("request-count-pill");
      await expect(pill).toHaveCount(0);

      await loomDaemon.seedQuestion({
        sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
        title: mutedTitle, options: ["A", "B"],
      });
      // THE WITNESS. Without it the zero below is indistinguishable from "nothing ever arrived".
      await expect(pill).toHaveText(/1\s*request needs you/, { timeout: 30_000 });
      expect(await matching(mutedTitle)).toEqual([]);

      // ── PHASE B (the positive control): unmuted, a second request DOES raise one.
      await patchMuted(loomDaemon.baseURL, null);
      await page.reload();
      await expect(page.getByTestId("request-count-pill")).toHaveText(/1\s*request needs you/, { timeout: 30_000 });

      await loomDaemon.seedQuestion({
        sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
        title: unmutedTitle, options: ["A", "B"],
      });
      await expect(page.getByTestId("request-count-pill")).toHaveText(/2\s*requests need you/, { timeout: 30_000 });
      await expect.poll(async () => (await matching(unmutedTitle)).length, { timeout: 30_000 }).toBe(1);
      expect((await matching(unmutedTitle))[0]!.body).toContain(unmutedTitle);
      // Phase A's request is still pending (the count above says 2), and with the mute lifted it is the one
      // row that would re-announce if the pending backlog ever replayed — so this doubles as a standing
      // witness for @decision 3157a563, asserted after phase B's own notification landed so the zero cannot
      // be an un-flushed-effect race.
      expect(await matching(mutedTitle)).toEqual([]);
    });
  });
}

// ── The Atlas Workspace node renders the queue, so the collapsed pill must stand down there ─────────
// Found while establishing where each of these states mounts, and the one product change this card makes.
// `REQUEST_PILL_SUPPRESSED_ROUTES` (App.tsx) is a hand-listed set of classic paths — "/", "/overview",
// "/inbox" — whose own page already renders the full pending-Request queue, so the collapsed count pill
// there is pure duplication. The Atlas Workspace node `/home` renders that same queue (a "Needs you" band
// plus the `needs you` KPI's pop-over, both off `useAttention().items` — pages/WorkspaceHome.tsx) and was
// NOT in the set, so a pending Request was announced twice on that one node. §E of the parity checklist
// carries this pill over as "unchanged, one collapsed pill", so the rule has to carry with it.
//
// Atlas-only by construction (the classic shell never mounts ATLAS_HOMES), so there is no OFF polarity to
// assert on /home itself. The contrast case that keeps it honest is the SAME browser and the SAME pending
// request on an Atlas node that does NOT render a queue: the pill must still appear there, or this would be
// satisfiable by the pill being broken outright under Atlas.
test("the collapsed request pill stands down on the Atlas Workspace node, which renders the queue itself (card 19683d2f)", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);

  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "P211PillMgr" });
  const title = `P2-11 pill decision ${Date.now()}`;

  await seedAtlasOn(page);
  // An Atlas node that renders NO attention queue, so the pill is expected here. `/agents` is a node of its
  // own (card c6160c7d) and is not in the suppression set.
  await page.goto(`${loomDaemon.baseURL}/agents`);
  await expect(atlasShell(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);

  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title, options: ["A", "B"],
  });

  // THE CONTRAST CASE: the pill works under Atlas, on a node whose page is not the queue.
  const pill = page.getByTestId("request-count-pill");
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toHaveText(/requests? needs? you/);

  // Now the Workspace node, same browser, same pending request — reached through the tree, the way a user
  // gets there.
  await page.getByTestId("atlas-home-workspace").click();
  await expect(page).toHaveURL(/\/home$/);

  // The page IS the surface here: its own queue lists the request...
  const needsYou = page.locator("main").getByTestId("attention-row");
  await expect(needsYou.first()).toBeVisible({ timeout: 30_000 });
  // ...so the pill stands down. Scoped by testid rather than by text, because the row inside <main> and the
  // pill would both match "request needs you".
  await expect(pill,
    "the collapsed request pill double-announced on the Atlas Workspace node, which already renders the attention queue").toHaveCount(0);
});

// ── And the Atlas PROJECT node renders it too, so the pill stands down there as well ────────────────
// Code review b864ece3 (Minor) on the commit above: the set's own comment asserted that `/project`
// renders no attention queue. Verified at source and it is false — pages/ProjectHome.tsx builds a
// "Needs you" BandPanel (`atlas-band-needs`) AND the `needs you` KPI's pop-over from `useAttention()`
// filtered through `attentionItemInProject`, via the SAME shared `AttentionList` WorkspaceHome uses.
// That is precisely the project-filtered queue classic `/overview` renders off the same helper, and
// `/overview` is already in the set — so the decision was parity with classic rather than a new rule,
// trade-off included: the pill counts daemon-wide while the band is project-scoped, exactly as on
// `/overview`.
//
// Same shape and the same honesty requirement as the `/home` case above — Atlas-only, so there is no
// OFF polarity to assert, and the contrast case is the SAME browser with the SAME pending request on
// `/agents`, the node that renders no queue. Two differences this node forces: the project is PINNED
// (the band filters by the ACTIVE project, so a default pick would leave the fixture's identity up to
// whatever the shared daemon happens to hold), and the band's row is addressed by `data-session-id`
// rather than by presence — components/fleet.tsx:167 states why, and here it is load-bearing, since a
// bare `attention-row` count cannot tell OUR request apart from a sibling spec's byte-identical one.
test("the collapsed request pill stands down on the Atlas project node, which renders the queue itself (card 19683d2f)", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);

  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "P211ProjPillMgr" });
  const title = `P2-11 project pill decision ${Date.now()}`;

  await seedAtlasOn(page);
  // Unconditional, unlike atlas-project-selection.spec.ts's `pinProject`: nothing here reloads to
  // measure persistence, and this spec's whole point is that the node is open on the project owning
  // the seeded request — so re-pinning on every navigation is the intent, not a confound.
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage unavailable — assertions will say so */ }
  }, [PROJECT_KEY, mgr.projectId] as const);

  await page.goto(`${loomDaemon.baseURL}/agents`);
  await expect(atlasShell(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);

  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title, options: ["A", "B"],
  });

  // THE CONTRAST CASE: `/agents` renders no queue, so the pill must work here — without this leg the
  // assertion below is satisfiable by the pill being broken outright under Atlas.
  const pill = page.getByTestId("request-count-pill");
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toHaveText(/requests? needs? you/);

  // Now the project node, same browser, same pending request — reached through the tree, the way a
  // user gets there.
  await page.getByTestId("atlas-home-project").click();
  await expect(page).toHaveURL(/\/project$/);

  // The page IS the surface here: its own "Needs you" band lists THIS project's request. Asserted
  // first, because it is the leg that retries until the page's own reads have landed — a leading
  // `toHaveCount(0)` would be satisfied by a page still loading (card 625d791c).
  await expect(page.getByTestId("atlas-band-needs")
    .locator(`[data-testid="attention-row"][data-session-id="${mgr.sessionId}"]`))
    .toHaveCount(1, { timeout: 30_000 });
  // ...so the pill stands down.
  await expect(pill,
    "the collapsed request pill double-announced on the Atlas project node, which already renders the project-filtered attention queue").toHaveCount(0);
});
