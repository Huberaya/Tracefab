import assert from 'node:assert/strict';
import { createProductHandler } from '../api/_routes/products/[productId].js';
import { validateProductPatch, ProductFieldError } from '../api/_lib/product-edit.js';
import { serializeProduct } from '../api/_lib/products.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
// Deux tenants reels, en UUID valides. Le scenario de reproduction Production
// du 2026-10-17 est un utilisateur membre de DEUX organisations : sans deux
// identifiants distincts, le test ne peut pas distinguer un bornage tenant d'un
// bornage utilisateur.
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let row: any = { id, brand_organization_id: TENANT_A, reference: 'REAL-1', name: 'Produit réel',
  sku: null, category: null, description: null, product_family: null, color_name: null,
  size_range: [], country_of_design: null, country_of_manufacture: null, weight_grams: null,
  care_instructions: {}, data_completion: 0, status: 'draft', product_identifiers: [], product_materials: [] };
let writes = 0;
const handler = createProductHandler({
  requireClerkUser: async () => ({ user: { id: 'user-a', email: 'a@example.test' } }) as any,
  withTracefabUserContext: async (_id: any, _email: any, cb: any) => cb({
    organization_memberships: {
      findMany: async () => [{ organization_id: TENANT_A }],
      // Le locataire actif est verifie par adhesion reelle. Seul TENANT_A est
      // une adhesion de marque : TENANT_B est membre ailleurs, ce qui est
      // exactement le cas du compte multi-organisations de l'incident.
      findFirst: async ({ where }: any) => {
        const requested = where.organization_id;
        if (requested !== TENANT_A) return null;
        return { organization_id: TENANT_A, role: 'admin', organizations: { type: 'brand' } };
      },
    },
    tracefab_products: {
      findFirst: async ({ where }: any) => where.id === id && where.brand_organization_id.in.includes(row.brand_organization_id) ? row : null,
      update: async ({ where, data }: any) => {
        assert.equal(where.id, id);
        writes++;
        Object.assign(row, data);
        return row;
      },
    },
    audit_logs: {
      create: async ({ data }: any) => {
        assert.equal(data.organization_id, TENANT_A);
        assert.equal(data.action, 'product.archived');
        assert.deepEqual(data.before_state, { status: 'draft' });
        assert.deepEqual(data.after_state, { status: 'archived' });
        writes++;
        return data;
      },
    },
    $queryRaw: async (_strings: any, ...args: any[]) => {
      writes++;
      const keys = ['reference', 'sku', 'name', 'category', 'description', 'product_family', 'color_name', 'size_range', 'country_of_design', 'country_of_manufacture', 'weight_grams', 'care_instructions'];
      keys.forEach((key, i) => row[key] = key === 'care_instructions' ? JSON.parse(args[i + 1]) : args[i + 1]);
      return [{ id }];
    },
  }),
} as any);
async function request(body: any, productId = id, method = 'PATCH', tenant: string | null = TENANT_A) {
  let status = 0, payload: any;
  const res: any = { getHeader() {}, setHeader() { return this; }, status(n: number) { status = n; return this; }, json(p: any) { payload = p; return this; } };
  const query: any = { productId };
  if (tenant) query.organizationId = tenant;
  await handler({ method, query, body, headers: {} } as any, res);
  return { status, payload };
}

const initial = await request(undefined, id, 'GET');
assert.equal(initial.status, 200);
for (const field of ['description', 'countryOfManufacture', 'colorName', 'weightGrams', 'category']) assert.equal(initial.payload.product[field], null);
const description = 'Description détaillée réelle, éditable sans inventer les autres attributs.';
assert.equal((await request({ description })).status, 200);
assert.equal(row.description, description);
assert.equal(row.country_of_manufacture, null);
assert.equal((await request({ countryOfManufacture: 'fr' })).payload.product.countryOfManufacture, 'FR');
assert.equal(row.description, description);
assert.equal(row.color_name, null);
assert.equal(row.weight_grams, null);
for (const body of [{ countryOfSpinning: null }, { countryOfManufacture: 'ZZ' }, { weightGrams: -1 }, { weightGrams: '12' }, { sizeRange: [''] }, { sizeRange: ['X'.repeat(41)] }, { sizeRange: Array(51).fill('S') }]) {
  const before = writes;
  const result = await request(body);
  assert.equal(result.status, 400);
  assert.equal(result.payload.field, Object.keys(body)[0]);
  assert.match(result.payload.message, new RegExp(Object.keys(body)[0]));
  assert.equal(writes, before);
}
assert.equal((await request({ description: 'Intrusion' }, other)).status, 404);
assert.equal(row.description, description);
assert.equal((await request({ colorName: 'Inconnu', countryOfDesign: '' })).payload.product.colorName, null);
assert.equal(row.country_of_design, null);
assert.equal(serializeProduct(row).weightGrams, null);
assert.equal(validateProductPatch({ weightGrams: 0 }, row).weightGrams, 0);
assert.throws(() => validateProductPatch({ sizeRange: null } as any, row), ProductFieldError);

/* ------------------------------------------------------------------------- *
 * Contexte de locataire actif — le defaut Production du 2026-10-17.
 *
 * Avant : sans locataire nomme, la route filtrait sur TOUTES les organisations
 * du compte, et un administrateur de Ginger voyait et modifiait la fiche
 * produit de Tracefab Recette Production. Les quatre cas ci-dessous sont
 * fail-closed : aucun ne doit ecrire, et aucun ne doit repondre 200.
 * ------------------------------------------------------------------------- */
{
  const before = writes;
  const missing = await request({ description: 'Sans locataire' }, id, 'PATCH', null);
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.error, 'organization_id_required');
  assert.equal(writes, before, 'un locataire absent ne doit provoquer aucune ecriture');
}
{
  const before = writes;
  const malformed = await request({ description: 'Locataire invalide' }, id, 'PATCH', 'pas-un-uuid');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.payload.error, 'invalid_organization_id');
  assert.equal(writes, before, 'un locataire mal forme ne doit provoquer aucune ecriture');
}
{
  // Le tenant B est une organisation REELLE du compte, mais ce n'est pas le
  // locataire actif ici. La reponse doit etre 404, identique a un identifiant
  // inexistant : la route ne revele pas que le produit existe ailleurs.
  const before = writes;
  const foreign = await request({ description: 'Depuis un autre tenant' }, id, 'PATCH', TENANT_B);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.payload.error, 'organization_not_found');
  assert.equal(writes, before, 'un locataire non adherent ne doit provoquer aucune ecriture');
  assert.equal(row.description, description, 'la fiche du tenant actif doit rester intacte');
}
{
  const before = writes;
  const foreignRead = await request(undefined, id, 'GET', TENANT_B);
  assert.equal(foreignRead.status, 404);
  assert.equal(writes, before);
}

{
  const invalidStatus = await request({ status: 'active' });
  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatus.payload.error, 'invalid_product_status_change');
  assert.equal(row.status, 'draft');
}
{
  const archived = await request({ status: 'archived' });
  assert.equal(archived.status, 200);
  assert.equal(archived.payload.product.status, 'archived');
  const secondArchive = await request({ status: 'archived' });
  assert.equal(secondArchive.status, 409);
  assert.equal(secondArchive.payload.error, 'only_draft_products_can_be_archived');
}

console.log('PASS product edit HTTP handler + serializer: partial edits, nulls, validation, forbidden key, tenant scope and draft archival (DB mocked; RLS tested separately).');
console.log('PASS contexte de locataire actif : absent 400, mal forme 400, autre tenant 404, aucune ecriture dans les trois cas.');
