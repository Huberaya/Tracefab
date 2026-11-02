#!/usr/bin/env node
/**
 * P10.7 — le CONTRAT d'identité du runtime est-il vraiment strict ?
 *
 * Ce test ne touche à aucune base : il exerce une fonction pure
 * (`api/_lib/identite-contrat.ts`). C'est son intérêt — il tourne partout, y
 * compris hors ligne, et il fixe par écrit ce que « identité sûre » veut dire
 * avant qu'une mesure réelle ne soit disponible.
 *
 * CE QU'IL AJOUTE À P10.5/P10.6
 *
 * P10.6 vérifiait `current_user`, `SUPERUSER` et `BYPASSRLS`. Un rôle qui ne
 * porte AUCUN attribut privilégié mais qui est membre d'un rôle qui en porte un
 * redevient privilégié par `SET ROLE` : la RLS n'est alors pas plus opposable.
 * Le contrat refuse désormais cette situation, et ce test le prouve cas par cas
 * — un seul défaut, un seul booléen faux.
 *
 * Chaque cas négatif est un défaut RÉEL, pas une variante cosmétique :
 *   C1 rôle courant différent de `tracefab_app` (le runtime tourne sous le
 *      propriétaire : RLS décorative) ;
 *   C2 `session_user` différent (identité posée par un intermédiaire) ;
 *   C3 SUPERUSER ;
 *   C4 BYPASSRLS ;
 *   C5 appartenance privilégiée DIRECTE ;
 *   C6 appartenance privilégiée TRANSITIVE (mesurée par la sonde runtime) ;
 *   C7 identité non mesurée (aucune conclusion possible) ;
 *   C8 sonde en échec mais champs « propres » (ne doit pas passer pour sûr).
 *
 * Sortie : 0 conforme · 1 régression.
 */
import assert from 'node:assert/strict';
import { identiteRuntimeSure, ecartIdentiteRuntime, type IdentiteRuntime } from '../api/_lib/identite-contrat.js';

let tests = 0;
const cas = (libelle: string, fn: () => void) => {
  fn();
  tests += 1;
  console.log(`  ok    ${libelle}`);
};

const saine: IdentiteRuntime = {
  measured: true,
  currentUser: 'tracefab_app',
  sessionUser: 'tracefab_app',
  database: 'tracefab',
  bypassesRls: false,
  isSuperuser: false,
  privilegedMemberships: [],
  canEscalate: false,
  detail: 'identite lue sur la connexion applicative',
};

cas('C0 identité conforme : le contrat ACCEPTE (contrôle positif, sans quoi tout le reste serait vacuant)', () => {
  assert.equal(identiteRuntimeSure(saine), true);
  assert.deepEqual(ecartIdentiteRuntime(saine), []);
});

cas('C1 rôle courant différent de tracefab_app : refus', () => {
  assert.equal(identiteRuntimeSure({ ...saine, currentUser: 'neondb_owner' }), false);
});

cas('C2 session_user différent du rôle courant : refus', () => {
  assert.equal(identiteRuntimeSure({ ...saine, sessionUser: 'postgres' }), false);
});

cas('C3 SUPERUSER : refus', () => {
  assert.equal(identiteRuntimeSure({ ...saine, isSuperuser: true }), false);
});

cas('C4 BYPASSRLS : refus', () => {
  assert.equal(identiteRuntimeSure({ ...saine, bypassesRls: true }), false);
});

cas('C5 appartenance privilégiée DIRECTE : refus, même avec des attributs irréprochables', () => {
  const avec = { ...saine, privilegedMemberships: ['tracefab_migrator'], canEscalate: true };
  assert.equal(identiteRuntimeSure(avec), false);
  assert.match(ecartIdentiteRuntime(avec).join(' | '), /appartenance privilégiée atteignable : tracefab_migrator/);
});

cas('C6 appartenance privilégiée TRANSITIVE : refus (canEscalate suffit)', () => {
  assert.equal(identiteRuntimeSure({ ...saine, privilegedMemberships: ['role_herite_bypass'], canEscalate: true }), false);
});

cas('C7 identité non mesurée : refus (aucune conclusion ne vaut acceptation)', () => {
  assert.equal(identiteRuntimeSure({ ...saine, measured: false }), false);
  assert.equal(identiteRuntimeSure(undefined), false);
  assert.equal(identiteRuntimeSure(null), false);
});

cas('C8 échec de sonde mais champs « propres » : refus, jamais un faux vert', () => {
  assert.equal(identiteRuntimeSure({ ...saine, measured: false, detail: 'indisponible' }), false);
});

cas('C9 un champ booléen absent (null) ne vaut pas « faux »', () => {
  assert.equal(identiteRuntimeSure({ ...saine, bypassesRls: null }), false);
  assert.equal(identiteRuntimeSure({ ...saine, isSuperuser: null }), false);
});

cas('C10 l écart est lisible sans révéler d identité sensible', () => {
  const ecarts = ecartIdentiteRuntime({ ...saine, currentUser: 'neondb_owner', bypassesRls: true });
  assert.equal(ecarts.length, 2);
  assert.equal(JSON.stringify(ecarts).includes('tracefab_app'), false);
});

console.log(`\n  Contrat d'identité runtime : ${tests} cas — le refus n'est jamais déduit d'un champ absent.`);
process.exit(0);
