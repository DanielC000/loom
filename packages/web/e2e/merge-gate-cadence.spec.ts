// Merge-gate CADENCE e2e (card 00664e74) — the gate strip and the cadence panel on the project Settings
// tab, and the failed-gate Attention row on the project Home tab. Both components lived on the classic
// Overview until card acbb6df6 deleted it and re-homed them unchanged (docs/decisions/acbb6df6-*).
//
// WHICH HALF IS SEEDABLE, AND WHICH IS NOT (the discipline from the `gates-active-lane-has-no-e2e-seed-path`
// and `harness-drain-blocked-has-no-e2e-seed-path` project-memory notes: ask which SOURCE a panel reads
// before assuming it is testable):
//   • The Settings CADENCE CONTROL and its persistence read/write the project config override through the
//     ordinary human PATCH, so they are driven FOR REAL here — no mocking at all.
//   • The gate STRIP (and the Home tab's alert) reads GET /api/projects/:id/merge-gate/status, whose interesting states (a mid-count
//     interval, a reached interval, a FAILED periodic gate, a verdict history) are produced only by real
//     merges landing and real gate commands failing. There is no seed path for any of that, and the fixture's
//     no-spawn guard forbids manufacturing one. So those states are driven by `page.route` fulfilment of the
//     real contract shape — the sanctioned substitute — which drives the REAL components with REAL props.
//     WHAT THAT THEREFORE DOES NOT PROVE: that the daemon ever emits these shapes. That half belongs to the
//     daemon card's own tests (6f13746c), not here.
//
// The interval PERSISTENCE test is gated on the daemon actually having the feature: until 6f13746c merges,
// the strict-zod config validator rejects the unknown `mergeGateInterval` key, so that one test SKIPS with an
// explicit reason rather than failing for a reason that is not about the web. It runs for real afterwards.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// The GET /api/projects/:id/merge-gate/status contract (card 6f13746c). `branchTip`/`candidates` are
// OPTIONAL on the wire, so the fixtures below deliberately vary between present, null and absent.
type Verdict = {
  at: string; result: "pass" | "fail" | "cleared"; reason?: string | null; opId?: string | null;
  fromSha?: string | null; toSha?: string | null; branchTip?: string | null; branch?: string | null; candidates?: number;
};
type Status = {
  repoKey?: string | null;
  cadence: "every" | "interval" | "never";
  interval: number | null;
  ungatedSinceLastPass: number;
  nextLandingGated: boolean;
  gateOwed: boolean;
  lastPassAt: string | null;
  lastFailure: { at: string; opId: string | null; fromSha: string | null; toSha: string | null; branchTip?: string | null; branch?: string | null; candidates?: number } | null;
  recent: Verdict[];
};

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const status = (o: Partial<Status> = {}): Status => ({
  cadence: "every", interval: null, ungatedSinceLastPass: 0, nextLandingGated: false,
  gateOwed: false, lastPassAt: iso(134), lastFailure: null, recent: [], ...o,
});

/**
 * Fulfil the status endpoint. Returns a `calls` array so a test can assert the UI actually RE-FETCHED after
 * an action (the contract requires a re-fetch right after a PATCH or gate-next, not just the 15s poll).
 */
async function routeStatus(page: Page, projectId: string, body: () => Status | null) {
  const calls: string[] = [];
  await page.route(`**/api/projects/${projectId}/merge-gate/status`, async (route) => {
    calls.push(route.request().url());
    const b = body();
    if (b === null) { await route.fulfill({ status: 404, json: { error: "not found" } }); return; }
    await route.fulfill({ json: b });
  });
  return calls;
}

const strip = (page: Page) => page.getByTestId("merge-gate-strip");

test.describe("merge-gate strip on the Settings tab + failed-gate alert on the Home tab (cards 00664e74, acbb6df6)", () => {
  test("an older daemon's 404 HIDES the strip instead of erroring", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-404-${Date.now()}`);
    await routeStatus(page, project.id, () => null);
    await pinActiveProject(page, project.id);

    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto(`${loomDaemon.baseURL}/settings`);
    // The page itself renders (identity assertion — we are looking at THIS project's Settings tab, not a
    // blank/errored shell), and the strip is simply absent.
    await expect(page.getByTestId("settings-section-project-settings")).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    // A 404 is an expected outcome for this route, not a failure to report.
    expect(errors.filter((e) => e.includes("merge-gate"))).toEqual([]);
  });

  test("cadence=every reads green and names the gate command", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-every-${Date.now()}`);
    // Give the project a real gate command so the strip's `cmd` chip has something true to show.
    const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/config`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { orchestration: { gateCommand: "pnpm build" } } }),
    });
    expect(res.ok, "seeding gateCommand").toBe(true);

    await routeStatus(page, project.id, () => status({ cadence: "every" }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-badge")).toHaveText("Every merge");
    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("Every merge runs the gate command");
    await expect(strip(page).getByText("pnpm build")).toBeVisible();
    // No counter at this cadence — there is nothing to count toward.
    await expect(strip(page).getByTestId("merge-gate-counter")).toHaveCount(0);
  });

  test("an interval mid-count shows the tick track, the fraction, and the (N+1)th badge", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-count-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 3 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-badge")).toHaveText("Every 6th merge");
    await expect(strip(page).getByTestId("merge-gate-counter")).toContainText("3");
    await expect(strip(page).getByTestId("merge-gate-counter")).toContainText("/ 5 ungated");
    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("2 more merges land ungated");
    // FIXTURE IDENTITY: five ticks, three of them filled — proves the track is driven by THIS fixture's
    // numbers and not a coincidentally-similar default.
    const ticks = strip(page).getByTestId("merge-gate-ticks");
    await expect(ticks).toHaveAttribute("aria-label", "3 of 5 ungated merges used");
    await expect(ticks.locator("> span")).toHaveCount(5);
  });

  test("a large interval degrades the tick track to a meter", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-big-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 20, ungatedSinceLastPass: 13 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-badge")).toHaveText("Every 21st merge");
    await expect(strip(page).getByTestId("merge-gate-counter")).toContainText("/ 20 ungated");
    await expect(strip(page).getByTestId("merge-gate-ticks")).toHaveCount(0);
  });

  test("a reached interval says the next merge is gated and drops the arm button", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-due-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 5, nextLandingGated: true }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("The next merge runs the gate");
    // "Gate the next merge" is meaningless when it is already gated, so it is not offered.
    await expect(strip(page).getByTestId("merge-gate-next")).toHaveCount(0);
  });

  test("cadence=never flags the unverified count as a standing hazard", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-never-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "never", ungatedSinceLastPass: 17 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-badge")).toHaveText("Never gated");
    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("17 merges have landed unverified");
  });

  test("a failed periodic gate escalates into Attention AND carries the bisect range", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-fail-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 5, ungatedSinceLastPass: 5, gateOwed: true, lastPassAt: iso(300),
      lastFailure: { at: iso(14), opId: "op-f", fromSha: "1111111aaa", toSha: "2222222bbb", branchTip: "4e762bafcc", branch: "loom/4e762baf" },
      recent: [
        { at: iso(900), result: "pass", opId: "o1", fromSha: null, toSha: "aaa1111bbb" },
        { at: iso(14), result: "fail", opId: "op-f", fromSha: "1111111aaa", toSha: "2222222bbb", branchTip: "4e762bafcc" },
      ],
    }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByTestId("merge-gate-badge")).toContainText("Gate failed");
    await expect(strip(page).getByText("1111111..2222222")).toBeVisible();
    // The branch NAME renders, not the tip sha, whenever the daemon supplies one.
    await expect(strip(page).getByText("loom/4e762baf")).toBeVisible();
    await expect(strip(page).getByText("4e762bafcc")).toHaveCount(0);
    // The interval fraction is SUPPRESSED here: with the interval suspended it is no longer the number
    // that matters, and showing it beside "gate failed" would imply the cycle is still running.
    await expect(strip(page).getByTestId("merge-gate-counter")).toHaveCount(0);

    // The Settings tab carries the strip ONLY — the alert is the Home tab's (docs/decisions/acbb6df6-*).
    await expect(page.getByTestId("merge-gate-attention")).toHaveCount(0);

    // Direction B's borrowing: the failure ALSO raises an ordinary Attention row — on the project Home
    // tab's "Needs you" card — and the card's count includes it: a row that is not counted reads as a
    // rendering bug. The card's own "nothing needs you" empty state must not sit beside the alert.
    await page.goto(`${loomDaemon.baseURL}/project`);
    const needs = page.getByTestId("atlas-band-needs");
    const row = needs.getByTestId("merge-gate-attention");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Periodic gate failed on loom/4e762baf");
    await expect(row).toContainText("Every merge stays gated until one passes");
    await expect(needs.locator(".loom-bandcount")).toHaveText("1");
    await expect(needs.getByText("Nothing needs you right now.")).toHaveCount(0);
  });

  test("the project Home tab shows the MERGE GATE alert only while a periodic gate is owed (card acbb6df6)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-home-${Date.now()}`);
    // One route, flipped mid-test, so both polarities are read off the SAME page and fixture.
    let failed = false;
    await routeStatus(page, project.id, () => failed
      ? status({
        cadence: "interval", interval: 3, ungatedSinceLastPass: 3, gateOwed: true, lastPassAt: iso(120),
        lastFailure: { at: iso(5), opId: "op-h", fromSha: "5555555aaa", toSha: "6666666bbb", branchTip: "77777777cc", branch: "loom/home-sentinel" },
      })
      : status({ cadence: "interval", interval: 3, ungatedSinceLastPass: 1 }));
    await pinActiveProject(page, project.id);

    // HEALTHY: no alert, the card reads its ordinary empty state, and the count does not include a gate.
    await page.goto(`${loomDaemon.baseURL}/project`);
    const needs = page.getByTestId("atlas-band-needs");
    await expect(needs).toBeVisible();
    await expect(needs.getByText("Nothing needs you right now.")).toBeVisible();
    await expect(page.getByTestId("merge-gate-attention")).toHaveCount(0);
    await expect(needs.locator(".loom-bandcount")).toHaveText("0");

    // FAILED (gateOwed): the alert appears in the same card, counted, naming THIS fixture's branch.
    failed = true;
    await page.reload();
    const row = page.getByTestId("atlas-band-needs").getByTestId("merge-gate-attention");
    await expect(row).toBeVisible();
    await expect(row).toContainText("loom/home-sentinel");
    await expect(page.getByTestId("atlas-band-needs").locator(".loom-bandcount")).toHaveText("1");
    // The kind label the alert row carries — the owner-facing name of this signal.
    await expect(row).toContainText(/merge gate/i);
  });

  test("a batch failure names the candidate count, and a first-ever failure says 'since tracking began'", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-batch-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 5, ungatedSinceLastPass: 9, gateOwed: true, lastPassAt: null,
      // A batch carries no single branch (branchTip null) and no prior pass to anchor fromSha.
      lastFailure: { at: iso(6), opId: "op-b", fromSha: null, toSha: "9999999ccc", branchTip: null, candidates: 4 },
      recent: [],
    }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page).getByText("4 branches")).toBeVisible();
    await expect(strip(page).getByText("since tracking began")).toBeVisible();
    await page.goto(`${loomDaemon.baseURL}/project`);
    await expect(page.getByTestId("merge-gate-attention")).toContainText("since tracking began");
  });

  test("a failure with no branch NAME falls back to the short tip sha", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-tip-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 5, ungatedSinceLastPass: 2, gateOwed: true,
      // branch ABSENT (not merely null) — the older-daemon shape.
      lastFailure: { at: iso(9), opId: "op-t", fromSha: "3333333aaa", toSha: "4444444bbb", branchTip: "abcdef123456" },
    }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    await expect(strip(page).getByText("abcdef1")).toBeVisible();
  });

  test("the editor opens, shows the verdict strip, and a bad interval blocks Save", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-edit-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 5, ungatedSinceLastPass: 3,
      recent: [
        { at: iso(900), result: "pass", opId: "o1", fromSha: "a1a1a1a1a1", toSha: "b1b1b1b1b1" },
        { at: iso(600), result: "fail", opId: "o2", fromSha: "b1b1b1b1b1", toSha: "c1c1c1c1c1" },
        { at: iso(300), result: "pass", opId: "o3", fromSha: "c1c1c1c1c1", toSha: "d1d1d1d1d1" },
      ],
    }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // BEFORE: no editor.
    await expect(page.getByTestId("merge-gate-editor")).toHaveCount(0);
    await page.getByTestId("merge-gate-edit").click();
    // AFTER: the editor is mounted, seeded from the LIVE status (cadence + interval), with the verdict strip.
    const editor = page.getByTestId("merge-gate-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId("merge-gate-interval")).toHaveValue("5");
    await expect(editor.getByTestId("merge-gate-verdicts").locator("> b")).toHaveCount(3);

    // Save is disabled while nothing changed (a no-op save would be a lie about having done something).
    await expect(editor.getByTestId("merge-gate-save")).toBeDisabled();

    // EXERCISE validation: 0 is refused inline, and Save STAYS blocked.
    await editor.getByTestId("merge-gate-interval").fill("0");
    await expect(editor.getByTestId("merge-gate-interval-error")).toContainText("whole number of 1 or more");
    await expect(editor.getByTestId("merge-gate-save")).toBeDisabled();

    // A valid change clears the error and enables Save (observable before/after on BOTH).
    await editor.getByTestId("merge-gate-interval").fill("8");
    await expect(editor.getByTestId("merge-gate-interval-error")).toHaveCount(0);
    await expect(editor.getByTestId("merge-gate-save")).toBeEnabled();

    // Cancel closes it without saving. It lives in the STRIP row, replacing "Change cadence" (mockup A6) —
    // the editor panel below holds only Save, so this is deliberately not scoped to `editor`.
    await expect(strip(page).getByTestId("merge-gate-edit")).toHaveCount(0);
    await strip(page).getByTestId("merge-gate-edit-cancel").click();
    await expect(page.getByTestId("merge-gate-editor")).toHaveCount(0);
  });

  test("no border declaration on the strip is blanked when the editor opens", async ({ page, loomDaemon }) => {
    // REGRESSION, found on a real dev server (card 00664e74). The strip's open/shut styles mixed `border`
    // and `borderRadius` SHORTHANDS with the longhands that flip when the editor opens. React warns about
    // that pair, and the warning is not pedantry: React decomposes the shorthand and then emits the
    // longhands it can no longer resolve with EMPTY values — `border-top-color: ; border-top-style: ;` —
    // so the strip silently loses its top and right borders in both states.
    //
    // This asserts that CONSEQUENCE rather than the console or the source text, for two measured reasons:
    // React's style warning is DEV-ONLY and this harness serves the PRODUCTION build (a console-based
    // version of this test passed against the defective code), and the emitted attribute never contains the
    // literal `border:`/`border-radius:` shorthand to grep for, because React has already expanded it.
    const project = await loomDaemon.createProject(`mg-style-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 2 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // The strip row is the section's FIRST child div; once the editor opens the section holds two, and an
    // unscoped locator is a strict-mode violation that would fail for a reason unrelated to this assertion.
    const stripRowStyle = () => page.locator('[data-testid="merge-gate-strip"] > div').first().getAttribute("style");

    for (const phase of ["shut", "open"] as const) {
      if (phase === "open") {
        await page.getByTestId("merge-gate-edit").click();
        await expect(page.getByTestId("merge-gate-editor")).toBeVisible();
      }
      const style = (await stripRowStyle()) ?? "";
      // Sanity: we are reading a real, populated style attribute, so an empty read can never pass vacuously.
      expect(style, `strip style while ${phase}`).toMatch(/border-bottom-left-radius/);
      const blanked = style
        .split(";")
        .map((d) => d.trim())
        .filter((d) => /^border[a-z-]*:\s*$/.test(d));
      expect(blanked, `blanked border declarations while ${phase}`).toEqual([]);
    }
  });

  test("switching the editor to `never` swaps the amber bisect note for the red one", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-warn-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 1 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    await page.getByTestId("merge-gate-edit").click();
    const editor = page.getByTestId("merge-gate-editor");

    // BEFORE: the amber bisect-cost note, stating THIS interval's number.
    await expect(editor.getByTestId("merge-gate-warn-interval")).toContainText("up to 5 merges reach the default branch");
    await expect(editor.getByTestId("merge-gate-warn-never")).toHaveCount(0);

    await editor.getByTestId("merge-gate-cadence").getByRole("radio", { name: "Never" }).click();

    // AFTER: the red weakening note, and the interval field goes inert.
    await expect(editor.getByTestId("merge-gate-warn-never")).toContainText("No merge will run the gate command");
    await expect(editor.getByTestId("merge-gate-warn-interval")).toHaveCount(0);
    await expect(editor.getByTestId("merge-gate-interval")).toBeDisabled();

    // And `every` clears both notes.
    await editor.getByTestId("merge-gate-cadence").getByRole("radio", { name: "Every merge" }).click();
    await expect(editor.getByTestId("merge-gate-warn-never")).toHaveCount(0);
    await expect(editor.getByTestId("merge-gate-warn-interval")).toHaveCount(0);
  });

  test("'Gate the next merge' POSTs gate-next and re-reads the status", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-next-${Date.now()}`);
    let armed = false;
    const statusCalls = await routeStatus(page, project.id, () =>
      status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 2, gateOwed: armed, nextLandingGated: armed }));

    let posts = 0;
    await page.route(`**/api/projects/${project.id}/merge-gate/gate-next`, async (route) => {
      expect(route.request().method()).toBe("POST");
      posts++; armed = true;
      await route.fulfill({ json: { ok: true } });
    });

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // BEFORE: counting, and the arm button is offered.
    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("3 more merges land ungated");
    const callsBefore = statusCalls.length;

    await strip(page).getByTestId("merge-gate-next").click();

    // AFTER (observable state change, not just "the click happened"): the strip flips to the gated reading,
    // the POST fired exactly once, and the UI re-fetched rather than waiting out the 15s poll.
    await expect(strip(page).getByTestId("merge-gate-sentence")).toContainText("The next merge runs the gate");
    await expect(strip(page).getByTestId("merge-gate-next")).toHaveCount(0);
    expect(posts).toBe(1);
    expect(statusCalls.length).toBeGreaterThan(callsBefore);
  });

  test("a CLEARED entry renders as a neutral mark, never as a pass or a fail", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-cleared-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 5, ungatedSinceLastPass: 4,
      recent: [
        { at: iso(900), result: "pass", opId: "o1", fromSha: "a1a1a1a1a1", toSha: "b1b1b1b1b1" },
        { at: iso(600), result: "fail", opId: "o2", fromSha: "b1b1b1b1b1", toSha: "c1c1c1c1c1" },
        // The wire shape for a clear: {result, at, reason} and nothing else.
        { at: iso(300), result: "cleared", reason: "cadence-changed" },
      ],
    }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    await page.getByTestId("merge-gate-edit").click();

    const marks = strip(page).getByTestId("merge-gate-verdicts").locator("> b");
    await expect(marks).toHaveCount(3);
    // The three kinds are distinguishable, and the cleared one is NEITHER verdict — a cleared entry
    // rendered by a pass/fail branch would assert a red run that never happened.
    await expect(marks.nth(0)).toHaveAttribute("data-verdict", "pass");
    await expect(marks.nth(1)).toHaveAttribute("data-verdict", "fail");
    await expect(marks.nth(2)).toHaveAttribute("data-verdict", "cleared");
    await expect(marks.nth(2)).toHaveAttribute("title", /owed gate cleared by a settings change/);

    // A cleared gate does NOT reset the counter — the strip still reads 4 of 5.
    await expect(strip(page).getByTestId("merge-gate-counter")).toContainText("/ 5 ungated");
  });

  test("a multi-repo project names the repo the strip describes; a single-repo one does not", async ({ page, loomDaemon }) => {
    // SINGLE repo (the default shape): no chip — naming "primary" where there is only one repo is noise.
    const solo = await loomDaemon.createProject(`mg-solo-repo-${Date.now()}`);
    await routeStatus(page, solo.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 1, repoKey: null }));
    await pinActiveProject(page, solo.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    await expect(strip(page)).toBeVisible();
    await expect(strip(page).getByText("repo", { exact: true })).toHaveCount(0);

    // MULTI repo: register a SECOND, real git repo (another seeded project's, which the fixture git-inits)
    // through the same human REST validator production uses, so this is a genuine multi-repo project.
    const donor = await loomDaemon.createProject(`mg-donor-${Date.now()}`);
    const all = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as Array<{ id: string; repoPath: string }>;
    const donorRepo = all.find((p) => p.id === donor.id)!.repoPath;
    const multi = await loomDaemon.createProject(`mg-multi-repo-${Date.now()}`);
    const patched = await fetch(`${loomDaemon.baseURL}/api/projects/${multi.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [{ key: "second", path: donorRepo }] }),
    });
    expect(patched.ok, `registering a second repo: ${patched.status}`).toBe(true);

    await routeStatus(page, multi.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 1, repoKey: "primary" }));
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), multi.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // The strip NAMES its repo, so a counter describing one of several repos never reads as project-wide.
    await expect(strip(page).getByText("primary", { exact: true })).toBeVisible();
  });

  test("the strip does not overflow a narrow 760px window", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-narrow-${Date.now()}`);
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 3 }));
    await pinActiveProject(page, project.id);
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page)).toBeVisible();
    // No horizontal page scroll, and the strip stays inside the viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 760px").toBeLessThanOrEqual(0);
    const box = await strip(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(760);
  });

  // Card acbb6df6: the strip moved from the full-width Overview into the ~800px Settings column. Its wrap
  // breakpoint was a VIEWPORT media query, so at a 1440 window it kept the one-row layout in a column too
  // narrow for it: the sentence shrank to 0px and the buttons ran past the panel's right edge. The section's
  // own box stayed in bounds (its children overflow it, unclipped), which is why the 760px leg above could
  // not see it. This measures the CONTROLS against the strip, in the failed state that carries the most chips.
  test("at a 1440 window every control stays inside the strip and the sentence is readable", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-wide-${Date.now()}`);
    await routeStatus(page, project.id, () => status({
      cadence: "interval", interval: 3, ungatedSinceLastPass: 3, gateOwed: true, lastPassAt: iso(120),
      lastFailure: { at: iso(5), opId: "op-w", fromSha: "1111111aaa", toSha: "2222222bbb", branchTip: "33333333cc", branch: "loom/wide-sentinel", candidates: 3 },
    }));
    await pinActiveProject(page, project.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await expect(strip(page)).toBeVisible();
    // Identity: THIS fixture's failure is what the strip is drawing.
    await expect(strip(page)).toContainText("1111111..2222222");
    const right = (await strip(page).boundingBox())!;
    for (const id of ["merge-gate-open-log", "merge-gate-edit", "merge-gate-badge"]) {
      const b = (await strip(page).getByTestId(id).boundingBox())!;
      expect(b.x + b.width, `${id} right edge inside the strip`).toBeLessThanOrEqual(right.x + right.width + 0.5);
    }
    const sentence = (await strip(page).getByTestId("merge-gate-sentence").boundingBox())!;
    expect(sentence.width, "the sentence is not squeezed to nothing").toBeGreaterThan(200);
  });
});

test.describe("Settings merge-gate cadence panel (card 00664e74)", () => {
  const readOverride = async (baseURL: string, projectId: string) => {
    const res = await fetch(`${baseURL}/api/projects`);
    const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { mergeGate?: string; mergeGateInterval?: number } } }>;
    const orch = projects.find((p) => p.id === projectId)?.config?.orchestration;
    return { mergeGate: orch?.mergeGate ?? null, mergeGateInterval: orch?.mergeGateInterval ?? null };
  };

  test("the three-valued cadence control replaces the on/off checkbox and drives the interval field", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-set-ui-${Date.now()}`);
    // The panel's LIVE counter row needs the status endpoint, which this daemon does not serve yet — and
    // the live row is where the "what actually clears this counter" copy lives. Fulfil it so that half of
    // the panel is exercised rather than sitting in its unavailable state.
    await routeStatus(page, project.id, () => status({ cadence: "interval", interval: 5, ungatedSinceLastPass: 3 }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const panel = page.getByTestId("merge-gate-panel");
    await expect(panel).toBeVisible();
    // The old binary checkbox is gone — a checkbox cannot express three cadences.
    await expect(page.getByTestId("merge-gate-off")).toHaveCount(0);

    const seg = panel.getByTestId("merge-gate-cadence");
    const field = panel.getByTestId("merge-gate-interval");
    // BEFORE: a fresh project inherits `every`; the field is present but inert (never removed, so the
    // control never looks like it lost a feature).
    await expect(seg.getByRole("radio", { name: "Every merge" })).toHaveAttribute("aria-checked", "true");
    await expect(field).toBeDisabled();
    await expect(panel.getByTestId("merge-gate-warn-interval")).toHaveCount(0);

    // AFTER: `every Nth` enables the field. The bisect-cost note stays away until there is a real N to
    // state a cost about — an empty field must not produce "up to 0 merges reach the default branch".
    await seg.getByRole("radio", { name: "Every Nth merge" }).click();
    await expect(seg.getByRole("radio", { name: "Every Nth merge" })).toHaveAttribute("aria-checked", "true");
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue("");
    await expect(panel.getByTestId("merge-gate-warn-interval")).toHaveCount(0);

    // There is deliberately NO "reset counter" control — zeroing the unverified-merges figure by hand
    // would make it lie, since only a passing gate actually verifies anything. The panel says what DOES
    // clear it instead, so the absence reads as a decision rather than a missing feature.
    await expect(panel.getByRole("button", { name: /reset/i })).toHaveCount(0);
    await expect(panel.getByTestId("merge-gate-live")).toContainText("resets on the next passing gate");

    // Typing a real interval is what raises the note, and it quotes THAT number.
    await field.fill("5");
    await expect(panel.getByTestId("merge-gate-warn-interval")).toContainText("up to 5 merges");

    // An invalid value withdraws the cost claim rather than restating it as 0.
    await field.fill("0");
    await expect(panel.getByTestId("merge-gate-interval-error")).toBeVisible();
    await expect(panel.getByTestId("merge-gate-warn-interval")).toHaveCount(0);
  });

  test("an out-of-range interval blocks the project Save, naming the reason", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-set-val-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const panel = page.getByTestId("merge-gate-panel");
    await panel.getByTestId("merge-gate-cadence").getByRole("radio", { name: "Every Nth merge" }).click();
    await panel.getByTestId("merge-gate-interval").fill("5");

    const save = page.getByRole("button", { name: "Save", exact: true }).first();
    await expect(save).toBeEnabled();

    // AFTER: 0 is refused, Save goes disabled, and the blocking reason is on the page (not just the field).
    await panel.getByTestId("merge-gate-interval").fill("0");
    await expect(panel.getByTestId("merge-gate-interval-error")).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(page.getByRole("alert").filter({ hasText: "whole number of 1 or more" }).first()).toBeVisible();

    // And it recovers: a legal value re-enables Save.
    await panel.getByTestId("merge-gate-interval").fill("1000");
    await expect(panel.getByTestId("merge-gate-interval-error")).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  test("choosing `never` persists mergeGate:off, and `every merge` clears the key", async ({ page, loomDaemon }) => {
    // Uses ONLY the pre-existing mergeGate key, so this runs for real against any daemon.
    const project = await loomDaemon.createProject(`mg-set-never-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const seg = page.getByTestId("merge-gate-panel").getByTestId("merge-gate-cadence");
    await seg.getByRole("radio", { name: "Never" }).click();
    await expect(page.getByTestId("merge-gate-warn-never")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).first().click();

    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id)).toEqual({ mergeGate: "off", mergeGateInterval: null });

    // A reload re-seeds the control from the PERSISTED override, not optimistic client state.
    await page.reload();
    await expect(page.getByTestId("merge-gate-panel").getByTestId("merge-gate-cadence").getByRole("radio", { name: "Never" }))
      .toHaveAttribute("aria-checked", "true");

    // Back to `every`: the override key is REMOVED (inherits the default), never stored as "on".
    await page.getByTestId("merge-gate-panel").getByTestId("merge-gate-cadence").getByRole("radio", { name: "Every merge" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id)).toEqual({ mergeGate: null, mergeGateInterval: null });
  });

  test("choosing `every Nth` persists BOTH keys, and switching away clears the interval", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`mg-set-interval-${Date.now()}`);

    // CAPABILITY GATE: the config validator is strict zod, so a daemon that predates card 6f13746c 400s on
    // the unknown `mergeGateInterval` key. Probing the feature's own status route is the honest check —
    // skipping is correct here, because a failure would be about the DAEMON not having landed, not the web.
    const probe = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/merge-gate/status`);
    test.skip(probe.status === 404, "daemon predates card 6f13746c: no merge-gate routes, so mergeGateInterval is not yet an accepted config key");

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const panel = page.getByTestId("merge-gate-panel");
    await panel.getByTestId("merge-gate-cadence").getByRole("radio", { name: "Every Nth merge" }).click();
    await panel.getByTestId("merge-gate-interval").fill("5");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();

    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id)).toEqual({ mergeGate: "off", mergeGateInterval: 5 });

    await page.reload();
    await expect(page.getByTestId("merge-gate-panel").getByTestId("merge-gate-interval")).toHaveValue("5");

    // Switching to `never` must CLEAR the interval, not leave a stale one behind the scenes.
    await page.getByTestId("merge-gate-panel").getByTestId("merge-gate-cadence").getByRole("radio", { name: "Never" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id)).toEqual({ mergeGate: "off", mergeGateInterval: null });
  });
});
