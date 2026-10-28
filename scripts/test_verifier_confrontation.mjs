#!/usr/bin/env node
/**
 * Le verificateur de confrontation doit mordre — sinon il ne verifie rien.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `verifier_confrontation_production.mjs` est l'instrument qui tranchera le
 * `BLOCKED` de `plm_erp_gs1`. Un instrument qu'on n'a jamais vu echouer ne
 * vaut pas mieux qu'une relecture a l'oeil : tant qu'on ignore ce qu'il refuse,
 * un `PASS` de sa part ne dit rien.
 *
 * Ce test le soumet donc a six etats dont cinq sont faux, et exige de lui :
 *
 *   - PASS  quand rien ne differe ;
 *   - FAIL  quand la regle change : RLS desactivee, politique supprimee, predicat
 *           remplace par `true`, mauvais organisation_id ;
 *   - A QUALIFIER (code 3) quand seul le RENDU change, sans que la regle bouge.
 *
 * Le troisieme point est le plus delicat. Un comparateur qui rend « a qualifier »
 * sur une regle elargie est complaisant ; un comparateur qui rend « fail » sur
 * une difference de cast entre PostgreSQL 17 et 18 est inutilisable. Les deux
 * sont exiges ici, sur le meme instrument.
 *
 * Aucune connexion, aucun secret : tout est local, sur base jetable.
 *
 *   npm run test:confrontation-production
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificateur = path.join(root, 'scripts/verifier_confrontation_production.mjs');

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confrontation-'));

const lancer = (args) => {
  try {
    const sortie = execFileSync('node', [verificateur, ...args], { encoding: 'utf8', cwd: root });
    return { code: 0, sortie };
  } catch (e) {
    return { code: e.status ?? 1, sortie: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

/* -------------------------------------------------------------------------
   1. Le referentiel
   ------------------------------------------------------------------------- */

console.log('\n  1. Referentiel construit a partir du depot');

const refPath = path.join(tmp, 'referentiel.txt');
const gen = lancer([`--ecrire-referentiel=${refPath}`]);
ok('le referentiel se calcule', gen.code === 0, gen.sortie.slice(0, 300));
const ref = fs.readFileSync(refPath, 'utf8').split('\n').filter(Boolean);
ok('le referentiel est substantiel (85 faits attendus)', ref.length === 85, `${ref.length}`);
ok('il porte TOUTES les politiques des quatorze tables (31), pas seulement celles de plm',
  ref.filter((l) => l.startsWith('P|')).length === 31,
  `${ref.filter((l) => l.startsWith('P|')).length}`);
ok('il porte les quatorze tables et les fonctions des cinq',
  ref.filter((l) => l.startsWith('T|')).length === 14 && ref.filter((l) => l.startsWith('F|')).length >= 14,
  `T=${ref.filter((l) => l.startsWith('T|')).length} F=${ref.filter((l) => l.startsWith('F|')).length}`);
ok('il porte les sept lignes d historique (cinq hors bande + les deux correctives)',
  ref.filter((l) => l.startsWith('H|')).length === 7,
  `${ref.filter((l) => l.startsWith('H|')).length}`);
ok('il porte les privileges et l heritage des droits (19 faits G)',
  ref.filter((l) => l.startsWith('G|')).length === 19,
  `${ref.filter((l) => l.startsWith('G|')).length}`);
ok('le role runtime n a ni SUPERUSER ni BYPASSRLS dans le depot',
  ref.some((l) => l.startsWith('G|attributs|tracefab_app|super=false|bypassrls=false')));

/* -------------------------------------------------------------------------
   2. Six etats soumis au verificateur
   ------------------------------------------------------------------------- */

console.log('\n  2. Ce que le verificateur accepte et refuse');

const ecrire = (nom, contenu) => {
  const p = path.join(tmp, nom);
  fs.writeFileSync(p, contenu);
  return p;
};
const muter = (nom, f) => ecrire(nom, `${ref.map(f).filter((l) => l !== null).join('\n')}\n`);

const cas = [
  ['etat conforme', refPath, 0],
  ['RLS desactivee sur une table', muter('m1.txt', (l) => l.replace('|rls=true|', '|rls=false|')), 1],
  ['politique supprimee', muter('m2.txt',
    (l) => (l.startsWith('P|plm_erp_integrations.plm_integrations_select_org') ? null : l)), 1],
  ['predicat remplace par true', muter('m3.txt',
    (l) => l.replace('tracefab_is_org_member(organization_id)', 'true')), 1],
  ['mauvais organisation_id dans la politique', muter('m4.txt',
    (l) => l.replace('tracefab_is_org_member(organization_id)', 'tracefab_is_org_member(brand_organization_id)')), 1],
  ['fonction passee en SECURITY INVOKER', muter('m5.txt',
    (l) => (l.startsWith('F|tracefab_ingest_plm_erp_payload')
      ? l.replace('|secdef=true|', '|secdef=false|') : l)), 1],
  ['EXECUTE ouvert a PUBLIC', muter('m6.txt',
    (l) => (l.startsWith('F|tracefab_calculate_product_pef')
      ? l.replace('|exec_public=false|', '|exec_public=true|') : l)), 1],
  ['corrective deja presente dans l historique', muter('m7.txt',
    (l) => (l.startsWith('H|20261028140000')
      ? 'H|20261028140000_supplier_invitation_owner_relationship_scope|present=1|steps=1|termine=true' : l)), 1],
  ['politique en plus sur une table hors PLM (compteur)', muter('m9.txt',
    (l) => (l.startsWith('T|green_claims_audits|') ? l.replace('|politiques=2|', '|politiques=3|') : l)), 1],
  ['BYPASSRLS accorde au role runtime', muter('m10b.txt',
    (l) => (l.startsWith('G|attributs|tracefab_app|') ? l.replace('bypassrls=false', 'bypassrls=true') : l)), 1],
  ['SUPERUSER accorde au role runtime', muter('m10c.txt',
    (l) => (l.startsWith('G|attributs|tracefab_app|') ? l.replace('super=false', 'super=true') : l)), 1],
  ['ecriture rendue au role runtime sur documents', muter('m10d.txt',
    (l) => (l.startsWith('G|hors-cible|documents|') ? l.replace('app=SELECT', 'app=SELECT,INSERT,UPDATE,DELETE') : l)), 1],
  ['ecriture rendue au role runtime sur une table cible', muter('m10e.txt',
    (l) => (l.startsWith('G|table|green_claims_audits|') ? l.replace('app=SELECT', 'app=SELECT,INSERT') : l)), 1],
  ['historique remis a zero (cinq hors bande effacees)', muter('m10.txt',
    (l) => (l.startsWith('H|2026100622') ? l.replace(/\|present=1\|steps=0\|termine=true$/, '|present=0|steps=-|termine=false') : l)), 1],
  ['rendu seulement : espaces et casts differents', muter('m8.txt',
    (l) => (l.includes("'owner'::membership_role")
      ? l.replace("'owner'::membership_role", "'owner' :: membership_role") : l)), 3],
];

for (const [libelle, fichier, attendu] of cas) {
  const r = lancer([fichier, `--referentiel=${refPath}`]);
  const nom = attendu === 0 ? 'PASS' : attendu === 1 ? 'FAIL' : 'A QUALIFIER';
  ok(`${libelle} → ${nom} (code ${attendu})`, r.code === attendu,
    `code ${r.code} — ${r.sortie.split('\n').filter((l) => /ECHEC|QUALIFIER/.test(l)).slice(0, 3).join(' | ')}`);
}

/* -------------------------------------------------------------------------
   2 ter. Le perimetre restreint ne masque rien de ce qu'il lit
   ------------------------------------------------------------------------- */

console.log('\n  2 ter. Comparaison limitee aux deux tables PLM');

// La requete du 28/10 n'interrogeait que les politiques de ces deux tables.
// Sans le drapeau, les vingt-sept politiques des douze autres passeraient pour
// des divergences. Avec, la comparaison doit rester stricte sur ce qui a ete lu.
const plmRef = ecrire('plm-referentiel.txt',
  `${ref.filter((l) => !l.startsWith('P|') || l.startsWith('P|plm_erp_')).join('\n')}\n`);
const rPlm = lancer([plmRef, plmRef, '--perimetre-plm']);
ok('un relevé conforme sur le perimetre PLM → PASS (code 0)', rPlm.code === 0,
  `code ${rPlm.code} — ${rPlm.sortie.split('\n').filter((l) => /ECHEC/.test(l)).slice(0, 2).join(' | ')}`);

const plmDerive = ecrire('plm-derive.txt', `${fs.readFileSync(plmRef, 'utf8').trimEnd()}
P|plm_erp_sync_jobs.plm_erp_sync_jobs_select_brand|roles=public|cmd=SELECT|permissive=PERMISSIVE|using=tracefab_is_org_member(brand_organization_id)|check=(aucun)
`);
const rDerive = lancer([plmDerive, plmRef, '--perimetre-plm']);
ok('une politique surnumeraire sur le perimetre PLM → pas un PASS (code 3)', rDerive.code === 3,
  `code ${rDerive.code}`);

/* -------------------------------------------------------------------------
   2 bis. Les deux formats de sortie sont acceptes
   ------------------------------------------------------------------------- */

console.log('\n  2 bis. psql et export CSV du SQL Editor de Neon');

// Le SQL Editor de Neon ne connait pas `-A -t` : on y colle la requete et on
// exporte en CSV. Une ligne d'en-tete prise pour une mesure ferait echouer la
// comparaison pour une raison etrangere a la production.
const csv = ecrire('export.csv', `ligne\n${ref.map((l) => `"${l}"`).join('\n')}\n`);
ok('un export CSV (en-tete + guillemets) donne le meme verdict',
  lancer([csv, `--referentiel=${refPath}`]).code === 0);

const csvFaux = ecrire('export-faux.csv',
  `ligne\n${ref.map((l) => `"${l.replace('|rls=true|', '|rls=false|')}"`).join('\n')}\n`);
ok('un export CSV falsifie echoue quand meme (le format ne masque pas le fond)',
  lancer([csvFaux, `--referentiel=${refPath}`]).code === 1);

/* -------------------------------------------------------------------------
   3. Le verificateur ne peut pas rendre PASS sur une sortie vide ou partielle
   ------------------------------------------------------------------------- */

console.log('\n  3. Une sortie partielle ne passe pas');

const vide = ecrire('vide.txt', '\n\n');
ok('une sortie vide est un echec, pas un silence', lancer([vide, `--referentiel=${refPath}`]).code !== 0);

const partielle = ecrire('partielle.txt', `${ref.slice(0, 3).join('\n')}\n`);
const rp = lancer([partielle, `--referentiel=${refPath}`]);
ok('le perimetre restreint ne desactive pas les onze autres controles de table',
  lancer([muter('m11.txt', (l) => (l.startsWith('T|pef_emission_factors|') ? l.replace('|rls=true|', '|rls=false|') : l)), plmRef, '--perimetre-plm']).code === 1);
ok('trois faits sur quatre-vingt-cinq est un echec, pas un PASS', rp.code === 1, `code ${rp.code}`);
ok('les faits manquants sont nommes', /absent/.test(rp.sortie));

/* -------------------------------------------------------------------------
   4. Le referentiel est stable
   ------------------------------------------------------------------------- */

console.log('\n  4. Stabilite');

const refPath2 = path.join(tmp, 'referentiel2.txt');
lancer([`--ecrire-referentiel=${refPath2}`]);
ok('deux constructions successives donnent le meme referentiel',
  fs.readFileSync(refPath, 'utf8') === fs.readFileSync(refPath2, 'utf8'));

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le verificateur refuse les falsifications et accepte le rendu conforme.');
  console.log('  Il peut donc trancher le BLOCKED de plm_erp_gs1.\n');
  process.exit(0);
}
console.log(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
