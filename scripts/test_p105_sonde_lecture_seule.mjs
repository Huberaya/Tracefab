#!/usr/bin/env node
/**
 * P10.5 — la sonde de production est-elle vraiment en LECTURE SEULE ?
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * `docs/security/2026-10-31-p105-sonde-connexions-lecture-seule.sql` est le
 * seul document que la mission laisse a un operateur pour mesurer l'etat reel
 * de la production. Un document pareil se degrade sans que personne ne le
 * remarque : une ligne ajoutee pour « verifier » un GRANT, un `UPDATE` de
 * confort, et la sonde devient une modification. Personne ne le verrait, et
 * la mission interdit precisement d'ecrire en production.
 *
 * Ce script exige donc trois choses, dans cet ordre :
 *
 *   1. STATIQUE — chaque instruction du fichier commence par SELECT ou WITH.
 *      Pas une seule exception : la regle est plus facile a tenir qu'une liste
 *      d'interdits.
 *   2. DYNAMIQUE — toutes les instructions s'executent sans erreur sur une base
 *      migree et rembourree, dans une transaction `READ ONLY`.
 *   3. NEGATIVE — dans cette meme transaction, une ecriture est REFUSEE par le
 *      moteur (25006). Un document dont on affirme qu'il ne modifie rien doit
 *      le prouver par un refus, pas par une relecture attentive.
 *
 * Elle verifie aussi que deux executions successives rendent le meme resultat :
 * une sonde qui change d'un passage a l'autre mesure le temps, pas l'etat.
 *
 * Env : DATABASE_URL. Sortie : 0 conforme · 1 regression · 2 non execute.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const CHEMIN = 'docs/security/2026-10-31-p105-sonde-connexions-lecture-seule.sql';
const URL = (process.env.DATABASE_URL || '').trim();
if (!URL) {
  console.error('  NON EXECUTE — DATABASE_URL est requise.');
  process.exit(2);
}

let assertions = 0;
let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

/* --- 1. statique ---------------------------------------------------------- */
const source = readFileSync(CHEMIN, 'utf8');
const sansCommentaires = source.replace(/--[^\n]*/g, '');
const instructions = sansCommentaires
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const nonSelect = instructions.filter((s) => !/^(select|with)\b/i.test(s));
ok(instructions.length >= 15, 'la sonde porte toutes ses sections', `${instructions.length} instructions`);
ok(nonSelect.length === 0,
  'chaque instruction commence par SELECT ou WITH — aucune ecriture possible par construction',
  nonSelect.length ? nonSelect[0].slice(0, 60) : 'aucune exception');
ok(!/insert\s+into|update\s+\w+\s+set|delete\s+from|grant\s+|revoke\s+|alter\s+|drop\s+|create\s+(table|role|function)/i
  .test(sansCommentaires),
  'aucun mot-cle d ecriture ou de DDL dans le code execute');

/* --- 2 et 3. dynamique et negative --------------------------------------- */
const client = new pg.Client({ connectionString: URL, ssl: sslDepuisUrl(URL), application_name: 'tracefab-p105-sonde-verif' });
await client.connect();

const executer = async () => {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
  const resultats = [];
  let erreur = null;
  let refus = null;
  try {
    for (const requete of instructions) {
      try {
        const r = await client.query(requete);
        resultats.push(JSON.stringify(r.rows));
      } catch (e) {
        erreur = `${e.code} ${e.message.split('\n')[0].slice(0, 70)} :: ${requete.slice(0, 50).replace(/\s+/g, ' ')}`;
        resultats.push(null);
        break;
      }
    }
    // Sonde d'ecriture au nom conventionnel du depot : si elle passe, le
    // message est sans ambiguite.
    try {
      await client.query('CREATE TABLE tracefab_readonly_probe (x int)');
      refus = 'ACCEPTEE';
      console.log('         UNE ECRITURE A REUSSI dans la transaction de la sonde');
    } catch (e) {
      refus = e.code;
      if (!/read-only transaction/i.test(e.message)) {
        console.log(`         refus inattendu (${e.code}) — attendu une read-only transaction`);
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return { resultats, erreur, refus };
};

const premier = await executer();
ok(premier.erreur === null, 'toutes les instructions s executent sur une base migree', premier.erreur || 'aucune erreur');
ok(premier.refus === '25006', 'le moteur REFUSE une ecriture dans la transaction de la sonde — read-only transaction (25006)', premier.refus || 'refus non observe');

const second = await executer();
// La sonde rend l'horodatage de la mesure (bloc 1, `now()`), qui change par
// construction. On neutralise les horodatages AVANT de comparer : sans cela,
// l'egalite serait fausse et l'assertion ne mesurerait que l'ecoulement du
// temps. Ce qui doit etre identique, c'est l'ETAT, pas l'heure de la mesure.
const normaliser = (resultats) => (resultats || []).map((r) => (r === null ? null
  : r.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)?/g, '<horodatage>')));
ok(JSON.stringify(normaliser(premier.resultats)) === JSON.stringify(normaliser(second.resultats)),
  'deux executions rendent le meme etat — la sonde ne modifie rien');

await client.end();

console.log('');
if (echecs === 0) {
  console.log(`  Sonde de production : ${assertions} assertions — lecture seule prouvee, pas seulement annoncee.`);
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
process.exit(1);
