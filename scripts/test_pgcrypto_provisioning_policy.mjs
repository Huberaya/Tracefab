#!/usr/bin/env node
/**
 * Matrice unitaire de la politique pgcrypto : extension absente, ACL révoquables,
 * ACL Neon-managed, propriétaire externe inconnu et mélanges ambigus.
 */
import assert from 'node:assert/strict';
import { determinerModePgcrypto } from './lib/pgcrypto_provisioning_policy.mjs';

const fonction = (overrides = {}) => ({
  public_execute: true,
  autorite_revoke: false,
  proprietaire_superuser: true,
  ...overrides,
});

const cas = [
  ['extension absente et installable', {
    extensionPresente: false, extensionDisponible: true, peutInstaller: true,
  }, 'install'],
  ['extension absente sans droit CREATE', {
    extensionPresente: false, extensionDisponible: true, peutInstaller: false,
  }, null],
  ['extension absente et indisponible', {
    extensionPresente: false, extensionDisponible: false, peutInstaller: true,
  }, null],
  ['aucune ACL PUBLIC résiduelle', {
    extensionPresente: true, fonctions: [fonction({ public_execute: false })],
  }, 'modifiable'],
  ['ACL PUBLIC révocable par le propriétaire', {
    extensionPresente: true, fonctions: [fonction({ autorite_revoke: true, proprietaire_superuser: false })],
  }, 'modifiable'],
  ['ACL PUBLIC Neon cloud_admin non endossable', {
    extensionPresente: true, fonctions: [fonction()],
  }, 'managed-external'],
  ['propriétaire externe non superuser', {
    extensionPresente: true, fonctions: [fonction({ proprietaire_superuser: false })],
  }, null],
  ['mélange cloud_admin et fonctions publiques révocables', {
    extensionPresente: true,
    fonctions: [fonction(), fonction({ autorite_revoke: true, proprietaire_superuser: false })],
  }, null],
  ['mélange cloud_admin et propriétaire externe inconnu', {
    extensionPresente: true,
    fonctions: [fonction(), fonction({ proprietaire_superuser: false })],
  }, null],
  ['extension présente sans fonction membre vérifiable', {
    extensionPresente: true, fonctions: [],
  }, null],
];

let echecs = 0;
for (const [nom, entree, attendu] of cas) {
  const obtenu = determinerModePgcrypto(entree).mode;
  const conforme = obtenu === attendu;
  console.log(`  ${conforme ? 'ok' : 'ECHEC'} ${nom} — attendu=${attendu}, obtenu=${obtenu}`);
  if (!conforme) echecs += 1;
}

assert.equal(echecs, 0, `${echecs} cas de politique pgcrypto en échec`);
console.log(`PASS — ${cas.length}/${cas.length} cas de décision pgcrypto.`);
