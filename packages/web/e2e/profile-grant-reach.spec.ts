// Profile grant BLAST RADIUS spec (card 3c4e0df6) — proves the Profiles editor refuses to widen a trust
// boundary silently.
//
// Profiles are GLOBAL. A human-only grant added to one reaches every agent already bound to it, in every
// project, on their next session. Before this card the human got no signal at all. This spec exercises the
// confirm as an INTERACTIVE control with an observable before/after on each branch — a render-only check
// would not distinguish "the panel drew" from "Cancel actually withheld the save":
//   1. Adding a grant with an agent bound opens the confirm, naming the agent and its project.
//   2. CANCEL leaves the stored profile UNCHANGED (REST read-back) — the grant did not land.
//   3. SAVE applies it, and the daemon files the `profile_grant_reach` audit event.
//   4. NEGATIVE CONTROL: a grant-free edit (description only) saves straight through with NO confirm.
//   5. FAIL-CLOSED: with the agents request ABORTED, the confirm STILL appears — and never claims zero.
//
// (5) is the load-bearing one and the reason this spec exists alongside the unit test. The planner is
// pure, so a unit test supplies its own inputs and can never be wrong about WHEN the caller sampled them
// (the 654869e2 lesson). Route-abort is the only way to hold the UI in the unresolved state for real and
// prove `isSuccess ? data : null` is what Profiles.tsx actually passes, rather than `data ?? []`.
//
// Builds on the shared `loomDaemon` fixture; profiles-agents.spec.ts is the template. Seeds its OWN
// uniquely-named profile + agent over REST and never touches a BUNDLED profile, so the shared store stays
// clean. The fixture is worker-scoped (other specs' profiles/agents coexist), so every assertion addresses
// rows by unique name/id, never by list position.
import { expect, test } from "./fixtures/daemon";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededProfile { id: string; name: string; description: string; browserTesting?: boolean }
interface SeededAgent { id: string; projectId: string; name: string; profileId: string | null }
interface ReachEvent { kind: string; detail?: { profileId?: string; agentCount?: number; addedKeys?: string[]; source?: string } }

const seedProfile = (baseURL: string, name: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify({ name }) });

const getProfile = (baseURL: string, id: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles/${encodeURIComponent(id)}`);

const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<SeededAgent>(`${baseURL}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });

const bindAgent = (baseURL: string, agentId: string, profileId: string) =>
  apiJson<SeededAgent>(`${baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ profileId }) });

const reachEventsFor = async (baseURL: string, profileId: string) => {
  const rows = await apiJson<ReachEvent[]>(`${baseURL}/api/orchestration/events?kinds=profile_grant_reach`);
  return rows.filter((e) => e.detail?.profileId === profileId);
};

/** Seed a profile with ONE agent bound to it, and assert that fixture identity before the test proceeds —
 *  so a confirm that renders can only be about THIS profile's own reach, never a sibling spec's data. */
async function seedBoundRig(baseURL: string, label: string, createProject: (n: string) => Promise<{ id: string; name: string }>) {
  const profile = await seedProfile(baseURL, `Grant Reach ${label} ${Date.now()}`);
  const project = await createProject(`grant-reach-${label}-${Date.now()}`);
  const agent = await seedAgent(baseURL, project.id, `Bound Agent ${label}`);
  const bound = await bindAgent(baseURL, agent.id, profile.id);
  expect(bound.profileId).toBe(profile.id);          // the binding this card's whole computation keys off
  expect(profile.browserTesting ?? false).toBe(false); // and the grant under test is genuinely absent first
  return { profile, project, agent };
}

const openProfile = async (page: import("@playwright/test").Page, baseURL: string, name: string) => {
  await page.goto(`${baseURL}/actors`);
  await page.getByRole("button").filter({ hasText: name }).first().click();
};

const browserToggle = (page: import("@playwright/test").Page) =>
  page.locator("label", { hasText: "Browser testing" }).locator('input[type="checkbox"]');

/** Navigate IN-APP via the rail — a page.goto would build a fresh QueryClient and drop the very cache
 *  these tests exist to exercise.
 *
 *  Then COLLAPSE the rail. It expands on `:hover` AND `:focus-within` (styles/global.css), so clicking
 *  a nav link leaves it open on BOTH counts, overlaying the main column and intercepting the next
 *  click — which surfaces as a timeout on an unrelated locator, nothing like a cache bug. Moving the
 *  pointer alone is not enough: the clicked link still holds focus. */
async function railTo(page: import("@playwright/test").Page, label: string) {
  await page.getByRole("link", { name: label, exact: true }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(900, 400);
}

test.describe("profile grant blast radius", () => {
  test("Cancel withholds the grant; Save applies it and files the audit event", async ({ page, loomDaemon }) => {
    const { profile, project, agent } = await seedBoundRig(loomDaemon.baseURL, "main", (n) => loomDaemon.createProject(n));

    await openProfile(page, loomDaemon.baseURL, profile.name);
    const toggle = browserToggle(page);
    await expect(toggle).not.toBeChecked();

    // BEFORE: no confirm is on screen, and nothing has been granted.
    await expect(page.getByTestId("grant-reach-confirm")).toHaveCount(0);

    // ACT: tick a human-only capability and press Save. The save must NOT go straight through.
    await toggle.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // AFTER (observable #1): the confirm appears and names the real blast radius — this agent, its project.
    const confirm = page.getByTestId("grant-reach-confirm");
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId("grant-reach-count")).toContainText("1 agent");
    await expect(page.getByTestId("grant-reach-agents")).toContainText(agent.name);
    await expect(page.getByTestId("grant-reach-agents")).toContainText(project.name);

    // ACT: Cancel.
    await page.getByTestId("grant-reach-cancel").click();

    // AFTER (observable #2 — the state change that matters): the confirm closes, and the STORED profile is
    // untouched. Asserted against REST, not the UI, because the editor still holds the ticked box locally —
    // the point is precisely that the local tick never reached the store.
    await expect(confirm).toHaveCount(0);
    expect((await getProfile(loomDaemon.baseURL, profile.id)).browserTesting ?? false).toBe(false);
    expect(await reachEventsFor(loomDaemon.baseURL, profile.id)).toHaveLength(0);

    // ACT: Save again, and this time confirm.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(confirm).toBeVisible();
    await page.getByTestId("grant-reach-save").click();

    // AFTER (observable #3): the grant lands in the store, and the daemon's audit row exists.
    await expect.poll(() => getProfile(loomDaemon.baseURL, profile.id).then((p) => p.browserTesting)).toBe(true);
    await expect.poll(async () => (await reachEventsFor(loomDaemon.baseURL, profile.id)).length).toBe(1);
    const events = await reachEventsFor(loomDaemon.baseURL, profile.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail?.addedKeys).toEqual(["browserTesting"]);
    expect(events[0]?.detail?.agentCount).toBe(1);
    expect(events[0]?.detail?.source).toBe("rest");
  });

  test("NEGATIVE CONTROL: a grant-free edit saves with no confirm and no event", async ({ page, loomDaemon }) => {
    const { profile } = await seedBoundRig(loomDaemon.baseURL, "neg", (n) => loomDaemon.createProject(n));

    await openProfile(page, loomDaemon.baseURL, profile.name);

    // ACT: change only the description — an edit that grants nothing, on a profile that HAS a bound agent
    // (so a confirm would fire if the trigger were "any save" rather than "a save that adds a grant").
    const blurb = `edited ${Date.now()}`;
    const description = page.locator("textarea").first();
    await description.fill(blurb);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // AFTER: it saved straight through — no prompt was ever shown, and no audit row was filed.
    await expect.poll(() => getProfile(loomDaemon.baseURL, profile.id).then((p) => p.description)).toBe(blurb);
    await expect(page.getByTestId("grant-reach-confirm")).toHaveCount(0);
    expect(await reachEventsFor(loomDaemon.baseURL, profile.id)).toHaveLength(0);
  });

  test("FAIL-CLOSED: with the agent list unreachable the confirm still fires, and never claims zero", async ({ page, loomDaemon }) => {
    const { profile } = await seedBoundRig(loomDaemon.baseURL, "abort", (n) => loomDaemon.createProject(n));

    // Hold the UI in the "agents query never resolved" state for the whole test. This is the ONLY way to
    // prove the component passes `isSuccess ? data : null` rather than `data ?? []` — with `?? []` the
    // planner would see an empty list, read it as "nobody is bound", and save the grant with no prompt.
    await page.route("**/api/agents", (r) => r.abort());

    await openProfile(page, loomDaemon.baseURL, profile.name);
    await browserToggle(page).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // AFTER: the confirm STILL appears, worded as unknown — never as a count, and never as "0 agents".
    const confirm = page.getByTestId("grant-reach-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/could not load/i);
    await expect(page.getByTestId("grant-reach-count")).toHaveCount(0);
    await expect(confirm).not.toContainText(/\b0 agents\b/);

    // And Cancel still withholds the save, exactly as in the loaded case.
    await page.getByTestId("grant-reach-cancel").click();
    expect((await getProfile(loomDaemon.baseURL, profile.id)).browserTesting ?? false).toBe(false);
  });

  test("a page that warmed the shared agent cache first does NOT suppress the confirm", async ({ page, loomDaemon }) => {
    // REGRESSION, code review of 8bf2772b. The Profiles editor used to run its OWN useQuery on the
    // ["allAgents"] key while lib/useAllAgents.ts ran a DIFFERENT queryFn on that same key — one that
    // projected each row to {id,label} and DROPPED profileId. Automation/Settings all mount that hook.
    // Visit one of them first and the editor reads the cached projected rows as isSuccess: every row
    // has profileId undefined, NOTHING looks bound, and the save goes through with no prompt at all.
    // A cache hit of the WRONG SHAPE reads exactly like a clean load — never like an error.
    const { profile, agent } = await seedBoundRig(loomDaemon.baseURL, "cache", (n) => loomDaemon.createProject(n));

    // Hold the stale-cache window open deterministically: the FIRST /api/agents fetch (the warming page
    // mount) passes through; every later one — including the background refetch Profiles fires on mount
    // — is stalled. Without this the test races that refetch and would pass for the wrong reason.
    let fetches = 0;
    await page.route("**/api/agents", async (route) => {
      fetches += 1;
      if (fetches > 1) await new Promise((r) => setTimeout(r, 15_000));
      await route.continue();
    });

    // STEP 1: land on Automation’s Events tab, whose target picker mounts the shared hook, and wait for
    // the real response so the cache is genuinely WARM (not merely requested) before navigating on.
    const warmed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.status() === 200);
    await page.goto(`${loomDaemon.baseURL}/automation?tab=events`);
    await warmed;

    // STEP 2: navigate IN-APP (the rail link, never page.goto) — a full reload builds a fresh
    // QueryClient and throws away the very cache entry this test is about.
    await railTo(page, "Actors");
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    // STEP 3: add a grant and save. The confirm must appear — and specifically the COUNTED variant, not
    // the unknown one: the cache is warm, so the editor must be reading raw rows that still carry
    // profileId. Asserting the count separates all three states that matter — raw cache (pass),
    // projected cache (no confirm at all: the bug), and not-loaded (confirm-unknown).
    await browserToggle(page).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("grant-reach-confirm")).toBeVisible();
    await expect(page.getByTestId("grant-reach-count")).toContainText("1 agent");
    await expect(page.getByTestId("grant-reach-agents")).toContainText(agent.name);

    // And Cancel still withholds it, so a green here can never be a save that merely looked prompted.
    await page.getByTestId("grant-reach-cancel").click();
    expect((await getProfile(loomDaemon.baseURL, profile.id)).browserTesting ?? false).toBe(false);
  });

  test("the pages sharing that cache still render agent labels after Profiles has used it", async ({ page, loomDaemon }) => {
    // The OTHER direction of the same collision. With one owner per key the cache holds RAW rows, so a
    // label consumer must derive its own shape via `select` instead of expecting a pre-projected cache;
    // if it did not, this picker would render options with an undefined label.
    const { profile, agent, project } = await seedBoundRig(loomDaemon.baseURL, "labels", (n) => loomDaemon.createProject(n));

    // Profiles FIRST, so the cache is populated by the RAW consumer, then navigate in-app to a label one.
    // The editor must actually be OPENED: the hook lives inside ProfileEditor, which only mounts once a
    // profile is selected, so a bare landing on /actors fetches nothing at all.
    await page.goto(`${loomDaemon.baseURL}/actors`);
    const warmed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.status() === 200);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await warmed;
    await railTo(page, "Automation");
    // The Time|Events switch is a Segmented control: role="tab", not a plain button.
    await page.getByRole("tab", { name: "Events", exact: true }).click();

    // The Events builder’s target picker is god-eye (any project’s agent), labelled "Project / Agent".
    await page.getByRole("button", { name: /new trigger/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /spawn an agent/i }).click();
    await expect(dialog.locator("option", { hasText: `${project.name} / ${agent.name}` })).toHaveCount(1);
  });
});

