import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The opt-in `shellSyntax` grammar of ssh_exec's command policy (card b2229239): argv quoting plus `|` pipelines on a
// read-write connection the owner opted in, every pipeline stage screened on its own, program-executing words HELD.
// Pure (no Db, no wire): evaluateSshCommandPolicy + parseSshShellCommand over connection-shaped objects.
// Every refusal/hold case is paired with a flip control that is NOT refused/held, so a check that can never fire
// cannot pass. Not covered: a real remote shell (this pins the Loom-side verdict only), a non-POSIX remote shell
// (the owner's attestation, never detected).
//
// Run: 1) build (turbo builds shared first), 2) node test/ssh-shell-syntax-policy.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lss-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { evaluateSshCommandPolicy } = await import("../dist/connections/sshPolicy.js");
const { parseSshShellCommand } = await import("../dist/connections/sshShellParse.js");
const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = await import("@loom/shared");

const base = { id: "shell-syntax-conn", readOnly: false, commandAllowlist: [], riskyCommandPatterns: [...DEFAULT_SSH_RISKY_COMMAND_PATTERNS] };
const on = { ...base, shellSyntax: true };
const off = { ...base, shellSyntax: false };
const verdict = (conn, cmd) => evaluateSshCommandPolicy(conn, cmd);
const isRefused = async (cmd, reason = "shell-metacharacters", conn = on) => { const v = await verdict(conn, cmd); return v.allowed === false && v.reason === reason; };
const isHeld = async (cmd, conn = on) => { const v = await verdict(conn, cmd); return v.allowed === true && v.requiresApproval === true; };
const isClean = async (cmd, conn = on) => { const v = await verdict(conn, cmd); return v.allowed === true && v.requiresApproval !== true; };

// ---- the parser itself ------------------------------------------------------------------------------------
{
  const p = parseSshShellCommand("grep 'a b' /etc/hosts | wc -l");
  check("parser: quoted arg is ONE word, pipe splits two segments",
    p.ok && p.segments.length === 2 && JSON.stringify(p.segments[0].words) === JSON.stringify(["grep", "a b", "/etc/hosts"]) && JSON.stringify(p.segments[1].words) === JSON.stringify(["wc", "-l"]));
  check("parser: segment raw text is kept trimmed", p.ok && p.segments[0].raw === "grep 'a b' /etc/hosts" && p.segments[1].raw === "wc -l");
  const glued = parseSshShellCommand("r''m \"-r\"f x");
  check("parser: adjacent quoted/unquoted pieces glue into one word (r''m -> rm, \"-r\"f -> -rf)", glued.ok && JSON.stringify(glued.segments[0].words) === JSON.stringify(["rm", "-rf", "x"]));
  const empty = parseSshShellCommand("echo ''");
  check("parser: an empty quoted pair is an (empty) word", empty.ok && JSON.stringify(empty.segments[0].words) === JSON.stringify(["echo", ""]));
  const lit = parseSshShellCommand("echo 'a|b;c>d&e*f'");
  check("parser: operators inside single quotes are literal word text, not syntax", lit.ok && lit.segments.length === 1 && lit.segments[0].words[1] === "a|b;c>d&e*f");
}

// ---- default OFF and read-only: byte-identical refusal ----------------------------------------------------
for (const cmd of ["ls 'x'", "ls \"x\"", "ls | wc", "ls /tmp | wc -l"]) {
  check(`default OFF (flag absent): ${JSON.stringify(cmd)} refused as shell-metacharacters`, await isRefused(cmd, "shell-metacharacters", base));
  check(`explicit shellSyntax:false: ${JSON.stringify(cmd)} refused`, await isRefused(cmd, "shell-metacharacters", off));
  check(`read-only ignores shellSyntax:true: ${JSON.stringify(cmd)} refused`, await isRefused(cmd, "shell-metacharacters", { ...on, readOnly: true }));
}
check("(flip control) the same pipeline is allowed once the flag is on and read-write", await isClean("ls /tmp | wc -l"));

// ---- shell syntax the grammar does not name stays refused ------------------------------------------------
for (const cmd of [
  "ls; reboot", "true; rm -rf x", "ls && reboot", "ls || reboot", "ls & reboot", "ls &", "ls | | wc", "| ls", "ls |", "ls |&  wc",
  "$(reboot)", "ls $(reboot)", "ls ${HOME}", "ls $HOME", "echo `reboot`", "ls > /tmp/x", "ls >> /tmp/x", "cat < /etc/passwd", "cat <<EOF",
  "(ls)", "{ ls; }", "ls \\ x", "ls *", "/bin/r*", "ls ?", "ls [a]", "ls ~", "ls #c", "ls !x", "ls ^x", "=rm -rf x", "ls | =rm x",
  // quoted forms that would still expand or escape
  "echo \"a$HOME\"", "echo \"a`reboot`\"", "echo 'a$b'", "echo 'a`b`'", "echo 'a\\b'", "echo \"a\\b\"", "echo \"a!b\"",
  // unterminated quotes
  "grep 'a", "grep \"a", "ls | grep 'a",
]) {
  check(`refused: ${JSON.stringify(cmd)}`, await isRefused(cmd));
}
for (const [cmd, reason] of [["ls\nreboot", "control-characters"], ["ls\treboot", "control-characters"], ["ls\rreboot", "control-characters"], ["ls café", "non-ascii-characters"]]) {
  check(`refused before the grammar: ${JSON.stringify(cmd)} -> ${reason}`, await isRefused(cmd, reason));
}
check("refused: an empty / whitespace-only command", (await verdict(on, "   ")).allowed === false);

// ---- quoting and pipes that ARE allowed -------------------------------------------------------------------
for (const cmd of [
  "ls -la /tmp", "ls /tmp | wc -l", "grep 'a b' /etc/hosts | head -5", "cat \"/tmp/x y\"", "ls | sort | uniq -c",
  "ls|wc", "journalctl -u 'nginx' | tail -20", "echo ''",
]) {
  check(`allowed, not held: ${JSON.stringify(cmd)}`, await isClean(cmd));
}

// ---- EVERY pipeline segment goes through the risky matcher -----------------------------------------------
for (const cmd of [
  "reboot", "sudo reboot", "sudo -n reboot", "/sbin/reboot", "/usr/bin/sudo /sbin/reboot", "FOO=1 reboot", "nice reboot", "REBOOT", "Sudo ShutDown now",
  // each pipeline position
  "reboot | cat", "ls | reboot", "ls | wc | reboot", "ls | sudo reboot", "ls | /sbin/reboot", "ls | rm -rf /tmp/x", "ls | sudo rm -rf /tmp/x",
  // quoting hides nothing
  "'rm' -rf /tmp/x", "\"rm\" -rf /tmp/x", "r''m -rf /tmp/x", "\"r\"m -rf /tmp/x", "'/bin/rm' -rf /x", "'sudo' 'reboot'", "ls | 'reboot'", "ls | r''eboot",
  // a risky command inside a quoted payload (the matcher also sees its pieces)
  "foo 'rm -rf /tmp/x'", "foo 'ls; reboot'", "foo \"docker compose down\"",
  // option-skipping still works per segment
  "docker -H tcp://10.0.0.1 compose down | cat", "ls | docker --context default compose down",
]) {
  check(`risky word HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd));
}
check("(flip control) a quoted harmless payload is NOT held", await isClean("foo 'ls -la'"));
check("(flip control) `ls | wc` is not held", await isClean("ls | wc"));
check("(flip control) risky word as a plain data word is still only a screen: `echo hello | wc` clean", await isClean("echo hello | wc"));
check("(flip control) `systemctl status sshd | head` is not held (exempt read-only subcommand)", await isClean("systemctl status sshd | head"));
check("systemctl -o cat stop sshd | head IS held (an option before the subcommand drops the exemption)", await isHeld("systemctl -o cat stop sshd | head"));
check("the exact-rule kind compares the WHOLE text: {exact:'ls | wc'} holds `ls | wc` only",
  (await isHeld("ls | wc", { ...on, riskyCommandPatterns: [{ kind: "exact", pattern: "ls | wc" }] })) && (await isClean("ls | wc -l", { ...on, riskyCommandPatterns: [{ kind: "exact", pattern: "ls | wc" }] })));
check("an owner regex risky rule still holds a piped command", await isHeld("ls | wc", { ...on, riskyCommandPatterns: [{ kind: "regex", pattern: "\\|\\s*wc" }] }));

// ---- wrappers / string executors / a pipe into a shell are HELD even with an empty risky list -------------
const noRisky = { ...on, riskyCommandPatterns: [] };
for (const cmd of [
  "sh -c 'ls'", "bash -c \"ls\"", "/bin/sh -c 'ls'", "zsh -c 'ls'", "dash -c 'ls'", "ksh -c 'ls'", "fish -c 'ls'", "sudo sh -c 'ls'", "env sh -c ls",
  // a pipe into a shell/interpreter executes stdin, even without -c/-e
  "ls | sh", "echo hi | bash", "echo hi | bash -s", "echo hi | /bin/sh", "echo hi | sudo sh", "cat x | zsh", "cat x | python3", "cat x | python", "cat x | python3.12",
  "cat x | perl", "cat x | ruby", "cat x | node", "cat x | php", "cat x | lua", "cat x | awk '{print}'", "cat x | gawk 1",
  // quote-glued interpreter names
  "ls | s'h'", "ls | \"ba\"sh",
  // programs that run another program
  "ls | xargs echo", "xargs rm", "find . -exec ls '{}' +", "find . -execdir ls '{}' +", "find . -ok ls '{}' +", "eval ls", "su -c ls", "watch ls",
  "pct exec 101 -- ls", "docker exec db ls", "docker run alpine ls", "ssh host ls", "nsenter -t 1 ls", "python3 -c 'print(1)'", "perl -e 'print 1'", "node -e 'x'",
]) {
  check(`executor HELD with an empty risky list: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
check("(flip control) with an empty risky list a plain pipeline is NOT held", await isClean("ls | grep 'x y' | wc -l", noRisky));
check("(flip control) `find . -name x` (no -exec) is not held", await isClean("find . -name x", noRisky));
check("(flip control) `grep -r 'shell' /etc | head` is not held (only a WHOLE word `sh` matches)", await isClean("grep -r 'shell' /etc | head", noRisky));
check("(documented over-match) a data word that equals a shell name IS held: `grep sh /etc/passwd`", await isHeld("grep sh /etc/passwd", noRisky));
check("(documented over-match) a quoted data word `ssh` IS held: `journalctl -u 'ssh'`", await isHeld("journalctl -u 'ssh'", noRisky));

// ---- nested evaluators: a de-quoted word may not carry shell syntax; string/stdin evaluators are held ----
// Specimens measured by the round-1 spec review: each was ALLOWED with no hold under the default risky list.
const SPECIMENS = [
  `env -S 'sh -c "r""eboot"'`, `trap 'r""eboot' EXIT`, `trap "r''eboot" EXIT`, `echo 'r""eboot' | . /dev/stdin`,
  `sed -n '1e r""eboot' /etc/fstab`, `echo 'r""m -rf /x' | at now`, `git -c 'alias.x=!r""eboot' x`,
  `GIT_SSH_COMMAND='r""eboot' git fetch`, `tar -I 'r""eboot' -cf a b`, `rsync -e 'r""eboot' a h:b`,
  // round-2 review: quote-free stdin-fed nested evaluators (no word carries syntax; R6/R7/R8 hold them)
  `echo 7265626f6f74 | xxd -r -p | command . /dev/stdin`, `printf %s%s reb oot | builtin . /dev/stdin`,
  `printf %s%s reb oot | time . /dev/stdin`, `echo reboox | sed s/x/t/e`, `printf %s%s reb oot | sed e`,
  `printf %s%s reb oot | sudo -s`, `printf %s%s reb oot | sudo -i`,
  `echo 7265626f6f74 | xxd -r -p | make -f -`, `echo 7265626f6f74 | xxd -r -p | m4`, `echo 7265626f6f74 | xxd -r -p | sqlite3`,
];
for (const cmd of SPECIMENS) {
  check(`nested-evaluator specimen HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...and REFUSED on the OFF path: ${JSON.stringify(cmd)}`, await isRefused(cmd, "shell-metacharacters", off));
}
check("control: echo 'reboot' held", await isHeld("echo 'reboot'"));
check("control: env -S 'sh -c \"reboot\"' held", await isHeld(`env -S 'sh -c "reboot"'`));
check("(flip control) `ls | wc -l` still clean", await isClean("ls | wc -l"));
check("pinned deliberately: `sed -i 's|a|b|' f` is HELD (a de-quoted word carries `|`)", await isHeld("sed -i 's|a|b|' f", noRisky));
check("pinned deliberately: `grep -v '^#' f` is HELD", await isHeld("grep -v '^#' f", noRisky));
check("(flip control) a quoted word with only plain text and spaces is NOT held: `grep 'a b' f`", await isClean("grep 'a b' f", noRisky));
// rule 1 alone (no executor, no risky list): the carrier word is the whole reason
for (const cmd of ["echo 'a;b'", "echo 'a>b'", "echo 'a*b'", "echo 'a(b'", "echo 'a~b'"]) {
  check(`syntax-carrying de-quoted word HELD with an empty risky list: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
// executor check over the PIECES of a quoted word (no syntax char, no risky word: only the pieces reveal the shell)
for (const cmd of ["foo 'sh x'", "foo 'bash -s'", "foo 'python3 y'", "foo 'xargs ls'", "foo 'find . -exec ls'", "foo 'trap x'"]) {
  check(`executor named INSIDE a quoted word HELD with an empty risky list: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
check("(flip control) a quoted word of plain data pieces is NOT held: `foo 'ls x'`", await isClean("foo 'ls x'", noRisky));
// rule 2: string/stdin evaluators, with an empty risky list
for (const cmd of [". /dev/stdin", "ls | . /x", "FOO=1 . x", "source x", "at now", "ls | batch", "crontab -l", "crontab x", "trap x EXIT",
  "env -S x", "env --split-string=x", "env --split-string x", "env -iS x", "env --split x", "sudo env -S x"]) {
  check(`evaluator HELD with an empty risky list: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
check("(flip control) a `.` as an ARGUMENT is not an evaluator: `ls .` clean", await isClean("ls .", noRisky));
check("(flip control) `env FOO=1 ls` clean", await isClean("env FOO=1 ls", noRisky));
check("(flip control) `env -i ls` clean", await isClean("env -i ls", noRisky));
// rule 3: exact risky rule against the de-quoted words
const exactRisky = { ...on, riskyCommandPatterns: [{ kind: "exact", pattern: "systemctl restart nginx" }] };
check("exact risky rule matches the de-quoted words: `systemctl restart 'nginx'` held", await isHeld("systemctl restart 'nginx'", exactRisky));
check("exact risky rule matches the de-quoted words per segment: `ls | systemctl \"restart\" nginx` held", await isHeld("ls | systemctl \"restart\" nginx", exactRisky));
check("(flip control) exact rule: `systemctl restart apache` clean", await isClean("systemctl restart apache", exactRisky));
check("exact risky rule on the OFF path unchanged: `systemctl restart 'nginx'` is refused", await isRefused("systemctl restart 'nginx'", "shell-metacharacters", { ...off, riskyCommandPatterns: exactRisky.riskyCommandPatterns }));

// ---- round 3: R6 pipeline-stage filter allowlist, R7 command-position wrappers, R8 sed, R9 one constant ----
// Each held case is run with an EMPTY risky list so only the rule under test can hold it.
for (const cmd of ["ls | xxd -r -p", "ls | make -f -", "ls | m4", "ls | sqlite3", "ls | tee x", "ls | jq .", "ls | less", "ls | awk 1", "ls | sed -n 1p",
  "ls | /usr/bin/xxd -r", "ls | nice wc", "ls | FOO=1 wc", "ls | wc | foo", "ls | ./deploy"]) {
  check(`R6: a non-filter stage after the first is HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
for (const cmd of ["ls | wc -l", "ps aux | grep x | head", "df -h | sort", "ls | head -5 | tail -1", "ls | cut -d: -f1 | tr a b | uniq", "ls | egrep x | fgrep y | cat | nl | column -t", "ls | /usr/bin/wc -l", "xxd -r -p"]) {
  check(`R6 flip control: filter stages stay clean: ${JSON.stringify(cmd)}`, await isClean(cmd, noRisky));
}
for (const cmd of ["sort --compress-program=sh x", "sort --compress-program sh x", "sort --compress=sh x", "sort --co=sh x", "df | sort --compress-program=sh", "ls | sort -u --compress-program=rm", "nice sort --compress-program=sh x"]) {
  check(`R6: sort --compress-program (any spelling) HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
check("R6 flip control: `sort -u -k 2 x` clean", await isClean("sort -u -k 2 x", noRisky));
for (const cmd of ["command . x", "builtin . x", "time . x", "time -p . x", "nohup . x", "nice . x", "nice -n 5 . x", "nice -5 . x", "stdbuf -oL . x", "timeout 5 . x", "timeout -s KILL 5 . x",
  "ionice -c 2 . x", "sudo . x", "sudo -u root . x", "FOO=1 command . x", "nice time command . x", "doas . x"]) {
  check(`R7: wrapper-prefixed \`.\` HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
for (const cmd of ["sudo -s", "sudo -i", "sudo -is", "sudo -u root -i", "sudo --shell", "sudo --login", "sudo -e x", "doas -s", "nice -n 5 sudo -s", "time -f x ls", "nice --bogus ls", "timeout --bogus 5 ls", "sudo --bogus ls"]) {
  check(`R7: sudo/doas shell option or unparsable wrapper option HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
for (const cmd of ["nice -n 5 ls", "nice ls", "time -p ls", "command ls", "timeout 5 ls", "timeout -s KILL 5 ls", "stdbuf -oL ls", "ionice -c 2 ls", "sudo -n ls", "sudo -u root ls", "sudo FOO=1 ls", "nohup ls", "command -v ls"]) {
  check(`R7 flip control: a plain wrapped command stays clean: ${JSON.stringify(cmd)}`, await isClean(cmd, noRisky));
}
for (const cmd of ["sed s/x/t/e f", "sed e f", "sed -e p f", "sed -i s/a/b/ f", "sed -n 1e f", "sed s/a/b/w f", "sudo sed e f", "sed --expression=p f", "sed", "sed -f x f", "sed 's/a b/c/e' f"]) {
  check(`R8: sed program that is not the plain form HELD: ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
}
for (const cmd of ["sed s/a/b/ f", "sed s/a/b/g f", "sed -n 5p f", "sed -n 5,9p f", "sed -E s/a/b/gi f", "sed 's/a b/c d/g' f"]) {
  check(`R8 flip control: a plain sed stays clean: ${JSON.stringify(cmd)}`, await isClean(cmd, noRisky));
}
// OFF path byte-identical: the pipe forms stay refused as syntax; the pipe-free forms are untouched by R6-R8
// (these rules are shell-mode only), so they keep their pre-round-3 verdict: allowed, not held, empty risky list.
const offNoRisky = { ...off, riskyCommandPatterns: [] };
for (const cmd of ["ls | xxd -r", "ls | sed e", "ls | sudo -s", "ls | command . /dev/stdin"]) {
  check(`round-3 OFF path: ${JSON.stringify(cmd)} still refused as shell-metacharacters`, await isRefused(cmd, "shell-metacharacters", offNoRisky));
}
for (const cmd of ["command . x", "sudo -s", "sed e f", "sort --compress-program=sh x"]) {
  check(`round-3 OFF path: pipe-free ${JSON.stringify(cmd)} keeps its unchanged verdict (allowed, not held)`, await isClean(cmd, offNoRisky));
}

// ---- round 4: R11 sort/uniq output sinks, R12 sed options at every position, R13 filter path ---------------
// Every specimen is run with the DEFAULT risky list too (the review's critical cases were clean under it).
// OFF-refuse pairs exist only for the piped specimens: the pipe-free ones (`setsid sort …`, `sort -uo x`) are
// ALLOWED, not held, on the OFF path today, which is asserted as the unchanged verdict instead.
const R11_SORT = [
  `printf '%s%s' '0-59 0-23 1-31 1-12 0-7 root reb' oot | sort --output=/etc/cron.d/x`,
  `printf '%s%s' '0-59 0-23 1-31 1-12 0-7 root reb' oot | sort -o /etc/cron.d/x`,
  `printf %s%s reb oot | sort -o /root/.bashrc`,
  `printf %s%s reb oot | sort -uo x`,
  `printf %s%s reb oot | sort -u -o x`,
  `printf %s%s reb oot | sort --o=x`,
  `printf %s%s reb oot | sort --files0-from=x`,
  `printf %s%s reb oot | sort --compress-program=sh`,
];
const R11_UNIQ = [
  `printf '%s%s' '0-59 0-23 1-31 1-12 0-7 root reb' oot | uniq - /etc/cron.d/x`,
  `printf %s%s reb oot | uniq - x`,
  `printf %s%s reb oot | uniq x y`,
  `printf %s%s reb oot | uniq -c x`,
  `printf %s%s reb oot | uniq -f 1 - x`,
];
const R12_SED = [
  `sed s/x/x/ -e s/a/reboot/ -e e /etc/hostname`, `sed s/x/y/ -e 1ereboot f`, `sed s/x/y/ --expression=1ereboot f`,
  `sed -n 1p -e 1ereboot f`, `sed s/x/y/ f -i`, `sed s/x/y/ -f s`,
  `printf %s%s reb oot | sed s/x/y/ -e e`,
];
const R13_PATH = [`ls | /tmp/x/cat`, `ls | ./wc`, `ls | /usr/bin/../../tmp/x/wc`, `ls | /opt/bin/wc -l`];
for (const cmd of [...R11_SORT, ...R11_UNIQ, ...R12_SED.filter((c) => c.includes("|")), ...R13_PATH]) {
  check(`R11-R13 specimen HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...held by the rule itself (empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...and REFUSED on the OFF path: ${JSON.stringify(cmd)}`, await isRefused(cmd, "shell-metacharacters", off));
}
for (const cmd of ["setsid sort --compress-program=m4 f", "sort -uo x", "sort -o x f", "setsid sort -o /etc/cron.d/x f", "uniq - x", "uniq x y",
  ...R12_SED.filter((c) => !c.includes("|"))]) {
  check(`R11/R12 pipe-free specimen HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...held by the rule itself (empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...and its OFF verdict is the unchanged pre-round-4 one (allowed, not held): ${JSON.stringify(cmd)}`, await isClean(cmd, offNoRisky));
}
for (const cmd of ["ls | wc -l", "ps aux | grep x | head", "df -h | sort", "ls | uniq -c", "ls | /usr/bin/wc -l", "ls | sort | uniq -c", "ls | sort -u -k 2",
  "ls | sort -rn | head", "ls | sort -t: -k2", "ls | uniq -d", "ls | uniq -c -f 1", "ls | uniq -cs 3", "ls | uniq -w2", "sort -u f", "uniq", "ls | uniq -i",
  "ls | /bin/cat", "ls | /usr/local/bin/wc", "ls | /sbin/cat", "ls | /usr/sbin/cat", "ls | /usr/local/sbin/cat",
  "sed s/a/b/ f", "sed -n 5,9p f g", "sed -- s/a/b/ f", "sed -n -E s/a/b/g f", "sed s/a/b/ f -n", "sed -n s/a/b/ f -s"]) {
  check(`round-4 flip control stays clean: ${JSON.stringify(cmd)}`, await isClean(cmd));
}

// ---- round 5: R15 sort positive option allowlist, R16 case-sensitive filter names, R17 gsed/ssed ---------
const R15_SORT = [
  `yes '0-59 0-23 1-31 1-12 0-7 root rebXoot' | tr -d X | sort -S 1K -T /etc/cron.d`,
  `ls | sort -T /etc/cron.d`, `ls | sort --temporary-directory=/etc/cron.d`, `ls | sort --tem=/etc/cron.d`,
  `ls | sort --temporary-directory /etc/cron.d`, `ls | sort -S 1K`, `ls | sort -m`, `ls | sort -c`, `ls | sort -C`, `ls | sort -R`,
  `ls | sort --random-source=x`, `ls | sort --parallel=2`, `ls | sort --batch-size=2`, `ls | sort --rev`, `ls | sort --key 2`,
  `ls | sort -k`, `ls | sort -to`, `ls | sort -rT /etc/cron.d`, `ls | sort -nrS1K`,
];
const R15_SORT_PIPEFREE = [`setsid sort -T /etc/cron.d f`, `sort -S 1K -T /etc/cron.d f`, `nice sort --tem=/etc/cron.d f`];
for (const cmd of R15_SORT) {
  check(`R15 sort specimen HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...held by the rule itself (empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...and REFUSED on the OFF path: ${JSON.stringify(cmd)}`, await isRefused(cmd, "shell-metacharacters", off));
}
for (const cmd of R15_SORT_PIPEFREE) {
  check(`R15 pipe-free sort specimen HELD (shell mode, empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...its OFF verdict is the unchanged one (allowed, not held): ${JSON.stringify(cmd)}`, await isClean(cmd, offNoRisky));
}
const R16_CASE = [`ls | CAT`, `ls | /usr/bin/WC`, `ls | Wc -l`, `ls | SORT`, `ls | /bin/Cat`];
for (const cmd of R16_CASE) {
  check(`R16 case-mismatched filter name HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...held by the rule itself (empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...and REFUSED on the OFF path: ${JSON.stringify(cmd)}`, await isRefused(cmd, "shell-metacharacters", off));
}
const R17_SED = [`gsed 1ereboot f`, `ssed 1ereboot f`, `gsed e f`, `ssed -e p f`, `gsed s/x/y/ -e 1ereboot f`, `ssed s/x/y/ -i f`, `GSED e f`, `/usr/bin/gsed s/a/b/w f`,
  `sudo gsed e f`, `printf %s%s reb oot | gsed e`];
for (const cmd of R17_SED.filter((c) => !c.includes("|"))) {
  check(`R17 gsed/ssed specimen HELD (shell mode, default list): ${JSON.stringify(cmd)}`, await isHeld(cmd));
  check(`  ...held by the rule itself (empty risky list): ${JSON.stringify(cmd)}`, await isHeld(cmd, noRisky));
  check(`  ...its OFF verdict is the unchanged one (allowed, not held): ${JSON.stringify(cmd)}`, await isClean(cmd, offNoRisky));
}
check("R17 specimen piped into gsed: HELD", await isHeld(`printf %s%s reb oot | gsed e`, noRisky));
check("R17 piped specimen REFUSED on the OFF path", await isRefused(`printf %s%s reb oot | gsed e`, "shell-metacharacters", off));
for (const cmd of ["df -h | sort", "ls | sort -rn", "ps aux | sort -k 3 -t:", "ls | sort -t: -k2", "ls | sort -k2,2n", "ls | sort -t : -k 2", "ls | sort -rnu", "ls | sort --reverse --numeric-sort",
  "ls | sort --key=2 --field-separator=:", "ls | sort -u -- f", "ls | sort -bdfghiMnrsuVz", "ls | sort -r -", "ls | sort -r -- x -T y","ls | sort -s -k1,1", "ls | /usr/bin/sort -r", "ls | cat", "ls | /usr/bin/wc -l",
  "gsed s/a/b/ f", "ssed -n 5p f", "ls | sort --zero-terminated --unique --stable --month-sort"]) {
  check(`round-5 flip control stays clean: ${JSON.stringify(cmd)}`, await isClean(cmd, noRisky));
}

// ---- allowlist interplay: owner approval/allowlist is never widened by a pipe ----------------------------
const allowLs = { ...on, commandAllowlist: [{ kind: "prefix", pattern: "ls" }] };
check("allowlist prefix: a single allowed command passes", await isClean("ls /tmp", allowLs));
check("allowlist prefix: `ls /a | ls /b` passes the allowlist (every segment matches) but is HELD (`ls` is not a pipeline filter)", await isHeld("ls /a | ls /b", allowLs));
check("allowlist prefix: `ls /tmp | wc -l` is refused (segment 2 not allowed), never smuggled behind segment 1", await isRefused("ls /tmp | wc -l", "not-in-allowlist", allowLs));
check("allowlist prefix: `ls /tmp | sh` is refused as not-in-allowlist (a hold never widens an allowlist)", await isRefused("ls /tmp | sh", "not-in-allowlist", allowLs));
const allowRe = { ...on, commandAllowlist: [{ kind: "regex", pattern: "^ls.*" }] };
check("allowlist regex: a single-segment command matches", await isClean("ls /tmp", allowRe));
check("allowlist regex: `.*` does not swallow a piped tail: `ls /tmp | wc -l` refused", await isRefused("ls /tmp | wc -l", "not-in-allowlist", allowRe));
const allowExact = { ...on, commandAllowlist: [{ kind: "exact", pattern: "ls /tmp | wc -l" }] };
check("allowlist exact: the owner's own whole-pipeline text passes", await isClean("ls /tmp | wc -l", allowExact));
check("allowlist exact: any other text refused", await isRefused("ls /tmp | wc -l | cat", "not-in-allowlist", allowExact));

// ---- the read-only verb list is untouched ----------------------------------------------------------------
const ro = { ...base, readOnly: true };
check("read-only: `ls /tmp` still allowed and clean", await isClean("ls /tmp", ro));
check("read-only: a non-read verb still refused as not-read-only-verb", await isRefused("touch x", "not-read-only-verb", ro));
check("read-only + shellSyntax:true: quotes/pipes still refused (flag is inert on read-only)", await isRefused("grep 'x' /etc/hosts | head", "shell-metacharacters", { ...ro, shellSyntax: true }));

console.log(failures === 0 ? "\nALL PASS — the opt-in shell grammar screens every pipeline segment, holds executors and pipes into shells, and keeps everything else refused." : `\n${failures} FAILURE(S).`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
