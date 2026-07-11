/**
 * Owner-declared symmetric project links (board card 2349d90c) — the sole gate for the manager↔manager
 * `peer_message` cross-project channel: a manager may message a peer project's manager ONLY if the owner
 * has linked the two projects. Written only through the HUMAN-only loopback REST surface
 * (`gateway/server.ts`) — there is intentionally NO MCP path (same trust posture as the connections/
 * capability_defs stores): an agent must never be able to link projects itself and so widen its own
 * cross-project reach. This module owns validation (self-link / duplicate / nonexistent project); the
 * db layer's unique index is the storage-layer backstop.
 */
import type { ProjectLink } from "@loom/shared";

/** The narrow db surface this module needs (mirrors ConnectionsDbStore's shape in connections/store.ts). */
export interface ProjectLinksDbStore {
  listProjectLinks(): ProjectLink[];
  getProjectLink(id: string): ProjectLink | undefined;
  areProjectsLinked(projectAId: string, projectBId: string): boolean;
  createProjectLink(projectAId: string, projectBId: string): ProjectLink;
  deleteProjectLink(id: string): void;
  getProject(id: string): { id: string } | undefined;
}

export function listProjectLinks(db: ProjectLinksDbStore): ProjectLink[] {
  return db.listProjectLinks();
}

/**
 * Declare a new symmetric link. VALIDATES (both projects exist, not a self-link, not already linked) and
 * THROWS a descriptive Error on an invalid input — the structural backstop: this holds regardless of
 * caller, so a future caller that skips its own pre-validation still can't persist a bad link (the REST
 * handler pre-checks for a friendly 400, but this is the authoritative enforcement point).
 */
export function createProjectLink(db: ProjectLinksDbStore, input: { projectAId: string; projectBId: string }): ProjectLink {
  const { projectAId, projectBId } = input;
  if (!projectAId || !projectBId) throw new Error("projectAId and projectBId are required");
  if (projectAId === projectBId) throw new Error("cannot link a project to itself");
  if (!db.getProject(projectAId)) throw new Error(`project not found: ${projectAId}`);
  if (!db.getProject(projectBId)) throw new Error(`project not found: ${projectBId}`);
  if (db.areProjectsLinked(projectAId, projectBId)) throw new Error("these projects are already linked");
  return db.createProjectLink(projectAId, projectBId);
}

/** Remove a link by id — idempotent, mirrors the db layer. */
export function deleteProjectLink(db: ProjectLinksDbStore, id: string): void {
  db.deleteProjectLink(id);
}
