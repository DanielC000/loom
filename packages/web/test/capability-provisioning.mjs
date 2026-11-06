// Hermetic unit test for the web-side capability-provisioning derivations in
// src/lib/capabilityProvisioning.ts — the pure, JSX-free helpers behind the Profiles editor's per-slug
// provisioning row and its `network` badge (card cd9a78bc).
//
// It pins the parts that are genuinely easy to get wrong and are cheap to assert here rather than in a
// browser: the kind classification in BOTH directions (every kind decided, and the two flags NOT treated
// as one), the three-way `provisioningSourceOf` routing (the `document-conversion` builtin's global-python
// carve-out is the whole reason the helper exists), and the failure-reason phrasing — including the two
// contract points that are easy to regress: a `disabled` reason naming the RIGHT per-kind env var, and an
// unrecognised code degrading to null instead of leaking a raw enum at the user.
//
// Like merge-gate.mjs/fleet.mjs, the web package has no test runner, so this is a self-contained node
// script, auto-discovered by test/run-all.mjs (which `pnpm build` runs). Run it standalone with:
//   node --experimental-strip-types packages/web/test/capability-provisioning.mjs
import assert from "node:assert/strict";
import {
  NETWORK_KINDS, PROVISIONED_KINDS, PROVISION_STATE_META, capabilityNeedsNetwork,
  capabilityReportsProvisioning, provisionReasonText, provisioningSourceOf,
} from "../src/lib/capabilityProvisioning.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

/** A capability summary factory — only the fields these helpers actually read. */
const cap = (o = {}) => ({ slug: "x", name: "X", kind: "bundled", builtin: false, ...o });

// The six provision kinds the daemon declares today (`CapabilityProvisionKind`, shared/src/types.ts).
// Hardcoded on purpose: the TYPE-level exhaustiveness guarantee lives in the lib's own
// `Record<CapabilityProvisionKind, …>` (a seventh kind fails `tsc`), and this list is the runtime half —
// it asserts each of today's six is DECIDED, which a Record alone doesn't say anything about.
const ALL_KINDS = ["node-package", "python-venv", "bundled", "command", "github-binary", "npm-pinned"];

// ── The kind classification ──────────────────────────────────────────────────────────────────────────

check("exactly the three background-provisioned kinds report a status", () => {
  assert.deepEqual([...PROVISIONED_KINDS].sort(), ["github-binary", "npm-pinned", "python-venv"]);
});

check("exactly the three fetching kinds carry the network badge", () => {
  assert.deepEqual([...NETWORK_KINDS].sort(), ["github-binary", "npm-pinned", "python-venv"]);
});

check("the two flags are SEPARATE arrays, not one aliased list", () => {
  // Today's members coincide — a fact about the catalog, not a definition. If a future edit collapses
  // them into one exported constant, this identity check is what notices.
  assert.notEqual(PROVISIONED_KINDS, NETWORK_KINDS);
});

check("every kind the daemon declares today is classified either way", () => {
  for (const kind of ALL_KINDS) {
    assert.equal(typeof capabilityNeedsNetwork(cap({ kind })), "boolean", kind);
    assert.equal(typeof capabilityReportsProvisioning(cap({ kind })), "boolean", kind);
  }
});

check("node-package is the one kind knowably offline-safe, and reports no status", () => {
  const playwright = cap({ slug: "browser-testing", kind: "node-package", builtin: true });
  assert.equal(capabilityNeedsNetwork(playwright), false);
  assert.equal(capabilityReportsProvisioning(playwright), false);
});

check("bundled/command withhold the network badge rather than asserting local", () => {
  // The badge's ABSENCE must never be read as a no-network guarantee — their recipe isn't in the summary.
  for (const kind of ["bundled", "command"]) assert.equal(capabilityNeedsNetwork(cap({ kind })), false, kind);
});

check("an unknown kind degrades to no-badge instead of throwing", () => {
  // A daemon that ships a kind this build hasn't seen must not blow up the picker.
  assert.equal(capabilityNeedsNetwork(cap({ kind: "kind-from-the-future" })), false);
});

// ── Which endpoint backs the row ─────────────────────────────────────────────────────────────────────

check("the document-conversion BUILTIN routes to the global python status, not the per-slug one", () => {
  // It is not a catalog row at all — buildMcpServers special-cases it, so the per-slug tracker never sees
  // the slug and /api/capabilities/document-conversion/provisioning answers idle forever.
  const docConv = cap({ slug: "document-conversion", kind: "python-venv", builtin: true });
  assert.equal(provisioningSourceOf(docConv), "global-python");
  assert.equal(capabilityReportsProvisioning(docConv), true);
});

check("the browser-testing BUILTIN has no status anywhere", () => {
  assert.equal(provisioningSourceOf(cap({ slug: "browser-testing", kind: "node-package", builtin: true })), "none");
});

check("a catalog row of a tracked kind routes per-slug", () => {
  for (const kind of ["python-venv", "github-binary", "npm-pinned"]) {
    assert.equal(provisioningSourceOf(cap({ slug: "s", kind, builtin: false })), "per-slug", kind);
  }
});

check("a catalog row of an untracked kind gets NO row", () => {
  // The gate's whole point: the generic route would answer a hardcoded idle forever, so an ungated row
  // would read "not provisioned yet" beside a capability that is mounted and working.
  for (const kind of ["node-package", "bundled", "command"]) {
    assert.equal(provisioningSourceOf(cap({ slug: "s", kind, builtin: false })), "none", kind);
    assert.equal(capabilityReportsProvisioning(cap({ slug: "s", kind, builtin: false })), false, kind);
  }
});

check("a python-venv row that is NOT the builtin still routes per-slug", () => {
  // An owner-added python-venv capability provisions through the registry tracker, unlike the builtin —
  // so the carve-out must be keyed on the slug AND builtin, never on the kind alone.
  assert.equal(provisioningSourceOf(cap({ slug: "my-pdf-thing", kind: "python-venv", builtin: false })), "per-slug");
});

check("capabilityReportsProvisioning agrees with provisioningSourceOf on every combination", () => {
  for (const kind of ALL_KINDS) {
    for (const builtin of [true, false]) {
      for (const slug of ["document-conversion", "browser-testing", "other"]) {
        const c = cap({ slug, kind, builtin });
        assert.equal(capabilityReportsProvisioning(c), provisioningSourceOf(c) !== "none", `${slug}/${kind}/${builtin}`);
      }
    }
  }
});

// ── State + reason phrasing ──────────────────────────────────────────────────────────────────────────

check("all four states have a tone and a label, and only the attention ones are tinted", () => {
  assert.deepEqual(Object.keys(PROVISION_STATE_META).sort(), ["failed", "idle", "installing", "ready"]);
  assert.equal(PROVISION_STATE_META.idle.tone, "muted");
  assert.equal(PROVISION_STATE_META.installing.tone, "work");
  assert.equal(PROVISION_STATE_META.ready.tone, "live");
  assert.equal(PROVISION_STATE_META.failed.tone, "danger");
  for (const m of Object.values(PROVISION_STATE_META)) assert.ok(m.label.length > 0);
});

check("every classified failure reason across all three kinds gets a human phrasing", () => {
  // The union of ProvisionOutcome (python/venv.ts), GithubBinaryProvisionOutcome and
  // NpmPinnedProvisionOutcome, minus `ready` (which never reaches a `failed` status).
  const reasons = [
    "no-base-python", "venv-create-failed", "pip-failed",
    "unsupported-platform", "download-failed", "checksum-mismatch", "extract-failed",
    "invalid-spec", "lock-missing", "install-failed", "timeout", "disabled",
  ];
  for (const r of reasons) {
    const text = provisionReasonText(r, "npm-pinned");
    assert.equal(typeof text, "string", r);
    assert.ok(text.length > 0, r);
    // Never leak the raw enum code at the user.
    assert.notEqual(text, r, r);
  }
});

check("the `disabled` reason names the env var for THIS kind, not one shared flag", () => {
  assert.match(provisionReasonText("disabled", "python-venv"), /LOOM_PYTHON_NO_PROVISION/);
  assert.match(provisionReasonText("disabled", "github-binary"), /LOOM_GITHUB_MCP_NO_PROVISION/);
  assert.match(provisionReasonText("disabled", "npm-pinned"), /LOOM_NPM_PINNED_NO_PROVISION/);
  // A kind with no flag of its own still gets a sentence, just without a var it never reads.
  const generic = provisionReasonText("disabled", "bundled");
  assert.match(generic, /provisioning disabled/);
  assert.doesNotMatch(generic, /LOOM_/);
});

check("pip-failed is phrased generically, not as markitdown's own install", () => {
  // It used to read "pip install of markitdown failed" — wrong for any other python-venv capability.
  assert.doesNotMatch(provisionReasonText("pip-failed", "python-venv"), /markitdown/i);
});

check("no-base-python keeps the one self-service pointer", () => {
  assert.match(provisionReasonText("no-base-python", "python-venv"), /Settings . Python interpreter/);
});

check("an absent reason, and an unrecognised one, both read as null", () => {
  // `null` is what makes the row fall back to the bare state label rather than printing an enum.
  assert.equal(provisionReasonText(undefined, "npm-pinned"), null);
  assert.equal(provisionReasonText("some-future-code", "npm-pinned"), null);
});

console.log(`\n${pass} assertions passed`);
