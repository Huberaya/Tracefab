#!/usr/bin/env node
/**
 * `20261029180000_plm_erp_sync_jobs_policy_dedup` : la migration est-elle
 * atomique, et faut-il y ajouter `BEGIN`/`COMMIT` ?
 *
 * POURQUOI CE TEST
 *
 * Le rapport du 29/10 laissait la question ouverte : « Prisma encadre
 * normalement chaque migration dans une transaction, mais je ne l'ai pas
 * prouve ici — a confirmer, ou a rendre explicite par BEGIN/COMMIT ».
 * Repondre « il faut ajouter BEGIN/COMMIT » sans mesurer serait une croyance :
 * si le mecanisme d'execution encadre deja chaque fichier, l'ajout est au mieux
 * inutile, au pire un `COMMIT` premature au milieu de la transaction du moteur.
 *
 * CE QUE CE TEST MESURE, sur PostgreSQL 17.10 jetable
 *
 *   A. le fichier REEL, applique comme le font le projet et le moteur Prisma
 *      (une seule requete multi-instructions), laisse l'etat attendu ;
 *   B. une panne AU MILIEU (dernier `CREATE POLICY` invalide), meme mecanisme :
 *      l'etat residuel est IDENTIQUE a l'etat initial — donc atomique ;
 *   C. la meme panne, mais instruction par instruction (autocommit) : l'etat
 *      residuel est PARTIEL (les `DROP` sont passes, les `CREATE` non) — le
 *      contrepoids qui prouve que la mesure B n'est pas un artefact ;
 *   D. la meme panne avec un `BEGIN`/`COMMIT` explicite : atomique aussi, donc
 *      l'ajout n'apporte aucune garantie supplementaire ;
 *   E. le fichier reel reste idempotent (second passage).
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { deriverUrl, creerBaseEphemere } from './lib/ephemeral-db.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const MIG_DIR = join(RACINE, 'prisma', 'migrations');
const CIBLE = '20261029180000_plm_erp_sync_jobs_policy_dedup';

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'atomicite de 20261029180000 — panne intermediaire mesuree',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;

/**
 * Decoupe un script SQL en instructions, en respectant les blocs dollar-quotes
 * (`$$ ... $$`, `$tag$ ... $tag$`) : un `;` a l'interieur n'est pas un
 * separateur. Sert uniquement a simuler un applicateur en autocommit.
 */
function decouper(sql) {
  const instructions = [];
  let courante = '';
  let dollar = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        courante += dollar;
        i += dollar.length - 1;
        dollar = null;
        continue;
      }
      courante += c;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollar = m[0];
        courante += dollar;
        i += dollar.length - 1;
        continue;
      }
    }
    if (c === ';') {
      const s = courante.trim();
      if (s) instructions.push(s);
      courante = '';
      continue;
    }
    courante += c;
  }
  const reste = courante.trim();
  if (reste) instructions.push(reste);
  return instructions;
}

/** Etat des politiques de la table, pour comparer avant/apres. */
async function etat(client) {
  const { rows } = await client.query(`
    SELECT policyname, cmd, permissive, roles::text AS roles,
           coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plm_erp_sync_jobs'
     ORDER BY policyname`);
  return rows;
}

const empreinte = (lignes) => JSON.stringify(lignes);

const base = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_plm_atomicite' });
let client = null;
try {
  const url = base.url;
  client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  client.on('error', () => {});
  await client.connect();

  console.log(`\n  base éphémère unique : ${base.nom} (oid ${base.oid})`);
  console.log(`  même cluster que la maintenance : ${base.identite.systemIdentifier}`);

  /* --- 0. schema complet, sauf la migration etudiee ---------------------- */
  const dossiers = readdirSync(MIG_DIR)
    .filter((n) => statSync(join(MIG_DIR, n)).isDirectory())
    .sort();
  const cible = dossiers.find((d) => d === CIBLE);
  if (!cible) {
    console.error(`  NON EXECUTE — migration ${CIBLE} absente du depot.`);
    process.exit(2);
  }
  for (const d of dossiers) {
    if (d === CIBLE) continue;
    const sql = readFileSync(join(MIG_DIR, d, 'migration.sql'), 'utf8');
    if (!sql.trim() || sql.trim() === '-- This is an empty migration.') continue;
    await client.query(sql);
  }
  console.log(`  ${dossiers.length - 1} migrations appliquées, ${CIBLE} exclue`);

  const sqlReel = readFileSync(join(MIG_DIR, CIBLE, 'migration.sql'), 'utf8');
  const etatInitial = await etat(client);
  verifier('temoin : l état de départ porte les deux politiques canoniques',
    etatInitial.length === 2
      && etatInitial.some((r) => r.policyname === 'plm_sync_jobs_insert_brand')
      && etatInitial.some((r) => r.policyname === 'plm_sync_jobs_select_org'),
    etatInitial.map((r) => r.policyname).join(', '));

  /* --- A. le fichier reel, par le mecanisme du projet --------------------- */
  console.log('\n  A. fichier réel, une seule requête multi-instructions (mécanisme du projet)');

  await client.query(sqlReel);
  const apresA = await etat(client);
  verifier('après application réelle, exactement 2 politiques',
    apresA.length === 2, apresA.map((r) => r.policyname).join(', '));
  verifier('la politique INSERT n autorise pas contributor',
    !/contributor/.test(apresA.find((r) => r.policyname === 'plm_sync_jobs_insert_brand')?.with_check ?? ''),
    apresA.find((r) => r.policyname === 'plm_sync_jobs_insert_brand')?.with_check);
  verifier('la politique SELECT est portée par tracefab_is_org_member',
    /tracefab_is_org_member/.test(apresA.find((r) => r.policyname === 'plm_sync_jobs_select_org')?.qual ?? ''),
    apresA.find((r) => r.policyname === 'plm_sync_jobs_select_org')?.qual);

  /* --- B. panne au milieu, meme mecanisme -------------------------------- */
  console.log('\n  B. panne au MILIEU — une seule requête multi-instructions');

  // Dernier CREATE invalide : les DROP et le premier CREATE ont bien eu lieu
  // avant l'echec. C'est exactement le scenario « interruption entre DROP et
  // CREATE » que le rapport du 29/10 redoutait.
  const sqlCasse = sqlReel.replace(/tracefab_is_org_member\(/g, 'tracefab_fonction_absente(');
  verifier('le témoin est bien altéré (le CREATE final appellera une fonction absente)',
    sqlCasse !== sqlReel && /tracefab_fonction_absente/.test(sqlCasse));

  let erreurB = null;
  try {
    await client.query(sqlCasse);
  } catch (e) {
    erreurB = e;
  }
  const apresB = await etat(client);
  verifier('la panne est bien survenue', erreurB !== null, 'aucune erreur : la panne n a pas eu lieu');
  verifier('ATOMIQUE : l état résiduel est identique à l état d avant la panne',
    empreinte(apresB) === empreinte(apresA),
    `${apresB.length} politique(s) : ${apresB.map((r) => r.policyname).join(', ') || 'aucune'}`);

  /* --- C. contrepoids : autocommit instruction par instruction ----------- */
  console.log('\n  C. contrepoids — mêmes instructions, une par une (autocommit)');

  let erreurC = null;
  let instructionEnEchec = null;
  // Les commentaires de ligne sont retires AVANT le decoupage : le fichier en
  // contient un qui comporte un `;` (`-- ... idempotente ; aucune donnee ...`),
  // et le decouper produirait une fausse instruction.
  const sansCommentaires = sqlCasse
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  for (const instruction of decouper(sansCommentaires)) {
    try {
      await client.query(instruction);
    } catch (e) {
      erreurC = e;
      instructionEnEchec = instruction.split('\n')[0].slice(0, 60);
      break;
    }
  }
  const apresC = await etat(client);
  console.log(`    (mesure) état résiduel après panne en autocommit : ${apresC.length} politique(s)`
    + ` — ${apresC.map((r) => r.policyname).join(', ') || 'aucune'}`);
  verifier('la panne est bien survenue', erreurC !== null, 'aucune erreur en autocommit');
  verifier('NON ATOMIQUE en autocommit : l état résiduel DIFFÈRE de l état initial',
    empreinte(apresC) !== empreinte(apresA),
    `identique (${apresC.map((r) => r.policyname).join(', ')}) — la mesure B ne prouverait rien`);
  verifier('le résidu est bien « politiques supprimées puis non recréées »',
    apresC.length < apresA.length,
    `${apresC.length} politique(s) restante(s) : ${apresC.map((r) => r.policyname).join(', ') || 'aucune'} (panne sur : ${String(instructionEnEchec)})`);

  /* --- D. la variante BEGIN/COMMIT --------------------------------------- */
  console.log('\n  D. variante BEGIN/COMMIT — apporte-t-elle quelque chose ?');

  // On repart d'un etat sain avant de mesurer la variante.
  await client.query(sqlReel);
  const avantD = await etat(client);
  let erreurD = null;
  try {
    await client.query(`BEGIN;\n${sqlCasse}\nCOMMIT;`);
  } catch (e) {
    erreurD = e;
  }
  verifier('la panne est bien survenue', erreurD !== null, 'aucune erreur avec BEGIN/COMMIT');

  // Effet de bord MESURE de la variante explicite : le BEGIN du script ouvre une
  // transaction que l'echec laisse AVORTEE sur la session de l'appelant.
  let poison = null;
  try {
    await client.query('SELECT 1');
  } catch (e) {
    poison = e;
  }
  verifier('avec BEGIN/COMMIT, l échec laisse la session dans une transaction avortée (25P02)',
    poison !== null && poison.code === '25P02',
    poison ? poison.code : 'la session est restée utilisable');

  // On remet la session au propre avant de poursuivre.
  await client.query('ROLLBACK').catch(() => {});

  const apresD = await etat(client);
  verifier('après ROLLBACK, l état résiduel est identique à l état sain',
    empreinte(apresD) === empreinte(avantD),
    `${apresD.length} politique(s) : ${apresD.map((r) => r.policyname).join(', ') || 'aucune'}`);
  verifier('donc BEGIN/COMMIT n ajoute aucune atomicité, mais impose un ROLLBACK à l appelant',
    empreinte(apresB) === empreinte(apresA) && empreinte(apresD) === empreinte(avantD),
    'les deux variantes sont atomiques : le fichier n a pas besoin d être modifié');

  /* --- E. idempotence ----------------------------------------------------- */
  console.log('\n  E. le fichier réel est idempotent');

  await client.query(sqlReel);
  const apresE = await etat(client);
  verifier('un second passage laisse exactement les deux politiques canoniques',
    empreinte(apresE) === empreinte(apresA),
    apresE.map((r) => r.policyname).join(', '));
  verifier('aucune politique surnuméraire n a été créée',
    apresE.length === 2, `${apresE.length} politiques`);
} finally {
  if (client) await client.end().catch(() => {});
  await base.fermer();
  console.log(`\n  base éphémère détruite : ${base.nom}`);
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — la migration est atomique par le mécanisme, sans BEGIN/COMMIT.\n');
process.exit(0);
