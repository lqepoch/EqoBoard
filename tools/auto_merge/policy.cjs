'use strict';

const EXPECTED_REPOSITORY = 'lqepoch/EqoBoard';
const DEFAULT_BASE_BRANCH = 'main';
const GITHUB_ACTIONS_APP = 'github-actions';
const GITHUB_CODEQL_APP = 'github-advanced-security';
const TRUSTED_CHECK_APPS = new Set([GITHUB_ACTIONS_APP, GITHUB_CODEQL_APP]);
const REVIEWER_WRITE_ROLES = new Set(['write', 'maintain', 'admin']);

const SENSITIVE_PREFIXES = [
  '.github/',
  '.agents/',
  'apps/gateway/',
  'apps/openterminal/server/',
  'apps/openterminal/web/app/api/',
  'apps/openterminal/web/lib/',
  'apps/openterminal/web/auth.ts',
  'apps/openterminal/web/next-auth.d.ts',
  'apps/openterminal/web/middleware.',
  'apps/openterminal/web/next.config.',
  'crates/alpaca-data/',
  'crates/domain/',
  'crates/execution/',
  'tools/auto_merge/',
  'docs/automerge.md',
];

const SENSITIVE_BASENAMES = new Set([
  'agents.md',
  'cargo.toml',
  'cargo.lock',
  'package.json',
  'package-lock.json',
]);

function normalizedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    return null;
  }
  const path = value.replace(/^\.\//, '').toLowerCase();
  if (path.startsWith('/') || path.split('/').some((segment) => segment === '..')) {
    return null;
  }
  return path;
}

function isSensitivePath(value) {
  const path = normalizedPath(value);
  if (!path) return true;
  if (SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith('.env')) return true;
  if (/^dockerfile(?:\.|$)/.test(basename)) return true;
  if (/^(?:docker-)?compose(?:\.|$)/.test(basename)) return true;
  if (/(^|\/)(auth|security|config)(\/|\.)/.test(path)) return true;
  return false;
}

function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { valid: false, sensitive: true, reason: 'changed-files-missing' };
  }
  let sensitive = false;
  for (const file of files) {
    if (!file || typeof file.filename !== 'string') {
      return { valid: false, sensitive: true, reason: 'changed-file-path-missing' };
    }
    if (file.status === 'renamed' && typeof file.previous_filename !== 'string') {
      return { valid: false, sensitive: true, reason: 'rename-source-missing' };
    }
    if (isSensitivePath(file.filename)) sensitive = true;
    if (file.previous_filename !== undefined) {
      if (typeof file.previous_filename !== 'string') {
        return { valid: false, sensitive: true, reason: 'rename-source-invalid' };
      }
      if (isSensitivePath(file.previous_filename)) sensitive = true;
    }
  }
  return {
    valid: true,
    sensitive,
    reason: sensitive ? 'sensitive-current-or-previous-path' : 'ordinary-paths',
  };
}

function normalizeLogin(login) {
  return typeof login === 'string' ? login.toLowerCase() : '';
}

function permissionFor(permissions, login) {
  const key = normalizeLogin(login);
  const entry = permissions && (permissions[key] || permissions[login]);
  if (typeof entry === 'string') return entry.toLowerCase();
  if (entry && typeof entry.permission === 'string') return entry.permission.toLowerCase();
  if (entry && typeof entry.role_name === 'string') return entry.role_name.toLowerCase();
  return 'none';
}

function hasWritePermission(permission) {
  return REVIEWER_WRITE_ROLES.has(permission);
}

function latestSubmittedReviews(reviews) {
  if (!Array.isArray(reviews)) return { valid: false, latest: new Map() };
  const latest = new Map();
  for (const review of reviews) {
    if (!review || !review.user || typeof review.user.login !== 'string') {
      return { valid: false, latest: new Map() };
    }
    if (review.state === 'PENDING') continue;
    if (typeof review.submitted_at !== 'string' || !Number.isFinite(Date.parse(review.submitted_at))) {
      return { valid: false, latest: new Map() };
    }
    const key = normalizeLogin(review.user.login);
    if (!key) return { valid: false, latest: new Map() };
    const previous = latest.get(key);
    const timestamp = Date.parse(review.submitted_at);
    const id = Number.isSafeInteger(review.id) ? review.id : 0;
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && id > previous.id)) {
      latest.set(key, { review, timestamp, id });
    }
  }
  return { valid: true, latest };
}

function latestByTimestamp(items, timestampField, idField = 'id') {
  if (!Array.isArray(items) || items.length === 0) return { valid: true, item: undefined };
  const ordered = [];
  for (const item of items) {
    const timestamp = Date.parse(item && (item[timestampField] || item.created_at) || '');
    const id = Number(item && item[idField]);
    if (!Number.isFinite(timestamp) || !Number.isSafeInteger(id)) {
      return { valid: false, item: undefined };
    }
    ordered.push({ item, timestamp, id });
  }
  ordered.sort((left, right) => right.timestamp - left.timestamp || right.id - left.id);
  return { valid: true, item: ordered[0].item };
}

function latestStatusesByContext(statuses) {
  if (!Array.isArray(statuses)) return { valid: false, statuses: [] };
  const latest = new Map();
  for (const status of statuses) {
    if (!status || typeof status.context !== 'string' || status.context.trim() === '' ||
        !Number.isSafeInteger(status.id) || typeof status.updated_at !== 'string') {
      return { valid: false, statuses: [] };
    }
    const timestamp = Date.parse(status.updated_at);
    if (!Number.isFinite(timestamp)) return { valid: false, statuses: [] };
    const key = status.context.toLowerCase();
    const previous = latest.get(key);
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && status.id > previous.status.id)) {
      latest.set(key, { status, timestamp });
    }
  }
  return { valid: true, statuses: [...latest.values()].map(({ status }) => status) };
}

function validateReviewPolicy({ reviews, permissions, authorLogin, headSha, sensitive, requiredApprovalCount = 1 }) {
  const reasons = [];
  if (!Number.isSafeInteger(requiredApprovalCount) || requiredApprovalCount < 0) {
    return ['pull-request-required-approval-count-invalid'];
  }
  const result = latestSubmittedReviews(reviews);
  if (!result.valid) return ['review-history-invalid'];
  const author = normalizeLogin(authorLogin);
  const validApprovals = new Set();

  for (const [reviewer, item] of result.latest.entries()) {
    const { review } = item;
    const state = review.state;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(state)) {
      reasons.push('review-state-unknown');
      continue;
    }
    if (state === 'DISMISSED') continue;
    const actor = review.user;
    const human = actor.type === 'User' && !reviewer.endsWith('[bot]') && !actor.login.endsWith('[bot]');
    const permission = permissionFor(permissions, actor.login);
    const independent = reviewer !== author;
    if (!human || !hasWritePermission(permission) || !independent) continue;
    if (state === 'CHANGES_REQUESTED') {
      reasons.push('changes-requested');
      continue;
    }
    if (state === 'APPROVED' && review.commit_id === headSha) {
      validApprovals.add(reviewer);
    }
  }

  const requiredApprovals = Math.max(1, requiredApprovalCount, sensitive ? 1 : 0);
  if (validApprovals.size < requiredApprovals) {
    reasons.push('required-current-head-approvals-not-met');
    if (sensitive && validApprovals.size === 0) reasons.push('sensitive-change-needs-independent-current-head-approval');
  }
  return reasons;
}

const PULL_REQUEST_RULE_PARAMETERS = new Set([
  'allowed_merge_methods',
  'dismiss_stale_reviews_on_push',
  'dismissal_restriction',
  'require_code_owner_review',
  'require_extra_approval_for_unattributed_changes',
  'require_last_push_approval',
  'required_approving_review_count',
  'required_review_thread_resolution',
  'required_reviewers',
]);

function rulesetRequiredApprovals(rules) {
  if (!Array.isArray(rules)) return { valid: false, count: 0, reason: 'branch-rules-response-invalid' };
  let count = 0;
  let foundPullRequestRule = false;
  for (const rule of rules) {
    if (!rule || typeof rule.type !== 'string') return { valid: false, count: 0, reason: 'branch-rule-invalid' };
    if (rule.type !== 'pull_request') continue;
    foundPullRequestRule = true;
    const parameters = rule.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      return { valid: false, count: 0, reason: 'pull-request-rule-parameters-invalid' };
    }
    if (Object.keys(parameters).some((key) => !PULL_REQUEST_RULE_PARAMETERS.has(key))) {
      return { valid: false, count: 0, reason: 'pull-request-rule-parameters-unknown' };
    }
    const extraApproval = parameters.require_extra_approval_for_unattributed_changes;
    if (extraApproval !== undefined && typeof extraApproval !== 'boolean') {
      return { valid: false, count: 0, reason: 'pull-request-extra-approval-setting-invalid' };
    }
    if (extraApproval === true) {
      return { valid: false, count: 0, reason: 'pull-request-extra-approval-requirement-unsupported' };
    }
    for (const field of ['require_code_owner_review', 'require_last_push_approval']) {
      const enabled = parameters[field];
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { valid: false, count: 0, reason: `pull-request-${field}-invalid` };
      }
      if (enabled === true) {
        return { valid: false, count: 0, reason: `pull-request-${field}-unsupported` };
      }
    }
    const requiredReviewers = parameters.required_reviewers;
    if (requiredReviewers !== undefined && !Array.isArray(requiredReviewers)) {
      return { valid: false, count: 0, reason: 'pull-request-required-reviewers-invalid' };
    }
    if (requiredReviewers?.length > 0) {
      return { valid: false, count: 0, reason: 'pull-request-required-reviewers-unsupported' };
    }
    const required = parameters.required_approving_review_count;
    if (!Number.isSafeInteger(required) || required < 0) {
      return { valid: false, count: 0, reason: 'pull-request-required-approval-count-invalid' };
    }
    count = Math.max(count, required);
  }
  if (!foundPullRequestRule) {
    return { valid: false, count: 0, reason: 'pull-request-review-policy-missing' };
  }
  return { valid: true, count: Math.max(1, count) };
}

function rulesetRequiredChecks(rules) {
  if (!Array.isArray(rules)) return { valid: false, checks: [], reason: 'ruleset-response-invalid' };
  const checks = [];
  for (const rule of rules) {
    if (!rule || rule.type !== 'required_status_checks') continue;
    const required = rule.parameters && rule.parameters.required_status_checks;
    if (!Array.isArray(required)) {
      return { valid: false, checks: [], reason: 'required-check-rule-invalid' };
    }
    for (const item of required) {
      if (!item || typeof item.context !== 'string' || item.context.length === 0) {
        return { valid: false, checks: [], reason: 'required-check-context-invalid' };
      }
      checks.push({
        context: item.context,
        integrationId: item.integration_id ?? null,
        source: 'ruleset',
      });
    }
  }
  return { valid: true, checks };
}

function normalizeCheckDeclaration(entry, source, required) {
  if (!entry || typeof entry.context !== 'string' || entry.context.length === 0) return null;
  return {
    context: entry.context,
    appSlug: entry.appSlug || entry.app_slug || '',
    integrationId: entry.integrationId ?? entry.integration_id ?? null,
    bindToWorkflowRun: entry.bindToWorkflowRun === true || entry.bind_to_workflow_run === true,
    source,
    required,
  };
}

function mergeRequiredChecks(manifestChecks, rules, guardChecks = []) {
  if (!Array.isArray(manifestChecks) || manifestChecks.length === 0) {
    return { valid: false, checks: [], reason: 'trusted-check-manifest-empty' };
  }
  if (!Array.isArray(guardChecks)) return { valid: false, checks: [], reason: 'trusted-check-guards-invalid' };
  const fromRules = rulesetRequiredChecks(rules);
  if (!fromRules.valid) return fromRules;
  const checks = new Map();
  for (const entry of manifestChecks) {
    const declaration = normalizeCheckDeclaration(entry, 'manifest', true);
    if (!declaration) return { valid: false, checks: [], reason: 'trusted-check-manifest-invalid' };
    checks.set(declaration.context, declaration);
  }
  for (const entry of guardChecks) {
    const declaration = normalizeCheckDeclaration(entry, 'guard', false);
    if (!declaration || checks.has(declaration.context)) {
      return { valid: false, checks: [], reason: 'trusted-check-guard-invalid-or-duplicate' };
    }
    checks.set(declaration.context, declaration);
  }
  for (const ruleCheck of fromRules.checks) {
    const key = ruleCheck.context;
    const existing = checks.get(key);
    if (existing) {
      if (ruleCheck.integrationId !== null && existing.integrationId !== null && Number(ruleCheck.integrationId) !== Number(existing.integrationId)) {
        return { valid: false, checks: [], reason: `required-check-provider-conflict:${key}` };
      }
      if (ruleCheck.integrationId !== null) existing.integrationId = ruleCheck.integrationId;
      existing.required = true;
      existing.source = `${existing.source}+ruleset`;
      continue;
    }
    const declaration = normalizeCheckDeclaration(ruleCheck, 'ruleset', true);
    if (!declaration) return { valid: false, checks: [], reason: 'ruleset-check-invalid' };
    checks.set(key, declaration);
  }
  const entries = [...checks.values()];
  return { valid: entries.some((entry) => entry.required), checks: entries, reason: entries.length ? undefined : 'required-check-set-empty' };
}

function validateRequiredChecks({ checks, statuses, requiredChecks, headSha, expectedCheckSuiteId }) {
  const reasons = [];
  if (!Array.isArray(checks) || !Array.isArray(statuses) || !Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    return ['check-evidence-invalid'];
  }
  const declarations = new Map(requiredChecks.map((entry) => [entry.context.toLowerCase(), entry]));
  const exactCheckNames = new Set(requiredChecks.map((entry) => entry.context));
  for (const status of statuses) {
    const key = typeof status?.context === 'string' ? status.context.toLowerCase() : '';
    const declaration = declarations.get(key);
    if (!status || typeof status.context !== 'string' || !declaration) {
      reasons.push(`status-context-unrecognized:${String(status && status.context || '<missing>')}`);
      continue;
    }
    if (status.state !== 'success' || status.creator?.login !== 'github-actions[bot]') {
      reasons.push(`status-not-success-or-untrusted:${declaration.context}`);
    }
  }
  for (const run of checks) {
    if (run && run.head_sha === headSha && !exactCheckNames.has(run.name)) {
      reasons.push(`check-context-unrecognized:${String(run.name || '<missing>')}`);
    }
  }
  for (const required of requiredChecks) {
    const matchingRuns = checks.filter((run) => run && run.name === required.context && run.head_sha === headSha);
    const matchingStatuses = statuses.filter((status) => status && typeof status.context === 'string' && status.context.toLowerCase() === required.context.toLowerCase());
    if (matchingRuns.length > 0) {
      const selection = latestByTimestamp(matchingRuns, 'started_at');
      const latest = selection.item;
      if (!selection.valid || !latest) {
        reasons.push(`check-evidence-invalid:${required.context}`);
        continue;
      }
      if (latest.status !== 'completed' || latest.conclusion !== 'success') {
        reasons.push(`check-not-success:${required.context}`);
        continue;
      }
      if (required.bindToWorkflowRun && (
        !Number.isSafeInteger(expectedCheckSuiteId) ||
        !Number.isSafeInteger(latest.check_suite && latest.check_suite.id) ||
        latest.check_suite.id !== expectedCheckSuiteId
      )) {
        reasons.push(`check-suite-mismatch:${required.context}`);
        continue;
      }
      reasons.push(...validateCheckProvider(latest, required));
      continue;
    }

    if (required.required === false && matchingStatuses.length > 0) {
      reasons.push(`guard-check-run-missing:${required.context}`);
      continue;
    }
    if (required.required === false) continue;
    if (required.source.includes('manifest') || required.source.includes('guard')) {
      reasons.push(`check-missing:${required.context}`);
      continue;
    }
    if (required.integrationId !== null) {
      reasons.push(`check-missing:${required.context}`);
      continue;
    }
    const selection = latestByTimestamp(matchingStatuses, 'updated_at');
    const latestStatus = selection.item;
    if (!selection.valid) {
      reasons.push(`check-status-evidence-invalid:${required.context}`);
    } else if (!latestStatus) {
      reasons.push(`check-missing:${required.context}`);
    } else if (latestStatus.state !== 'success' || latestStatus.creator?.login !== 'github-actions[bot]') {
      reasons.push(`check-status-not-success-or-untrusted:${required.context}`);
    }
  }
  return reasons;
}

function validateCheckProvider(run, declaration) {
  const reasons = [];
  const slug = run.app && run.app.slug;
  if (declaration.integrationId !== null && Number(run.app && run.app.id) !== Number(declaration.integrationId)) {
    reasons.push(`check-provider-mismatch:${declaration.context}`);
  }
  if (declaration.appSlug && slug !== declaration.appSlug) {
    reasons.push(`check-provider-mismatch:${declaration.context}`);
  } else if (!declaration.appSlug && declaration.integrationId === null && !TRUSTED_CHECK_APPS.has(slug)) {
    reasons.push(`check-provider-unknown:${declaration.context}`);
  }
  return reasons;
}

function validateRunBinding({ trigger, run, relatedPullRequests, pr, workflow, expectedRepository = EXPECTED_REPOSITORY, baseBranch = DEFAULT_BASE_BRANCH }) {
  const reasons = [];
  const expectedRepo = expectedRepository.toLowerCase();
  const related = relatedPullRequests;

  if (!trigger || !['workflow_run', 'workflow_dispatch'].includes(trigger.eventName)) {
    reasons.push('unsupported-trigger');
  } else if (trigger.ref !== `refs/heads/${baseBranch}`) {
    reasons.push('untrusted-trigger-ref');
  }
  if (!pr || pr.state !== 'open' || pr.draft || pr.merged) reasons.push('pull-request-not-open-ready');
  if (!pr || !pr.base || pr.base.ref !== baseBranch || pr.base.repo?.full_name?.toLowerCase() !== expectedRepo) {
    reasons.push('pull-request-base-untrusted');
  }
  if (!pr || !pr.head || pr.head.repo?.full_name?.toLowerCase() !== expectedRepo) {
    reasons.push('fork-or-missing-head-repository');
  }
  if (!pr || !pr.head || !/^[a-f0-9]{40}$/i.test(pr.head.sha || '')) reasons.push('pull-request-head-sha-invalid');
  if (!pr || !pr.base || !/^[a-f0-9]{40}$/i.test(pr.base.sha || '')) reasons.push('pull-request-base-sha-invalid');
  if (!pr || !pr.mergeable) reasons.push('pull-request-not-mergeable');
  if (!Array.isArray(related) || related.length !== 1) {
    reasons.push('ci-run-must-link-one-pull-request');
  } else {
    const link = related[0];
    if (link.number !== pr.number) reasons.push('ci-run-pull-request-number-mismatch');
    if (link.head?.sha !== pr.head?.sha || link.head?.ref !== pr.head?.ref) reasons.push('ci-run-head-mismatch');
    if (link.base?.sha !== pr.base?.sha || link.base?.ref !== pr.base?.ref) reasons.push('ci-run-base-mismatch');
    if (link.head?.repo?.full_name?.toLowerCase() !== expectedRepo || link.base?.repo?.full_name?.toLowerCase() !== expectedRepo) {
      reasons.push('ci-run-repository-link-untrusted');
    }
  }
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'pull_request') {
    reasons.push('ci-run-not-successful-pull-request-run');
  }
  if (!run || !Number.isSafeInteger(run.check_suite_id)) reasons.push('ci-run-check-suite-id-invalid');
  if (!run || run.head_repository?.full_name?.toLowerCase() !== expectedRepo) reasons.push('ci-run-source-repository-untrusted');
  if (!run || run.head_sha !== pr?.head?.sha || run.head_branch !== pr?.head?.ref) reasons.push('ci-run-tested-revision-mismatch');
  if (!workflow || workflow.state !== 'active' || !run || run.workflow_id !== workflow.id) {
    reasons.push('ci-workflow-identity-untrusted');
  }
  const path = typeof run?.path === 'string' ? run.path.split('@')[0] : '';
  if (!workflow || !workflow.path || path !== workflow.path) reasons.push('ci-workflow-path-mismatch');
  if (typeof pr?.user?.login !== 'string' || pr.user.type !== 'User') reasons.push('pull-request-author-invalid');
  return reasons;
}

function evaluatePolicySnapshot(input) {
  const reasons = validateRunBinding(input);
  const permissions = input.permissions || {};
  const authorLogin = input.pr?.user?.login || '';
  const trustedAuthors = new Set((input.trustedAuthors || []).map(normalizeLogin));
  if (!authorLogin || !trustedAuthors.has(normalizeLogin(authorLogin))) reasons.push('author-not-allowlisted');
  if (!hasWritePermission(permissionFor(permissions, authorLogin))) reasons.push('author-permission-insufficient');

  const files = classifyChangedFiles(input.files);
  if (!files.valid) reasons.push(files.reason);
  const approvalRule = rulesetRequiredApprovals(input.rules);
  if (!approvalRule.valid) reasons.push(approvalRule.reason);
  const checkPlan = mergeRequiredChecks(input.manifestChecks, input.rules, input.guardChecks || []);
  if (!checkPlan.valid) reasons.push(checkPlan.reason);
  if (checkPlan.valid) {
    reasons.push(...validateRequiredChecks({
      checks: input.checkRuns,
      statuses: input.statuses,
      requiredChecks: checkPlan.checks,
      headSha: input.pr?.head?.sha,
      expectedCheckSuiteId: input.run?.check_suite_id,
    }));
  }
  if (!Array.isArray(input.unresolvedThreads)) {
    reasons.push('review-thread-evidence-invalid');
  } else if (input.unresolvedThreads.length > 0) {
    reasons.push('unresolved-review-threads');
  }
  reasons.push(...validateReviewPolicy({
    reviews: input.reviews,
    permissions,
    authorLogin,
    headSha: input.pr?.head?.sha,
    sensitive: files.sensitive,
    requiredApprovalCount: approvalRule.valid ? approvalRule.count : 0,
  }));

  return {
    eligible: reasons.length === 0,
    sensitive: files.sensitive,
    reasons: [...new Set(reasons)],
    requiredChecks: checkPlan.valid ? checkPlan.checks : [],
  };
}

module.exports = {
  DEFAULT_BASE_BRANCH,
  EXPECTED_REPOSITORY,
  GITHUB_ACTIONS_APP,
  GITHUB_CODEQL_APP,
  classifyChangedFiles,
  evaluatePolicySnapshot,
  hasWritePermission,
  isSensitivePath,
  latestSubmittedReviews,
  latestStatusesByContext,
  mergeRequiredChecks,
  permissionFor,
  rulesetRequiredChecks,
  rulesetRequiredApprovals,
  validateRequiredChecks,
  validateCheckProvider,
  validateReviewPolicy,
  validateRunBinding,
};
