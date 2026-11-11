// Renaming an agent from its editor (card b0495d0b, Atlas audit A-34).
//
// An agent's NAME is an identity: worker_spawn resolves `agentId` by name and slug, and the setup home's
// seeders find their agents by exact name. So a rename is checked on both sides (trimmed, non-empty, no
// same-project name or slug clash, and no renaming a built-in seeded agent), and these legs measure it
// against the REAL daemon:
//   1. A rename lands: the server reads the new name back, and the editor header, the roster card and the
//      tree's session row (a server-side join on the agent row) all show it.
//   2. A refused rename says why and writes nothing: the client pre-check catches an empty name and a
//      case-insensitive duplicate before any request, and a clash the client could not see (a sibling made
//      after the editor loaded) comes back as the daemon's own refusal, shown verbatim.
//   3. An unsaved name draft blocks the dialog's close, like the prompt does (card dd83149f).
//   4. A rename made ELSEWHERE while the field is open: an untouched draft follows it; a typed one gets a
//      stated conflict and Save waits for "Keep mine" / "Take theirs" — never a silent revert.
//   5. While the rename is in flight the field is locked, and it closes only on the name it sent.
//   6. Switch off: the Projects page hosts the same rename control.
//
// ⛔ NO REAL SPAWN. Renames are plain DB writes. The tree's session row is a SEEDED live row (no pty).
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface SeededAgent { id: string; name: string }
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<SeededAgent>(`${baseURL}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });
const serverName = async (baseURL: string, projectId: string, agentId: string) =>
  (await apiJson<SeededAgent[]>(`${baseURL}/api/projects/${projectId}/agents`)).find((a) => a.id === agentId)?.name;

async function seed(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("renameproj"));
  // Names share no stem with each other or with the project: locators below filter by text.
  const subject = await seedAgent(loomDaemon.baseURL, project.id, uniq("Quillwright"));
  const taken = await seedAgent(loomDaemon.baseURL, project.id, uniq("Tidekeeper"));
  return { project, subject, taken };
}

async function openEditor(page: Page, agentId: string) {
  await page.getByTestId(`atlas-agent-edit-${agentId}`).click();
  const dialog = page.getByTestId("atlas-agent-editor");
  await expect(dialog.getByTestId(`agent-editor-${agentId}`)).toBeVisible();
  return dialog;
}

test.describe("agent rename from the editor (card b0495d0b)", () => {
  test("switch ON: a rename lands on the server and shows in the header, the roster and the tree", async ({ page, loomDaemon }) => {
    const { project, subject } = await seed(loomDaemon);
    const session = await loomDaemon.seedLiveSession({ project, agentId: subject.id, agentName: subject.name, id: `e2e-rename-${Date.now()}` });
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/agents");

    // BEFORE: the tree row and the roster card carry the old name.
    const treeRow = page.getByTestId(`atlas-session-${session.sessionId}`);
    await expect(treeRow).toContainText(subject.name);
    const card = page.getByTestId(`atlas-agent-card-${subject.id}`);
    await expect(card).toContainText(subject.name);

    const dialog = await openEditor(page, subject.id);
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(subject.name);
    await dialog.getByTestId(`agent-rename-${subject.id}`).click();
    const input = dialog.getByTestId(`agent-name-input-${subject.id}`);
    await expect(input).toHaveValue(subject.name);
    // The stale-reference hint names the OLD name, since that is what a brief would still say.
    await expect(dialog.getByTestId(`agent-name-hint-${subject.id}`)).toContainText(subject.name);
    // Nothing changed yet, so nothing to save.
    await expect(dialog.getByTestId(`agent-name-save-${subject.id}`)).toBeDisabled();

    const next = uniq("Lamplighter");
    await input.fill(`  ${next}  `); // trimmed on save
    await input.press("Enter");

    // AFTER: the field closes on the persisted row, and every derivation agrees.
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(next);
    await expect(dialog.getByTestId(`agent-name-saved-${subject.id}`)).toBeVisible();
    await expect(input).toHaveCount(0);
    expect(await serverName(loomDaemon.baseURL, project.id, subject.id)).toBe(next);
    await page.getByTestId("atlas-agent-editor-close").click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText(next);
    await expect(treeRow).toContainText(next);
    await expect(treeRow).not.toContainText(subject.name);
  });

  test("switch ON: an empty or duplicate name is refused with a visible reason, and nothing is written", async ({ page, loomDaemon }) => {
    const { project, subject, taken } = await seed(loomDaemon);
    // The global mutation handler would alert for a non-inline mutation; the rename is inline, so any
    // native dialog here is a defect. Record rather than let one wedge the test.
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/agents");
    const dialog = await openEditor(page, subject.id);
    await dialog.getByTestId(`agent-rename-${subject.id}`).click();
    const input = dialog.getByTestId(`agent-name-input-${subject.id}`);
    const save = dialog.getByTestId(`agent-name-save-${subject.id}`);
    const error = dialog.getByTestId(`agent-name-error-${subject.id}`);

    // Empty (whitespace only): the client says so, and Save stays off.
    await input.fill("   ");
    await expect(error).toHaveText("A name can't be empty.");
    await expect(save).toBeDisabled();

    // A case-insensitive duplicate of a sibling, caught before any request.
    await input.fill(taken.name.toUpperCase());
    await expect(error).toContainText(`already named "${taken.name}"`);
    await expect(save).toBeDisabled();

    // A clash the client CANNOT see: a sibling created after the editor loaded its sibling list. The
    // pre-check passes, so this is the daemon's own refusal, shown verbatim.
    const late = uniq("Driftwood");
    await seedAgent(loomDaemon.baseURL, project.id, late);
    await input.fill(late);
    await expect(error).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(error).toHaveText(`another agent in this project is already named "${late}"`);
    await expect(input).toHaveValue(late); // the draft is kept for a fix, never thrown away
    // Editing the draft retires the server's refusal (it no longer describes what is typed).
    await input.fill(`${late}-b`);
    await expect(error).toHaveCount(0);

    // Nothing was written by any of it, and Cancel restores the read-only name.
    expect(await serverName(loomDaemon.baseURL, project.id, subject.id)).toBe(subject.name);
    await dialog.getByTestId(`agent-name-cancel-${subject.id}`).click();
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(subject.name);
    expect(nativeDialogs).toEqual([]);
  });

  test("switch ON: an unsaved name draft blocks the dialog's close", async ({ page, loomDaemon }) => {
    const { project, subject } = await seed(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/agents");
    const dialog = await openEditor(page, subject.id);
    await dialog.getByTestId(`agent-rename-${subject.id}`).click();
    await dialog.getByTestId(`agent-name-input-${subject.id}`).fill(uniq("Halfdone"));
    await page.getByTestId("atlas-agent-editor-close").click();
    const bar = dialog.getByTestId("agent-unsaved-bar");
    await expect(bar).toContainText("Unsaved name.");
    await bar.getByTestId("agent-unsaved-keep").click();
    await expect(bar).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // Escape inside the field cancels the edit only, and the dialog stays open.
    await dialog.getByTestId(`agent-name-input-${subject.id}`).press("Escape");
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(subject.name);
    await expect(dialog).toBeVisible();
  });

  test("switch ON: a rename made elsewhere while the field is open is followed or stated, never reverted", async ({ page, loomDaemon }) => {
    const { project, subject } = await seed(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/agents");
    const dialog = await openEditor(page, subject.id);
    const input = dialog.getByTestId(`agent-name-input-${subject.id}`);
    const save = dialog.getByTestId(`agent-name-save-${subject.id}`);
    const conflict = dialog.getByTestId(`agent-name-conflict-${subject.id}`);
    // Another writer (the Platform Lead's agent_update, say) renames over REST. The editor learns of it on
    // its next ["agents", projectId] refetch, driven here by saving the PROMPT — its save invalidates that
    // query outright, deterministically, and never touches the name on the wire.
    const renameElsewhere = (name: string) =>
      apiJson(`${loomDaemon.baseURL}/api/agents/${subject.id}`, { method: "POST", body: JSON.stringify({ name }) });
    let promptRound = 0;
    const refetch = async () => {
      await dialog.getByTestId(`agent-prompt-${subject.id}`).fill(`prompt round ${++promptRound}`);
      await dialog.getByTestId(`agent-save-${subject.id}`).click();
      await expect(dialog.getByTestId(`agent-prompt-saved-${subject.id}`)).toBeVisible();
    };

    // 1. UNTOUCHED draft: it follows the other rename; there is nothing of ours to keep.
    await dialog.getByTestId(`agent-rename-${subject.id}`).click();
    await expect(input).toHaveValue(subject.name);
    const theirs1 = uniq("Brineward");
    await renameElsewhere(theirs1);
    await refetch();
    await expect(input).toHaveValue(theirs1);
    await expect(conflict).toHaveCount(0);
    await expect(save).toBeDisabled(); // following is not an edit

    // 2. TYPED draft + a rename elsewhere: stated, our text kept, and Save held until we pick. Before the
    //    fix Save stayed enabled here and one click put the stale name back over theirs.
    const mine = uniq("Saltmarsh");
    await input.fill(mine);
    const theirs2 = uniq("Cinderfold");
    await renameElsewhere(theirs2);
    await refetch();
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(theirs2);
    await expect(input).toHaveValue(mine);
    await expect(save).toBeDisabled();
    await input.press("Enter"); // the keyboard can't save past it either
    expect(await serverName(loomDaemon.baseURL, project.id, subject.id)).toBe(theirs2);

    //    "Take theirs" adopts their name into the field and retires the notice.
    await dialog.getByTestId(`agent-name-take-theirs-${subject.id}`).click();
    await expect(input).toHaveValue(theirs2);
    await expect(conflict).toHaveCount(0);
    await expect(save).toBeDisabled();

    // 3. Same again, but "Keep mine": the notice retires and Save writes ours, deliberately.
    await input.fill(mine);
    const theirs3 = uniq("Hollowmere");
    await renameElsewhere(theirs3);
    await refetch();
    await expect(conflict).toBeVisible();
    await dialog.getByTestId(`agent-name-keep-mine-${subject.id}`).click();
    await expect(conflict).toHaveCount(0);
    await expect(input).toHaveValue(mine);
    await save.click();
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(mine);
    expect(await serverName(loomDaemon.baseURL, project.id, subject.id)).toBe(mine);
  });

  test("switch ON: the field is locked while a rename is in flight, and closes on the name it sent", async ({ page, loomDaemon }) => {
    const { project, subject } = await seed(loomDaemon);
    // Hold the rename's POST until the test has looked at the in-flight state.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let heldCount = 0;
    await page.route(`**/api/agents/${subject.id}`, async (route) => {
      if (route.request().method() === "POST") { heldCount++; await held; }
      await route.continue();
    });
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/agents");
    const dialog = await openEditor(page, subject.id);
    await dialog.getByTestId(`agent-rename-${subject.id}`).click();
    const input = dialog.getByTestId(`agent-name-input-${subject.id}`);
    const next = uniq("Ferrymoor");
    await input.fill(next);
    await dialog.getByTestId(`agent-name-save-${subject.id}`).click();

    // IN FLIGHT: nothing typed now could be silently thrown away by the close, because nothing can be typed.
    await expect.poll(() => heldCount).toBe(1);
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue(next);
    await expect(dialog.getByTestId(`agent-name-save-${subject.id}`)).toHaveText("Saving…");

    release();
    await expect(dialog.getByTestId(`agent-name-${subject.id}`)).toHaveText(next);
    await expect(input).toHaveCount(0);
    expect(await serverName(loomDaemon.baseURL, project.id, subject.id)).toBe(next);
  });
});
