#!/usr/bin/env node
/**
 * Épreuve de l'outil de comparaison des objets de sécurité.
 *
 * Aucune connexion autorisée à l'environnement audité n'est disponible depuis ce
 * chantier. Les identifiants des deux politiques et de la fonction
 * `SECURITY DEFINER` en écart ne peuvent donc PAS être produits ici, et ce
 * contrôle ne les invente pas : il éprouve l'outil sur des fixtures
 * synthétiques, pour que le jour où une cible autorisée est disponible la
 * comparaison soit fiable du premier coup.
 *
 * Il vérifie aussi que la requête d'inventaire est réellement en lecture seule —
 * un outil destiné à être exécuté sur une cible sensible ne doit pas pouvoir
 * écrire.
 *
 * Sorties : 0 conforme · 1 défaut.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTIL = path.join(RACINE, 'scripts', 'comparer-objets-sql.mjs');
const REQUETE = path.join(RACINE, 'scripts', 'lire-objets-sql.sql');

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
    console.log(`    ECHEC ${etiquette}${detail ? ` — ${detail}` : ''}`);
  }
}

function lance(args) {
  try {
    const sortie = execFileSync('node', [OUTIL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, sortie };
  } catch (e) {
    return { code: e.status ?? -1, sortie: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objets-sql-'));
const ecrire = (nom, lignes) => {
  const p = path.join(tmp, nom);
  fs.writeFileSync(p, lignes.join('\n') + '\n');
  return p;
};

try {
  // Fixture de référence : forme réaliste, mais entièrement synthétique.
  const reference = ecrire('reference.txt', [
    'POLICY public.documents.documents_select_owner',
    'POLICY public.documents.documents_update_owner',
    'POLICY public.suppliers.suppliers_select_authorized',
    'SECDEF public.tracefab_add_dpp_event(uuid, jsonb)',
    'SECDEF public.tracefab_public_brand(uuid)',
  ]);

  /* --- 1. Inventaires identiques ------------------------------------------ */
  console.log('\n  1. inventaires identiques');
  {
    const r = lance(['--reference', reference, '--cible', reference]);
    verifier('sortie 0 quand les inventaires concordent', r.code === 0, `sortie ${r.code}`);
  }

  /* --- 2. L'écart réellement observé : 2 politiques + 1 fonction ----------- */
  console.log('\n  2. écart de la forme observée sur l environnement audité');
  {
    const cible = ecrire('cible-en-plus.txt', [
      ...fs.readFileSync(reference, 'utf8').trim().split('\n'),
      'POLICY public.tracefab_products.politique_supplementaire_1',
      'POLICY public.data_shares.politique_supplementaire_2',
      'SECDEF public.fonction_supplementaire(uuid, text)',
    ]);
    const r = lance(['--reference', reference, '--cible', cible]);
    verifier('sortie 1 en cas de divergence', r.code === 1, `sortie ${r.code}`);
    verifier('les 2 politiques sont nommées', r.sortie.includes('politique_supplementaire_1') && r.sortie.includes('politique_supplementaire_2'), 'noms absents');
    verifier('la fonction est nommée', r.sortie.includes('fonction_supplementaire(uuid, text)'), 'nom absent');
    verifier('le compte annoncé est 3', /absents de la reference\s*:\s*3/.test(r.sortie), 'compte différent');
  }

  /* --- 3. Objet absent de la cible ---------------------------------------- */
  console.log('\n  3. objet présent dans la référence, absent de la cible');
  {
    const cible = ecrire('cible-en-moins.txt', [
      'POLICY public.documents.documents_select_owner',
      'POLICY public.documents.documents_update_owner',
      'SECDEF public.tracefab_add_dpp_event(uuid, jsonb)',
      'SECDEF public.tracefab_public_brand(uuid)',
    ]);
    const r = lance(['--reference', reference, '--cible', cible]);
    verifier('sortie 1', r.code === 1, `sortie ${r.code}`);
    verifier("l'objet manquant est nommé", r.sortie.includes('suppliers_select_authorized'), 'nom absent');
  }

  /* --- 4. Entrées manquantes ou illisibles -------------------------------- */
  console.log('\n  4. entrées manquantes ou illisibles');
  {
    const r = lance(['--reference', reference]);
    verifier('cible absente : sortie 2', r.code === 2, `sortie ${r.code}`);
  }
  {
    const r = lance(['--reference', path.join(tmp, 'inexistant.txt'), '--cible', reference]);
    verifier('référence introuvable : sortie 2', r.code === 2, `sortie ${r.code}`);
  }
  {
    const vide = ecrire('vide.txt', ['POLICY', 'objet', '12 lignes']);
    const r = lance(['--reference', reference, '--cible', vide]);
    verifier('sortie sans ligne exploitable : sortie 2', r.code === 2, `sortie ${r.code}`);
  }
  {
    // NON-RÉGRESSION du 19 octobre. Le comparateur filtrait les lignes non
    // conformes SANS LE DIRE : un inventaire de 245 objets réels plus 4 lignes
    // parasites rendait « inventaires identiques » avec un code de sortie 0.
    // Démontré avant correction sur un inventaire de 245 objets. Sur une cible
    // réelle, un objet rendu dans un format inattendu disparaissait donc de la
    // comparaison sans aucun signal — le faux vert exact que cet outil doit
    // rendre impossible, puisqu'il doit trancher sur les objets divergents.
    const melange = ecrire('cible-bruit.txt', [
      ...fs.readFileSync(reference, 'utf8').trim().split('\n'),
      'politique rendue sur une colonne inattendue',
      '(5 lignes)',
      'POLICY',
    ]);
    const r = lance(['--reference', reference, '--cible', melange]);
    verifier('lignes non conformes : sortie 2, pas un faux vert', r.code === 2, `sortie ${r.code}`);
    verifier(
      'le comparateur ne conclut PAS à des inventaires identiques',
      !/inventaires identiques/i.test(r.sortie),
      'il annonce des inventaires identiques malgré des lignes écartées',
    );
    verifier(
      'les lignes en cause sont montrées',
      /ligne\(s\) non conforme/.test(r.sortie) && r.sortie.includes('(5 lignes)'),
      'diagnostic absent',
    );
  }

  /* --- 5. La requête d'inventaire est bien en lecture seule ---------------- */
  console.log('\n  5. la requête d inventaire ne peut pas écrire');
  {
    const sql = fs.readFileSync(REQUETE, 'utf8');
    // Les commentaires sont écartés : ils citent des verbes pour les expliquer.
    const corps = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const interdits = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'COPY'];
    const trouves = interdits.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(corps));
    verifier('aucun verbe d écriture hors commentaire', trouves.length === 0, trouves.join(', '));
    verifier('la requête lit pg_policies', /from\s+pg_policies/i.test(corps), 'pg_policies absent');
    verifier('la requête lit pg_proc', /from\s+pg_proc/i.test(corps), 'pg_proc absent');
    verifier('elle filtre les fonctions SECURITY DEFINER', /prosecdef/i.test(corps), 'prosecdef absent');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(1);
}
console.log('  ok — l outil de comparaison est éprouvé sur fixtures synthétiques.');
process.exit(0);
