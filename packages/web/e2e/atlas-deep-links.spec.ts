// The two query-param deep links, verified against the ATLAS URL scheme (card 3ed3dc31, Atlas build
// plan P2-10: docs/plans/atlas-ui/03-decomposition.md row P2-10). Closes parity gap §J.5 —
// `01-parity-checklist.md` §G listed both rows as "NOT VERIFIED AGAINST ATLAS'S OWN URL SCHEME".
//
//   `?task=<id>`                      → opens THAT card's dialog (pages/Board.tsx)
//   `?profile=<id>&grant=<connId>`    → pre-selects THAT profile with the connection pre-ticked,
//                                       unsaved (pages/Profiles.tsx, card 12dc7fc9)
//
// Neither param is read by the Atlas frame; both are consumed by the page component, which phase 1
// mounts verbatim under both shells. So the question this spec answers is NOT "does Board still read
// searchParams" — it is whether the ATLAS ADDRESSES those pages now live at still deliver the param,
// and whether a node that owns its OWN `?tab=` can share one URL with a page-level deep link without
// either consumer eating the other's. That second half is genuinely new under Atlas: the classic
// shell has no address where a frame-level tab and a card deep link coexist.
//
// Surfaces covered, and why each one:
//   1. `/board?task=`                      the Board node — the address the classic link already used.
//   2. `/project?task=`                    the project node (ATLAS-ONLY, card fd99b2d7) — its Overview
//                                          tab embeds the whole <Board>, so the link must land here too.
//   3. `/project?tab=deck&task=`           the coexistence case: the node's own tab param and the
//                                          card param on one URL. Asserts `tab=deck` SURVIVES the
//                                          board consuming `task` — a `setSearchParams({})` that
//                                          rebuilt the query instead of deleting one key would drop it.
//   4. `/platform?tab=board&task=`         the other Atlas node with its own `?tab=`, and the one whose
//                                          panels all stay MOUNTED (PlatformView.tsx) — so its board is
//                                          live even on a different tab and could consume the param
//                                          where nobody can see the dialog.
//   5. `/actors?tab=profiles&profile=&grant=`  the profile deep link, on the Actors node.
//   6. a LEGACY REDIRECT (`/profiles?...`) — parity, not function: `nav.tsx`'s `redirect()` builds a
//                                          plain path `<Navigate>`, so the incoming query is DROPPED.
//                                          That is what it has always done; the row asserts BOTH
//                                          shells still drop it identically, so nobody later "fixes"
//                                          one side into a divergence. (`?task=` has no legacy
//                                          redirect at all — no LEGACY_REDIRECTS row targets /board.)
//
// Every leg is FRESHLY LOADED: a real `page.goto` of the deep link itself, never a click-through from
// a page that already holds the state. Each test gets its own browser context, so there is no prior
// client state to begin with.
//
// WHICH card / WHICH profile is the load-bearing half, so every leg seeds a DECOY alongside the
// target and asserts the decoy is NOT what landed. A spec that only checks "a dialog opened" passes
// against a board that opens the first card it finds.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there before what must not.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, gotoActorsReady, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const VIEWPORT = { width: 1400, height: 1000 };

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a later goto and that leg would measure this helper (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

type SeededCard = { id: string; title: string };

/**
 * Two cards on one board: the one the deep link names, and a DECOY that proves the dialog is the
 * target's and not merely "whichever card the board opened". The decoy is seeded FIRST so it is the
 * older row — a board that fell back to opening something would reach for it, not the target.
 */
async function seedDecoyAndTarget(loomDaemon: LoomDaemon, projectId: string): Promise<{ decoy: SeededCard; target: SeededCard }> {
  const decoyTitle = uniq("deeplink-DECOY");
  const targetTitle = uniq("deeplink-TARGET");
  const decoy = await loomDaemon.createTask(projectId, { title: decoyTitle, body: `body ${decoyTitle}`, columnKey: "todo" });
  const target = await loomDaemon.createTask(projectId, { title: targetTitle, body: `body ${targetTitle}`, columnKey: "todo" });
  return { decoy: { id: decoy.id, title: decoyTitle }, target: { id: target.id, title: targetTitle } };
}

/**
 * The deep link landed on the RIGHT card. The short id in the dialog header (`Task · xxxxxxxx`) is the
 * discriminator — titles are not unique board text (a child card renders its parent's title as a chip,
 * card 1ae4f88c), whereas the drawer header's id names exactly one row. The decoy's id is asserted
 * ABSENT from the same dialog, so "a dialog opened" can never satisfy this.
 */
async function assertDialogIsCard(page: Page, target: SeededCard, decoy: SeededCard) {
  const dialog = page.getByRole("dialog");
  await expect(dialog, "the deep link opened a detail dialog").toBeVisible();
  await expect(dialog.getByText(`Task · ${target.id.slice(0, 8)}`), "the dialog is the DEEP-LINKED card's").toBeVisible();
  // The title rides an editable Input (pages/Board.tsx, inside `task-edit-column`), not body text — so
  // it is read as a VALUE. Two independent fields of the same row, which is the point: a dialog showing
  // one card's id beside another card's title would be a cache hand-off bug this would catch.
  await expect(dialog.getByTestId("task-edit-column").locator("input").first(), "…carrying that card's own title")
    .toHaveValue(target.title);
  await expect(dialog.getByText(`Task · ${decoy.id.slice(0, 8)}`), "…and not the decoy's").toHaveCount(0);
}

test.describe("Atlas deep links (card 3ed3dc31)", () => {
  // ── 1. The Board node ───────────────────────────────────────────────────────────────────────────
  test("switch ON: ?task= on the Board node opens that card's dialog and clears only the task param", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdeep-board"));
    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(target.id)}`);

    // PRESENCE first: the ATLAS frame is really what mounted, so this leg cannot be measuring the
    // classic shell with the switch quietly off.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.locator(".loom-rail")).toHaveCount(0);

    await assertDialogIsCard(page, target, decoy);

    // The param is CONSUMED — a later close/reopen must not re-open it — and the address stays the
    // Atlas node's own, with no navigation away from it.
    await expect(page).toHaveURL(/\/board$/);
    expect(page.url(), "the consumed ?task= is cleared").not.toContain("task=");

    // Closing works in place: the Atlas frame is still the frame, no route change.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page).toHaveURL(/\/board$/);
  });

  // ── 2 + 3. The project node, and the tab/task coexistence case ──────────────────────────────────
  test("switch ON: ?task= on the project node opens that card's dialog, and ?tab=deck survives it", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdeep-project"));
    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);

    // ── Overview tab (the node's default, no tab param at all) ──
    await page.goto(`${loomDaemon.baseURL}/project?task=${encodeURIComponent(target.id)}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId("atlas-board-embed"), "the project node's embedded board").toBeVisible();
    await assertDialogIsCard(page, target, decoy);
    await expect(page).toHaveURL(/\/project$/);
    expect(page.url()).not.toContain("task=");
    // The CONTROL for the tab-identity check below: the two tabs are told apart by which KPI readout
    // renders (card fd99b2d7 — Overview keeps the 26px `.loom-kpideck`, the board-first Deck gets the
    // compact `.loom-kpistrip`), so here the pair is asserted INVERTED. Without this, "the Deck is
    // still showing" could be satisfied by a locator that is simply always present.
    await expect(page.locator(".loom-kpideck"), "the Overview tab's own readout").toBeVisible();
    await expect(page.locator(".loom-kpistrip")).toHaveCount(0);

    // ── Deck tab: the node's OWN param and the card param on one URL ──
    // A fresh document load, not a tab click, so the two params arrive together exactly as a pasted
    // link would deliver them.
    await page.goto(`${loomDaemon.baseURL}/project?tab=deck&task=${encodeURIComponent(target.id)}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertDialogIsCard(page, target, decoy);

    // THE coexistence assertion: `task` is gone, `tab=deck` is NOT. Board clears its own key with
    // `p.delete("task")`; a `setSearchParams({})` that rebuilt the query would have taken the tab with
    // it and silently bounced the reader back to Overview.
    await expect(page).toHaveURL(/\/project\?tab=deck$/);
    expect(page.url()).not.toContain("task=");
    // …and the Deck is still the tab actually SHOWING, not merely the one still named in the URL.
    // The KPI strip is the Deck's own readout; Overview renders the taller KPI deck instead.
    await expect(page.locator(".loom-kpistrip"), "still on the Deck tab after the card param was consumed").toBeVisible();
    await expect(page.locator(".loom-kpideck")).toHaveCount(0);
  });

  // ── 4. The Platform node — the other `?tab=` owner, and the always-mounted one ───────────────────
  test("switch ON: ?task= on the Platform node's Board tab opens that card's dialog", async ({ page, loomDaemon }) => {
    // The Platform node's board is the RESERVED home's, never the active project's (card fa3bb729),
    // so both cards have to be seeded THERE — and removed after: that board is shared with every other
    // spec on this worker's daemon (card 1d3192dc trap 1).
    const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` } });
    expect(res.ok, `GET /api/setup/home -> ${res.status}`).toBe(true);
    const home = (await res.json()) as { project: { id: string; name: string } };
    expect(home.project.name, "the reserved home this leg seeds into").toBe("Platform");

    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, home.project.id);
    // A SECOND project, pinned active, so "the Platform board's card opened" cannot be satisfied by
    // the active project's board having been rendered here instead.
    const other = await loomDaemon.createProject(uniq("atlasdeep-zulu"));

    try {
      await seedAtlasOn(page);
      await pinProject(page, other.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=board&task=${encodeURIComponent(target.id)}`);

      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("platform-panel-board"), "the Platform node's Board tab").toBeVisible();
      await assertDialogIsCard(page, target, decoy);

      // Same coexistence rule as the project node: the tab the link named is still the tab showing.
      await expect(page).toHaveURL(/\/platform\?tab=board$/);
      expect(page.url()).not.toContain("task=");
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/tasks/${target.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${loomDaemon.baseURL}/api/tasks/${decoy.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 5. The profile + grant deep link ────────────────────────────────────────────────────────────
  test("switch ON: ?profile=&grant= pre-selects that profile with the connection unsaved, and Save confirms rather than grants", async ({ page, loomDaemon }) => {
    const base = loomDaemon.baseURL;
    const connection = await apiJson<{ id: string; name: string }>(`${base}/api/connections`, {
      method: "POST",
      body: JSON.stringify({ name: uniq("E2E Deeplink Conn"), host: "api.example-deeplink.test", authScheme: "api-key", secret: `sk_${Date.now()}` }),
    });
    // A DECOY profile alongside the target: "the editor opened" is not the claim — "it opened the one
    // the URL named" is, and only a second profile can tell those apart.
    const decoyProfile = await apiJson<{ id: string; name: string }>(`${base}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Decoy Rig") }),
    });
    const profile = await apiJson<{ id: string; name: string }>(`${base}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Target Rig") }),
    });
    // An agent BOUND to the target profile is what makes the grant-reach confirm fire at all: with
    // nobody bound, `planGrantSave` returns a plain `save` (lib/profileGrantReach.ts) and the grant
    // would land straight away — a legitimate outcome, but not the one this card asks to witness.
    const project = await loomDaemon.createProject(uniq("atlasdeep-actors"));
    const agent = await apiJson<{ id: string; name: string }>(`${base}/api/projects/${project.id}/agents`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Bound Agent"), startupPrompt: "" }),
    });
    await apiJson(`${base}/api/agents/${agent.id}`, { method: "POST", body: JSON.stringify({ profileId: profile.id }) });

    try {
      await seedAtlasOn(page);
      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);
      // `gotoActorsReady` (fixtures/daemon.ts) waits for the editor's own `GET /api/agents` to land.
      // Without it, `planGrantSave` fails CLOSED on an unresolved list (@decision 3c4e0df6) and Save
      // would open `confirm-unknown` — the right panel, reached for the wrong reason, which would make
      // the assertion below pass without the reach ever having been computed.
      const deepLink = `/actors?tab=profiles&profile=${encodeURIComponent(profile.id)}&grant=${encodeURIComponent(connection.id)}`;
      await gotoActorsReady(page, base, deepLink);

      // PRESENCE first: the Atlas frame, then the Profiles tab under it.
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.locator(".loom-rail")).toHaveCount(0);

      // THE RIGHT PROFILE. The editor's Name field holds the stored row's name, so it names which
      // profile actually mounted — and the decoy's name proves the check discriminates. (Compared on
      // the input's VALUE, not the editor's `<strong>` header: that header is CSS-uppercased, and
      // `innerText` folds `text-transform` in while `toHaveText` does not — card 82bde849 gotcha 1.)
      const nameField = page.getByLabel("Name", { exact: true });
      await expect(nameField).toHaveValue(profile.name);
      expect(profile.name).not.toBe(decoyProfile.name);
      await expect(nameField).not.toHaveValue(decoyProfile.name);

      // THE GRANT IS PRE-SELECTED, NOT GRANTED. The banner is the editor's own statement of that.
      await expect(page.getByText(/is pre-selected below/)).toBeVisible();
      await expect(page.getByText(connection.name, { exact: false }).first()).toBeVisible();

      // …and the stored row still carries nothing, read back over REST rather than inferred from the UI.
      const atRest = await apiJson<{ connections?: string[] }>(`${base}/api/profiles/${profile.id}`);
      expect(atRest.connections ?? [], "arriving on the deep link grants nothing").not.toContain(connection.id);

      // THE FAIL-CLOSED CONFIRM IS INTACT UNDER ATLAS (@decision 3c4e0df6). Save does not write — it
      // opens the blast-radius confirm naming the bound agent, because a profile is global.
      await expect(page.getByTestId("grant-reach-confirm")).toHaveCount(0);
      await page.getByRole("button", { name: "Save", exact: true }).click();

      const confirm = page.getByTestId("grant-reach-confirm");
      await expect(confirm, "Save opens the grant-reach confirm instead of writing").toBeVisible();
      await expect(confirm.getByTestId("grant-reach-count")).toHaveText(/1 agent\b/);
      await expect(confirm.getByTestId("grant-reach-agents")).toContainText(agent.name);

      // The observable that makes "it does not auto-grant" a real claim: still nothing stored.
      const afterSaveClick = await apiJson<{ connections?: string[] }>(`${base}/api/profiles/${profile.id}`);
      expect(afterSaveClick.connections ?? [], "the click opened a confirm, it did not grant").not.toContain(connection.id);
    } finally {
      await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/profiles/${decoyProfile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/connections/${connection.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 6. The legacy redirect — a PARITY row, not a working deep link ───────────────────────────────
  test("both shells: a legacy redirect drops the deep-link query identically", async ({ page, loomDaemon }) => {
    // Asserted against the REAL declaration so this leg can never quietly test a dead URL: if
    // /profiles stops redirecting to /actors, this fails here rather than passing on a 404 page.
    const src = readFileSync(NAV_SOURCE, "utf8");
    const start = src.indexOf("export const LEGACY_REDIRECTS");
    expect(start, `no LEGACY_REDIRECTS declaration in ${NAV_SOURCE}`).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, src.indexOf("\n];", start));
    expect(block, "the row this leg exercises").toContain(`redirect("/profiles", "/actors")`);
    // The positive control for that substring check: the same pattern finds a DIFFERENT, known row,
    // so a `toContain` that had quietly stopped matching anything would fail here too.
    expect(block, "the parse reaches the declaration's other rows").toContain(`redirect("/vault", "/repository")`);
    // …and no legacy row targets /board, which is why `?task=` has no redirect leg of its own.
    expect(block, "nothing redirects into /board").not.toContain(`"/board"`);

    const profile = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Redirect Rig") }),
    });
    const deadLink = `/profiles?profile=${encodeURIComponent(profile.id)}&grant=does-not-matter`;
    // `nav.tsx`'s `redirect()` builds `<Navigate to="/actors" replace/>` from a plain path string, so
    // react-router drops the incoming search entirely. That has always been the behaviour; the point
    // of this row is that the ATLAS shell did not change it in either direction.
    //
    // Card 41eab0eb added a SECOND hop under Atlas alone: /actors is now the Workspace node's
    // `actors` tab, so the Atlas landing is that tab's address while the classic one is unchanged.
    // The DROP — which is this test's whole subject — must still happen identically on both, so both
    // legs below still assert `profile=` is gone; only the path each one lands on differs, and the
    // per-shell constant is what records that it is a deliberate divergence and not a drift.
    const ATLAS_URL = /\/home\?tab=actors$/;
    const CLASSIC_URL = /\/actors$/;
    const PLACEHOLDER = "Select a profile to edit it";

    try {
      // Switch ON.
      await seedAtlasOn(page);
      await page.setViewportSize(VIEWPORT);
      await page.goto(`${loomDaemon.baseURL}${deadLink}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByText(PLACEHOLDER, { exact: false }), "no profile pre-selected: the query was dropped").toBeVisible();
      await expect(page).toHaveURL(ATLAS_URL);
      expect(page.url()).not.toContain("profile=");

      // Switch OFF — a second context, so the seeded flag cannot carry over.
      const classic = await page.context().browser()!.newPage();
      try {
        await classic.setViewportSize(VIEWPORT);
        await classic.goto(`${loomDaemon.baseURL}${deadLink}`);
        await expect(classic.locator(".loom-rail"), "the classic shell really mounted").toBeVisible();
        await expect(classic.getByTestId("atlas-shell")).toHaveCount(0);
        await expect(classic.getByText(PLACEHOLDER, { exact: false })).toBeVisible();
        await expect(classic).toHaveURL(CLASSIC_URL);
        expect(classic.url()).not.toContain("profile=");
      } finally {
        await classic.close();
      }
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── The other polarity: the classic shell is untouched ──────────────────────────────────────────
  test("switch OFF: both deep links behave exactly as they did on the classic shell", async ({ page, loomDaemon }) => {
    const base = loomDaemon.baseURL;
    const project = await loomDaemon.createProject(uniq("atlasdeep-classic"));
    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, project.id);

    await pinProject(page, project.id); // no seedAtlasOn — OFF is the default
    await page.setViewportSize(VIEWPORT);

    // ── `?task=` on the classic Board page ──
    await page.goto(`${base}/board?task=${encodeURIComponent(target.id)}`);
    await expect(page.locator(".loom-rail"), "the classic shell really mounted").toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await assertDialogIsCard(page, target, decoy);
    await expect(page).toHaveURL(/\/board$/);
    expect(page.url()).not.toContain("task=");

    // ── `?profile=&grant=` on the classic Actors page ──
    const connection = await apiJson<{ id: string; name: string }>(`${base}/api/connections`, {
      method: "POST",
      body: JSON.stringify({ name: uniq("E2E Classic Conn"), host: "api.example-classic.test", authScheme: "api-key", secret: `sk_${Date.now()}` }),
    });
    const profile = await apiJson<{ id: string; name: string }>(`${base}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Classic Target Rig") }),
    });
    try {
      await gotoActorsReady(page, base, `/actors?tab=profiles&profile=${encodeURIComponent(profile.id)}&grant=${encodeURIComponent(connection.id)}`);
      await expect(page.locator(".loom-rail")).toBeVisible();
      await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(profile.name);
      await expect(page.getByText(/is pre-selected below/)).toBeVisible();
      const atRest = await apiJson<{ connections?: string[] }>(`${base}/api/profiles/${profile.id}`);
      expect(atRest.connections ?? []).not.toContain(connection.id);
    } finally {
      await fetch(`${base}/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/connections/${connection.id}`, { method: "DELETE" }).catch(() => {});
    }
  });
});
