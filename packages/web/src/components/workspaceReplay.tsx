import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { archivedOnlyProjects, fleetProjectNames, replayRoots } from "../lib/fleet";
import { AuditReplayPanel } from "./auditReplay";
import { InactiveFleet } from "./fleet";

// THE WORKSPACE NODE'S RETROSPECTIVE READING — card ff6123de (epic 9fe8cd4e). Overview is the node read
// operationally and Deck is the same node read board-first; this is the same node read BACKWARDS: what
// already happened. Both halves were Mission Control's, and both had no Atlas mount at all, which is what
// blocked card 5afd71bd from retiring that page.
//
// Two sections, in the order a reader uses them: the wave scrubber/diff first (the tool), then the
// finished waves it can be pointed at (the subjects). On Mission Control these sat at opposite ends of a
// long operational page and never read as related; here the second is literally the first's input set.
//
// ⛔ Both components are the EXISTING ones, mounted verbatim — components/auditReplay.tsx and
// components/fleet.tsx. Nothing here re-implements a timeline, a picker or a fleet card.
//
// @decision ff6123de — this body must stay BEHIND the lazily-mounted Replay tab. Its four archive/home
// reads are what the operational `/home` landing deliberately does not pay for, and hoisting any of them
// into WorkspaceHome's own query list puts that cost back on the default Atlas landing.

/** The archived page size both feeds use — Mission Control's own figure, kept identical so the two
 *  surfaces share ONE `["allArchivedSessions", …]` cache entry rather than polling it twice. */
const ARCHIVED_PAGE = 300;

export function WorkspaceReplay() {
  // The live, non-archived feed — the shared cache entry every fleet surface already reads, kept live by
  // FleetSocketProvider's /ws/fleet deltas. No interval of its own.
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  // Archived (now-exited) sessions across every project, ALL roles — what makes a finished wave's project
  // visible at all, since sessions auto-archive on exit and drop out of the live feed. Paginated: this is
  // a recent-history read, not the full cross-project archive (2137 rows / 2.4MB measured live).
  const archivedQ = useQuery({
    queryKey: ["allArchivedSessions", ARCHIVED_PAGE],
    queryFn: () => api.allArchivedSessions({ limit: ARCHIVED_PAGE }),
    refetchInterval: 15000,
  });
  // Archived MANAGERS ONLY, for the replay picker — a SEPARATE role-scoped page, never a client-side
  // filter of the all-roles one above: the mixed page interleaves managers with the far more numerous
  // archived worker rows in one archived_at ordering, so an archived manager older than the newest 300
  // archived sessions GLOBALLY would fall off the page and become unselectable even with far fewer than
  // 300 managers in existence (card 9f010283).
  const archivedManagersQ = useQuery({
    queryKey: ["allArchivedSessions", "manager", ARCHIVED_PAGE],
    queryFn: () => api.allArchivedSessions({ limit: ARCHIVED_PAGE, role: "manager" }),
    refetchInterval: 15000,
  });
  // The reserved/system homes, discovered read-only exactly as the Platform pages do (retry:false —
  // setupHome may still 404 before the home seeds). Their project ids EXCLUDE those homes from the
  // inactive tier: they sit in the archive with zero live sessions, but they are hidden from every
  // ordinary project surface and must not read as an "inactive" user project here either. Shared query
  // keys ⇒ cache reuse, no extra poll.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const setupHome = useQuery({ queryKey: ["setupHome"], queryFn: api.setupHome, retry: false });

  const all = sessionsQ.data ?? [];
  const managers = all.filter((s) => s.role === "manager");
  const archivedItems = archivedQ.data?.items ?? [];
  const reservedProjectIds = [platformHome.data?.project?.id, setupHome.data?.project?.id].filter(Boolean) as string[];

  // The two shared derivations (lib/fleet.ts). `fleetProjectNames` is the LIVE population; anything
  // outside it but present in the archive is a finished wave. Both are the same functions Mission
  // Control calls, so the two surfaces cannot disagree about which projects are inactive or about which
  // managers the picker offers.
  const inactive = archivedOnlyProjects(fleetProjectNames(all), archivedItems, reservedProjectIds);
  const roots = replayRoots(managers, archivedManagersQ.data?.items ?? []);

  return (
    <div className="loom-atlas-replay" data-testid="atlas-replay">
      <section className="loom-atlas-primary" data-testid="atlas-replay-wave">
        <div className="loom-atlas-primaryhead">
          <span className="loom-atlas-primarylbl">Wave replay</span>
          <span className="loom-bandcount">{roots.length}</span>
          <span style={{ flex: 1 }} />
        </div>
        <p className="loom-bandempty">
          Step a wave's durable audit timeline event by event, or diff one run against another. Live waves
          are listed first, then the managers of runs that have already finished.
        </p>
        {/* `hideLabel`: the section head above IS this panel's label, so the panel's own would be the
            second copy of the same words within ~40px. */}
        <AuditReplayPanel managers={roots} hideLabel />
      </section>

      <section className="loom-atlas-primary" data-testid="atlas-replay-inactive">
        {/* No `loom-bandcount` here, deliberately — unlike the Wave replay head above. `InactiveFleet`'s
            own affordance reads "N inactive project(s)" ~60px below, and it is BOTH the figure and the
            control for it, so a count in the head is the same number drawn twice on one screen (measured
            at 1440; the same restated-figure rule card 5968d7e0 applied to the node head's pills). The
            Wave replay head keeps its count because nothing inside that panel states how many waves there
            are — its `events`/`actors` chips describe the one SELECTED wave. */}
        <div className="loom-atlas-primaryhead">
          <span className="loom-atlas-primarylbl">Inactive projects</span>
          <span style={{ flex: 1 }} />
        </div>
        {inactive.length === 0 ? (
          <p className="loom-bandempty">
            Every project with an archived session still has something running. A project whose whole
            wave has exited is listed here, with what it was made of.
          </p>
        ) : (
          <>
            <p className="loom-bandempty">
              Finished waves — projects whose sessions have all exited. Each one's manager is a replay
              subject above.
            </p>
            {/* `defaultOpen`: nothing sits above this strip on a tab a reader navigated to deliberately,
                so the collapse Mission Control needs (to keep its live fleet grid on the fold) is pure
                friction here. The affordance itself stays, so it can still be shut. */}
            <InactiveFleet projects={inactive} defaultOpen />
          </>
        )}
      </section>
    </div>
  );
}
