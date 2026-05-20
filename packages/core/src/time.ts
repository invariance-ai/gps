/**
 * Time helpers shared by --since filters and `gps stale`.
 *
 * Accepts ISO 8601 dates ("2026-04-01", "2026-04-01T12:00:00Z") or compact
 * relative durations: <N>d (days), <N>w (weeks), <N>mo (months), <N>y (years).
 * Throws on malformed input — callers should surface to the user.
 */

const REL_RE = /^(\d+)(d|w|mo|y)$/i;

export function parseSince(input: string, now: Date = new Date()): Date {
  const t = input.trim();
  if (!t) throw new Error("--since requires a value");
  const rel = t.match(REL_RE);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const d = new Date(now);
    if (unit === "d") d.setUTCDate(d.getUTCDate() - n);
    else if (unit === "w") d.setUTCDate(d.getUTCDate() - n * 7);
    else if (unit === "mo") d.setUTCMonth(d.getUTCMonth() - n);
    else if (unit === "y") d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    throw new Error(`--since: unrecognized date '${input}' (use ISO or 7d/2w/3mo/1y)`);
  }
  return new Date(ms);
}

/** True when `recorded_at` is at or after `since`. Inclusive lower bound. */
export function isAfter(recorded_at: string, since: Date): boolean {
  const ms = Date.parse(recorded_at);
  if (Number.isNaN(ms)) return false;
  return ms >= since.getTime();
}

/** Days between two ISO dates (now defaults to current time). */
export function daysBetween(iso: string, end: Date = new Date()): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.floor((end.getTime() - ms) / 86_400_000);
}
