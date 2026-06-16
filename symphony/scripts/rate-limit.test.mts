/**
 * rate-limit.test.mts — verify the rate-limit banner detection & reset-time
 * parsing extracted from poll-tickets.mts (UP-831).
 *
 * Run with:
 *   node --experimental-strip-types --test symphony/scripts/rate-limit.test.mts
 *
 * The whole point of the extraction is that RATE_LIMIT_PATTERN must NOT match
 * innocent log lines that merely mention "rate limit" — the old loose pattern
 * caused a restart-suicide loop when any agent log contained "rate-limit".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_PATTERN, parseRateLimitResetTime, scanTailForRateLimit } from './rate-limit.mts';

// ── RATE_LIMIT_PATTERN ───────────────────────────────────────────────────────

test('RATE_LIMIT_PATTERN matches the real Claude banner', () => {
  assert.ok(RATE_LIMIT_PATTERN.test("You've hit your limit · resets 6pm (Asia/Shanghai)"));
  assert.ok(RATE_LIMIT_PATTERN.test('You’ve hit your limit · resets 18:00 (UTC)')); // curly apostrophe
  assert.ok(RATE_LIMIT_PATTERN.test("You've hit your limit, resets at 11am"));
});

test('RATE_LIMIT_PATTERN does NOT match innocent lines mentioning rate limit (UP-831)', () => {
  // These all matched the old loose /rate.?limit/i and triggered self-DOS.
  assert.ok(!RATE_LIMIT_PATTERN.test('npm warn: you may be rate-limited by the registry'));
  assert.ok(!RATE_LIMIT_PATTERN.test('Error: GitHub API rate limit exceeded'));
  assert.ok(!RATE_LIMIT_PATTERN.test('// TODO: add a rate-limiter to this endpoint'));
  assert.ok(!RATE_LIMIT_PATTERN.test('const RATE_LIMIT_PATTERN = /ratelimit/i;'));
  assert.ok(!RATE_LIMIT_PATTERN.test("You've hit your limit")); // banner without "resets"
});

// ── parseRateLimitResetTime ──────────────────────────────────────────────────

test('parseRateLimitResetTime returns null for unparseable text', () => {
  assert.equal(parseRateLimitResetTime("You've hit your limit"), null);
  assert.equal(parseRateLimitResetTime('no reset clause here'), null);
  assert.equal(parseRateLimitResetTime('resets soon'), null);
});

test('parseRateLimitResetTime rejects invalid clock values', () => {
  assert.equal(parseRateLimitResetTime('resets 25:00 (UTC)'), null);
  assert.equal(parseRateLimitResetTime('resets 10:99 (UTC)'), null);
});

test('parseRateLimitResetTime rejects an invalid timezone', () => {
  assert.equal(parseRateLimitResetTime('resets 6pm (Not/AZone)'), null);
});

test('parseRateLimitResetTime returns a future date for a valid banner', () => {
  const reset = parseRateLimitResetTime("You've hit your limit · resets 6pm (UTC)");
  assert.ok(reset instanceof Date);
  assert.ok(reset!.getTime() > Date.now());
});

// ── scanTailForRateLimit (SY-66 adopted-agent completion handling) ───────────

test('scanTailForRateLimit detects a banner written after the adoption offset', () => {
  const pre = 'starting session\nnormal work line\n';
  const log = pre + "You've hit your limit · resets 6pm (UTC)\n";
  const res = scanTailForRateLimit(log, pre.length);
  assert.equal(res.hit, true);
  assert.ok(res.resetAt instanceof Date);
  assert.ok(res.resetAt!.getTime() > Date.now());
});

test('scanTailForRateLimit ignores a stale banner that precedes the offset', () => {
  // A banner left by a PREVIOUS run-ticket.sh invocation, before we adopted the
  // agent — must NOT trigger a pause (the whole reason we record an offset).
  const stale = "You've hit your limit · resets 6pm (UTC)\n";
  const log = stale + 'new session after adoption\nharmless rate-limit mention\n';
  const res = scanTailForRateLimit(log, stale.length);
  assert.equal(res.hit, false);
  assert.equal(res.resetAt, null);
});

test('scanTailForRateLimit with offset 0 scans the whole log', () => {
  assert.equal(scanTailForRateLimit("You've hit your limit · resets 6pm (UTC)").hit, true);
  assert.equal(scanTailForRateLimit('just an innocent rate-limit log line').hit, false);
});

test('scanTailForRateLimit returns hit but null reset for an unparseable banner', () => {
  // Banner present but no parseable reset clause — caller treats null reset as
  // "do not pause" so a single malformed line never wedges the poller.
  const res = scanTailForRateLimit("You've hit your limit and resets sometime");
  assert.equal(res.hit, true);
  assert.equal(res.resetAt, null);
});
