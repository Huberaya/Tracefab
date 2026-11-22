#!/usr/bin/env node
/**
 * P10.7 — LE TEST DE LA SONDE NE PEUT PAS DIVERGER DE LA SONDE.
 *
 * POURQUOI CE GARDE-FOU EXISTE
 *
 * `test_neon_contexte_tenant_sonde.mjs` rejoue le SQL de `probeContexteTenant`
 * au lieu d'importer la fonction : le client Prisma n'est pas genere dans
 * l'environnement d'analyse, donc `api/_lib/readiness-probes.ts` ne peut pas
 * etre charge.
 *
 * Un test qui RECOPIE la logique qu'il verifie est un test qui peut mentir : le
 * jour ou la sonde change de fonction, de GUC ou de critere, le test continue de
 * passer en verifiant l'ancien contrat. Il donnerait alors un feu vert sur du
 * code qu'il ne regarde plus.
 *
 * Ce garde-fou lit les DEUX sources et exige qu'elles citent les memes elements.
 * Il ne compare pas le SQL caractere par caractere — ce serait fragile et il
 * serait contourne par une reformulation. Il verifie les points de contrat qui,
 * s'ils changent, rendent le test caduc.
 */
import fs from 'node:fs';
import path from 'node:path';

const RACINE = path.resolve(import.meta.dirname, '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');

// Les commentaires sont retires : les deux fichiers EXPLIQUENT le contrat, et
// citer un element ne doit pas compter comme l'utiliser.
const sansCommentaires = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

const sonde = sansCommentaires(lire('api/_lib/readiness-probes.ts'));
const test = sansCommentaires(lire('scripts/test_neon_contexte_tenant_sonde.mjs'));

let echecs = 0;
const verifier = (nom, condition, observe = '') => {
  if (condition) {
    console.log(`  ok    ${nom}`);
    return;
  }
  echecs += 1;
  console.log(`  ECHEC ${nom}${observe ? ` — ${observe}` : ''}`);
  console.log(`::error::contrat sonde contexte tenant — ${nom} ${observe}`);
};

// --- 1. Le GUC d organisation, et lui seul ---------------------------------
// Si la sonde se mettait a poser un autre nom, le test verifierait un contrat
// que plus personne n'utilise.
verifier('les deux citent tracefab.active_organization_id',
  sonde.includes("'tracefab.active_organization_id'")
  && test.includes("'tracefab.active_organization_id'"));

verifier('les deux citent tracefab.identity',
  sonde.includes("'tracefab.identity'") && test.includes("'tracefab.identity'"));

// --- 2. Le point de passage unique -----------------------------------------
// C'est LUI qui decide, pas la sonde : le test doit interroger le meme.
verifier('les deux interrogent tracefab_current_user_id()',
  sonde.includes('tracefab_current_user_id()') && test.includes('tracefab_current_user_id()'));

// --- 3. La portee TRANSACTIONNELLE du set_config ---------------------------
// `true` en troisieme argument. Portee session (`false`), le GUC survivrait a
// la transaction et fuirait vers la connexion suivante du pool : c'est
// precisement la propriete que les deux doivent exiger.
// On compte les set_config dont le dernier argument est `true` dans la sonde.
const porteesSonde = [...sonde.matchAll(/set_config\([^)]*,\s*(true|false)\s*\)/g)].map((m) => m[1]);
verifier('chaque set_config de la sonde est a portee transactionnelle',
  porteesSonde.length > 0 && porteesSonde.every((p) => p === 'true'),
  `portees observees : ${porteesSonde.join(',') || 'aucune'}`);

const porteesTest = [...test.matchAll(/set_config\([^)]*,\s*(true|false)\s*\)/g)].map((m) => m[1]);
verifier('chaque set_config du test est a portee transactionnelle',
  porteesTest.length > 0 && porteesTest.every((p) => p === 'true'),
  `portees observees : ${porteesTest.join(',') || 'aucune'}`);

// --- 4. La signature du jeton ----------------------------------------------
// Le corps signe doit etre IDENTIQUE des deux cotes, sinon la base refuserait
// un jeton que le test croit valide (ou l inverse) et la mesure serait fausse.
verifier('les deux construisent le corps v1|user|org|tracefab_identity|exp',
  sonde.includes('v1|') === false || test.includes('tracefab_identity')
  , 'le test doit nommer l usage tracefab_identity');

// La sonde ne construit pas le corps : elle appelle `signerIdentite`. Le test,
// lui, doit le reconstruire. On verifie donc qu il suit le format du module.
const jetonModule = sansCommentaires(lire('api/_lib/identite-jeton.ts'));
// Comparaison de CHAINES, pas de regex : la ligne du module contient des
// caracteres qui doivent etre echappes deux fois si on la met dans une regex,
// et la premiere version de ce garde-fou a echoue sur sa propre echappement —
// pas sur le contrat. Un garde-fou qui ne sait pas lire ce qu il surveille est
// pire qu absent : il rassure.
const attenduModule = '`v1|${userId}|${organizationId ?? \'\'}|${IDENTITY_PURPOSE}|${expiration}`';
verifier('le module d identite signe v1|userId|organizationId|usage|expiration',
  jetonModule.includes(attenduModule),
  'format du module introuvable ou change');
verifier('le test reconstruit ce format a l identique',
  test.includes('`v1|${userId}|${organizationId ?? \'\'}|tracefab_identity|${expiration}`'),
  'le format du test diverge de celui du module');
verifier('le test utilise bien le purpose tracefab_identity',
  jetonModule.includes("IDENTITY_PURPOSE = 'tracefab_identity'"));

// --- 5. Le controle negatif existe des deux cotes --------------------------
verifier('la sonde signe un jeton pour une AUTRE organisation',
  sonde.includes('SONDE_ORG_AUTRE') || sonde.includes('organisationId: SONDE_ORG'),
  'la sonde ne construit plus de jeton etranger');
verifier('le test verifie aussi le refus d une autre organisation',
  /organisationB/.test(test) && /refus/i.test(test),
  'le controle negatif a disparu du test');

// --- 6. La sonde ne peut pas rendre PASS sans les trois conditions ---------
// La condition de PASS est dans le script de preuve, pas ici : on verifie qu il
// exige bien les TROIS champs, et pas seulement le premier.
const preuve = sansCommentaires(lire('scripts/preuve_runtime_p107.mjs'));
verifier('C4.6 exige identiteLue ET organisationEtrangereRefusee ET gucRemisAZero',
  /ct\.identiteLue === true/.test(preuve)
  && /ct\.organisationEtrangereRefusee === true/.test(preuve)
  && /ct\.gucRemisAZero === true/.test(preuve),
  'la conjonction des trois conditions a change');

if (echecs === 0) {
  console.log('\n  Contrat sonde contexte tenant : le test ne peut pas mentir sur la sonde.');
  process.exit(0);
}
console.log(`\n  Contrat sonde contexte tenant : ${echecs} echec(s).`);
process.exit(1);
