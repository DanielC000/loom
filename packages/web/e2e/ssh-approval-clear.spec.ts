// The Requests inbox's Clear / Revoke action on an ANSWERED ssh_exec hold (card a56270da, design record
// a3d5c7f4). The owner can end a deny's 24h cooldown or revoke a grant before it lapses; either way the
// agent's next identical ssh_exec call files a FRESH hold instead of being refused / running.
//
// The before/after is measured on the REAL ssh_exec core (performSshExec, the function the MCP tool calls),
// run as the seeded session through a test-only seed kind, not inferred from the row: the deny case refuses (`ssh-approval-denied`) before the clear and files
// a new hold after it; the grant case dials the host before the revoke and files a new hold after it.
//
// ⛔ NO REAL HOST and no real claude: the grant case dials a throwaway ssh2.Server on 127.0.0.1 started in
// this test process, which never accepts the client key, so nothing is ever executed. The session is a
// seeded live-no-PTY row carrying the connection grant on the row (the only place ssh_exec reads it from).
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type LoomDaemon, type Page } from "./fixtures/daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonRequire = createRequire(path.resolve(__dirname, "..", "..", "daemon", "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ssh2: any = daemonRequire("ssh2");

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Optional reviewer evidence: LOOM_E2E_SSH_CLEAR_SHOTS = an absolute dir to write screenshots into, and
// LOOM_E2E_SSH_CLEAR_THEME = "light" to render in the light theme. Both are no-ops when unset.
async function shot(target: Locator, name: string) {
  const dir = process.env.LOOM_E2E_SSH_CLEAR_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: path.join(dir, `${process.env.LOOM_E2E_SSH_CLEAR_THEME === "light" ? "light" : "dark"}-${name}.png`) });
}
async function gotoInbox(page: Page, base: string) {
  if (process.env.LOOM_E2E_SSH_CLEAR_THEME === "light") {
    await page.addInitScript(() => { try { localStorage.setItem("loom.theme", "light"); } catch { /* blocked */ } });
  }
  await page.goto(`${base}/inbox`);
}

/** A loopback ssh server that never authenticates anyone, plus the fingerprint of its host key. */
async function startRefusingSshServer(): Promise<{ port: number; fingerprint: string; close: () => Promise<void> }> {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  const raw: Buffer = ssh2.utils.parseKey(hostKey.public).getPublicSSH();
  const fingerprint = `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (conn: { on: (e: string, f: (...a: never[]) => void) => void }) => {
    conn.on("error", () => {});
    conn.on("authentication", ((ctx: { reject: () => void }) => ctx.reject()) as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: server.address().port, fingerprint, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SshResult { ok: boolean; status?: string; reason?: string; kind?: string; approvalRequestId?: string }

/** A project, a read-write ssh connection scoped to it, and a seeded worker session granted that connection. */
async function seedSshWorker(loomDaemon: LoomDaemon, server: { port: number; fingerprint: string }) {
  const project = await loomDaemon.createProject(uniq("ssh-clear"));
  const key = ssh2.utils.generateKeyPairSync("ed25519");
  const conn = await api<{ id: string }>(`${loomDaemon.baseURL}/api/connections/ssh`, {
    method: "POST",
    body: JSON.stringify({
      name: uniq("box"), host: "127.0.0.1", port: server.port, user: "loom", privateKey: key.private,
      hostKeyFingerprint: server.fingerprint, readOnly: false, projectId: project.id,
    }),
  });
  const worker = await loomDaemon.seedLiveSession({ project, role: "worker", agentName: "SshWorker", task: { title: "feat(x): ssh card" }, connections: [conn.id] });
  // The seeded session has no live pty, so it cannot pass the /mcp* per-session token hook; the test-only
  // seed kind runs the SAME performSshExec core the MCP tool calls, as this session, off its own row grant.
  const holdIds = new Set<string>();
  const sshExec = async (command: string): Promise<SshResult> => {
    const r = await api<{ sshExecResults: SshResult[] }>(`${loomDaemon.baseURL}/internal/test/seed`, {
      method: "POST", body: JSON.stringify({ sshExecCalls: [{ sessionId: worker.sessionId, connectionId: conn.id, command }] }),
    });
    const res = r.sshExecResults[0]!;
    if (res.approvalRequestId) holdIds.add(res.approvalRequestId);
    return res;
  };
  // The daemon files these holds itself, so the fixture's seeded-question cleanup never sees them: dismiss
  // any still pending, or the next spec on this shared daemon inherits a live "permission needed" item.
  const dismissHolds = async () => {
    for (const id of holdIds) await fetch(`${loomDaemon.baseURL}/api/questions/${id}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  };
  return { sshExec, dismissHolds };
}

const row = (page: Page, id: string) => page.locator(`[data-testid="request-row"][data-question-id="${id}"]`);
const questionState = async (base: string, id: string) => (await api<{ state: string }>(`${base}/api/questions/${id}`)).state;

test("Clear denial ends a deny's cooldown: the next identical ssh_exec files a fresh hold instead of refusing", async ({ page, loomDaemon }) => {
  const server = await startRefusingSshServer();
  const w = await seedSshWorker(loomDaemon, server);
  try {
    const held = await w.sshExec("reboot");
    expect(held).toMatchObject({ ok: false, status: "awaiting-owner-approval" });
    const id = held.approvalRequestId!;
    await api(`${loomDaemon.baseURL}/api/questions/${id}/answer`, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
    // BEFORE: the deny governs — refused, nothing new filed.
    expect(await w.sshExec("reboot")).toMatchObject({ ok: false, reason: "ssh-approval-denied" });

    await gotoInbox(page, loomDaemon.baseURL);
    const r = row(page, id);
    const trigger = r.getByRole("button", { name: "Clear denial" });
    await expect(trigger).toBeVisible();
    await shot(r, "deny-1-row");
    await trigger.click();
    const confirm = r.getByTestId("ssh-clear-confirm");
    await expect(confirm).toContainText("Clear this denial?");
    await shot(r, "deny-2-confirm");
    // Keep is the safe default (focused) and backs out without touching anything.
    await expect(confirm.getByRole("button", { name: "Keep" })).toBeFocused();
    await confirm.getByRole("button", { name: "Keep" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await questionState(loomDaemon.baseURL, id)).toBe("answered");
    expect(await w.sshExec("reboot")).toMatchObject({ reason: "ssh-approval-denied" });

    await trigger.click();
    await r.getByTestId("ssh-clear-confirm").getByRole("button", { name: "Clear denial" }).click();
    await expect(r).toHaveCount(0); // cleared → history, out of the inbox
    expect(await questionState(loomDaemon.baseURL, id)).toBe("cancelled");

    // AFTER: a fresh hold, a new request id.
    const fresh = await w.sshExec("reboot");
    expect(fresh).toMatchObject({ ok: false, status: "awaiting-owner-approval" });
    expect(fresh.approvalRequestId).not.toBe(id);
    await gotoInbox(page, loomDaemon.baseURL);
    const freshRow = row(page, fresh.approvalRequestId!);
    await expect(freshRow).toBeVisible();
    await expect(freshRow.getByTestId("ssh-clear")).toHaveCount(0); // pending: nothing to clear yet
    await shot(freshRow, "deny-3-fresh-hold");
  } finally {
    await w.dismissHolds();
    await server.close();
  }
});

test("Revoke takes back a standing grant: the next identical ssh_exec files a fresh hold instead of dialing", async ({ page, loomDaemon }) => {
  const server = await startRefusingSshServer();
  const w = await seedSshWorker(loomDaemon, server);
  try {
    const held = await w.sshExec("reboot");
    const id = held.approvalRequestId!;
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
    await api(`${loomDaemon.baseURL}/api/questions/${id}/answer`, { method: "POST", body: JSON.stringify({ decision: "authorize", scope: "standing", expiresAt }) });
    // BEFORE: the grant governs — the call is dispatched (the throwaway host refuses the key), not held.
    const before = await w.sshExec("reboot");
    expect(before.status).not.toBe("awaiting-owner-approval");
    expect(before).toMatchObject({ ok: false, kind: "auth-refused" });

    await gotoInbox(page, loomDaemon.baseURL);
    const r = row(page, id);
    await expect(r.getByRole("button", { name: "Revoke" })).toBeVisible();
    await shot(r, "grant-1-row");
    await r.getByRole("button", { name: "Revoke" }).click();
    const confirm = r.getByTestId("ssh-clear-confirm");
    await expect(confirm).toContainText("Revoke this standing grant?");
    await shot(r, "grant-2-confirm");
    await confirm.getByRole("button", { name: "Revoke grant" }).click();
    await expect(r).toHaveCount(0);
    expect(await questionState(loomDaemon.baseURL, id)).toBe("cancelled");

    // AFTER: held again, under a new request.
    const after = await w.sshExec("reboot");
    expect(after).toMatchObject({ ok: false, status: "awaiting-owner-approval" });
    expect(after.approvalRequestId).not.toBe(id);
  } finally {
    await w.dismissHolds();
    await server.close();
  }
});

test("CONTROL: no Clear/Revoke on a pending ssh hold or on an answered non-ssh permission row", async ({ page, loomDaemon }) => {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ClearControlMgr" });
  const pendingSsh = await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("pending-ssh"), type: "permission",
    body: "A session asks to run `reboot`.", permissionAction: 'ssh_exec connection=conn-e2e target=loom@10.0.0.9:22 pin=0123456789ab command="reboot"',
  });
  const answeredPlain = await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("answered-plain"), type: "permission",
    body: "Push to origin?", permissionAction: "git push origin main",
  });
  // Answered through the REAL route (the human stamp an ssh row would also carry), so the only thing that
  // differs from a clearable ssh deny is the action itself.
  await api(`${loomDaemon.baseURL}/api/questions/${answeredPlain}/answer`, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
  await gotoInbox(page, loomDaemon.baseURL);
  for (const id of [pendingSsh, answeredPlain]) {
    const r = row(page, id);
    await expect(r).toBeVisible();
    await expect(r.getByTestId("ssh-clear")).toHaveCount(0);
    await expect(r.getByRole("button", { name: /Clear denial|Revoke/ })).toHaveCount(0);
  }
});
