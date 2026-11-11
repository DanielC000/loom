// SSH connections in the Connections UI (card b5565d4c, design record a3d5c7f4): create one through the
// form, then grant it to ONE agent in the agent editor (card caca806c), and prove a sibling agent on the
// SAME profile does not get it.
//
// Each claim is measured against real state, never against "a control rendered":
//   1. SAFE DEFAULTS. Read-only starts ticked and the hold-these-commands-for-approval list starts as the shipped default — both
//      asserted in the form AND in the row the daemon actually stored.
//   2. NO SILENT TOFU. "Fetch from host" only DISPLAYS a fingerprint; the pin field stays empty until the
//      explicit "Pin this fingerprint" click. The displayed value is compared to one computed
//      INDEPENDENTLY from the throwaway server's own host key, never to the route's own output.
//   3. NEVER ECHOED. After save, neither the page nor the API carries the pasted key or its passphrase.
//      The key marker is a slice of the pasted key's BODY (past the fixed "openssh-key-v1" header, which is
//      identical across keys — decision f9972a3d), so it is specific to this key.
//   4. GRANT REACH. Before: neither agent carries the connection. After saving A's grant: A does, B (same
//      profile) does not — read back from the daemon, and from the Connections row's own "Granted to".
//      An agent in ANOTHER project is not even offered the (project-scoped) connection.
//
// ⛔ NO REAL HOST. The fetch path dials a throwaway ssh2.Server on 127.0.0.1 started inside this test
// process (ssh2 resolved from the daemon package, which already depends on it). Nothing is ever executed
// over ssh, and the agent editor writes are plain DB writes — no session is spawned.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "./fixtures/daemon";
import { generateParseableEd25519 } from "./fixtures/ssh-keys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ssh2: any = createRequire(path.resolve(__dirname, "..", "..", "daemon", "package.json"))("ssh2");

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Optional evidence screenshots for a reviewer: set LOOM_E2E_SSH_SHOTS to an absolute dir. A no-op otherwise.
async function shot(target: Locator, name: string) {
  const dir = process.env.LOOM_E2E_SSH_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: path.join(dir, `${name}.png`) });
}
/** The New-connection form's own root (the Connector button group's grandparent). */
const formRoot = (page: Page) => page.getByRole("group", { name: "Connector type" }).locator("xpath=../..");

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface AgentRow { id: string; name: string; profileId: string | null; connections?: string[] }
interface ConnRow { id: string; name: string; authScheme: string; readOnly?: boolean; riskyCommandPatterns?: unknown[]; hostKeyFingerprint?: string; projectId: string | null }

/** A throwaway loopback ssh server and the fingerprint computed from its host key directly. */
async function startHostKeyServer(): Promise<{ port: number; fingerprint: string; close: () => Promise<void> }> {
  const hostKey = generateParseableEd25519(ssh2.utils);
  const raw: Buffer = ssh2.utils.parseKey(hostKey.public).getPublicSSH();
  const fingerprint = `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (conn: { on: (e: string, f: () => void) => void }) => { conn.on("error", () => {}); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: server.address().port, fingerprint, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A slice of the key's base64 BODY, well past the header bytes every openssh key shares. Taken from
 *  INSIDE one line: the key is line-wrapped, so a slice of the joined body that straddles a line break
 *  is never a substring of a rendered key — a marker that can't match (measured: it missed a planted
 *  leak of the whole key before this was fixed). */
function keyMarker(pem: string): string {
  const lines = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
  const mid = lines[Math.floor(lines.length / 2)]!;
  if (mid.length < 50) throw new Error("keyMarker: expected a full-width base64 body line");
  return mid.slice(5, 45);
}

/** Test-only access to the page's QueryClient, with NO hook shipped in the app: a minimal React DevTools
 *  global hook (installed before React loads) records each committed fiber root, and the probe walks the
 *  tree to the QueryClientProvider's `client` prop. Must run before the first navigation. */
async function installQueryClientProbe(page: Page) {
  await page.addInitScript(() => {
    const roots = new Set<unknown>();
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, isDisabled: false, renderers: new Map(),
      inject: () => 1, checkDCE: () => {}, onScheduleFiberRoot: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: unknown) => { roots.add(root); },
    };
    (window as unknown as { __e2eFiberRoots: Set<unknown> }).__e2eFiberRoots = roots;
  });
}

/** Does any mutation in the page's MutationCache carry `needle` in its variables? Throws when the
 *  QueryClient can't be found, so a broken probe never reads as "absent". Also returns the cache size. */
function mutationCacheCarries(page: Page, needle: string): Promise<{ carries: boolean; size: number }> {
  return page.evaluate((n) => {
    type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedProps?: { client?: { getMutationCache?: () => { getAll: () => { state: { variables?: unknown } }[] } } } };
    const roots = (window as unknown as { __e2eFiberRoots?: Set<{ current: Fiber }> }).__e2eFiberRoots;
    if (!roots || roots.size === 0) throw new Error("query-client probe: no React root recorded (install it before navigating)");
    for (const root of roots) {
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const f = stack.pop()!;
        const client = f.memoizedProps?.client;
        if (client && typeof client.getMutationCache === "function") {
          const all = client.getMutationCache().getAll();
          return { carries: all.some((m) => JSON.stringify(m.state.variables ?? null).includes(n)), size: all.length };
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    throw new Error("query-client probe: no QueryClientProvider found in the fiber tree");
  }, needle);
}

function field(page: Page, labelText: string) {
  return page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`).locator("input, select, textarea").first();
}

test("create an ssh connection with a confirmed pin, then grant it to one agent — the sibling on the same profile does not get it", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const base = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("ssh-ui"));
  const otherProject = await loomDaemon.createProject(uniq("ssh-ui-other"));
  const profile = await apiJson<{ id: string }>(`${base}/api/profiles`, { method: "POST", body: JSON.stringify({ name: uniq("Homelab rig") }) });
  const mkAgent = async (projectId: string, name: string) => {
    const a = await apiJson<AgentRow>(`${base}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });
    await apiJson(`${base}/api/agents/${a.id}`, { method: "POST", body: JSON.stringify({ profileId: profile.id }) });
    return a;
  };
  const agentA = await mkAgent(project.id, uniq("Keeper"));
  const agentB = await mkAgent(project.id, uniq("Sibling"));
  const outsider = await mkAgent(otherProject.id, uniq("Outsider"));
  const agentsOf = (projectId: string) => apiJson<AgentRow[]>(`${base}/api/projects/${projectId}/agents`);

  const passphrase = uniq("pass-phrase");
  const key: { private: string } = generateParseableEd25519(ssh2.utils, { passphrase, cipher: "aes256-ctr" });
  const marker = keyMarker(key.private);
  const server = await startHostKeyServer();
  const connName = uniq("Homelab NAS");
  let connId: string | undefined;

  try {
    await installQueryClientProbe(page);
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${base}/home?tab=settings`);
    await page.getByRole("button", { name: "New connection" }).click();
    await page.getByRole("button", { name: "SSH host", exact: true }).click();

    // ── 1. Safe defaults, in the form.
    const readOnly = page.locator("label", { hasText: "Read-only" }).locator('input[type="checkbox"]').first();
    await expect(readOnly).toBeChecked();
    // The count comes from the SHIPPED constant (compiled shared dist), never a literal that drifts when the list grows.
    const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = (await import(pathToFileURL(path.resolve(__dirname, "..", "..", "shared", "dist", "index.js")).href)) as { DEFAULT_SSH_RISKY_COMMAND_PATTERNS: unknown[] };
    const defaultRiskyCount = DEFAULT_SSH_RISKY_COMMAND_PATTERNS.length;
    expect(defaultRiskyCount, "control: the imported default list is a real, non-trivial list").toBeGreaterThan(16);
    await expect(page.getByTestId("ssh-risky-summary")).toHaveText(`${defaultRiskyCount} patterns · Loom's default list`);
    // The risky-list copy must say a match WAITS for approval (not that it is refused), and that it is not a boundary.
    const riskyHint = page.getByTestId("ssh-risky-hint");
    await expect(riskyHint).toContainText("waits for your approval in the decision inbox");
    await expect(riskyHint).toContainText("not a security boundary");
    await expect(riskyHint, "the retired 'refused' copy must be gone").not.toContainText("refused");
    await expect(page.getByText("Hold these commands for my approval", { exact: true })).toBeVisible();
    await expect(field(page, "Port")).toHaveValue("22");
    await shot(formRoot(page), "1-empty-form");

    await field(page, "Name").fill(connName);
    await field(page, "Host").fill("127.0.0.1");
    await field(page, "Port").fill(String(server.port));
    await field(page, "User").fill("loom");
    await field(page, "Private key").fill(key.private);
    await field(page, "Key passphrase").fill(passphrase);
    await field(page, "Scope").selectOption(project.id);

    // ── 2. No silent TOFU: fetch DISPLAYS, the pin stays empty until the explicit confirm.
    const pin = page.getByLabel("Host key fingerprint");
    await expect(pin).toHaveValue("");
    await page.getByRole("button", { name: "Fetch from host" }).click();
    await expect(page.getByTestId("ssh-fingerprint-fetched")).toHaveText(server.fingerprint);
    await expect(pin, "a fetched fingerprint must not be pinned before the owner confirms it").toHaveValue("");
    await shot(formRoot(page), "2a-fetched-awaiting-confirm");
    await page.getByRole("button", { name: "Pin this fingerprint" }).click();
    await expect(pin).toHaveValue(server.fingerprint);
    await expect(page.getByTestId("ssh-fingerprint-confirm")).toHaveCount(0);
    await shot(formRoot(page), "2b-filled-form");

    // Hold the create POST so the probe can be shown to SEE the key in the mutation cache while it is in
    // flight — the positive control that makes the "absent after save" check below mean something.
    let releaseCreate!: () => void;
    const createHeld = new Promise<void>((r) => { releaseCreate = r; });
    await page.route((u) => u.pathname === "/api/connections/ssh", async (route) => {
      if (route.request().method() === "POST") await createHeld;
      await route.continue();
    });
    await page.getByRole("button", { name: "Create connection" }).click();
    await expect.poll(async () => (await mutationCacheCarries(page, marker)).carries, { timeout: 5_000 }).toBe(true);
    expect((await mutationCacheCarries(page, passphrase)).carries, "control: the in-flight mutation carries the passphrase").toBe(true);
    releaseCreate();

    // ── The saved row: what the daemon stored, and what the page shows.
    const findStored = async () => (await apiJson<ConnRow[]>(`${base}/api/connections`)).find((c) => c.name === connName);
    await expect.poll(async () => (await findStored())?.id ?? null, { timeout: 15_000 }).not.toBeNull();
    const stored = (await findStored())!;
    connId = stored.id;
    expect(stored).toMatchObject({ authScheme: "ssh", readOnly: true, hostKeyFingerprint: server.fingerprint, projectId: project.id });
    expect(stored.riskyCommandPatterns).toHaveLength(defaultRiskyCount);
    const row = page.getByTestId(`connection-row-${stored.id}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`ssh-target-${stored.id}`)).toHaveText(`loom@127.0.0.1:${server.port}`);
    await expect(row.getByText("Read-only", { exact: true })).toBeVisible();
    // BEFORE the grant: not granted, on the page and in the daemon.
    await expect(page.getByTestId(`ssh-granted-${stored.id}`)).toHaveText("Not granted");
    const before = await agentsOf(project.id);
    expect(before.find((a) => a.id === agentA.id)?.connections ?? []).not.toContain(stored.id);
    expect(before.find((a) => a.id === agentB.id)?.connections ?? []).not.toContain(stored.id);

    // ── 3. Never echoed: the form is gone, and neither the page nor the API carries the key or passphrase.
    await expect(page.getByLabel("Host key fingerprint")).toHaveCount(0);
    const pageText = await page.locator("body").innerText();
    const pageHtml = await page.content();
    expect(pageText.includes(marker) || pageHtml.includes(marker), "the pasted key must not appear on the page after save").toBe(false);
    expect(pageText.includes(passphrase) || pageHtml.includes(passphrase), "the passphrase must not appear on the page after save").toBe(false);
    const listRaw = await (await fetch(`${base}/api/connections`)).text();
    expect(listRaw.includes(marker) || listRaw.includes(passphrase)).toBe(false);
    // ...nor the client's MutationCache: the create mutation is evicted on success, not left for gcTime
    // (5 min by default) after `reset()` merely detaches it. Measured right after the row renders.
    expect((await mutationCacheCarries(page, marker)).carries, "the pasted key must not linger in the mutation cache").toBe(false);
    expect((await mutationCacheCarries(page, passphrase)).carries, "the passphrase must not linger in the mutation cache").toBe(false);
    await shot(row, "3-saved-connection");

    // ── 4. Grant to agent A only, in the agent editor — the Agents node's edit dialog (the /projects list
    //    that hosted it was deleted with the classic shell, card acbb6df6).
    await page.goto(`${base}/agents`);
    await page.getByTestId(`atlas-agent-edit-${agentA.id}`).click();
    const chipA = page.getByTestId(`agent-connection-${agentA.id}-${stored.id}`);
    await expect(chipA).toBeVisible();
    await expect(chipA).toHaveText(new RegExp(`^${connName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(loom@127\\.0\\.0\\.1\\)\\s*ssh$`));
    await chipA.click();
    await expect(chipA).toHaveText(/^✓ /);
    await page.getByTestId(`agent-grants-save-${agentA.id}`).click();
    await expect(page.getByTestId(`agent-grants-saved-${agentA.id}`)).toBeVisible();
    expect(await page.content()).not.toContain(marker);
    await shot(page.getByTestId(`agent-editor-${agentA.id}`), "4-agent-grant");

    // AFTER: A carries it, B — same project, same profile — does not.
    const after = await agentsOf(project.id);
    expect(after.find((a) => a.id === agentA.id)?.connections).toContain(stored.id);
    expect(after.find((a) => a.id === agentB.id)?.connections ?? []).not.toContain(stored.id);
    expect(after.find((a) => a.id === agentB.id)?.profileId).toBe(after.find((a) => a.id === agentA.id)?.profileId);

    // B's own editor offers it, unselected.
    await page.getByTestId("atlas-agent-editor-close").click();
    await expect(page.getByTestId("atlas-agent-editor")).toHaveCount(0);
    await page.getByTestId(`atlas-agent-edit-${agentB.id}`).click();
    const chipB = page.getByTestId(`agent-connection-${agentB.id}-${stored.id}`);
    await expect(chipB).toBeVisible();
    await expect(chipB).not.toHaveText(/^✓ /);

    // An agent in ANOTHER project is not offered this project-scoped connection at all.
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), otherProject.id);
    await page.goto(`${base}/agents`);
    await page.getByTestId(`atlas-agent-edit-${outsider.id}`).click();
    await expect(page.getByTestId(`agent-editor-${outsider.id}`)).toBeVisible();
    await expect(page.getByTestId(`agent-connection-${outsider.id}-${stored.id}`)).toHaveCount(0);

    // The Connections row now reads the grant back from the agent list.
    await page.goto(`${base}/home?tab=settings`);
    await expect(page.getByTestId(`ssh-granted-${stored.id}`)).toHaveText("Granted to 1 agent");
    await expect(page.getByTestId(`ssh-granted-${stored.id}`)).toHaveAttribute("title", `${project.name} / ${agentA.name}`);
    await shot(page.getByTestId(`connection-row-${stored.id}`), "5-saved-connection-granted");
  } finally {
    await server.close();
    if (connId) await fetch(`${base}/api/connections/${connId}`, { method: "DELETE" });
  }
});

test("an unconfirmed fetched fingerprint is discarded when the host changes, and a malformed pin blocks save", async ({ page, loomDaemon }) => {
  const base = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("ssh-ui-guard"));
  const server = await startHostKeyServer();
  const before = (await apiJson<ConnRow[]>(`${base}/api/connections`)).length;
  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${base}/home?tab=settings`);
    await page.getByRole("button", { name: "New connection" }).click();
    await page.getByRole("button", { name: "SSH host", exact: true }).click();
    await field(page, "Name").fill(uniq("Guard"));
    await field(page, "Host").fill("127.0.0.1");
    await field(page, "Port").fill(String(server.port));
    await page.getByRole("button", { name: "Fetch from host" }).click();
    await expect(page.getByTestId("ssh-fingerprint-fetched")).toHaveText(server.fingerprint);
    // Retargeting must drop the pending confirm: it was fetched from a different host:port.
    await field(page, "Port").fill("2222");
    await expect(page.getByTestId("ssh-fingerprint-confirm")).toHaveCount(0);
    await expect(page.getByLabel("Host key fingerprint")).toHaveValue("");

    // A fetched fingerprint that WAS pinned is evidence about one host:port only: changing the host clears
    // it, with a note saying why the field went empty.
    await field(page, "Port").fill(String(server.port));
    await page.getByRole("button", { name: "Fetch from host" }).click();
    await page.getByRole("button", { name: "Pin this fingerprint" }).click();
    await expect(page.getByLabel("Host key fingerprint")).toHaveValue(server.fingerprint);
    await expect(page.getByTestId("ssh-pin-cleared")).toHaveCount(0);
    await field(page, "Host").fill("127.0.0.2");
    await expect(page.getByLabel("Host key fingerprint"), "a fetched pin must not survive a host change").toHaveValue("");
    await expect(page.getByTestId("ssh-pin-cleared")).toHaveText(`Pin cleared: it was fetched from 127.0.0.1:${server.port}, and the host has changed. Fetch it again, or paste the fingerprint.`);
    await shot(formRoot(page), "6-pin-cleared-on-host-change");
    // A hand-typed fingerprint is not tied to any target, so a host change leaves it alone.
    const typed = `SHA256:${"B".repeat(43)}`;
    await page.getByLabel("Host key fingerprint").fill(typed);
    await expect(page.getByTestId("ssh-pin-cleared")).toHaveCount(0);
    await field(page, "Host").fill("127.0.0.1");
    await expect(page.getByLabel("Host key fingerprint")).toHaveValue(typed);

    await field(page, "User").fill("loom");
    await field(page, "Private key").fill(generateParseableEd25519(ssh2.utils).private);
    await page.getByLabel("Host key fingerprint").fill("SHA256:not-a-real-fingerprint");
    await page.getByRole("button", { name: "Create connection" }).click();
    await expect(page.getByText("Pin the host key fingerprint: paste it, or fetch it from the host and confirm.")).toBeVisible();
    expect((await apiJson<ConnRow[]>(`${base}/api/connections`)).length).toBe(before);
  } finally {
    await server.close();
  }
});

test("the quoted-and-piped opt-in is off and disabled while read-only, and a read-write connection round-trips it through the editor", async ({ page, loomDaemon }) => {
  const base = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("ssh-shell-ui"));
  let connId: string | undefined;
  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${base}/home?tab=settings`);
    await page.getByRole("button", { name: "New connection" }).click();
    await page.getByRole("button", { name: "SSH host", exact: true }).click();
    // Create form: off by default, and not tickable while Read-only is ticked.
    const optIn = page.getByTestId("ssh-shell-syntax");
    await expect(optIn).not.toBeChecked();
    await expect(optIn).toBeDisabled();
    await expect(page.getByText("the remote login shell is POSIX sh-compatible", { exact: false })).toBeVisible();
    const readOnlyBox = page.locator("label", { hasText: "Read-only" }).locator('input[type="checkbox"]').first();
    await readOnlyBox.uncheck();
    await expect(optIn).toBeEnabled();
    await optIn.check();
    await readOnlyBox.check();
    await expect(optIn, "re-ticking Read-only clears and disables the opt-in").not.toBeChecked();
    await expect(optIn).toBeDisabled();

    // Editor: a read-write connection created with the opt-in carries it, shows it ticked, and can switch it off.
    const key = generateParseableEd25519(ssh2.utils);
    const fp = `SHA256:${createHash("sha256").update(Buffer.from(uniq("fp"))).digest("base64").replace(/=+$/, "")}`;
    const created = await apiJson<ConnRow & { shellSyntax?: boolean }>(`${base}/api/connections/ssh`, {
      method: "POST",
      body: JSON.stringify({ name: uniq("Shell NAS"), host: "127.0.0.1", port: 2222, user: "loom", privateKey: key.private, hostKeyFingerprint: fp, readOnly: false, shellSyntax: true, projectId: project.id }),
    });
    connId = created.id;
    expect(created.shellSyntax, "control: the daemon stored the opt-in").toBe(true);
    await page.goto(`${base}/home?tab=settings`);
    await page.getByTestId(`ssh-edit-open-${created.id}`).click();
    const editOptIn = page.getByTestId(`ssh-edit-shell-syntax-${created.id}`);
    await expect(editOptIn).toBeChecked();
    await editOptIn.uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await apiJson<Array<ConnRow & { shellSyntax?: boolean }>>(`${base}/api/connections`)).find((c) => c.id === created.id)?.shellSyntax, { timeout: 15_000 }).toBe(false);
  } finally {
    if (connId) await fetch(`${base}/api/connections/${connId}`, { method: "DELETE" });
  }
});

test("a host-key mismatch offers a human re-pin to exactly the presented fingerprint, and the stored pin follows", async ({ page, loomDaemon }) => {
  const base = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("ssh-repin-ui"));
  const server = await startHostKeyServer();
  let connId: string | undefined;
  try {
    // Pinned to a DIFFERENT fingerprint than the live server presents, i.e. the post-reinstall mismatch.
    const stale = `SHA256:${createHash("sha256").update(Buffer.from(uniq("old"))).digest("base64").replace(/=+$/, "")}`;
    expect(stale, "control: the stand-in pin really differs from the live host key").not.toBe(server.fingerprint);
    const key = generateParseableEd25519(ssh2.utils);
    const created = await apiJson<ConnRow>(`${base}/api/connections/ssh`, {
      method: "POST",
      body: JSON.stringify({ name: uniq("Repin NAS"), host: "127.0.0.1", port: server.port, user: "loom", privateKey: key.private, hostKeyFingerprint: stale, readOnly: true, projectId: project.id }),
    });
    connId = created.id;
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${base}/home?tab=settings`);
    await page.getByTestId(`ssh-edit-open-${created.id}`).click();
    await page.getByRole("button", { name: "Fetch from host" }).click();
    await expect(page.getByTestId("ssh-hostkey-mismatch")).toContainText(stale);
    // Nothing is pinned by merely looking at the mismatch.
    expect((await apiJson<ConnRow[]>(`${base}/api/connections`)).find((c) => c.id === created.id)?.hostKeyFingerprint).toBe(stale);
    await page.getByTestId("ssh-repin-hostkey").click();
    await expect.poll(async () => (await apiJson<ConnRow[]>(`${base}/api/connections`)).find((c) => c.id === created.id)?.hostKeyFingerprint, { timeout: 15_000 }).toBe(server.fingerprint);
    await expect(page.getByTestId("ssh-hostkey-mismatch")).toHaveCount(0);
    // A re-pin built from the now-stale pin is refused by the daemon (compare-and-swap), pin untouched.
    const replay = await fetch(`${base}/api/connections/${created.id}/ssh/repin-host-key`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: server.fingerprint, previousFingerprint: stale }),
    });
    expect(replay.status).toBe(409);
  } finally {
    if (connId) await fetch(`${base}/api/connections/${connId}`, { method: "DELETE" });
    await server.close();
  }
});
