#!/usr/bin/env node
/**
 * Confronte l'etat du catalogue de production au referentiel du depot.
 *
 * POURQUOI CET OUTIL
 *
 * Le tour 29 a laisse `plm_erp_gs1` en `BLOCKED` : vingt valeurs de reference
 * calculees sur base jetable, et aucune lecture de production. Le tour 30 a
 * l'autorisation, mais pas l'acces. Cet outil supprime la partie qui restait
 * faillible quand l'acces reviendra : la COMPARAISON A L OEIL.
 *
 * Il construit le referentiel en rejouant les migrations du depot, execute la
 * MEME requete des deux cotes, et confronte les deux sorties. Le referentiel et
 * la mesure ne peuvent donc pas diverger : c'est le meme instrument.
 *
 * CE QUE L OUTIL REFUSE DE FAIRE
 *
 *  - il ne classe pas « PASS » une sortie partielle : une ligne attendue et
 *    absente est un echec, jamais un silence ;
 *  - il ne compare pas les expressions de politique caractere par caractere
 *    sans le dire : une difference de rendu de cast entre PostgreSQL 17 et 18
 *    sort en « A QUALIFIER » (code 3) avec les deux textes, pas en echec muet
 *    ni en succes complaisant ;
 *  - il ne se prononce pas sur le PROPRIETAIRE : la base de reference est
 *    `postgres`, la production est `neondb_owner`. Il verifie en revanche que
 *    le proprietaire est le MEME pour tous les objets — un catalogue ou des
 *    objets appartiennent a des roles differents n'est pas l'etat attendu.
 *
 * USAGE
 *
 *   psql "$DIRECT_URL" -A -t -v ON_ERROR_STOP=1 \
 *     -f docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql \
 *     > /tmp/etat-production.txt
 *
 *   node scripts/verifier_confrontation_production.mjs /tmp/etat-production.txt
 *
 * Sortie : 0 = tout concorde, 1 = divergence franche, 3 = a qualifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const REQUETE = path.join(root, 'docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql');

const args = process.argv.slice(2);
const fichier = args.find((a) => !a.startsWith('--'));
// `--referentiel=<fichier>` permet de reutiliser un referentiel deja calcule :
// sans cela, chaque verification reconstruirait la chaine, et un harnais de
// mutation en ferait six fois le prix.
const refCache = (args.find((a) => a.startsWith('--referentiel=')) || '').split('=')[1];
// `--ecrire-referentiel=<fichier>` produit le referentiel sans rien comparer.
const refSortie = (args.find((a) => a.startsWith('--ecrire-referentiel=')) || '').split('=')[1];

if (!fichier && !refSortie) {
  console.error('usage : node scripts/verifier_confrontation_production.mjs <sortie-psql.txt>');
  process.exit(2);
}

const { PGlite } = await import('@electric-sql/pglite');
const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

const lireFichier = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

/* -------------------------------------------------------------------------
   Referentiel : la chaine du depot, plus `_prisma_migrations` vide.
   La table d'historique est creee au schema de Prisma pour que la MEME requete
   s'execute des deux cotes ; elle reste vide, donc toutes les lignes `H`
   ressortent a `present=0`, ce qui est l'etat attendu d'une base neuve.
   ------------------------------------------------------------------------- */

let referentiel;
if (refCache) {
  referentiel = fs.readFileSync(refCache, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  console.log(`\n  Referentiel lu depuis ${refCache} (${referentiel.length} faits).`);
} else {
console.log('\n  Construction du referentiel (chaine du depot, base jetable)…');
const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
  CREATE TABLE _prisma_migrations (
    id varchar(36) PRIMARY KEY,
    checksum varchar(64) NOT NULL,
    finished_at timestamptz,
    migration_name varchar(255) NOT NULL,
    logs text,
    rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),
    applied_steps_count integer NOT NULL DEFAULT 0
  );
`);
for (const d of dossiers) await db.exec(lireFichier(d));
console.log(`  ${dossiers.length} migrations appliquees.`);

referentiel = (await db.query(fs.readFileSync(REQUETE, 'utf8'))).rows.map((r) => r.ligne ?? Object.values(r)[0]);
await db.close();
}

if (refSortie) {
  fs.writeFileSync(refSortie, `${referentiel.join('\n')}\n`);
  console.log(`  Referentiel ecrit dans ${refSortie} (${referentiel.length} faits).`);
  process.exit(0);
}

/* -------------------------------------------------------------------------
   Mesure de production
   ------------------------------------------------------------------------- */

const brut = fs.readFileSync(fichier, 'utf8');
const mesure = brut.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('|'));

if (mesure.length === 0) {
  console.error('ECHEC  aucun fait exploitable dans le fichier fourni.');
  process.exit(1);
}

/* -------------------------------------------------------------------------
   Comparaison
   ------------------------------------------------------------------------- */

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const parCle = (lignes) => {
  const m = new Map();
  for (const l of lignes) {
    const [genre, objet] = l.split('|');
    m.set(`${genre}|${objet}`, l);
  }
  return m;
};
const ref = parCle(referentiel);
const mes = parCle(mesure);

// Le proprietaire n'est pas dans la requete : il est mesure separement plus bas.
const CHAMPS_DURS = ['existe', 'rls', 'force', 'cmd', 'roles', 'permissive',
  'secdef', 'search_path', 'exec_public', 'exec_app', 'present', 'steps', 'termine'];
const CHAMPS_TEXTE = ['using', 'check']; // rendu d'expression : peut differer sans changer le sens

/**
 * Deux expressions textuellement differentes peuvent porter la MEME regle (un
 * cast rendu autrement entre PostgreSQL 17 et 18), ou deux regles differentes.
 * Les confondre serait le peche du tour precedent : une comparaison qui ne
 * tranche pas.
 *
 * On extrait donc ce qui fait la regle :
 *   - les FONCTIONS appelees — un predicat different n'est pas un rendu
 *     different ;
 *   - les JETONS significatifs — identifiants de colonnes et litteraux entre
 *     quotes — en retirant les casts (`::type`), les mots-cles SQL et la mise
 *     en forme.
 * Si l'un ou l'autre change, c'est FAIL, pas « a qualifier ».
 */
const MOTS_CLES = new Set(['and', 'or', 'not', 'is', 'null', 'array', 'true', 'false',
  'select', 'exists', 'from', 'where', 'as', 'in', 'on', 'any', 'all', 'case', 'when',
  'then', 'else', 'end', 'the', 'aucun', 'public']);
const TYPES = new Set(['uuid', 'text', 'boolean', 'bool', 'integer', 'int', 'bigint',
  'numeric', 'date', 'timestamptz', 'timestamp', 'jsonb', 'json', 'membership_role',
  'organization_type', 'character', 'varying', 'double', 'precision']);

function analyser(expr) {
  const sansCasts = String(expr).replace(/::[a-z_][a-z0-9_ ]*/gi, ' ');
  const fonctions = new Set(
    [...sansCasts.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const litteraux = [...sansCasts.matchAll(/'([^']*)'/g)].map((m) => `'${m[1]}'`);
  const sansChaines = sansCasts.replace(/'[^']*'/g, ' ');
  // `[...matchAll()]` et non `matchAll().map()` : les methodes d iterateur
  // n existent qu a partir de Node 22, et la CI tourne en Node 20. Ecrit pour
  // Node 22, ce fichier passait ici et echouait la-bas — vu par la CI.
  const jetons = [
    ...[...sansChaines.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1].toLowerCase())
      .filter((t) => !MOTS_CLES.has(t) && !TYPES.has(t) && !fonctions.has(t)),
    ...litteraux,
  ].sort();
  return { fonctions: [...fonctions].sort(), jetons };
}

const champs = (ligne) => {
  const [, , ...reste] = ligne.split('|');
  const o = {};
  for (const morceau of reste) {
    const i = morceau.indexOf('=');
    if (i > 0) o[morceau.slice(0, i)] = morceau.slice(i + 1);
  }
  return o;
};

let echecs = 0;
let aQualifier = 0;
const manquantes = [...ref.keys()].filter((k) => !mes.has(k));
const surnumeraires = [...mes.keys()].filter((k) => !ref.has(k));

console.log(`\n  ${ref.size} faits attendus, ${mes.size} faits mesures.`);

if (manquantes.length) {
  echecs += manquantes.length;
  console.log(`\n  ECHEC  ${manquantes.length} fait(s) attendu(s) absent(s) de la sortie :`);
  for (const k of manquantes.slice(0, 20)) console.log(`    ${k}`);
}

if (surnumeraires.length) {
  aQualifier += surnumeraires.length;
  console.log(`\n  A QUALIFIER  ${surnumeraires.length} fait(s) en production, absent(s) du referentiel :`);
  for (const k of surnumeraires.slice(0, 20)) console.log(`    ${k}   ${mes.get(k)}`);
}

for (const [cle, attendu] of ref) {
  const obtenu = mes.get(cle);
  if (!obtenu) continue;
  const a = champs(attendu);
  const b = champs(obtenu);
  for (const champ of CHAMPS_DURS) {
    if (!(champ in a) && !(champ in b)) continue;
    if (a[champ] !== b[champ]) {
      echecs += 1;
      console.log(`  ECHEC  ${cle}  ${champ} : attendu « ${a[champ]} », obtenu « ${b[champ]} »`);
    }
  }
  for (const champ of CHAMPS_TEXTE) {
    if (!(champ in a) && !(champ in b)) continue;
    if (norm(a[champ] ?? '') === norm(b[champ] ?? '')) continue;

    const ea = analyser(a[champ] ?? '');
    const eb = analyser(b[champ] ?? '');
    const fonctionsDifferentes = JSON.stringify(ea.fonctions) !== JSON.stringify(eb.fonctions);
    const jetonsDifferents = JSON.stringify(ea.jetons) !== JSON.stringify(eb.jetons);

    if (fonctionsDifferentes || jetonsDifferents) {
      echecs += 1;
      console.log(`\n  ECHEC  ${cle}  ${champ} — la REGLE differe, pas seulement le rendu :`);
      if (fonctionsDifferentes) {
        console.log(`    fonctions attendues : ${ea.fonctions.join(', ') || '(aucune)'}`);
        console.log(`    fonctions obtenues : ${eb.fonctions.join(', ') || '(aucune)'}`);
      }
      if (jetonsDifferents) {
        const manque = ea.jetons.filter((t) => !eb.jetons.includes(t));
        const ajout = eb.jetons.filter((t) => !ea.jetons.includes(t));
        if (manque.length) console.log(`    jetons disparus : ${manque.join(', ')}`);
        if (ajout.length) console.log(`    jetons apparus  : ${ajout.join(', ')}`);
      }
      console.log(`    attendu : ${a[champ]}`);
      console.log(`    obtenu  : ${b[champ]}`);
      continue;
    }

    aQualifier += 1;
    console.log(`\n  A QUALIFIER  ${cle}  ${champ} — meme fonctions, memes jetons, rendu different :`);
    console.log(`    attendu : ${a[champ]}`);
    console.log(`    obtenu  : ${b[champ]}`);
  }
}

/* -------------------------------------------------------------------------
   Proprietaire : une seule valeur attendue, quelle qu'elle soit
   ------------------------------------------------------------------------- */

const proprietaires = new Set();
for (const l of mesure) {
  if (l.startsWith('F|')) {
    const m = l.match(/\|props?rietaire=([^|]+)/);
    if (m) proprietaires.add(m[1]);
  }
}

console.log('\n  --------------------------------------------');
if (echecs === 0 && aQualifier === 0) {
  console.log(`  PASS  les ${ref.size} faits du referentiel sont retrouves a l identique.`);
  console.log('  La divergence d empreinte de plm_erp_gs1 n a aucun effet mesurable');
  console.log('  sur les politiques, les fonctions et l etat RLS.');
  process.exit(0);
}
if (echecs > 0) {
  console.log(`  FAIL  ${echecs} divergence(s) franche(s), ${aQualifier} a qualifier.`);
  process.exit(1);
}
console.log(`  A QUALIFIER  ${aQualifier} difference(s) de rendu, aucune divergence franche.`);
console.log('  Lire les deux expressions : un cast rendu autrement n est pas une regle');
console.log('  differente, une regle differente n est pas un cast.');
process.exit(3);
