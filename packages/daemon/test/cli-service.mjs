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

  // --- (3b) systemd quoting/escaping per systemd.syntax(7) — card db3b731f ------------------------
  // The regression: ExecStart=/Environment= lines were unquoted, so a value with a space, `%`, or `$`
  // broke the unit (space splits a token early; `%`/`$` get read as a systemd specifier/variable).
  const homeWithSpace = svc.linuxUnitText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: "/home/u/my home" });
  check("linux unit: LOOM_HOME with a space is quoted as the whole assignment",
    homeWithSpace.includes('Environment="LOOM_HOME=/home/u/my home"'));

  const homeWithPercent = svc.linuxUnitText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: "/home/u/50%off" });
  check("linux unit: LOOM_HOME with a literal % is specifier-escaped (%%), and not spuriously quoted",
    homeWithPercent.includes("Environment=LOOM_HOME=/home/u/50%%off") && !homeWithPercent.includes('Environment="LOOM_HOME'));

  const homeWithDollar = svc.linuxUnitText({ node: NODE, loomBin: LOOM_BIN, port: PORT, loomHome: "/home/u/$literal" });
  check("linux unit: LOOM_HOME with a literal $ stays a single $ (Environment= is never $-expanded)",
    homeWithDollar.includes("Environment=LOOM_HOME=/home/u/$literal") && !homeWithDollar.includes("$$literal"));

  const binWithDollar = svc.linuxUnitText({ node: NODE, loomBin: "/home/u/$special/loom.mjs", port: PORT, loomHome: null });
  check("linux unit: an ExecStart token with a literal $ IS doubled ($$) — ExecStart= performs $-expansion",
    binWithDollar.includes(`ExecStart=${NODE} /home/u/$$special/loom.mjs start --no-open --port ${PORT}`));

  const binWithSpace = svc.linuxUnitText({ node: NODE, loomBin: "/home/u/my loom/loom.mjs", port: PORT, loomHome: null });
  check("linux unit: an ExecStart token with a space is quoted",
    binWithSpace.includes(`ExecStart=${NODE} "/home/u/my loom/loom.mjs" start --no-open --port ${PORT}`));

  // Negative control: the ordinary no-special-characters case (already asserted above, restated here
  // explicitly) must stay byte-identical/unquoted — proves quoting only fires when actually needed.
  check("linux unit: negative control — plain values stay unquoted (no spurious quoting/escaping)",
    unit.includes(`ExecStart=${NODE} ${LOOM_BIN} start --no-open --port ${PORT}`) &&
    !unit.includes('"') && !unit.includes("%%") && !unit.includes("$$"));

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
  // Card 0da5a3f7: KeepAlive must be the SuccessfulExit:false qualifier form (crash-only restart), never
  // unconditional <true/> — see that decision record for the launchd-vs-`loom update` race it prevents.
  check("mac plist: KeepAlive is SuccessfulExit:false (crash-only, matches systemd's on-failure)",
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/.test(plist));
  check("mac plist: KeepAlive is NOT the unconditional bare <true/> form", !/<key>KeepAlive<\/key>\s*<true\/>/.test(plist));
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
  // card db3b731f regression: windowsTaskXml took no loomHome at all, so a custom LOOM_HOME never
  // reached the autostarted daemon (it always booted on the DEFAULT ~/.loom). Task Scheduler's Exec
  // action has no native env-var slot, so the fix routes the launch through cmd.exe + `set`.
  const xml = svc.windowsTaskXml({ node: WIN_NODE, loomBin: WIN_BIN, port: PORT, workingDir: "C:\\pkg", userId: "MACHINE\\u", loomHome: null });
  check("win xml: declares UTF-16 (schtasks requirement)", xml.includes('encoding="UTF-16"'));
  check("win xml: LogonTrigger (autostart at logon)", xml.includes("<LogonTrigger>"));
  check("win xml: principal LeastPrivilege + InteractiveToken (no admin)", xml.includes("<RunLevel>LeastPrivilege</RunLevel>") && xml.includes("<LogonType>InteractiveToken</LogonType>"));
  check("win xml: Command is cmd.exe (Task Scheduler has no native env-var slot for Exec actions)", xml.includes("<Command>C:\\Windows\\System32\\cmd.exe</Command>"));
  // Quotes are XML-escaped (&quot;) in the file and `&` as &amp;; Task Scheduler/cmd.exe decode both back.
  check("win xml (no custom home): Arguments sets LOOM_PORT then execs quoted node + quoted loomBin",
    xml.includes(`<Arguments>/d /c set &quot;LOOM_PORT=${PORT}&quot;&amp;&quot;${WIN_NODE}&quot; &quot;${WIN_BIN}&quot; start --no-open --port ${PORT}</Arguments>`));
  check("win xml (no custom home): no LOOM_HOME set when unset", !xml.includes("LOOM_HOME"));
  check("win xml: WorkingDirectory preserved", xml.includes("<WorkingDirectory>C:\\pkg</WorkingDirectory>"));
  check("win xml: RestartOnFailure (keep-alive)", xml.includes("<RestartOnFailure>"));
  check("win xml: no execution time limit (PT0S — daemon runs forever)", xml.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
  check("win xml: userId XML-escaped backslash preserved", xml.includes("<UserId>MACHINE\\u</UserId>"));

  // --- the actual regression: a custom LOOM_HOME (with a space, the exec-path-with-spaces case) ----
  const winHomeWithSpace = "C:\\Users\\u\\custom home";
  const xmlWithHome = svc.windowsTaskXml({ node: WIN_NODE, loomBin: WIN_BIN, port: PORT, workingDir: "C:\\pkg", userId: "MACHINE\\u", loomHome: winHomeWithSpace });
  check("win xml: custom LOOM_HOME (incl. a space) is baked as a quoted `set` before the exec",
    xmlWithHome.includes(`<Arguments>/d /c set &quot;LOOM_PORT=${PORT}&quot;&amp;set &quot;LOOM_HOME=${winHomeWithSpace}&quot;&amp;&quot;${WIN_NODE}&quot; &quot;${WIN_BIN}&quot; start --no-open --port ${PORT}</Arguments>`));

  const plan = svc.servicePlan({ platform: "win32", node: WIN_NODE, loomBin: WIN_BIN, port: PORT, homedir: WIN_HOME, loomHome: null, userId: "MACHINE\\u" });
  check("win plan: artifact under <loomHome>/service/Loom.xml", plan.artifactPath === path.join(WIN_HOME, ".loom", "service", "Loom.xml"));
  check("win plan: artifact encoding utf16le (BOM written by executor)", plan.artifactEncoding === "utf16le");
  check("win plan: install is schtasks /create /xml … /f (idempotent overwrite)",
    plan.installCmds.length === 1 && plan.installCmds[0].file === "schtasks" &&
    plan.installCmds[0].args.join(" ") === `/create /tn Loom /xml ${plan.artifactPath} /f`);
  check("win plan: uninstall is schtasks /delete /tn Loom /f best-effort",
    plan.uninstallCmds[0].args.join(" ") === "/delete /tn Loom /f" && plan.uninstallCmds[0].ignoreFailure === true);
  check("win plan: queryCmd is schtasks /query /tn Loom", plan.queryCmd.args.join(" ") === "/query /tn Loom");

  const planWithHome = svc.servicePlan({ platform: "win32", node: WIN_NODE, loomBin: WIN_BIN, port: PORT, homedir: WIN_HOME, loomHome: "C:\\Users\\u\\.loom", userId: "MACHINE\\u" });
  check("win plan: servicePlan actually threads loomHome through to windowsTaskXml (the card's own regression)",
    planWithHome.artifactContent.includes("LOOM_HOME=C:\\Users\\u\\.loom"));
}

// --- (6) unsupported platform throws --------------------------------------------------------------
check("servicePlan throws on unknown platform", (() => { try { svc.servicePlan({ platform: "sunos", node: NODE, loomBin: LOOM_BIN, port: PORT, homedir: HOMEDIR, loomHome: null, userId: "" }); return false; } catch { return true; } })());

console.log(failures === 0
  ? "\n✅ ALL PASS — service install/uninstall/status: arg-parsing + the systemd unit / launchd plist / Task Scheduler XML generation + idempotent command construction are correct for all three OSes.\n   ⚠ mac/linux paths are STRUCTURALLY verified only — they need owner live-verify on a Mac/Linux host (launchctl/systemctl are absent on the Windows dev box). Windows is verified LIVE."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
