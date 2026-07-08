// Role picker spec (card 04fec5be) — proves the Profiles editor's role field is the capability "class"
// picker (Direction A + C's tinted header on the selected card) and that it renders from the ONE role
// display map with an OBSERVABLE before/after for the selection control:
//   1. The picker renders on the Profiles editor, one card per conferrable role (from lib/roleDisplay).
//   2. Dev-layer roles (platform/auditor) are shown LOCKED — non-selectable (disabled) — so a saved
//      profile can never carry a validator-rejected role.
//   3. Selecting a role produces an observable state change: the picked card gains the selected marker
//      (data-selected flips) and the previously-selected card loses it — a render-only check is NOT
//      enough for an interactive control, so this exercises it and asserts the DOM differs.
//   4. Save round-trips: the picked role persists to the store (REST read-back).
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); profiles-agents.spec.ts is the template.
// Only ever CREATES a uniquely-named profile (never mutates a bundled one), so the shared store stays clean.
import { expect, test } from "./fixtures/daemon";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededProfile { id: string; name: string; role: string | null }
const seedProfile = (baseURL: string, name: string, role?: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(role ? { name, role } : { name }) });
const getProfile = (baseURL: string, id: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles/${encodeURIComponent(id)}`);

// Open a seeded profile in the Profiles editor (sidebar rows are <button>s; the unique name pins one).
const openProfile = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button").filter({ hasText: name }).first().click();
const saveButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Save", exact: true });

test.describe("role picker", () => {
  test("renders the class picker, locks dev-layer roles, and selecting a role changes the form + persists", async ({ page, loomDaemon }) => {
    const shots = mkdtempSync(path.join(tmpdir(), "role-picker-shots-"));
    // A freshly seeded profile carries no role (null) → the plain card is selected by default.
    const profile = await seedProfile(loomDaemon.baseURL, `Role Picker Rig ${Date.now()}`);
    await page.goto(`${loomDaemon.baseURL}/profiles`);

    await openProfile(page, profile.name);

    // 1. The picker renders, with a card per conferrable role (the display map's PICKER_ROLES).
    const picker = page.getByTestId("role-picker");
    await expect(picker).toBeVisible();
    for (const key of ["plain", "worker", "manager", "setup", "platform", "auditor"]) {
      await expect(page.getByTestId(`role-card-${key}`)).toBeVisible();
    }

    // BEFORE: the plain card is selected (null role), manager is not.
    const plain = page.getByTestId("role-card-plain");
    const manager = page.getByTestId("role-card-manager");
    await expect(plain).toHaveAttribute("data-selected", "true");
    await expect(manager).toHaveAttribute("data-selected", "false");
    await picker.screenshot({ path: path.join(shots, "before-plain-selected.png") });

    // 2. Dev-layer roles are LOCKED — rendered but non-selectable (disabled), so they can never be saved.
    const platform = page.getByTestId("role-card-platform");
    await expect(platform).toHaveAttribute("data-locked", "true");
    await expect(platform).toBeDisabled();
    await expect(platform).toHaveAttribute("data-selected", "false");
    await expect(page.getByTestId("role-card-auditor")).toBeDisabled();

    // 3. ACT + AFTER (interactive observable): pick Manager → the picked card gains the selected marker and
    //    the plain card loses it (DOM differs before vs. after — not just that the page renders).
    await manager.click();
    await expect(manager).toHaveAttribute("data-selected", "true");
    await expect(plain).toHaveAttribute("data-selected", "false");
    await picker.screenshot({ path: path.join(shots, "after-manager-selected.png") });

    // 4. ACT + AFTER (persistence): Save, then read the role straight back over REST.
    const save = saveButton(page);
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).role).toBe("manager");

    // eslint-disable-next-line no-console
    console.log(`[role-picker] before/after screenshots: ${shots}`);
  });

  test("a locked dev-layer card is inert — clicking it never selects it and never reaches a save", async ({ page, loomDaemon }) => {
    // The picker is the guard: the human-REST validateProfile actually ACCEPTS "platform", so what stops a
    // dev-layer role from ever being saved is that the picker never lets you select (or dirty) it. This
    // proves the lock is a real save-time guard, not just a cosmetic disabled attribute.
    const profile = await seedProfile(loomDaemon.baseURL, `Locked Rig ${Date.now()}`);
    await page.goto(`${loomDaemon.baseURL}/profiles`);
    await openProfile(page, profile.name);

    const platform = page.getByTestId("role-card-platform");
    const plain = page.getByTestId("role-card-plain");
    const worker = page.getByTestId("role-card-worker");
    await expect(platform).toBeDisabled();

    // Clicking the locked card (forced past the disabled gate) does NOT select it — plain stays selected.
    await platform.click({ force: true });
    await expect(platform).toHaveAttribute("data-selected", "false");
    await expect(plain).toHaveAttribute("data-selected", "true");

    // Make a REAL, valid change (Worker) so Save is reachable, then click the locked card AGAIN — it must
    // still not take, and Save must carry Worker, never platform.
    await worker.click();
    await expect(worker).toHaveAttribute("data-selected", "true");
    await platform.click({ force: true });
    await expect(worker).toHaveAttribute("data-selected", "true");
    await expect(platform).toHaveAttribute("data-selected", "false");

    const save = saveButton(page);
    await expect(save).toBeEnabled();
    await save.click();
    // The persisted role is Worker — the locked platform clicks never reached the store.
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).role).toBe("worker");
  });

  test("selecting Plain round-trips a role back to null", async ({ page, loomDaemon }) => {
    // Start from a real role, pick Plain ("" → null), Save, and read it back — the no-role branch persists.
    const profile = await seedProfile(loomDaemon.baseURL, `Plain Round-trip Rig ${Date.now()}`, "manager");
    await page.goto(`${loomDaemon.baseURL}/profiles`);
    await openProfile(page, profile.name);

    const plain = page.getByTestId("role-card-plain");
    const manager = page.getByTestId("role-card-manager");
    // BEFORE: the seeded manager role is selected.
    await expect(manager).toHaveAttribute("data-selected", "true");
    await expect(plain).toHaveAttribute("data-selected", "false");

    // ACT: pick Plain → the observable selection moves to plain.
    await plain.click();
    await expect(plain).toHaveAttribute("data-selected", "true");
    await expect(manager).toHaveAttribute("data-selected", "false");

    // AFTER (persistence): Save, then the store reads back a null role (no-role session).
    const save = saveButton(page);
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).role).toBe(null);
  });
});
