import { readFile } from 'node:fs/promises';
import { pageSource } from './lib/page_source.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('=== TEST SUITE CHANTIER 5: QUALITY ISSUE ACTIONS (ACKNOWLEDGE & WAIVER) ===');

// 1. Verify API Routes for Quality Issues
console.log('1. Checking quality issue API routes...');
const ackRoute = await readFile(
  new URL('../api/_routes/quality-issues/[issueId]/acknowledge.ts', import.meta.url),
  'utf8',
);
assert(
  ackRoute.includes('tracefab_acknowledge_quality_issue'),
  'Acknowledge route must execute tracefab_acknowledge_quality_issue',
);
assert(
  ackRoute.includes('serializeQualityIssue'),
  'Acknowledge route must serialize quality issue in response',
);

const waiveRoute = await readFile(
  new URL('../api/_routes/quality-issues/[issueId]/waive.ts', import.meta.url),
  'utf8',
);
assert(
  waiveRoute.includes('tracefab_waive_quality_issue'),
  'Waive route must execute tracefab_waive_quality_issue',
);
assert(
  waiveRoute.includes('requiredString(body.reason'),
  'Waive route must require reason string',
);

// 2. Verify SQL definitions and business logic
console.log('2. Checking SQL stored procedures and error definitions...');
const initialMigrationSql = await readFile(
  new URL('../prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql', import.meta.url),
  'utf8',
);
assert(
  initialMigrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_acknowledge_quality_issue'),
  'Database must define tracefab_acknowledge_quality_issue',
);
assert(
  initialMigrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_waive_quality_issue'),
  'Database must define tracefab_waive_quality_issue',
);
assert(
  initialMigrationSql.includes('quality_issue_waiver_reason_required'),
  'Database must enforce waiver reason constraint',
);

const sqlErrors = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
assert(
  sqlErrors.includes('quality_issue_waive_role_required'),
  'SQL errors must map quality_issue_waive_role_required',
);
assert(
  sqlErrors.includes('quality_issue_waiver_reason_required'),
  'SQL errors must map quality_issue_waiver_reason_required',
);

// 3. Verify Brand Console UI
console.log('3. Checking Brand Console UI implementation...');
const brandConsoleHtml = pageSource('brand-console/index.html');
assert(
  brandConsoleHtml.includes('data-action="acknowledge-issue"'),
  'Brand console must offer acknowledge button on issues',
);
assert(
  brandConsoleHtml.includes('data-action="open-waive-modal"'),
  'Brand console must offer waiver button on issues',
);
assert(
  brandConsoleHtml.includes("type === 'waive-issue'"),
  'Brand console must include modal for waiving issues',
);
assert(
  brandConsoleHtml.includes('id="waive-issue-form"'),
  'Brand console must define waive-issue-form',
);
assert(
  brandConsoleHtml.includes('minlength="10"'),
  'Brand console waiver modal must require minlength 10',
);
assert(
  brandConsoleHtml.includes('acknowledgeIssue('),
  'Brand console must implement acknowledgeIssue handler',
);
assert(
  brandConsoleHtml.includes('waiveIssue('),
  'Brand console must implement waiveIssue handler',
);
// Chantier 8 : le badge est passe au catalogue (console.cnWaiverGranted).
assert(
  brandConsoleHtml.includes("bt('cnWaiverGranted')"),
  'Brand console must display waiver reason badge when issue is waived',
);
assert(
  JSON.parse(await readFile(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8')).console.cnWaiverGranted
    === 'Dérogation accordée :',
  'la copie FR du badge de derogation doit rester au catalogue',
);

// 4. Pure State Machine Simulation of Issue Lifecycle and Score Recovery
console.log('4. Testing quality issue lifecycle and score recovery...');

function computeConsistencyScore(issues) {
  // Matching Neon tracefab_compute_product_quality:
  // v_blocking_count, v_warning_count WHERE status IN ('open', 'acknowledged')
  const activeBlocking = issues.filter((i) => i.severity === 'blocking' && ['open', 'acknowledged'].includes(i.status)).length;
  const activeWarning = issues.filter((i) => i.severity === 'warning' && ['open', 'acknowledged'].includes(i.status)).length;

  return Math.max(0, 100 - activeBlocking * 30 - activeWarning * 10);
}

function simulateAcknowledgeIssue(issue, userRole) {
  if (!['owner', 'admin', 'manager', 'auditor'].includes(userRole)) {
    throw new Error('quality_issue_review_role_required');
  }
  return {
    ...issue,
    status: 'acknowledged',
    acknowledgedAt: new Date().toISOString(),
  };
}

function simulateWaiveIssue(issue, reason, userRole) {
  if (!['owner', 'admin'].includes(userRole)) {
    throw new Error('quality_issue_waive_role_required');
  }
  if (!reason || reason.trim().length < 10) {
    throw new Error('quality_issue_waiver_reason_required');
  }
  return {
    ...issue,
    status: 'waived',
    details: {
      ...issue.details,
      waiver_reason: reason.trim(),
      waived_at: new Date().toISOString(),
    },
  };
}

// Initial state: Product has 1 blocking issue and 1 warning issue
const initialIssues = [
  { id: 'iss-1', severity: 'blocking', status: 'open', ruleKey: 'product_expired_certification', message: 'Certificat expiré' },
  { id: 'iss-2', severity: 'warning', status: 'open', ruleKey: 'product_missing_evidence', message: 'Preuve absente' },
];

const score1 = computeConsistencyScore(initialIssues);
// 100 - (1*30) - (1*10) = 60
assert(score1 === 60, `Initial consistency score must be 60, got ${score1}`);

// Step A: Acknowledge the warning issue
const ackIssue2 = simulateAcknowledgeIssue(initialIssues[1], 'manager');
assert(ackIssue2.status === 'acknowledged', 'Issue status must be acknowledged');
assert(Boolean(ackIssue2.acknowledgedAt), 'acknowledgedAt must be set');

const issuesAfterAck = [initialIssues[0], ackIssue2];
const score2 = computeConsistencyScore(issuesAfterAck);
// Acknowledged issue still counts towards consistency until resolved or waived
assert(score2 === 60, 'Consistency remains unchanged upon acknowledgment');

// Step B: Attempt to waive with reason < 10 characters
let shortReasonBlocked = false;
try {
  simulateWaiveIssue(initialIssues[0], 'court', 'admin');
} catch (e) {
  shortReasonBlocked = e.message.includes('quality_issue_waiver_reason_required');
}
assert(shortReasonBlocked, 'Waiving with reason < 10 chars must fail');

// Step C: Attempt to waive without admin/owner role
let roleBlocked = false;
try {
  simulateWaiveIssue(initialIssues[0], 'Dérogation justifiée suite à vérification audit 2026', 'contributor');
} catch (e) {
  roleBlocked = e.message.includes('quality_issue_waive_role_required');
}
assert(roleBlocked, 'Waiving without admin/owner role must fail');

// Step D: Successfully waive the blocking issue
const waivedIssue1 = simulateWaiveIssue(
  initialIssues[0],
  'Dérogation accordée suite au renouvellement en cours auprès de l’organisme de certification.',
  'admin',
);
assert(waivedIssue1.status === 'waived', 'Issue status must be waived');
assert(
  waivedIssue1.details.waiver_reason.includes('renouvellement en cours'),
  'Waiver reason must be stored in details',
);

// Step E: Recalculate score with waived blocking issue
const issuesAfterWaiver = [waivedIssue1, ackIssue2];
const scoreAfterWaiver = computeConsistencyScore(issuesAfterWaiver);
// Blocking issue is waived (excluded from calculation) -> 100 - (0*30) - (1*10) = 90
assert(scoreAfterWaiver === 90, `Consistency score after waiver must recover to 90, got ${scoreAfterWaiver}`);

// Step F: Verify DPP quality requirement is unblocked
// In tracefab_dpp_requirement_met('quality.no_blocking_issues'):
// Checks if blocking_issues = '[]'
const openOrAckBlocking = issuesAfterWaiver.filter((i) => i.severity === 'blocking' && ['open', 'acknowledged'].includes(i.status));
assert(openOrAckBlocking.length === 0, 'No active blocking issues should remain after waiver');

console.log('Chantier 5 verification complete! All tests passed.');
