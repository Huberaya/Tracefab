#!/usr/bin/env node
/**
 * Garde statique : migration et provisioning doivent appliquer le même
 * périmètre de droits sur tracefab_products.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLONNES_INSERT_PRODUIT,
  COLONNES_UPDATE_PRODUIT,
  COLONNES_CALCULEES_PRODUIT,
  COLONNES_ECRITURE_PRODUIT,
} from './lib/tracefab_app_role.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20261028130000_product_computed_fields_column_scoped/migration.sql'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'scripts/lib/tracefab_app_role.mjs'), 'utf8');

const expectedInsert = [
  'id', 'brand_organization_id', 'reference', 'sku', 'name', 'category',
  'status', 'public_slug', 'created_by', 'created_at', 'updated_at',
  'description', 'product_family', 'color_name', 'size_range',
  'country_of_design', 'country_of_manufacture', 'weight_grams',
  'care_instructions', 'last_data_updated_by',
];
const expectedUpdate = [
  'name', 'category', 'status', 'sku', 'description', 'updated_at',
  'weight_grams', 'country_of_manufacture', 'country_of_design',
];

assert.deepEqual(COLONNES_INSERT_PRODUIT, expectedInsert, 'INSERT doit rester borné aux 20 colonnes nécessaires');
assert.deepEqual(COLONNES_UPDATE_PRODUIT, expectedUpdate, 'UPDATE doit rester limité aux 9 colonnes écrites directement');
assert.deepEqual(COLONNES_ECRITURE_PRODUIT, expectedInsert, 'alias historique = périmètre INSERT uniquement');
assert.equal(COLONNES_CALCULEES_PRODUIT.some((c) => COLONNES_INSERT_PRODUIT.includes(c) || COLONNES_UPDATE_PRODUIT.includes(c)), false, 'aucun champ calculé ne doit être directement insérable/modifiable');

const reserved = ['id', 'brand_organization_id', 'reference', 'public_slug', 'created_by', 'created_at'];
assert.equal(reserved.some((c) => COLONNES_UPDATE_PRODUIT.includes(c)), false, 'les identifiants et métadonnées réservées sont immuables en UPDATE');

const updateBlock = migration.slice(migration.indexOf("EXECUTE 'GRANT UPDATE ("), migration.indexOf('END $tf_acl$'));
assert.notEqual(updateBlock, '', 'la migration doit définir un GRANT UPDATE explicite');
for (const column of expectedUpdate) assert.ok(updateBlock.includes(column), `migration : UPDATE doit accorder ${column}`);
for (const column of reserved) assert.ok(!updateBlock.includes(column), `migration : UPDATE ne doit pas accorder ${column}`);

assert.ok(migration.includes('REVOKE ALL PRIVILEGES (%s) ON TABLE public.tracefab_products FROM tracefab_app'), 'la migration doit retirer les anciennes ACL colonne');
assert.ok(helper.includes('REVOKE ALL PRIVILEGES (%s) ON TABLE public.tracefab_products FROM %I'), 'le provisioning doit retirer les anciennes ACL colonne');
assert.ok(helper.includes('COLONNES_INSERT_PRODUIT.join'), 'le provisioning doit accorder le périmètre INSERT');
assert.ok(helper.includes('COLONNES_UPDATE_PRODUIT.join'), 'le provisioning doit accorder le périmètre UPDATE');

console.log('PASS — migration et provisioning alignés : INSERT 20 colonnes, UPDATE 9 colonnes, aucun champ calculé ou réservé.');
