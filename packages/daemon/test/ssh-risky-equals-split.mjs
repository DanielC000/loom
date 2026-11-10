import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ssh_exec risky screen over a program glued to an option value or env assignment (card 7755b0bd): `x=reboot`,
// `-Ireboot`, `-ocore.pager=x` are split into pieces so the risky list (and, in shell mode, the executor hold)
// sees the program. Applies to the OFF path too (fail-closed only). Each specimen is paired with clean controls.
// Pure (no Db, no wire). Not covered: env vars that name a file/library (LD_PRELOAD=/x.so), a program on no list,
// the OFF path's lack of an executor hold (bash/xargs are held only in shell mode).
//
// Run: 1) build (turbo builds shared first), 2) node test/ssh-risky-equals-split.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lre-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { evaluateSshCommandPolicy } = await import("../dist/connections/sshPolicy.js");
const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = await import("@loom/shared");

const base = { id: "equals-split-conn", readOnly: false, commandAllowlist: [], riskyCommandPatterns: [...DEFAULT_SSH_RISKY_COMMAND_PATTERNS] };
const off = base;
const on = { ...base, shellSyntax: true };
const held = async (conn, cmd) => { const v = await evaluateSshCommandPolicy(conn, cmd); return v.allowed === true && v.requiresApproval === true; };
const clean = async (conn, cmd) => { const v = await evaluateSshCommandPolicy(conn, cmd); return v.allowed === true && v.requiresApproval !== true; };

// Unquoted specimens: HELD on OFF and in shell mode.
for (const cmd of [
  "git -c core.sshCommand=reboot fetch", "tar --to-command=reboot x", "GIT_SSH_COMMAND=reboot git fetch",
  "git -c core.pager=reboot log", "rsync --rsh=reboot a b", "rsync --rsync-path=reboot a b",
  "tar --use-compress-program=reboot -xf a", "tar --checkpoint-action=exec=reboot x", "ssh -o ProxyCommand=reboot h",
  "man --pager=reboot ls", "tar -Ireboot -xf a", "rsync -ereboot a b", "git -ocore.pager=reboot log",
]) {
  check(`OFF   HELD: ${cmd}`, await held(off, cmd));
  check(`SHELL HELD: ${cmd}`, await held(on, cmd));
}

// Quoted multi-word payloads exist only in shell mode (the flat grammar refuses quotes).
for (const cmd of [
  "git -c 'core.pager=rm -rf /srv' log", "GIT_SSH_COMMAND='rm -rf /srv' git fetch",
  "GIT_SSH_COMMAND='bash -i' git fetch", "git -c 'core.pager=python3 -m http.server' log",
]) {
  check(`SHELL HELD: ${cmd}`, await held(on, cmd));
}

// Clean controls: must stay allowed WITHOUT a hold, on both paths.
for (const cmd of ["git -c user.name=x log", "ls -l", "ls -la /etc", "df -h"]) {
  check(`OFF   clean: ${cmd}`, await clean(off, cmd));
  check(`SHELL clean: ${cmd}`, await clean(on, cmd));
}

// Slash pieces (card 7eea8cd4): a word ending in `/` has an empty basename; its pieces must still be screened.
for (const cmd of ["sed s/a/reboot/ f", "echo x/reboot/", "ls /usr/sbin/reboot/"]) {
  check(`OFF   HELD: ${cmd}`, await held(off, cmd));
  check(`SHELL HELD: ${cmd}`, await held(on, cmd));
}
for (const cmd of ["ls /etc/", "cat /var/log/syslog", "df -h /"]) {
  check(`OFF   clean: ${cmd}`, await clean(off, cmd));
  check(`SHELL clean: ${cmd}`, await clean(on, cmd));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
