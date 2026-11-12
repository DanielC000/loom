// Re-pin grants button — card 158cb01a. A live session's connections are PINNED on its row at spawn and stay
// frozen across recycle (owner ruling 298b826e); the human-only POST /api/sessions/:id/repin-grants moves them,
// and this is its UI: a counts-only drift badge (GET /api/sessions/:id/grant-drift) + a confirmed button.
//
// What each leg is measured against:
//   1. ZERO-PINNED (the owner's incident): agent grants 3, session pinned 0 -> badge shows, the confirm names
//      the before/after COUNTS and the resume caveat, applying re-pins, and after a RELOAD the session row's
//      pinned set EQUALS the agent's (read off GET /api/sessions, not off the UI) and the badge is gone.
//   2. PARTIAL (1 of 3): badge shows with the partial counts, no first-time caveat.
//   3. NO DRIFT: a session whose pins equal its agent's grants shows neither badge nor button.
//   4. COUNTS ONLY: no connection id appears in the drift read the page issued.
import { expect, test } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe("Re-pin grants (card 158cb01a)", () => {
  test("zero-pinned, partial and in-sync sessions: badge, confirm, re-pin, reload", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const base = loomDaemon.baseURL;
    const conns: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await apiJson<{ id: string }>(`${base}/api/connections`, {
        method: "POST",
        body: JSON.stringify({ name: uniq(`E2E Repin Conn ${i}`), host: `api.example-repin-${i}.test`, authScheme: "api-key", secret: `sk_${Date.now()}_${i}` }),
      });
      conns.push(c.id);
    }
    try {
      const zero = await loomDaemon.seedLiveSession({
        role: "manager", agentName: "RepinZero", id: `e2e-repinzero-${Date.now()}`,
        ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "zero ready\r\n",
      });
      const partial = await loomDaemon.seedLiveSession({
        project: zero.project, role: "manager", agentName: "RepinPartial", id: `e2e-repinpart-${Date.now()}`,
        connections: [conns[0]!], ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "partial ready\r\n",
      });
      const synced = await loomDaemon.seedLiveSession({
        project: zero.project, role: "manager", agentName: "RepinSynced", id: `e2e-repinsync-${Date.now()}`,
        connections: conns, ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "synced ready\r\n",
      });
      // The agents are granted AFTER their sessions were pinned — exactly the owner's incident.
      for (const s of [zero, partial, synced]) {
        await apiJson(`${base}/api/agents/${s.agentId}`, { method: "POST", body: JSON.stringify({ connections: conns }) });
      }

      await page.addInitScript(([pk, pv]) => {
        try { localStorage.setItem(pk, pv); } catch { /* assertions will say so */ }
      }, [PROJECT_KEY, zero.projectId] as const);

      const driftBodies: string[] = [];
      page.on("response", async (r) => {
        if (r.url().includes("/grant-drift")) { try { driftBodies.push(await r.text()); } catch { /* ignore */ } }
      });

      const pinnedOf = async (sessionId: string): Promise<string[]> => {
        const rows = await apiJson<{ id: string; connections?: string[] }[]>(`${base}/api/sessions`);
        return [...(rows.find((r) => r.id === sessionId)?.connections ?? [])].sort();
      };

      // ── 3. NO DRIFT first: presence-first — the node must be there before an absence means anything. ──
      await page.goto(`${base}/session/${synced.sessionId}`);
      await expect(page.getByTestId("session-node")).toBeVisible();
      await expect.poll(() => driftBodies.length, { message: "the drift read must have answered before absence counts" }).toBeGreaterThan(0);
      await expect(page.getByTestId(`repin-drift-badge-${synced.sessionId}`)).toHaveCount(0);
      await expect(page.getByTestId(`repin-grants-button-${synced.sessionId}`)).toHaveCount(0);

      // ── 2. PARTIAL: badge shows, no first-time caveat. ──
      await page.goto(`${base}/session/${partial.sessionId}`);
      await expect(page.getByTestId(`repin-drift-badge-${partial.sessionId}`)).toBeVisible();
      await page.getByTestId(`repin-grants-button-${partial.sessionId}`).click();
      await expect(page.getByTestId("repin-confirm-counts")).toContainText("pinned to 1 connection");
      await expect(page.getByTestId("repin-confirm-counts")).toContainText("currently grants 3 connections");
      await expect(page.getByTestId("repin-confirm-first-time")).toHaveCount(0);
      // connections are live on the next call: no spawn-time resume caveat for a connections-only diff
      await expect(page.getByTestId("repin-confirm-resume-note")).toHaveCount(0);
      await expect(page.getByTestId("repin-confirm-change-connections")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId(`repin-confirm-${partial.sessionId}`)).toHaveCount(0);
      expect(await pinnedOf(partial.sessionId), "Cancel must not re-pin").toEqual([conns[0]]);

      // ── 1. ZERO-PINNED: the owner's incident. ──
      expect(await pinnedOf(zero.sessionId)).toEqual([]);
      await page.goto(`${base}/session/${zero.sessionId}`);
      await expect(page.getByTestId(`repin-drift-badge-${zero.sessionId}`)).toBeVisible();
      await page.getByTestId(`repin-grants-button-${zero.sessionId}`).click();
      await expect(page.getByTestId("repin-confirm-counts")).toContainText("pinned to 0 connections");
      await expect(page.getByTestId("repin-confirm-counts")).toContainText("currently grants 3 connections");
      await expect(page.getByTestId("repin-confirm-first-time")).toContainText("resume");
      await page.getByTestId(`repin-confirm-apply-${zero.sessionId}`).click();
      await expect(page.getByTestId(`repin-grants-${zero.sessionId}`)).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("session-node")).toBeVisible();
      await expect(page.getByTestId(`repin-grants-button-${zero.sessionId}`)).toHaveCount(0);
      expect(await pinnedOf(zero.sessionId), "after a reload the session's pinned set equals the agent's").toEqual([...conns].sort());

      // ── 4. COUNTS ONLY: nothing the page read from grant-drift carries a connection id. ──
      expect(driftBodies.length).toBeGreaterThan(0);
      for (const b of driftBodies) for (const id of conns) expect(b).not.toContain(id);
    } finally {
      for (const id of conns) await fetch(`${base}/api/connections/${id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // Review round: drift in ONLY a field the counts never show. The row is pinned restrictedTools:true while its
  // agent resolves false, so applying would silently REMOVE a restriction — the dialog must say so, prominently.
  test("a restriction-loosening drift (restrictedTools only) is named in the badge and the dialog", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const base = loomDaemon.baseURL;
    const s = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "RepinLoosen", id: `e2e-repinloose-${Date.now()}`,
      restrictedTools: true, ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "loosen ready\r\n",
    });
    await page.addInitScript(([pk, pv]) => {
      try { localStorage.setItem(pk, pv); } catch { /* assertions will say so */ }
    }, [PROJECT_KEY, s.projectId] as const);
    await page.goto(`${base}/session/${s.sessionId}`);
    const badge = page.getByTestId(`repin-drift-badge-${s.sessionId}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("title", /tool restriction REMOVED/);
    await page.getByTestId(`repin-grants-button-${s.sessionId}`).click();
    const change = page.getByTestId("repin-confirm-change-restrictedTools");
    await expect(change).toContainText("tool restriction REMOVED");
    await expect(change).toHaveAttribute("data-loosening", "true");
    // no connection/capability line: the diff is ONLY the non-counted field
    await expect(page.getByTestId("repin-confirm-change-connections")).toHaveCount(0);
    // restrictedTools mounts at spawn: the resume caveat is shown and names it
    await expect(page.getByTestId("repin-confirm-resume-note")).toContainText("next resume");
    await page.getByRole("button", { name: "Cancel" }).click();
  });
});
