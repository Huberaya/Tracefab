import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = Object.fromEntries(await Promise.all([
  ['profile', 'api/_lib/supplier-profile.ts'],
  ['points', 'api/_lib/data-points.ts'],
  ['pointsRoute', 'api/supplier/data-points.ts'],
  ['pointUpdate', 'api/supplier/data-points/[dataPointId].ts'],
  ['members', 'api/supplier/members.ts'],
  ['invitationManagement', 'api/supplier/member-invitations/[invitationId].ts'],
  ['organizations', 'api/supplier/organizations.ts'],
  ['requests', 'api/data-requests.ts'],
  ['requestDetail', 'api/data-requests/[requestId].ts'],
  ['portal', 'supplier-portal/index.html'],
  ['docs', 'docs/architecture/26-supplier-portal-advanced.md'],
  ['acceptPage', 'invitations/accept/index.html'],
  ['hardening', 'prisma/migrations/20261005090000_supplier_portal_advanced_hardening/migration.sql'],
  ['supplierInvitationCompatibility', 'prisma/migrations/20261005100000_supplier_invitation_compatibility/migration.sql'],
  ['email', 'api/_lib/email.ts'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(files.profile.includes('requestedOrganizationId') && files.profile.includes('organization_id: organizationId'), 'Supplier context must verify an explicitly selected organization membership');
assert(files.points.includes('SUPPLIER_DATA_TYPES') && files.points.includes('DATA_POINT_DEFINITIONS') && files.points.includes('data_point_date_range'), 'Structured data point validation is missing');
assert(files.pointsRoute.includes("status: 'available'") && files.pointsRoute.includes('data_value_status.documented') && files.pointsRoute.includes('requireSupplierMutationRole'), 'Data point evidence, status derivation or write-role guard is missing');
assert(files.pointUpdate.includes('supersedes_id') && files.pointUpdate.includes('version: current.version + 1'), 'Data point updates must preserve version history');
assert(files.members.includes('createHash') && files.members.includes('last_owner_membership_required'), 'Member invitations and last-owner protection are missing');
assert(files.invitationManagement.includes("methodNotAllowed(res, ['POST', 'DELETE'])") && files.invitationManagement.includes('sendOrganizationMemberInvitationEmail'), 'Invitation resend/revoke lifecycle is missing');
assert(files.members.includes('member_management_role_required'), 'Member management must be role-protected');
assert(files.organizations.includes('organizations: { type: \'supplier\''), 'Organization switcher must be supplier-scoped');
assert(files.requests.includes('requestedOrganizationId(req)') && files.requestDetail.includes('requestedOrganizationId(req)'), 'Data request list and detail must honor the selected organization');
assert(files.portal.includes("navButton('dataPoints'") && files.portal.includes("navButton('members'") && files.portal.includes('X-Tracefab-Organization-Id'), 'Supplier Portal advanced navigation and tenant context are missing');
assert(files.portal.includes('sourceDocumentId'), 'Structured data point evidence selection is missing');
assert(files.docs.includes('Chantier 23'), 'Advanced Supplier Portal documentation is missing');
assert(files.acceptPage.includes('/api/invitations/accept') && files.acceptPage.includes('clerk.browser.js'), 'Invitation acceptance page is missing Clerk/API integration');
const acceptScript = files.acceptPage.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert(acceptScript, 'Invitation acceptance page script is missing');
new vm.Script(acceptScript, { filename: 'invitations/accept/index.html' });
assert(files.hardening.includes('last_owner_membership_required') && files.hardening.includes('data_points_insert_owner'), 'Neon hardening migration is missing role and RLS guards');
assert(files.supplierInvitationCompatibility.includes("NEW.target_role = 'owner' AND NEW.relationship_id IS NULL"), 'Supplier onboarding owner invitation compatibility is missing');
assert(files.email.includes('manualInvitationFallbackAllowed') && files.email.includes('TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK'), 'Production invitation fallback is not explicitly gated');
console.log('Supplier advanced contract passed: structured points, evidence gating, versioning, member controls and multi-organization context');
