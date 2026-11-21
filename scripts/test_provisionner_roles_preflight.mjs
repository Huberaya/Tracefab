#!/usr/bin/env node
/**
 * Garde statique du préflight de provisionnement PostgreSQL.
 * Vérifie que la décision de propriété/ACL est prise avant le premier appel
 * susceptible de créer un rôle ou de modifier un privilège.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./provisionner_roles_db.mjs', import.meta.url), 'utf8');
const debut = source.indexOf('async function preflightPgcryptoAvantEcriture() {');
const fin = source.indexOf('\nasync function assurerExtensions()', debut);
assert.ok(debut >= 0 && fin > debut, 'le préflight pgcrypto existe et est délimité');
const preflight = source.slice(debut, fin);

assert.match(preflight, /pg_catalog\.pg_extension[\s\S]*extname = 'pgcrypto'/,
  'le préflight exige une extension pgcrypto existante');
assert.match(preflight, /pg_catalog\.pg_get_userbyid\(p\.proowner\)/,
  'le propriétaire réel de chaque fonction est mesuré');
assert.match(preflight, /pg_catalog\.aclexplode\([\s\S]*acl\.grantee = 0[\s\S]*EXECUTE/,
  'EXECUTE PUBLIC est lu depuis les ACL effectives');
assert.match(preflight, /pg_catalog\.pg_has_role\(current_user, p\.proowner, 'SET'\)/,
  'la capacité réelle à endosser le propriétaire est vérifiée');
assert.match(preflight, /sansAutorite/,
  'un propriétaire non endossable entraîne un refus');
assert.doesNotMatch(preflight, /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:ROLE|SCHEMA|EXTENSION|EXECUTE|CONNECT|USAGE)/i,
  'le préflight lui-même ne contient aucune mutation SQL');

const blocProvisionnement = source.slice(source.indexOf('if (!verifierSeulement) {'));
const appel = blocProvisionnement.indexOf('await preflightPgcryptoAvantEcriture()');
const creation = blocProvisionnement.indexOf('await assurerRole(ROLE_APP_SURCHARGE');
assert.ok(appel >= 0 && creation > appel,
  'le préflight est exécuté avant toute création ou modification de rôle');
assert.match(blocProvisionnement.slice(0, creation), /await db\.end\(\);[\s\S]*process\.exit\(1\)/,
  'un échec ferme la connexion et sort avant le provisionnement');

console.log('PASS — préflight pgcrypto en lecture seule, propriété vérifiée, refus avant toute écriture.');
