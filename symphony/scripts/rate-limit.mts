/**
 * rate-limit.mts — Claude Code rate-limit banner detection & reset-time parsing.
 *
 * Extracted from poll-tickets.mts so the regex and parser can be unit-tested
 * without importing the poller (which has heavy import-time side effects).
 */

// Require the full Claude rate-limit banner ("You've hit your limit … resets")
// on a single line — mirrors pty-wrapper.py's RATE_LIMIT_RE. The old loose
// `rate.?limit` alternative matched any log line that merely mentioned
// "rate limit" / "rate-limit" (npm warnings, library errors, code comments),
// which combined with a process.exit caused a restart-suicide loop (UP-831).
export const RATE_LIMIT_PATTERN = /You(?:'|’)ve hit your limit[^\r\n]*resets/i;

/**
 * Scan only the bytes written after `fromOffset` for a rate-limit banner.
 *
 * Used when an *adopted* orphan agent (one this poller did not spawn, so it has
 * no `child.on('exit')` handler) is found dead: we record the agent log's size
 * at adoption time and scan only what was appended since, so a stale banner from
 * a previous run-ticket.sh invocation in the append-only log can't trigger a
 * false pause (SY-66). Mirrors the owned exit handler's logOffset scan.
 */
export function scanTailForRateLimit(
  logContent: string,
  fromOffset = 0
): { hit: boolean; resetAt: Date | null } {
  // fromOffset > 0  → scan only what was appended since adoption. If the log was
  //   truncated/rotated so it's now shorter than the offset, slice() returns ''
  //   (no new bytes) — we must NOT fall back to scanning the whole log, or a
  //   stale banner from before the offset could trigger a false pause.
  // fromOffset <= 0 → scan the whole log (the offset-0 default).
  const tail = fromOffset > 0 ? logContent.slice(fromOffset) : logContent;
  if (!RATE_LIMIT_PATTERN.test(tail)) return { hit: false, resetAt: null };
  return { hit: true, resetAt: parseRateLimitResetTime(tail) };
}

/**
 * Parse the reset time from a Claude Code rate-limit message.
 * Handles: "You've hit your limit · resets 6pm (Asia/Shanghai)", "resets 18:00 (UTC)", etc.
 * Returns the next occurrence of that clock time (today or tomorrow) + 5-minute buffer,
 * or null if parsing fails.
 */
export function parseRateLimitResetTime(logContent: string): Date | null {
  const match = logContent.match(
    /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i
  );
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();
  const timezone = match[4]?.trim() ?? 'UTC';

  if (ampm === 'pm' && hours !== 12) hours += 12;
  else if (ampm === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); } catch { return null; }

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);

  const currentSec = get('hour') * 3600 + get('minute') * 60 + get('second');
  const resetSec = hours * 3600 + minutes * 60;
  let diffSec = resetSec - currentSec;
  if (diffSec <= 0) diffSec += 86400;

  // Add 5-minute buffer after the reset time
  return new Date(now.getTime() + diffSec * 1000 + 5 * 60 * 1000);
}
