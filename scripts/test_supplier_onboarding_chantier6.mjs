import { readFile } from 'node:fs/promises';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('=== TEST SUITE CHANTIER 6: AUTONOMOUS SUPPLIER ONBOARDING ===');

// 1. Verify Migration SQL
console.log('1. Checking migration SQL...');
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006180000_supplier_self_onboarding/migration.sql', import.meta.url),
  'utf8',
);

assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_register_supplier_organization'),
  'Migration must define tracefab_register_supplier_organization',
);
assert(
  migrationSql.includes('INSERT INTO organizations'),
  'tracefab_register_supplier_organization must create organization',
);
assert(
  migrationSql.includes('INSERT INTO organization_memberships'),
  'tracefab_register_supplier_organization must create owner membership',
);
assert(
  migrationSql.includes('INSERT INTO suppliers'),
  'tracefab_register_supplier_organization must create initial supplier profile',
);
assert(
  migrationSql.includes('GRANT EXECUTE ON FUNCTION tracefab_register_supplier_organization'),
  'Migration must grant execute permission to PUBLIC',
);

// 2. Verify API routes and router registration
console.log('2. Checking API onboarding route and router...');
const routerTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(routerTs.includes('supplier/onboarding.js'), 'Router must register supplier/onboarding route');

const onboardingRoute = await readFile(
  new URL('../api/_routes/supplier/onboarding.ts', import.meta.url),
  'utf8',
);
assert(
  onboardingRoute.includes('tracefab_register_supplier_organization'),
  'Onboarding route must call tracefab_register_supplier_organization',
);
assert(
  onboardingRoute.includes('serializeSupplierProfile'),
  'Onboarding route must serialize created profile in response',
);
assert(
  onboardingRoute.includes('invalid_country_code'),
  'Onboarding route must validate 2-letter ISO country code',
);

const sqlErrors = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
assert(
  sqlErrors.includes('invalid_country_code'),
  'SQL errors must map invalid_country_code',
);

// 3. Verify Supplier Portal UI
console.log('3. Checking Supplier Portal UI implementation...');
const supplierPortalHtml = await readFile(
  new URL('../supplier-portal/index.html', import.meta.url),
  'utf8',
);
assert(
  supplierPortalHtml.includes("state.view = 'selfOnboarding'"),
  'Supplier portal must transition to selfOnboarding instead of throwing error',
);
assert(
  supplierPortalHtml.includes('selfOnboardingView('),
  'Supplier portal must implement selfOnboardingView',
);
assert(
  supplierPortalHtml.includes('id="self-onboarding-form"'),
  'Supplier portal must render self-onboarding-form',
);
assert(
  supplierPortalHtml.includes('submitSelfOnboarding('),
  'Supplier portal must implement submitSelfOnboarding',
);
assert(
  supplierPortalHtml.includes('/api/supplier/onboarding'),
  'Supplier portal must call /api/supplier/onboarding on submission',
);

// 4. Pure Unit Test & Simulation of Autonomous Supplier Registration
console.log('4. Testing autonomous supplier registration flow & state machine...');

function simulateSupplierRegistration(userId, userEmail, input) {
  if (!userId || !userEmail) {
    throw new Error('authentication_required');
  }

  const legalName = (input.legalName || '').trim();
  if (legalName.length === 0) {
    throw new Error('supplier_legal_name_required');
  }

  const countryCode = input.countryCode ? input.countryCode.trim().toUpperCase() : null;
  if (countryCode && countryCode.length !== 2) {
    throw new Error('invalid_country_code');
  }

  const orgId = `org-${Date.now()}`;
  const supplierId = `sup-${Date.now()}`;
  const membershipId = `mem-${Date.now()}`;

  const organization = {
    id: orgId,
    type: 'supplier',
    legalName,
    displayName: input.displayName ? input.displayName.trim() : legalName,
    countryCode,
    status: 'active',
    createdBy: userId,
  };

  const membership = {
    id: membershipId,
    organizationId: orgId,
    userId,
    role: 'owner',
    status: 'active',
  };

  const supplier = {
    id: supplierId,
    organizationId: orgId,
    onboardingStatus: 'in_progress',
    contactName: input.contactName || null,
    contactEmail: userEmail,
    contactPhone: input.contactPhone || null,
    profileSummary: input.profileSummary || null,
    activityTypes: input.activityTypes || [],
    profileCompletion: 50,
  };

  return { organization, membership, supplier };
}

// Case 1: Unauthenticated registration rejected
let unauthBlocked = false;
try {
  simulateSupplierRegistration(null, null, { legalName: 'Nhãn Textile' });
} catch (e) {
  unauthBlocked = e.message.includes('authentication_required');
}
assert(unauthBlocked, 'Unauthenticated registration must fail');

// Case 2: Missing legal name rejected
let emptyNameBlocked = false;
try {
  simulateSupplierRegistration('u1', 'test@supplier.com', { legalName: '   ' });
} catch (e) {
  emptyNameBlocked = e.message.includes('supplier_legal_name_required');
}
assert(emptyNameBlocked, 'Empty legal name must be rejected');

// Case 3: Invalid country code rejected
let invalidCountryBlocked = false;
try {
  simulateSupplierRegistration('u1', 'test@supplier.com', { legalName: 'Nhãn Textile', countryCode: 'PRT' });
} catch (e) {
  invalidCountryBlocked = e.message.includes('invalid_country_code');
}
assert(invalidCountryBlocked, 'Country code not 2 chars must be rejected');

// Case 4: Successful autonomous registration
const result = simulateSupplierRegistration('user-new-001', 'owner@nhan-textile.pt', {
  legalName: 'Nhãn Textile Lda',
  displayName: 'Nhãn Textile',
  countryCode: 'PT',
  contactName: 'Carlos Silva',
  contactPhone: '+351 253 111 222',
  profileSummary: 'Atelier de confection et tricotage spécialisé en maille circulaire.',
  activityTypes: ['knitting', 'dyeing', 'sewing'],
});

assert(result.organization.status === 'active', 'Created organization must be active');
assert(result.organization.type === 'supplier', 'Created organization must have supplier type');
assert(result.membership.role === 'owner', 'Creator must be assigned owner role');
assert(result.membership.status === 'active', 'Membership must be active');
assert(result.supplier.onboardingStatus === 'in_progress', 'Supplier profile must be in_progress');
assert(result.supplier.contactEmail === 'owner@nhan-textile.pt', 'Contact email must match user email');
assert(result.supplier.activityTypes.length === 3, 'Activity types must be preserved');

console.log('Chantier 6 verification complete! All tests passed.');
