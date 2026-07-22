// Settings spec (card 18e27876) — proves the Settings page (/settings) both RENDERS the resolved config
// and PERSISTS edits through the human/REST config path. Two write surfaces are covered end to end with an
// observable before/after:
//   1. Project config (PATCH /api/projects/:id/config) — the human-only `gateCommand` field (editable here
//      by design; only the agent MCP validator rejects it) round-trips: type → Save → REST read-back shows
//      it → reload re-seeds it into the field.
//   2. Daemon-global platform config (PATCH /api/platform/config) — a watcher/timeout field round-trips to
//      the stored override (canonical ms), read back over REST.
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template.
//
// Determinism note: the Settings project section is scoped to the ACTIVE project (localStorage
// `loom.projectId`, see lib/activeProject.tsx). The worker-scoped daemon is SHARED across the specs in this
// file, so more than one project can exist on it and the auto-resolved "first project" is not stable. Every
// test therefore PINS its own seeded project as active via addInitScript BEFORE navigating, so it never
// races another test's project.
import { expect, test } from "./fixtures/daemon";

// Locate a config field's control by the EXACT text of its label <span>. getByLabel is unusable here: each
// field's <label> also nests its Hint text, which pollutes the accessible name AND makes "Gate command"
// collide with "Gate command timeout (s)". `label:has(> span:text-is(...))` pins the exact label span, then
// descends to the control — precise regardless of the hint text.
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test("renders the active project's config and the daemon-global config", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-render-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Project section renders, scoped to the pinned project.
  await expect(page.getByText("Project Settings", { exact: true })).toBeVisible();
  await expect(page.getByText("Editing", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Orchestration Caps", { exact: true })).toBeVisible();
  await expect(field(page, "Gate command")).toBeVisible();
  // A resolved "effective: …" hint confirms the seeded/default config actually resolved (not just an empty
  // shell) — resolveConfig ran and rendered real values.
  await expect(page.getByText(/effective:/).first()).toBeVisible();

  // The daemon-global section loads over GET /api/platform/config; "Rate Limits" only appears once that
  // query resolves, so asserting it visible also proves the platform-config read endpoint works.
  await expect(page.getByText("Global / Daemon", { exact: true })).toBeVisible();
  await expect(page.getByText("Rate Limits", { exact: true })).toBeVisible();
  await expect(field(page, "Git push (s)")).toBeVisible();
});

test("editing the project gate command persists (REST read-back + reload)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-project-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const gate = field(page, "Gate command");
  // BEFORE: a freshly seeded project has no gateCommand override, so the field is empty.
  await expect(gate).toHaveValue("");

  await gate.fill("pnpm build");
  // The ConfigEditor Save is the FIRST "Save" button in DOM order (the project section precedes the global
  // section; RepoPathEditor's button is "Rebind", not "Save"). It enables only once the form is dirty.
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  // AFTER (observable #1): the human/REST config path persisted it — read it straight back off the store the
  // UI shares. gateCommand is the card's named human-only field; it is editable on THIS path by design.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { gateCommand?: string } } }>;
      return projects.find((p) => p.id === project.id)?.config?.orchestration?.gateCommand ?? null;
    })
    .toBe("pnpm build");

  // AFTER (observable #2): a full reload re-seeds the field from the persisted override — not just optimistic
  // client state.
  await page.reload();
  await expect(field(page, "Gate command")).toHaveValue("pnpm build");
});

test("editing a daemon-global setting persists to the platform override", async ({ page, loomDaemon }) => {
  // Pin a project so the page is fully populated, though the global section is project-independent.
  const project = await loomDaemon.createProject(`settings-global-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Wait for the platform-config query to resolve (the global fields only mount after it loads).
  const gitPush = field(page, "Git push (s)");
  await expect(gitPush).toBeVisible();

  // 47s is an arbitrary non-default value so the read-back is unambiguous. The form displays SECONDS and
  // stores canonical ms (×1000).
  await gitPush.fill("47");
  // The global Save is the LAST "Save" button (the global section follows the project section in DOM order).
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  await expect(globalSave).toBeEnabled();
  await globalSave.click();

  // Observable: the platform override now carries gitPushMs = 47_000 (47s in canonical ms).
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { timeouts?: { gitPushMs?: number } } };
      return body?.override?.timeouts?.gitPushMs ?? null;
    })
    .toBe(47_000);
});

test("editing maxConcurrentGates: blank inherits, a set value persists, blank-AFTER-set CLEARS the override (card fd55ac8a), a bad value surfaces a readable 400 (card 13eda2eb)", async ({ page, loomDaemon }) => {
  // The daemon-global gate-concurrency cap surfaced as its own control. Per the card the field OMITS on
  // blank (a top-level scalar, like schedulerEnabled) — a blank field is not overridden, so it inherits the
  // platform default. This proves the DoD behaviors: blank = inherit, a set value PATCHes + persists, a
  // PREVIOUSLY-SET value blanked-and-saved again actually CLEARS the persisted override (not just leaves
  // the stale last-saved value in place — the pre-fix bug this card exists for), and a bad value 400s
  // readably. (A daemon-global setting has no per-test isolation on this shared worker-scoped daemon, so
  // the field is exercised on whatever state prior tests left; the assertions read the override + effective
  // hint directly rather than assuming a pristine start.)
  const project = await loomDaemon.createProject(`settings-gates-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const gates = field(page, "Max concurrent merge/deploy gates");
  await expect(gates).toBeVisible();
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  // The field's own label container, so the "effective: N" hint assertion can't match another field's hint.
  const gatesLabel = page.locator('label:has(> span:text-is("Max concurrent merge/deploy gates"))');

  const readGatesOverride = async (): Promise<number | null> => {
    const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    const body = (await res.json()) as { override?: { maxConcurrentGates?: number } };
    return body?.override?.maxConcurrentGates ?? null;
  };

  // BLANK = INHERIT (unset field): confirm the resolved value the hint shows is the platform default (1) —
  // a never-set field resolves to the inherited default. The placeholder states the same revert target.
  await gates.fill("");
  await expect(gatesLabel.getByText("effective: 1")).toBeVisible();
  await expect(gates).toHaveAttribute("placeholder", "inherit (default 1)");

  // SET: 4 is a valid in-bounds, non-default value so the read-back is unambiguous.
  await gates.fill("4");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  // Observable #1 (BEFORE the clear): the platform override now carries maxConcurrentGates = 4 (a
  // top-level key, not nested).
  await expect.poll(readGatesOverride).toBe(4);
  // Observable #2: a reload re-seeds the field from the persisted override — not just optimistic state.
  await page.reload();
  await expect(field(page, "Max concurrent merge/deploy gates")).toHaveValue("4");

  // CLEAR (card fd55ac8a): blanking this NOW-SET field and saving again must actually revert it to
  // inherit — the PATCH handler used to shallow-merge and OMIT an untouched/blank field, so a set→blank
  // round-trip silently kept the stale 4 forever. Observable AFTER: the stored override no longer carries
  // the key at all (not merely re-defaulted client-side) AND the effHint reverts to the platform default.
  const gatesAfterSet = field(page, "Max concurrent merge/deploy gates");
  await gatesAfterSet.fill("");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readGatesOverride).toBeNull();
  await expect(gatesLabel.getByText("effective: 1")).toBeVisible();
  // A reload re-seeds the field from the CLEARED persisted override (blank, not the stale "4").
  await page.reload();
  await expect(field(page, "Max concurrent merge/deploy gates")).toHaveValue("");

  // BAD VALUE: 99 is outside the control's advertised 1–50 bound. buildGlobalOverride sends it verbatim; the
  // strict-zod PATCH 400s with a field-named reason (formatZodIssues prefixes the path), surfaced inline —
  // never silently accepted, and the persisted (now-cleared) value stays unchanged.
  const gatesAfterReload = field(page, "Max concurrent merge/deploy gates");
  await gatesAfterReload.fill("99");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentGates/).first()).toBeVisible();
  await expect.poll(readGatesOverride).toBeNull();

  // NON-NUMERIC is likewise rejected — routed through as the literal string (not NaN, which JSON-
  // serializes to `null` and would collide with the clear sentinel) — so it 400s distinctly from a real
  // clear, rather than being silently accepted as one.
  await gatesAfterReload.fill("abc");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentGates/).first()).toBeVisible();
  await expect.poll(readGatesOverride).toBeNull();
});

test("editing maxConcurrentManagers (card 52ab5d45): blank inherits, a set value persists, blank-AFTER-set clears, a bad value 400s", async ({ page, loomDaemon }) => {
  // The fleet-wide scheduler-manager cap, mirroring the maxConcurrentGates test above end to end — this
  // field is the fix for the bug where the cron Scheduler's cap was always deaf to any override (no
  // PlatformConfigOverride key existed for it) and the per-project "Max managers" field was actively
  // misleading (the Scheduler never read it). Same shared-daemon caveat as the gates test: assertions read
  // the override + effective hint directly rather than assuming a pristine start.
  const project = await loomDaemon.createProject(`settings-managers-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const label = "Max concurrent scheduler-spawned managers · restart required";
  const managers = field(page, label);
  await expect(managers).toBeVisible();
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  const managersLabel = page.locator(`label:has(> span:text-is(${JSON.stringify(label)}))`);

  const readManagersOverride = async (): Promise<number | null> => {
    const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    const body = (await res.json()) as { override?: { maxConcurrentManagers?: number } };
    return body?.override?.maxConcurrentManagers ?? null;
  };

  // BLANK = INHERIT: the platform default is 3 (ZERO behavior change from today's PLATFORM_DEFAULTS).
  await managers.fill("");
  await expect(managersLabel.getByText(/effective: 3/)).toBeVisible();
  await expect(managers).toHaveAttribute("placeholder", "inherit (default 3)");

  // SET: 7 is a valid in-bounds, non-default value so the read-back is unambiguous.
  await managers.fill("7");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readManagersOverride).toBe(7);
  // A reload re-seeds the field from the persisted override — not just optimistic client state.
  await page.reload();
  await expect(field(page, label)).toHaveValue("7");

  // CLEAR: blanking this NOW-SET field and saving again must actually DELETE the persisted key (revert to
  // inherit), not merely omit it while the stale 7 survives underneath (the fd55ac8a-class bug).
  const managersAfterSet = field(page, label);
  await managersAfterSet.fill("");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readManagersOverride).toBeNull();
  await expect(managersLabel.getByText(/effective: 3/)).toBeVisible();
  await page.reload();
  await expect(field(page, label)).toHaveValue("");

  // BAD VALUE: 999 is outside the control's advertised 1–100 bound — the strict-zod PATCH 400s readably
  // (field-named reason) and the persisted (now-cleared) value stays unchanged.
  const managersAfterReload = field(page, label);
  await managersAfterReload.fill("999");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentManagers/).first()).toBeVisible();
  await expect.poll(readManagersOverride).toBeNull();

  // NON-NUMERIC is likewise rejected — routed through as the literal string, so it 400s distinctly from a
  // real clear rather than silently colliding with the null sentinel.
  await managersAfterReload.fill("abc");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentManagers/).first()).toBeVisible();
  await expect.poll(readManagersOverride).toBeNull();
});

test("editing maxConcurrentAuditors (sweep G2): blank inherits, a set value persists, blank-AFTER-set clears, a bad value 400s", async ({ page, loomDaemon }) => {
  // The fleet-wide scheduler-AUDITOR cap — mirrors the maxConcurrentManagers test above end to end (its
  // near-exact sibling: a SEPARATE daemon-global budget for scheduler-spawned auditor sessions, same
  // blank-to-inherit / restart-required shape, just its own 1-50 bound instead of 1-100).
  const project = await loomDaemon.createProject(`settings-auditors-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const label = "Max concurrent scheduler-spawned auditors · restart required";
  const auditors = field(page, label);
  await expect(auditors).toBeVisible();
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  const auditorsLabel = page.locator(`label:has(> span:text-is(${JSON.stringify(label)}))`);

  const readAuditorsOverride = async (): Promise<number | null> => {
    const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    const body = (await res.json()) as { override?: { maxConcurrentAuditors?: number } };
    return body?.override?.maxConcurrentAuditors ?? null;
  };

  // BLANK = INHERIT: the platform default is 2 (ZERO behavior change from today's
  // DEFAULT_MAX_CONCURRENT_AUDITORS constant).
  await auditors.fill("");
  await expect(auditorsLabel.getByText(/effective: 2/)).toBeVisible();
  await expect(auditors).toHaveAttribute("placeholder", "inherit (default 2)");

  // SET: 6 is a valid in-bounds, non-default value so the read-back is unambiguous.
  await auditors.fill("6");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readAuditorsOverride).toBe(6);
  // A reload re-seeds the field from the persisted override — not just optimistic client state.
  await page.reload();
  await expect(field(page, label)).toHaveValue("6");

  // CLEAR: blanking this NOW-SET field and saving again must actually DELETE the persisted key (revert to
  // inherit), not merely omit it while the stale 6 survives underneath (the fd55ac8a-class bug).
  const auditorsAfterSet = field(page, label);
  await auditorsAfterSet.fill("");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readAuditorsOverride).toBeNull();
  await expect(auditorsLabel.getByText(/effective: 2/)).toBeVisible();
  await page.reload();
  await expect(field(page, label)).toHaveValue("");

  // BAD VALUE: 999 is outside the control's advertised 1–50 bound — the strict-zod PATCH 400s readably
  // (field-named reason) and the persisted (now-cleared) value stays unchanged.
  const auditorsAfterReload = field(page, label);
  await auditorsAfterReload.fill("999");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentAuditors/).first()).toBeVisible();
  await expect.poll(readAuditorsOverride).toBeNull();

  // NON-NUMERIC is likewise rejected — routed through as the literal string, so it 400s distinctly from a
  // real clear rather than silently colliding with the null sentinel.
  await auditorsAfterReload.fill("abc");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect(page.getByText(/maxConcurrentAuditors/).first()).toBeVisible();
  await expect.poll(readAuditorsOverride).toBeNull();
});

test("editing a message-delivery toggle (coalesceAgentMessages): set persists, clearing back to inherit CLEARS the override (card fd55ac8a)", async ({ page, loomDaemon }) => {
  // The tri-state toggles (coalesceAgentMessages/operatorEnabled/schedulerEnabled) share the same
  // clear-to-inherit fix as maxConcurrentGates above — selecting "— inherit" and saving must actually
  // DELETE the persisted key, not just omit it from the PATCH while the last-saved boolean survives
  // underneath. Exercised here on coalesceAgentMessages (default OFF); the other two toggles share the
  // identical TriSelect + buildGlobalOverride code path.
  const project = await loomDaemon.createProject(`settings-coalesce-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const labelText = "Group agent & worker messages into a single turn (legacy)";
  const toggle = field(page, labelText);
  await expect(toggle).toBeVisible();
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  const toggleLabel = page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`);

  const readOverride = async (): Promise<boolean | null> => {
    const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    const body = (await res.json()) as { override?: { coalesceAgentMessages?: boolean } };
    return body?.override?.coalesceAgentMessages ?? null;
  };

  // SET: flip it on — the platform default is off, so `true` is an unambiguous non-default value.
  await toggle.selectOption("true");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  // Observable #1 (BEFORE the clear): the override now carries coalesceAgentMessages = true.
  await expect.poll(readOverride).toBe(true);
  await expect(toggleLabel.getByText("effective: true")).toBeVisible();
  await page.reload();
  await expect(field(page, labelText)).toHaveValue("true");

  // CLEAR (card fd55ac8a): select "— inherit" and save. Observable AFTER: the stored override no longer
  // carries the key at all AND the effective hint reverts to the platform default (false) — not merely a
  // client-side re-default while `true` survives underneath in the DB.
  const toggleAfterSet = field(page, labelText);
  await toggleAfterSet.selectOption("inherit");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readOverride).toBeNull();
  await expect(toggleLabel.getByText("effective: false")).toBeVisible();
  // A reload re-seeds "— inherit" from the CLEARED override (not the stale "true").
  await page.reload();
  await expect(field(page, labelText)).toHaveValue("inherit");
});

test.describe("cross-group sibling preservation (code-review fix, card fd55ac8a; deep-merge, card ba9ccd75)", () => {
  // This spec seeds rateLimit.exhaustedThresholdPct directly and sets watchers.wakeMs through the UI, on
  // the SHARED worker-scoped daemon. Both are inert to every other spec today (nothing else reads
  // exhaustedThresholdPct; wakeMs is boot-bound, per event-triggers.spec.ts's determinism note this is
  // exactly the class of shared-daemon leakage that has broken this suite before) — clear both back out
  // via the clear-to-inherit sentinel this same card built, so nothing survives to the next spec.
  test.afterEach(async ({ loomDaemon }) => {
    await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { rateLimit: null, watchers: null, timeouts: null } }),
    });
  });

  test("saving the Watcher Cadences grid PRESERVES a Rate Limits field it doesn't touch (cross-group, not just cross-panel)", async ({ page, loomDaemon }) => {
    // rateLimit.exhaustedThresholdPct now has its OWN control (sweep §2 — "Exhausted threshold (%)"), but
    // it's built in buildGlobalOverride as a hand-folded addition to the rateLimit group's entries object,
    // not through the shared GLOBAL_FIELDS ms-loop — so it's still worth proving a save of a DIFFERENT
    // group (watchers) round-trips this field's CURRENTLY-LOADED value unchanged rather than losing it.
    // Before card ba9ccd75 a submitted group REPLACED the persisted one wholesale (the PATCH handler's
    // shallow TOP-LEVEL merge); now the handler DEEP-merges field by field. Seed it directly over REST
    // (bypassing the UI, exactly as a human curl'ing the PATCH endpoint would), confirm the control picks
    // up the seeded value, then save with only an unrelated watchers field touched and confirm it survives.
    const seed = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { rateLimit: { exhaustedThresholdPct: 77 } } }),
    });
    expect(seed.ok).toBe(true);

    const project = await loomDaemon.createProject(`settings-nongrid-sibling-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // The seeded value loaded straight into its own control.
    await expect(field(page, "Exhausted threshold (%)")).toHaveValue("77");

    // Touch an UNRELATED daemon-global field (Watcher Cadences, not Rate Limits) so Save enables — the
    // Rate Limits panel is never interacted with, only re-sent from its already-loaded state.
    const wakeMs = field(page, "Wake tick (s)");
    await expect(wakeMs).toBeVisible();
    await wakeMs.fill("50");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await expect(globalSave).toBeEnabled();
    await globalSave.click();

    const readExhaustedThreshold = async (): Promise<number | null> => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { rateLimit?: { exhaustedThresholdPct?: number } } };
      return body?.override?.rateLimit?.exhaustedThresholdPct ?? null;
    };
    // Observable: the sibling field survives a save that touched a different group entirely — not
    // silently wiped by a whole-group replace.
    await expect.poll(readExhaustedThreshold).toBe(77);
    // And the edited, unrelated field actually took (proving the save was real, not a no-op).
    await expect
      .poll(async () => {
        const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
        const body = (await res.json()) as { override?: { watchers?: { wakeMs?: number } } };
        return body?.override?.watchers?.wakeMs ?? null;
      })
      .toBe(50_000);
  });

  test("editing Exhausted threshold (%) directly: a set value persists, blank clears to inherit (sweep §2)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`settings-exhausted-pct-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const pct = field(page, "Exhausted threshold (%)");
    await expect(pct).toBeVisible();
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();

    const readPct = async (): Promise<number | null> => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { rateLimit?: { exhaustedThresholdPct?: number } } };
      return body?.override?.rateLimit?.exhaustedThresholdPct ?? null;
    };

    await pct.fill("90");
    await expect(globalSave).toBeEnabled();
    await globalSave.click();
    await expect.poll(readPct).toBe(90);
    await page.reload();
    await expect(field(page, "Exhausted threshold (%)")).toHaveValue("90");

    // CLEAR: blanking the now-set field and saving reverts it to inherit (the per-field null sentinel).
    await field(page, "Exhausted threshold (%)").fill("");
    await expect(globalSave).toBeEnabled();
    await globalSave.click();
    await expect.poll(readPct).toBeNull();
  });

  test("blanking a PREVIOUSLY-SET rendered grid field actually clears it, while a resent sibling in the same group survives (card ba9ccd75)", async ({ page, loomDaemon }) => {
    // The load-bearing risk on card ba9ccd75: "blank a grid field → Save → it clears" worked pre-fix only
    // BECAUSE the group replaced wholesale (any field the form didn't resend was gone by construction).
    // Under the deep merge that same outcome now depends on buildGlobalOverride sending an explicit
    // per-field `null` for a blanked field, instead of just omitting it (omitted now means "leave alone"
    // at the field level too) — if that per-field null stopped firing, this is exactly the regression
    // that would silently ship: a blanked field would stop clearing and just sit there stale. Seed TWO
    // fields in the same group (timeouts) directly over REST, exactly as two prior grid saves would have
    // left them, then blank only one through the UI and confirm it — and only it — clears.
    const seed = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { timeouts: { busyStaleMs: 120000, provisionMs: 300000 } } }),
    });
    expect(seed.ok).toBe(true);

    const project = await loomDaemon.createProject(`settings-grid-field-clear-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const busyStale = field(page, "PTY busy-stale (s)");
    const provision = field(page, "Worktree provision (s)");
    // BEFORE: both fields render the seeded values (proves the load happened, not just that both are
    // blank by coincidence).
    await expect(busyStale).toHaveValue("120");
    await expect(provision).toHaveValue("300");

    // Blank ONLY busyStaleMs; leave provisionMs exactly as loaded (a non-blank, unchanged resend).
    await busyStale.fill("");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await expect(globalSave).toBeEnabled();
    await globalSave.click();

    const readTimeouts = async (): Promise<{ busyStaleMs?: number; provisionMs?: number }> => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { timeouts?: { busyStaleMs?: number; provisionMs?: number } } };
      return body?.override?.timeouts ?? {};
    };
    // Observable #1: the blanked field is actually GONE from the persisted override — the per-field null
    // sentinel fired, not left stale under the new deep-merge contract.
    await expect.poll(async () => (await readTimeouts()).busyStaleMs).toBeUndefined();
    // Observable #2: the sibling the grid resent unchanged (non-blank) survives — the deep merge applied
    // it, rather than the whole group having been nulled.
    await expect.poll(async () => (await readTimeouts()).provisionMs).toBe(300_000);

    // A reload re-seeds the cleared field back to blank — not the stale "120" — and the surviving sibling
    // still shows its value.
    await page.reload();
    await expect(field(page, "PTY busy-stale (s)")).toHaveValue("");
    await expect(field(page, "Worktree provision (s)")).toHaveValue("300");
  });

  test("typing garbage into a grid field 400s and does NOT silently clear it (code-review catch, card ba9ccd75)", async ({ page, loomDaemon }) => {
    // The Code Reviewer catch on ba9ccd75: widening the per-field schema to accept `null` removed a guard
    // this grid was leaning on without its own backstop. `Number("abc")` is NaN, which JSON.stringify()s
    // to `null` — the SAME wire shape as the legitimate clear sentinel — so pre-fix this would have
    // silently "succeeded" as a clear (200, value reverted to inherit) instead of 400ing. Seed a field,
    // type garbage into it, and prove BOTH halves: a readable 400 surfaces, AND the persisted value is
    // untouched (not cleared).
    const seed = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { timeouts: { busyStaleMs: 120000 } } }),
    });
    expect(seed.ok).toBe(true);

    const project = await loomDaemon.createProject(`settings-grid-garbage-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const busyStale = field(page, "PTY busy-stale (s)");
    await expect(busyStale).toHaveValue("120");

    await busyStale.fill("abc");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
    await expect(globalSave).toBeEnabled();
    await globalSave.click();

    // A readable 400 surfaces inline (field-named, like the maxConcurrentGates bad-value case above).
    await expect(page.getByText(/busyStaleMs/).first()).toBeVisible();

    // NOT cleared: the persisted value is exactly what it was before Save, not gone.
    const readBusyStale = async (): Promise<number | null> => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { timeouts?: { busyStaleMs?: number } } };
      return body?.override?.timeouts?.busyStaleMs ?? null;
    };
    await expect.poll(readBusyStale).toBe(120_000);
  });
});

// Card 503a30a0 (owner privacy constraint): the "Codescape" host-tool integration row was removed from
// Settings — codescape is a private internal tool and must have NO discoverable web-Settings surface on
// a vanilla install. The two e2e specs that used to live here (editing / clearing the field through the
// UI) are retired along with the UI; the underlying `integrations.codescape.path` REST round-trip (set,
// persist, clear-back) stays covered directly against the REST API by
// packages/daemon/test/platform-config.mjs's "(14) host-tool integrations" section, which never went
// through the web UI at all.

test("editing the newly-added watcher/timeout fields (crashRecoveryWatchMs, runMs) persists (sweep §2)", async ({ page, loomDaemon }) => {
  // Same GLOBAL_FIELDS grid + buildGlobalOverride ms-loop as every other watcher/timeout field (e.g. the
  // "Git push (s)" test above) — these two were simply absent from GLOBAL_FIELDS until this card.
  const project = await loomDaemon.createProject(`settings-watchtimeouts-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const crashRecovery = field(page, "Crash-recovery watch (s)");
  const runTimeout = field(page, "Agent Run hard timeout (s)");
  await expect(crashRecovery).toBeVisible();
  await expect(runTimeout).toBeVisible();

  await crashRecovery.fill("90");
  await runTimeout.fill("900");
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  await expect(globalSave).toBeEnabled();
  await globalSave.click();

  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { watchers?: { crashRecoveryWatchMs?: number }; timeouts?: { runMs?: number } } };
      return { crashRecoveryWatchMs: body?.override?.watchers?.crashRecoveryWatchMs ?? null, runMs: body?.override?.timeouts?.runMs ?? null };
    })
    .toEqual({ crashRecoveryWatchMs: 90_000, runMs: 900_000 });

  await page.reload();
  await expect(field(page, "Crash-recovery watch (s)")).toHaveValue("90");
  await expect(field(page, "Agent Run hard timeout (s)")).toHaveValue("900");
});

test("editing the Authenticated Request Guard (connections) fields persists wholesale, and clearing all of them reverts to inherit (sweep §2)", async ({ page, loomDaemon }) => {
  // `connections` is NOT a DEEP_MERGE_GROUPS member — a submitted group REPLACES the persisted one
  // wholesale, exactly like `integrations` above — so all 4 fields are modeled and always emitted
  // together (blank fields omit that key, clearing it to default).
  const project = await loomDaemon.createProject(`settings-connections-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  await expect(page.getByText("Authenticated Request Guard", { exact: true })).toBeVisible();
  const reqTimeout = field(page, "Request timeout (s)");
  const maxBytes = field(page, "Max response bytes");
  const rateLimitMax = field(page, "Rate limit (requests / window)");
  const rateLimitWindow = field(page, "Rate limit window (m)");
  await expect(reqTimeout).toBeVisible();

  const readConnections = async () => {
    const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    const body = (await res.json()) as { override?: { connections?: Record<string, number> } };
    return body?.override?.connections ?? {};
  };

  await reqTimeout.fill("15");
  await maxBytes.fill("2000000");
  await rateLimitMax.fill("50");
  await rateLimitWindow.fill("10");
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  await expect(globalSave).toBeEnabled();
  await globalSave.click();

  await expect
    .poll(readConnections)
    .toEqual({ requestTimeoutMs: 15_000, maxResponseBytes: 2_000_000, rateLimitMax: 50, rateLimitWindowMs: 600_000 });

  await page.reload();
  await expect(field(page, "Request timeout (s)")).toHaveValue("15");
  await expect(field(page, "Max response bytes")).toHaveValue("2000000");
  await expect(field(page, "Rate limit (requests / window)")).toHaveValue("50");
  await expect(field(page, "Rate limit window (m)")).toHaveValue("10");

  // CLEAR all 4 — since the group is always emitted, blanking every field replaces the persisted
  // `connections` override with an empty object (every field reverts to its platform default).
  await field(page, "Request timeout (s)").fill("");
  await field(page, "Max response bytes").fill("");
  await field(page, "Rate limit (requests / window)").fill("");
  await field(page, "Rate limit window (m)").fill("");
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect.poll(readConnections).toEqual({});
});

test("editing the project Memory fields persists, and clearing them removes the override (card 2fd9abf9 UI, sweep §2)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-memory-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const budget = field(page, "Budget (tokens)");
  const topK = field(page, "Related notes (top K)");
  const maxNotes = field(page, "Max unpinned notes");
  await expect(budget).toBeVisible();
  await expect(budget).toHaveValue("");

  await budget.fill("3000");
  await topK.fill("12");
  await maxNotes.fill("200");
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  const readMemory = async () => {
    const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
    const projects = (await res.json()) as Array<{ id: string; config?: { memory?: { budgetTokens?: number; topK?: number; maxNotes?: number } } }>;
    return projects.find((p) => p.id === project.id)?.config?.memory ?? null;
  };
  await expect.poll(readMemory).toEqual({ budgetTokens: 3000, topK: 12, maxNotes: 200 });

  await page.reload();
  await expect(field(page, "Budget (tokens)")).toHaveValue("3000");
  await expect(field(page, "Related notes (top K)")).toHaveValue("12");
  await expect(field(page, "Max unpinned notes")).toHaveValue("200");

  // CLEAR: blanking every field deletes the whole `memory` override key (inherits the platform default).
  await field(page, "Budget (tokens)").fill("");
  await field(page, "Related notes (top K)").fill("");
  await field(page, "Max unpinned notes").fill("");
  await expect(projectSave).toBeEnabled();
  await projectSave.click();
  await expect.poll(readMemory).toBeNull();
});

test("editing the project Deploy command + its timeout persists (mirrors gateCommand, sweep §2)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-deploy-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const deployCommand = field(page, "Deploy command");
  const deployTimeout = field(page, "Deploy command timeout (s)");
  await expect(deployCommand).toBeVisible();
  await expect(deployCommand).toHaveValue("");

  await deployCommand.fill("git push origin main");
  await deployTimeout.fill("60");
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { deployCommand?: string; deployCommandTimeoutMs?: number } } }>;
      const orch = projects.find((p) => p.id === project.id)?.config?.orchestration;
      return { deployCommand: orch?.deployCommand ?? null, deployCommandTimeoutMs: orch?.deployCommandTimeoutMs ?? null };
    })
    .toEqual({ deployCommand: "git push origin main", deployCommandTimeoutMs: 60_000 });

  await page.reload();
  await expect(field(page, "Deploy command")).toHaveValue("git push origin main");
  await expect(field(page, "Deploy command timeout (s)")).toHaveValue("60");
});

test("editing the project Alert webhook URL + events persists, and clearing both removes the override (sweep §2)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-webhook-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const url = field(page, "Alert webhook URL");
  const events = field(page, "Alert webhook events");
  await expect(url).toBeVisible();
  await expect(url).toHaveValue("");

  await url.fill("https://hooks.example.com/incoming");
  await events.fill("merge_done\nmerge_rejected");
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  const readWebhook = async () => {
    const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
    const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { alertWebhook?: { url?: string; events?: string[] } } } }>;
    return projects.find((p) => p.id === project.id)?.config?.orchestration?.alertWebhook ?? null;
  };
  await expect.poll(readWebhook).toEqual({ url: "https://hooks.example.com/incoming", events: ["merge_done", "merge_rejected"] });

  await page.reload();
  await expect(field(page, "Alert webhook URL")).toHaveValue("https://hooks.example.com/incoming");
  await expect(field(page, "Alert webhook events")).toHaveValue("merge_done\nmerge_rejected");

  // CLEAR both — the key is dropped entirely, not left as a stale partial.
  await field(page, "Alert webhook URL").fill("");
  await field(page, "Alert webhook events").fill("");
  await expect(projectSave).toBeEnabled();
  await projectSave.click();
  await expect.poll(readWebhook).toBeNull();
});

