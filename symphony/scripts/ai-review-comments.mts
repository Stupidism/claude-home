/**
 * ai-review-comments.mts — pure helpers for detecting an AI code review that
 * landed as a PR *issue comment* rather than a formal PR review.
 *
 * Background (UP-832): `@codex review` sometimes posts its verdict via
 * `/repos/.../issues/N/comments` (an issue comment) instead of
 * `/repos/.../pulls/N/reviews` (a formal review). `gh pr view --json reviews`
 * only returns the latter, so the review was invisible to `hasReviewForSha`
 * and the `symphony/ai-reviewed` commit status stayed `pending` forever.
 *
 * Codex includes a `Reviewed commit: <sha>` marker in its comment body. This
 * module parses that marker and ties it to the PR head SHA, so the poller can
 * treat the comment as proof a review ran against the current HEAD.
 *
 * Kept side-effect free (no imports, no I/O) so it is unit-testable in
 * isolation — poll-tickets.mts has heavy import-time side effects.
 */

/** A GitHub issue comment, narrowed to the fields we inspect. */
export interface IssueComment {
  body?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
}

/**
 * True when `comment` looks like an AI reviewer's verdict whose
 * `Reviewed commit: <sha>` marker matches `sha`.
 *
 * Guarded by author so a human quoting the marker can't flip the status:
 * the comment must come from a bot (`user.type === 'Bot'`) or an account whose
 * login mentions codex. SHA comparison is prefix-tolerant in both directions
 * because Codex may print an abbreviated SHA while the PR head is the full
 * 40-char oid.
 */
export function isCodexReviewCommentForSha(comment: IssueComment, sha: string): boolean {
  if (!sha) return false;
  const login = (comment.user?.login ?? '').toLowerCase();
  const isBot = comment.user?.type === 'Bot';
  if (!isBot && !login.includes('codex')) return false;

  // Optional `[` (markdown link) or backtick before the hash; Codex formats
  // the marker a few different ways.
  const match = (comment.body ?? '').match(/reviewed commit:\s*[`[]?([0-9a-f]{7,40})/i);
  if (!match) return false;

  const reviewed = match[1]!.toLowerCase();
  const head = sha.toLowerCase();
  return head.startsWith(reviewed) || reviewed.startsWith(head);
}

/** True when any comment in `comments` is an AI review verdict for `sha`. */
export function codexCommentMatchesSha(comments: IssueComment[], sha: string): boolean {
  return comments.some((c) => isCodexReviewCommentForSha(c, sha));
}
