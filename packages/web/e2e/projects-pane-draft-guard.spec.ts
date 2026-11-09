// The Projects page's third pane never drops a typed agent prompt when another pick replaces it (card
// f58b1250, from card dd83149f's "Not covered" list).
//
// The pane has no close of its own, but picking another agent, another project or a create form
// remounts it with a different occupant. Before the fix that remount threw the draft away without a
// word. Now a dirty editor holds the pick and arms the same UnsavedCloseBar the Atlas agent dialog uses:
// Keep editing keeps the draft and the selection, Discard and close performs the held pick, and the
// bar's Save writes the draft. A CLEAN editor still switches at once, which is the control that proves
// the bar is about the draft and not about every click.
//
// WHERE: switch OFF (classic) only. `/projects` is retired under Atlas (card 5afd71bd) and redirects to
// `/home`, so this pane does not exist with the switch on (see agent-editor-mod-enter.spec.ts).
//
// NO SPAWN: agent create/update are plain DB writes on the isolated fixture daemon.
import { expect, test, type Page } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";
const AGENT_KEY = "loom.agentId";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface SeededAgent { id: string; name: string; startupPrompt: string }

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Pins the active project once (addInitScript re-runs on every navigation, so only while unset).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([pkey, akey, id]) => {
    try {
      if (localStorage.getItem(pkey) === null) { localStorage.setItem(pkey, id); localStorage.removeItem(akey); }
    } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, AGENT_KEY, projectId] as const);
}

test.describe("Projects pane · a dirty agent editor holds the pick (card f58b1250)", () => {
  test("switching agents or opening a create form never drops a typed prompt", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(uniq("draftguard"));
    const mk = (name: string, startupPrompt: string) => apiJson<SeededAgent>(
      `${loomDaemon.baseURL}/api/projects/${project.id}/agents`,
      { method: "POST", body: JSON.stringify({ name, startupPrompt }) },
    );
    const a = await mk(uniq("Alder"), uniq("DRAFTGUARD-A-SEEDED"));
    const b = await mk(uniq("Birch"), uniq("DRAFTGUARD-B-SEEDED"));
    const readPrompt = async (id: string) =>
      (await apiJson<SeededAgent[]>(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`)).find((x) => x.id === id)?.startupPrompt;
    // useAgentWrites sets no inlineError, so a refused save raises a window.alert; record it as a failure.
    const dialogs: string[] = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });

    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/projects");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

    const editorA = page.getByTestId(`agent-editor-${a.id}`);
    const editorB = page.getByTestId(`agent-editor-${b.id}`);
    const fieldA = page.getByTestId(`agent-prompt-${a.id}`);
    const bar = page.getByTestId("agent-unsaved-bar");
    // The agent list's own row button (the editor header repeats the name, so bare text is ambiguous).
    const row = (x: SeededAgent) => page.getByRole("button", { name: x.name, exact: true });

    // CONTROL — a clean editor switches at once, with no bar.
    await row(a).click();
    await expect(fieldA).toHaveValue(a.startupPrompt); // identity: wired to THIS agent
    await expect(page.getByTestId(`agent-prompt-saved-${a.id}`)).toHaveCount(0); // nothing saved yet
    await row(b).click();
    await expect(editorB).toBeVisible();
    await expect(bar).toHaveCount(0);
    await row(a).click();
    await expect(fieldA).toHaveValue(a.startupPrompt);

    // (1) A dirty editor holds an agent pick; Keep editing keeps the draft and the selection.
    const draft = `${a.startupPrompt}\n${uniq("DRAFT")}`;
    await fieldA.fill(draft);
    await row(b).click();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Unsaved prompt");
    await expect(editorB).toHaveCount(0);
    await expect(fieldA).toHaveValue(draft);
    await page.getByTestId("agent-unsaved-keep").click();
    await expect(bar).toHaveCount(0);
    await expect(fieldA).toHaveValue(draft);

    // (2) "＋ New agent" is a pick too: it would replace the editor with the create form.
    await page.getByRole("button", { name: "＋ New agent" }).click();
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("agent-create-form")).toHaveCount(0);
    await page.getByTestId("agent-unsaved-keep").click();
    await expect(fieldA).toHaveValue(draft);

    // (3) Discard and close performs the held pick and leaves the stored prompt untouched.
    await row(b).click();
    await page.getByTestId("agent-unsaved-discard").click();
    await expect(editorB).toBeVisible();
    await expect(editorA).toHaveCount(0);
    expect(await readPrompt(a.id)).toBe(a.startupPrompt);

    // (4) The bar's Save writes the draft, keeps this editor, and only then reads "saved".
    await row(a).click();
    await expect(fieldA).toHaveValue(a.startupPrompt); // the discarded draft is really gone
    const kept = `${a.startupPrompt}\n${uniq("KEPT")}`;
    await fieldA.fill(kept);
    await row(b).click();
    await page.getByTestId("agent-unsaved-save").click();
    await expect(bar).toHaveCount(0);
    await expect.poll(() => readPrompt(a.id)).toBe(kept);
    await expect(page.getByTestId(`agent-prompt-saved-${a.id}`)).toHaveText("saved");
    await expect(editorA).toBeVisible();

    // ...and the now-clean editor switches straight away again.
    await row(b).click();
    await expect(editorB).toBeVisible();
    await expect(bar).toHaveCount(0);
    expect(dialogs, `a save was refused: ${dialogs.join(" | ")}`).toEqual([]);
  });
});
