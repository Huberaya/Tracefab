#!/usr/bin/env node
/**
 * La reconciliation d'historique doit mordre, et se taire quand tout va bien.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `scripts/reconcilier-historique-migrations.mjs` sert a decider, sans aucune
 * connexion, si la production atteste avoir execute les migrations du depot —
 * et avec quel contenu. Un outil de diagnostic qui rend toujours « coherent »
 * est pire qu'aucun outil : il autorise a conclure. Ce test fabrique donc des
 * exports SYNTHETIQUES surs (aucune donnee de production, aucun secret) et
 * verifie que l'outil distingue cinq situations :
 *
 *   1. historique complet et conforme                -> exit 0
 *   2. migrations du depot non attestees             -> exit 1, liste exacte
 *   3. empreinte divergente pour un meme nom         -> exit 1, nomme
 *   4. migration non terminee, puis annulee          -> exit 1, nommee
 *   5. entree orpheline cote production              -> exit 1, nommee
 *
 * Et deux garde-fous de forme : un export vide est refuse (exit 2), et un
 * export sans en-tete ne doit PAS etre declare coherent — l'outil ne suppose
 * jamais « terminee » par silence.
 *
 *   npm run test:reconciliation-historique
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const OUTIL = 'scripts/reconcilier-historique-migrations.mjs';
const DOSSIER = 'prisma/migrations';
const dir = mkdtempSync(join(tmpdir(), 'tf-reconcil-'));
let verifies = 0;

const controle = (libelle, condition, detail) => {
  assert.ok(condition, `${libelle}${detail ? ' — ' + detail : ''}`);
  verifies += 1;
};

/* --- Materiau : les 63 migrations du depot, empreintes reelles ------------ */

const depot = readdirSync(DOSSIER).filter((d) => /^\d{14}_/.test(d)).sort();
const empreinte = (nom) => createHash('sha256')
  .update(readFileSync(join(DOSSIER, nom, 'migration.sql')))
  .digest('hex');
const empreintes = new Map(depot.map((n) => [n, empreinte(n)]));

const ENTETE = 'migration_name,checksum,finished_at,rolled_back_at,applied_steps_count';

/** Fabrique un export synthetique au format CSV avec en-tete. */
function exporter(lignes) {
  const contenu = [ENTETE, ...lignes.map((l) => {
    const c = empreintes.get(l.nom) ?? '';
    const fin = l.finished ?? '2026-10-01 10:00:00+00';
    const rb = l.rolledBack ?? '';
    return `${l.nom},${l.checksum ?? c},${fin},${rb},1`;
  })].join('\n');
  const f = join(dir, `export-${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(f, contenu);
  return f;
}

function executer(args) {
  const r = spawnSync('node', [OUTIL, ...args], { encoding: 'utf8' });
  return { code: r.status, sortie: `${r.stdout}${r.stderr}` };
}

/* --- 1. Historique complet et conforme ------------------------------------ */

{
  const f = exporter(depot.map((nom) => ({ nom })));
  const { code, sortie } = executer([f]);
  controle('un historique complet et conforme sort en 0', code === 0, `code=${code}`);
  controle('le compte du depot est annonce', sortie.includes(`${depot.length} migrations`));
  controle('la conclusion est explicite', /Historique coherent/.test(sortie));
}

/* --- 2. Migrations du depot non attestees --------------------------------- */

{
  const manquantes = depot.slice(-5); // les cinq plus recentes, comme en production
  const presentes = depot.filter((n) => !manquantes.includes(n));
  const f = exporter(presentes.map((nom) => ({ nom })));
  const { code, sortie } = executer([f]);
  controle('des migrations non attestees font echouer', code === 1, `code=${code}`);
  controle('le nombre d ecarts est exact', sortie.includes('NON ATTESTEES : au depot, jamais executees en production (5)'),
    sortie.slice(0, 400));
  for (const m of manquantes) {
    controle(`la migration absente ${m.slice(0, 14)} est nommee`, sortie.includes(m));
  }
}

/* --- 3. Empreinte divergente ---------------------------------------------- */

{
  const cible = depot[Math.floor(depot.length / 2)];
  const f = exporter(depot.map((nom) => ({
    nom,
    // Une empreinte plausible mais differente : le fichier a change depuis
    // l'execution distante. C'est le cas P3018 des migrations corrigees.
    checksum: nom === cible ? 'f'.repeat(64) : undefined,
  })));
  const { code, sortie } = executer([f]);
  controle('une empreinte divergente fait echouer', code === 1, `code=${code}`);
  controle('la divergence est nommee', sortie.includes(cible));
  controle('la divergence est qualifiee', /EMPREINTE DIVERGENTE/.test(sortie));
  controle('l empreinte du depot est affichee', sortie.includes(empreintes.get(cible)));
}

/* --- 4. Non terminee, puis annulee ---------------------------------------- */

{
  const cible = depot[depot.length - 6];
  const f1 = exporter(depot.map((nom) => ({ nom, finished: nom === cible ? '' : undefined })));
  const r1 = executer([f1]);
  controle('une migration non terminee fait echouer', r1.code === 1, `code=${r1.code}`);
  controle('la non-terminee est nommee', r1.sortie.includes(cible));
  controle('l entree en echec est qualifiee', /NON TERMINEES/.test(r1.sortie));

  const f2 = exporter(depot.map((nom) => ({
    nom,
    finished: nom === cible ? '' : undefined,
    rolledBack: nom === cible ? '2026-10-20 09:00:00+00' : undefined,
  })));
  const r2 = executer([f2]);
  controle('une migration annulee fait echouer', r2.code === 1, `code=${r2.code}`);
  controle('l annulee est qualifiee', /ANNULEES/.test(r2.sortie));
  controle('une annulee n est pas comptee comme non terminee',
    !r2.sortie.includes('NON TERMINEES : `finished_at` absent (1)'));
}

/* --- 5. Orpheline cote production ----------------------------------------- */

{
  const f = exporter([
    ...depot.map((nom) => ({ nom })),
    { nom: '20260101000000_migration_fantome', checksum: 'a'.repeat(64) },
  ]);
  const { code, sortie } = executer([f]);
  controle('une orpheline fait echouer', code === 1, `code=${code}`);
  controle('l orpheline est nommee', sortie.includes('20260101000000_migration_fantome'));
}

/* --- 6. Garde-fous de forme ----------------------------------------------- */

{
  const vide = join(dir, 'vide.csv');
  writeFileSync(vide, '');
  controle('un export vide est refuse', executer([vide]).code === 2);
  controle('un export introuvable est refuse', executer([join(dir, 'absent.csv')]).code === 2);
  controle('sans argument, l outil explique son usage', executer([]).code === 2);

  // Sans en-tete : noms et empreintes suffisent a comparer, mais l'outil ne
  // doit pas conclure « coherent » — il ignore si les migrations ont abouti.
  const sansEntete = join(dir, 'sans-entete.txt');
  writeFileSync(sansEntete, depot.map((n) => `${n}|${empreintes.get(n)}`).join('\n'));
  const r = executer([sansEntete]);
  controle('un export sans en-tete ne conclut pas a la coherence', r.code === 1, `code=${r.code}`);
  controle('l absence d en-tete est signalee', /ETATS INCONNUS/.test(r.sortie));
}

console.log(`\n  ${verifies} verifications passees.`);
console.log('  Aucune connexion ouverte : les exports sont synthetiques.\n');
