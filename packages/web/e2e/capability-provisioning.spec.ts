// Capability provisioning status + network badge spec (card cd9a78bc, shadcn/ui epic 375bbfab) — proves the
// Profiles editor's provisioning row is genuinely SLUG-KEYED rather than the one hardcoded markitdown panel
// it replaced, and that the `network` badge discriminates by provision kind.
//
// RETARGETED (card ed39d432) after eae230d9 moved credential/registry capability grants onto the AGENT:
// the Profiles editor now lists ONLY the two builtins (`browser-testing` node-package, `document-conversion`
// python-venv). So the tracked/untracked pair below is `document-conversion` (its row reads the daemon-wide
// python status, `/api/python/provisioning`) vs `browser-testing`, and the registry capabilities (`image-gen`
// …) are asserted ABSENT from the profile picker — their per-slug row and network badge no longer exist in
// any editor (the agent editor's grant list renders neither). The old per-slug endpoint-agreement leg has no
// UI subject left and now agrees with the python endpoint instead.
//
// Three observables, each a real before/after rather than a render check:
//   1. Granting a TRACKED capability (`image-gen`, kind npm-pinned) mounts its own provisioning row, keyed
//      by that slug — absent before the toggle, present after, and gone again when the toggle is cleared.
//   2. Granting an UNTRACKED one (`browser-testing`, kind node-package) mounts NO row. That is the point of
//      the gate: the generic route answers a hardcoded `idle` forever for an untracked kind, so an ungated
//      row would read "not provisioned yet" beside a capability that is in fact mounted and working.
//   3. The row's rendered state agrees with what `GET /api/capabilities/image-gen/provisioning` returns —
//      the UI is reading the real per-slug endpoint, not an invented one.
//
// POLARITY (per the worker doctrine's control rule): leg 2 is an ABSENCE assertion, so a zero there proves
// nothing on its own — a broken locator returns zero exactly like a correct gate does. Leg 1 is its
// positive control: the SAME `capability-provisioning-<slug>` locator shape is shown returning ≥1 for a
// tracked slug in the same test, on the same page, before any zero is trusted.
//
// FIXTURE IDENTITY: every test seeds its own uniquely-named profile and reads the catalog back from
// `loomDaemon.baseURL`, asserting the exact seeded slugs + kinds it depends on are the ones this daemon
// actually serves. A sibling worker's daemon renders identically, so an unasserted run could screenshot a
// completely wrong fixture; the slug/kind assertion is what makes that fail loudly instead.
//
// Builds on the shared worker-scoped `loomDaemon` fixture (card c3fd1d68); profiles-agents.spec.ts is the
// template. Opens the editor through `openActorsProfile` because `capabilities` is a `planGrantSave`
// widening key (card 8206994d) — a bare `page.goto` races the Save click into an unhandled grant-reach
// confirm. No Save is needed to observe legs 1-3: the row is driven off the editor's local toggle state,
// exactly as the markitdown panel it generalises was.
import { expect, openActorsProfile, test } from "./fixtures/daemon";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededProfile { id: string; name: string }
interface CatalogRow { slug: string; name: string; kind: string; builtin: boolean }
interface ProvisionStatus { state: "idle" | "installing" | "ready" | "failed"; reason?: string; binary?: string }

const seedProfile = (baseURL: string, name: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify({ name }) });

const listCapabilities = (baseURL: string) => apiJson<CatalogRow[]>(`${baseURL}/api/capabilities`);

const pythonProvisioning = (baseURL: string) => apiJson<ProvisionStatus>(`${baseURL}/api/python/provisioning`);

/** A capability's picker entry: the <label> wrapping its checkbox, pinned by the catalog row's own name. */
const pickerRow = (page: import("@playwright/test").Page, name: string) =>
  page.locator("label").filter({ hasText: name }).first();

// The two slugs this spec depends on, and the kind each one's behaviour hangs off. Asserted against the
// live catalog in every test rather than assumed — if a future card changes `image-gen`'s kind away from a
// tracked one, this spec must fail LOUDLY on the premise rather than silently stop testing the gate.
const TRACKED = { slug: "document-conversion", kind: "python-venv" };
const UNTRACKED = { slug: "browser-testing", kind: "node-package" };
// A REGISTRY capability: granted per agent since eae230d9, so the Profiles editor must not list it.
const REGISTRY = { slug: "image-gen", kind: "npm-pinned" };

test.describe("capability provisioning status", () => {
  test("a granted tracked capability mounts its own slug-keyed row; an untracked one mounts none", async ({ page, loomDaemon }) => {
    // FIXTURE IDENTITY: this daemon's own catalog, not an assumed one.
    const catalog = await listCapabilities(loomDaemon.baseURL);
    const tracked = catalog.find((c) => c.slug === TRACKED.slug);
    const untracked = catalog.find((c) => c.slug === UNTRACKED.slug);
    expect(tracked, `this daemon must seed the ${TRACKED.slug} capability`).toBeTruthy();
    expect(untracked, `this daemon must expose the ${UNTRACKED.slug} builtin`).toBeTruthy();
    expect(tracked!.kind, "the premise of leg 1 is that this slug's kind is background-provisioned").toBe(TRACKED.kind);
    expect(untracked!.kind, "the premise of leg 2 is that this slug's kind is NOT provisioned").toBe(UNTRACKED.kind);

    const profile = await seedProfile(loomDaemon.baseURL, `Rig Provisioning ${Date.now()}`);
    await openActorsProfile(page, loomDaemon.baseURL, profile.name);

    const trackedToggle = pickerRow(page, tracked!.name).locator('input[type="checkbox"]');
    const untrackedToggle = pickerRow(page, untracked!.name).locator('input[type="checkbox"]');
    const trackedRow = page.getByTestId(`capability-provisioning-${TRACKED.slug}`);
    const untrackedRow = page.getByTestId(`capability-provisioning-${UNTRACKED.slug}`);

    // eae230d9: a registry capability is no longer a profile-level grant — no picker row, no network
    // badge, no provisioning row. Controlled by the builtin picker row resolving through the same helper.
    const registry = catalog.find((c) => c.slug === REGISTRY.slug);
    expect(registry, `this daemon must still seed ${REGISTRY.slug} (else this absence proves nothing)`).toBeTruthy();
    expect(registry!.kind).toBe(REGISTRY.kind);
    await expect(trackedToggle).toBeVisible();
    await expect(pickerRow(page, registry!.name), "registry capabilities are granted per agent, not listed on a profile").toHaveCount(0);

    // BEFORE: a freshly seeded profile grants nothing, so NO provisioning row exists for either slug.
    await expect(trackedToggle).not.toBeChecked();
    await expect(untrackedToggle).not.toBeChecked();
    await expect(trackedRow).toHaveCount(0);
    await expect(untrackedRow).toHaveCount(0);

    // ACT + AFTER (observable #1 — the positive control for the locator shape): granting the tracked
    // capability mounts a row keyed by ITS slug, and it reports a real state word.
    await trackedToggle.check();
    await expect(trackedToggle).toBeChecked();
    await expect(trackedRow).toBeVisible();
    await expect(page.getByTestId(`provisioning-state-${TRACKED.slug}`)).toBeVisible();

    // AFTER (observable #2 — the gated absence, now controlled): granting the UNTRACKED capability adds no
    // row of its own, while the tracked row is still standing right beside it. The same locator shape just
    // returned ≥1 above, so this zero is a real gate rather than a broken selector.
    await untrackedToggle.check();
    await expect(untrackedToggle).toBeChecked();
    await expect(untrackedRow).toHaveCount(0);
    await expect(trackedRow).toBeVisible();

    // AFTER (observable #3 — reversibility): clearing the grant unmounts its row again. The row tracks the
    // live grant, never "has ever been granted".
    await trackedToggle.uncheck();
    await expect(trackedToggle).not.toBeChecked();
    await expect(trackedRow).toHaveCount(0);
  });

  test("the row's state agrees with the daemon's python provisioning endpoint", async ({ page, loomDaemon }) => {
    const catalog = await listCapabilities(loomDaemon.baseURL);
    const tracked = catalog.find((c) => c.slug === TRACKED.slug);
    expect(tracked, `this daemon must seed the ${TRACKED.slug} capability`).toBeTruthy();

    const profile = await seedProfile(loomDaemon.baseURL, `Rig Provisioning REST ${Date.now()}`);
    await openActorsProfile(page, loomDaemon.baseURL, profile.name);

    await pickerRow(page, tracked!.name).locator('input[type="checkbox"]').check();
    await expect(page.getByTestId(`capability-provisioning-${TRACKED.slug}`)).toBeVisible();

    // The daemon's own answer for this slug. On a fixture daemon that has never spawned a session granting
    // it, this is `idle` — but the assertion is written against whatever the endpoint SAYS, so it holds on
    // a warm daemon too rather than pinning one incidental state.
    const status = await pythonProvisioning(loomDaemon.baseURL);
    const expectedLabel = { idle: "not provisioned yet", installing: "installing…", ready: "ready", failed: "install failed" }[status.state];
    await expect(page.getByTestId(`provisioning-state-${TRACKED.slug}`)).toContainText(expectedLabel, { ignoreCase: true });
  });

  test("the network badge marks the fetching kinds and is withheld from the rest", async ({ page, loomDaemon }) => {
    const catalog = await listCapabilities(loomDaemon.baseURL);
    const profile = await seedProfile(loomDaemon.baseURL, `Rig Network Badge ${Date.now()}`);
    await openActorsProfile(page, loomDaemon.baseURL, profile.name);

    // The picker must have rendered the catalog before any badge absence is read — otherwise every
    // `toHaveCount(0)` below passes on an empty list.
    await expect(pickerRow(page, catalog[0]!.name)).toBeVisible();

    // Derived from each row's OWN kind, not a hardcoded expectation per slug — so this test keeps asserting
    // the real rule (pip / GitHub release / npm install fetch; a daemon-bundled node dependency doesn't)
    // as the catalog grows. `bundled`/`command` deliberately carry NO badge: their recipe never reaches the
    // REST summary, so the absence is "not known to fetch", never "known to be local".
    // Only the BUILTINS are profile-level since eae230d9, so the rule is exercised on them; every
    // registry capability (fetching or not) carries NO badge here because it is not listed at all.
    const fetching = new Set(["python-venv", "github-binary", "npm-pinned"]);
    let withBadge = 0;
    let withoutBadge = 0;
    for (const c of catalog) {
      const badge = page.getByTestId(`capability-network-${c.slug}`);
      if (c.builtin && fetching.has(c.kind)) { await expect(badge, `${c.slug} (${c.kind}) must badge`).toBeVisible(); withBadge++; }
      else { await expect(badge, `${c.slug} (${c.kind}) must not badge`).toHaveCount(0); withoutBadge++; }
    }
    // Both polarities must be genuinely exercised, or one half of the rule went untested.
    expect(withBadge, "the catalog must contain at least one fetching builtin").toBeGreaterThan(0);
    expect(withoutBadge, "the catalog must contain at least one non-badged capability").toBeGreaterThan(0);
    expect(catalog.some((c) => !c.builtin && fetching.has(c.kind)),
      "the registry must carry a fetching non-builtin, or the 'not listed' half is untested").toBe(true);
  });
});
