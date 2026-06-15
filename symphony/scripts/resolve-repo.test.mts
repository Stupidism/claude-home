/**
 * resolve-repo.test.mts — verify the multi-repo branch-detection logic added to
 * poll-tickets.mts:resolveRepo / resolveRepoByPR (UP-824).
 *
 * Run with:
 *   node --experimental-strip-types --test symphony/scripts/resolve-repo.test.mts
 *
 * poll-tickets.mts has heavy import-time side effects (singleton lock, config
 * load, network), so — exactly like poll-tickets-stdin.test.mts — we re-create
 * the decision logic in isolation against a stubbed GitHub probe and assert the
 * behaviours the fix guarantees. The reproduction below mirrors the production
 * `resolveRepoByPR` + `resolveRepo` and must stay in lockstep with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

type RepoConfig = { name: string; githubRepo: string };
type Project = { primaryRepo: string; repos: Array<{ name: string }> };
type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

/** Stubbed `gh pr list --state all --json state`: the PRs each repo slug returns. */
type Probe = (githubRepo: string) => PRState[];

/** Mirror of poll-tickets.mts:resolveRepoByPR (gh spawn replaced by `probe`). */
function resolveRepoByPR(
  project: Project,
  repoMap: Map<string, RepoConfig>,
  probe: Probe,
): RepoConfig | null {
  for (const entry of project.repos) {
    const repo = repoMap.get(entry.name);
    if (!repo) continue;
    const prs = probe(repo.githubRepo);
    if (prs.some((s) => s === 'OPEN' || s === 'MERGED')) return repo;
  }
  return null;
}

/** Mirror of poll-tickets.mts:resolveRepo (Sentry path omitted — tested elsewhere). */
function makeResolveRepo(
  project: Project,
  repoMap: Map<string, RepoConfig>,
  defaultRepo: string,
  probe: Probe,
) {
  const cache = new Map<string, RepoConfig>();
  let probeCalls = 0;
  const countingProbe: Probe = (slug) => { probeCalls++; return probe(slug); };
  const resolve = (ticketId: string): RepoConfig => {
    const cached = cache.get(ticketId);
    if (cached) return cached;
    if (project.repos.length > 1) {
      const owner = resolveRepoByPR(project, repoMap, countingProbe);
      if (owner) { cache.set(ticketId, owner); return owner; }
    }
    return repoMap.get(project.primaryRepo) ?? repoMap.get(defaultRepo)!;
  };
  return { resolve, probeCalls: () => probeCalls };
}

const REPOS: RepoConfig[] = [
  { name: 'workstream-mono', githubRepo: 'ws/workstream-mono' },
  { name: 'workstream-hr', githubRepo: 'ws/workstream-hr' },
  { name: 'workstream-backend', githubRepo: 'ws/workstream-backend' },
];
const repoMap = new Map(REPOS.map((r) => [r.name, r]));
const hiring: Project = {
  primaryRepo: 'workstream-mono',
  repos: [{ name: 'workstream-mono' }, { name: 'workstream-hr' }, { name: 'workstream-backend' }],
};

test('resolves to the non-primary repo that actually owns the branch (UP-793 scenario)', () => {
  // PR lives in workstream-hr, not the primaryRepo workstream-mono.
  const { resolve } = makeResolveRepo(hiring, repoMap, 'workstream-mono', (s) => (s === 'ws/workstream-hr' ? ['MERGED'] : []));
  assert.equal(resolve('UP-793').name, 'workstream-hr');
});

test('falls back to primaryRepo when no candidate repo owns the branch (fresh spawn)', () => {
  const { resolve } = makeResolveRepo(hiring, repoMap, 'workstream-mono', () => []);
  assert.equal(resolve('UP-999').name, 'workstream-mono');
});

test('a stale CLOSED PR does not claim ownership — the open PR in a later repo wins', () => {
  // workstream-mono has a leftover closed PR (rework/reset); the real open PR is
  // in workstream-hr further down project.repos.
  const { resolve } = makeResolveRepo(hiring, repoMap, 'workstream-mono', (s) => {
    if (s === 'ws/workstream-mono') return ['CLOSED'];
    if (s === 'ws/workstream-hr') return ['OPEN'];
    return [];
  });
  assert.equal(resolve('UP-814').name, 'workstream-hr');
});

test('probe runs at most once per ticket — second resolve is cached', () => {
  const { resolve, probeCalls } = makeResolveRepo(hiring, repoMap, 'workstream-mono', (s) => (s === 'ws/workstream-hr' ? ['MERGED'] : []));
  resolve('UP-793');
  const before = probeCalls();
  resolve('UP-793');
  assert.equal(resolve('UP-793').name, 'workstream-hr');
  assert.equal(probeCalls(), before, 'cached resolve must not re-probe');
});

test('the primaryRepo fallback is NOT cached — a later cycle can still detect the branch', () => {
  let prExists = false;
  const { resolve } = makeResolveRepo(hiring, repoMap, 'workstream-mono', (s) => (prExists && s === 'ws/workstream-hr' ? ['OPEN'] : []));
  assert.equal(resolve('UP-810').name, 'workstream-mono', 'no PR yet → fallback');
  prExists = true; // branch pushed + PR opened on a later poll cycle
  assert.equal(resolve('UP-810').name, 'workstream-hr', 'fallback must not have been cached');
});

test('single-repo project skips the probe entirely', () => {
  const solo: Project = { primaryRepo: 'workstream-mono', repos: [{ name: 'workstream-mono' }] };
  const { resolve, probeCalls } = makeResolveRepo(solo, repoMap, 'workstream-mono', () => ['OPEN']);
  assert.equal(resolve('UP-1').name, 'workstream-mono');
  assert.equal(probeCalls(), 0, 'a single-repo project has no ambiguity to probe');
});

test('first repo in project.repos order wins when multiple own a PR', () => {
  // Iteration follows project.repos order: mono, hr, backend.
  const { resolve } = makeResolveRepo(hiring, repoMap, 'workstream-mono', () => ['OPEN']);
  assert.equal(resolve('UP-2').name, 'workstream-mono');
});
