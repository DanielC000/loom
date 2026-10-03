// `loom service install | uninstall | status` — register Loom to AUTOSTART in the background on
// login/boot, on all three OSes. This is the management-CLI companion to bin/loom.mjs (Epic 2b).
//
// ARCHITECTURE (decided by the Lead — see the task): END USERS get NO supervisor
// (scripts/daemon-supervisor.mjs is NOT shipped in the npm package). So the registered OS service runs
// **`loom start --no-open`** in the FOREGROUND and the OS service manager owns the lifecycle +
// keep-alive/restart:
//   - Linux  : a systemd --user unit (Restart=on-failure, WantedBy=default.target) under
//              ~/.config/systemd/user, enabled+started via `systemctl --user`.
//   - macOS  : a launchd LaunchAgent plist (RunAtLoad + KeepAlive) under ~/Library/LaunchAgents,
//              loaded via `launchctl`.
//   - Windows: a Task Scheduler logon task (schtasks /create /xml) running at logon — no admin / no
//              service wrapper needed (a logon task runs as the current interactive user with
//              LeastPrivilege).
//
// This module is SIDE-EFFECT-FREE on import: it only DEFINES functions. The pure generators
// (`servicePlan` and the artifact builders) are unit-tested hermetically on any OS; the executor
// (`runService`) shells out to the platform tool and only runs on the matching OS. So on this Windows
// box the Windows path is verified LIVE, while the mac/linux artifacts are structurally verified.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Stable identifiers for the registered service, per OS.
export const LINUX_UNIT_NAME = "loom.service";
export const MAC_LABEL = "com.loom.daemon";
export const WIN_TASK_NAME = "Loom";

export const SERVICE_ACTIONS = new Set(["install", "uninstall", "status"]);

// XML/text escaping for the small set of values we interpolate (paths, user id, port).
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// The argument string the OS runs: `loom start --no-open --port <port>`. We always bake an explicit
// --port so the autostarted daemon matches the port chosen at install time, regardless of whether the
// login session has LOOM_PORT set. (Returned as an argv array; callers join/quote per platform.)
export function startArgv(port) {
  return ["start", "--no-open", "--port", String(port)];
}

// --- artifact text generators (PURE) ----------------------------------------------------------------

// --- systemd value quoting/escaping (systemd.syntax(7)) ---------------------------------------------
// Both ExecStart= and Environment= lines go through systemd's own SPECIFIER expansion — any bare `%` can
// be read as the start of a %i/%n/... specifier (systemd.unit(5) "Specifiers": "to insert a literal %
// character, write %%") — and ExecStart= additionally performs shell-style `$VAR`/`${VAR}` expansion
// (systemd.service(5) "Command lines": "$$ is replaced by a single dollar sign"), so a literal `$` in an
// ExecStart= token must ALSO be doubled. Environment= assignments are NOT $-expanded, so a `$` in a
// LOOM_HOME value must be left alone there — doubling it would store the wrong value.
function systemdEscapePercent(s) {
  return s.replace(/%/g, "%%");
}
function systemdEscapeDollarForExec(s) {
  return s.replace(/\$/g, "$$$$"); // replacement "$$$$" -> two literal $ per match, per String#replace rules
}
// True if `s` needs systemd's own shell-style double-quoting to survive whitespace/quote tokenizing.
function systemdNeedsQuoting(s) {
  return /[\s"'\\]/.test(s);
}
// Backslash-escape for the inside of a systemd double-quoted token (backslash first, then the quote).
function systemdBackslashEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
// One ExecStart= word: specifier/variable-escaped, then quoted only if it actually needs to be — keeps
// the common no-special-character case byte-identical to the unquoted form every existing caller expects.
function systemdExecToken(raw) {
  const escaped = systemdEscapeDollarForExec(systemdEscapePercent(raw));
  return systemdNeedsQuoting(escaped) ? `"${systemdBackslashEscape(escaped)}"` : escaped;
}
// One Environment= assignment ("KEY=value"): % escaped (specifiers), $ left alone (no expansion here),
// the WHOLE assignment quoted (per systemd.exec(5)'s own `Environment="VAR=word1 word2"` form) only if
// the value needs it.
function systemdEnvAssignment(key, rawValue) {
  const value = systemdEscapePercent(rawValue);
  const assignment = `${key}=${value}`;
  return systemdNeedsQuoting(assignment) ? `"${systemdBackslashEscape(assignment)}"` : assignment;
}

// systemd --user unit. Restart=on-failure gives the keep-alive the supervisor would otherwise provide.
// WantedBy=default.target makes `enable` autostart it on the next login (the --user manager starts at
// login, so this is "on login" — exactly the supervisor-free model the Lead chose).
export function linuxUnitText({ node, loomBin, port, loomHome }) {
  const exec = [node, loomBin, ...startArgv(port)].map(systemdExecToken).join(" ");
  const envLines = [`Environment=${systemdEnvAssignment("LOOM_PORT", String(port))}`];
  if (loomHome) envLines.push(`Environment=${systemdEnvAssignment("LOOM_HOME", loomHome)}`);
  return `[Unit]
Description=Loom — local-first AI project workspace
After=network.target

[Service]
Type=simple
${envLines.join("\n")}
ExecStart=${exec}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// launchd LaunchAgent plist. RunAtLoad starts it when the agent is loaded at login; KeepAlive restarts it
// on a CRASH (a non-zero/signal exit) — the same "keep-alive on failure, not on every exit" posture as
// Linux's `Restart=on-failure` and Windows' `RestartOnFailure`, via KeepAlive's SuccessfulExit qualifier
// rather than the unconditional `<true/>` form.
//
// @decision 0da5a3f7 — do not revert to unconditional `<true/>`: it races launchd's own auto-respawn
// against `loom update`'s stop → npm install → restart sequence (a graceful stop is a clean exit).
//
// Stdout/stderr go to a log under LOOM_HOME so a background boot stays debuggable.
export function macPlistText({ node, loomBin, port, loomHome, logDir }) {
  const programArgs = [node, loomBin, ...startArgv(port)];
  const argXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envEntries = [["LOOM_PORT", String(port)]];
  if (loomHome) envEntries.push(["LOOM_HOME", loomHome]);
  const envXml = envEntries.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join("\n");
  const outLog = path.join(logDir, "daemon-service.log");
  const errLog = path.join(logDir, "daemon-service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(MAC_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

// Windows Task Scheduler logon task (schema v1.2). LogonTrigger fires at the user's logon; the
// principal runs as that interactive user with LeastPrivilege (no admin / no service wrapper).
// ExecutionTimeLimit PT0S = no time limit (the daemon runs as long as the session). RestartOnFailure
// gives the keep-alive.
//
// Task Scheduler's Exec action (TaskSchema.xsd) has only Command/Arguments/WorkingDirectory — no
// Environment element — so, unlike systemd/launchd above, there is no native way to hand this process a
// custom LOOM_HOME/LOOM_PORT. The Command is therefore cmd.exe, and node + the daemon script become part
// of the Arguments, preceded by `set "VAR=value"` for each env var. Quoting the WHOLE assignment (not
// just the value) is the standard robust `set` form: it survives spaces, and since cmd.exe treats a
// quoted region's contents as literal, it also protects against `&`/`|`/`<`/`>` inside the value being
// read as a new command — a literal `"` can never appear in a Windows path (NTFS forbids it), so no
// further escaping is needed. `/d` skips registry AutoRun commands for this one launch.
export function windowsTaskXml({ node, loomBin, port, workingDir, userId, loomHome }) {
  const cmdExe = "C:\\Windows\\System32\\cmd.exe";
  const setters = [`set "LOOM_PORT=${port}"`];
  if (loomHome) setters.push(`set "LOOM_HOME=${loomHome}"`);
  const execLine = `"${node}" "${loomBin}" ${startArgv(port).join(" ")}`;
  const argsStr = `/d /c ${[...setters, execLine].join("&")}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Loom — local-first AI project workspace (autostart at logon)</Description>
    <URI>\\${xmlEscape(WIN_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmdExe)}</Command>
      <Arguments>${xmlEscape(argsStr)}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// --- the plan (PURE) --------------------------------------------------------------------------------
// Describe everything install/uninstall/status need for a platform, declaratively, so it can be
// asserted in a hermetic test without executing any OS tool. opts:
//   { platform, node, loomBin, workingDir, port, homedir, loomHome, userId }
// Returns:
//   { platform, manager, artifactPath, artifactContent, artifactEncoding,
//     installCmds:[{file,args}], uninstallCmds:[{file,args,ignoreFailure?}], queryCmd:{file,args}|null }
export function servicePlan(opts) {
  const { platform, node, loomBin, workingDir, port, homedir, loomHome, userId } = opts;
  if (platform === "linux") {
    const dir = path.join(homedir, ".config", "systemd", "user");
    const artifactPath = path.join(dir, LINUX_UNIT_NAME);
    return {
      platform,
      manager: "systemd (--user)",
      artifactPath,
      artifactContent: linuxUnitText({ node, loomBin, port, loomHome }),
      artifactEncoding: "utf8",
      // daemon-reload picks up the freshly-written unit; `enable --now` is idempotent (re-running just
      // re-asserts enabled + started).
      installCmds: [
        { file: "systemctl", args: ["--user", "daemon-reload"] },
        { file: "systemctl", args: ["--user", "enable", "--now", LINUX_UNIT_NAME] },
      ],
      // disable --now is best-effort (a not-loaded unit is fine); the unit file is removed by the
      // executor, then a daemon-reload clears it.
      uninstallCmds: [
        { file: "systemctl", args: ["--user", "disable", "--now", LINUX_UNIT_NAME], ignoreFailure: true },
        { file: "systemctl", args: ["--user", "daemon-reload"], ignoreFailure: true },
      ],
      queryCmd: { file: "systemctl", args: ["--user", "is-enabled", LINUX_UNIT_NAME] },
    };
  }
  if (platform === "darwin") {
    const dir = path.join(homedir, "Library", "LaunchAgents");
    const artifactPath = path.join(dir, `${MAC_LABEL}.plist`);
    const logDir = path.join(loomHome || path.join(homedir, ".loom"), "logs");
    return {
      platform,
      manager: "launchd (LaunchAgent)",
      artifactPath,
      artifactContent: macPlistText({ node, loomBin, port, loomHome, logDir }),
      artifactEncoding: "utf8",
      // Pre-unload (best-effort) makes load idempotent — a re-install replaces a stale registration
      // cleanly instead of erroring with "already loaded".
      installCmds: [
        { file: "launchctl", args: ["unload", artifactPath], ignoreFailure: true },
        { file: "launchctl", args: ["load", "-w", artifactPath] },
      ],
      uninstallCmds: [
        { file: "launchctl", args: ["unload", "-w", artifactPath], ignoreFailure: true },
      ],
      queryCmd: { file: "launchctl", args: ["list", MAC_LABEL] },
    };
  }
  if (platform === "win32") {
    const dir = path.join(loomHome || path.join(homedir, ".loom"), "service");
    const artifactPath = path.join(dir, `${WIN_TASK_NAME}.xml`);
    return {
      platform,
      manager: "Task Scheduler (logon task)",
      artifactPath,
      artifactContent: windowsTaskXml({ node, loomBin, port, workingDir, userId, loomHome }),
      // schtasks /create /xml requires a UTF-16 file (with BOM) — see runService.
      artifactEncoding: "utf16le",
      // /f forces overwrite → idempotent re-install.
      installCmds: [
        { file: "schtasks", args: ["/create", "/tn", WIN_TASK_NAME, "/xml", artifactPath, "/f"] },
      ],
      // /f suppresses the confirm prompt; a missing task is best-effort.
      uninstallCmds: [
        { file: "schtasks", args: ["/delete", "/tn", WIN_TASK_NAME, "/f"], ignoreFailure: true },
      ],
      queryCmd: { file: "schtasks", args: ["/query", "/tn", WIN_TASK_NAME] },
    };
  }
  throw new Error(`unsupported platform '${platform}'`);
}

// --- executor (runs only on the matching OS) --------------------------------------------------------

// `timeoutMs`, when given, bounds the spawn (spawnSync kills the child and returns with `status: null` on
// expiry — already "not ok" via the check below, so a timeout needs no special-cased branch). Only
// `isServiceRegistered`'s query call passes one (card 279c0208 review) — install/uninstall steps are
// unbounded, unchanged.
function runStep(step, timeoutMs) {
  const r = spawnSync(step.file, step.args, { encoding: "utf8", shell: false, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  // ENOENT (tool absent) surfaces as r.error; a non-zero exit (incl. a timeout kill) as r.status !== 0.
  const ok = !r.error && r.status === 0;
  return { ok, status: r.status, error: r.error, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function writeArtifact(plan) {
  fs.mkdirSync(path.dirname(plan.artifactPath), { recursive: true });
  // Windows schtasks wants UTF-16 LE WITH a BOM; prepend ﻿ so utf16le emits FF FE.
  const content = plan.artifactEncoding === "utf16le" ? "﻿" + plan.artifactContent : plan.artifactContent;
  fs.writeFileSync(plan.artifactPath, content, plan.artifactEncoding);
}

// Build the live ctx → plan. ctx: { platform, node, loomBin, workingDir, port, loomHome }.
function planFor(ctx) {
  const homedir = os.homedir();
  let userId = "";
  if (ctx.platform === "win32") {
    const user = (() => { try { return os.userInfo().username; } catch { return process.env.USERNAME || ""; } })();
    userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  }
  return servicePlan({
    platform: ctx.platform,
    node: ctx.node,
    loomBin: ctx.loomBin,
    workingDir: ctx.workingDir,
    port: ctx.port,
    homedir,
    loomHome: process.env.LOOM_HOME || null,
    userId,
  });
}

// install: write the artifact, then run the install commands (idempotent per-OS). Returns an exit code.
async function install(ctx) {
  let plan;
  try { plan = planFor(ctx); } catch (e) { console.error(`loom service: ${e.message}`); return 1; }
  console.log(`loom service: installing Loom autostart via ${plan.manager} …`);
  try { writeArtifact(plan); } catch (e) {
    console.error(`loom service: failed to write ${plan.artifactPath}: ${e.message}`); return 1;
  }
  for (const step of plan.installCmds) {
    const r = runStep(step);
    if (!r.ok && !step.ignoreFailure) {
      console.error(`loom service: command failed — ${step.file} ${step.args.join(" ")}`);
      if (r.error) console.error(`  ${r.error.message}`);
      else if (r.stderr.trim()) console.error(`  ${r.stderr.trim()}`);
      return 1;
    }
  }
  console.log(`loom service: installed. Loom will autostart \`loom start --no-open --port ${ctx.port}\` on next login.`);
  console.log(`  artifact: ${plan.artifactPath}`);
  return 0;
}

// uninstall: run the uninstall commands (best-effort), then remove the artifact. Idempotent — removing
// an absent registration is a no-op success.
async function uninstall(ctx) {
  let plan;
  try { plan = planFor(ctx); } catch (e) { console.error(`loom service: ${e.message}`); return 1; }
  console.log(`loom service: removing Loom autostart (${plan.manager}) …`);
  for (const step of plan.uninstallCmds) {
    const r = runStep(step);
    if (!r.ok && !step.ignoreFailure) {
      console.error(`loom service: command failed — ${step.file} ${step.args.join(" ")}`);
      if (r.stderr.trim()) console.error(`  ${r.stderr.trim()}`);
      return 1;
    }
  }
  try { fs.rmSync(plan.artifactPath, { force: true }); } catch { /* already gone */ }
  console.log("loom service: uninstalled (autostart removed).");
  return 0;
}

// status: registered? (query the OS manager) + running? (cross-check the daemon via isRunning).
async function status(ctx) {
  let plan;
  try { plan = planFor(ctx); } catch (e) { console.error(`loom service: ${e.message}`); return 1; }
  let registered = false;
  if (plan.queryCmd) {
    const r = runStep(plan.queryCmd);
    registered = r.ok;
  }
  // The artifact file existing is a fallback signal (e.g. systemd is-enabled may report "static").
  const artifactExists = fs.existsSync(plan.artifactPath);
  const isRegistered = registered || artifactExists;

  const version = await ctx.isRunning(ctx.port);
  console.log(`loom service: manager   = ${plan.manager}`);
  console.log(`loom service: registered = ${isRegistered ? "yes" : "no"}${!registered && artifactExists ? " (artifact present)" : ""}`);
  console.log(`loom service: artifact   = ${plan.artifactPath}${artifactExists ? "" : " (absent)"}`);
  console.log(`loom service: running    = ${version ? `yes (v${version} on port ${ctx.port})` : "no"}`);
  // Exit non-zero when not registered, so it is scriptable like `loom status`.
  return isRegistered ? 0 : 1;
}

// Bounds `isServiceRegistered`'s OS-query spawn (card 279c0208 review): `loom update` calls this AFTER
// already stopping the daemon it might be about to restart, so a hung/unresponsive query tool (a wedged
// systemd/launchd/Task-Scheduler client, a broken D-Bus session, …) must never hang the whole update with
// the daemon already down. A timed-out query is treated the same as any other query failure — not
// registered, falling back to the artifact-existence check below.
const SERVICE_QUERY_TIMEOUT_MS = 5000;

// Read-only: is a Loom autostart registration currently present for `ctx.platform`? Same detection
// `status()` above uses (query the OS manager, falling back to the artifact file existing), factored out
// so a caller that only needs the yes/no — never the full install/uninstall/status UX — doesn't have to
// duplicate it. `ctx` needs only `platform` (+ `loomHome`/`LOOM_HOME` implicitly, via `planFor`) — the
// other `servicePlan` fields (node/loomBin/workingDir/port) only affect the generated ARTIFACT CONTENT,
// which this never reads. Used by `loom update` (card 279c0208, point 2 — see that call site's own
// comment for the decision this backs) to decide whether to print a hint; never throws (a platform this
// process doesn't run on, or any probe failure, is reported as "not registered" — a pure information
// read has no useful way to fail loudly to a caller that doesn't even show the platform it asked about).
export function isServiceRegistered(ctx) {
  let plan;
  try { plan = planFor(ctx); } catch { return false; }
  let registered = false;
  if (plan.queryCmd) {
    const r = runStep(plan.queryCmd, SERVICE_QUERY_TIMEOUT_MS);
    registered = r.ok;
  }
  try { return registered || fs.existsSync(plan.artifactPath); } catch { return registered; }
}

// Dispatch entry called from bin/loom.mjs. ctx: { action, platform, node, loomBin, workingDir, port,
//   loomHome, isRunning }.
export async function runService(ctx) {
  switch (ctx.action) {
    case "install": return install(ctx);
    case "uninstall": return uninstall(ctx);
    case "status": return status(ctx);
    default:
      console.error(`loom service: unknown action '${ctx.action}' (expected install | uninstall | status)`);
      return 2;
  }
}
