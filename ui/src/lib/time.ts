const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A timestamp as people say it: "just now", "2 min ago", "3 h ago",
 * "yesterday", "4 days ago", then the calendar date. Future times (clock skew)
 * read as "just now"; an unparseable value is returned unchanged.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const elapsed = now - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * How long ago `iso` was, in its largest whole unit: "3d", "5h", "12m", or
 * "<1m" (future times too); "" for an unparseable value. For uptimes ("Up 3d").
 */
export function shortDuration(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const elapsed = now - then;
  if (elapsed >= DAY) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed >= HOUR) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed >= MINUTE) return `${Math.floor(elapsed / MINUTE)}m`;
  return "<1m";
}
