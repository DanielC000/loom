/**
 * Slugify an agent name the way worker_spawn's `agentId` name/slug resolution does: lowercase, collapse any
 * run of non-alphanumerics to a single hyphen, trim leading/trailing hyphens. Deterministic and
 * dependency-free, so "QA Tester" and "qa-tester" both resolve to that agent. ONE definition shared by the
 * daemon (resolution + the name checks) and the web agent editor's client-side pre-check, so the two can
 * never disagree about which names collide.
 */
export function slugifyAgentName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
