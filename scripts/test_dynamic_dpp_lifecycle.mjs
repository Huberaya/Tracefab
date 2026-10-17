import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = p => readFile(new URL(`../${p}`, import.meta.url),'utf8');
const [sql,router,publicRoute,eventRoute,publicationRoute,schema,dpp,trustSql,claimsRoute,reviewRoute] = await Promise.all([
  read('prisma/migrations/20261016130000_dynamic_dpp_lifecycle/migration.sql'),read('api/index.ts'),
  read('api/_routes/dpp/[gtin].ts'),read('api/_routes/products/[productId]/dpp/events.ts'),
  read('api/_routes/products/[productId]/dpp/publication.ts'),read('prisma/schema.prisma'),read('api/_lib/dpp.ts'),
  read('prisma/migrations/20261017120000_dpp_trust_reviews/migration.sql'),
  read('api/_routes/products/[productId]/dpp/claims.ts'),
  read('api/_routes/products/[productId]/dpp/claims/[claimId]/review.ts')]);

assert.match(sql,/CREATE TABLE dpp_lifecycle_events/);
assert.match(sql,/BEFORE UPDATE OR DELETE ON dpp_lifecycle_events/,'events must be append-only');
assert.match(sql,/ALTER TABLE dpp_lifecycle_events FORCE ROW LEVEL SECURITY/);
assert.match(sql,/public_summary IS NOT NULL[\s\S]*validation_status <> 'rejected'[\s\S]*tracefab_product_is_public/);
assert.match(sql,/tracefab_has_org_role[\s\S]*dpp_verification_role_required/);
assert.match(sql,/owner_organization_id = v_product.brand_organization_id[\s\S]*invalid_evidence_document/,'evidence must belong to product tenant');
assert.match(sql,/readiness_status <> 'ready_to_publish'[\s\S]*reviewed_at IS NULL/,'publication must require review');
assert.match(sql,/UPDATE tracefab_products SET public_slug=NULL/,'suspension must immediately revoke public resolution');
assert.match(sql,/INSERT INTO audit_logs/);
assert.ok(!/GRANT EXECUTE[^;]+ TO PUBLIC/.test(sql),'SECURITY DEFINER functions must never be executable by PUBLIC');
assert.match(sql,/TO tracefab_app/,'runtime execution must be granted explicitly');
assert.match(router,/dpp\\\/events/); assert.match(router,/dpp\\\/publication/);
assert.match(eventRoute,/accessibleProduct/); assert.match(eventRoute,/LIMIT 200/); assert.match(eventRoute,/evidence\.length > 50/);
assert.match(publicationRoute,/\['publish','suspend','withdraw'\]/); assert.match(publicationRoute,/Cache-Control','no-store/);
assert.match(publicRoute,/SELECT e\.id,e\.event_type,e\.business_occurred_at,e\.recorded_at,[\s\S]*validation_status::text,e\.public_summary/);
for (const forbidden of ['actor_user_id','details','evidence_document_ids','metadata','owner_organization_id']) {
  const publicSelect = publicRoute.slice(publicRoute.indexOf('SELECT e.id'), publicRoute.indexOf('FROM dpp_lifecycle_events e'));
  assert.ok(!publicSelect.includes(forbidden),`public projection leaks ${forbidden}`);
}
assert.match(schema,/model dpp_lifecycle_events/); assert.match(schema,/enum dpp_event_validation_status/);
assert.match(dpp,/published: 'Publié'/); assert.match(dpp,/rawStatus === 'published'/);

// --- Regles de confiance (migration 20261017120000) -----------------------
assert.match(trustSql,/CREATE TABLE IF NOT EXISTS dpp_claim_reviews/);
assert.match(trustSql,/CREATE TABLE IF NOT EXISTS dpp_verification_mandates/);
assert.match(trustSql,/dpp_claim_reviews_are_append_only/);
assert.match(trustSql,/dpp_claim_initial_status_must_be_declared/,'une affirmation ne peut pas naitre verifiee');
assert.match(trustSql,/dpp_event_evidence_required/,'un evenement documente exige une preuve');
assert.match(trustSql,/dpp_claim_evidence_required/,'un statut documente exige une preuve acceptee');
assert.match(trustSql,/dpp_verification_mandate_required/,'third_party_verified exige un mandat');
assert.match(trustSql,/third_party_verifier_role_required/);
assert.match(trustSql,/resulting_status <> 'third_party_verified' OR reviewer_organization_id IS NOT NULL/);
assert.match(trustSql,/tracefab_grant_dpp_verification_mandate/);
assert.match(trustSql,/tracefab_review_dpp_claim/);
assert.match(trustSql,/CREATE POLICY dpp_events_verifier_select/);
assert.match(trustSql,/revocation du mandat|tracefab_revoke_dpp_verification_mandate/);
assert.ok(!/GRANT EXECUTE[^;]+ TO PUBLIC/.test(trustSql),'aucune fonction de confiance executee par PUBLIC');
assert.match(router,/claims\\\/\(\[\^\\\/\]\+\)\\\/review/);
assert.match(claimsRoute,/dpp_claim_initial_status_must_be_declared/);
assert.match(claimsRoute,/dpp_claim_reviews/);
assert.match(reviewRoute,/tracefab_review_dpp_claim/);
assert.match(reviewRoute,/accessibleProductForDppRead/);
assert.match(publicRoute,/tracefab_public_verifier_name/);
assert.match(publicRoute,/toPublicDppProjection/);
assert.match(eventRoute,/verifiedByOrganizationId/);
assert.match(schema,/model dpp_claim_reviews/); assert.match(schema,/model dpp_verification_mandates/);
assert.match(schema,/verified_by_organization_id/);
console.log('Dynamic DPP lifecycle: 38 security, publication, trust and history assertions passed.');
