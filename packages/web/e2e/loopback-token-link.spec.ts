// Card a1ec70a6 item 1 — a `?token=` link whose secret the daemon REFUSES must not evict the working one
// this browser holds. Pre-fix, `captureTokenFromUrl` stored the param on sight, so any link to
// `127.0.0.1:<port>/?token=x` silently broke every write until the next `loom open`; the banner's paste
// path and the whole gateway-token path both verified first.
//
// This is the WIRING proof that test/loopback-token-link.mjs (the algebra) structurally cannot give:
// api.ts really runs the capture at import, the real daemon really refuses the bad secret, the stored one
// really survives, and a real UI-DRIVEN write really still goes through afterwards.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const STORAGE_KEY = "loom.loopbackToken";
// Shaped like a real secret (the daemon's is hex) but not this daemon's — so the refusal is the guard's
// own 401, not a parse/format rejection on the way in.
const BAD_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// A GOOD link's capture RELOADS the page (requests that raced the module-scope capture carried no token),
// so a read can land mid-navigation and throw "Execution context was destroyed" — which is a symptom of
// the reload working, not of the secret being wrong. Swallow exactly that and report `undefined`, so the
// `expect.poll` below retries instead of failing for the wrong reason. A genuine mismatch still fails,
// with the poll's own last-seen value in the message.
async function storedSecret(page: Page): Promise<string | null | undefined> {
  try {
    return await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
  } catch {
    return undefined;
  }
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test("a REFUSED ?token= link keeps the stored secret, says so, and leaves writes working", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`token-link-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // PRECONDITION: this browser holds the daemon's REAL secret (the fixture seeds it, exactly as
  // `loom open`'s own `?token=` link would). Asserting it first is what makes the "unchanged" assertion
  // below mean something — otherwise it would pass identically against an empty slot.
  await page.goto(`${loomDaemon.baseURL}/board`);
  expect(await storedSecret(page)).toBe(loomDaemon.loopbackSecret);
  expect(loomDaemon.loopbackSecret).not.toBe(BAD_SECRET);

  // THE ATTACK: open the app through a link carrying a secret the daemon will refuse.
  await page.goto(`${loomDaemon.baseURL}/board?token=${BAD_SECRET}`);

  // 1. The rejected secret is stripped from the visible URL — true on the OLD code and the new one, which
  //    is exactly why it is the right thing to wait on here: it proves the capture has RUN without
  //    depending on any surface the fix added. Pre-fix, the store happened BEFORE this strip, so by the
  //    time it is gone the damage is already done — the next assertion is therefore never vacuous.
  await expect.poll(() => new URL(page.url()).searchParams.get("token")).toBeNull();

  // 2. THE CARD'S DEFECT: the stored secret is UNCHANGED. Read here because the strip above proves the
  //    capture has run past the point where the OLD code had already done its damage — but the verify is
  //    still in flight at this moment, so step 4 repeats it once the outcome has actually landed.
  expect(await storedSecret(page)).toBe(loomDaemon.loopbackSecret);

  // 3. The refusal is SURFACED — and worded for a link, not as a (false) refused write.
  const banner = page.getByTestId("credential-banner");
  await expect(banner).toBeVisible();
  await expect(banner.getByText("A link's access credential was refused.")).toBeVisible();
  await expect(banner.getByText(/so it was NOT saved; the one this browser already holds is unchanged/)).toBeVisible();
  // …and the copy must not promise an outcome nobody observed: the held secret is unproven here, and the
  // "Unlock writes" field is rendered right beside this sentence (round-2 review, card a1ec70a6).
  await expect(banner.getByText(/writes still work/)).toHaveCount(0);
  // No retry is offered for a REFUSAL: the daemon answered, so there is nothing a re-check could change.
  await expect(banner.getByTestId("loopback-link-retry")).toHaveCount(0);

  // 4. The stored secret is STILL unchanged now that the banner has rendered. Asserted a second time on
  //    purpose: the first read raced the capture's own await, so only this one is ordered strictly AFTER
  //    the whole verify-and-reject path has finished and could observe a late write.
  expect(await storedSecret(page)).toBe(loomDaemon.loopbackSecret);

  // 5. WRITES STILL WORK — the point of the whole fix. A UI-driven create carries the surviving secret;
  //    pre-fix this is where the user hit a wall of 401s. Read back off REST so the proof isn't just DOM.
  const title = `token-link-write-${Date.now()}`;
  await page.getByPlaceholder("new task title").fill(title);
  await page.getByRole("button", { name: "Add to Inbox" }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const tasks = await (await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`)).json();
  expect((tasks as { title: string }[]).map((t) => t.title)).toContain(title);

  // 6. Dismissable, because nothing is actually broken — unlike a real lock, which has no Dismiss.
  await banner.getByTestId("loopback-link-dismiss").click();
  await expect(banner).toBeHidden();
});

// The POSITIVE leg: a GOOD link must still be captured — `loom open`'s whole delivery path. Run in a RAW
// context (`browser.newContext()`), deliberately NOT the shared `page` fixture: that fixture seeds the real
// secret into localStorage for every page, so the capture would short-circuit on the already-held value and
// this test would pass without the store path ever running. An empty slot is the only honest fixture here.
test("a GOOD ?token= link IS captured into an empty slot, and raises no banner", async ({ browser, loomDaemon }) => {
  const project = await loomDaemon.createProject(`token-link-good-${Date.now()}`);
  const context = await browser.newContext();
  // The two things the shared fixture would have done for us, minus the token seeding.
  await context.addInitScript((id) => {
    localStorage.setItem("loom.setupWelcomeDismissed", "1");
    localStorage.setItem("loom.projectId", id);
  }, project.id);
  const raw = await context.newPage();
  try {
    await raw.goto(`${loomDaemon.baseURL}/board`);
    expect(await storedSecret(raw)).toBeNull(); // precondition: genuinely nothing held

    await raw.goto(`${loomDaemon.baseURL}/board?token=${loomDaemon.loopbackSecret}`);
    // The capture verifies then reloads, so poll rather than reading once mid-flight.
    await expect.poll(() => storedSecret(raw)).toBe(loomDaemon.loopbackSecret);
    await expect(raw.getByPlaceholder("new task title")).toBeVisible(); // the reload has settled
    expect(new URL(raw.url()).searchParams.get("token")).toBeNull();
    await expect(raw.getByTestId("credential-banner")).toBeHidden();
  } finally {
    await context.close();
  }
});
