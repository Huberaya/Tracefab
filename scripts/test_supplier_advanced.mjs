import { readFile } from 'node:fs/promises';

const files = Object.fromEntries(await Promise.all([
  ['profile', 'api/_lib/supplier-profile.ts'],
  ['points', 'api/_lib/data-points.ts'],
  ['pointsRoute', 'api/supplier/data-points.ts'],
  ['pointUpdate', 'api/supplier/data-points/[dataPointId].ts'],
  ['members', 'api/supplier/members.ts'],
  ['organizations', 'api/supplier/organizations.ts'],
  ['requests', 'api/data-requests.ts'],
  ['requestDetail', 'api/data-requests/[requestId].ts'],
  ['portal', 'supplier-portal/index.html'],
  ['docs', 'docs/architecture/26-supplier-portal-advanced.md'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(files.profile.includes('requestedOrganizationId') && files.profile.includes('organization_id: organizationId'), 'Supplier context must verify an explicitly selected organization membership');
assert(files.points.includes('SUPPLIER_DATA_TYPES') && files.points.includes('data_point_date_range'), 'Structured data point validation is missing');
assert(files.pointsRoute.includes("status: 'available'") && files.pointsRoute.includes('data_value_status.documented'), 'Data point evidence must be available before documentation status');
assert(files.pointUpdate.includes('supersedes_id') && files.pointUpdate.includes('version: current.version + 1'), 'Data point updates must preserve version history');
assert(files.members.includes('createHash') && files.members.includes('last_owner_membership_required'), 'Member invitations and last-owner protection are missing');
assert(files.members.includes('member_management_role_required'), 'Member management must be role-protected');
assert(files.organizations.includes('organizations: { type: \'supplier\''), 'Organization switcher must be supplier-scoped');
assert(files.requests.includes('requestedOrganizationId(req)') && files.requestDetail.includes('requestedOrganizationId(req)'), 'Data request list and detail must honor the selected organization');
assert(files.portal.includes("navButton('dataPoints'") && files.portal.includes("navButton('members'") && files.portal.includes('X-Tracefab-Organization-Id'), 'Supplier Portal advanced navigation and tenant context are missing');
assert(files.portal.includes('sourceDocumentId'), 'Structured data point evidence selection is missing');
assert(files.docs.includes('Chantier 23'), 'Advanced Supplier Portal documentation is missing');
console.log('Supplier advanced contract passed: structured points, evidence gating, versioning, member controls and multi-organization context');
