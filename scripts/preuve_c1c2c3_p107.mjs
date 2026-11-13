#!/usr/bin/env node
/**
 * P10.7 — C1/C2/C3, EXECUTES AVEC LE VRAI CODE APPLICATIF
 *
 * NATURE DE CETTE PREUVE — A LIRE AVANT TOUT
 *
 * C'est le COMPLEMENT LOCAL autorise par la mission, PAS la preuve runtime.
 * Les fonctions importees ici sont celles du depot (`api/_lib/identite-systeme.
 * ts`, `identite-jeton.ts`), non modifiees, mais elles tournent dans CE
 * processus Node, pas dans le processus Vercel deploye. La preuve runtime
 * correspondante est produite par `scripts/preuve_runtime_p107.mjs` contre
 * l'URL Preview. Les deux sont rapportees separement, et cette distinction est
 * ecrite dans le fichier de sortie.
 *
 * CE QUI EST MESURE ICI
 *   C1  la signature est calculee cote serveur, et la BASE la verifie
 *       (aller-retour reel, pas un booleen de configuration) ;
 *   C2  la cle est lue dans l'environnement du processus, au format attendu,
 *       et c'est bien ELLE qui signe — une autre cle produit une signature
 *       refusee ;
 *   C3  les huit scenarios d'anti-usurpation, dont la substitution de tenant,
 *       l'usurpation systeme et le jeton expire.
 *
 * AUCUN SECRET N'EST IMPRIME : les cles sont tirees au hasard a l'execution,
 * ne sortent jamais de ce processus, et la base jetable est la seule a les voir.
 *
 * UTILISATION
 *   DATABASE_URL=postgresql://... node --import tsx scripts/preuve_c1c2c3_p107.mjs
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const URL = (process.env.TF_ADMIN_URL || process.env.DATABASE_URL || '').trim();
const SORTIE = 'livrables-finalisation/preuves/p107-c1c2c3-local.json';
const horodatage = new Date().toISOString();

if (!URL) {
  console.error('  ARRET — DATABASE_URL ou TF_ADMIN_URL requis.');
  process.exit(2);
}

// Le code applicatif, tel quel.
const { signerIdentiteSysteme, etatCleSysteme, verifierIdentiteSysteme }
  = await import('../api/_lib/identite-systeme.ts');
const { signerIdentite, etatCleIdentite } = await import('../api/_lib/identite-jeton.ts');

let echecs = 0;
let assertions = 0;
const resultats = [];
const ok = (id, libelle, cond, detail = '') => {
  assertions += 1;
  if (!cond) echecs += 1;
  resultats.push({ id, libelle, verdict: cond ? 'PASS' : 'FAIL', detail });
  console.log(`  ${cond ? 'PASS ' : 'FAIL '} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
};

// LA CLE DE TRAVAIL EST CELLE QUI EST PROVISIONNEE EN BASE.
//
// La base ne verifie pas contre une cle fournie par l'appelant : elle lit
// `tracefab_identity_cles` (le verificateur SECURITY DEFINER la consulte, hors
// de portee du role applicatif — c'est tout l'interet). Signer avec une cle
// tiree au hasard ici ne prouverait donc RIEN : l'aller-retour echouerait pour
// une raison banale, et l'assertion « la base accepte » tomberait.
//
// La cle de travail vient donc de `TRACEFAB_IDENTITY_KEY` — la meme variable que
// le processus applicatif lit reellement — et une MAUVAISE cle distincte sert
// aux controles negatifs. Aucune des deux n'est affichee.
const CLE = (process.env.TRACEFAB_IDENTITY_KEY || '').trim();
const MAUVAISE_CLE = randomBytes(32).toString('hex');
if (!CLE) {
  console.error('  ARRET — TRACEFAB_IDENTITY_KEY requise : c est la cle que la base connait.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: URL });
await client.connect();

/** La base repond-elle « ce jeton est valide » ? C'est le verificateur reel. */
async function baseVerifie(jeton) {
  const { rows } = await client.query(
    'SELECT public.tracefab_identite_systeme_jeton_valide($1) AS v', [jeton]);
  return rows[0]?.v === true;
}

try {
  // ===================== C2 — la cle, dans CE processus ==================
  console.log('\n  --- C2 : la cle est-elle chargee et utilisee par ce processus ---');
  const avant = process.env.TRACEFAB_IDENTITY_KEY;
  process.env.TRACEFAB_IDENTITY_KEY = CLE;
  try {
    ok('C2.1', 'la cle est lue dans l environnement du processus et jugee valide',
      etatCleSysteme() === 'valide', 'format hexadecimal >= 64 caracteres');
    ok('C2.2', 'le jeton utilisateur voit la MEME cle',
      etatCleIdentite() === 'valide', 'une seule variable pour les deux usages');

    // Une cle malformee doit etre un ETAT, pas une panne.
    process.env.TRACEFAB_IDENTITY_KEY = 'pas-hexadecimal';
    ok('C2.3', 'une cle malformee est un ETAT nomme, pas une exception',
      etatCleSysteme() === 'invalide', etatCleSysteme());
    process.env.TRACEFAB_IDENTITY_KEY = '';
    ok('C2.4', 'une cle vide est « absente », distincte de « invalide »',
      etatCleSysteme() === 'absente', etatCleSysteme());
    // Sans cle, aucune signature : le repli silencieux n'existe pas.
    ok('C2.5', 'sans cle, la signature systeme rend null (aucun repli)',
      signerIdentiteSysteme({ cle: undefined }) === null, 'null');
    process.env.TRACEFAB_IDENTITY_KEY = CLE;
    ok('C2.6', 'la cle restauree est de nouveau valide', etatCleSysteme() === 'valide', 'retour a valide');

    // ===================== C1 — signature et verification ================
    console.log('\n  --- C1 : la signature est calculee ici, la BASE la verifie ---');
    const signe = signerIdentiteSysteme({ cle: CLE });
    ok('C1.1', 'une identite systeme est signee', Boolean(signe?.jeton), 'jeton produit');
    ok('C1.2', 'le jeton porte l usage SYSTEME, pas l usage utilisateur',
      String(signe.jeton).startsWith('v1|tracefab_system|'), 'prefixe de corps');

    const accepte = await baseVerifie(signe.jeton);
    ok('C1.3', 'la BASE accepte le jeton signe — aller-retour reel', accepte === true, String(accepte));

    // Une autre cle ne produit pas une signature valide pour cette base.
    const autre = signerIdentiteSysteme({ cle: MAUVAISE_CLE });
    const refuseAutre = await baseVerifie(autre.jeton);
    ok('C1.4', 'une signature produite avec une AUTRE cle est refusee',
      refuseAutre === false, String(refuseAutre));

    // ===================== C3 — anti-usurpation ==========================
    console.log('\n  --- C3 : les scenarios d anti-usurpation ---');

    // a) identite valide -> acceptation (deja mesuree en C1.3, repetee ici)
    ok('C3.1', 'identite valide + signature valide -> ACCEPTEE', accepte === true, 'aller-retour');

    // b) identite MODIFIEE apres signature
    const parties = signe.jeton.split('.');
    const corpsFalsifie = parties[0].replace('tracefab_system', 'tracefab_user');
    ok('C3.2', 'corps MODIFIE apres signature -> REFUSE',
      await baseVerifie(`${corpsFalsifie}.${parties[1]}`) === false, 'refus');

    // c) MAC falsifie
    const macFaux = `${'0'.repeat(64)}`;
    ok('C3.3', 'MAC falsifie -> REFUSE',
      await baseVerifie(`${parties[0]}.${macFaux}`) === false, 'refus');

    // d) MAC en majuscules : deux ecritures du meme jeton interdites
    ok('C3.4', 'MAC en MAJUSCULES -> REFUSE (forme canonique unique)',
      await baseVerifie(`${parties[0]}.${parties[1].toUpperCase()}`) === false, 'refus');

    // e) jeton a deux points : serialisation ambigue
    ok('C3.5', 'jeton a DEUX points -> REFUSE (serialisation non ambigue)',
      await baseVerifie(`${signe.jeton}.nimporte_quoi`) === false, 'refus');

    // f) identite absente
    ok('C3.6', 'jeton ABSENT (null) -> REFUSE', await baseVerifie(null) === false, 'refus');
    ok('C3.7', 'jeton VIDE -> REFUSE', await baseVerifie('') === false, 'refus');

    // g) jeton EXPIRE — signe dans le passe, au-dela du plafond verificateur
    const expire = signerIdentiteSysteme({ cle: CLE, maintenant: Math.floor(Date.now() / 1000) - 3600 });
    ok('C3.8', 'jeton EXPIRE (signe il y a 1 h) -> REFUSE',
      await baseVerifie(expire.jeton) === false, 'refus');

    // h) jeton a duree de vie demesuree — le plafond est cote VERIFICATEUR
    const perenne = signerIdentiteSysteme({ cle: CLE, dureeSecondes: 60 * 60 * 24 * 365 });
    ok('C3.9', 'jeton a duree de vie d un AN -> REFUSE (plafond 600 s cote base)',
      await baseVerifie(perenne.jeton) === false, 'refus');

    // i) USURPATION SYSTEME : un jeton UTILISATEUR ne doit pas ouvrir l'usage systeme
    const jetonUtilisateur = signerIdentite({
      userId: 'user_attaquant', organizationId: 'org_victime', cle: CLE,
    });
    ok('C3.10', 'jeton UTILISATEUR presente comme jeton SYSTEME -> REFUSE',
      await baseVerifie(jetonUtilisateur.jeton) === false, 'refus');

    // j) verification APPLICATIVE du jeton systeme (chemin hors base)
    if (typeof verifierIdentiteSysteme === 'function') {
      const v = await verifierIdentiteSysteme({ jeton: signe.jeton, cle: CLE });
      ok('C3.11', 'verification applicative : jeton valide accepte', v === true || v?.valide === true, JSON.stringify(v)?.slice(0, 60));
      const v2 = await verifierIdentiteSysteme({ jeton: signe.jeton, cle: MAUVAISE_CLE });
      ok('C3.12', 'verification applicative : mauvaise cle -> refus', v2 === false || v2?.valide === false, JSON.stringify(v2)?.slice(0, 60));
    }

    // k) aucun secret dans les sorties produites
    const sortie = JSON.stringify(resultats);
    ok('C3.13', 'aucun fragment de cle dans les resultats',
      !sortie.includes(CLE.slice(0, 16)) && !sortie.includes(MAUVAISE_CLE.slice(0, 16)),
      'recherche des 16 premiers caracteres des deux cles');
  } finally {
    if (avant === undefined) delete process.env.TRACEFAB_IDENTITY_KEY;
    else process.env.TRACEFAB_IDENTITY_KEY = avant;
  }

  mkdirSync(dirname(SORTIE), { recursive: true });
  writeFileSync(SORTIE, `${JSON.stringify({
    schema: 'tracefab-p107-c1c2c3-local-v1',
    horodatage,
    cible: URL.replace(/:\/\/[^@]*@/, '://***@'),
    nature: 'complement-local — PAS la preuve runtime (celle-ci exige le processus Vercel deploye)',
    resultats, echecs,
  }, null, 2)}\n`);
  console.log(`\n  preuves ecrites : ${SORTIE}`);
} finally {
  await client.end().catch(() => {});
}

console.log('');
if (echecs === 0) {
  console.log(`  P10.7 C1/C2/C3 (complement local) : ${assertions} assertions vertes.`);
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
process.exit(1);
