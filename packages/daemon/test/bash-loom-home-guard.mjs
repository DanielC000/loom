// Card da1a4a1b — PreToolUse(Bash) guard that refuses a command naming the REAL LOOM_HOME's DB / backups /
// secret.key for Loom-driven roles. Covers: the pure matcher (refusal, spelling variants, passes), the
// real hook process contract (exit 2 + stderr / exit 0), and the settings wiring (driven vs not).
// NOT covered: a real claude session actually honouring exit 2 (needs a real engine spawn).
// RUN: pnpm --filter @loom/daemon build, then `node test/bash-loom-home-guard.mjs` from packages/daemon.
import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("blhg-");
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "assets", "bash-loom-home-guard.mjs");
const { checkCommand } = await import(pathToFileURL(SCRIPT).href);

// ── (1) pure matcher, win32 flavour ─────────────────────────────────────────────────────────────
const W = { win32: true, homedir: "C:\\Users\\Tester" };
const WHOME = "C:\\Users\\Tester\\.loom";
const refusedW = [
  ["forward slash", `node -e "new (require('better-sqlite3'))('C:/Users/Tester/.loom/loom.db')"`],
  ["backslash", `node q.mjs C:\\Users\\Tester\\.loom\\loom.db`],
  ["mixed slashes", `node q.mjs C:\\Users\\Tester/.loom\\loom.db`],
  ["double slashes", `cat C://Users//Tester//.loom//secret.key`],
  ["case-variant (win32 is case-insensitive)", `type c:\\users\\TESTER\\.LOOM\\Loom.DB`],
  ["git-bash drive form", `cp /c/Users/Tester/.loom/loom.db ./x.db`],
  ["tilde", `sqlite3 ~/.loom/loom.db .tables`],
  ["$HOME", `cp "$HOME/.loom/loom.db" x`],
  ["${HOME}", `cp \${HOME}/.loom/secret.key x`],
  ["%USERPROFILE%", `copy %USERPROFILE%\\.loom\\loom.db x.db`],
  ["$env:USERPROFILE", `Copy-Item $env:USERPROFILE\\.loom\\loom.db x.db`],
  ["$LOOM_HOME", `cp $LOOM_HOME/loom.db x`],
  ["$env:LOOM_HOME", `Copy-Item $env:LOOM_HOME\\loom.db x`],
  ["wal sibling", `cp ~/.loom/loom.db-wal x`],
  ["backups dir", `ls ~/.loom/backups/auto`],
  ["cd then bare name", `cd ~/.loom && sqlite3 loom.db .tables`],
  ["secret.key via cd", `cd C:/Users/Tester/.loom; cat secret.key`],
  ["gateway-loopback.key forward slash", `cat C:/Users/Tester/.loom/gateway-loopback.key`],
  ["gateway-loopback.key backslash", `type C:\\Users\\Tester\\.loom\\gateway-loopback.key`],
  ["gateway-loopback.key tilde", `curl -H "Authorization: Bearer $(cat ~/.loom/gateway-loopback.key)" x`],
  ["gateway-loopback.key %USERPROFILE%", `type %USERPROFILE%\\.loom\\gateway-loopback.key`],
  ["gateway-loopback.key $LOOM_HOME", `cat $LOOM_HOME/gateway-loopback.key`],
  ["gateway-loopback.key case-variant", `type c:\\USERS\\tester\\.LOOM\\Gateway-Loopback.KEY`],
  ["gateway-loopback.key via cd", `cd ~/.loom && cat gateway-loopback.key`],
  [".env forward slash", `cat C:/Users/Tester/.loom/.env`],
  [".env backslash", `type C:\\Users\\Tester\\.loom\\.env`],
  [".env tilde", `cat ~/.loom/.env`],
  [".env $env:USERPROFILE", `Get-Content $env:USERPROFILE\\.loom\\.env`],
  [".env git-bash drive", `cat /c/Users/Tester/.loom/.env`],
  [".env via cd", `cd ~/.loom && cat .env`],
  // LOOM_HOME= is NOT an exemption: bash expands $LOOM_HOME before a prefix assignment applies.
  ["prefix-assignment bypass", `LOOM_HOME=/tmp/x cp $LOOM_HOME/loom.db /tmp/y`],
  ["bare LOOM_HOME= mention bypass", `echo LOOM_HOME=; cp $LOOM_HOME/secret.key /tmp/k`],
  ["temp-home assign then real $LOOM_HOME .env", `LOOM_HOME=C:/Temp/blhg-3 node x.mjs && cat $LOOM_HOME/.env`],
  ["export then $LOOM_HOME/loom.db", `export LOOM_HOME="$(mktemp -d)"; node t.mjs "$LOOM_HOME/loom.db"`],
  ["trailing slash home then bare token", `cd ~/.loom/ && cat secret.key`],
  // `.` / `..` traversal (collapsed lexically, or caught as `../<sensitive>` under a home descendant):
  ["traversal: tmp/../loom.db", `cat ~/.loom/tmp/../loom.db`],
  ["traversal: ./secret.key", `cat ~/.loom/./secret.key`],
  ["traversal: home/. then .env", `cd ~/.loom/. && cat .env`],
  ["traversal: home/./ then secret.key", `cd ~/.loom/./ && cat secret.key`],
  ["traversal: tmp/.. then .env", `cd ~/.loom/tmp/.. && cat .env`],
  ["traversal: cd tmp then ../loom.db", `cd ~/.loom/tmp && cat ../loom.db`],
  ["traversal: cd logs; ../.env", `cd ~/.loom/logs; cat ../.env`],
  ["traversal: scratch ../../../secret.key", `cd ~/.loom/tmp/scratch/s && cp ../../../secret.key /tmp/k`],
  ["traversal: absolute with a/b/../../", `cat C:/Users/Tester/.loom/tmp/scratch/../../loom.db`],
  // Quote removal (normalised ONCE before every rule):
  ["quote: ../\"loom.db\"", `cd ~/.loom/tmp && cat ../"loom.db"`],
  ["quote: ../'.env'", `cd ~/.loom/tmp && cat ../'.env'`],
  ["quote: ..'/.env'", `cd ~/.loom/tmp && cat ..'/.env'`],
  ["quote: ..\"/\"loom.db",`cd ~/.loom/tmp && cat .."/"loom.db`],
  ["quote around the home dir", `cd "~/.loom" && cat .env`],
  ["quote around the home dir with sensitive file", `cat "$HOME/.loom"/"secret.key"`],
  ["mixed quotes inside an absolute path", `cat C:/Users/Tester/.loom/"tmp"/'..'/"loom.db"`],
  // Root-climb: `..` right after a root is dropped, as the OS does:
  ["root-climb: C:/../Users/...", `cat C:/../Users/Tester/.loom/loom.db`],
  ["root-climb: Users/../../Users/...", `cat C:/Users/../../Users/Tester/.loom/secret.key`],
  // `<` / `>` are separators:
  ["redirect: home> then .env", `cd ~/.loom>/dev/null && cat .env`],
  ["redirect: .env>", `cd ~/.loom && cat .env>/tmp/x`],
  ["redirect: cat<.env", `cd ~/.loom && cat<.env`],
  ["redirect: cat <~/.loom/.env", `cat <~/.loom/.env`],
  ["session settings dir",`cat ~/.loom/tmp/settings/abc.mcp-config.json`],
  ["session settings backslash", `type C:\\Users\\Tester\\.loom\\tmp\\settings\\x.json`],
];
for (const [label, cmd] of refusedW) check(`win32 refused: ${label}`, checkCommand(cmd, WHOME, W) !== null);

const allowedW = [
  ["normal command", `pnpm build && git status`],
  ["own scratch dir under LOOM_HOME", `node x.mjs C:/Users/Tester/.loom/scratch/abc/out.json`],
  ["scratch file under tilde", `cat ~/.loom/scratch/abc/notes.txt`],
  ["word loom.db without the real path", `grep -rn "loom.db" packages/daemon/src`],
  ["different home's loom.db", `node t.mjs C:/Temp/blhg-1/loom.db`],
  ["backups-old lookalike", `ls ~/.loom/backups-old-notes`],
  ["scratch dir under tmp (not tmp/settings)", `cat ~/.loom/tmp/scratch/abc/.env.example`],
  ["repo .env.example without the home", `cat packages/web/.env.example && grep -n ".env" README.md`],
  ["worktree-local gateway-loopback mention", `grep -rn gateway-loopback.key packages/daemon/src`],
  ["hermetic test shape: LOOM_HOME=<tmp> node test", `LOOM_HOME=C:/Temp/blhg-2 node test/x.mjs`],
  // Descendants of the real home (the worker's own $LOOM_SCRATCH_DIR lives at <home>/tmp/scratch/<sid>):
  ["own temp db under scratch", `sqlite3 C:/Users/Tester/.loom/tmp/scratch/s/h/loom.db .tables`],
  ["scratch out.log then grep loom.db in repo", `node t.mjs > C:/Users/Tester/.loom/tmp/scratch/s/out.log; grep -rn loom.db src`],
  ["copy repo .env.example into scratch", `cp packages/web/.env.example C:/Users/Tester/.loom/tmp/scratch/s/.env`],
  ["tail daemon log piped to grep .env", `tail C:/Users/Tester/.loom/logs/daemon-output.log | grep ".env"`],
  ["scratch with ./ and harmless ../ (no sensitive token)", `cd ~/.loom/tmp/scratch/s && ls ./out && cat ../notes.txt`],
  ["scratch ../ to a non-sensitive sibling", `cd ~/.loom/tmp/scratch/s && cp ../other/.env.example .`],
  ["tilde scratch + bare loom.db token",`cd ~/.loom/tmp/scratch/s && sqlite3 loom.db .tables`],
];
for (const [label, cmd] of allowedW) check(`win32 allowed: ${label}`, checkCommand(cmd, WHOME, W) === null);

// Cost: a pathological nesting (under the cap) must collapse in linear time; over the cap fails CLOSED.
{
  const deep = "cat " + "/a".repeat(12000) + "/..".repeat(12000);
  const t0 = performance.now();
  const r = checkCommand(deep, WHOME, W);
  const ms = performance.now() - t0;
  check(`pathological depth (${deep.length} chars) is allowed and takes < 1000 ms (took ${ms.toFixed(0)} ms)`, r === null && ms < 1000);
  const deepRefused = "cat C:/Users/Tester/.loom/" + "a/../".repeat(12000) + "loom.db";
  const t1 = performance.now();
  check("pathological a/../ chain still resolves to the real loom.db and is refused, fast",
    checkCommand(deepRefused, WHOME, W) !== null && performance.now() - t1 < 1000);
  const over = "echo " + "x".repeat(70000);
  check("over the length cap: matcher returns the too-long reason", checkCommand(over, WHOME, W) === "command too long for the Loom Bash guard");
}

// ── (2) pure matcher, POSIX flavour (case-sensitive) ────────────────────────────────────────────
const P = { win32: false, homedir: "/home/tester" };
const PHOME = "/home/tester/.loom";
check("posix refused: absolute", checkCommand("sqlite3 /home/tester/.loom/loom.db .dump", PHOME, P) !== null);
check("posix refused: tilde", checkCommand("cp ~/.loom/secret.key /tmp/k", PHOME, P) !== null);
check("posix refused: $HOME", checkCommand("cp $HOME/.loom/loom.db /tmp/x", PHOME, P) !== null);
check("posix refused: double slash", checkCommand("cat /home/tester//.loom//loom.db", PHOME, P) !== null);
check("posix allowed: case-differing path is a DIFFERENT file", checkCommand("cat /home/tester/.LOOM/loom.db", PHOME, P) === null);
check("posix allowed: normal", checkCommand("ls -la && node --test", PHOME, P) === null);
check("posix allowed: custom LOOM_HOME elsewhere not named", checkCommand("cat /home/tester/.loom/scratch/a.txt", PHOME, P) === null);
const CUSTOM = "/data/loomhome";
check("custom LOOM_HOME: real path refused", checkCommand("cp /data/loomhome/loom.db x", CUSTOM, P) !== null);
check("custom LOOM_HOME: default ~/.loom NOT refused (it is not the resolved home)", checkCommand("cp ~/.loom/loom.db x", CUSTOM, P) === null);
check("empty / non-string command allowed", checkCommand("", PHOME, P) === null && checkCommand(undefined, PHOME, P) === null);

// ── (3) real hook process contract ──────────────────────────────────────────────────────────────
const realHome = mkdtempManaged("blhg-real-");
const run = (command) => spawnSync(process.execPath, [SCRIPT, realHome], {
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8",
});
const denied = run(`node q.mjs "${realHome.replace(/\\/g, "/")}/loom.db"`);
check("process: command naming the real DB exits 2", denied.status === 2);
check("process: refusal message on stderr names the rule", /Refused: .*real Loom data directory/.test(denied.stderr));
const ok = run("pnpm build");
check("process: normal command exits 0 with no output", ok.status === 0 && ok.stderr === "");
const hermetic = run(`LOOM_HOME=${mkdtempManaged("blhg-tmp-").replace(/\\/g, "/")} node test/x.mjs`);
check("process: temp-LOOM_HOME test command exits 0", hermetic.status === 0);
// Malformed home ARGUMENT fails CLOSED and visibly (exit 2), unlike an unparseable stdin payload.
{
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } });
  const full = Buffer.from(realHome, "utf8").toString("base64url");
  // A base64 string whose length % 4 === 1 is never valid. (A truncation that lands on a valid length decodes
  // to a DIFFERENT, shorter path and cannot be detected without a checksum: named as a residual in the record.)
  let truncated = full.slice(0, -1);
  while (truncated.length % 4 !== 1) truncated = truncated.slice(0, -1);
  const argv = {
    "invalid chars": ["b64:!!!@@@"], "empty b64": ["b64:"], "truncated value (invalid length)": [`b64:${truncated}`],
    "padded (non-canonical) value": [`b64:${full}==`], "no argument": [], "empty plain argument": [""],
    "relative plain argument": ["not/absolute"], "b64 of a relative path": [`b64:${Buffer.from("rel/dir").toString("base64url")}`],
  };
  for (const [label, args] of Object.entries(argv)) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { input: payload, encoding: "utf8" });
    check(`misconfigured (${label}): exits 2 with the visible message`, r.status === 2 && /Loom Bash guard misconfigured: .*Report this to your manager/.test(r.stderr));
  }
  const good = spawnSync(process.execPath, [SCRIPT, `b64:${full}`], { input: payload, encoding: "utf8" });
  check("misconfigured control: a well-formed b64 argument still exits 0 on a normal command", good.status === 0);
}
{
  const r = run("echo " + "x".repeat(70000));
  check("process: an over-cap command fails CLOSED (exit 2) with the too-long message", r.status === 2 && /command too long for the Loom Bash guard/.test(r.stderr));
}
const garbage = spawnSync(process.execPath, [SCRIPT, realHome], { input: "not json", encoding: "utf8" });
check("process: unparseable payload fails open (exit 0)", garbage.status === 0);

// ── (4) settings wiring ─────────────────────────────────────────────────────────────────────────
const { writeSessionSettings, hooksShapeViolations } = await import("../dist/pty/claude-settings.js");
fs.mkdirSync(path.join(process.env.LOOM_HOME, "tmp", "settings"), { recursive: true });
const perm = { mode: "auto", allow: [], deny: [] };
const readHooks = (id, guard) => {
  const f = writeSessionSettings(id, perm, "tok", undefined, undefined, undefined, undefined, guard);
  return JSON.parse(fs.readFileSync(f, "utf8")).hooks;
};
const on = readHooks("blhg-on", true);
const bashGroup = on.PreToolUse.find((g) => g.matcher === "Bash");
check("wiring: driven role gets a PreToolUse Bash group", !!bashGroup);
check("wiring: command runs the guard script with the resolved LOOM_HOME",
  bashGroup && bashGroup.hooks[0].command.includes("bash-loom-home-guard.mjs") && bashGroup.hooks[0].command.includes(" b64:"));
{
  // The home arg is base64url, so no path character can break the shell quoting; it must decode to the resolved home.
  const m = /b64:([A-Za-z0-9_-]+)$/.exec(bashGroup?.hooks[0].command ?? "");
  check("wiring: the b64 arg decodes to the resolved LOOM_HOME", !!m && Buffer.from(m[1], "base64url").toString("utf8") === path.resolve(process.env.LOOM_HOME));
  const viaB64 = spawnSync(process.execPath, [SCRIPT, `b64:${Buffer.from(realHome + "$weird%dir\\", "utf8").toString("base64url")}`], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }), encoding: "utf8",
  });
  check("process: a b64 home containing $ % and a trailing backslash is accepted (exit 0 on a normal command)", viaB64.status === 0);
  const viaB64Deny = spawnSync(process.execPath, [SCRIPT, `b64:${Buffer.from(realHome, "utf8").toString("base64url")}`], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `cp "${realHome.replace(/\\/g, "/")}/loom.db" x` } }), encoding: "utf8",
  });
  check("process: a b64-encoded home still refuses the real loom.db (exit 2)", viaB64Deny.status === 2);
}
check("wiring: attribution PreToolUse group still present", on.PreToolUse.length === 2 && on.PreToolUse[0].matcher !== "Bash");
check("wiring: settings.hooks shape valid", hooksShapeViolations(on).length === 0);
const off = readHooks("blhg-off", undefined);
check("wiring: non-driven role (flag omitted) has NO Bash guard", !off.PreToolUse.some((g) => g.matcher === "Bash") && off.PreToolUse.length === 1);

// Source-level coupling: the host passes the guard flag from the same LOOM_DRIVEN_ROLES predicate.
const hostSrc = fs.readFileSync(path.join(here, "..", "src", "pty", "host.ts"), "utf8");
check("wiring: host.ts passes isLoomDrivenRole(opts.role) as the guard flag",
  // Whitespace-tolerant so a re-wrap of the call does not flip this (it is also a member of the
  // text-scanner lists in worktrees.ts for the same reason).
  /writeSessionSettings\([^;]*?isLoomDrivenRole\(opts\.role\)\s*,\s*isLoomDrivenRole\(opts\.role\)\s*\)/.test(hostSrc));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
finishAndExit(failures);
