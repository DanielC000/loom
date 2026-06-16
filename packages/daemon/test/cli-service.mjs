import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db and runs no OS tool.
// `loom service install | uninstall | status` — the cross-OS autostart registration (Epic 2b).
// HERMETIC + side-effect-free: it imports the bin's parseArgs and the PURE generators/plan from
// bin/service.mjs and asserts the GENERATED artifacts (systemd unit / launchd plist / Task Scheduler
// XML) + the install/uninstall command construction + idempotency, for ALL THREE platforms, on ANY
// host. It NEVER executes systemctl/launchctl/schtasks. Windows is verified LIVE separately (by the
// worker, on this Windows box); mac/linux artifacts are STRUCTURALLY verified here and flagged as
// needing owner live-verify on a Mac/Linux host.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_BIN = path.join(__dirname, "..", "..", "..", "bin"); // packages/daemon/test → repo root/bin
const { parseArgs } = await import(pathToFileURL(path.join(REPO_BIN, "loom.mjs")).href);
const svc = await import(pathToFileURL(path.join(REPO_BIN, "service.mjs")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- (1) arg parsing: `service` + its sub-action --------------------------------------------------
for (const a of ["install", "uninstall", "status"]) {
  const r = parseArgs(["service", a]);
  check(`service ${a}: command 'service', action '${a}', no error`, r.command === "service" && r.serviceAction === a && r.error === null);
}
check("service (no action) → error exit 2", (() => { const r = parseArgs(["service"]); return r.error !== null && r.exitCode === 2; })());
check("service bogus → error exit 2", (() => { const r = parseArgs(["service", "bogus"]); return r.error !== null && r.exitCode === 2; })());
check("service install --port 5000 parses port", (() => { const r = parseArgs(["service", "install", "--port", "5000"]); return r.serviceAction === "install" && r.port === 5000; })());
// Existing subcommands are unchanged (backward-compat): serviceAction stays null.
check("start: serviceAction null", parseArgs(["start"]).serviceAction === null);

// --- shared fixture for the generators ------------------------------------------------------------
const NODE = "/usr/bin/node";
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const LOOM_BIN = "/home/u/.npm/loomctl/bin/loom.mjs";
const WIN_BIN = "C:\\Users\\u\\AppData\\npm\\loomctl\\bin\\loom.mjs";
const PORT = 4317;
const HOMEDIR = "/home/u";
const WIN_HOME = "C:\\Users\\u";

// --- (2) startArgv: always `start --no-open --port <port>` ----------------------------------------
check("startArgv bakes start --no-open --port", svc.startArgv(4317).join(" ") === "start --no-open --port 4317");

// --- (3) Linux: systemd --user unit ---------------------------------------------------------------
{
  const unit = svc.linuxUnitText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: null });
  check("linux unit: ExecStart runs node + loom + start --no-open --port", unit.includes(`ExecStart=${NODE} ${LOOM_BIN} start --no-open --port ${PORT}`));
  check("linux unit: Restart=on-failure (keep-alive)", unit.includes("Restart=on-failure"));
  check("linux unit: WantedBy=default.target (autostart on login)", unit.includes("WantedBy=default.target"));
  check("linux unit: Environment LOOM_PORT", unit.includes(`Environment=LOOM_PORT=${PORT}`));
  const withHome = svc.linuxUnitText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: "/tmp/lh" });
  check("linux unit: custom LOOM_HOME baked when set", withHome.includes("Environment=LOOM_HOME=/tmp/lh"));
  check("linux unit: no LOOM_HOME line when unset", !unit.includes("LOOM_HOME"));

  const plan = svc.servicePlan({ platform: "linux", node: NODE, loomBin: LOOM_BIN, port: PORT, homedir: HOMEDIR, loomHome: null, userId: "" });
  check("linux plan: unit path under ~/.config/systemd/user", plan.artifactPath === path.join(HOMEDIR, ".config/systemd/user/loom.service"));
  check("linux plan: install runs daemon-reload then enable --now (idempotent)",
    plan.installCmds.length === 2 &&
    plan.installCmds[0].args.join(" ") === "--user daemon-reload" &&
    plan.installCmds[1].args.join(" ") === "--user enable --now loom.service");
  check("linux plan: uninstall is best-effort (disable --now ignoreFailure)",
    plan.uninstallCmds[0].args.join(" ") === "--user disable --now loom.service" && plan.uninstallCmds[0].ignoreFailure === true);
  check("linux plan: queryCmd is is-enabled", plan.queryCmd.args.join(" ") === "--user is-enabled loom.service");
}

// --- (4) macOS: launchd LaunchAgent plist ---------------------------------------------------------
{
  const plist = svc.macPlistText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: null, logDir: "/home/u/.loom/logs" });
  check("mac plist: Label com.loom.daemon", plist.includes("<string>com.loom.daemon</string>"));
  check("mac plist: ProgramArguments has node + loom + start + --no-open + --port + port",
    plist.includes(`<string>${NODE}</string>`) && plist.includes(`<string>${LOOM_BIN}</string>`) &&
    plist.includes("<string>start</string>") && plist.includes("<string>--no-open</string>") &&
    plist.includes("<string>--port</string>") && plist.includes(`<string>${PORT}</string>`));
  check("mac plist: RunAtLoad + KeepAlive (autostart + keep-alive)", plist.includes("<key>RunAtLoad</key>") && plist.includes("<key>KeepAlive</key>"));
  check("mac plist: well-formed (declares plist + closes)", plist.startsWith("<?xml") && plist.trimEnd().endsWith("</plist>"));

  const plan = svc.servicePlan({ platform: "darwin", node: NODE, loomBin: LOOM_BIN, port: PORT, homedir: HOMEDIR, loomHome: null, userId: "" });
  check("mac plan: plist path under ~/Library/LaunchAgents", plan.artifactPath === path.join(HOMEDIR, "Library/LaunchAgents/com.loom.daemon.plist"));
  check("mac plan: install pre-unloads then loads -w (idempotent replace)",
    plan.installCmds[0].args[0] === "unload" && plan.installCmds[0].ignoreFailure === true &&
    plan.installCmds[1].args.join(" ") === `load -w ${plan.artifactPath}`);
  check("mac plan: uninstall unload -w best-effort", plan.uninstallCmds[0].args.join(" ") === `unload -w ${plan.artifactPath}` && plan.uninstallCmds[0].ignoreFailure === true);
  check("mac plan: queryCmd is launchctl list <label>", plan.queryCmd.args.join(" ") === "list com.loom.daemon");
}

// --- (5) Windows: Task Scheduler logon task XML ---------------------------------------------------
{
  const xml = svc.windowsTaskXml({ node: WIN_NODE, loomBin: WIN_BIN, port: PORT, workingDir: "C:\\pkg", userId: "MACHINE\\u" });
  check("win xml: declares UTF-16 (schtasks requirement)", xml.includes('encoding="UTF-16"'));
  check("win xml: LogonTrigger (autostart at logon)", xml.includes("<LogonTrigger>"));
  check("win xml: principal LeastPrivilege + InteractiveToken (no admin)", xml.includes("<RunLevel>LeastPrivilege</RunLevel>") && xml.includes("<LogonType>InteractiveToken</LogonType>"));
  check("win xml: Command is the node exe", xml.includes(`<Command>${WIN_NODE}</Command>`));
  // Quotes around loomBin are XML-escaped (&quot;) in the file; Task Scheduler decodes them back to ".
  check("win xml: Arguments = (escaped-)quoted loomBin + start --no-open --port", xml.includes(`<Arguments>&quot;${WIN_BIN}&quot; start --no-open --port ${PORT}</Arguments>`));
  check("win xml: RestartOnFailure (keep-alive)", xml.includes("<RestartOnFailure>"));
  check("win xml: no execution time limit (PT0S — daemon runs forever)", xml.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
  check("win xml: userId XML-escaped backslash preserved", xml.includes("<UserId>MACHINE\\u</UserId>"));

  const plan = svc.servicePlan({ platform: "win32", node: WIN_NODE, loomBin: WIN_BIN, port: PORT, homedir: WIN_HOME, loomHome: null, userId: "MACHINE\\u" });
  check("win plan: artifact under <loomHome>/service/Loom.xml", plan.artifactPath === path.join(WIN_HOME, ".loom", "service", "Loom.xml"));
  check("win plan: artifact encoding utf16le (BOM written by executor)", plan.artifactEncoding === "utf16le");
  check("win plan: install is schtasks /create /xml … /f (idempotent overwrite)",
    plan.installCmds.length === 1 && plan.installCmds[0].file === "schtasks" &&
    plan.installCmds[0].args.join(" ") === `/create /tn Loom /xml ${plan.artifactPath} /f`);
  check("win plan: uninstall is schtasks /delete /tn Loom /f best-effort",
    plan.uninstallCmds[0].args.join(" ") === "/delete /tn Loom /f" && plan.uninstallCmds[0].ignoreFailure === true);
  check("win plan: queryCmd is schtasks /query /tn Loom", plan.queryCmd.args.join(" ") === "/query /tn Loom");
}

// --- (6) unsupported platform throws --------------------------------------------------------------
check("servicePlan throws on unknown platform", (() => { try { svc.servicePlan({ platform: "sunos", node: NODE, loomBin: LOOM_BIN, port: PORT, homedir: HOMEDIR, loomHome: null, userId: "" }); return false; } catch { return true; } })());

console.log(failures === 0
  ? "\n✅ ALL PASS — service install/uninstall/status: arg-parsing + the systemd unit / launchd plist / Task Scheduler XML generation + idempotent command construction are correct for all three OSes.\n   ⚠ mac/linux paths are STRUCTURALLY verified only — they need owner live-verify on a Mac/Linux host (launchctl/systemctl are absent on the Windows dev box). Windows is verified LIVE."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
