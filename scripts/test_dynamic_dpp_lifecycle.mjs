import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = p => readFile(new URL(`../${p}`, import.meta.url),'utf8');
const [sql,router,publicRoute,eventRoute,publicationRoute,schema,dpp] = await Promise.all([
  read('prisma/migrations/20261016130000_dynamic_dpp_lifecycle/migration.sql'),read('api/index.ts'),
  read('api/_routes/dpp/[gtin].ts'),read('api/_routes/products/[productId]/dpp/events.ts'),
  read('api/_routes/products/[productId]/dpp/publication.ts'),read('prisma/schema.prisma'),read('api/_lib/dpp.ts')]);

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
assert.match(publicRoute,/SELECT id,event_type,business_occurred_at,recorded_at,[\s\S]*validation_status::text,public_summary/);
for (const forbidden of ['actor_user_id','details','evidence_document_ids','metadata','owner_organization_id']) {
  const publicSelect = publicRoute.slice(publicRoute.indexOf('SELECT id,event_type'), publicRoute.indexOf('FROM dpp_lifecycle_events'));
  assert.ok(!publicSelect.includes(forbidden),`public projection leaks ${forbidden}`);
}
assert.match(schema,/model dpp_lifecycle_events/); assert.match(schema,/enum dpp_event_validation_status/);
assert.match(dpp,/published: 'Publié'/); assert.match(dpp,/rawStatus === 'published'/);
console.log('Dynamic DPP lifecycle: 22 security, publication and history assertions passed.');
