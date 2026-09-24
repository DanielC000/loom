// Default-harness Settings surface (card b8e52cfe) — the two "Default Harness" panels (daemon-global and
// per-project), the switch-to-codex confirm that gates their Save, and the drain banner over
// GET /api/harness/drain.
//
// NO SESSION IS EVER SPAWNED HERE. Every live row is a `processState:"live"` DB row inserted through the
// test-only POST /internal/test/seed (`loomDaemon.seedLiveSession`), never startSession — which would run a
// real claude and trip the fixture's `[pty] spawn` no-spawn guard. The drain endpoint is a PURE DERIVED
// read over those rows plus the stored config, so a seeded row exercises it end to end.
//
// TWO LAYERS, TWO ISOLATION POSTURES. The per-project panel writes a config on a project this spec created,
// so it is fully isolated. The platform panel writes the DAEMON-GLOBAL override on a worker-scoped daemon
// shared with every other spec in this worker — same posture settings.spec.ts already documents for
// maxConcurrentGates — so those tests read the stored override rather than assuming a pristine start, and
// afterEach clears the key back to inherit rather than leaving codex armed for whatever runs next.
import { expect, test, type Page } from "./fixtures/daemon";

/** Scope a control to ONE of the two identical panels — both render the same labels by design. */
const panelOf = (page: Page, layer: "platform" | "project") => page.getByTestId(`default-harness-${layer}`);

/** A select inside a panel, pinned by the EXACT text of its label span (the hint text pollutes getByLabel). */
const selectIn = (page: Page, layer: "platform" | "project", labelText: string) =>
  panelOf(page, layer).locator(`label:has(> span:text-is(${JSON.stringify(labelText)})) select`);

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

interface HarnessOverride { default?: string; scope?: string }

async function readPlatformHarness(baseURL: string): Promise<HarnessOverride | null> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  const body = (await res.json()) as { override?: { harness?: HarnessOverride } };
  return body.override?.harness ?? null;
}

/**
 * The stored platform DEFAULT, or null for "not overridden". Read through this rather than off the group:
 * clearing both halves sends the per-field null sentinel, and the server's deep-merge persists the result
 * as `harness: {}` instead of deleting the key (inert — resolveHarnessConfig reads every field with `??`).
 * A test asserting the GROUP is absent would therefore pass on a pristine daemon and fail on one this file
 * has already touched, purely from test order.
 */
async function readPlatformDefault(baseURL: string): Promise<string | null> {
  return (await readPlatformHarness(baseURL))?.default ?? null;
}

async function readProjectHarness(baseURL: string, projectId: string): Promise<HarnessOverride | null> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as Array<{ id: string; config?: { harness?: HarnessOverride } }>;
  return projects.find((p) => p.id === projectId)?.config?.harness ?? null;
}

interface DrainWire {
  target: string;
  pending: { sessionId: string }[];
  blocked: { sessionId: string }[];
  done: boolean;
}

async function readDrain(baseURL: string, projectId?: string): Promise<DrainWire> {
  const url = projectId
    ? `${baseURL}/api/harness/drain?projectId=${encodeURIComponent(projectId)}`
    : `${baseURL}/api/harness/drain`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as DrainWire;
}

test.describe("default harness settings", () => {
  // The daemon-global key is the one piece of state here with no per-test isolation. Clearing it (both
  // halves back to the inherit sentinel) is the same PATCH shape the form itself sends on a blank field.
  test.afterEach(async ({ loomDaemon }) => {
    await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${loomDaemon.loopbackSecret}` },
      body: JSON.stringify({ config: { harness: { default: null, scope: null } } }),
    });
  });

  // ── The confirm is a GATE, not a notice. The half that actually matters is Cancel: a dialog that shows
  // the caveats and saves anyway would look identical on screen to this one, and only a held save tells
  // them apart. So the negative is asserted on a POSITIVE observable — the form still reads "unsaved
  // changes" with Save re-enabled, which a completed save would have cleared (onSuccess re-baselines) —
  // rather than on a bare timeout waiting for a PATCH that never comes.
  test("switching the fleet default to codex is gated by a confirm that names both caveats, and Cancel holds the save", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`harness-platform-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const sel = selectIn(page, "platform", "Vendor CLI");
    await expect(sel).toBeVisible();

    // BEFORE — fixture identity: nothing stored at this layer, and the control agrees.
    expect(await readPlatformDefault(loomDaemon.baseURL)).toBeNull();
    await expect(sel).toHaveValue("");
    await expect(panelOf(page, "platform")).toContainText("effective: Claude Code");

    await sel.selectOption("codex");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await expect(globalSave).toBeEnabled();
    await globalSave.click();

    // The dialog intercepts the save and names both open caveats by card id.
    const dialog = page.getByTestId("codex-default-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("d991fefd");
    await expect(dialog).toContainText("merge gate");
    await expect(dialog).toContainText("dc254a2a");
    await expect(dialog).toContainText("spinner");

    // CANCEL — the save is held, not merely deferred.
    await page.getByTestId("codex-default-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("unsaved changes")).toBeVisible();
    await expect(globalSave).toBeEnabled();
    expect(await readPlatformDefault(loomDaemon.baseURL)).toBeNull();

    // ACCEPT — the same click now lands.
    await globalSave.click();
    await page.getByTestId("codex-default-accept").click();
    await expect.poll(() => readPlatformDefault(loomDaemon.baseURL)).toBe("codex");

    // …and a reload re-seeds the control from the persisted override, not from optimistic client state.
    await page.reload();
    await expect(selectIn(page, "platform", "Vendor CLI")).toHaveValue("codex");
    await expect(panelOf(page, "platform")).toContainText("effective: Codex CLI");
  });

  // The gate's own falsifiability control. If the confirm were keyed to "the harness field changed" rather
  // than to the DIRECTION of the change, this test would fail — and the earlier one would still pass.
  test("switching back off codex is not gated", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`harness-back-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${loomDaemon.loopbackSecret}` },
      body: JSON.stringify({ config: { harness: { default: "codex" } } }),
    });

    await page.goto(`${loomDaemon.baseURL}/settings`);
    const sel = selectIn(page, "platform", "Vendor CLI");
    await expect(sel).toHaveValue("codex");

    await sel.selectOption("claude");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await globalSave.click();

    // No dialog at all — the save goes straight through to the store.
    await expect(page.getByTestId("codex-default-confirm")).toHaveCount(0);
    await expect.poll(() => readPlatformDefault(loomDaemon.baseURL)).toBe("claude");
  });

  // `scope:"fleet"` is rejected by BOTH config validators until HARNESS_FLEET_ROLES widens (card 4c4eb9af),
  // so the option is shown DISABLED with the reason rather than hidden — a silently-absent option reads as
  // a UI that forgot it. The sibling "workers" option must stay genuinely usable, which is what keeps this
  // from being a select nobody can touch.
  test("the fleet scope is offered disabled with its reason, and workers remains settable", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`harness-scope-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const scope = selectIn(page, "platform", "Roles covered");
    await expect(scope).toBeVisible();
    await expect(scope).toHaveValue("");

    await expect(scope.locator('option[value="fleet"]')).toHaveJSProperty("disabled", true);
    await expect(scope.locator('option[value="workers"]')).toHaveJSProperty("disabled", false);
    await expect(panelOf(page, "platform")).toContainText("4c4eb9af");
    // The roles-affected copy is read off the SAME shared allowlist the daemon resolves spawns with.
    await expect(panelOf(page, "platform")).toContainText("worker sessions only");

    // BEFORE/AFTER on the control that IS usable: an explicit "workers" override is a real edit (the
    // stored value was inherit), so it dirties the form and persists.
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await expect(globalSave).toBeDisabled();
    await scope.selectOption("workers");
    await expect(globalSave).toBeEnabled();
    await globalSave.click();
    await expect.poll(() => readPlatformHarness(loomDaemon.baseURL).then((h) => h?.scope ?? null)).toBe("workers");
  });

  // The per-project layer + the REAL drain endpoint, end to end. The seeded worker is pinned to claude
  // while the project default resolves to codex, which is exactly the "off target" condition
  // `harnessDrainStatus` derives — no stored drain state is involved anywhere.
  test("a project override drains a live claude worker, and the banner reflects the real endpoint", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`harness-drain-${Date.now()}`);
    const worker = await loomDaemon.seedLiveSession({ project, role: "worker", harness: "claude", agentName: "Drain Worker" });
    await pinActiveProject(page, project.id);

    // BEFORE — fixture identity, straight off the endpoint: the project has no override, so the worker's
    // claude is on target and there is nothing to drain.
    const before = await readDrain(loomDaemon.baseURL, project.id);
    expect(before.target).toBe("claude");
    expect(before.done).toBe(true);

    await page.goto(`${loomDaemon.baseURL}/settings`);
    const panel = panelOf(page, "project");
    await expect(panel.getByTestId("harness-drain")).toHaveAttribute("data-done", "true");

    // ACT — flip this project's default to codex, through the same confirm the platform layer uses.
    const sel = selectIn(page, "project", "Vendor CLI");
    await expect(sel).toHaveValue("");
    await sel.selectOption("codex");
    const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
    await expect(projectSave).toBeEnabled();
    await projectSave.click();
    // The SAME gate guards this layer — the dialog is shared, not a platform-only affordance.
    await expect(page.getByTestId("codex-default-confirm")).toBeVisible();
    await page.getByTestId("codex-default-accept").click();

    // AFTER (observable #1) — the human/REST config path persisted the override.
    await expect.poll(() => readProjectHarness(loomDaemon.baseURL, project.id).then((h) => h?.default ?? null)).toBe("codex");

    // AFTER (observable #2) — the endpoint now derives this exact session as pending. Asserted on the WIRE
    // first: if `harness` did not survive `resolveAgentSpawn`'s default layer the UI check below would fail
    // for an unrelated reason, and this read is the only thing that tells the two apart.
    await expect
      .poll(async () => {
        const d = await readDrain(loomDaemon.baseURL, project.id);
        return { target: d.target, done: d.done, pending: d.pending.map((p) => p.sessionId) };
      })
      .toEqual({ target: "codex", done: false, pending: [worker.sessionId] });

    // AFTER (observable #3) — the banner re-read it without a reload (the save invalidates its query), and
    // names the session rather than only a count.
    const drain = panel.getByTestId("harness-drain");
    await expect(drain).toHaveAttribute("data-done", "false");
    await expect(panel.getByTestId("harness-drain-pending")).toContainText(worker.sessionId.slice(0, 8));
    await expect(drain).toContainText("1 session still to move");
    // ── The headline names the POPULATION, never a destination, and the scope default is stated
    // separately with its own caveat. This pair is a REGRESSION PIN, found by eyeballing rather than by a
    // test: the banner originally read "Draining to {target}", and `target` is NOT every listed row's
    // destination. In FLEET scope they diverge exactly as they do right here — this project now defaults
    // to codex, so its claude worker is pending, while the FLEET default is still claude. The old copy
    // rendered that as "Draining to Claude Code … runs claude", a session listed as moving to the harness
    // it already runs. The project-scoped case alone could never catch it, because there the scope default
    // and the per-session answer always agree.
    await expect(drain.getByTestId("harness-drain-scope")).toContainText("Target: Codex CLI");
    await expect(drain.getByTestId("harness-drain-scope")).toContainText("this project's default");

    const fleetDrain = panelOf(page, "platform").getByTestId("harness-drain");
    await expect(fleetDrain).toHaveAttribute("data-done", "false");
    await expect(fleetDrain.getByTestId("harness-drain-scope")).toContainText("Fleet default: Claude Code");
    await expect(fleetDrain.getByTestId("harness-drain-scope")).toContainText("may be heading somewhere else");
    // …and it must NOT present that fleet default as where the listed session is going.
    await expect(fleetDrain).not.toContainText("Draining to");
    // Nothing is blocked, so that group must not render at all — otherwise "blocked" could be an empty
    // heading that always shows and the next test would prove nothing.
    await expect(panel.getByTestId("harness-drain-blocked")).toHaveCount(0);

    // …and the two-layer effective hint follows the override.
    await expect(panel).toContainText("effective: Codex CLI");
  });

  // ── The BLOCKED branch, route-fulfilled, and why.
  //
  // A blocked row is a manager/platform-lead whose SESSION ROW carries codex-incompatible fields
  // (restrictedTools / browserTesting / documentConversion / capabilities — see `recycleHarness` →
  // `codexIncompatibilities`). The test-only seed route models none of those four on `liveSessions`: it
  // takes id/projectId/agentId/role/parentSessionId/taskId/title/busy/branch/model/processState/
  // ctxInputTokens/ptyGeometry/ptyBytes/harness and nothing else, and those fields are otherwise written
  // only by a real spawn — which is exactly what the no-spawn guard forbids. So there is NO seed path to
  // this state, and the sanctioned substitute is to fulfil the endpoint with its own real contract shape,
  // driving the real component with real props (same posture as the Gates ACTIVE lane).
  //
  // What this therefore does NOT prove: that the daemon ever classifies a session as blocked. That half
  // lives in the daemon's own tests for `harnessDrainStatus`. What it DOES prove is the half the fulfilled
  // payload cannot fake — that blocked sessions render as their own group, separated from pending, with
  // their per-reason detail rather than folded into one count a reader would wait out forever.
  test("the drain banner separates blocked sessions from pending ones and shows their reasons", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`harness-blocked-${Date.now()}`);
    await pinActiveProject(page, project.id);

    await page.route("**/api/harness/drain*", (route) =>
      route.fulfill({
        json: {
          target: "codex",
          scope: { projectId: project.id },
          pending: [{ sessionId: "pend0001-0000-0000-0000-000000000001", role: "worker", harness: "claude", projectId: project.id }],
          blocked: [{
            sessionId: "blok0001-0000-0000-0000-000000000002",
            role: "manager",
            harness: "claude",
            projectId: project.id,
            wanted: "codex",
            reasons: [{ id: "restrictedTools", reason: "restrictedTools is not supported on harness \"codex\" — codex has no per-native-tool disallow mechanism." }],
          }],
          done: false,
        },
      }));

    await page.goto(`${loomDaemon.baseURL}/settings`);
    const drain = panelOf(page, "project").getByTestId("harness-drain");
    await expect(drain).toHaveAttribute("data-done", "false");

    // The headline counts the two populations SEPARATELY — a single total would tell the owner to wait for
    // a session that is never going to move.
    await expect(drain).toContainText("1 session still to move");
    await expect(drain).toContainText("1 that never will");

    const pending = panelOf(page, "project").getByTestId("harness-drain-pending");
    const blocked = panelOf(page, "project").getByTestId("harness-drain-blocked");
    await expect(pending).toContainText("pend0001");
    await expect(pending).not.toContainText("blok0001");
    await expect(blocked).toContainText("blok0001");
    await expect(blocked).toContainText("will never move");
    // The per-reason detail is what makes a blocked row actionable — the field to change is named.
    await expect(blocked.getByTestId("harness-drain-reason-restrictedTools")).toContainText("per-native-tool disallow");
  });
});
