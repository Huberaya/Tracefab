import assert from 'node:assert/strict';
import { createProductHandler } from '../api/_routes/products/[productId].js';
import { validateProductPatch, ProductFieldError } from '../api/_lib/product-edit.js';
import { serializeProduct } from '../api/_lib/products.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
let row: any = { id, brand_organization_id: 'tenant-a', reference: 'REAL-1', name: 'Produit réel',
  sku: null, category: null, description: null, product_family: null, color_name: null,
  size_range: [], country_of_design: null, country_of_manufacture: null, weight_grams: null,
  care_instructions: {}, data_completion: 0, product_identifiers: [], product_materials: [] };
let writes = 0;
const handler = createProductHandler({
  requireClerkUser: async () => ({ user: { id: 'user-a', email: 'a@example.test' } }) as any,
  withTracefabUserContext: async (_id: any, _email: any, cb: any) => cb({
    organization_memberships: { findMany: async () => [{ organization_id: 'tenant-a' }] },
    tracefab_products: { findFirst: async ({ where }: any) => where.id === id && where.brand_organization_id.in.includes(row.brand_organization_id) ? row : null },
    $queryRaw: async (_strings: any, ...args: any[]) => {
      writes++;
      const keys = ['reference', 'sku', 'name', 'category', 'description', 'product_family', 'color_name', 'size_range', 'country_of_design', 'country_of_manufacture', 'weight_grams', 'care_instructions'];
      keys.forEach((key, i) => row[key] = key === 'care_instructions' ? JSON.parse(args[i + 1]) : args[i + 1]);
      return [{ id }];
    },
  }),
} as any);
async function request(body: any, productId = id, method = 'PATCH') {
  let status = 0, payload: any;
  const res: any = { getHeader() {}, setHeader() { return this; }, status(n: number) { status = n; return this; }, json(p: any) { payload = p; return this; } };
  await handler({ method, query: { productId }, body } as any, res);
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
console.log('PASS product edit HTTP handler + serializer: partial edits, nulls, validation, forbidden key, tenant scope (DB mocked; RLS tested separately).');
