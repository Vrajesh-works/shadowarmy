// Run limits (behavior contract section 16). A "run" is a workflow job that
// starts an agent; in the Realm those jobs are named after their role. The
// daily count resets at 00:00 in the configured time zone.

import { repoPath, type GitHubClient } from "./github.ts";

/** Jobs that start an agent. Reusable workflow jobs show as "<caller job> / <job>". */
export const AGENT_JOB_NAMES = ["marshal", "soldier", "knight", "scout"] as const;

/** The wall-clock time in `timeZone` at instant `t`, read as if it were UTC (milliseconds). */
function wallClockAsUtc(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** The UTC instant of local midnight, in `timeZone`, on the local date of `now`. */
export function startOfDay(now: Date, timeZone: string): Date {
  const local = new Date(wallClockAsUtc(now.getTime(), timeZone));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const offsetAt = (t: number) => wallClockAsUtc(t, timeZone) - Math.floor(t / 1000) * 1000;
  // The offset at midnight can differ from the offset now (daylight saving time), so refine once.
  let t = midnight - offsetAt(now.getTime());
  t = midnight - offsetAt(t);
  return new Date(t);
}

interface RunJson {
  id: number;
}

interface JobJson {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

/** True for a job that started an agent: an agent job that actually started and was not skipped. */
export function isAgentJob(job: JobJson): boolean {
  const name = (job.name.split(" / ").at(-1) ?? "").trim().toLowerCase();
  return (AGENT_JOB_NAMES as readonly string[]).includes(name) && job.started_at !== null && job.conclusion !== "skipped";
}

/** Count agent jobs in the Realm's workflow runs created since `since`. */
export async function countAgentRuns(client: GitHubClient, realm: string, since: Date): Promise<number> {
  const runs = await client.paginate<RunJson>(
    `/repos/${repoPath(realm)}/actions/runs?created=${encodeURIComponent(`>=${since.toISOString()}`)}`,
    20,
  );
  let count = 0;
  for (const run of runs) {
    const jobs = await client.paginate<JobJson>(`/repos/${repoPath(realm)}/actions/runs/${String(run.id)}/jobs`, 5);
    count += jobs.filter(isAgentJob).length;
  }
  return count;
}
