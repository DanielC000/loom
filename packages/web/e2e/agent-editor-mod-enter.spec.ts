// ⌘/Ctrl+Enter saves a PROJECT agent's startup prompt (card c6b80cf7).
//
// `AgentEditor` (components/agentEditor.tsx) is the one implementation of that field, and it had no
// keyboard save while the reserved-home editor beside it (AgentPromptEditor, covered by
// atlas-keyboard-shortcuts.spec.ts) did — so the identical keystroke saved on one surface and inserted
// a newline on the other. Both now share lib/modEnter.ts, and this spec is the project editor's half.
//
// WHERE THE EDITOR IS REACHABLE — read off the code, not assumed, because it is EXACTLY ONE HOST PER
// SWITCH STATE and they are DIFFERENT HOSTS:
//   · switch OFF (classic): pages/Projects.tsx's own editor pane. `/agents` is an ATLAS_HOMES address
//     (src/nav.tsx), which only AtlasShell mounts, so the Agents node does not exist in this shell.
//   · switch ON (Atlas): the Agents node's `AgentEditDialog` (components/atlasAgents.tsx). `/projects`
//     is in ATLAS_RETIREMENTS (card 5afd71bd) and redirects to `/home`, so the Projects pane is gone.
// Each leg below therefore MEASURES the absence in its own state rather than citing that record, and
// then drives the host that is actually there.
//
// HOW THE "BARE ENTER DOES NOT SAVE" CLAIM IS MADE FALSIFIABLE. A REST read taken straight after the
// keypress races the save it is trying to disprove, and a fixed wait makes it unfalsifiable in one
// trial. So the bare-Enter leg instead leans on three observables, the third of them ORDERED:
//   1. the textarea really gained a newline — the control proving the keystroke was delivered at all,
//      without which "nothing saved" is equally satisfied by a key that never reached the field;
//   2. the editor is still dirty (Save enabled, no "saved" chip);
//   3. once the FOLLOWING ⌘+Enter save has landed, exactly ONE POST /api/agents/:id has been seen for
//      this agent — a bare-Enter save would have been issued strictly earlier in wall-clock, so it
//      cannot still be in flight by then. The counter's positive control is that same save incrementing
//      it, on the same listener, inside the same test.
//
// NO SPAWN: agent create/update are ordinary DB writes with no process behind them, so they hit the
// isolated fixture daemon for real. Nothing here starts a session.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";
const AGENT_KEY = "loom.agentId";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const rail = (page: Page) => page.locator(".loom-rail");
const atlasShell = (page: Page) => page.getByTestId("atlas-shell");
/** Any mounted copy of the shared editor, whichever frame hosts it. */
const anyEditor = (page: Page) => page.locator('[data-testid^="agent-editor-"]');

// Only ever seeded ON. OFF is the default (an untouched context has an empty key) and addInitScript
// re-runs on EVERY navigation, so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Pins the active project and clears any persisted agent selection, but only while the project key is
// still absent: addInitScript re-runs on every navigation, so an unconditional write would re-pin on a
// later navigation and measure this helper instead of the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([pkey, akey, id]) => {
    try {
      if (localStorage.getItem(pkey) === null) { localStorage.setItem(pkey, id); localStorage.removeItem(akey); }
    } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, AGENT_KEY, projectId] as const);
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededAgent { id: string; name: string; startupPrompt: string }

/** A project with ONE plain (unbound) agent carrying a sentinel prompt — the identity every assertion
 *  below reads the editor against, so a leg wired to the wrong agent fails rather than passing. */
async function seedOne(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("modenter"));
  const sentinel = uniq("MODENTER-SEEDED-PROMPT");
  const agent = await apiJson<SeededAgent>(
    `${loomDaemon.baseURL}/api/projects/${project.id}/agents`,
    { method: "POST", body: JSON.stringify({ name: uniq("Keystone"), startupPrompt: sentinel }) },
  );
  return { project, agent, sentinel };
}

const readPrompt = async (baseURL: string, projectId: string, agentId: string) => {
  const agents = await apiJson<SeededAgent[]>(`${baseURL}/api/projects/${projectId}/agents`);
  return agents.find((a) => a.id === agentId)?.startupPrompt ?? null;
};

const writePrompt = (baseURL: string, agentId: string, startupPrompt: string) =>
  apiJson(`${baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ startupPrompt }) });

/** Every POST the PAGE makes to this agent's own write route. The prompt save is the only one this
 *  spec triggers (the profile `<select>` is never touched), so the count IS the save count. */
function countSaves(page: Page, agentId: string): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (new URL(req.url()).pathname === `/api/agents/${agentId}`) seen.push(req.url());
  });
  return seen;
}

const SURFACES = [
  {
    name: "switch OFF (classic) — the Projects page's own editor pane",
    atlas: false,
    /** The classic host. Also measures that the Atlas-only Agents node reached nothing here. */
    async open(page: Page, baseURL: string, seeded: Awaited<ReturnType<typeof seedOne>>) {
      await pinProject(page, seeded.project.id);

      // `/agents` is an ATLAS_HOMES address, so in this shell it mounts no editor at all. Presence
      // first (the shell really rendered), then the absence — a leading count-0 also passes on a page
      // that has not rendered anything yet.
      await page.goto(baseURL + "/agents");
      await expect(rail(page)).toBeVisible();
      await expect(anyEditor(page)).toHaveCount(0);
      await expect(page.getByTestId("atlas-agent-editor")).toHaveCount(0);

      await page.goto(baseURL + "/projects");
      await expect(rail(page)).toBeVisible();
      await expect(atlasShell(page)).toHaveCount(0);
      await page.getByText(seeded.agent.name, { exact: true }).click();
      return page.getByTestId(`agent-editor-${seeded.agent.id}`);
    },
  },
  {
    name: "switch ON (Atlas) — the Agents node's edit dialog",
    atlas: true,
    async open(page: Page, baseURL: string, seeded: Awaited<ReturnType<typeof seedOne>>) {
      await seedAtlasOn(page);
      await pinProject(page, seeded.project.id);

      // `/projects` is retired under Atlas (card 5afd71bd): it redirects, so the classic pane that
      // hosts this editor is genuinely unreachable in this state.
      await page.goto(baseURL + "/projects");
      await expect(atlasShell(page)).toBeVisible();
      await expect(page).toHaveURL(baseURL + "/home");
      await expect(anyEditor(page)).toHaveCount(0);

      await page.goto(baseURL + "/agents");
      await expect(atlasShell(page)).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
      await expect(page.getByTestId("atlas-agents-node")).toBeVisible();
      await page.getByTestId(`atlas-agent-card-${seeded.agent.id}`)
        .getByTestId(`atlas-agent-edit-${seeded.agent.id}`).click();
      await expect(page.getByTestId("atlas-agent-editor")).toBeVisible();
      return page.getByTestId(`agent-editor-${seeded.agent.id}`);
    },
  },
] as const;

for (const surface of SURFACES) {
  test.describe(`project agent prompt · ⌘/Ctrl+Enter — ${surface.name} (card c6b80cf7)`, () => {
    test("saves on ⌘+Enter and on Ctrl+Enter, never on a bare Enter, and never loses the draft", async ({ page, loomDaemon }) => {
      test.setTimeout(90_000);
      const seeded = await seedOne(loomDaemon);
      const saves = countSaves(page, seeded.agent.id);
      // `useAgentWrites` sets no `meta.inlineError`, so a REFUSED save raises main.tsx's global
      // window.alert. Recording them turns a silent server rejection into a named failure below.
      const dialogs: string[] = [];
      page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });

      try {
        const editor = await surface.open(page, loomDaemon.baseURL, seeded);
        await expect(editor).toBeVisible();

        // IDENTITY, not position: the field holds the prompt REST says THIS agent carries, so the
        // editor is wired to the seeded agent and not to a sibling worker's identically-rendered app.
        const field = page.getByTestId(`agent-prompt-${seeded.agent.id}`);
        const save = page.getByTestId(`agent-save-${seeded.agent.id}`);
        await expect(field).toHaveValue(seeded.sentinel);
        await expect(save).toBeDisabled();
        // The shortcut is DISCOVERABLE. A keyboard save nobody can find has not really shipped, and
        // this editor's textarea carries no placeholder to advertise it in (the composer's does).
        await expect(save).toHaveAttribute("title", /⌘\/Ctrl\+Enter/);
        expect(await readPrompt(loomDaemon.baseURL, seeded.project.id, seeded.agent.id)).toBe(seeded.sentinel);

        // Stamp the live DOM node. React replaces the element on a remount, taking the expando with
        // it — so re-reading this after each keystroke is the measure for "the change neither remounts
        // the editor nor loses what is typed in it". Asserted readable now, which is its own control.
        const STAMP = "modenter-same-node";
        await field.evaluate((el, s) => { (el as HTMLTextAreaElement & { __loomStamp?: string }).__loomStamp = s; }, STAMP);
        const stamp = () => field.evaluate((el) => (el as HTMLTextAreaElement & { __loomStamp?: string }).__loomStamp);
        expect(await stamp()).toBe(STAMP);

        // ── (a) BARE ENTER MUST NOT SAVE ───────────────────────────────────────────────────────────
        // It inserts a newline and the editor stays dirty. The newline is the control: it proves the
        // keystroke reached the field, so "nothing was saved" cannot pass for the wrong reason.
        const typo = `${seeded.sentinel}\nMODENTER-NEVER-SAVED`;
        await field.fill(typo);
        await field.press("Enter");
        // Asserted without assuming where `fill` left the caret: exactly one newline appeared and
        // nothing else about the text moved.
        const afterEnter = await field.inputValue();
        expect(afterEnter, "the bare Enter never reached the field").not.toBe(typo);
        expect(afterEnter.replace(/\n/g, ""), "the bare Enter changed more than a line break")
          .toBe(typo.replace(/\n/g, ""));
        await expect(save).toBeEnabled();
        await expect(editor.getByText("saved", { exact: true })).toHaveCount(0);
        expect(await stamp(), "a bare Enter remounted the editor").toBe(STAMP);

        // ── (b) ⌘+Enter SAVES ──────────────────────────────────────────────────────────────────────
        const viaMeta = `${seeded.sentinel}\n${uniq("MODENTER-SAVED-VIA-META")}`;
        await field.fill(viaMeta);
        await expect(save).toBeEnabled();
        await field.press("Meta+Enter");
        // The dirty gate clears only once the invalidated agents query comes back with the new text,
        // so this chip is a read of persisted state, not of the local textarea.
        await expect(editor.getByText("saved", { exact: true })).toBeVisible();
        await expect.poll(() => readPrompt(loomDaemon.baseURL, seeded.project.id, seeded.agent.id),
          { message: "⌘+Enter never reached the daemon" }).toBe(viaMeta);
        // The draft survived the save, in the SAME element.
        await expect(field).toHaveValue(viaMeta);
        expect(await stamp(), "the ⌘+Enter save remounted the editor").toBe(STAMP);
        // ...and (a) contributed NO write: a bare-Enter save would have been issued strictly before
        // this one, so by now it could not still be unobserved.
        expect(saves.length, "a bare Enter also wrote to the agent").toBe(1);

        // ── (c) Ctrl+Enter SAVES TOO — the other half of the `||`, from a now-clean editor ─────────
        const viaCtrl = `${seeded.sentinel}\n${uniq("MODENTER-SAVED-VIA-CTRL")}`;
        await field.fill(viaCtrl);
        await expect(save).toBeEnabled();
        await field.press("Control+Enter");
        await expect(editor.getByText("saved", { exact: true })).toBeVisible();
        await expect.poll(() => readPrompt(loomDaemon.baseURL, seeded.project.id, seeded.agent.id),
          { message: "Ctrl+Enter never reached the daemon" }).toBe(viaCtrl);
        await expect(field).toHaveValue(viaCtrl);
        expect(await stamp(), "the Ctrl+Enter save remounted the editor").toBe(STAMP);
        expect(saves.length, "the two keyboard saves should be the only writes").toBe(2);

        // ── (d) A CLEAN EDITOR DOES NOT SAVE ──────────────────────────────────────────────────────
        // The `enabled` half of the gate, which the two legs above cannot distinguish from an
        // ungated handler. MEASURED while writing this: the inert keystroke also leaves the TEXT
        // untouched — a modified Enter in a Chromium textarea inserts no character of its own, so
        // "not consumed" is not an affordance here and lib/modEnter.ts says so rather than implying
        // a newline it does not produce.
        await expect(save).toBeDisabled();
        await field.press("Meta+Enter");
        expect(await field.inputValue(), "an inert ⌘+Enter changed the draft").toBe(viaCtrl);
        // ...and it wrote nothing: this real save is the ORDERED control, exactly as in (b) — a write
        // from the inert keystroke above would have been issued earlier and would make this 4.
        const viaFinal = `${seeded.sentinel}\n${uniq("MODENTER-SAVED-LAST")}`;
        await field.fill(viaFinal);
        await field.press("Control+Enter");
        await expect(editor.getByText("saved", { exact: true })).toBeVisible();
        await expect.poll(() => readPrompt(loomDaemon.baseURL, seeded.project.id, seeded.agent.id)).toBe(viaFinal);
        expect(saves.length, "an inert ⌘+Enter on a clean editor still wrote to the agent").toBe(3);

        expect(dialogs, "a save was refused and alerted").toEqual([]);
      } finally {
        // This agent is this spec's own row, but restore it anyway: the editor's whole contract is that
        // it does not leave someone else's prompt rewritten, and the restore is what a shared row needs.
        await writePrompt(loomDaemon.baseURL, seeded.agent.id, seeded.sentinel)
          .catch(() => { /* best-effort restore */ });
      }
    });
  });
}
