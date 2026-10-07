'use strict';

const manifest = require('./required-checks.json');
const {
  EXPECTED_REPOSITORY,
  evaluatePolicySnapshot,
  latestStatusesByContext,
  mergeRequiredChecks,
} = require('./policy.cjs');

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_CHECK_RUNS_FOR_REF = 1_000;
const MAX_CHANGED_FILES = 3_000;
const TRUSTED_AUTHORS = ['LQ-Epoch'];

const THREADS_QUERY = `
  query PullRequestThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes { id isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function apiMessage(error) {
  const status = Number.isInteger(error && error.status) ? ` status=${error.status}` : '';
  return `GitHub API evidence unavailable${status}`;
}

function pageHasNext(response, itemCount) {
  const link = response && response.headers && response.headers.link;
  if (typeof link === 'string' && link.trim() !== '') {
    if (!/<[^>]+>\s*;\s*rel="next"/.test(link)) {
      if (/rel="(?:next|prev|first|last)"/.test(link)) return false;
      throw new Error('unrecognized REST pagination Link header');
    }
    return true;
  }
  return itemCount === PAGE_SIZE;
}

async function collectRestPages(request, parameters, collectionName) {
  const collected = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const response = await request({ ...parameters, page, per_page: PAGE_SIZE });
    const data = response && response.data;
    const items = Array.isArray(data) ? data : data && data[collectionName];
    if (!Array.isArray(items)) throw new Error(`GitHub API ${collectionName || 'list'} response is invalid`);
    collected.push(...items);
    if (collected.length > MAX_ITEMS) throw new Error('GitHub API pagination exceeded safe item bound');
    if (Number.isInteger(data && data.total_count) && data.total_count > MAX_CHECK_RUNS_FOR_REF && collectionName === 'check_runs') {
      throw new Error('GitHub check-run API result exceeds its 1000-suite evidence limit');
    }
    if (Number.isInteger(data && data.total_count) && collected.length >= data.total_count) return collected;
    if (!pageHasNext(response, items.length)) return collected;
    page += 1;
  }
  throw new Error('GitHub API pagination exceeded safe page bound');
}

async function loadReviewThreads(github, owner, repo, number) {
  const threads = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await github.graphql(THREADS_QUERY, { owner, repo, number, cursor });
    const connection = result && result.repository && result.repository.pullRequest && result.repository.pullRequest.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') {
      throw new Error('GitHub GraphQL review-thread response is invalid');
    }
    threads.push(...connection.nodes);
    if (threads.length > MAX_ITEMS) throw new Error('GitHub review-thread pagination exceeded safe item bound');
    if (!connection.pageInfo.hasNextPage) return threads;
    if (typeof connection.pageInfo.endCursor !== 'string' || connection.pageInfo.endCursor === cursor) {
      throw new Error('GitHub review-thread cursor did not advance');
    }
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error('GitHub review-thread pagination exceeded safe page bound');
}

async function getWorkflow(github, owner, repo) {
  const response = await github.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', {
    owner,
    repo,
    workflow_id: manifest.ci_workflow_file,
  });
  const workflow = response && response.data;
  if (
    !workflow ||
    !Number.isSafeInteger(workflow.id) ||
    workflow.state !== 'active' ||
    workflow.path !== manifest.ci_workflow_file ||
    workflow.name !== manifest.ci_workflow_name
  ) {
    throw new Error('trusted CI workflow identity differs from the check manifest');
  }
  return workflow;
}

function linkedPullRequest(run, expectedNumber) {
  const links = run && run.pull_requests;
  if (!Array.isArray(links) || links.length !== 1 || links[0].number !== expectedNumber) {
    return false;
  }
  return true;
}

function sameCandidateRun(run, pr, workflow, expectedRepo) {
  if (!run || run.workflow_id !== workflow.id || run.event !== 'pull_request') return false;
  if (!linkedPullRequest(run, pr.number)) return false;
  const link = run.pull_requests[0];
  return run.head_repository?.full_name?.toLowerCase() === expectedRepo.toLowerCase() &&
    run.head_branch === pr.head.ref && run.head_sha === pr.head.sha &&
    link.head?.repo?.full_name?.toLowerCase() === expectedRepo.toLowerCase() &&
    link.base?.repo?.full_name?.toLowerCase() === expectedRepo.toLowerCase() &&
    link.head?.ref === pr.head.ref && link.head?.sha === pr.head.sha &&
    link.base?.ref === pr.base.ref && link.base?.sha === pr.base.sha;
}

async function listWorkflowRuns(github, owner, repo, workflow, branch) {
  return collectRestPages(
    (parameters) => github.rest.actions.listWorkflowRuns(parameters),
    { owner, repo, workflow_id: workflow.id, branch, event: 'pull_request' },
    'workflow_runs',
  );
}

function runOrder(run) {
  const created = Date.parse(run.created_at || '');
  if (!Number.isFinite(created) || !Number.isSafeInteger(run.run_number)) return null;
  return { created, runNumber: run.run_number, attempt: Number(run.run_attempt || 1) };
}

function compareRuns(left, right) {
  const a = runOrder(left);
  const b = runOrder(right);
  if (!a || !b) throw new Error('workflow run ordering evidence is invalid');
  return b.created - a.created || b.runNumber - a.runNumber || b.attempt - a.attempt;
}

async function resolveLatestRun({ github, owner, repo, workflow, pr, eventRun, expectedRepo }) {
  const runs = await listWorkflowRuns(github, owner, repo, workflow, pr.head.ref);
  const matching = runs.filter((run) => sameCandidateRun(run, pr, workflow, expectedRepo));
  if (matching.length === 0) throw new Error('no CI run is linked to the current PR head and base');
  matching.sort(compareRuns);
  const latest = matching[0];
  if (eventRun && latest.id !== eventRun.id) throw new Error('workflow_run event is older than the latest CI run');
  if (latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('latest linked CI run is not completed successfully');
  }
  return latest;
}

function dataOrThrow(response, label) {
  if (!response || response.data === undefined || response.data === null) {
    throw new Error(`GitHub API ${label} response is empty`);
  }
  return response.data;
}

async function getPermission(github, owner, repo, username) {
  try {
    const response = await github.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
      owner,
      repo,
      username,
    });
    const data = dataOrThrow(response, 'collaborator permission');
    return {
      permission: typeof data.permission === 'string' ? data.permission : 'none',
      role_name: typeof data.role_name === 'string' ? data.role_name : undefined,
    };
  } catch (error) {
    if (error && error.status === 404) return { permission: 'none' };
    throw error;
  }
}

async function getPermissions(github, owner, repo, pr, reviews) {
  if (!pr.user || typeof pr.user.login !== 'string') throw new Error('pull request author identity missing');
  const logins = new Set([pr.user.login]);
  if (!Array.isArray(reviews)) throw new Error('pull request review history missing');
  for (const review of reviews) {
    if (review && review.user && typeof review.user.login === 'string' && review.submitted_at && review.state !== 'PENDING') {
      logins.add(review.user.login);
    }
  }
  const entries = await Promise.all([...logins].map(async (login) => [login.toLowerCase(), await getPermission(github, owner, repo, login)]));
  return Object.fromEntries(entries);
}

async function loadSnapshot({ github, owner, repo, number, headSha, baseBranch }) {
  const [files, reviews, threads, checkRuns, combinedStatus, rawStatuses, rulesResponse] = await Promise.all([
    collectRestPages((parameters) => github.rest.pulls.listFiles(parameters), { owner, repo, pull_number: number }, undefined),
    collectRestPages((parameters) => github.rest.pulls.listReviews(parameters), { owner, repo, pull_number: number }, undefined),
    loadReviewThreads(github, owner, repo, number),
    collectRestPages((parameters) => github.rest.checks.listForRef(parameters), { owner, repo, ref: headSha, filter: 'all' }, 'check_runs'),
    github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha, per_page: PAGE_SIZE, page: 1 }),
    collectRestPages(
      (parameters) => github.rest.repos.listCommitStatusesForRef(parameters),
      { owner, repo, ref: headSha },
      undefined,
    ),
    github.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { owner, repo, branch: baseBranch }),
  ]);
  if (files.length >= MAX_CHANGED_FILES) throw new Error('pull request file list reached GitHub API truncation limit');
  const statusData = dataOrThrow(combinedStatus, 'combined status');
  if (
    statusData.sha !== headSha ||
    !Array.isArray(statusData.statuses) ||
    !Number.isSafeInteger(statusData.total_count) ||
    statusData.total_count < statusData.statuses.length
  ) {
    throw new Error('combined commit status is not bound to the current head');
  }
  const latestStatuses = latestStatusesByContext(rawStatuses);
  if (!latestStatuses.valid || latestStatuses.statuses.length !== statusData.total_count) {
    throw new Error('paginated commit-status evidence disagrees with the combined status count');
  }
  const rules = dataOrThrow(rulesResponse, 'active branch rules');
  if (!Array.isArray(rules)) throw new Error('active branch rules response is invalid');
  return { files, reviews, threads, checkRuns, statuses: latestStatuses.statuses, rules };
}

async function createPolicyInput({ github, owner, repo, pr, run, workflow, trigger, config }) {
  const snapshot = await loadSnapshot({
    github,
    owner,
    repo,
    number: pr.number,
    headSha: pr.head.sha,
    baseBranch: config.baseBranch,
  });
  const permissions = await getPermissions(github, owner, repo, pr, snapshot.reviews);
  return {
    trigger,
    run,
    relatedPullRequests: run.pull_requests,
    pr,
    workflow,
    expectedRepository: config.expectedRepository,
    baseBranch: config.baseBranch,
    trustedAuthors: config.trustedAuthors,
    permissions,
    files: snapshot.files,
    reviews: snapshot.reviews,
    unresolvedThreads: snapshot.threads.filter((thread) => !thread.isResolved),
    checkRuns: snapshot.checkRuns,
    statuses: snapshot.statuses,
    manifestChecks: config.requiredChecks,
    guardChecks: config.guardChecks || manifest.guard_checks,
    rules: snapshot.rules,
  };
}

function block(reasons) {
  return { state: 'blocked', reasons: [...new Set(reasons)] };
}

async function runAutoMerge({ github, context, config = {}, notify = () => {} }) {
  const policyConfig = {
    expectedRepository: config.expectedRepository || EXPECTED_REPOSITORY,
    baseBranch: config.baseBranch || 'main',
    trustedAuthors: config.trustedAuthors || TRUSTED_AUTHORS,
    requiredChecks: config.requiredChecks || manifest.required_checks,
  };
  const { owner, repo } = context.repo || {};
  if (!owner || !repo || `${owner}/${repo}`.toLowerCase() !== policyConfig.expectedRepository.toLowerCase()) {
    return block(['execution-repository-mismatch']);
  }
  if (context.ref !== `refs/heads/${policyConfig.baseBranch}`) return block(['untrusted-trigger-ref']);

  const eventRun = context.eventName === 'workflow_run' && context.payload
    ? context.payload.workflow_run
    : null;
  let number;
  if (context.eventName === 'workflow_run') {
    if (!eventRun || !Array.isArray(eventRun.pull_requests) || eventRun.pull_requests.length !== 1) {
      return block(['ci-run-must-link-one-pull-request']);
    }
    number = eventRun.pull_requests[0].number;
  } else if (context.eventName === 'workflow_dispatch') {
    number = Number(context.payload && context.payload.inputs && context.payload.inputs.pull_number);
    if (!Number.isSafeInteger(number) || number < 1) return block(['manual-pull-number-invalid']);
  } else {
    return block(['unsupported-trigger']);
  }

  try {
    const workflow = await getWorkflow(github, owner, repo);
    const initialPr = dataOrThrow(await github.rest.pulls.get({ owner, repo, pull_number: number }), 'pull request');
    if (initialPr.number !== number) return block(['pull-request-number-mismatch']);
    const latestRun = await resolveLatestRun({
      github,
      owner,
      repo,
      workflow,
      pr: initialPr,
      eventRun,
      expectedRepo: policyConfig.expectedRepository,
    });
    const trigger = { eventName: context.eventName, ref: context.ref };
    const initialInput = await createPolicyInput({
      github, owner, repo, pr: initialPr, run: latestRun, workflow, trigger, config: policyConfig,
    });
    const initialDecision = evaluatePolicySnapshot(initialInput);
    if (!initialDecision.eligible) {
      notify(`PR #${number} blocked: ${initialDecision.reasons.join(', ')}`);
      return block(initialDecision.reasons);
    }

    // Re-read all evidence immediately before the write. The merge endpoint's sha
    // precondition closes the remaining head-update race; the base is rechecked here.
    const currentPr = dataOrThrow(await github.rest.pulls.get({ owner, repo, pull_number: number }), 'final pull request');
    if (currentPr.head?.sha !== initialPr.head?.sha || currentPr.base?.sha !== initialPr.base?.sha) {
      return block(['pull-request-head-or-base-updated-during-evaluation']);
    }
    const currentRun = await resolveLatestRun({
      github, owner, repo, workflow, pr: currentPr, expectedRepo: policyConfig.expectedRepository,
    });
    if (currentRun.id !== latestRun.id) return block(['latest-ci-run-changed-during-evaluation']);
    const finalInput = await createPolicyInput({
      github, owner, repo, pr: currentPr, run: currentRun, workflow, trigger, config: policyConfig,
    });
    const finalDecision = evaluatePolicySnapshot(finalInput);
    if (!finalDecision.eligible) {
      notify(`PR #${number} blocked after final refresh: ${finalDecision.reasons.join(', ')}`);
      return block(finalDecision.reasons);
    }

    const mergeResponse = dataOrThrow(await github.rest.pulls.merge({
      owner,
      repo,
      pull_number: number,
      sha: currentPr.head.sha,
      merge_method: 'squash',
    }), 'pull request merge');
    if (mergeResponse.merged !== true || typeof mergeResponse.sha !== 'string') {
      return block(['merge-api-did-not-confirm-merge']);
    }
    const mergedPr = dataOrThrow(await github.rest.pulls.get({ owner, repo, pull_number: number }), 'merged pull request verification');
    if (mergedPr.merged !== true || mergedPr.state !== 'closed' || mergedPr.merge_commit_sha !== mergeResponse.sha) {
      return block(['merge-result-could-not-be-verified']);
    }
    notify(`PR #${number} squash merge verified at ${mergeResponse.sha}`);
    return { state: 'merged', pullNumber: number, headSha: currentPr.head.sha, mergeSha: mergeResponse.sha };
  } catch (error) {
    notify(`PR #${number} not merged: ${apiMessage(error)}`);
    return block([apiMessage(error)]);
  }
}

module.exports = {
  MAX_CHANGED_FILES,
  MAX_CHECK_RUNS_FOR_REF,
  PAGE_SIZE,
  TRUSTED_AUTHORS,
  collectRestPages,
  getPermission,
  loadReviewThreads,
  resolveLatestRun,
  runAutoMerge,
};
