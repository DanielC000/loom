import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7d6e43b, Code Review hardening amendment 2(a)/(e): validateNpmPinnedSpec (capabilities/npm-pinned.ts)
// is the FAIL-CLOSED allowlist check run BEFORE any package/version/binRelativeToPackageJson value is
// interpolated into the `npm install` shell command string. The provision recipe lives in a DB row
// (constant-at-seed-time, not compile-time-constant), so a hand-edited/corrupted row must never reach the
// shell. This is a pure-function unit test — no fs, no spawn, no LOOM_HOME.
//
// Proves:
//   (1) every genuinely-valid seed shape passes (unscoped name, scoped name, exact semver w/ prerelease
//       and build metadata, a nested relative bin path).
//   (2) a package name carrying a shell metacharacter (space, `;`, `` ` ``, `$`, `|`, `&`, quotes) is
//       rejected.
//   (3) a version that is a RANGE (`^`/`~`/`*`), a dist-tag (`latest`), a URL, or a `file:`/`git:` spec is
//       rejected — only an EXACT semver passes.
//   (4) a binRelativeToPackageJson containing a `..` segment, or an absolute path, is rejected.
//   (5) every rejection returns a non-empty reason string (never throws, never returns an empty string).
//
// Run: 1) build, 2) node test/npm-pinned-validate.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { validateNpmPinnedSpec } = await import("../dist/capabilities/npm-pinned.js");

// ===================== (1) valid shapes pass =====================
check("(1) unscoped name + exact semver + simple bin ⇒ valid", validateNpmPinnedSpec("mcp-imagenate", "0.2.1", "dist/index.js") === undefined);
check("(1) scoped name ⇒ valid", validateNpmPinnedSpec("@scope/my-pkg", "1.0.0", "bin/cli.js") === undefined);
check("(1) prerelease + build metadata semver ⇒ valid", validateNpmPinnedSpec("semver", "7.6.3-beta.1+build.5", "bin/semver.js") === undefined);
check("(1) nested relative bin path ⇒ valid", validateNpmPinnedSpec("semver", "7.6.3", "bin/nested/cli.js") === undefined);

// ===================== (2) shell-metacharacter package names are rejected =====================
for (const bad of ["evil; rm -rf /", "evil`whoami`", "evil$(whoami)", "evil|cat", "evil&sleep", "evil\"x\"", "evil'x'", "has space", "UPPERCASE"]) {
  const reason = validateNpmPinnedSpec(bad, "1.0.0", "bin/cli.js");
  check(`(2) package '${bad}' is rejected (shell metacharacter / invalid name)`, typeof reason === "string" && reason.length > 0);
}

// Card e7d6e43b, Code Review Minor: a LEADING dash would be parsed by `npm install` as a CLI OPTION, not
// a package name — '-' stays valid as an INTERIOR character (e.g. "mcp-imagenate"), but the first
// character of each name segment must exclude it.
for (const bad of ["-foo", "-", "--registry=http://evil", "@-scope/pkg"]) {
  const reason = validateNpmPinnedSpec(bad, "1.0.0", "bin/cli.js");
  check(`(2) leading-dash package '${bad}' is rejected`, typeof reason === "string" && reason.length > 0);
}
check("(2) negative control: a leading tilde is still accepted (not conflated with the leading-dash rejection)", validateNpmPinnedSpec("~foo", "1.0.0", "bin/cli.js") === undefined);
check("(2) negative control: an interior dash is still accepted (mcp-imagenate)", validateNpmPinnedSpec("mcp-imagenate", "1.0.0", "bin/cli.js") === undefined);

// ===================== (3) only an EXACT semver passes — ranges/tags/URLs/file:/git: all rejected =====================
for (const bad of ["^1.0.0", "~1.0.0", "*", "1.x", "latest", "1.0", "1", "https://example.com/pkg.tgz", "file:../local-pkg", "git://example.com/x.git", "1.0.0 ; rm -rf /"]) {
  const reason = validateNpmPinnedSpec("mcp-imagenate", bad, "dist/index.js");
  check(`(3) version '${bad}' is rejected (not an exact semver)`, typeof reason === "string" && reason.length > 0);
}

// ===================== (4) binRelativeToPackageJson containment =====================
for (const bad of ["../escape.js", "a/../../escape.js", "/absolute/path.js", "\\absolute\\path.js", ""]) {
  const reason = validateNpmPinnedSpec("mcp-imagenate", "0.2.1", bad);
  check(`(4) binRelativeToPackageJson '${bad}' is rejected`, typeof reason === "string" && reason.length > 0);
}

// ===================== (5) negative control — a deliberately bogus "valid" input the validator must NOT reject =====================
check("(5) negative control: a genuinely valid spec is NOT rejected", validateNpmPinnedSpec("cowsay", "1.6.0", "cli.js") === undefined);

console.log(failures === 0
  ? "\n✅ ALL PASS — validateNpmPinnedSpec rejects shell metacharacters in package names, every non-exact-semver version shape (ranges/tags/URLs/file:/git:), and any binRelativeToPackageJson escaping the package directory, while every genuinely valid shape still passes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
