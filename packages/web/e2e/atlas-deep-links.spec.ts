// The two query-param deep links, verified against the ATLAS URL scheme (card 3ed3dc31, Atlas build
// plan P2-10: docs/plans/archive/atlas-ui/03-decomposition.md row P2-10). Closes parity gap §J.5 —
// `01-parity-checklist.md` §G listed both rows as "NOT VERIFIED AGAINST ATLAS'S OWN URL SCHEME".
//
//   `?task=<id>`                      → opens THAT card's dialog (pages/Board.tsx)
//   `?profile=<id>[&grant=<connId>]`  → pre-selects THAT profile (pages/Profiles.tsx). The `grant=`
//                                       pre-tick (card 12dc7fc9) was RETIRED by eae230d9 — connection
//                                       grants moved to the AGENT editor — so a carried `grant=` is
//                                       inert: it must select nothing and grant nothing.
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
//   2. `/project?task=`                    the project node (ATLAS-ONLY, card fd99b2d7). Its Overview
//                                          tab embedded the whole <Board> until card 269f46ef removed
//                                          it on the owner's instruction, so the link now NORMALIZES
//                                          onto the node's Board tab rather than opening in place —
//                                          same shape as leg 4b, and the deep link still resolves.
//   3. `/project?tab=deck&task=`           a LEGACY tab param plus the card param on one URL.
//                                          (The Workspace node's own `?tab=deck` went the same way
//                                          one card later — see atlas-home.spec.ts, card 4a0ad464.)
//                                          `tab=deck` named a real second home tab until card
//                                          44f725fe unified the pair; asserts the dead param neither
//                                          breaks the deep link nor is eaten by the board consuming
//                                          `task`, and that it resolves to the unified Overview. The
//                                          coexistence claim for a LIVE node tab is leg 4's now.
//   4. `/platform?tab=board&task=`         the other Atlas node with its own `?tab=`, and the one whose
//                                          panels all stay MOUNTED (PlatformView.tsx) — so its board is
//                                          live even on a different tab and could consume the param
//                                          where nobody can see the dialog.
//   4b. `/platform?task=` with NO tab=board      the invisible-consumption case (card 260fb29a): the
//                                          node's hidden Board used to eat the param and open its
//                                          dialog where nobody can see it. The address now normalizes
//                                          onto the Board tab.
//   4c. the same, with a WARM board cache  the other half of that fix, and the only leg that can see
//                                          it: a hidden panel's board must not CONSUME the param.
//                                          Unreachable by a fresh load — see the leg's own note.
//   5. `/actors?tab=profiles&profile=&grant=`  the profile deep link, on the Actors node.
//   6. a LEGACY REDIRECT (`/profiles?...`) — FUNCTION, not parity, since card 260fb29a: `nav.tsx`'s
//                                          `redirect()` now carries the incoming query through, so
//                                          the deep link ARRIVES and pre-selects the profile under
//                                          both shells. It used to build a plain path `<Navigate>`
//                                          and drop it, which this row asserted as parity; that
//                                          reading is retired — a redirect is a rename, so the params
//                                          were always meant for the page they land on.
//   6b. `/setup?task=`                     the two fixes composing: the redirect carries `task=` to
//                                          /platform, which then normalizes onto its Board tab.
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

// lib/activeProject.tsx owns the project key.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const PROJECT_KEY = "loom.projectId";

const VIEWPORT = { width: 1400, height: 1000 };

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
  test("?task= on the Board node opens that card's dialog and clears only the task param", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdeep-board"));
    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, project.id);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(target.id)}`);

    // PRESENCE first: the Atlas frame is really what mounted.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

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
  test("?task= on the project node opens that card's dialog, and a legacy ?tab=deck survives it", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdeep-project"));
    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, project.id);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);

    // ── Overview tab (the node's default, no tab param at all) ──
    //
    // 🔴 THE LINK NO LONGER LANDS WHERE IT IS ISSUED, AND THAT IS THE NEW CLAIM. Card 269f46ef
    // removed the embedded board from this tab on the owner's own instruction, so `/project?task=`
    // has nothing on the Overview that can show a card dialog. `ProjectHome` normalizes the ADDRESS
    // onto the node's Board tab instead — the same move, for the same reason, as the Platform
    // node's own normalization in leg 4b (card 260fb29a): rewrite the address rather than derive a
    // tab, because `Board` clears the param it consumes. The deep link still WORKS, which is what
    // this leg has always been for; where it ends up is what changed.
    await page.goto(`${loomDaemon.baseURL}/project?task=${encodeURIComponent(target.id)}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertDialogIsCard(page, target, decoy);
    await expect(page, "the card link normalized onto the node's Board tab").toHaveURL(/\/board$/);
    expect(page.url()).not.toContain("task=");
    // The frame is still on the PROJECT node — a normalization that navigated out of the node (or
    // into another project) would satisfy the dialog check above and be a different bug.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(project.name);

    // …and the Overview it bounced off really does render, with no board of its own. Asserted on a
    // clean load of the same address without the param, so this is the tab's own shape and not a
    // mid-normalization frame. `.loom-ovbrief` is the Overview's own readout since card 269f46ef,
    // and `.loom-kpistrip` — the compact readout the removed Deck tab owned, which card 4a0ad464
    // then deleted from every tab of every node — is what must be absent; neither locator can be
    // one that is simply always present or simply always missing.
    await page.goto(`${loomDaemon.baseURL}/project`);
    await expect(page.locator(".loom-ovbrief"), "the Overview tab's own readout").toBeVisible();
    await expect(page.locator(".loom-kpistrip")).toHaveCount(0);
    await expect(page.getByTestId("atlas-board-embed")).toHaveCount(0);

    // ── A LEGACY `?tab=deck` on the node, carrying a card param too ──
    // A fresh document load, not a tab click, so the two params arrive together exactly as a pasted
    // bookmark would deliver them. `tab=deck` named a real second home tab until card 44f725fe
    // unified the pair, so this is the shape of every link anyone saved before that.
    await page.goto(`${loomDaemon.baseURL}/project?tab=deck&task=${encodeURIComponent(target.id)}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertDialogIsCard(page, target, decoy);

    // Two things at once, and BOTH matter. (1) The dead tab param does not break the deep link: the
    // card's dialog opened anyway, asserted above. (2) The normalization DROPS `tab` and keeps
    // everything else — `tab` is this node's own home-tab key and means nothing at `/board`, which
    // is a re-homed tab with an address of its own. `task` is then gone because `Board` consumed and
    // cleared it with `p.delete("task")`; that delete is still what keeps a LIVE node tab (the
    // Platform node's, leg 4) alive across a card param being consumed.
    await expect(page).toHaveURL(/\/board$/);
    expect(page.url()).not.toContain("task=");
    expect(page.url(), "the node's own tab key rode along to an address that has no use for it")
      .not.toContain("tab=");
  });

  // ── 4. The Platform node — the other `?tab=` owner, and the always-mounted one ───────────────────
  test("?task= on the Platform node's Board tab opens that card's dialog", async ({ page, loomDaemon }) => {
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

    try {      await pinProject(page, other.id);
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

  // ── 4b + 6b. The Platform node WITHOUT tab=board — and the same link through a legacy redirect ──
  test("?task= on the Platform node with no tab=board switches to the Board tab and opens the card", async ({ page, loomDaemon }) => {
    // Card 260fb29a. The Platform node keeps all five panels MOUNTED and hides the inactive ones
    // (PlatformView.tsx — the owner's rule that a tab click is not consent to discard unfinished
    // input), so its <Board> is live on every tab. `?task=` arriving without `tab=board` was therefore
    // consumed by a board inside a HIDDEN panel: the dialog opened where nobody could see it, and the
    // param was cleared on the way out, so no visible board ever got a chance at it.
    //
    // Everything below is the OBSERVABLE of that fix, not a render check: the Board tab is what is
    // showing, the Home tab is not, and the dialog on it is the deep-linked card's rather than
    // whichever card the board found first.
    const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` } });
    expect(res.ok, `GET /api/setup/home -> ${res.status}`).toBe(true);
    const home = (await res.json()) as { project: { id: string; name: string } };
    expect(home.project.name, "the reserved home this leg seeds into").toBe("Platform");

    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, home.project.id);
    // A second project, pinned active, so "the Platform board's card opened" cannot be satisfied by
    // the active project's board having been rendered here instead.
    const other = await loomDaemon.createProject(uniq("atlasdeep-platform-notab"));

    try {      await pinProject(page, other.id);
      await page.setViewportSize(VIEWPORT);

      // ── The bare node address: no tab at all, so Home is what it would otherwise resolve to. ──
      await page.goto(`${loomDaemon.baseURL}/platform?task=${encodeURIComponent(target.id)}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      // PRESENCE first (card 625d791c): the Board panel is the one SHOWING. `platform-panel-home` is
      // the contrast case — both are in the document either way, since none of the five is ever
      // unmounted, so "the board is visible" only means something beside "home is not".
      await expect(page.getByTestId("platform-panel-board"), "the node switched to its Board tab").toBeVisible();
      await expect(page.getByTestId("platform-panel-home"), "…and off the Home tab it would otherwise default to")
        .toBeHidden();
      await expect(page.getByTestId("atlas-tab-board"), "the tab row agrees with the panel")
        .toHaveAttribute("aria-selected", "true");

      // THE DIALOG — the whole point. Before this card it opened inside the hidden Home-tab render
      // pass and was never visible at all.
      await assertDialogIsCard(page, target, decoy);

      // The address was REWRITTEN, not merely derived: `tab=board` is really in the URL, which is what
      // keeps the panel visible after Board clears the param it consumed. A derived tab would re-hide
      // the dialog on that very next render.
      await expect(page).toHaveURL(/\/platform\?tab=board$/);
      expect(page.url(), "the consumed ?task= is cleared").not.toContain("task=");

      // Still on the node, still on the Board tab, after the dialog closes — the normalization is a
      // one-shot address rewrite, not a loop that re-fires once the param is gone.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).toHaveURL(/\/platform\?tab=board$/);
      await expect(page.getByTestId("platform-panel-board")).toBeVisible();

      // ── An EXPLICIT other tab loses to the card param, and that is deliberate: a URL naming both is
      //    self-contradictory, and only the Board tab can serve either half of it. ──
      await page.goto(`${loomDaemon.baseURL}/platform?tab=cadence&task=${encodeURIComponent(target.id)}`);
      await expect(page.getByTestId("platform-panel-board"), "?task= wins over an explicit tab=cadence").toBeVisible();
      await expect(page.getByTestId("platform-panel-cadence")).toBeHidden();
      await assertDialogIsCard(page, target, decoy);
      await expect(page).toHaveURL(/\/platform\?tab=board$/);

      // ── 6b. THE TWO FIXES COMPOSING. /setup is a declared LEGACY_REDIRECTS row onto /platform, so
      //    this one URL exercises both halves of the card: the redirect has to carry `task=` through
      //    (it used to drop it), and the node then has to normalize onto its Board tab. Asserted
      //    against the real declaration so this can never quietly test a dead URL.
      const navSrc = readFileSync(NAV_SOURCE, "utf8");
      const block = navSrc.slice(navSrc.indexOf("export const LEGACY_REDIRECTS"),
        navSrc.indexOf("\n];", navSrc.indexOf("export const LEGACY_REDIRECTS")));
      expect(block, "the row this leg chains through").toContain(`redirect("/setup", "/platform")`);
      expect(block, "positive control: the parse reaches the declaration's other rows")
        .toContain(`redirect("/vault", "/repository")`);

      await page.goto(`${loomDaemon.baseURL}/setup?task=${encodeURIComponent(target.id)}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("platform-panel-board"), "the redirect carried ?task= and the node switched")
        .toBeVisible();
      await assertDialogIsCard(page, target, decoy);
      await expect(page).toHaveURL(/\/platform\?tab=board$/);
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/tasks/${target.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${loomDaemon.baseURL}/api/tasks/${decoy.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 4c. The hidden panel's board must not CONSUME the param — the half no fresh load can see ────
  test("a hidden Platform panel's board does not eat ?task= when the board cache is already warm", async ({ page, loomDaemon }) => {
    // Card 260fb29a's fix is two halves, and this leg exists because the OTHER half's legs cannot
    // discriminate this one. MEASURED, both polarities, on a real build: with `Board`'s `deepLinks`
    // gate REMOVED but the normalization <Navigate> kept, every other leg in this file still passes.
    // The reason is timing, not correctness — a fresh `page.goto` starts with a COLD board cache, so
    // `board.data` is undefined on the first render and the hidden board's effect no-ops until after
    // the <Navigate> has landed.
    //
    // Warm that cache and the race is real. Same measurement, same build, warm + client-side arrival:
    //   gate ON  → url /platform?tab=board, board panel visible, 1 visible dialog
    //   gate OFF → url /platform (tab=board WIPED), board panel hidden, 0 dialogs
    // The hidden board's effect fires in the SAME flush as the <Navigate> and its `setSearchParams`
    // is computed from the pre-navigation closure, so its "delete task" writes back a query that
    // never had `tab=board` in it. Without this leg the gate is untested machinery.
    //
    // THE ARRIVAL IS SYNTHETIC, deliberately and with the reason stated: a warm cache plus a
    // client-side arrival at this address is a state no in-app link produces TODAY — every route to
    // `/platform?task=` is a full document load, which is cold. It is one small change away from
    // being live, though: `components/requests.tsx`'s own linked-task chip already does exactly this
    // shape (`navigate("/board?task=" + id)`) from inside the app. A pushState + popstate is what
    // react-router's own history listener responds to, so this drives the real client-side path.
    const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` } });
    expect(res.ok, `GET /api/setup/home -> ${res.status}`).toBe(true);
    const home = (await res.json()) as { project: { id: string; name: string } };
    expect(home.project.name, "the reserved home this leg seeds into").toBe("Platform");

    const { decoy, target } = await seedDecoyAndTarget(loomDaemon, home.project.id);
    const other = await loomDaemon.createProject(uniq("atlasdeep-platform-warm"));

    try {      await pinProject(page, other.id);
      await page.setViewportSize(VIEWPORT);

      // ── Warm the board cache by sitting on the Board tab, and WAIT for the read that warms it. ──
      await page.goto(`${loomDaemon.baseURL}/platform?tab=board`);
      await expect(page.getByTestId("platform-panel-board")).toBeVisible();
      await page.waitForResponse((r) => r.url().includes(`/api/projects/${home.project.id}/board`) && r.ok());
      // PRESENCE/ABSENCE control on the starting state: nothing is open yet, so a dialog found at the
      // end cannot be one that was already there.
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // ── Move off the Board tab client-side (a real tab link), so its board stays MOUNTED and warm
      //    while hidden — which is the whole condition under test. ──
      await page.getByTestId("atlas-tab-cadence").click();
      await expect(page.getByTestId("platform-panel-cadence")).toBeVisible();
      await expect(page.getByTestId("platform-panel-board"), "the board is hidden but still mounted").toBeHidden();

      // ── Arrive at ?task= with NO document load. ──
      await page.evaluate((id) => {
        history.pushState({}, "", `/platform?task=${id}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, target.id);

      // The normalization survived the hidden board: the address really carries `tab=board`, the panel
      // is showing, and the dialog on it is the deep-linked card's.
      await expect(page, "the hidden board's clear wiped the normalized tab=board out of the address")
        .toHaveURL(/\/platform\?tab=board$/);
      await expect(page.getByTestId("platform-panel-board"), "…so the Board panel is what is showing").toBeVisible();
      await expect(page.getByTestId("platform-panel-cadence")).toBeHidden();
      await assertDialogIsCard(page, target, decoy);
      // Exactly ONE dialog: a hidden board that ALSO consumed the param would open a second one inside
      // its own panel, which no visibility assertion above would notice.
      await expect(page.getByRole("dialog"), "only the visible panel's board opened a dialog").toHaveCount(1);
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/tasks/${target.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${loomDaemon.baseURL}/api/tasks/${decoy.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 5. The profile + grant deep link ────────────────────────────────────────────────────────────
  test("?profile=&grant= pre-selects that profile, the retired grant= is inert, and a widening Save confirms rather than writes", async ({ page, loomDaemon }) => {
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

    try {      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);
      // `gotoActorsReady` (fixtures/daemon.ts) waits for the editor's own `GET /api/agents` to land.
      // Without it, `planGrantSave` fails CLOSED on an unresolved list (@decision 3c4e0df6) and Save
      // would open `confirm-unknown` — the right panel, reached for the wrong reason, which would make
      // the assertion below pass without the reach ever having been computed.
      const deepLink = `/actors?tab=profiles&profile=${encodeURIComponent(profile.id)}&grant=${encodeURIComponent(connection.id)}`;
      await gotoActorsReady(page, base, deepLink);

      // PRESENCE first: the Atlas frame, then the Profiles tab under it.
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      // THE RIGHT PROFILE. The editor's Name field holds the stored row's name, so it names which
      // profile actually mounted — and the decoy's name proves the check discriminates. (Compared on
      // the input's VALUE, not the editor's `<strong>` header: that header is CSS-uppercased, and
      // `innerText` folds `text-transform` in while `toHaveText` does not — card 82bde849 gotcha 1.)
      const nameField = page.getByLabel("Name", { exact: true });
      await expect(nameField).toHaveValue(profile.name);
      expect(profile.name).not.toBe(decoyProfile.name);
      await expect(nameField).not.toHaveValue(decoyProfile.name);

      // THE RETIRED `grant=` IS INERT (eae230d9 moved connection grants onto the AGENT editor). The
      // profile editor no longer pre-selects a connection or says so: the connection's name is nowhere
      // on the page, and the stored row carries nothing, read back over REST rather than inferred.
      await expect(page.getByText(/is pre-selected below/)).toHaveCount(0);
      await expect(page.getByText(connection.name, { exact: false })).toHaveCount(0);
      const atRest = await apiJson<{ connections?: string[] }>(`${base}/api/profiles/${profile.id}`);
      expect(atRest.connections ?? [], "arriving on the deep link grants nothing").not.toContain(connection.id);

      // THE FAIL-CLOSED CONFIRM IS INTACT UNDER ATLAS (@decision 3c4e0df6). The still-profile-level
      // widening key (vault write) stands in for the retired connection pre-tick: Save does not write,
      // it opens the blast-radius confirm naming the bound agent, because a profile is global.
      await expect(page.getByTestId("grant-reach-confirm")).toHaveCount(0);
      await page.getByTestId("profile-vault-write").check();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      const confirm = page.getByTestId("grant-reach-confirm");
      await expect(confirm, "Save opens the grant-reach confirm instead of writing").toBeVisible();
      await expect(confirm.getByTestId("grant-reach-count")).toHaveText(/1 agent\b/);
      await expect(confirm.getByTestId("grant-reach-agents")).toContainText(agent.name);

      // The observable that makes "it does not auto-grant" a real claim: still nothing stored.
      const afterSaveClick = await apiJson<{ vaultWrite?: boolean }>(`${base}/api/profiles/${profile.id}`);
      expect(afterSaveClick.vaultWrite ?? false, "the click opened a confirm, it did not write the widening").toBe(false);
    } finally {
      await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/profiles/${decoyProfile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${base}/api/connections/${connection.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── 6. The legacy redirect — a WORKING deep link since card 260fb29a ─────────────────────────────
  test("a legacy redirect carries the deep-link query through", async ({ page, loomDaemon }) => {
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

    // A DECOY profile alongside the target, for the same reason every other leg seeds one: "the editor
    // opened" is not the claim — "it opened the one the URL named" is, and only a second profile can
    // tell those apart.
    const decoyProfile = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Redirect Decoy") }),
    });
    const profile = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Deeplink Redirect Rig") }),
    });
    const connection = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/connections`, {
      method: "POST",
      body: JSON.stringify({ name: uniq("E2E Redirect Conn"), host: "api.example-redirect.test", authScheme: "api-key", secret: `sk_${Date.now()}` }),
    });
    const legacyLink = `/profiles?profile=${encodeURIComponent(profile.id)}&grant=${encodeURIComponent(connection.id)}`;
    // Card 260fb29a: `nav.tsx`'s `redirect()` renders `QueryPreservingRedirect`, which merges the
    // incoming search into the target's own. So the deep link ARRIVES at the renamed address and
    // pre-selects the profile — where before it landed on a bare Actors page with the placeholder up.
    // The row's own `?tab=` still wins any key collision; `/profiles` pins none, so there is nothing
    // here for the carried query to collide with.
    //
    // Card 41eab0eb added a SECOND hop: /actors is the Workspace node's `actors` tab, so the landing is
    // that tab's address, and that hop has to carry the query too.
    const ATLAS_URL = /\/home\?tab=actors&/;
    const PLACEHOLDER = "Select a profile to edit it";

    try {      await page.setViewportSize(VIEWPORT);

      // THE ADDRESS FIRST, on a plain goto, before the functional half below. `gotoActorsReady` awaits
      // the editor's own `GET /api/agents`, and that request only fires once the editor MOUNTS — which
      // a dropped query prevents — so against the pre-card behaviour the helper dies on a 30s
      // `waitForResponse` timeout that names nothing. MEASURED: reverting the fix turned this leg red
      // at exactly that timeout. Checking the landed URL on its own navigation first makes the red land
      // on the discriminating claim instead.
      await page.goto(`${loomDaemon.baseURL}${legacyLink}`);
      await page.waitForURL((u) => u.pathname !== "/profiles");
      expect(page.url(), "the redirect dropped ?profile= instead of carrying it through").toContain("profile=");
      expect(page.url(), "…and dropped ?grant= with it").toContain("grant=");

      // Now the functional half. `gotoActorsReady` for the same reason leg 5 needs it: without the
      // editor's own GET /api/agents resolved, `planGrantSave` fails CLOSED (@decision 3c4e0df6) and
      // the pre-selection would be reached for the wrong reason.
      await gotoActorsReady(page, loomDaemon.baseURL, legacyLink);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      // PRESENCE first: the editor mounted on the profile the URL named. The decoy's name is the
      // discriminator — "an editor opened" would pass against either.
      const nameField = page.getByLabel("Name", { exact: true });
      await expect(nameField, "the carried ?profile= pre-selected its profile").toHaveValue(profile.name);
      expect(profile.name).not.toBe(decoyProfile.name);
      await expect(nameField).not.toHaveValue(decoyProfile.name);
      // (The `?grant=` half still rides the URL — asserted below — but the editor no longer acts on it:
      // eae230d9 retired the profile-level connection pre-tick, so there is no banner to look for.)
      // The CONTRAST CASE for the assertion above: the placeholder is what this address showed before
      // the query survived the redirect, so its absence is the measured difference.
      await expect(page.getByText(PLACEHOLDER, { exact: false }),
        "the editor is open, so the no-selection placeholder must be gone").toHaveCount(0);
      await expect(page).toHaveURL(ATLAS_URL);
      expect(page.url(), "the redirect carried ?profile= through").toContain("profile=");
      expect(page.url(), "…and ?grant= with it").toContain("grant=");

      // Arriving on the deep link still GRANTS nothing — read back over REST, not inferred from the
      // UI. Making the link work must not have made it write (card 12dc7fc9's own rule).
      const atRest = await apiJson<{ connections?: string[] }>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`);
      expect(atRest.connections ?? [], "arriving on the carried deep link grants nothing").not.toContain(connection.id);
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${loomDaemon.baseURL}/api/profiles/${decoyProfile.id}`, { method: "DELETE" }).catch(() => {});
      await fetch(`${loomDaemon.baseURL}/api/connections/${connection.id}`, { method: "DELETE" }).catch(() => {});
    }
  });
});
