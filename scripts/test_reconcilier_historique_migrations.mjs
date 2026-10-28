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
 * exports SYNTHETIQUES (aucune donnee de production) et verifie que l'outil
 * distingue les situations reelles.
 *
 * LES CAS QUI COMPTENT, et qui ont tous ete observes sur l'export reel du
 * 28 octobre 2026 :
 *
 *   - une migration peut avoir PLUSIEURS lignes (annulee puis rejouee) :
 *     les ecraser dans une table de hachage effacerait l'information ;
 *   - une ligne annulee suivie d'une reussite est un incident RESOLU, pas un
 *     blocage — c'est la difference entre « rien a faire » et « deploy bloque » ;
 *   - une migration marquee appliquee avec `applied_steps_count = 0` n'a
 *     probablement jamais ete executee : ses objets peuvent manquer ;
 *   - un nom present en production mais absent du depot est une orpheline.
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

/* --- Materiau : les migrations du depot, empreintes reelles --------------- */

const depot = readdirSync(DOSSIER).filter((d) => /^\d{14}_/.test(d)).sort();
const empreinte = (nom) => createHash('sha256')
  .update(readFileSync(join(DOSSIER, nom, 'migration.sql')))
  .digest('hex');
const empreintes = new Map(depot.map((n) => [n, empreinte(n)]));

let compteur = 0;
const ecrire = (contenu, ext = 'json') => {
  compteur += 1;
  const f = join(dir, `export-${compteur}.${ext}`);
  writeFileSync(f, contenu);
  return f;
};

/** Export JSON, la forme qui porte les etats. */
const exporterJson = (lignes) => ecrire(JSON.stringify(lignes.map((l) => ({
  migration_name: l.nom,
  checksum: l.checksum === undefined ? empreintes.get(l.nom) : l.checksum,
  finished_at: l.finished === undefined ? '2026-10-01 10:00:00+00' : l.finished,
  rolled_back_at: l.rolledBack === undefined ? null : l.rolledBack,
  applied_steps_count: l.steps === undefined ? 1 : l.steps,
}))), 'json');

const executer = (args) => {
  const r = spawnSync('node', [OUTIL, ...args], { encoding: 'utf8' });
  return { code: r.status, sortie: `${r.stdout}${r.stderr}` };
};

/* --- 1. Historique complet et conforme ------------------------------------ */

{
  const f = exporterJson(depot.map((nom) => ({ nom })));
  const { code, sortie } = executer([f]);
  controle('un historique complet et conforme sort en 0', code === 0, `code=${code}`);
  controle('le compte du depot est annonce', sortie.includes(`${depot.length} migrations`));
  controle('la conclusion est explicite', /Historique coherent/.test(sortie));
  controle('le commit est imprime (provenance)', /commit\s+:\s+[0-9a-f]{40}/.test(sortie), sortie.slice(0, 200));
}

/* --- 2. Migrations du depot non attestees --------------------------------- */

{
  const manquantes = depot.slice(-7);
  const presentes = depot.filter((n) => !manquantes.includes(n));
  const { code, sortie } = executer([exporterJson(presentes.map((nom) => ({ nom })))]);
  controle('des migrations non attestees font echouer', code === 1, `code=${code}`);
  controle('le nombre d ecarts est exact',
    sortie.includes(`NON ATTESTEES : au depot, aucune execution reussie en production (7)`),
    sortie.slice(0, 400));
  for (const m of manquantes) controle(`la migration absente ${m.slice(0, 14)} est nommee`, sortie.includes(m));
}

/* --- 3. Empreinte divergente ---------------------------------------------- */

{
  const cible = depot[10];
  const f = exporterJson(depot.map((nom) => ({
    nom,
    checksum: nom === cible ? 'f'.repeat(64) : undefined,
  })));
  const { code, sortie } = executer([f]);
  controle('une empreinte divergente fait echouer', code === 1, `code=${code}`);
  controle('la divergence est nommee', sortie.includes(cible));
  controle('l empreinte du depot est affichee', sortie.includes(empreintes.get(cible)));
}

/* --- 4. Le cas reel : annulee PUIS reussie = incident resolu, pas blocage -- */

{
  const cible = depot[depot.length - 8];
  // Ordre REEL de l export du 28/10 : la ligne annulee precede la reussite, et
  // son empreinte differe — c'est le contenu d'avant correction. Un outil qui
  // retiendrait la premiere ligne conclurait a une divergence qui n'existe pas.
  const lignes = [];
  for (const nom of depot) {
    if (nom === cible) lignes.push({ nom, checksum: 'a'.repeat(64), finished: null,
      rolledBack: '2026-10-16 02:04:36+00', steps: 0 });
    lignes.push({ nom });
  }
  const f = exporterJson(lignes);
  const { code, sortie } = executer([f]);
  controle('une annulee suivie d une reussite est classee « incident resolu »',
    /ANNULEES PUIS REUSSIES \(incident resolu\) \(1\)/.test(sortie), sortie.slice(0, 500));
  controle('elle n est PAS comptee comme bloquante', !/BLOQUANTES : ni terminees ni annulees \(1\)/.test(sortie));
  controle('elle n est PAS comptee comme non attestee', !sortie.includes(`NON ATTESTEES : au depot, aucune execution reussie en production (1)`));
  controle('le doublon est signale', /NOMS EN DOUBLE : plusieurs lignes pour une migration \(1\)/.test(sortie));
  controle('la ligne retenue est la REUSSITE, pas l annulation : aucune divergence inventee',
    !/DIVERGENTES : la ligne retenue/.test(sortie), sortie.slice(0, 600));
  controle('l empreinte perimee de la ligne annulee n est pas confondue avec celle du depot',
    !sortie.includes('a'.repeat(64)));
  // Une trace d'incident resolu ne declenche PAS d'echec : elle n'empeche pas
  // `migrate deploy` de fonctionner. La distinction vaut d'etre tenue : c'est
  // elle qui separe « rien a faire » de « historique bloque ».
  controle('un incident resolu ne fait pas echouer la reconciliation', code === 0, `code=${code}`);
  controle('mais il reste visible dans le rapport', /ANNULEES PUIS REUSSIES/.test(sortie));
}

/* --- 5. Une vraie bloquante : ni terminee ni annulee ---------------------- */

{
  const cible = depot[depot.length - 9];
  const f = exporterJson([
    ...depot.map((nom) => ({ nom })),
    { nom: cible, finished: null, rolledBack: null, steps: 0 },
  ]);
  const { code, sortie } = executer([f]);
  controle('une entree ni terminee ni annulee est BLOQUANTE',
    /BLOQUANTES : ni terminees ni annulees \(1\)/.test(sortie), sortie.slice(0, 500));
  controle('elle est nommee', sortie.includes(cible));
  controle('le blocage fait echouer', code === 1);
}

/* --- 6. Marquees appliquees sans etape : toujours visibles ---------------- */

{
  // Le classement (hors bande / inexplique) est teste en 6 bis. Ici, on verifie
  // seulement qu'aucune migration a 0 etape ne disparait du rapport : un
  // diagnostic qui passe sous silence une ligne anormale ne sert a rien.
  const cibles = depot.slice(5, 8);
  const f = exporterJson(depot.map((nom) => ({
    nom,
    steps: cibles.includes(nom) ? 0 : 1,
  })));
  const { sortie } = executer([f]);
  for (const c of cibles) {
    controle(`la migration sans etape ${c.slice(0, 14)} apparait dans le rapport`, sortie.includes(c));
  }
  controle('les 0 etape sont separes en deux categories (avec / sans lanceur)',
    /APPLIQUEES HORS BANDE|SANS EXECUTEUR CONNU/.test(sortie), sortie.slice(0, 600));
}

/* --- 6 bis. 0 etape : hors bande (lanceur du depot) vs inexplique ---------- */

{
  // Cas reel du 28/10 : `20261006250000_universal_supplier_passport` porte
  // applied_steps_count = 0 en production, et le depot contient
  // `apply_migration_chantier6_passport.mjs` qui execute EXACTEMENT ce fichier.
  // L'application hors bande explique le 0 ; ce n'est pas un oubli d'execution.
  const avecLanceur = '20261006250000_universal_supplier_passport';
  controle('la migration choisie a bien un lanceur dans le depot',
    depot.includes(avecLanceur));

  const f = exporterJson(depot.map((nom) => ({ nom, steps: nom === avecLanceur ? 0 : 1 })));
  const { code, sortie } = executer([f]);
  controle('un 0 etape avec lanceur est classe « hors bande »',
    /APPLIQUEES HORS BANDE : 0 etape, mais un lanceur du depot existe \(1\)/.test(sortie),
    sortie.slice(0, 600));
  controle('le lanceur est nomme', /chantier6_passport/.test(sortie));
  controle('un 0 etape explique ne fait PAS echouer la reconciliation', code === 0, `code=${code}`);

  // A l'inverse, un 0 etape qu'aucun script du depot n'explique reste une
  // anomalie : les objets peuvent manquer, et `deploy` ne rejouera pas.
  const sansLanceur = '20260923140000_tracefab_clerk_context';
  const g = exporterJson(depot.map((nom) => ({ nom, steps: nom === sansLanceur ? 0 : 1 })));
  const r = executer([g]);
  controle('un 0 etape sans executeur connu est signale',
    /SANS EXECUTEUR CONNU \(1\)/.test(r.sortie), r.sortie.slice(0, 600));
  controle('il nomme la migration', r.sortie.includes(sansLanceur));
  controle('il fait echouer la reconciliation', r.code === 1, `code=${r.code}`);
}

/* --- 7. Orpheline cote production ----------------------------------------- */

{
  const f = exporterJson([
    ...depot.map((nom) => ({ nom })),
    { nom: '20260101000000_migration_fantome', checksum: 'a'.repeat(64) },
  ]);
  const { code, sortie } = executer([f]);
  controle('une orpheline fait echouer', code === 1, `code=${code}`);
  controle('l orpheline est nommee', sortie.includes('20260101000000_migration_fantome'));
}

/* --- 8. Formats acceptes -------------------------------------------------- */

{
  // CSV avec en-tete : meme verdict que le JSON sur un historique conforme.
  const csv = ['migration_name,checksum,finished_at,rolled_back_at,applied_steps_count',
    ...depot.map((n) => `${n},${empreintes.get(n)},2026-10-01 10:00:00+00,,1`)].join('\n');
  const r = executer([ecrire(csv, 'csv')]);
  controle('un CSV avec en-tete est lu', r.code === 0, `code=${r.code} ${r.sortie.slice(0, 200)}`);

  // Une ligne CSV dont le champ `logs` contient des virgules ne doit pas
  // decaler les colonnes : le decoupage respecte les guillemets.
  const csvGuillemets = ['migration_name,checksum,finished_at,rolled_back_at,applied_steps_count,logs',
    ...depot.map((n, i) => i === 0
      ? `"${n}",${empreintes.get(n)},2026-10-01 10:00:00+00,,1,"erreur, avec des virgules, et un ""guillemet"""`
      : `${n},${empreintes.get(n)},2026-10-01 10:00:00+00,,1,`)].join('\n');
  const g = executer([ecrire(csvGuillemets, 'csv')]);
  controle('les champs CSV entre guillemets ne decalent pas les colonnes', g.code === 0,
    `code=${g.code} ${g.sortie.slice(0, 300)}`);

  // Sans en-tete : noms et empreintes suffisent, mais l'outil ne conclut pas
  // sur les etats — il ne suppose jamais « terminee » par silence.
  const sansEntete = ecrire(depot.map((n) => `${n}|${empreintes.get(n)}`).join('\n'), 'txt');
  const s = executer([sansEntete]);
  controle('un export sans en-tete ne conclut pas a la coherence', s.code === 1, `code=${s.code}`);
  controle('l absence d en-tete est signalee', /ETATS INCONNUS/.test(s.sortie));
}

/* --- 9. Garde-fous de forme ----------------------------------------------- */

{
  controle('un export vide est refuse', executer([ecrire('', 'json')]).code === 2);
  controle('un export introuvable est refuse', executer([join(dir, 'absent.json')]).code === 2);
  controle('sans argument, l outil explique son usage', executer([]).code === 2);
  controle('un JSON sans nom de migration est refuse', executer([ecrire('{"a":1}', 'json')]).code === 2);
}

console.log(`\n  ${verifies} verifications passees.`);
console.log('  Aucune connexion ouverte : les exports sont synthetiques.\n');
