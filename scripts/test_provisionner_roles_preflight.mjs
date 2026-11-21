#!/usr/bin/env node
/**
 * Garde statique du provisionneur : vérifie le branchement de la politique
 * pgcrypto testée séparément par une matrice unitaire.
 * Ne remplace pas un test d'intégration PostgreSQL.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./provisionner_roles_db.mjs', import.meta.url), 'utf8');
const policy = await readFile(new URL('./lib/pgcrypto_provisioning_policy.mjs', import.meta.url), 'utf8');
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
assert.match(preflight, /determinerModePgcrypto\(/,
  'la décision de sécurité est déléguée à la politique pure testée');
assert.match(preflight, /migrator_execute/,
  'l’accès du rôle de migration à hmac est vérifié avant les écritures');
assert.match(preflight, /app_direct_execute/,
  'les ACL EXECUTE directes du rôle applicatif sont contrôlées avant les écritures');
assert.match(preflight, /possède déjà des ACL EXECUTE directes/,
  'un octroi direct à l’application refuse avant provisionnement');
assert.match(preflight, /aucune capacité démontrée pour donner EXECUTE sur hmac/,
  'l’absence de droit et de capacité de GRANT refuse avant écriture');
assert.match(preflight, /decision\.mode === 'managed-external'/,
  'le cas Neon-managed est explicitement reconnu');
assert.match(preflight, /REFUS AVANT ÉCRITURE/,
  'un état non classé refuse avant toute écriture');
assert.doesNotMatch(preflight, /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:ROLE|SCHEMA|EXTENSION|EXECUTE|CONNECT|USAGE)/i,
  'le préflight lui-même ne contient aucune mutation SQL');

assert.match(policy, /publiques\.every\([\s\S]*proprietaire_superuser === true[\s\S]*autorite_revoke === false/,
  'le mode Neon-managed exige que toutes les fonctions publiques soient détenues par un superutilisateur externe non endossable');
assert.match(policy, /mélange de propriétaires publics/,
  'les états mixtes restent refusés');

const verifierDebut = source.indexOf('async function verifierPublicPgcrypto(');
const verifierFin = source.indexOf('\nasync function preflightPgcryptoAvantEcriture()', verifierDebut);
assert.ok(verifierDebut >= 0 && verifierFin > verifierDebut, 'le contrôle des ACL pgcrypto est délimité');
const verifier = source.slice(verifierDebut, verifierFin);
assert.match(verifier, /droitsAppHorsPublic/,
  'un droit direct de l’application hors PUBLIC reste détecté comme écart');
assert.match(verifier, /hmac\?\.migrator_execute === true/,
  'le rôle de migration doit conserver EXECUTE sur hmac dans le mode Neon-managed');

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
assert.match(assurance, /if \(modePgcrypto === 'managed-external'\) \{[\s\S]*verifierPublicPgcrypto\('managed-external'\)[\s\S]*return;/,
  'aucun GRANT superflu n’est tenté dans le cas où PUBLIC donne déjà EXECUTE');

const blocProvisionnement = source.slice(source.indexOf('if (!verifierSeulement) {'));
const appel = blocProvisionnement.indexOf('await preflightPgcryptoAvantEcriture()');
const creation = blocProvisionnement.indexOf('await assurerRole(ROLE_APP_SURCHARGE');
assert.ok(appel >= 0 && creation > appel,
  'le préflight est exécuté avant toute création ou modification de rôle');
assert.match(blocProvisionnement.slice(0, creation), /await db\.query\('BEGIN'\)/,
  'les mutations sont encapsulées dans une transaction après le préflight');
assert.match(blocProvisionnement.slice(0, creation), /await db\.end\(\);[\s\S]*process\.exit\(1\)/,
  'un échec ferme la connexion et sort avant le provisionnement');

assert.match(source, /const modePgcrypto = await preflightPgcryptoAvantEcriture\(\);[\s\S]*assurerExtensions\(modePgcrypto\)/,
  'le mode détecté est transmis au provisionnement effectif');
assert.match(source, /const modePgcrypto = await preflightPgcryptoAvantEcriture\(\);[\s\S]*verifierPublicPgcrypto\(modePgcrypto\)/,
  'le mode --verifier applique la même classification en lecture seule');
assert.match(source, /await db\.query\('COMMIT'\)[\s\S]*await db\.query\('ROLLBACK'\)/,
  'le provisionnement valide ou annule atomiquement toutes ses écritures');

assert.match(source, /WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/,
  'le droit SET est accordé temporairement sans ADMIN ni INHERIT');
const transfertTemporaire = source.indexOf('await db.query(`ALTER SCHEMA public OWNER TO ${ROLE_MIGRATOR}`)');
const revokeTemporaire = source.indexOf('await db.query(`REVOKE ${ROLE_MIGRATOR} FROM ${quoteIdent(executant)}`)');
assert.ok(transfertTemporaire >= 0 && revokeTemporaire > transfertTemporaire,
  'l’appartenance temporaire est révoquée immédiatement après le transfert');
assert.match(source, /appartenance temporaire absente/,
  'l’absence d’appartenance privilégiée est vérifiée avant COMMIT');
assert.match(source, /ROLLBACK — provisionnement annulé intégralement/,
  'tout échec de l’étape temporaire annule la transaction et quitte sans poursuivre les contrôles');

console.log('PASS — provisionneur branché sur une politique pure testée, fail-closed et sans REVOKE impossible.');
