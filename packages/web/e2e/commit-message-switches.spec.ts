// Commit-message switches e2e (card bd828fb3) — the two HUMAN-only project keys that govern what the
// NEXT landing writes into its commit message (`orchestration.commitTrailers`,
// `orchestration.commitLogBody`; daemon halves 3e92e23b / 9a5d040c / 5933734e), plus the task drawer's
// ship-state read-out when trailers are off.
//
// WHAT IS DRIVEN FOR REAL HERE, AND WHAT IS NOT (the same discipline merge-gate-cadence.spec.ts states:
// ask which SOURCE a surface reads before assuming it is testable):
//   • Both Settings controls and their persistence read/write the project config override through the
//     ordinary human PATCH, so they are driven FOR REAL — no mocking at all, and every assertion about
//     what was stored reads the override back off `GET /api/projects`.
//   • The drawer's ship-state note reads the SAME override, so it is driven for real too — the project's
//     config is PATCHed, the real board is opened, and the note's presence/absence is asserted both ways.
//   • WHAT THIS THEREFORE DOES NOT PROVE: that a trailers-off landing actually omits the trailer
//     paragraph, or that merge discovery then degrades to `merged: null`. That half is the daemon cards'
//     own tests (9a5d040c / 5933734e), not this spec's — the fixture's no-spawn guard forbids
//     manufacturing a real merge here at all.
//
// Determinism: the worker-scoped daemon is SHARED across specs and both surfaces are scoped to the
// ACTIVE project, so every test seeds its OWN project and pins it active BEFORE navigating. Each
// assertion about stored state is keyed to THAT project's id, so a read that somehow resolved a
// different project (or a different daemon) fails loudly rather than passing on a sibling's data.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";
import path from "node:path";

// Screenshot hook (opt-in via LOOM_E2E_SHOTS, same as board.spec.ts / board-task-modal.spec.ts): unset
// in CI, so this is a no-op there. Set it to a dir to persist the rendered controls for a visual review.
// Takes a LOCATOR, not the page: the Settings page is ~12000px tall, and a full-page capture of it is
// unreadable at any size anyone would actually look at it.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | Locator, name: string) => { if (shotDir) await target.screenshot({ path: path.join(shotDir, name) }); };

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The two stored keys as they actually sit on THIS project's override, or null when absent. */
async function readOverride(baseURL: string, projectId: string) {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as Array<{
    id: string; config?: { orchestration?: { commitTrailers?: string; commitLogBody?: string } };
  }>;
  const row = projects.find((p) => p.id === projectId);
  // A missing row is a DIFFERENT failure from a project that simply carries no override, and conflating
  // the two would let a wrong-daemon/wrong-project read pass as "inherits the default".
  if (!row) throw new Error(`project ${projectId} is not on this daemon — wrong daemon or wrong id`);
  const orch = row.config?.orchestration;
  return { commitTrailers: orch?.commitTrailers ?? null, commitLogBody: orch?.commitLogBody ?? null };
}

async function patchConfig(baseURL: string, projectId: string, config: unknown, unset: string[] = []) {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, unset }),
  });
  if (!res.ok) throw new Error(`PATCH config -> ${res.status}: ${await res.text()}`);
}

const panelOf = (page: Page) => page.getByTestId("commit-message-panel");
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true }).first();

test.describe("Settings commit-message switches (card bd828fb3)", () => {
  test("both switches default to On, and turning each Off raises its own note", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cm-ui"));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    const trailers = panel.getByTestId("commit-trailers");
    const logBody = panel.getByTestId("commit-log-body");

    // BEFORE: a fresh project inherits "on" for both, and neither note is rendered — a default must
    // never warn about itself.
    await expect(trailers.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
    await expect(logBody.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("commit-trailers-warn")).toHaveCount(0);
    await expect(page.getByTestId("commit-log-body-warn")).toHaveCount(0);

    // AFTER (trailers): the amber note appears, and it states every cost the card requires plus the
    // retroactivity reassurance. Asserted as COPY, because the copy IS the deliverable here.
    await trailers.getByRole("radio", { name: "Off" }).click();
    await expect(trailers.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    const warn = page.getByTestId("commit-trailers-warn");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("lose track of a merge if the daemon crashes mid-landing");
    await expect(warn).toContainText("already shipped as not merged");
    await expect(warn).toContainText("stops auto-confirming retained batch branches for cleanup");
    await expect(warn).toContainText("Existing history is never rewritten");
    await expect(warn).toContainText("existing retained branches may need a manual check");
    // The other switch is genuinely INDEPENDENT: it neither moved nor raised its own note.
    await expect(logBody.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("commit-log-body-warn")).toHaveCount(0);

    // AFTER (worker commit log): its own note, and it must NOT borrow the trailers note's costs — that
    // would be a false claim about a switch nothing in Loom reads back.
    await logBody.getByRole("radio", { name: "Off" }).click();
    const logWarn = page.getByTestId("commit-log-body-warn");
    await expect(logWarn).toBeVisible();
    await expect(logWarn).toContainText("Nothing in Loom reads that prose");
    await expect(logWarn).toContainText("Existing history is never rewritten");
    await expect(logWarn).not.toContainText("crashes mid-landing");
    await shoot(panel, "commit-message-switches-off.png");

    // And each note withdraws when its own switch goes back to On.
    await trailers.getByRole("radio", { name: "On" }).click();
    await expect(page.getByTestId("commit-trailers-warn")).toHaveCount(0);
    await expect(page.getByTestId("commit-log-body-warn")).toBeVisible();
  });

  test("each switch persists its OWN key, and On CLEARS it rather than storing the default", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cm-persist"));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // BEFORE: nothing stored.
    expect(await readOverride(loomDaemon.baseURL, project.id)).toEqual({ commitTrailers: null, commitLogBody: null });

    // Trailers off, ALONE: only its key lands. (The independence the daemon cards shipped two keys for.)
    await panelOf(page).getByTestId("commit-trailers").getByRole("radio", { name: "Off" }).click();
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id))
      .toEqual({ commitTrailers: "off", commitLogBody: null });

    // A reload re-seeds the control from the PERSISTED override, not optimistic client state.
    await page.reload();
    await expect(panelOf(page).getByTestId("commit-trailers").getByRole("radio", { name: "Off" }))
      .toHaveAttribute("aria-checked", "true");
    await expect(panelOf(page).getByTestId("commit-log-body").getByRole("radio", { name: "On" }))
      .toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("commit-trailers-warn")).toBeVisible();

    // Now the worker commit log too: both keys stored, independently.
    await panelOf(page).getByTestId("commit-log-body").getByRole("radio", { name: "Off" }).click();
    await saveButton(page).click();
    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id))
      .toEqual({ commitTrailers: "off", commitLogBody: "off" });

    // Back to the default: BOTH keys are REMOVED from the override, never written back as "on" — a
    // stored default would be indistinguishable from a deliberate choice on every later read.
    await page.reload();
    await panelOf(page).getByTestId("commit-trailers").getByRole("radio", { name: "On" }).click();
    await panelOf(page).getByTestId("commit-log-body").getByRole("radio", { name: "On" }).click();
    await saveButton(page).click();
    await expect.poll(() => readOverride(loomDaemon.baseURL, project.id))
      .toEqual({ commitTrailers: null, commitLogBody: null });
  });
});

test.describe("Task drawer ship state with trailers off (card bd828fb3)", () => {
  test("a card with no recorded landing reads UNKNOWN when trailers are off, and nothing when they are on", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cm-ship"));
    const title = uniq("cm-ship-card");
    await loomDaemon.createTask(project.id, { title, body: "no landing recorded", columnKey: "todo" });
    await pinActiveProject(page, project.id);

    // BEFORE: trailers are at their default, so the drawer says nothing about ship state at all — the
    // note must not appear on every project just because a card has not merged.
    await page.goto(`${loomDaemon.baseURL}/board`);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.getByText(title, { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("ship-state-trailers-off")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // AFTER: with trailers off, the SAME card's drawer states that a missing landing is unknown rather
    // than negative, muted, with the qualifying tooltip — the shipVerificationStyle "trailer-only"
    // pattern this mirrors.
    await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { commitTrailers: "off" } });
    expect(await readOverride(loomDaemon.baseURL, project.id))
      .toEqual({ commitTrailers: "off", commitLogBody: null });

    await page.reload();
    await page.getByText(title, { exact: true }).click();
    const note = page.getByRole("dialog").getByTestId("ship-state-trailers-off");
    await expect(note).toBeVisible();
    await expect(note).toContainText("unknown");
    await expect(note).toContainText("trailers off");
    await expect(note).toHaveAttribute("title", /may still have shipped/);
    // It must never assert the negative — that is the whole reason the line exists.
    await expect(note).not.toContainText(/not shipped/i);
    await shoot(page.getByRole("dialog"), "ship-state-trailers-off.png");

    // And it withdraws the moment trailers come back, so it can never linger as a stale caveat.
    await patchConfig(loomDaemon.baseURL, project.id, {}, ["orchestration.commitTrailers"]);
    expect(await readOverride(loomDaemon.baseURL, project.id))
      .toEqual({ commitTrailers: null, commitLogBody: null });
    await page.reload();
    await page.getByText(title, { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByTestId("ship-state-trailers-off")).toHaveCount(0);
  });
});
