#!/usr/bin/env node
/**
 * BANC DE `scripts/lib/colonnes_differees.mjs`.
 *
 * Le 27/10/2026, le verificateur d'identite a refuse de tourner avant migration
 * parce qu'il interrogeait des colonnes creees par les migrations en attente.
 * La correction consiste a distinguer « pas encore mesurable » de « manquant ».
 * Ce banc verrouille cette distinction : sans lui, un futur assouplissement
 * pourrait rendre le script muet sur une vraie colonne absente.
 *
 * Sortie : 0 si tous les cas passent, 1 sinon.
 */
import assert from 'node:assert/strict';
import { colonnesAjouteesPar, classerColonnes } from './lib/colonnes_differees.mjs';

let cas = 0;
const eprouve = (titre, fn) => {
  fn();
  cas += 1;
  console.log(`  ok    ${titre}`);
};

eprouve('ADD COLUMN IF NOT EXISTS est reconnu', () => {
  const noms = colonnesAjouteesPar(['ALTER TABLE dpp_records\n  ADD COLUMN IF NOT EXISTS reviewed_basis_fingerprint TEXT,']);
  assert.ok(noms.has('reviewed_basis_fingerprint'));
});

eprouve('ADD COLUMN sans IF NOT EXISTS est reconnu', () => {
  const noms = colonnesAjouteesPar(['ALTER TABLE t ADD COLUMN "ReviewBasis" TEXT;']);
  assert.ok(noms.has('reviewbasis'));
});

eprouve('un ADD COLUMN cite en commentaire ne cree pas de colonne', () => {
  const noms = colonnesAjouteesPar(['-- on ajoutera ADD COLUMN fantome TEXT\nSELECT 1;']);
  assert.equal(noms.size, 0);
});

eprouve('plusieurs ALTER et plusieurs fichiers sont cumules', () => {
  const noms = colonnesAjouteesPar([
    'ALTER TABLE t ADD COLUMN a TEXT;',
    'ALTER TABLE t ADD COLUMN b TEXT, ADD COLUMN IF NOT EXISTS c TEXT;',
  ]);
  assert.deepEqual([...noms].sort(), ['a', 'b', 'c']);
});

eprouve('une colonne presente est mesurable', () => {
  const r = classerColonnes({ presentes: ['reviewed_at'], ajouteesEnAttente: [], attendues: ['reviewed_at'] });
  assert.deepEqual(r, { mesurables: ['reviewed_at'], differees: [], inattendues: [] });
});

eprouve('une colonne absente mais ajoutee par une migration en attente est differee', () => {
  const r = classerColonnes({
    presentes: ['reviewed_at'],
    ajouteesEnAttente: ['reviewed_basis_fingerprint'],
    attendues: ['reviewed_at', 'reviewed_basis_fingerprint'],
  });
  assert.deepEqual(r.mesurables, ['reviewed_at']);
  assert.deepEqual(r.differees, ['reviewed_basis_fingerprint']);
  assert.deepEqual(r.inattendues, []);
});

eprouve('une colonne absente que rien n\'ajoute est INATTENDUE — jamais differee', () => {
  const r = classerColonnes({ presentes: [], ajouteesEnAttente: ['autre'], attendues: ['disparue'] });
  assert.deepEqual(r.inattendues, ['disparue']);
  assert.deepEqual(r.differees, []);
});

eprouve('la casse ne cree ni faux mesurable ni faux differe', () => {
  const r = classerColonnes({ presentes: ['Review_At'], ajouteesEnAttente: ['AUTRE'], attendues: ['review_at', 'autre'] });
  assert.deepEqual(r.mesurables, ['review_at']);
  assert.deepEqual(r.differees, ['autre']);
});

eprouve('aucune attendue : rien n\'est invente', () => {
  const r = classerColonnes({ presentes: ['a'], ajouteesEnAttente: ['b'], attendues: [] });
  assert.deepEqual(r, { mesurables: [], differees: [], inattendues: [] });
});

console.log(`\n${cas} cas OK — la distinction mesurable / differee / inattendue tient.`);
process.exit(0);
