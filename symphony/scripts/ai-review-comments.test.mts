/**
 * ai-review-comments.test.mts — verify codexCommentMatchesSha() detects an AI
 * review that landed as a PR issue comment (UP-832). Run with:
 *
 *   node --experimental-strip-types --test symphony/scripts/ai-review-comments.test.mts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexCommentMatchesSha, isCodexReviewCommentForSha, type IssueComment } from './ai-review-comments.mts';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const codex = (body: string): IssueComment => ({
  body,
  user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
});

test('matches a Codex issue comment whose Reviewed commit marker equals the head SHA', () => {
  const comment = codex(`Codex Review: Didn't find any major issues.\n\nReviewed commit: ${HEAD}`);
  assert.equal(isCodexReviewCommentForSha(comment, HEAD), true);
});

test('matches an abbreviated Reviewed commit marker (prefix of head SHA)', () => {
  const comment = codex('Codex Review: LGTM.\n\nReviewed commit: a1b2c3d');
  assert.equal(isCodexReviewCommentForSha(comment, HEAD), true);
});

test('matches when the SHA is wrapped in backticks or a markdown link', () => {
  assert.equal(isCodexReviewCommentForSha(codex('Reviewed commit: `a1b2c3d4`'), HEAD), true);
  assert.equal(isCodexReviewCommentForSha(codex('Reviewed commit: [a1b2c3d4](http://x)'), HEAD), true);
});

test('does NOT match a Reviewed commit marker for a different SHA', () => {
  const comment = codex('Reviewed commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(isCodexReviewCommentForSha(comment, HEAD), false);
});

test('does NOT match a bot comment without the Reviewed commit marker', () => {
  assert.equal(isCodexReviewCommentForSha(codex('To use Codex here, mention @codex.'), HEAD), false);
});

test('does NOT match the marker when posted by a non-bot human author', () => {
  const human: IssueComment = {
    body: `Reviewed commit: ${HEAD}`,
    user: { login: 'some-person', type: 'User' },
  };
  assert.equal(isCodexReviewCommentForSha(human, HEAD), false);
});

test('matches a non-bot author whose login mentions codex', () => {
  const comment: IssueComment = {
    body: `Reviewed commit: ${HEAD}`,
    user: { login: 'codex-reviewer', type: 'User' },
  };
  assert.equal(isCodexReviewCommentForSha(comment, HEAD), true);
});

test('empty sha never matches', () => {
  assert.equal(isCodexReviewCommentForSha(codex(`Reviewed commit: ${HEAD}`), ''), false);
});

test('codexCommentMatchesSha finds the match among many comments', () => {
  const comments: IssueComment[] = [
    { body: '@codex review', user: { login: 'Stupidism', type: 'User' } },
    codex('To use Codex here, mention @codex.'),
    codex(`Codex Review: looks good.\n\nReviewed commit: ${HEAD}`),
  ];
  assert.equal(codexCommentMatchesSha(comments, HEAD), true);
});

test('codexCommentMatchesSha returns false when no comment matches', () => {
  const comments: IssueComment[] = [
    { body: '@codex review', user: { login: 'Stupidism', type: 'User' } },
    codex('Reviewed commit: deadbeefdeadbeef'),
  ];
  assert.equal(codexCommentMatchesSha(comments, HEAD), false);
});

test('codexCommentMatchesSha handles an empty comment list', () => {
  assert.equal(codexCommentMatchesSha([], HEAD), false);
});
