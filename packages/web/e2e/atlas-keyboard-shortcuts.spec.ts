// Keyboard shortcuts under BOTH Atlas switch states (card a1c6e339, Atlas build plan P2-8 —
// docs/plans/atlas-ui/03-decomposition.md row P2-8). Closes parity gaps §J.3 and §J.10 of
// docs/plans/atlas-ui/01-parity-checklist.md.
//
// @decision a1c6e339 — never re-wire one of these shortcuts per Atlas surface (the handler belongs to
// the component, and a second shell-level copy makes "which one fired" unanswerable), and never drop a
// leg's bare-Enter or control-byte control to shorten it: each is the only thing standing between its
// assertion and a confident false green.
//
// ── WHERE EACH SHORTCUT LIVES, AND WHERE ITS HOST LIVES IN ATLAS ────────────────────────────────
// Every handler is on the COMPONENT, not on a page or a shell, so a host that Atlas mounts verbatim
// carries it by construction. The inventory below is the card's first deliverable; it was derived by
// grepping every `metaKey|ctrlKey` site in packages/web/src (7 of them, 6 named in §F) and then
// tracing each component's real import sites — never from the §F table, which names the components
// but not which page actually mounts them today.
//
//   ⌘/Ctrl+Enter · send a turn          Composer.tsx `onComposeKey`     ┐ all three live inside
//   ⌘/Ctrl+Enter · save a preset        PresetPrompts.tsx `PresetForm`  ├ components/TerminalCard.tsx
//   ⌘/Ctrl+Enter · save a queued turn   SessionQueue.tsx `QueueEditor`  ┘
//        hosts: /platform (PlatformSessionTile) · /terminals · /overview · /session/:id (TerminalTile)
//   ⌘/Ctrl+Enter · save a startup prompt  AgentPromptEditor.tsx — host: /platform ONLY (PlatformView)
//   ⌘/Ctrl+F     · scoped in-doc find     DocFind.tsx — host: /repository › Files (pages/Vault.tsx)
//   ⌘/Ctrl+V,+C  · smart clipboard        Terminal.tsx `attachCustomKeyEventHandler` — the TerminalPane
//        in every host above, plus the Companion node's read-only Terminal tab.
//   (⌘/Ctrl+K — CommandPalette — is already covered for both shells by P1-5's
//    atlas-shell-chrome.spec.ts, and Escape-to-dismiss by lib/useDismissable.ts everywhere. Neither is
//    re-tested here.)
//
// ONE of those hosts was REBUILT in phase 2: /platform (card c07ff42a, P2-4) is now a five-tab node, and
// its Home tab carries the agent cards (AgentPromptEditor) AND the live session tiles (Composer +
// SessionQueue + TerminalPane) — so it hosts FOUR of the six shortcuts inside a rebuilt frame. Every
// other host is a phase-1 verbatim mount: /terminals and /overview are NAV_PAGES destinations both
// shells map from the one declaration in src/nav.tsx, /repository likewise, and /session/:id is a
// PARAM_PAGES address with NO tree node at all (P2-7, the session node, is mockups-only so far — so the
// session-cockpit copy of these shortcuts is reached through that param route under BOTH shells and
// moves only when P2-7 lands). That is why the weight of this spec sits on /platform: it is the one
// frame where a rebuild could have dropped a handler.
//
// WHY EVERY TEST RUNS TWICE. The Atlas rule for this epic is two assertions per behaviour — it works
// with the switch ON, and the classic shell is untouched with it OFF — so each test below is generated
// for both states by the SHELLS loop, and `openShell` proves exactly one shell is mounted before
// anything else is asserted.
//
// NO RENDER-ONLY CHECKS. Every leg presses the real key and asserts an observable before/after state
// change (a cleared composer, a persisted prompt read back over REST, a new preset row, a rewritten
// queue entry, an open find bar with a painted match, a control byte present or absent on the wire) —
// and every leg pairs it with the discriminator that proves the MODIFIER is what did it: a plain Enter
// that must NOT submit, or a control byte that must still reach the wire.
//
// HERMETIC: no real claude is ever spawned. Live sessions are `seedLiveSession` rows with a canned,
// no-process pty (fixtures/daemon.ts), the vault leg writes real .md files into its own mkdtemp dir and
// POSTs a project at it (the vault.spec.ts recipe), and the one shared row this spec mutates — the
// reserved Platform operator agent's own startupPrompt — is captured and restored over REST.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const rail = (page: Page) => page.locator(".loom-rail");
const atlasShell = (page: Page) => page.getByTestId("atlas-shell");

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Temp vault/repo roots this spec seeds, torn down together at the end (the fixture cleans only its own
// scratch; dirs we mkdtemp here are ours to remove).
const seededDirs: string[] = [];
test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Only ever seeded ON. OFF is the default (an untouched context has an empty key), and `addInitScript`
// re-runs on EVERY navigation including reload() — so a "seed off" script would silently re-clear the
// key mid-test (measured on card 757c80dd, and again in the other polarity on card e47df20a).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Pins the active project, but only while the key is still absent: addInitScript re-runs on every
// navigation, so an unconditional write would re-pin on a later leg and measure the helper, not the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * Land on `path` under the requested switch state and prove EXACTLY ONE shell is mounted.
 *
 * Presence-first: the positive half is asserted BEFORE the negative half, because a leading count-0 also
 * passes on a page that has not rendered anything yet — which would make every "the other shell is gone"
 * claim vacuous on a slow load. (Same helper shape as atlas-shell-chrome.spec.ts; copied rather than
 * shared because each Atlas spec owns its own, and a shared one would couple their load contracts.)
 */
async function openShell(page: Page, baseURL: string, atlas: boolean, path: string): Promise<void> {
  if (atlas) await seedAtlasOn(page);
  await page.goto(baseURL + path);
  await expect(atlas ? atlasShell(page) : rail(page)).toBeVisible();
  await expect(atlas ? rail(page) : atlasShell(page)).toHaveCount(0);
}

// ── Shared seeding: the reserved Platform home's operator agent + a canned-pty session on it ─────────
// Resolved exactly as PlatformView's end-user edition resolves it (the fixture boots LOOM_DEV=0, so
// GET /api/platform/home returns `project: null` (card 8d82be67 — the route is always 200) and the page
// renders the shipping edition off GET /api/setup/home) — the
// same resolution terminal-queue-ledger.spec.ts and composer-preset-insert.spec.ts already use.
type HomeAgent = { id: string; name: string; profileId: string | null; startupPrompt: string };
type SetupHome = { project: { id: string; name: string }; agents: HomeAgent[] };

async function platformOperator(baseURL: string): Promise<{ home: SetupHome; operator: HomeAgent }> {
  const home = (await (await fetch(`${baseURL}/api/setup/home`)).json()) as SetupHome;
  const profiles = (await (await fetch(`${baseURL}/api/profiles`)).json()) as { id: string; role: string }[];
  const roleOf = (a: HomeAgent) => profiles.find((p) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a) => roleOf(a) === "setup") ?? home.agents.find((a) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();
  return { home, operator: operator! };
}

// A distinctive session id PREFIX, so the tile's rendered short id (`id.slice(0, 8)`) identifies THIS
// spec's session rather than the fixture's default "e2e-live" that every other seeded row also shows.
// Fixture identity matters here beyond tidiness: a sibling worker's dev server renders this app
// identically, so the short id is what pins which data the assertions below are reading.
const SHORT_ID = "kbdshort";

async function seedOperatorTerminal(loomDaemon: LoomDaemon, bytes: string) {
  const { home, operator } = await platformOperator(loomDaemon.baseURL);
  const seeded = await loomDaemon.seedLiveSession({
    id: `${SHORT_ID}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    // A production-like 120x40 grid: the terminal hugs its grid, so the composer sits flush beneath it
    // and the tile's height budget settles instead of letterboxing.
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: bytes,
  });
  return { home, operator, sessionId: seeded.sessionId };
}

/** Land on the Platform node/page with this spec's seeded tile rendered and the font scale settled. */
async function openPlatformWithTile(page: Page, baseURL: string, atlas: boolean): Promise<void> {
  await openShell(page, baseURL, atlas, "/platform");
  // Identity first: this is THIS spec's seeded session, not a leftover or a sibling worker's.
  await expect(page.getByText(new RegExp(SHORT_ID)).first()).toBeVisible();
  await expect(page.locator(".xterm-screen")).toHaveCount(1);
  // The height-budget measure + xterm font scale settle before any pointer interaction; the corner
  // controls sit over the terminal and jitter sub-pixel until they do (see composer-preset-insert.spec).
  await page.waitForTimeout(700);
}

const composerBox = (page: Page) => page.getByPlaceholder("Send a turn to this session", { exact: false });
const sendTurn = (page: Page) => page.getByRole("button", { name: "Send turn" });

const SHELLS = [
  { name: "switch OFF (classic)", atlas: false },
  { name: "switch ON (Atlas)", atlas: true },
] as const;

for (const shell of SHELLS) {
  test.describe(`keyboard shortcuts — ${shell.name} (card a1c6e339)`, () => {
    // ── 1. ⌘/Ctrl+Enter in the session COMPOSER ────────────────────────────────────────────────────
    // BOTH modifiers, because the handler is `e.metaKey || e.ctrlKey` and a single-modifier test passes
    // with the other half broken (the same reasoning atlas-shell-chrome.spec.ts gives for ⌘K/Ctrl+K).
    // The plain-Enter leg first is the discriminator: Enter alone inserts a newline and must NOT send,
    // so a handler that fired on bare Enter — or a box cleared by anything other than a successful
    // send — fails here rather than passing the two modifier legs for the wrong reason.
    test("the composer sends on ⌘/Ctrl+Enter, and not on a bare Enter", async ({ page, loomDaemon }) => {
      await seedOperatorTerminal(loomDaemon, "LOOM-KBD-COMPOSER\r\ncmd+enter sends this turn\r\n");
      await openPlatformWithTile(page, loomDaemon.baseURL, shell.atlas);

      const box = composerBox(page);
      await expect(box).toBeVisible();
      await expect(box).toHaveValue("");
      await expect(sendTurn(page)).toBeDisabled();

      // (a) BARE ENTER MUST NOT SEND. The box keeps the draft (plus the newline Enter inserted) and Send
      // stays enabled — a send would have cleared it.
      const first = uniq("KBD-ENTER-ALONE");
      await box.click({ force: true });
      await box.fill(first);
      await box.press("Enter");
      await expect(box).toHaveValue(new RegExp(first));
      await expect(sendTurn(page)).toBeEnabled();

      // (b) ⌘+Enter SENDS. The box clears and Send disables again — Composer clears only in
      // `send.onSuccess` (delivered or queued), so an empty box here IS the send.
      await box.press("Meta+Enter");
      await expect(box).toHaveValue("");
      await expect(sendTurn(page)).toBeDisabled();

      // (c) Ctrl+Enter SENDS TOO — the other half of the `||`. This one lands while the session is busy
      // from (b), so it is HELD rather than delivered; both branches clear the box, which is the point.
      const second = uniq("KBD-CTRL-ENTER");
      await box.fill(second);
      await expect(box).toHaveValue(new RegExp(second));
      await box.press("Control+Enter");
      await expect(box).toHaveValue("");
      await expect(sendTurn(page)).toBeDisabled();
    });

    // ── 2. ⌘/Ctrl+Enter in the PRESET editor ───────────────────────────────────────────────────────
    // The preset editor lives inside the composer's own "Preset prompts" popover, so it is only
    // reachable through a mounted Composer — which is why it shares this host.
    test("the preset editor saves on ⌘/Ctrl+Enter, and not on a bare Enter", async ({ page, loomDaemon }) => {
      await seedOperatorTerminal(loomDaemon, "LOOM-KBD-PRESET\r\ncmd+enter saves the preset\r\n");
      await openPlatformWithTile(page, loomDaemon.baseURL, shell.atlas);

      const LABEL = uniq("KBD preset");
      const PROMPT = uniq("KBD-PRESET-BODY: saved from the keyboard");
      let createdId: string | null = null;

      try {
        await page.getByRole("button", { name: "Preset prompts" }).first().click({ force: true });
        const dialog = page.getByRole("dialog", { name: "Preset prompts" });
        await expect(dialog).toBeVisible();

        // BEFORE: no preset by this label exists. Scoped to the dialog — the prompt text would otherwise
        // also match the composer box once a later leg inserts it.
        await expect(dialog.getByText(LABEL, { exact: true })).toHaveCount(0);

        // `force` bypasses the actionability "stable" check: the popover is positioned over the
        // composer, which sits over the terminal, whose font settle jitters it sub-pixel indefinitely
        // (MEASURED — 57 stability retries then a timeout on the classic layout without this).
        await dialog.getByRole("button", { name: "+ Add" }).click({ force: true });
        const labelField = dialog.getByPlaceholder("Run tests");
        const promptField = dialog.getByPlaceholder("The prompt text sent to the session…");
        await expect(labelField).toBeVisible();
        await labelField.fill(LABEL);
        await promptField.fill(PROMPT);

        // (a) BARE ENTER MUST NOT SAVE: it adds a newline to the prompt and the form stays open.
        await promptField.press("Enter");
        await expect(promptField).toBeVisible();
        await expect(dialog.getByText(LABEL, { exact: true })).toHaveCount(0);

        // (b) ⌘+Enter SAVES: PresetForm's onSuccess calls onDone() (the form unmounts) and invalidates
        // the list, so the new row appears. Two independent observables for one mutation.
        await promptField.press("Meta+Enter");
        await expect(dialog.getByText(LABEL, { exact: true })).toBeVisible();
        await expect(dialog.getByPlaceholder("The prompt text sent to the session…")).toHaveCount(0);

        // ...and it really persisted, not just re-rendered from local state.
        const presets = (await (await fetch(`${loomDaemon.baseURL}/api/preset-prompts`)).json()) as
          { id: string; label: string; prompt: string }[];
        const mine = presets.find((p) => p.label === LABEL);
        expect(mine, "the keyboard save should have reached the daemon").toBeTruthy();
        createdId = mine!.id;
        expect(mine!.prompt).toContain("KBD-PRESET-BODY");
      } finally {
        // Preset prompts are daemon-global and the worker daemon is SHARED across every spec file, so
        // this row would otherwise leak into every later popover. Nothing else here mutates shared state.
        if (createdId) {
          await fetch(`${loomDaemon.baseURL}/api/preset-prompts/${createdId}`, { method: "DELETE" })
            .catch(() => { /* best-effort cleanup */ });
        }
      }
    });

    // ── 3. ⌘/Ctrl+Enter in the QUEUE editor ────────────────────────────────────────────────────────
    // Reaching the queue editor needs a genuinely HELD entry, which needs the session busy: the first
    // POST /input delivers and arms busy (reconcile() skips canned entries, so busy never self-clears),
    // the second is held in the FIFO. Exactly the recipe terminal-queue-ledger.spec.ts uses.
    test("the queue editor saves an edited queued message on ⌘/Ctrl+Enter, and not on a bare Enter", async ({ page, loomDaemon }) => {
      const { sessionId } = await seedOperatorTerminal(loomDaemon, "LOOM-KBD-QUEUE\r\ncmd+enter saves the queued edit\r\n");

      const send = (text: string) =>
        fetch(`${loomDaemon.baseURL}/api/sessions/${sessionId}/input`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).then((r) => r.json() as Promise<{ delivered: boolean; position?: number }>);

      const ORIGINAL = uniq("KBD-QUEUED-ORIGINAL");
      expect((await send("first turn — delivers and arms busy")).delivered).toBe(true);
      expect((await send(ORIGINAL)).delivered).toBe(false); // held in the FIFO

      await openPlatformWithTile(page, loomDaemon.baseURL, shell.atlas);

      // The ledger bar appears on SessionQueue's own 3s poll.
      await expect(page.getByText(/Queued \(1\)/)).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("queue-ledger-bar").click({ force: true });
      const drawer = page.getByTestId("queue-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText(ORIGINAL)).toBeVisible();

      // `force` for the same reason the ledger-bar click above takes it: the drawer hangs below the
      // terminal, so the xterm font settle keeps every control in it jittering sub-pixel.
      await drawer.getByTitle("Edit this queued message").first().click({ force: true });
      // QueueEditor seeds its draft from the entry and autofocuses — so the editor is identified by the
      // text it is holding, not by position in the drawer.
      const editor = drawer.locator("textarea");
      await expect(editor).toHaveValue(ORIGINAL);

      const REWRITTEN = uniq("KBD-QUEUED-REWRITTEN");
      await editor.fill(REWRITTEN);

      // (a) BARE ENTER MUST NOT SAVE: the editor stays open and the STORED entry is untouched. Read the
      // daemon's own FIFO rather than the drawer here — the drawer's only copy of this text right now is
      // the textarea's VALUE, and Playwright's text engine does not match a textarea value, so a DOM
      // `toHaveCount(0)` would pass whether or not the save had fired.
      await editor.press("Enter");
      await expect(editor).toBeVisible();
      expect(await queuedTexts(loomDaemon.baseURL, sessionId)).toContain(ORIGINAL);
      expect(await queuedTexts(loomDaemon.baseURL, sessionId)).not.toContain(REWRITTEN);

      // The newline Enter just inserted would ride into the saved text; drop it so the stored value is
      // exactly the sentinel (the editor is ours, so this destroys no user input).
      await editor.fill(REWRITTEN);

      // (b) ⌘+Enter SAVES: edit.onSuccess clears editingId (the editor unmounts) and the row re-renders
      // with the new text — which the drawer CAN show, because a settled row renders its text as a span.
      await editor.press("Meta+Enter");
      await expect(drawer.locator("textarea")).toHaveCount(0);
      await expect(drawer.getByText(REWRITTEN, { exact: false })).toBeVisible();
      await expect(drawer.getByText(ORIGINAL, { exact: false })).toHaveCount(0);

      // ...and the daemon's own FIFO holds the rewrite, not just the rendered row.
      expect(await queuedTexts(loomDaemon.baseURL, sessionId)).toContain(REWRITTEN);
    });

    // ── 4. ⌘/Ctrl+Enter in the AGENTS editor (a reserved-home agent's startup prompt) ──────────────
    // The one editor with a SINGLE host, and that host is the rebuilt Platform node. BOTH modifiers are
    // exercised, same reasoning as the composer: two successive saves cost one extra keystroke here.
    test("the agents editor saves a startup prompt on ⌘/Ctrl+Enter, and not on a bare Enter", async ({ page, loomDaemon }) => {
      const { operator } = await platformOperator(loomDaemon.baseURL);
      const original = operator.startupPrompt;

      const readPrompt = async () => {
        const home = (await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json()) as SetupHome;
        return home.agents.find((a) => a.id === operator.id)?.startupPrompt ?? null;
      };
      const writePrompt = (text: string) =>
        fetch(`${loomDaemon.baseURL}/api/agents/${operator.id}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ startupPrompt: text }),
        });

      try {
        await openShell(page, loomDaemon.baseURL, shell.atlas, "/platform");

        // IDENTITY, not position. platform.spec.ts addresses this disclosure as `.first()` and calls it
        // "the operator's"; that is a DOM-order guess. Expanding it and matching the textarea against
        // the value REST says the operator agent holds is what actually pins which agent is being
        // edited — and it is the same check that would catch the editor being wired to the wrong agent.
        const disclosure = page.getByRole("button", { name: /startup prompt/i }).first();
        await expect(disclosure).toBeVisible();
        await disclosure.click();
        const field = page.getByPlaceholder("The kickoff prompt this agent boots with…");
        await expect(field).toBeVisible();
        await expect(field).toHaveValue(original);

        // (a) BARE ENTER MUST NOT SAVE: it adds a newline, the editor stays dirty, nothing persists.
        const typo = `${original}\nKBD-NEVER-SAVED`;
        await field.fill(typo);
        await field.press("Enter");
        await expect(page.getByText("unsaved changes")).toBeVisible();
        expect(await readPrompt()).toBe(original);

        // (b) ⌘+Enter SAVES. The dirty marker flips to "saved" (AgentPromptEditor re-reads the persisted
        // value locally on success) and the daemon holds the new text.
        const viaMeta = `${original}\n${uniq("KBD-SAVED-VIA-META")}`;
        await field.fill(viaMeta);
        await field.press("Meta+Enter");
        await expect(page.getByText("saved", { exact: true })).toBeVisible();
        await expect.poll(readPrompt).toBe(viaMeta);

        // (c) Ctrl+Enter SAVES TOO — the other half of the `||`, from a now-clean editor.
        const viaCtrl = `${original}\n${uniq("KBD-SAVED-VIA-CTRL")}`;
        await field.fill(viaCtrl);
        await expect(page.getByText("unsaved changes")).toBeVisible();
        await field.press("Control+Enter");
        await expect(page.getByText("saved", { exact: true })).toBeVisible();
        await expect.poll(readPrompt).toBe(viaCtrl);
      } finally {
        // The reserved Platform home's operator agent is a SHARED row on the worker-scoped daemon and
        // nothing in the fixture's auto-isolation restores it — so this test puts it back itself.
        await writePrompt(original).catch(() => { /* best-effort restore */ });
      }
    });

    // ── 5. ⌘/Ctrl+F — the Vault's scoped in-document find ──────────────────────────────────────────
    // DocFind binds a WINDOW keydown but gates it on `isDocActive()` (focus or the last pointerdown
    // inside the doc's scroll container), so the two halves of this test are one behaviour: it opens
    // when the doc is the active region, and it leaves the browser's native find alone when it is not.
    // Both halves matter — an unconditional handler would hijack ⌘F across the whole app.
    test("⌘/Ctrl+F opens the Vault's scoped find bar and paints a match — and does nothing outside the doc", async ({ page, loomDaemon }) => {
      const NEEDLE = uniq("KBDFIND");
      const { id } = await seedVaultProject(loomDaemon.baseURL, {
        "Find-Me.md": `# Keyboard find fixture\n\nThe scoped finder should land on ${NEEDLE} exactly once.\n`,
      });
      await pinProject(page, id);
      await openShell(page, loomDaemon.baseURL, shell.atlas, "/repository");

      const noteRow = page.locator("button.loom-tree-row").filter({ hasText: "Find-Me.md" });
      await expect(noteRow).toBeVisible();

      const findField = page.getByLabel("Find in document");
      await expect(findField).toHaveCount(0);

      // (a) OUTSIDE THE DOC: the last pointerdown landed on the tree row, which is NOT inside DocFind's
      // container, so ⌘F must fall through to the browser and open nothing of ours.
      await noteRow.click();
      await expect(page.getByRole("heading", { name: "Keyboard find fixture" })).toBeVisible();
      await page.keyboard.press("Meta+f");
      await expect(findField).toHaveCount(0);

      // (b) INSIDE THE DOC: click the rendered body, then ⌘F opens the bar. The count-0 above is what
      // makes this meaningful — the same locator resolves on this page the moment the gate is satisfied.
      await page.getByRole("heading", { name: "Keyboard find fixture" }).click();
      await page.keyboard.press("Meta+f");
      await expect(findField).toBeVisible();
      await expect(findField).toBeFocused();

      // (c) It FINDS: type the needle and the bar's own readout reports one match of one...
      await findField.fill(NEEDLE);
      const bar = page.locator(".loom-docfind");
      await expect(bar.getByText("1/1")).toBeVisible();
      // ...and the match is really PAINTED, not merely counted. DocFind registers CSS Custom Highlight
      // ranges under these two keys (one for all matches, one for the active one); reading the registry
      // is the only DOM-visible witness that the highlight exists, since a Highlight paints no element.
      await expect.poll(() => page.evaluate(() => {
        const reg = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
        return [reg?.get("loom-find")?.size ?? -1, reg?.get("loom-find-active")?.size ?? -1];
      })).toEqual([1, 1]);

      // (d) Ctrl+F reaches it too — the other half of the `||` — from a bar closed in between.
      await page.getByLabel("Close find").click();
      await expect(findField).toHaveCount(0);
      await page.getByRole("heading", { name: "Keyboard find fixture" }).click();
      await page.keyboard.press("Control+f");
      await expect(findField).toBeVisible();
    });

    // ── 6. The terminal's smart clipboard (⌘/Ctrl+V and ⌘/Ctrl+C) ──────────────────────────────────
    // Terminal.tsx is reused verbatim by every host, so this leg is "prove it still fires in the new
    // frame" rather than a rebuild check. Its observables are byte-level: what does and does not reach
    // the /ws/term socket. Both absence claims below are preceded by a positive control on the SAME
    // page at the SAME moment — an empty recording reads identically to a broken recorder.
    test("the terminal's smart clipboard still fires: ⌘/Ctrl+V swallows the raw byte, ⌘/Ctrl+C copies or interrupts", async ({ page, loomDaemon }) => {
      await recordStdinFrames(page);
      await recordClipboardWrites(page);
      await seedOperatorTerminal(loomDaemon, "LOOM-KBD-CLIPBOARD selectable words here\r\n");
      await openPlatformWithTile(page, loomDaemon.baseURL, shell.atlas);

      expect(await page.evaluate(() => !!navigator.clipboard),
        "this origin must expose navigator.clipboard, or the copy assertion below is vacuous").toBe(true);

      const screen = page.locator(".xterm-screen").first();
      await screen.click({ force: true });

      // (a) POSITIVE CONTROL + the SIGINT half: with NOTHING selected, Ctrl+C falls through as the
      // interrupt byte. This proves the recorder records AND that the smart handler did not swallow the
      // interrupt — the failure mode an over-eager "always copy" implementation would have.
      await page.keyboard.press("Control+c");
      await expect.poll(() => stdinFrames(page).then((f) => f.join(""))).toContain("\x03");

      // (b) SECOND CONTROL: an ordinary Ctrl+<letter> still reaches the wire as its raw control byte, so
      // the absence of 0x16 in (c) is a measured absence rather than "no bytes get through at all".
      await page.keyboard.press("Control+b");
      await expect.poll(() => stdinFrames(page).then((f) => f.join(""))).toContain("\x02");

      // (c) Ctrl+V SWALLOWS the raw 0x16, so xterm's own native paste handler is free to do the paste
      // exactly once (returning false rather than calling preventDefault is what avoids the double-paste
      // bug). ⚠️ STATED LIMIT: `keyboard.press` does not synthesize a real `paste` event, so what is
      // measured here is the SWALLOW — the half that lives in Loom's handler — and not the paste that
      // follows it. Asserting the paste itself would need a system clipboard this harness does not have.
      const beforePaste = (await stdinFrames(page)).length;
      await page.keyboard.press("Control+v");
      await page.waitForTimeout(300); // give a byte that WOULD be sent time to actually be sent
      expect((await stdinFrames(page)).slice(beforePaste).join(""), "⌘/Ctrl+V must not emit the raw 0x16")
        .not.toContain("\x16");

      // (d) Ctrl+C WITH a selection COPIES instead of interrupting. Double-click selects a word (the
      // DOM renderer — the default, since Terminal.tsx loads only FitAddon — paints the selection as
      // real elements, so "a selection exists" is measurable before we press anything).
      const row = page.locator(".xterm-rows > div").first();
      const box = await row.boundingBox();
      expect(box, "the canned pty should have rendered a first row to select").toBeTruthy();
      await page.mouse.dblclick(box!.x + 8, box!.y + box!.height / 2);
      await expect.poll(() => selectionArea(page)).toBeGreaterThan(0);

      const beforeCopy = (await stdinFrames(page)).length;
      await page.keyboard.press("Control+c");
      // Copied: the handler wrote the selection to the clipboard...
      await expect.poll(() => clipboardWrites(page).then((w) => w.join("")))
        .toContain("LOOM");
      // ...and did NOT also send SIGINT, which is the whole point of "smart".
      await page.waitForTimeout(300);
      expect((await stdinFrames(page)).slice(beforeCopy).join(""),
        "a copy must not also emit the interrupt byte").not.toContain("\x03");

      // (e) THE SELECTION WAS REALLY CLEARED — witnessed through the app's own logic rather than the
      // DOM. A SECOND Ctrl+C now falls through as SIGINT and copies nothing, which is only possible if
      // `term.hasSelection()` went false. This is the behaviour the clear exists FOR: without it a
      // terminal would keep re-copying the same stale text and could never be interrupted again.
      //
      // ⚠️ Deliberately NOT asserted on the DOM, because the DOM does not agree. MEASURED on this
      // build: `.xterm-selection` holds 0 child elements at rest, 2 after the double-click, and still
      // 2 (painted, non-zero area) after the copy — while an ordinary click elsewhere does take it
      // back to 0. So `clearSelection()` clears the MODEL but the selection HIGHLIGHT stays on screen
      // until some later event repaints it. That is a real, small, pre-existing defect — identical
      // under both shells, so nothing Atlas introduced and nothing this parity card may quietly
      // assert away. Carded separately; see docs/decisions/a1c6e339-atlas-keyboard-shortcuts.md §5.
      const beforeSecond = (await stdinFrames(page)).length;
      const clipsBeforeSecond = (await clipboardWrites(page)).length;
      await page.keyboard.press("Control+c");
      await expect.poll(() => stdinFrames(page).then((f) => f.slice(beforeSecond).join("")))
        .toContain("\x03");
      expect((await clipboardWrites(page)).length,
        "with the selection cleared, a second copy must not fire").toBe(clipsBeforeSecond);
    });
  });
}

// ── Witnesses ───────────────────────────────────────────────────────────────────────────────────────

// Record every `{type:"stdin"}` frame the page puts on ANY WebSocket, by wrapping WebSocket.prototype
// .send before page scripts run. This observes the REAL /ws/term transport rather than a proxy for it,
// and it only records — the socket is never substituted, so the terminal still attaches for real.
// (The same recorder companion-terminal-readonly.spec.ts uses; copied rather than shared for the same
// reason openShell is — each spec owns its own instruments.)
async function recordStdinFrames(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __loomStdin: string[] }).__loomStdin = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
      try {
        if (typeof data === "string") {
          const msg = JSON.parse(data) as { type?: string; data?: string };
          if (msg?.type === "stdin") (window as unknown as { __loomStdin: string[] }).__loomStdin.push(msg.data ?? "");
        }
      } catch { /* binary pty bytes / non-JSON — never a stdin frame */ }
      return origSend.call(this, data);
    };
  });
}

const stdinFrames = (page: Page) => page.evaluate(() => (window as unknown as { __loomStdin: string[] }).__loomStdin ?? []);

// Record every `navigator.clipboard.writeText` the page makes, calling through so the real behaviour is
// unchanged. Recording rather than reading the OS clipboard back is deliberate: a headless context has
// no clipboard-read permission by default, and Terminal.tsx's own call is `.catch(() => {})`, so a
// rejected real write is indistinguishable from no write at all when read from the other side.
async function recordClipboardWrites(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __loomClip: string[] }).__loomClip = [];
    const clip = navigator.clipboard as Clipboard | undefined;
    if (!clip) return; // asserted against in the test — a silent skip here would make the copy leg vacuous
    const orig = clip.writeText.bind(clip);
    Object.defineProperty(clip, "writeText", {
      configurable: true,
      value: (text: string) => {
        (window as unknown as { __loomClip: string[] }).__loomClip.push(text);
        return orig(text).catch(() => { /* no clipboard permission in headless — the record is the witness */ });
      },
    });
  });
}

const clipboardWrites = (page: Page) => page.evaluate(() => (window as unknown as { __loomClip: string[] }).__loomClip ?? []);

/** The xterm selection's total painted area in px². Non-zero iff something is actually selected — the
 *  DOM renderer keeps its selection elements across a clear and zeroes their geometry instead of
 *  removing them, so counting elements cannot tell a live selection from a cleared one. */
const selectionArea = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>(".xterm-selection div")).reduce((sum, el) => {
    const r = el.getBoundingClientRect();
    return sum + r.width * r.height;
  }, 0));

/** The daemon's own view of a session's held FIFO — the authority on what a queue edit did or did not
 *  persist, independent of whatever the drawer happens to be rendering at the moment. */
async function queuedTexts(baseURL: string, sessionId: string): Promise<string> {
  const q = (await (await fetch(`${baseURL}/api/sessions/${sessionId}/queue`)).json()) as { pending: { text: string }[] };
  return q.pending.map((m) => m.text).join("\n");
}

// Seed a project whose vaultPath is a real on-disk dir holding `notes` (relative path -> markdown), then
// POST it. The vault viewer reads notes from disk (daemon vault/browser.ts), and the fixture's own
// createProject makes an EMPTY vault dir and never exposes its path — so this spec seeds its own, the
// same way vault.spec.ts does. The repo dir is git-init'd to mirror createProject.
async function seedVaultProject(baseURL: string, notes: Record<string, string>): Promise<{ id: string }> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-kbd-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);

  for (const [rel, content] of Object.entries(notes)) {
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  const res = await fetch(`${baseURL}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("kbd-vault"), repoPath: repoDir, vaultPath: vaultDir }),
  });
  if (!res.ok) throw new Error(`POST /api/projects -> ${res.status}: ${await res.text()}`);
  return { id: ((await res.json()) as { id: string }).id };
}
