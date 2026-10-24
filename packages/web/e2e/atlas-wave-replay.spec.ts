// Atlas — wave replay + the inactive-projects tier on the Workspace node's Replay tab (card ff6123de,
// epic 9fe8cd4e). Decisions: docs/decisions/ff6123de-atlas-wave-replay-workspace-node.md.
//
// Card 5afd71bd retires Mission Control as an Atlas destination, and it was blocked on these two: a
// forensic wave scrubber/diff, and the finished-wave tier fed by GET /api/archived-sessions, neither of
// which had any Atlas mount at all. They now live on the Workspace node's own trailing `replay` tab.
//
// ⭐ EVERY ON LEG ASSERTS A BEFORE AND AN AFTER. "The panel rendered" is not the claim the card makes —
// the claim is that the scrubber MOVES the timeline and that selecting another wave CHANGES it, so each
// is read twice with the act in between.
//
// ⚠️ The Workspace node's tab row folds into a "More ⋯" menu once a tab carrying the KPI strip is
// selected (card d4350286), and `replay` is the LAST tab in the row — so it is reached through
// helpers/nodeTabs.ts. `getByTestId("atlas-tab-replay")` alone is not a complete way to reach it and
// fails with a timeout that reads like a missing feature.
//
// ⚠️ FIXTURE IDENTITY, not ambient readings: this daemon is shared across the specs in its worker, so
// every count below is scoped to a project THIS spec created and names. The inactive tier in particular
// is derived from a DAEMON-GLOBAL archived page, where a sibling spec's exited sessions genuinely appear.
import { expect, test, type Locator, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";
import { expectTimestampInsideRow, FIT_CHECK_KINDS } from "./helpers/replayRow";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only, so a spec cannot pull `src/` in.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

/** The Replay tab's address — a `?tab=` on the Workspace node's own path (card 41eab0eb's shape). */
const REPLAY_TAB_URL = "/home?tab=replay";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

// ── The surfaces under test ────────────────────────────────────────────────────────────────────
const replayBody = (page: Page) => page.getByTestId("atlas-replay");
const waveSection = (page: Page) => page.getByTestId("atlas-replay-wave");
const inactiveSection = (page: Page) => page.getByTestId("atlas-replay-inactive");
/** The scrub head's `N/M` readout — the cheapest observable that the scrubber moved. */
const position = (scope: Locator) => scope.getByTestId("audit-replay-position");
const eventRows = (scope: Locator) => scope.getByTestId("audit-replay-event");
/** The subject picker. FIRST combobox in the panel; the second is the `compare run…` select. */
const subjectPicker = (scope: Locator) => scope.getByRole("combobox").first();

/** Land on the Replay tab by CLICKING the tab, so the affordance that gets a reader here is exercised. */
async function openReplayTab(page: Page, baseURL: string) {
  await page.goto(baseURL + "/home");
  await openNodeTab(page, "replay");
  await expect(page, "the Replay tab is not an address on the Workspace node")
    .toHaveURL(new RegExp(`${REPLAY_TAB_URL.replace("?", "\\?")}$`));
  await expect(replayBody(page), "the Replay tab rendered no body").toHaveCount(1);
}

/**
 * Seed N orchestration events onto one manager's wave. Serial on purpose: the audit timeline's `seq` is
 * positional over an `ordered` read, so a spec that cares about the COUNT must not race the inserts.
 */
async function seedWave(loomDaemon: { seedOrchestrationEvent: (e: { managerSessionId: string; kind: string; detail?: Record<string, unknown> }) => Promise<string> },
  managerSessionId: string, kinds: string[]) {
  for (const kind of kinds) await loomDaemon.seedOrchestrationEvent({ managerSessionId, kind });
}

test.describe("Atlas wave replay on the Workspace node (card ff6123de)", () => {
  test("switch ON: the scrubber moves the timeline, and selecting another wave changes it",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const project = await loomDaemon.createProject(`atlas-replay-${Date.now()}`);
      // TWO waves of DIFFERENT lengths, so "selecting another wave changed the timeline" is a reading of
      // a number this spec chose rather than of whatever the panel happened to be showing.
      const wideMgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "WideWave" });
      const thinMgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "ThinWave" });
      await seedWave(loomDaemon, wideMgr.sessionId,
        ["merge_request", "merge_done", "worker_report", "idle_report", "recycle_complete"]);
      await seedWave(loomDaemon, thinMgr.sessionId, ["merge_request", "merge_done"]);
      await pinProject(page, project.id);
      await seedAtlasOn(page);

      await openReplayTab(page, loomDaemon.baseURL);
      const wave = waveSection(page);

      // FIXTURE IDENTITY — both of THIS project's managers are selectable subjects. Scoped by the unique
      // project name, so archived managers left by sibling specs on the shared daemon cannot skew it.
      await expect(subjectPicker(wave).locator("option", { hasText: `${project.name} · mgr` }),
        "the picker does not offer this spec's own two waves").toHaveCount(2);

      // Select EXPLICITLY rather than trusting the default subject: both managers are live, so which one
      // `replayRoots` ranks first is a recency tiebreak between two rows seeded milliseconds apart.
      await subjectPicker(wave).selectOption(wideMgr.sessionId);
      await expect(position(wave), "the 5-event wave's timeline never loaded").toHaveText("5/5");

      // ── BEFORE the scrub: parked at the live edge. Every event is played, nothing is dimmed. ──
      await expect(eventRows(wave), "the 5 seeded events are not all rendered").toHaveCount(5);
      await expect(wave.locator('[data-replay-state="future"]'),
        "events are already dimmed as un-played before anything scrubbed").toHaveCount(0);
      await expect(wave.locator('[data-replay-state="current"]'),
        "no single event is the scrub head").toHaveCount(1);
      // The live-edge escape appears only once you have LEFT the live edge, so its absence here is half
      // of a before/after pair rather than a bare negative.
      const liveEdge = wave.getByRole("button", { name: /live/ });
      await expect(liveEdge, "the jump-to-live-edge control is offered while already at the live edge")
        .toHaveCount(0);

      // ── THE ACT: step the scrub head back one event. ──
      await wave.getByTitle("Step back").click();

      // ── AFTER: the readout moved, the stream re-staged around the new head, and the escape appeared. ──
      await expect(position(wave), "stepping back did not move the scrub head").toHaveText("4/5");
      await expect(wave.locator('[data-replay-state="future"]'),
        "the event after the scrub head is not dimmed as un-played — the stream did not re-stage")
        .toHaveCount(1);
      await expect(wave.locator('[data-replay-state="current"]'),
        "the scrub head is no longer exactly one event").toHaveCount(1);
      await expect(liveEdge, "scrubbing away from the live edge offered no way back to it").toHaveCount(1);
      // Still FIVE rows: a scrub re-stages the stream, it does not truncate it. Without this, "4/5" would
      // also be satisfied by a panel that had simply dropped an event.
      await expect(eventRows(wave), "the scrub dropped an event instead of re-staging the stream")
        .toHaveCount(5);

      // ── THE SECOND ACT: select the OTHER wave. ──
      await subjectPicker(wave).selectOption(thinMgr.sessionId);
      await expect(position(wave), "selecting the 2-event wave did not change the timeline")
        .toHaveText("2/2");
      await expect(eventRows(wave), "the stream still shows the previous wave's events").toHaveCount(2);
      // And the scrub reset with the subject — a position carried across subjects points at an event
      // that is not in the new timeline.
      await expect(liveEdge, "the scrub position survived a subject change").toHaveCount(0);
    });

  test("switch ON: the inactive tier lists a finished-wave project, and its entry does what Mission Control's did",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      // A project whose WHOLE wave has exited — the tier's own subject.
      const dead = await loomDaemon.createProject(`atlas-replay-dead-${Date.now()}`);
      const deadMgr = await loomDaemon.seedLiveSession({ project: dead, role: "manager", agentName: "DeadMgr" });
      const deadWorker = await loomDaemon.seedLiveSession({
        project: dead, role: "worker", agentName: "DeadWorker", parentSessionId: deadMgr.sessionId,
      });
      // A project that stays LIVE, never archived. It is the positive control for the absence below: a
      // tier that listed every project, or listed none, would both satisfy "the live one is not here".
      const alive = await loomDaemon.createProject(`atlas-replay-alive-${Date.now()}`);
      const aliveMgr = await loomDaemon.seedLiveSession({ project: alive, role: "manager", agentName: "AliveMgr" });
      await pinProject(page, alive.id);

      await fetch(`${loomDaemon.baseURL}/internal/test/seed`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveSessions: [deadMgr.sessionId, deadWorker.sessionId] }),
      });

      // ── MISSION CONTROL FIRST, with the switch still OFF. Measured, not assumed: the card's DoD says
      //    the Atlas entry must navigate "where Mission Control's did", and that destination turns out to
      //    be NOWHERE — a muted card's expand is a no-op and the card holds no link. Reading it here is
      //    what makes the comparison below a measurement instead of a guess.
      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(".loom-rail"), "the classic shell did not render").toBeVisible();
      const mcStrip = page.getByTestId("inactive-fleet");
      await expect(mcStrip, "Mission Control lost its inactive-projects strip").toHaveCount(1);
      // Collapsed on Mission Control — the strip sits under the live fleet grid there, so it must not
      // push it off the fold. That is the `defaultOpen`-off half of the shared component's contract.
      await expect(mcStrip, "Mission Control's inactive strip is no longer collapsed on mount")
        .toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("inactive-fleet-list"),
        "Mission Control's inactive strip rendered its cards before being opened").toHaveCount(0);
      await mcStrip.click();
      const mcCard = cardFor(page.getByTestId("inactive-fleet-list"), dead.name);
      await expect(mcCard, "Mission Control's inactive strip does not list the finished-wave project")
        .toHaveCount(1);
      const mcSurface = await entrySurface(mcCard);
      // POSITIVE CONTROL on the href half, on the same page at the same moment. Scoped to `body`, NOT
      // `main`: measured here, Mission Control's whole <main> carries ZERO anchors — every affordance on
      // it is a button or a programmatic navigate() — so a main-scoped control would itself come back
      // empty and prove nothing. The rail's links are outside <main>, which is why body is the scope.
      expect(await hrefsIn(page.locator("body")),
        "the href collector found no links anywhere on Mission Control, so the card's empty list proves nothing")
        .not.toHaveLength(0);
      // POSITIVE CONTROL on the CARD-scoped collector itself: it resolved a real element and read a real
      // control off it, so the empty href list beside it is an absence rather than a missed card.
      expect(mcSurface.buttons,
        "the card-scoped collector read no control at all, so its empty href list proves nothing")
        .not.toHaveLength(0);

      // ── NOW THE ATLAS SIDE. ──
      await seedAtlasOn(page);
      await openReplayTab(page, loomDaemon.baseURL);
      const section = inactiveSection(page);
      const strip = section.getByTestId("inactive-fleet");
      await expect(strip, "the Replay tab has no inactive-projects tier").toHaveCount(1);
      // OPEN by default here, unlike Mission Control: nothing sits above it on a tab a reader navigated
      // to deliberately, so the collapse that protects MC's live fleet is pure friction.
      await expect(strip, "the Replay tab's inactive tier is collapsed, so its content needs a second click")
        .toHaveAttribute("aria-expanded", "true");
      const list = section.getByTestId("inactive-fleet-list");
      await expect(list, "the Replay tab's inactive tier rendered no card list").toHaveCount(1);

      const atlasCard = cardFor(list, dead.name);
      await expect(atlasCard, "the finished-wave project is not listed on the Workspace node — it is now unreachable")
        .toHaveCount(1);
      // It carries the project's archived HISTORY, which is the thing the Atlas project grid does not:
      // two exited sessions, named as archived.
      await expect(atlasCard, "the inactive card does not report the archived sessions it is made of")
        .toContainText("archived 2");
      // The live project is NOT in the tier, and the card above is the positive control for that absence.
      await expect(cardFor(list, alive.name),
        "a project with a live session is listed as inactive").toHaveCount(0);
      expect(aliveMgr.sessionId, "the live manager was never seeded").toBeTruthy();

      // ⭐ THE EQUIVALENCE, both sides MEASURED rather than assumed. The card's DoD asks that the entry
      // "navigate where Mission Control's did", and the measurement above says that destination is
      // NOWHERE: a muted FleetCard holds no link, and its one control is an inert Expand. So the claim
      // is an equality of the whole interactive surface — links AND controls — which is falsifiable in
      // both directions: an added link or a lost Expand on this side both break it.
      expect(await entrySurface(atlasCard),
        "the Atlas inactive entry's links/controls differ from Mission Control's").toEqual(mcSurface);
      // POSITIVE CONTROL on the href half here too — and on THIS surface `main` is the right scope,
      // because the Atlas content column genuinely does carry anchors (tab links, band exits).
      expect(await hrefsIn(page.locator("main")),
        "the href collector found no links in the Atlas content column, so the equality above proves nothing")
        .not.toHaveLength(0);
      // And the expand control is inert on this side too — clicking it leaves the reader on the Replay
      // tab rather than navigating. Asserted through a POSITIVE observable (the panel is still here),
      // not a bare "the URL did not change", which a pending navigation would also satisfy.
      await atlasCard.getByRole("button").click();
      await expect(replayBody(page), "expanding an inactive card navigated off the Replay tab")
        .toHaveCount(1);
      await expect(page).toHaveURL(new RegExp(`${REPLAY_TAB_URL.replace("?", "\\?")}$`));
    });

  test("switch ON: the Workspace Pulse band carries the cross-project activity cap, not the old 40",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const project = await loomDaemon.createProject(`atlas-pulse-cap-${Date.now()}`);
      const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "PulseMgr" });
      // 45 events: MORE than the 40 this band used to slice to, and fewer than the 100 it now shares with
      // Mission Control's own Activity column. So the reading below is only reachable after the raise —
      // under the old cap the WHOLE band held 40 rows, from every project, which cannot cover 41 of mine.
      const SEEDED = 45;
      await seedWave(loomDaemon, mgr.sessionId, Array.from({ length: SEEDED }, () => "merge_done"));
      await pinProject(page, project.id);
      await seedAtlasOn(page);

      await page.goto(loomDaemon.baseURL + "/home");
      const pulse = page.getByTestId("atlas-band-pulse");
      await expect(pulse, "the Workspace node's Pulse band is gone").toBeVisible();
      // Scoped to THIS project's own rows: the band interleaves every live manager on a shared daemon, so
      // each row carries its owning project as a `title`-bearing chip and that is the identity to count.
      // A FLOOR, not an equality — a sibling spec's live manager legitimately adds rows above mine.
      await expect.poll(async () => pulse.locator(`[title="${project.name}"]`).count(), {
        message: `the Pulse band never rendered more than 40 of this project's ${SEEDED} events — the band is still capped at 40`,
        timeout: 20_000,
      }).toBeGreaterThanOrEqual(41);
      // And the band is still a BAND: one fixed-height panel owning its own scroll, not a column that
      // grew to fit 45 rows. The raise was meant to change scroll depth, not layout.
      const box = await pulse.boundingBox();
      expect(box, "the Pulse band has no box").not.toBeNull();
      expect(box!.height, `the Pulse band grew to ${box!.height}px to fit its rows`).toBeLessThan(420);
    });

  test("switch ON: the Replay tab is mounted only once visited, and never unmounted after",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const archivedPolls: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("/api/archived-sessions")) archivedPolls.push(req.url());
      });

      const project = await loomDaemon.createProject(`atlas-replay-lazy-${Date.now()}`);
      const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "LazyMgr" });
      await seedWave(loomDaemon, mgr.sessionId, ["merge_request", "merge_done", "worker_report"]);
      await pinProject(page, project.id);
      await seedAtlasOn(page);

      // ── NOT MOUNTED, AND NOT PAYING FOR IT. The default Atlas landing is Overview; the Replay tab's two
      //    300-row archived pages are exactly what it must not fetch for a tab nobody opened.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
      await expect(page.getByTestId("atlas-tabpanel-replay"),
        "the Replay panel is mounted on a tab nobody has opened").toHaveCount(0);
      await expect(page.getByTestId("atlas-band-pulse"),
        "the Overview tab never finished rendering, so the absence above proves nothing").toBeVisible();
      expect(archivedPolls,
        "the default Atlas landing fetched an archived-sessions page for a tab nobody opened")
        .toHaveLength(0);

      // ── VISITED: mounted, and only now does it read the archive. ──
      await openNodeTab(page, "replay");
      await expect(page.getByTestId("atlas-tabpanel-replay")).toBeVisible();
      await expect.poll(() => archivedPolls.length, {
        message: "opening the Replay tab never fetched the archived pages its two sections are derived from",
      }).toBeGreaterThan(0);

      // Leave the scrub somewhere that is NOT the default, so what survives below is a real position and
      // not the state a freshly-mounted panel would have had anyway.
      const wave = waveSection(page);
      await expect(position(wave), "the seeded wave's timeline never loaded").toHaveText("3/3");
      await wave.getByTitle("Step back").click();
      await expect(position(wave)).toHaveText("2/3");

      // ── A TAB SWITCH IS NOT CONSENT TO DISCARD IT. Hidden rather than destroyed, asserted both ways:
      //    "not visible" is equally true of a panel that was unmounted outright.
      await openNodeTab(page, "overview");
      await expect(page.getByTestId("atlas-tabpanel-replay"),
        "the Replay panel was unmounted by a tab switch").toHaveCount(1);
      await expect(page.getByTestId("atlas-tabpanel-replay"),
        "the inactive Replay panel is still visible").toBeHidden();
      await expect(page.getByTestId("atlas-tabpanel-replay")).toHaveAttribute("hidden", /.*/);
      expect(await page.getByTestId("atlas-tabpanel-replay").evaluate((el) =>
        (el as HTMLElement).style.display), "the panel wrapper carries an inline display").toBe("");

      // ── AND BACK: the scrub position is still where the reader left it. ──
      await openNodeTab(page, "replay");
      await expect(position(waveSection(page)),
        "the scrub position did not survive a tab round trip — a forensic position was discarded by a tab click")
        .toHaveText("2/3");

      // NEGATIVE CONTROL for that survival claim: a tab the reader never opened still has no panel, so
      // the claim is not simply "every panel is always mounted".
      await expect(page.getByTestId("atlas-tabpanel-automation"),
        "an unvisited panel is mounted after all, so the survival claim above proves nothing").toHaveCount(0);
    });

  test("switch ON: at 420px the event row keeps its timestamp inside the row, and 1440 is unchanged (card f51d3068)",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const project = await loomDaemon.createProject(`atlas-replay-fit-${Date.now()}`);
      const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "FitMgr" });
      await seedWave(loomDaemon, mgr.sessionId, FIT_CHECK_KINDS);
      await pinProject(page, project.id);
      await seedAtlasOn(page);

      // 1440 FIRST, as the control. The row was already correct there, so this leg is what distinguishes
      // "the narrow case was fixed" from "the row was rebuilt and desktop happened to survive" — and it
      // is the leg that catches a future fix that buys 420 by spending the desktop layout.
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(loomDaemon.baseURL + "/home");
        await openNodeTab(page, "replay");
        const wave = waveSection(page);
        await expect(position(wave), `the seeded wave's timeline never loaded at ${width}px`)
          .toHaveText(`${FIT_CHECK_KINDS.length}/${FIT_CHECK_KINDS.length}`);
        await expectTimestampInsideRow(wave, FIT_CHECK_KINDS.length, `Atlas Replay tab @${width}px`);
      }
    });

  test("switch OFF: Mission Control keeps both surfaces, and the Replay tab's address renders nothing",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const dead = await loomDaemon.createProject(`atlas-replay-off-${Date.now()}`);
      const deadMgr = await loomDaemon.seedLiveSession({ project: dead, role: "manager", agentName: "OffMgr" });
      await loomDaemon.seedOrchestrationEvent({ managerSessionId: deadMgr.sessionId, kind: "merge_done" });
      await fetch(`${loomDaemon.baseURL}/internal/test/seed`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveSessions: [deadMgr.sessionId] }),
      });
      // No seedAtlasOn: OFF is the default.

      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(".loom-rail"), "the classic shell did not render").toBeVisible();
      await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

      // Wave replay is still Mission Control's own collapsed section, with its own toggle — unchanged by
      // the component being shared with an Atlas mount. (The gated-poll half of that contract is
      // mission-control-wave-replay.spec.ts's claim, not re-made here.)
      const toggle = page.locator("main").getByRole("button", { name: /Wave replay/i });
      await expect(toggle, "Mission Control lost its Wave replay section").toBeVisible();
      await expect(toggle, "Mission Control's Wave replay is no longer collapsed by default")
        .toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("audit-replay"),
        "Mission Control mounted the replay panel while its section was collapsed").toHaveCount(0);
      await toggle.click();
      await expect(page.getByTestId("audit-replay"),
        "expanding Mission Control's Wave replay mounted no panel").toHaveCount(1);

      // And the inactive tier is still there, still collapsed, under the fleet.
      const strip = page.getByTestId("inactive-fleet");
      await expect(strip, "Mission Control lost its inactive-projects strip").toHaveCount(1);
      await expect(strip).toHaveAttribute("aria-expanded", "false");
      await strip.click();
      await expect(cardFor(page.getByTestId("inactive-fleet-list"), dead.name),
        "Mission Control's inactive strip no longer lists a finished-wave project").toHaveCount(1);

      // The Replay tab is an Atlas-only reading of an Atlas-only node: LegacyShell mounts no ATLAS_HOMES
      // route, so under the classic shell its address renders nothing rather than a second replay surface.
      await page.goto(loomDaemon.baseURL + REPLAY_TAB_URL);
      await expect(page.locator(".loom-rail")).toBeVisible();
      await expect(page.locator("main"),
        "the Atlas-only Replay tab address rendered something under the classic shell").toBeEmpty();
      await expect(page.locator("[class*='loom-atlas']"),
        "the Replay tab's address mounted an Atlas element with the switch off").toHaveCount(0);
    });
});

// ── Shared readers ────────────────────────────────────────────────────────────────────────────

/**
 * The inactive tier's card for one project. The shared `FleetCard` carries no test id of its own, so the
 * card is addressed structurally: a direct `div` child of the strip's grid (the `+N more inactive`
 * overflow note is a span, so it is excluded) holding the project's name as EXACT text. Exact, not
 * `hasText`: that is a substring match, and two seeded projects in one leg share a name prefix.
 */
function cardFor(list: Locator, projectName: string): Locator {
  return list.locator("> div").filter({ has: list.page().getByText(projectName, { exact: true }) });
}

/** Every link inside a scope, as pathnames — the measurable form of "where does this entry go". */
async function hrefsIn(scope: Locator): Promise<string[]> {
  return scope.locator("a[href]").evaluateAll((els) =>
    els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
}

/**
 * One entry's whole INTERACTIVE surface: where it can take you, and what it offers. Both halves are
 * needed for the cross-surface equality — on their own, "no links" is satisfied by a card that rendered
 * nothing, and "one Expand control" is satisfied by a card that also grew a link.
 *
 * Controls are read by `title` first: a FleetCard's Expand is a glyph (`⤢`), so its text content is not
 * a name a reader or a diff can interpret.
 */
async function entrySurface(card: Locator): Promise<{ hrefs: string[]; buttons: string[] }> {
  return {
    hrefs: await hrefsIn(card),
    buttons: await card.locator("button").evaluateAll((els) =>
      els.map((el) => (el.getAttribute("title") || el.textContent || "").trim())),
  };
}
