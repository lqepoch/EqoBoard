'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../tools/auto_merge/required-checks.json');
const pr16CheckRuns = require('./fixtures/auto_merge/pr16-check-runs.json');
const {
  classifyChangedFiles,
  evaluatePolicySnapshot,
  mergeRequiredChecks,
  latestStatusesByContext,
  validateRequiredChecks,
} = require('../tools/auto_merge/policy.cjs');
const { runAutoMerge } = require('../tools/auto_merge/orchestrator.cjs');

const REPOSITORY = 'lqepoch/EqoBoard';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const WORKFLOW_ID = 42;
const CHECK_SUITE_ID = 777;
const REVIEWER = { login: 'independent-reviewer', type: 'User' };

function makePr(overrides = {}) {
  return {
    number: 9,
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    user: { login: 'LQ-Epoch', type: 'User' },
    head: { ref: 'topic', sha: HEAD, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', sha: BASE, repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

function makeRun(pr = makePr(), overrides = {}) {
  return {
    id: 99,
    run_number: 12,
    run_attempt: 1,
    name: manifest.ci_workflow_name,
    path: manifest.ci_workflow_file,
    workflow_id: WORKFLOW_ID,
    check_suite_id: CHECK_SUITE_ID,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: REPOSITORY },
    head_branch: pr.head.ref,
    head_sha: pr.head.sha,
    created_at: '2026-10-07T10:00:00Z',
    pull_requests: [{
      number: pr.number,
      head: { ref: pr.head.ref, sha: pr.head.sha, repo: { full_name: REPOSITORY } },
      base: { ref: pr.base.ref, sha: pr.base.sha, repo: { full_name: REPOSITORY } },
    }],
    ...overrides,
  };
}

function makeCheckRuns(headSha = HEAD, overrides = {}) {
  return [...manifest.required_checks, ...manifest.guard_checks].map((check, index) => ({
    id: index + 1,
    name: check.context,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-07T10:10:00Z',
    app: { id: index + 100, slug: check.app_slug },
    check_suite: { id: check.bind_to_workflow_run ? CHECK_SUITE_ID : CHECK_SUITE_ID + 1 },
    ...((overrides && overrides[check.context]) || {}),
  }));
}

function makeReview(state = 'APPROVED', overrides = {}) {
  return {
    id: 11,
    state,
    submitted_at: '2026-10-07T10:15:00Z',
    commit_id: HEAD,
    user: REVIEWER,
    ...overrides,
  };
}

function makeStatus(id, context, state, secondsAfterBase = id) {
  const updatedAt = new Date(Date.parse('2026-10-07T10:00:00Z') + secondsAfterBase * 1000).toISOString();
  return {
    id,
    context,
    state,
    updated_at: updatedAt,
    creator: { login: 'github-actions[bot]' },
  };
}

function makePolicyInput(overrides = {}) {
  const pr = overrides.pr || makePr();
  const run = overrides.run || makeRun(pr);
  return {
    trigger: { eventName: 'workflow_run', ref: 'refs/heads/main' },
    run,
    relatedPullRequests: run.pull_requests,
    pr,
    workflow: { id: WORKFLOW_ID, name: manifest.ci_workflow_name, path: manifest.ci_workflow_file, state: 'active' },
    expectedRepository: REPOSITORY,
    baseBranch: 'main',
    trustedAuthors: ['LQ-Epoch'],
    permissions: {
      'lq-epoch': { permission: 'admin', role_name: 'admin' },
      'independent-reviewer': { permission: 'write', role_name: 'write' },
    },
    files: [{ filename: 'README.md', status: 'modified' }],
    reviews: [],
    unresolvedThreads: [],
    checkRuns: makeCheckRuns(pr.head.sha),
    statuses: [],
    manifestChecks: manifest.required_checks,
    guardChecks: manifest.guard_checks,
    rules: [],
    ...overrides,
  };
}

function createGithubMock(overrides = {}) {
  const pr = overrides.pr || makePr();
  const run = overrides.run || makeRun(pr);
  const state = {
    prGets: 0,
    mergeCalls: [],
    workflowRunListCalls: 0,
    reviewListCalls: 0,
    fileListCalls: 0,
    statusListCalls: 0,
    mergeResult: { merged: true, sha: MERGE },
    mergedPrVisible: true,
    prSnapshots: null,
    ...overrides.state,
  };
  const copy = (value) => structuredClone(value);
  const currentPr = () => {
    if (state.prSnapshots && state.prGets <= state.prSnapshots.length) {
      return copy(state.prSnapshots[state.prGets - 1]);
    }
    if (state.merged && state.mergedPrVisible) {
      return { ...copy(pr), state: 'closed', merged: true, merge_commit_sha: MERGE };
    }
    return copy(pr);
  };
  const page = (items, pageNo, key) => {
    const rows = items.slice((pageNo - 1) * 100, pageNo * 100);
    if (key) return { data: { total_count: items.length, [key]: rows }, headers: {} };
    return { data: rows, headers: {} };
  };
  const files = overrides.files || [{ filename: 'README.md', status: 'modified' }];
  const reviews = overrides.reviews || [];
  const checkRuns = overrides.checkRuns || makeCheckRuns(pr.head.sha);
  const statuses = overrides.statuses || [];
  const combinedStatuses = latestStatusesByContext(statuses);
  const combinedStatusTotalCount = overrides.combinedStatusTotalCount ?? combinedStatuses.statuses.length;
  const runs = overrides.runs || [run];
  const threadsPages = overrides.threadsPages || [{ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }];
  const rules = overrides.rules || [];
  const permissions = {
    'lq-epoch': { permission: 'admin', role_name: 'admin' },
    'independent-reviewer': { permission: 'write', role_name: 'write' },
    ...(overrides.permissions || {}),
  };

  const github = {
    request: async (route, parameters) => {
      if (route.includes('/actions/workflows/')) {
        return { data: { id: WORKFLOW_ID, name: manifest.ci_workflow_name, path: manifest.ci_workflow_file, state: 'active' } };
      }
      if (route.includes('/collaborators/') && route.endsWith('/permission')) {
        const login = parameters.username.toLowerCase();
        const permission = permissions[login];
        if (!permission) {
          const error = new Error('not a collaborator');
          error.status = 404;
          throw error;
        }
        return { data: permission };
      }
      if (route.includes('/rules/branches/')) return { data: copy(rules) };
      throw new Error(`unexpected REST route ${route}`);
    },
    graphql: async (_query, variables) => {
      const pageNo = variables.cursor ? Number(variables.cursor.replace('cursor-', '')) + 1 : 1;
      const current = threadsPages[pageNo - 1];
      if (!current) throw new Error('thread page missing');
      return { repository: { pullRequest: { reviewThreads: copy(current) } } };
    },
    rest: {
      pulls: {
        get: async () => {
          state.prGets += 1;
          return { data: currentPr() };
        },
        listFiles: async ({ page: pageNo }) => {
          state.fileListCalls += 1;
          return page(files, pageNo);
        },
        listReviews: async ({ page: pageNo }) => {
          state.reviewListCalls += 1;
          const reviewRows = typeof overrides.reviewsForCall === 'function'
            ? overrides.reviewsForCall(state.reviewListCalls)
            : reviews;
          return page(reviewRows, pageNo);
        },
        merge: async (parameters) => {
          state.mergeCalls.push(copy(parameters));
          if (parameters.sha !== pr.head.sha) {
            const error = new Error('head SHA changed');
            error.status = 409;
            throw error;
          }
          if (overrides.mergeError) throw overrides.mergeError;
          state.merged = true;
          return { data: copy(state.mergeResult) };
        },
      },
      checks: {
        listForRef: async ({ page: pageNo }) => page(checkRuns, pageNo, 'check_runs'),
      },
      repos: {
        getCombinedStatusForRef: async () => ({
          data: {
            sha: pr.head.sha,
            state: 'success',
            total_count: combinedStatusTotalCount,
            statuses: overrides.combinedStatusRows || combinedStatuses.statuses.slice(0, 30),
          },
        }),
        listCommitStatusesForRef: async ({ page: pageNo }) => {
          state.statusListCalls += 1;
          return page(statuses, pageNo);
        },
      },
      actions: {
        listWorkflowRuns: async ({ page: pageNo }) => {
          state.workflowRunListCalls += 1;
          return page(runs, pageNo, 'workflow_runs');
        },
      },
    },
  };
  return { github, state };
}

function makeContext(eventName = 'workflow_run', run = makeRun()) {
  return {
    repo: { owner: 'lqepoch', repo: 'EqoBoard' },
    eventName,
    ref: 'refs/heads/main',
    payload: eventName === 'workflow_run'
      ? { workflow_run: run }
      : { inputs: { pull_number: '9' } },
  };
}

test('sensitivity covers identity, trading, gateway, config, compose, workflow, skills and both rename names', () => {
  const paths = [
    'apps/openterminal/web/app/api/eqo/orders/route.ts',
    'apps/openterminal/server/src/auth.ts',
    'crates/domain/src/lib.rs',
    'crates/execution/src/lib.rs',
    'apps/gateway/src/main.rs',
    'compose.yaml',
    'Dockerfile.runtime',
    '.env.example',
    '.github/workflows/ci.yml',
    'apps/openterminal/AGENTS.md',
    '.agents/skills/github-ci/SKILL.md',
    'tools/auto_merge/policy.cjs',
    'Cargo.lock',
    'apps/openterminal/web/app/page.tsx',
  ];
  const files = paths.map((filename) => ({ filename, status: 'modified' }));
  const result = classifyChangedFiles(files);
  assert.equal(result.valid, true);
  assert.equal(result.sensitive, true);
  assert.equal(classifyChangedFiles([{ filename: 'docs/new.md', previous_filename: '.github/workflows/old.yml', status: 'renamed' }]).sensitive, true);
  assert.equal(classifyChangedFiles([{ filename: 'docs/new.md', previous_filename: 'docs/old.md', status: 'renamed' }]).sensitive, false);
  assert.equal(classifyChangedFiles([{ filename: 'docs/new.md', status: 'renamed' }]).valid, false);
});

test('legacy counterexamples all become sensitive and cannot merge without a valid current-head human approval', async (t) => {
  const scenarios = [
    {
      name: 'old external approval for sensitive execution path',
      files: [{ filename: 'crates/execution/src/lib.rs', status: 'modified' }],
      reviews: [makeReview('APPROVED', { commit_id: 'd'.repeat(40), user: { login: 'outside-reviewer', type: 'User' } })],
      permissions: {},
    },
    {
      name: 'BFF API path with no approval',
      files: [{ filename: 'apps/openterminal/web/app/api/eqo/orders/route.ts', status: 'modified' }],
      reviews: [],
    },
    {
      name: 'rename from workflow path to a harmless path',
      files: [{ filename: 'docs/renamed.md', previous_filename: '.github/workflows/pr-auto-merge.yml', status: 'renamed' }],
      reviews: [],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const mock = createGithubMock(scenario);
      const result = await runAutoMerge({
        github: mock.github,
        context: makeContext(),
      });
      assert.equal(result.state, 'blocked');
      assert.equal(mock.state.mergeCalls.length, 0);
      assert.ok(mock.state.fileListCalls > 0);
    });
  }
});

test('valid collaborator approvals from write, maintain, or admin count only when independent and bound to current head', () => {
  for (const role of ['write', 'maintain', 'admin']) {
    const input = makePolicyInput({
      files: [{ filename: 'crates/execution/src/lib.rs', status: 'modified' }],
      reviews: [makeReview()],
      permissions: {
        'lq-epoch': { permission: 'admin' },
        'independent-reviewer': { permission: role, role_name: role },
      },
    });
    assert.equal(evaluatePolicySnapshot(input).eligible, true, role);
  }

  const authorApproval = makePolicyInput({
    files: [{ filename: 'crates/execution/src/lib.rs' }],
    reviews: [makeReview('APPROVED', { user: { login: 'LQ-Epoch', type: 'User' } })],
  });
  assert.ok(evaluatePolicySnapshot(authorApproval).reasons.includes('sensitive-change-needs-independent-current-head-approval'));

  const appApproval = makePolicyInput({
    files: [{ filename: 'crates/domain/src/lib.rs' }],
    reviews: [makeReview('APPROVED', { user: { login: 'reviewer-app[bot]', type: 'Bot' } })],
    permissions: { 'reviewer-app[bot]': { permission: 'admin' } },
  });
  assert.ok(evaluatePolicySnapshot(appApproval).reasons.includes('sensitive-change-needs-independent-current-head-approval'));
});

test('latest review must be current-head approval; changes requested and unresolved threads block', () => {
  const staleLast = makePolicyInput({
    files: [{ filename: 'apps/gateway/src/main.rs' }],
    reviews: [
      makeReview('APPROVED', { id: 1, submitted_at: '2026-10-07T10:00:00Z' }),
      makeReview('APPROVED', { id: 2, submitted_at: '2026-10-07T10:20:00Z', commit_id: 'd'.repeat(40) }),
    ],
  });
  assert.ok(evaluatePolicySnapshot(staleLast).reasons.includes('sensitive-change-needs-independent-current-head-approval'));

  const changesRequested = makePolicyInput({
    reviews: [makeReview('CHANGES_REQUESTED')],
  });
  assert.ok(evaluatePolicySnapshot(changesRequested).reasons.includes('changes-requested'));

  const commentedAfterApproval = makePolicyInput({
    files: [{ filename: 'crates/execution/src/lib.rs' }],
    reviews: [
      makeReview('APPROVED', { id: 1, submitted_at: '2026-10-07T10:00:00Z' }),
      makeReview('COMMENTED', { id: 2, submitted_at: '2026-10-07T10:20:00Z' }),
    ],
  });
  assert.ok(evaluatePolicySnapshot(commentedAfterApproval).reasons.includes('sensitive-change-needs-independent-current-head-approval'));

  const dismissedAfterApproval = makePolicyInput({
    files: [{ filename: 'crates/execution/src/lib.rs' }],
    reviews: [
      makeReview('APPROVED', { id: 1, submitted_at: '2026-10-07T10:00:00Z' }),
      makeReview('DISMISSED', { id: 2, submitted_at: '2026-10-07T10:20:00Z' }),
    ],
  });
  assert.ok(evaluatePolicySnapshot(dismissedAfterApproval).reasons.includes('sensitive-change-needs-independent-current-head-approval'));

  const unresolved = makePolicyInput({ unresolvedThreads: [{ id: 'thread-1' }] });
  assert.ok(evaluatePolicySnapshot(unresolved).reasons.includes('unresolved-review-threads'));
});

test('required check union is exact and missing, unknown, pending, stale or failed checks block', () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Release Gate', integration_id: null }] } }];
  const plan = mergeRequiredChecks(manifest.required_checks, rules);
  assert.equal(plan.valid, true);
  assert.ok(plan.checks.some((check) => check.context === 'Release Gate'));
  assert.equal(plan.checks.some((check) => check.context === 'Trusted PR Auto Merge'), false);

  const baseline = makeCheckRuns(HEAD);
  const required = manifest.required_checks;
  const allDeclared = mergeRequiredChecks(required, [], manifest.guard_checks).checks;
  assert.deepEqual(validateRequiredChecks({ checks: baseline, statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }), []);
  assert.ok(validateRequiredChecks({ checks: baseline.slice(1), statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).some((reason) => reason.startsWith('check-missing:')));

  for (const change of [
    { status: 'queued', conclusion: null },
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'neutral' },
    { status: 'complete-ish', conclusion: 'success' },
    { status: 'completed', conclusion: 'success', app: { id: 111, slug: 'unexpected-app' } },
  ]) {
    const altered = makeCheckRuns(HEAD, { [required[0].context]: change });
    assert.ok(validateRequiredChecks({ checks: altered, statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).length > 0);
  }
  assert.ok(validateRequiredChecks({ checks: baseline, statuses: [], requiredChecks: allDeclared, headSha: 'd'.repeat(40), expectedCheckSuiteId: CHECK_SUITE_ID }).length > 0);
  assert.ok(validateRequiredChecks({ checks: baseline, statuses: [], requiredChecks: [{ context: 'Release Gate', integrationId: null, source: 'ruleset' }], headSha: HEAD }).includes('check-missing:Release Gate'));
  assert.ok(mergeRequiredChecks([], []).valid === false);
  const missingOptional = baseline.filter((run) => run.name !== 'CodeQL');
  assert.deepEqual(validateRequiredChecks({ checks: missingOptional, statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }), []);
  const unknownContext = [...baseline, { name: 'Unmanifested CI', head_sha: HEAD, status: 'completed', conclusion: 'success', started_at: '2026-10-07T10:10:00Z', app: { slug: 'github-actions' } }];
  assert.ok(validateRequiredChecks({ checks: unknownContext, statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).includes('check-context-unrecognized:Unmanifested CI'));
  const forgedSuite = baseline.map((run) => run.name === required[0].context ? { ...run, check_suite: { id: CHECK_SUITE_ID + 99 } } : run);
  assert.ok(validateRequiredChecks({ checks: forgedSuite, statuses: [], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).includes(`check-suite-mismatch:${required[0].context}`));
  assert.ok(validateRequiredChecks({ checks: baseline, statuses: [{ context: required[0].context, state: 'failure', creator: { login: 'github-actions[bot]' } }], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).includes(`status-not-success-or-untrusted:${required[0].context}`));
  assert.ok(validateRequiredChecks({ checks: baseline, statuses: [{ context: 'Unmanifested status', state: 'success', creator: { login: 'github-actions[bot]' } }], requiredChecks: allDeclared, headSha: HEAD, expectedCheckSuiteId: CHECK_SUITE_ID }).includes('status-context-unrecognized:Unmanifested status'));
});

test('live GitHub check-run fixture binds the real three required jobs and known security guards', () => {
  const declarations = mergeRequiredChecks(manifest.required_checks, [], manifest.guard_checks).checks;
  assert.deepEqual(validateRequiredChecks({
    checks: pr16CheckRuns.check_runs,
    statuses: [],
    requiredChecks: declarations,
    headSha: pr16CheckRuns.head_sha,
    expectedCheckSuiteId: pr16CheckRuns.ci_check_suite_id,
  }), []);
  assert.equal(manifest.required_checks.length, 3);
});

test('run and PR must be trusted, linked, non-forked, non-draft, authored by allowlist, and on main', () => {
  const candidates = [
    { pr: makePr({ draft: true }), reason: 'pull-request-not-open-ready' },
    { pr: makePr({ head: { ref: 'topic', sha: HEAD, repo: { full_name: 'forker/EqoBoard' } } }), reason: 'fork-or-missing-head-repository' },
    { pr: makePr({ user: { login: 'other-user', type: 'User' } }), reason: 'author-not-allowlisted' },
    { pr: makePr({ mergeable: false }), reason: 'pull-request-not-mergeable' },
    { trigger: { eventName: 'workflow_dispatch', ref: 'refs/heads/topic' }, reason: 'untrusted-trigger-ref' },
  ];
  for (const candidate of candidates) {
    const pr = candidate.pr || makePr();
    const run = makeRun(pr);
    const input = makePolicyInput({ pr, run, relatedPullRequests: run.pull_requests });
    if (candidate.trigger) input.trigger = candidate.trigger;
    assert.ok(evaluatePolicySnapshot(input).reasons.includes(candidate.reason), candidate.reason);
  }
  const noLink = makePolicyInput({ relatedPullRequests: [] });
  assert.ok(evaluatePolicySnapshot(noLink).reasons.includes('ci-run-must-link-one-pull-request'));
});

test('orchestrator merges a fresh trusted candidate using expected head SHA and verifies the merged PR', async () => {
  const pr = makePr();
  const run = makeRun(pr);
  const mock = createGithubMock({ pr, run, files: [{ filename: 'README.md', status: 'modified' }] });
  const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
  assert.equal(result.state, 'merged');
  assert.equal(mock.state.mergeCalls.length, 1);
  assert.equal(mock.state.mergeCalls[0].sha, HEAD);
  assert.equal(mock.state.mergeCalls[0].merge_method, 'squash');
  assert.equal(mock.state.workflowRunListCalls, 2);
});

test('workflow_dispatch reuses the latest successful linked CI run without triggering a new CI run', async () => {
  const pr = makePr();
  const run = makeRun(pr);
  const mock = createGithubMock({ pr, runs: [run] });
  const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_dispatch') });
  assert.equal(result.state, 'merged');
  assert.equal(mock.state.workflowRunListCalls, 2);
});

test('REST and GraphQL pagination is complete before any merge decision', async () => {
  const pr = makePr();
  const run = makeRun(pr);
  const files = Array.from({ length: 101 }, (_value, index) => ({ filename: `docs/file-${index}.md`, status: 'modified' }));
  const threadsPages = [
    { nodes: [{ id: 'resolved-1', isResolved: true }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
    { nodes: [{ id: 'resolved-2', isResolved: true }], pageInfo: { hasNextPage: false, endCursor: 'cursor-2' } },
  ];
  const mock = createGithubMock({ pr, run, files, threadsPages });
  const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
  assert.equal(result.state, 'merged');
  assert.equal(mock.state.fileListCalls, 4);
});

test('paginated commit-status history finds hidden contexts and uses only the latest status per context', async (t) => {
  await t.test('unknown 31st context omitted from combined-status default page blocks', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const names = Array.from({ length: 30 }, (_value, index) => `Ruleset Gate ${index + 1}`);
    const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: names.map((context) => ({ context })) } }];
    const statuses = [
      ...names.map((context, index) => makeStatus(index + 1, context, 'success')),
      makeStatus(31, 'Unmanifested Gate 31', 'success'),
    ];
    const mock = createGithubMock({ pr, run, rules, statuses, combinedStatusRows: statuses.slice(0, 30) });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
    assert.equal(mock.state.statusListCalls, 1);
    assert.ok(result.reasons.includes('status-context-unrecognized:Unmanifested Gate 31'));
  });

  await t.test('101 historical rows paginate and an older failure is replaced by latest success', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const context = manifest.required_checks[0].context;
    const statuses = Array.from({ length: 101 }, (_value, index) => makeStatus(
      index + 1,
      context,
      index === 100 ? 'success' : 'failure',
      index + 1,
    ));
    const mock = createGithubMock({ pr, run, statuses });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'merged');
    assert.equal(mock.state.mergeCalls.length, 1);
    assert.equal(mock.state.statusListCalls, 4);
  });
});

test('head or base update before merge, latest-run failure, or merge SHA conflict never retries or merges stale state', async (t) => {
  await t.test('base changes on final PR fetch', async () => {
    const pr = makePr();
    const changedBase = makePr({ base: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: REPOSITORY } } });
    const run = makeRun(pr);
    const mock = createGithubMock({ pr, run, state: { prSnapshots: [pr, changedBase] } });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('latest linked CI run is pending', async () => {
    const pr = makePr();
    const run = makeRun(pr, { status: 'in_progress', conclusion: null, id: 101, run_number: 13 });
    const mock = createGithubMock({ pr, run });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('merge endpoint reports head conflict', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const error = new Error('expected sha conflict');
    error.status = 409;
    const mock = createGithubMock({ pr, run, mergeError: error });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 1);
  });
});

test('approval loss during final refresh and failed CodeQL block before merge', async (t) => {
  await t.test('approval changes to request-changes before write', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const reviews = [makeReview()];
    const mock = createGithubMock({
      pr,
      run,
      files: [{ filename: 'crates/execution/src/lib.rs', status: 'modified' }],
      reviews,
      reviewsForCall: (call) => call <= 1 ? reviews : [makeReview('CHANGES_REQUESTED')],
    });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('CodeQL non-success is not ignored as a non-required external check', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const checkRuns = makeCheckRuns(HEAD, { CodeQL: { status: 'completed', conclusion: 'failure' } });
    const mock = createGithubMock({ pr, run, checkRuns });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('same-name job from another check suite cannot impersonate the current CI run', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const checkRuns = makeCheckRuns(HEAD);
    checkRuns.find((entry) => entry.name === manifest.required_checks[0].context).check_suite.id += 99;
    const mock = createGithubMock({ pr, run, checkRuns });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
    assert.ok(result.reasons.some((reason) => reason.startsWith('check-suite-mismatch:')));
  });
  await t.test('failed matching commit status cannot be masked by a successful check run', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const context = manifest.required_checks[0].context;
    const mock = createGithubMock({
      pr,
      run,
      statuses: [makeStatus(1, context, 'failure')],
    });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
    assert.ok(result.reasons.includes(`status-not-success-or-untrusted:${context}`), JSON.stringify(result.reasons));
  });
});

test('missing linkage, bad API pages, and failed merge verification fail closed', async (t) => {
  await t.test('workflow run has no pull request association', async () => {
    const pr = makePr();
    const run = makeRun(pr, { pull_requests: [] });
    const mock = createGithubMock({ pr, run });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('GraphQL pagination cursor failure blocks', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const mock = createGithubMock({ pr, run, threadsPages: [{ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }] });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 0);
  });
  await t.test('post-merge state is not verified', async () => {
    const pr = makePr();
    const run = makeRun(pr);
    const mock = createGithubMock({ pr, run, state: { mergedPrVisible: false } });
    const result = await runAutoMerge({ github: mock.github, context: makeContext('workflow_run', run) });
    assert.equal(result.state, 'blocked');
    assert.equal(mock.state.mergeCalls.length, 1);
  });
});
