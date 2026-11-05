import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The ssh_exec risky-pattern WORD SCREEN (design record a3d5c7f4) — a word screen deciding when to ASK the owner,
// NOT a security boundary. Pure (no Db, no wire): evaluateSshCommandPolicy over a connection-shaped object.
// One case per bypass named in the triage notes: words anywhere (after sudo / absolute paths / env prefixes),
// multi-word rules that skip interposed option words, case-insensitive command words, the porous docker list,
// and `systemctl status` staying unflagged. Each positive case is paired with a flip control that is NOT held.
//
// Run: 1) build (turbo builds shared first), 2) node test/ssh-risky-matcher.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lsm-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { evaluateSshCommandPolicy } = await import("../dist/connections/sshPolicy.js");
const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = await import("@loom/shared");

const rw = { id: "risky-matcher-conn", readOnly: false, commandAllowlist: [], riskyCommandPatterns: [...DEFAULT_SSH_RISKY_COMMAND_PATTERNS] };
const ro = { ...rw, readOnly: true };
const verdict = (conn, cmd) => evaluateSshCommandPolicy(conn, cmd);
const isHeld = async (cmd, conn = rw) => { const v = await verdict(conn, cmd); return v.allowed === true && v.requiresApproval === true; };
const isClean = async (cmd, conn = rw) => { const v = await verdict(conn, cmd); return v.allowed === true && v.requiresApproval !== true; };

// ---- words anywhere: after sudo / absolute paths / env prefixes / wrappers --------------------------------
for (const cmd of ["reboot", "sudo reboot", "sudo -n reboot", "/sbin/reboot", "/usr/bin/sudo /sbin/reboot", "FOO=1 reboot", "nice reboot", "rm -rf /tmp/x", "sudo rm -rf /tmp/x", "/bin/rm -rf /tmp/x", "shutdown -h now", "sudo poweroff"]) {
  check(`words anywhere: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}
check("(flip control) a harmless command is not held", await isClean("ls /tmp"));

// ---- the shell-syntax bypass shapes from the triage note are REFUSED before any rule runs ------------------
for (const [cmd, reason] of [["true; rm -rf x", "shell-metacharacters"], ["true && reboot", "shell-metacharacters"], ["ls | reboot", "shell-metacharacters"], ["rm\t-rf x", "control-characters"], ["rm\\t-rf x", "shell-metacharacters"], ["$(reboot)", "shell-metacharacters"]]) {
  const v = await verdict(rw, cmd);
  check(`bypass shape ${JSON.stringify(cmd)} is refused as ${reason}, never allowed`, v.allowed === false && v.reason === reason);
}

// ---- case-insensitive command words ------------------------------------------------------------------------
for (const cmd of ["REBOOT", "Reboot", "/SBIN/REBOOT", "sudo ShutDown now", "RM -RF /tmp/x", "DOCKER COMPOSE DOWN", "Docker Compose Down"]) {
  check(`case-insensitive: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}
check("case-insensitive exact rule: {exact:'RM -RF /'} matches `rm -rf /`", await isHeld("rm -rf /", { ...rw, riskyCommandPatterns: [{ kind: "exact", pattern: "RM -RF /" }] }));
check("(limit, pinned) an owner REGEX rule keeps its own flags: /^reboot$/ does not match REBOOT", await isClean("REBOOT", { ...rw, riskyCommandPatterns: [{ kind: "regex", pattern: "^reboot$" }] }));

// ---- multi-word rules skip interposed option words (and a possible value), failing closed -----------------
for (const cmd of [
  "docker compose down", "docker -l info compose down", "docker --context default compose down", "docker -l info system prune -af",
  "docker --log-level info compose down", "docker -H tcp://10.0.0.1 compose down", "docker --host=tcp://10.0.0.1 compose down",
  "docker -D compose up", "docker -c a -l b compose down", "docker compose -f x.yml down", "docker compose --project-name p down",
]) {
  check(`option-skip: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}
check("(flip control) a bare non-option word between rule words is NOT skipped: `docker ps compose down` is not held", await isClean("docker ps compose down"));
check("(flip control) `docker ps -a` is not held", await isClean("docker ps -a"));
check("(flip control) `docker compose ps` is not held", await isClean("docker compose ps"));

// ---- the docker list is no longer porous ------------------------------------------------------------------
for (const cmd of [
  "docker stop web", "docker restart web", "docker pause web", "docker rm web", "docker kill web", "docker exec db ls", "docker run alpine",
  "docker volume rm v1", "docker volume prune", "docker network rm n1", "docker image rm img", "docker container rm c1", "docker container prune",
  "docker compose stop", "docker compose restart", "docker compose rm", "docker compose kill", "docker compose up", "docker system prune",
  "docker -l info stop db", "docker -H x volume rm v1",
]) {
  check(`docker list: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}
for (const cmd of ["docker ps", "docker images", "docker logs web", "docker inspect web", "docker compose ps", "docker compose logs"]) {
  check(`docker list (flip control): ${JSON.stringify(cmd)} is not held`, await isClean(cmd));
}

// ---- the sub-subcommand / v1 / halt-class additions (review round 1) ----------------------------------------
for (const cmd of [
  "docker container stop web", "docker container restart web", "docker container kill web", "docker container rm web", "docker container exec web ls",
  "docker compose run web sh", "docker compose exec web sh", "docker image prune", "docker -H x container stop web",
  "docker-compose down", "docker-compose stop", "docker-compose rm", "docker-compose kill", "docker-compose run web sh", "docker-compose exec web sh",
  "/usr/local/bin/docker-compose down", "docker-compose -f x.yml down",
  "halt", "sudo halt", "init 0", "telinit 0", "killall nginx", "crontab -r", "sudo crontab -r",
]) {
  check(`added list: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}
for (const cmd of ["docker container ls", "docker image ls", "docker-compose ps", "docker-compose logs", "crontab -l", "init 3", "telinit 3"]) {
  check(`added list (flip control): ${JSON.stringify(cmd)} is not held`, await isClean(cmd));
}

// ---- systemctl: read-only subcommands IMMEDIATELY after systemctl are not flagged; everything else is ---------
for (const cmd of ["systemctl status nginx", "systemctl is-active nginx", "systemctl is-enabled nginx", "/usr/bin/systemctl status nginx", "sudo systemctl status nginx"]) {
  check(`systemctl read-only: ${JSON.stringify(cmd)} is NOT held`, await isClean(cmd));
}
for (const cmd of ["systemctl restart nginx", "systemctl stop nginx", "systemctl -o cat stop sshd", "systemctl -p status disable sshd", "systemctl --user status nginx", "systemctl --force reboot", "SYSTEMCTL RESTART nginx", "sudo systemctl restart nginx"]) {
  check(`systemctl mutating/option-shifted: ${JSON.stringify(cmd)} is HELD`, await isHeld(cmd));
}

// ---- risky never widens read-only or an allowlist: those refusals come FIRST ---------------------------------
const roV = await verdict(ro, "systemctl restart nginx");
check("read-only connection: a risky command is refused not-read-only-verb (no hold)", roV.allowed === false && roV.reason === "not-read-only-verb");
const alV = await verdict({ ...rw, commandAllowlist: [{ kind: "prefix", pattern: "ls" }] }, "reboot");
check("allowlisted connection: a risky command outside the allowlist is refused not-in-allowlist (no hold)", alV.allowed === false && alV.reason === "not-in-allowlist");

// ---- the option-skip search is polynomial: a worst-case agent command cannot stall the event loop -------------
{
  const many = "docker" + " -a".repeat(1000) + " x";
  const t0 = performance.now();
  const miss = await isClean(many);
  const hit = await isHeld("docker" + " -a".repeat(1000) + " compose down");
  const ms = performance.now() - t0;
  check(`pathological option run (1000 options): correct on both sides (miss=${miss}, hit=${hit}) in ${ms.toFixed(0)}ms (< 1500)`, miss && hit && ms < 1500);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
