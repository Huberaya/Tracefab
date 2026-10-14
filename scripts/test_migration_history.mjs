#!/usr/bin/env node
import assert from 'node:assert/strict';
import { compareMigrationHistory } from './lib/migration-history-check.mjs';

const names = ['20261001090000_first', '20261001100000_second'];
const success = (migration_name) => ({ migration_name, started_at: new Date(), finished_at: new Date(), rolled_back_at: null });
const failed = (migration_name) => ({ migration_name, started_at: new Date(), finished_at: null, rolled_back_at: null });
const rolledBack = (migration_name) => ({ migration_name, started_at: new Date(), finished_at: null, rolled_back_at: new Date() });

let checks = 0;
function test(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok    ${label}`);
}

test('historique cohérent : succès', () => {
  const r = compareMigrationHistory(names, names.map(success));
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, names);
});

test('migration absente de la base : échec', () => {
  const r = compareMigrationHistory(names, [success(names[0])]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending, [names[1]]);
});

test('migration en cours ou échouée non résolue : échec', () => {
  const r = compareMigrationHistory(names, [success(names[0]), failed(names[1])]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, [names[1]]);
});

test('migration annulée sans application réussie : échec', () => {
  const r = compareMigrationHistory(names, [success(names[0]), rolledBack(names[1])]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, [names[1]]);
});

test('migration enregistrée mais absente du dépôt : divergence', () => {
  const r = compareMigrationHistory(names, [...names.map(success), success('20261001110000_unknown')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ['20261001110000_unknown']);
});

test('tentative non résolue même avec une ligne de succès : échec conservateur', () => {
  const r = compareMigrationHistory(names, [success(names[0]), success(names[1]), failed(names[1])]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Tentative de migration non résolue')));
});

test('entrée invalide : échec', () => {
  const r = compareMigrationHistory(names, [success(names[0]), { finished_at: new Date() }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('entrée _prisma_migrations invalide')));
});

console.log(`\n${checks}/${checks} tests passés. Aucun accès à une base de données.`);
