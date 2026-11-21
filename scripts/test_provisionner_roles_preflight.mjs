#!/usr/bin/env node
/**
 * Garde statique du provisionneur : le préflight classe les ACL pgcrypto
 * Neon-managed comme résiduel documenté, sans faux refus ni REVOKE impossible.
 * Ce test statique ne remplace pas la suite d'intégration PostgreSQL.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./provisionner_roles_db.mjs', import.meta.url), 'utf8');
const debut = source.indexOf('async function preflightPgcryptoAvantEcriture() {');
const fin = source.indexOf('\nasync function assurerExtensions(', debut);
assert.ok(debut >= 0 && fin > debut, 'le préflight pgcrypto existe et est délimité');
const preflight = source.slice(debut, fin);

assert.match(preflight, /pg_catalog\.pg_available_extensions/,
  'l’absence de pgcrypto est évaluée avant les écritures');
assert.match(preflight, /has_database_privilege\(current_user, current_database\(\), 'CREATE'\)/,
  'la capacité d’installation est vérifiée si l’extension est absente');
assert.match(preflight, /pg_catalog\.pg_get_userbyid\(p\.proowner\)/,
  'le propriétaire réel de chaque fonction est mesuré');
assert.match(preflight, /pg_catalog\.aclexplode\([\s\S]*acl\.grantee = 0[\s\S]*EXECUTE/,
  'EXECUTE PUBLIC est lu depuis les ACL effectives');
assert.match(preflight, /pg_catalog\.pg_has_role\(current_user, p\.proowner, 'SET'\)/,
  'la capacité réelle à endosser le propriétaire est vérifiée');
assert.match(preflight, /return 'managed-external'/,
  'les fonctions détenues par un superutilisateur plateforme sont classées, pas bloquées');
assert.match(preflight, /proprietaire_superuser === true/,
  'le classement plateforme exige un propriétaire superutilisateur');
assert.match(preflight, /REFUS AVANT ÉCRITURE — propriétaire externe non classé/,
  'un propriétaire externe non reconnu reste bloquant');
assert.doesNotMatch(preflight, /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:ROLE|SCHEMA|EXTENSION|EXECUTE|CONNECT|USAGE)/i,
  'le préflight lui-même ne contient aucune mutation SQL');

const assuranceDebut = source.indexOf('async function assurerExtensions(modePgcrypto)');
const assuranceFin = source.indexOf('\nasync function assurerDroitsSchema()', assuranceDebut);
assert.ok(assuranceDebut >= 0 && assuranceFin > assuranceDebut, 'le traitement extension est délimité');
const assurance = source.slice(assuranceDebut, assuranceFin);
const brancheManaged = assurance.indexOf("if (modePgcrypto === 'managed-external')");
const brancheRevoke = assurance.indexOf('REVOKE EXECUTE ON FUNCTION');
assert.ok(brancheManaged >= 0 && brancheRevoke > brancheManaged,
  'la branche Neon-managed est évaluée avant toute tentative de REVOKE');
assert.match(assurance.slice(brancheManaged, brancheRevoke), /continue;/,
  'les ACL plateforme sont conservées explicitement, sans tentative de REVOKE');
assert.match(assurance, /if \(modePgcrypto === 'managed-external'\) return;/,
  'aucun GRANT superflu n’est tenté dans le cas où PUBLIC donne déjà EXECUTE');

const blocProvisionnement = source.slice(source.indexOf('if (!verifierSeulement) {'));
const appel = blocProvisionnement.indexOf('await preflightPgcryptoAvantEcriture()');
const creation = blocProvisionnement.indexOf('await assurerRole(ROLE_APP_SURCHARGE');
assert.ok(appel >= 0 && creation > appel,
  'le préflight est exécuté avant toute création ou modification de rôle');
assert.match(blocProvisionnement.slice(0, creation), /await db\.end\(\);[\s\S]*process\.exit\(1\)/,
  'un échec ferme la connexion et sort avant le provisionnement');

assert.match(source, /const modePgcrypto = await preflightPgcryptoAvantEcriture\(\);[\s\S]*assurerExtensions\(modePgcrypto\)/,
  'le mode détecté est transmis au provisionnement effectif');
assert.match(source, /const modePgcrypto = await preflightPgcryptoAvantEcriture\(\);[\s\S]*verifierPublicPgcrypto\(modePgcrypto\)/,
  'le mode --verifier applique la même classification en lecture seule');

console.log('PASS — préflight fail-closed, ACL Neon-managed explicitement conservées, aucun REVOKE/GRANT impossible.');
