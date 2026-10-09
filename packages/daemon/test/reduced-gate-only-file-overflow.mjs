// Card 92be634e: buildReducedGateCommand's `--only=<names>` step has no length bound, and every gate step
// is spawned via `shell:true` (gate-runner.ts) — on win32 that's cmd.exe, whose command-line ceiling is
// ~8191 chars (the same hazard card cee17efe already fixed for the dist-importer check's own `--only=`
// selection). This file proves:
//   (A) below REDUCED_GATE_ONLY_INLINE_MAX_CHARS, buildReducedGateCommand is byte-identical to before this
//       card — no FS access at all, `opts` fully optional.
//   (B) above the threshold with an injected writer, the step switches to `--only-file=<path>` and the
//       writer is called with exactly the right path and newline-joined content — no real FS touched.
//   (C) above the threshold with NO onlyFilePath supplied, it throws ReducedGateOnlyFileError rather than
//       picking an implicit os.tmpdir() path.
//   (D) above the threshold with a THROWING writer, the thrown error is wrapped in a ReducedGateOnlyFileError
//       naming the real cause — never swallowed into a silent fallback to the over-length inline form.
//   (E) the BOUNDARY: a names list rendering to just at-or-under the threshold stays inline; one char more
//       crosses it.
//   (F) REAL-SPAWN, no injected writer: the real default writer actually writes a real file, and the
//       resulting `--only-file=<path>` step is spawned through a real shell (mirroring gate-runner.ts) and
//       reaches scripts/test-daemon.mjs's own in-process argument handling — never an OS/shell-layer
//       command-line failure. Mirrors test-daemon-only-file-real-spawn.mjs's own technique.
//   (G) gateOnlyListPath's `.only.txt` convention is invisible to pruneGateSpills/listGateSpillOpIds (both
//       filter strictly on `.endsWith(".log")`) — a sibling `.log` file in the SAME directory is still
//       correctly counted/pruned, proving the `.only.txt` file isn't accidentally excluding it either.
// LEAD round-2 rulings (2, 5) — the two the first round of this file didn't yet cover:
//   (H) ruling 2: writeReducedGateOnlyFileReal mkdir's its own parent recursively — a fresh LOOM_HOME's
//       GATE_SPILL_DIR (and any deeper missing segment) never pre-exists, so the first overflow write must
//       not ENOENT.
//   (I) ruling 5: sweepStaleGateOnlyFiles (the boot-time backstop) removes every `*.only.txt` unconditionally
//       while leaving a sibling `.log` spill untouched, is idempotent on a second sweep, and never throws
//       against a missing directory.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const {
  buildReducedGateCommand, ReducedGateOnlyFileError, REDUCED_GATE_ONLY_INLINE_MAX_CHARS, writeReducedGateOnlyFileReal,
} = await import("../dist/git/worktrees.js");
const { gateOnlyListPath, GATE_SPILL_DIR, pruneGateSpills, listGateSpillOpIds } = await import("../dist/orchestration/gate-spill.js");

const EMPTY_INPUT = { changedAssetPaths: [], changedTsPaths: [], changedScriptFiles: [] };
const namesInput = (n, prefix = "reduced-gate-only-file-overflow-padding") =>
  ({ ...EMPTY_INPUT, changedTestFiles: Array.from({ length: n }, (_, i) => `packages/daemon/test/${prefix}-${i}.mjs`) });

const run = async () => {
  // ── (A) below the threshold: byte-identical to before this card, no opts, no FS ──────────────────────
  {
    const cmd = buildReducedGateCommand({ ...EMPTY_INPUT, changedTestFiles: ["packages/daemon/test/dev-server.mjs"] });
    check("(A) a small list stays inline, --only= form", cmd.includes("pnpm --filter @loom/daemon test:daemon --only=dev-server"));
    check("(A) no --only-file= anywhere", !cmd.includes("--only-file="));
  }

  // ── (B) above the threshold, injected writer: no real FS, writer called with the right args ──────────
  {
    const input = namesInput(400);
    const inlineLen = `pnpm --filter @loom/daemon test:daemon --only=${input.changedTestFiles.map((p) => p.slice("packages/daemon/test/".length, -".mjs".length)).join(",")}`.length;
    check("(B) setup: this list's inline form genuinely exceeds the threshold", inlineLen > REDUCED_GATE_ONLY_INLINE_MAX_CHARS);
    let written;
    const cmd = buildReducedGateCommand(input, {
      onlyFilePath: "C:\\fake\\only-file.txt",
      writeOnlyFile: (p, content) => { written = { path: p, content }; },
    });
    check("(B) switches to --only-file=, never --only=", cmd.includes("--only-file=") && !/--only=[^-]/.test(cmd));
    check("(B) the injected writer was actually called", written !== undefined);
    check("(B) writer received the exact onlyFilePath", written?.path === "C:\\fake\\only-file.txt");
    check("(B) writer received newline-joined bare names (not comma-joined, not full paths)",
      written?.content === input.changedTestFiles.map((p) => p.slice("packages/daemon/test/".length, -".mjs".length)).join("\n"));
    check("(B) the command embeds the path via JSON.stringify (quoted, survives a space)",
      cmd.includes(JSON.stringify("C:\\fake\\only-file.txt")));
    check("(B) build + guards still run unconditionally", cmd.includes("pnpm build"));
  }

  // ── (C) above the threshold, no onlyFilePath: throws rather than an implicit tmp path ────────────────
  {
    let threw;
    try {
      buildReducedGateCommand(namesInput(400));
    } catch (err) {
      threw = err;
    }
    check("(C) throws ReducedGateOnlyFileError", threw instanceof ReducedGateOnlyFileError);
    check("(C) message names the missing-path cause, not a write failure", /no onlyFilePath was supplied/.test(threw?.message ?? ""));
  }
  {
    // Same, but writeOnlyFile alone (no onlyFilePath) — the path requirement is checked BEFORE any writer runs.
    let threw;
    let writerCalled = false;
    try {
      buildReducedGateCommand(namesInput(400), { writeOnlyFile: () => { writerCalled = true; } });
    } catch (err) {
      threw = err;
    }
    check("(C2) onlyFilePath is required even when a writer is supplied", threw instanceof ReducedGateOnlyFileError);
    check("(C2) the writer is never invoked when there's no path to give it", !writerCalled);
  }

  // ── (D) above the threshold, a THROWING writer: wrapped, never swallowed into the inline fallback ────
  {
    let threw;
    const cmd = (() => {
      try {
        return buildReducedGateCommand(namesInput(400), {
          onlyFilePath: "C:\\fake\\only-file.txt",
          writeOnlyFile: () => { throw new Error("ENOSPC: no space left on device"); },
        });
      } catch (err) {
        threw = err;
        return undefined;
      }
    })();
    check("(D) throws ReducedGateOnlyFileError (not the raw injected error, not swallowed)", threw instanceof ReducedGateOnlyFileError);
    check("(D) the real cause (ENOSPC) is named in the message", /ENOSPC: no space left on device/.test(threw?.message ?? ""));
    check("(D) never silently returns a command at all", cmd === undefined);
  }

  // ── (E) THE BOUNDARY: just at/under the threshold stays inline; one char more crosses it ─────────────
  {
    // Build a single-name list whose INLINE step string is exactly REDUCED_GATE_ONLY_INLINE_MAX_CHARS long,
    // then one char longer, via a name padded to hit an exact target length.
    const prefix = "pnpm --filter @loom/daemon test:daemon --only=";
    const targetName = (totalLen) => "x".repeat(Math.max(1, totalLen - prefix.length));
    const atThreshold = { ...EMPTY_INPUT, changedTestFiles: [`packages/daemon/test/${targetName(REDUCED_GATE_ONLY_INLINE_MAX_CHARS)}.mjs`] };
    const overThreshold = { ...EMPTY_INPUT, changedTestFiles: [`packages/daemon/test/${targetName(REDUCED_GATE_ONLY_INLINE_MAX_CHARS + 1)}.mjs`] };
    const atCmd = buildReducedGateCommand(atThreshold);
    check("(E) exactly AT the threshold stays inline (not >, strictly greater-than crosses it)", atCmd.includes("--only=") && !atCmd.includes("--only-file="));
    let overThrew;
    try {
      buildReducedGateCommand(overThreshold);
    } catch (err) {
      overThrew = err;
    }
    check("(E) one char OVER the threshold crosses it (throws for lack of onlyFilePath, proving it tried the file path)", overThrew instanceof ReducedGateOnlyFileError);
    let overWritten;
    const overCmd = buildReducedGateCommand(overThreshold, { onlyFilePath: "C:\\fake\\over.txt", writeOnlyFile: (p, c) => { overWritten = { p, c }; } });
    check("(E) one char over, WITH a path, switches to --only-file=", overCmd.includes("--only-file="));
    check("(E) one char over actually invoked the writer", overWritten !== undefined);
  }

  // ── (F) REAL-SPAWN: the real default writer + a real shell, mirroring gate-runner.ts ──────────────────
  {
    const testFileDir = path.dirname(fileURLToPath(import.meta.url));
    const daemonPkgDir = path.join(testFileDir, "..");
    const repoRoot = path.join(daemonPkgDir, "..", "..");
    const tmpDir = mkdtempManaged("loom-test-92be634e-reduced-gate-only-");
    const onlyFilePath = path.join(tmpDir, "reduced gate only file.txt"); // a literal space — survives cmd.exe quoting (mirrors R3-7 in test-daemon-only-file-real-spawn.mjs)

    // A deliberately bogus (never-discovered) but plausible-shaped name list, large enough to cross the
    // threshold by a wide margin — the point is command-line LENGTH, not selecting a real test.
    const input = namesInput(400, "92be634e-padding-name");
    const cmd = buildReducedGateCommand(input, { onlyFilePath }); // no writer injected: exercises writeReducedGateOnlyFileReal for real
    check("(F) the real default writer actually created the file", fs.existsSync(onlyFilePath));
    const writtenNames = fs.readFileSync(onlyFilePath, "utf8").split("\n").filter(Boolean);
    check("(F) the file holds every bare name, newline-separated", writtenNames.length === input.changedTestFiles.length && writtenNames[0] === "92be634e-padding-name-0");

    const lastStep = cmd.split(" && ").pop();
    check("(F) the last step is the --only-file= test:daemon step", lastStep.includes("test:daemon --only-file="));

    const result = await new Promise((resolve) => {
      let out = "";
      let errOut = "";
      let child;
      try {
        // Mirrors gate-runner.ts's own real gate-step spawn EXACTLY (shell:true, cwd at repo root — a
        // reduced gate's steps run with cwd=worktreePath, which for this test IS the repo root).
        child = spawn(lastStep, { cwd: repoRoot, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ spawnThrew: true, code: null, out: "", err: String(err) });
        return;
      }
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { errOut += d; });
      child.on("close", (code) => resolve({ spawnThrew: false, code, out, err: errOut }));
    });
    check(
      "(F) the real step spawns cleanly through a real shell and reaches test-daemon.mjs's own in-process argument handling (never an OS/shell-layer command-line failure)",
      !result.spawnThrew && (result.out.includes("test-daemon.mjs") || result.err.includes("test-daemon.mjs")),
    );
    check(
      "(F) that in-process handling correctly refuses the bogus (never-discovered) padding names, by name",
      result.code === 1 && /--only names \d+ file\(s\) not in the discovered hermetic set/.test(result.err) && result.err.includes("92be634e-padding-name-0"),
    );
  }

  // ── (G) .only.txt is invisible to the .log-only spill sweep — positive AND negative in one directory ──
  {
    const dir = mkdtempManaged("loom-test-92be634e-spill-interaction-");
    fs.mkdirSync(dir, { recursive: true });
    const onlyPath = path.join(dir, "fake-op-id.only.txt");
    fs.writeFileSync(onlyPath, "some-test\n", "utf8");
    // A real sibling .log file, same directory, so pruning has something real to count/trim.
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `clean-op-${i}.log`), "x", "utf8");
    const opIdsBefore = listGateSpillOpIds(dir);
    check("(G) listGateSpillOpIds never returns the .only.txt file's stem", !opIdsBefore.includes("fake-op-id"));
    check("(G) listGateSpillOpIds still returns the 5 real .log files", opIdsBefore.length === 5);
    pruneGateSpills(dir, 3); // keep=3, so 2 of the 5 .log files are pruned
    check("(G) the .only.txt file survives the prune untouched", fs.existsSync(onlyPath));
    check("(G) the .only.txt file's content is untouched", fs.readFileSync(onlyPath, "utf8") === "some-test\n");
    const remaining = fs.readdirSync(dir);
    check("(G) the .log pool was still correctly trimmed to its own cap DESPITE the .only.txt file sharing the directory",
      remaining.filter((n) => n.endsWith(".log")).length === 3);
    check("(G) gateOnlyListPath itself derives the SAME directory .log spills already live under", path.dirname(gateOnlyListPath("x")) === GATE_SPILL_DIR);
  }

  // ── (H) card 92be634e ruling 2: the real writer mkdir's its own parent — a fresh LOOM_HOME's
  //        GATE_SPILL_DIR is never pre-created, so the FIRST overflow on a brand-new home must not ENOENT ──
  {
    const base = mkdtempManaged("loom-test-92be634e-fresh-home-");
    const neverCreatedParent = path.join(base, "gate-output-like", "a", "b"); // multiple missing segments
    check("(H) setup: the parent directory genuinely does not exist yet", !fs.existsSync(neverCreatedParent));
    const onlyFilePath = path.join(neverCreatedParent, "fake-opid.only.txt");
    let threw;
    try {
      writeReducedGateOnlyFileReal(onlyFilePath, "some-name\n");
    } catch (err) {
      threw = err;
    }
    check("(H) writeReducedGateOnlyFileReal does NOT throw ENOENT against a never-created parent", threw === undefined);
    check("(H) the file actually landed, with the right content", fs.existsSync(onlyFilePath) && fs.readFileSync(onlyFilePath, "utf8") === "some-name\n");
  }

  // ── (I) card 92be634e ruling 5: the boot-time sweep removes every stale .only.txt, unconditionally ──
  {
    const { sweepStaleGateOnlyFiles } = await import("../dist/orchestration/gate-spill.js");
    const dir = mkdtempManaged("loom-test-92be634e-boot-sweep-");
    fs.writeFileSync(path.join(dir, "stale-op-1.only.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(dir, "stale-op-2.only.txt"), "b\n", "utf8");
    fs.writeFileSync(path.join(dir, "keep-me.log"), "c", "utf8"); // a sibling .log must survive untouched
    const removed = sweepStaleGateOnlyFiles(dir);
    check("(I) reports exactly the 2 .only.txt files it removed", removed === 2);
    const remaining = fs.readdirSync(dir);
    check("(I) both .only.txt files are gone", !remaining.includes("stale-op-1.only.txt") && !remaining.includes("stale-op-2.only.txt"));
    check("(I) the sibling .log file is untouched", remaining.includes("keep-me.log"));
    check("(I) a second sweep of the same (now-empty-of-.only.txt) dir is a harmless no-op", sweepStaleGateOnlyFiles(dir) === 0);
    check("(I) sweeping a directory that doesn't exist at all never throws and reports 0", sweepStaleGateOnlyFiles(path.join(dir, "does-not-exist")) === 0);
  }

  console.log(`\n${failures === 0 ? "✅" : "❌"} reduced-gate-only-file-overflow: ${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
};

run();
