// The owner's opt-in to plain HTTP for a private/LAN host (card 1d882a8c), driven through the real Settings UI
// against the fixture daemon: the checkbox in the inline edit form (with its plain warning) saves host + flag
// together, the row then carries a distinct "HTTP (LAN)" badge, a public address is refused with the daemon's own
// error, and an ordinary https row has neither the badge nor the flag. The daemon's own read is asserted beside
// every UI claim so a UI that merely LOOKS saved cannot pass.
import { expect, test } from "./fixtures/daemon";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function postConnection(baseURL: string, body: Record<string, unknown>) {
  return fetch(`${baseURL}/api/connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
type Row = { id: string; host: string; allowPlainHttp?: boolean; invalidHost?: boolean };
const rowsOf = async (baseURL: string) => (await (await fetch(`${baseURL}/api/connections`)).json()) as Row[];

test("the edit form opts a connection into plain http for a LAN host, badges it, and refuses a public address", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("conn-http"));
  const lan = (await (await postConnection(loomDaemon.baseURL, { name: uniq("plex"), host: "plex.example.com", authScheme: "api-key", secret: "s" })).json()) as { id: string };
  const plain = (await (await postConnection(loomDaemon.baseURL, { name: uniq("plain"), host: "api.example.com", authScheme: "api-key", secret: "s" })).json()) as { id: string };
  try {
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);

    // Before: no badge anywhere, flag absent on the daemon's own read.
    await expect(page.getByTestId(`connection-row-${lan.id}`)).toBeVisible();
    await expect(page.getByTestId(`connection-row-${lan.id}`).getByTestId("connection-plain-http")).toHaveCount(0);
    expect((await rowsOf(loomDaemon.baseURL)).find((r) => r.id === lan.id)?.allowPlainHttp).toBeUndefined();

    await page.getByTestId(`connection-edit-open-${lan.id}`).click();
    const form = page.getByTestId(`connection-edit-${lan.id}`);
    const toggle = page.getByTestId(`connection-edit-plain-http-${lan.id}`);
    await expect(toggle).not.toBeChecked();
    await expect(form).toContainText("The token is sent unencrypted on your local network");

    // A public address with the opt-in is refused by the daemon, and the UI shows that error; nothing saved.
    await form.getByLabel("Connection host").fill("8.8.8.8:8080");
    await toggle.check();
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form.getByRole("alert")).toContainText(/private LAN address/);
    expect((await rowsOf(loomDaemon.baseURL)).find((r) => r.id === lan.id)).toMatchObject({ host: "plex.example.com" });
    expect((await rowsOf(loomDaemon.baseURL)).find((r) => r.id === lan.id)?.allowPlainHttp).toBeUndefined();

    // A private host:port with the opt-in saves; the row is badged; the daemon agrees.
    await form.getByLabel("Connection host").fill("192.168.178.136:32400");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId(`connection-row-${lan.id}`).getByTestId("connection-plain-http")).toHaveText("HTTP (LAN)");
    const after = (await rowsOf(loomDaemon.baseURL)).find((r) => r.id === lan.id);
    expect(after).toMatchObject({ host: "192.168.178.136:32400", allowPlainHttp: true });

    // The other, ordinary https row never gets the badge.
    await expect(page.getByTestId(`connection-row-${plain.id}`).getByTestId("connection-plain-http")).toHaveCount(0);
    expect((await rowsOf(loomDaemon.baseURL)).find((r) => r.id === plain.id)?.allowPlainHttp).toBeUndefined();

    // Turning it back off removes the badge and the flag.
    await page.getByTestId(`connection-edit-open-${lan.id}`).click();
    await page.getByTestId(`connection-edit-plain-http-${lan.id}`).uncheck();
    await page.getByTestId(`connection-edit-${lan.id}`).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId(`connection-row-${lan.id}`).getByTestId("connection-plain-http")).toHaveCount(0);
    expect((await rowsOf(loomDaemon.baseURL)).find((r) => r.id === lan.id)?.allowPlainHttp).toBeUndefined();
  } finally {
    for (const id of [lan.id, plain.id]) await fetch(`${loomDaemon.baseURL}/api/connections/${id}`, { method: "DELETE" });
  }
});
