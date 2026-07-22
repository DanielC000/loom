import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unit tests for resolveRepo (multi-repo epic 49136451, phase 1) — the ONE resolver every repo-scoped
// operation is meant to route through. PURE-FUNCTION tests, no Db/MCP/HTTP scaffolding: resolveRepo takes
// a plain Project + optional Task-shaped object and returns {key,path,gateCommand}. Also covers
// resolveRepoKeyOrError (projects/repos.ts), the shared validator both write surfaces (mcp/tasks.ts,
// gateway/server.ts) use to check a task.repoKey against a project's registry.
//
// Proves the DoD's explicit resolveRepo unit-test coverage:
//   (1) task omitted (undefined) -> primary (byte-identical path every existing project takes today).
//   (2) task.repoKey null -> primary.
//   (3) task.repoKey "primary" -> primary (explicit spelling of the default).
//   (4) task.repoKey names a registry entry -> that entry's OWN path/gateCommand verbatim (no fallback
//       to the project-level gateCommand — a registry repo's gate is deliberately NOT inherited).
//   (5) a registry entry with NO gateCommand -> gateCommand: undefined (not the project-level gate).
//   (6) task.repoKey names NO entry in the CURRENT registry -> throws UnknownRepoKeyError (stale data).
//   (7) primary's gateCommand resolves through resolveConfig(project.config).orchestration.gateCommand,
//       "" (the unset default) surfacing as undefined, same as a configured non-empty command surfacing verbatim.
//   (8) resolveRepoKeyOrError: undefined/null/"primary" -> {ok:true,value:null}; a known key -> {ok:true,
//       value:key}; an unknown key -> {ok:false,error} naming the registered keys.
//
// Run: 1) build (turbo builds shared first), 2) node test/resolve-repo.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveRepo, UnknownRepoKeyError } = await import("../dist/projects/resolve-repo.js");
const { resolveRepoKeyOrError } = await import("../dist/projects/repos.js");

const baseProject = {
  id: "p1", name: "Demo", repoPath: "/host/primary-repo", vaultPath: "/host/vault",
  config: {}, createdAt: "2026-01-01T00:00:00.000Z", archivedAt: null, reserved: false,
  referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"],
  repos: [
    { key: "svc-a", path: "/host/svc-a-repo", gateCommand: "npm test" },
    { key: "svc-b", path: "/host/svc-b-repo" }, // no gateCommand
  ],
};

// ===== (1) task omitted -> primary =====
{
  const r = resolveRepo(baseProject);
  check("(1) task omitted -> key 'primary'", r.key === "primary");
  check("(1) task omitted -> path is project.repoPath", r.path === baseProject.repoPath);
  check("(1) task omitted -> no registered gateCommand -> gateCommand undefined", r.gateCommand === undefined);
}

// ===== (2) task.repoKey null -> primary =====
{
  const r = resolveRepo(baseProject, { repoKey: null });
  check("(2) task.repoKey null -> key 'primary'", r.key === "primary");
  check("(2) task.repoKey null -> path is project.repoPath", r.path === baseProject.repoPath);
}

// ===== (3) task.repoKey "primary" -> primary (explicit spelling) =====
{
  const r = resolveRepo(baseProject, { repoKey: "primary" });
  check("(3) task.repoKey 'primary' -> key 'primary'", r.key === "primary");
  check("(3) task.repoKey 'primary' -> path is project.repoPath", r.path === baseProject.repoPath);
}

// ===== (4) registry hit -> the entry's OWN path/gateCommand verbatim =====
{
  const r = resolveRepo(baseProject, { repoKey: "svc-a" });
  check("(4) registry hit -> key is the entry's key", r.key === "svc-a");
  check("(4) registry hit -> path is the entry's OWN path (not repoPath)", r.path === "/host/svc-a-repo");
  check("(4) registry hit -> gateCommand is the entry's OWN gateCommand (not any project-level fallback)", r.gateCommand === "npm test");
}

// ===== (5) a registry entry with no gateCommand -> undefined, NOT the project-level gate =====
{
  const projectWithProjectGate = { ...baseProject, config: { orchestration: { gateCommand: "pnpm build" } } };
  const r = resolveRepo(projectWithProjectGate, { repoKey: "svc-b" });
  check("(5) registry entry with no own gateCommand -> undefined (deliberately NOT inheriting the project-level gate)", r.gateCommand === undefined);
  // Control: the SAME project's primary resolution DOES see its own project-level gate — proves the
  // omission above is a deliberate per-repo choice, not a broken read of project.config entirely.
  const primary = resolveRepo(projectWithProjectGate);
  check("(5 control) primary resolution DOES see the project-level gateCommand", primary.gateCommand === "pnpm build");
}

// ===== (6) unknown repoKey -> throws UnknownRepoKeyError (stale registry data) =====
{
  let threw = null;
  try {
    resolveRepo(baseProject, { repoKey: "no-such-key" });
  } catch (e) {
    threw = e;
  }
  check("(6) unknown repoKey throws", threw !== null);
  check("(6) thrown error is an UnknownRepoKeyError", threw instanceof UnknownRepoKeyError);
  check("(6) thrown error names the offending key", threw?.repoKey === "no-such-key");
  check("(6) thrown error names the project id", threw?.projectId === "p1");
}

// ===== (7) primary gateCommand: unset ("") surfaces as undefined; a configured command surfaces verbatim =====
{
  const unset = resolveRepo({ ...baseProject, config: {} });
  check("(7) unset project-level gateCommand -> undefined (not the empty string)", unset.gateCommand === undefined);
  const configured = resolveRepo({ ...baseProject, config: { orchestration: { gateCommand: "pnpm build && pnpm test" } } });
  check("(7) configured project-level gateCommand surfaces verbatim", configured.gateCommand === "pnpm build && pnpm test");
}

// ===== (8) resolveRepoKeyOrError =====
{
  const registry = baseProject.repos;
  check("(8) undefined -> ok, value null", JSON.stringify(resolveRepoKeyOrError(registry, undefined)) === JSON.stringify({ ok: true, value: null }));
  check("(8) null -> ok, value null", JSON.stringify(resolveRepoKeyOrError(registry, null)) === JSON.stringify({ ok: true, value: null }));
  check("(8) 'primary' -> ok, value null", JSON.stringify(resolveRepoKeyOrError(registry, "primary")) === JSON.stringify({ ok: true, value: null }));
  check("(8) a known key -> ok, value the key", JSON.stringify(resolveRepoKeyOrError(registry, "svc-a")) === JSON.stringify({ ok: true, value: "svc-a" }));
  const bad = resolveRepoKeyOrError(registry, "ghost");
  check("(8) an unknown key -> ok:false", bad.ok === false);
  check("(8) the error names the offending key", /ghost/.test(bad.error));
  check("(8) the error lists the registered keys", /svc-a/.test(bad.error) && /svc-b/.test(bad.error));
  const emptyRegistry = resolveRepoKeyOrError([], "anything");
  check("(8) an unknown key against an EMPTY registry still errors cleanly (no crash)", emptyRegistry.ok === false && /none/.test(emptyRegistry.error));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveRepo resolves null-task/null-repoKey/\"primary\" to the primary repo (project-level gateCommand, \"\" surfacing as undefined), a registry hit to that entry's OWN path/gateCommand (deliberately never falling back to the project-level gate), and an unknown repoKey throws UnknownRepoKeyError naming the key + project; resolveRepoKeyOrError mirrors the same null/primary/known/unknown shape as a plain {ok,value|error} check."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
