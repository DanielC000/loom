// Companion "not provisioned" e2e (card ed49cef6) — proves a live, unconfigured, unbound assistant
// session (no companion_config row, no binding — unreachable by construction, per the f899381b
// investigation this card followed up on) appears on /companion as "not provisioned" instead of sitting
// invisible, and that the Provision action — which reuses the EXISTING human-only POST /api/companion/
// config path (the same create-config flow a "binding only" companion already uses, option (b)'s "no
// new endpoint" instruction) — turns it into a normal, configured companion. A second case proves "Stop
// session" removes it from the page entirely.
//
// SEEDING: `loomDaemon.seedLiveSession({ role: "assistant" })` — a direct DB insert, writing NO
// companion_config and NO binding, unlike `seedCompanion` (which seeds all three). This is deliberately
// the ONE fixture call that reaches the orphaned shape this card fixes; the investigation confirmed the
// SAME shape is reachable via ordinary human REST too (bind an assistant-role profile to an agent, then
// start a session with no body). Isolation is automatic — `autoIsolation` archives every
// `seedLiveSession` session after each test — so this spec needs no afterEach of its own.
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

// The GET the page's `["companionConfigs"]` query issues. Exact (not a prefix glob) so holding or failing
// it never touches the POST create on the SAME path, nor the DELETE on `/api/companion/config/:id`.
const CONFIGS_URL = (baseURL: string) => `${baseURL}/api/companion/config`;

// Screenshot hook (opt-in via LOOM_E2E_SHOTS, same convention as board-task-modal.spec.ts and friends):
// unset in CI, so this is a no-op there. Set it to a dir to persist the before/after render for review.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (page: Page, name: string) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name) }); };

test("an unconfigured, unbound assistant session shows as 'not provisioned', and Provision configures it", async ({ page, loomDaemon }) => {
  const seeded = await loomDaemon.seedLiveSession({ role: "assistant" });
  try {
    await page.goto(`${loomDaemon.baseURL}/companion`);

    // Not the empty create-box — the orphaned session already gives the page a companion row to show.
    await expect(page.getByText("New companion", { exact: true })).toHaveCount(0);

    // The orphan's own badge + its dedicated panel — never the normal Chat/Manage/Terminal tabs, since
    // there is nothing for Chat to show with no binding at all.
    await expect(page.getByText("not provisioned", { exact: true })).toBeVisible();
    await expect(page.getByTestId("companion-unprovisioned-panel")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Companion view" })).toHaveCount(0);
    await shoot(page, "ed49cef6-before-provision.png");

    // Provision: the SAME create-config form a "binding only" companion already uses (ConfigSection in
    // create mode), reached via the "Provision"-labeled button rather than "Configure".
    await page.getByRole("button", { name: "Provision" }).click();
    await page.getByPlaceholder("123456:ABC-DEF…").fill("123456:e2e-unprovisioned-token");
    await page.getByPlaceholder("e.g. 123456789").fill("987654321");
    await page.getByRole("button", { name: "Save" }).click();

    // Now a normal, configured companion: the badge flips, the panel is gone, Chat/Manage/Terminal render.
    await expect(page.getByText("not provisioned", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("companion-unprovisioned-panel")).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Companion view" })).toBeVisible();
    await expect(page.getByText("enabled", { exact: true })).toBeVisible();
    await shoot(page, "ed49cef6-after-provision.png");
  } finally {
    // This Provision writes a REAL companion_config via the real human-only POST /api/companion/config
    // (deliberately — this card's whole point is reusing that path), which `autoIsolation`'s
    // `deleteSeededCompanionConfigs` does NOT know about (it only tracks rows created through the
    // fixture's OWN `seedCompanion` helper) — so this test must clean up its own write, or the config +
    // its armed token leak into every later spec sharing this worker's daemon.
    await fetch(`${loomDaemon.baseURL}/api/companion/config/${seeded.sessionId}`, { method: "DELETE" }).catch(() => {});
  }
});

// A `seedLiveSession` row with no real registered pty has nothing for `PtyHost.stop()` to act on (it's a
// genuine DB-only row — no process, no `seedCanned` stub either), so this fixture can't observe the
// session actually disappearing the way a REAL companion session's stop would (that round-trip through a
// real process's exit event is already covered by the terminal-lifecycle specs, not re-proven here).
// What IS provable, and what this card's own DoD is actually about, is the WIRING: clicking "Stop session"
// on the unprovisioned panel must issue the real `POST /api/sessions/:id/stop` for exactly this session,
// in graceful mode — the same call every other Stop control on this page already makes.
test("Stop session issues the real stop call for the unconfigured, unbound assistant session", async ({ page, loomDaemon }) => {
  const seeded = await loomDaemon.seedLiveSession({ role: "assistant" });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByTestId("companion-unprovisioned-panel")).toBeVisible();
  const stopRequest = page.waitForRequest(
    (req) => req.url() === `${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/stop` && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Stop session" }).click();
  const req = await stopRequest;
  expect(req.postDataJSON()).toEqual({ mode: "graceful" });
});

// ── The LOADING GATE (review round 1) ─────────────────────────────────────────────────────────────────
// The orphan derivation answers "which live assistant sessions are in NEITHER the config list nor the
// binding list" — and an EMPTY provisioned set means either "nothing is provisioned" or "we haven't been
// told yet". ["allSessions"] is usually already warm app-wide while those two reads are still in flight, so
// deriving off the session list alone rendered EVERY live assistant session — real, configured companions
// included — as "not provisioned", with an unconfirmed "Stop session" button, until the configs landed.
//
// `ptyGeometry` is LOAD-BEARING here, not decoration: a plain `seedCompanion` row is `exited`, which the
// derivation's own live/starting check excludes regardless of any gate — so without a canned pty this spec
// would pass whether the gate exists or not. The canned entry makes the row genuinely LIVE, i.e. a real
// candidate the gate is the only thing holding back.
test("a provisioned companion is never shown as 'not provisioned' while the configs read is still in flight", async ({ page, loomDaemon }) => {
  const seeded = await loomDaemon.seedCompanion({ name: "Held", ptyGeometry: { cols: 80, rows: 24 } });
  let releaseConfigs = () => {};
  const held = new Promise<void>((resolve) => { releaseConfigs = () => resolve(); });
  let holds = 0;
  await page.route(CONFIGS_URL(loomDaemon.baseURL), async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    holds += 1;
    await held;
    await route.continue();
  });

  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Wait for EITHER render this page can reach while the configs read is held — the mid-load placeholder,
  // or the orphan panel the gate exists to suppress. A bare `toHaveCount(0)` would otherwise pass
  // vacuously against a page that simply hadn't rendered yet; anchoring on something true under BOTH
  // outcomes is also what keeps the ASSERTION below (not the anchor) the thing a regression trips on.
  await expect(page.locator('[data-testid="companion-unprovisioned-panel"], p:text-is("Loading…")').first()).toBeVisible();

  // THE ASSERTION: the live assistant session behind that held config is NOT presented as an orphan.
  await expect(page.getByTestId("companion-unprovisioned-panel")).toHaveCount(0);
  await expect(page.getByText("not provisioned", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);

  // Fixture identity: this really is THIS page mid-load against the read this spec is holding.
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  expect(holds, "the configs GET was actually intercepted and held").toBeGreaterThan(0);
  await shoot(page, "ed49cef6-configs-held.png");

  // Released ⇒ it resolves as the real, configured companion it always was. The orphan panel never appears.
  releaseConfigs();
  await expect(page.getByRole("tablist", { name: "Companion view" })).toBeVisible();
  await expect(page.getByText("Held", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("companion-unprovisioned-panel")).toHaveCount(0);
  await expect(page.getByText("not provisioned", { exact: true })).toHaveCount(0);
  await shoot(page, "ed49cef6-configs-released.png");
  expect(seeded.sessionId).toMatch(/^e2e-companion-/);
});

// An ERRORED configs read is the permanent form of the same defect: the query never answers, so an
// un-gated derivation left every live assistant session stuck on "not provisioned" for the life of the
// page. Fail toward "not shown" — no orphan rows at all.
test("a failed configs read shows NO orphan rows", async ({ page, loomDaemon }) => {
  const orphanId = `e2e-orphan-${randomUUID()}`;
  await loomDaemon.seedLiveSession({ role: "assistant", id: orphanId });
  let failures = 0;
  await page.route(CONFIGS_URL(loomDaemon.baseURL), async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    failures += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "e2e-forced-configs-failure" }) });
  });

  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Wait for EITHER settled render — the create box (nothing it can trust) or the orphan panel — so the
  // absence below is a real observation of a settled page, not a vacuous pass against one still loading,
  // and so a regression trips the ASSERTION rather than this anchor. The generous budget covers
  // react-query's own default retries before the query finally reports the error.
  await expect(page.locator('[data-testid="companion-unprovisioned-panel"], button:text-is("Create companion")').first())
    .toBeVisible({ timeout: 25_000 });

  // THE ASSERTION: no orphan row survives a configs read that never answered.
  await expect(page.getByTestId("companion-unprovisioned-panel")).toHaveCount(0);
  await expect(page.getByText("not provisioned", { exact: true })).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Create companion" })).toBeVisible();
  expect(failures, "the configs GET really was failed, repeatedly, by this spec").toBeGreaterThan(0);
  await shoot(page, "ed49cef6-configs-errored.png");
});

// ── The FOCUS rule (review round 1) ───────────────────────────────────────────────────────────────────
// An orphan is a row to TRIAGE, not a conversation to open — it has no chat at all — so it must never take
// the page's default focus off a real companion, however many turns its own session happens to carry.
test("an unprovisioned session with MORE turns does not take the default focus from a real companion", async ({ page, loomDaemon }) => {
  const real = await loomDaemon.seedCompanion({ name: "Primary", ptyGeometry: { cols: 80, rows: 24 } });
  // The id sorts BEFORE `e2e-companion-…`, so the orphan is companions[0]: a focus that merely out-ranked
  // orphans instead of excluding them — or that fell back to the first row — lands here, which is the
  // failure this asserts against.
  const orphanId = `e2e-aaa-orphan-${randomUUID()}`;
  await loomDaemon.seedLiveSession({ role: "assistant", id: orphanId });

  // `ctxTurns` is not settable through the fixture, so overlay it on the shared ["allSessions"] read that
  // the ranking actually consults — the ORPHAN gets far more measured turns than the real companion.
  // Nothing else in the response is touched, and the rows themselves are the daemon's own.
  // A SET of ids, not a counter: this read is a polled query, so a count would just measure how many
  // refetches happened to land before the assertion rather than whether both rows were really there.
  const overlaid = new Set<string>();
  await page.route(`${loomDaemon.baseURL}/api/sessions`, async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as { id: string; ctxTurns?: number | null }[];
    for (const r of rows) {
      if (r.id === orphanId) { r.ctxTurns = 500; overlaid.add(r.id); }
      else if (r.id === real.sessionId) { r.ctxTurns = 1; overlaid.add(r.id); }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
  });

  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Wait for EITHER focus outcome — the orphan's panel, or a real companion's own Chat/Manage/Terminal
  // tabs (each replaces the other) — so the absence below observes a settled page and a regression trips
  // the ASSERTION rather than this anchor.
  await expect(page.locator('[data-testid="companion-unprovisioned-panel"], [role="tablist"][aria-label="Companion view"]').first())
    .toBeVisible();

  // THE ASSERTION: the orphan did NOT take the focus, so its panel is nowhere — the REAL companion's own
  // tabs are what rendered instead.
  await expect(page.getByTestId("companion-unprovisioned-panel")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Companion view" })).toBeVisible();

  // ...and the orphan is excluded from the FOCUS, not from the page: both rows are in the switcher, with
  // the pressed one being the real companion. (An unnamed orphan renders as "Companion <id-prefix>".)
  const picker = page.getByRole("group", { name: "Select companion" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "Primary", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(picker.getByRole("button", { name: /^Companion e2e-/ })).toHaveAttribute("aria-pressed", "false");
  expect([...overlaid].sort(), "both seeded rows were present in the overlaid session list")
    .toEqual([orphanId, real.sessionId].sort());
  await shoot(page, "ed49cef6-focus-real-companion.png");
});
