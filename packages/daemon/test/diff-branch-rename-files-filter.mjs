import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// diffBranch `files:`/`pathGlob` filter vs a RENAMED file (card 4cee7413). REAL git on a temp repo, no daemon.
// `git diff --stat` renders a rename as `src/{old.ts => new.ts}`; the filter's pathspec used to be that
// display string, so a renamed file matched nothing (empty patch, read as "no changes").
// Run: 1) pnpm build, 2) node test/diff-branch-rename-files-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const { diffBranch, normalizeDiffstatPath, diffstatRenameSource } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dbr@loom -c user.name=dbr";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dbr-"));
try {
  const sh = (c) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "old.ts"), body);
  fs.writeFileSync(path.join(repo, "other.ts"), "x\n");
  sh("git init -q -b main && git config user.email dbr@loom && git config user.name dbr");
  commitAll(repo, "init", GIT_ID);
  sh("git checkout -q -b feat");
  sh("git mv src/old.ts src/new.ts");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), body.replace("line 5\n", "line 5 EDITED\n"));
  fs.writeFileSync(path.join(repo, "other.ts"), "y\n");
  commitAll(repo, "rename+edit", GIT_ID);

  const all = await diffBranch(repo, "feat", "main", {});
  check("premise: diffstat renders the rename in bracket form", all.allFiles.some((f) => f.file.includes("=>")));

  const byFile = await diffBranch(repo, "feat", "main", { files: ["src/new.ts"] });
  check("files:[new path] keeps the renamed entry", byFile.files.length === 1 && byFile.filesChanged === 1);
  check("files:[new path] patch is NON-empty and carries the edit", byFile.patch.includes("line 5 EDITED"));
  check("files:[new path] patch excludes the unrelated file", !byFile.patch.includes("other.ts"));

  const byGlob = await diffBranch(repo, "feat", "main", { pathGlob: "src/*.ts" });
  check("pathGlob on the new path returns a non-empty patch", byGlob.patch.includes("line 5 EDITED"));

  // Review signal: git must PAIR the rename (both paths in the pathspec) -> `rename from/to` + only the real edit.
  check("files:[new path] patch pairs the rename (rename from/to)", byFile.patch.includes("rename from src/old.ts") && byFile.patch.includes("rename to src/new.ts"));
  check("files:[new path] patch does NOT re-add the unchanged content", !byFile.patch.includes("+line 7") && byFile.patch.includes("+line 5 EDITED"));
  check("pathGlob patch also pairs the rename", byGlob.patch.includes("rename from src/old.ts"));

  // Negative control: a path matching nothing stays empty.
  const none = await diffBranch(repo, "feat", "main", { files: ["nope/absent.ts"] });
  check("bogus path -> empty patch, 0 files", none.patch === "" && none.files.length === 0);

  check("normalize: common-prefix form", normalizeDiffstatPath("src/{old.ts => new.ts}") === "src/new.ts");
  check("normalize: whole-path form", normalizeDiffstatPath("a.ts => b.ts") === "b.ts");
  check("source: common-prefix / whole-path / non-rename", diffstatRenameSource("src/{old.ts => new.ts}") === "src/old.ts" && diffstatRenameSource("a.ts => b.ts") === "a.ts" && diffstatRenameSource("src/plain.ts") === null);
  check("source: empty-side dir move", diffstatRenameSource("src/{ => sub}/x.ts") === "src/x.ts" && diffstatRenameSource("src/{sub => }/x.ts") === "src/sub/x.ts");
  check("normalize: empty-side dir move has no doubled slash", normalizeDiffstatPath("src/{ => sub}/x.ts") === "src/sub/x.ts" && normalizeDiffstatPath("src/{sub => }/x.ts") === "src/x.ts");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
