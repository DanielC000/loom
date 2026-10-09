// @decision 85ae7768 — a SIDE-EFFECT-FREE LEAF module: never add a paths/config/db import here, or a
// test importing it before setting its own LOOM_HOME freezes the wrong ambient paths. Moved verbatim from
// pty/host.ts, which re-exports every name below so existing consumers stay byte-identical.
import { spawn as spawnProcess } from "node:child_process";

/** @decision 2897acc4 — one row from `reapOrphanedDescendants`'s own lightweight enumeration: the
 *  parent chain plus (win32 only — POSIX always `null`) this row's OS-reported creation time, epoch-ms.
 *  `creationTime: null` means unavailable, never "created at epoch 0". */
export interface OrphanSweepRow { pid: number; ppid: number; creationTime: number | null; }

/** @decision 2897acc4 — converts the win32 sweep's raw .NET `DateTime.Ticks` integer (culture-invariant,
 *  never a locale-dependent date STRING) to epoch-ms; the sentinel `"0"` (an unreadable `CreationDate`)
 *  maps to `null`, never a bogus epoch-0 (1970) creation time. Exported for a hermetic unit test. */
export function parseWin32SweepTicks(raw: string): number | null {
  const ticks = Number(raw);
  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000; // new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).Ticks
  const TICKS_PER_MS = 10_000;
  return Math.round((ticks - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MS);
}

/** @decision 2897acc4 — parses ONE line of `reapOrphanedDescendants`'s own lightweight enumeration
 *  output (`pid,ppid` or win32's `pid,ppid,ticks`); `null` for a non-matching line (never thrown — the
 *  caller filters). Exported for a hermetic unit test. */
export function parseOrphanSweepLine(line: string): OrphanSweepRow | null {
  const m = line.trim().match(/^(\d+)[,\s]+(\d+)(?:[,\s]+(-?\d+))?$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), creationTime: m[3] !== undefined ? parseWin32SweepTicks(m[3]) : null };
}

/** @decision 2897acc4 (round 6, item 1) — must be `.ToUniversalTime().Ticks`, never bare `.Ticks` (a
 *  LOCAL-kind value {@link parseWin32SweepTicks} above wrongly treats as UTC). Shared by both the full
 *  sweep query and {@link win32SweepFilteredCommand}'s single-pid one — one source, never hand-copied. */
export const WIN32_SWEEP_FOREACH_BODY =
  "$t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToUniversalTime().Ticks }; \"$($_.ProcessId),$($_.ParentProcessId),$t\"";
export const WIN32_SWEEP_PS_COMMAND = `Get-CimInstance Win32_Process | ForEach-Object { ${WIN32_SWEEP_FOREACH_BODY} }`;

/** @decision 87691385 (CR 376c51de, item 3) — a FILTERED single-pid CIM query, never a full-table scan,
 *  for the at-spawn root-creation-time capture: shrinks both the per-spawn cost and the capture window. */
function win32SweepFilteredCommand(pid: number): string {
  return `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { ${WIN32_SWEEP_FOREACH_BODY} }`;
}

/** @decision 2897acc4 (round 6, item 1) — read-only, kills nothing: lets a real-spawn test cross-check this
 *  enumeration's reported creationTime against `checkRootSurvival`'s independent one for the same real pid. */
export function enumerateWin32SweepRows(timeoutMs = 10_000): Promise<OrphanSweepRow[]> {
  return new Promise((resolve, reject) => {
    const cmd = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32_SWEEP_PS_COMMAND], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { cmd.kill(); } catch { /* best-effort */ }
      reject(new Error(`enumerateWin32SweepRows: powershell.exe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cmd.stdout?.on("data", (d) => { out += d; });
    cmd.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    cmd.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out.split("\n").map(parseOrphanSweepLine).filter((r): r is OrphanSweepRow => r !== null));
    });
  });
}

/** @decision 87691385 (CR f89d9552 round 3, MINOR 3a) — true when our OWN diagnostic helper (spawned to
 *  answer "is `queriedPid` still alive") was itself assigned `queriedPid` — the freed pid's most reachable
 *  reuse shape. Pure; exported for a hermetic unit test (a real collision can't be forced deterministically). */
export function isHelperPidCollision(helperPid: number, queriedPid: number): boolean {
  return helperPid === queriedPid;
}

/** @decision 87691385 (CR 376c51de, item 3) — single-pid filtered counterpart to
 *  {@link enumerateWin32SweepRows}, for the at-spawn capture seam. `null` on any failure/timeout/no-row —
 *  never thrown; a rejection is already treated by every caller as "unknown". */
export function enumerateWin32SweepRowForPid(pid: number, timeoutMs = 10_000): Promise<OrphanSweepRow | null> {
  return new Promise((resolve, reject) => {
    const cmd = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", win32SweepFilteredCommand(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    // @decision 87691385 (round 3, MINOR 3a) — the OS freed `pid` and could hand it straight to THIS
    // helper; if so, the CIM query would only ever find itself, never the real target — bail immediately.
    if (cmd.pid != null && isHelperPidCollision(cmd.pid, pid)) {
      try { cmd.kill(); } catch { /* best-effort */ }
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { cmd.kill(); } catch { /* best-effort */ }
      reject(new Error(`enumerateWin32SweepRowForPid: powershell.exe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cmd.stdout?.on("data", (d) => { out += d; });
    cmd.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    cmd.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const rows = out.split("\n").map(parseOrphanSweepLine).filter((r): r is OrphanSweepRow => r !== null);
      resolve(rows.find((r) => r.pid === pid) ?? null);
    });
  });
}

/** @decision 87691385 (CR f89d9552 round 3) — `CreateProcess` returns before `startedAt` is ever stamped,
 *  so the true root's own creation time is ALWAYS `<= startedAt`; this covers rounding only (~2ms), never
 *  a real margin — round 2's 50ms default was itself too wide. */
export const ROOT_CREATION_CAPTURE_SLACK_MS = Number(process.env.LOOM_ROOT_CREATION_CAPTURE_SLACK_MS) || 2;

/** @decision 87691385 — positive-identity check before a captured row is trusted as the root's own
 *  creation time: requires BOTH `row.ppid === expectedPpid` AND `row.creationTime` no later than
 *  `startedAt + slackMs`. Pure; `null` on any failed check — never partial trust. */
export function resolveVerifiedRootCreationTime(
  row: OrphanSweepRow | null, expectedPpid: number, startedAt: number, slackMs = ROOT_CREATION_CAPTURE_SLACK_MS,
): number | null {
  if (!row || row.creationTime == null) return null;
  if (row.ppid !== expectedPpid) return null;
  if (row.creationTime > startedAt + slackMs) return null;
  return row.creationTime;
}
