#!/usr/bin/env node
/**
 * TRACEFAB — contexte de locataire actif : contrat du module `api/_lib/tenant.ts`.
 *
 * Incident Production du 2026-10-17 : un administrateur Clerk membre de Ginger
 * et de Tracefab Recette Production voyait, depuis Ginger, le produit brouillon
 * RECETTE-DPP-20261017 qui n'appartient qu'au tenant de recette.
 *
 * Les tests existants ne pouvaient pas le voir. `scripts/test_cross_tenant.mjs`
 * verifiait la PRESENCE des maillons d'isolation (requireClerkUser +
 * withTracefabUserContext) : la route fautive les portait tous les deux. Son
 * filtre etait `{ in: organizationIds }` — l'union de toutes les organisations
 * du compte — qui borne l'UTILISATEUR, pas le LOCATAIRE ACTIF. Avec un compte
 * mono-organisation, les deux sont indiscernables ; c'est pour cela que le
 * defaut n'est apparu qu'en Production, sur un compte multi-organisations.
 *
 * Ce test execute le vrai module, pas une reimplementation. Il ne monte aucune
 * base : `resolveActiveTenant` recoit un client de transaction factice qui joue
 * la table d'adherences. L'etancheite reelle en base est couverte par
 * `npm run test:neon:cross-tenant` et par le parcours navigateur
 * `npm run test:multi-tenant:browser`.
 *
 * Usage : npx tsx scripts/test_active_tenant_context.mjs
 */
import assert from 'node:assert/strict';
import {
  requestedTenantId,
  resolveActiveTenant,
  requireActiveTenant,
  tenantFilter,
  isTenantError,
  TenantError,
  TENANT_HEADER,
} from '../api/_lib/tenant.js';

/* -------------------------------------------------------------------------- *
 * Deux organisations reelles, comme dans le scenario de reproduction.
 * Le compte est membre actif des deux. C'est la condition du test : avec une
 * seule adhesion, un bornage utilisateur et un bornage tenant sont identiques
 * et rien ne peut etre prouve.
 * ------------------------------------------------------------------------- */
const GINGER = '11111111-1111-4111-8111-111111111111';
const RECETTE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

/** Membre actif de GINGER (brand) et de RECETTE (brand). */
const memberships = [
  { user_id: USER, organization_id: GINGER, status: 'active', role: 'admin', organizations: { type: 'brand' } },
  { user_id: USER, organization_id: RECETTE, status: 'active', role: 'admin', organizations: { type: 'brand' } },
];

const calls = [];
const tx = {
  organization_memberships: {
    async findFirst({ where }) {
      calls.push(where);
      return memberships.find((m) =>
        m.user_id === where.user_id
        && m.organization_id === where.organization_id
        && (!where.status || m.status === where.status)
        && (!where.role || where.role.in.includes(m.role))
        && (!where.organizations || where.organizations.type.in.includes(m.organizations.type))
      ) ?? null;
    },
  },
};

const req = (over = {}) => ({
  method: 'GET',
  query: {},
  headers: {},
  body: undefined,
  ...over,
});

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`  ok    ${label}`); };

console.log('\n=== TRACEFAB — contexte de locataire actif ===\n');

/* --------------------------------------------------------- precedence ----- */
check("l'en-tete prime sur la query string", () => {
  const value = requestedTenantId(req({
    headers: { [TENANT_HEADER]: GINGER },
    query: { organizationId: RECETTE },
  }));
  assert.equal(value, GINGER);
});

check('la query string prime sur le corps', () => {
  const value = requestedTenantId(req({
    query: { organizationId: GINGER },
    body: { organizationId: RECETTE },
  }));
  assert.equal(value, GINGER);
});

check('`brandOrganizationId` est accepte en repli de `organizationId`', () => {
  assert.equal(requestedTenantId(req({ query: { brandOrganizationId: RECETTE } })), RECETTE);
  assert.equal(requestedTenantId(req({ body: { brandOrganizationId: RECETTE } })), RECETTE);
});

check("une valeur absente, vide ou uniquement blanche vaut null", () => {
  assert.equal(requestedTenantId(req()), null);
  assert.equal(requestedTenantId(req({ headers: { [TENANT_HEADER]: '   ' } })), null);
  assert.equal(requestedTenantId(req({ query: { organizationId: '' } })), null);
  assert.equal(requestedTenantId(req({ query: { organizationId: [''] } })), null);
});

check("une query en tableau prend sa premiere valeur", () => {
  assert.equal(requestedTenantId(req({ query: { organizationId: [GINGER, RECETTE] } })), GINGER);
});

/* -------------------------------------------------------------- fail-closed */
await (async () => {
  calls.length = 0;
  await assert.rejects(
    () => resolveActiveTenant(tx, USER, null),
    (e) => isTenantError(e) && e.status === 400 && e.message === 'organization_id_required',
  );
  assert.equal(calls.length, 0, 'un locataire absent ne doit provoquer aucune lecture');
  checks += 1;
  console.log('  ok    locataire absent -> 400 organization_id_required, sans toucher la base');
})();

await (async () => {
  for (const malformed of ['pas-un-uuid', GINGER.slice(0, 35), `${GINGER}x`, '123e4567-e89b-12d3-a456']) {
    calls.length = 0;
    await assert.rejects(
      () => resolveActiveTenant(tx, USER, malformed),
      (e) => isTenantError(e) && e.status === 400 && e.message === 'invalid_organization_id',
      `attendu invalid_organization_id pour ${malformed}`,
    );
    assert.equal(calls.length, 0, 'un locataire mal forme ne doit provoquer aucune lecture');
  }
  checks += 1;
  console.log('  ok    locataire mal forme -> 400 invalid_organization_id, sans toucher la base');
})();

await (async () => {
  // Une organisation qui existe peut-etre, mais dont le compte n'est pas membre.
  calls.length = 0;
  await assert.rejects(
    () => resolveActiveTenant(tx, USER, '99999999-9999-4999-8999-999999999999'),
    (e) => isTenantError(e) && e.status === 404 && e.message === 'organization_not_found',
  );
  checks += 1;
  console.log('  ok    locataire non adherent -> 404 organization_not_found (pas de 403 : aucune revelation)');
})();

/* ------------------------------------------------------- resolution normale */
await (async () => {
  const tenant = await resolveActiveTenant(tx, USER, RECETTE);
  assert.equal(tenant.organizationId, RECETTE);
  assert.equal(tenant.role, 'admin');
  assert.equal(tenant.organizationType, 'brand');
  checks += 1;
  console.log('  ok    locataire adherent -> resolu avec role et type');
})();

await (async () => {
  // Le coeur du test : les DEUX tenants se resolvent, et chacun ne rend que
  // lui-meme. `tenantFilter` produit un filtre a UN element — jamais l'union.
  const a = await resolveActiveTenant(tx, USER, GINGER);
  const b = await resolveActiveTenant(tx, USER, RECETTE);
  assert.deepEqual(tenantFilter(a), { in: [GINGER] });
  assert.deepEqual(tenantFilter(b), { in: [RECETTE] });
  assert.notDeepEqual(tenantFilter(a), tenantFilter(b));
  assert.equal(tenantFilter(a).in.length, 1, 'le filtre doit borner a un seul locataire');
  checks += 1;
  console.log('  ok    tenantFilter borne a UN locataire — jamais l union des adherences');
})();

/* ------------------------------------------------------------------- scopes */
await (async () => {
  // Un role non tenu dans le locataire actif doit refuser, avec la meme
  // reponse qu'une absence d'adhesion.
  await assert.rejects(
    () => resolveActiveTenant(tx, USER, GINGER, { roles: ['owner'] }),
    (e) => isTenantError(e) && e.status === 404,
  );
  const ownerOnly = await resolveActiveTenant(tx, USER, GINGER, { roles: ['admin', 'owner'] });
  assert.equal(ownerOnly.organizationId, GINGER);
  checks += 1;
  console.log('  ok    scope de roles applique dans le locataire actif');
})();

/* ------------------------------------------------------ variante de route */
await (async () => {
  // `requireActiveTenant` lit la requete : c'est le chemin reel des routes.
  const tenant = await requireActiveTenant(tx, req({ headers: { [TENANT_HEADER]: GINGER } }), USER);
  assert.equal(tenant.organizationId, GINGER);
  await assert.rejects(
    () => requireActiveTenant(tx, req(), USER),
    (e) => isTenantError(e) && e.status === 400,
  );
  checks += 1;
  console.log('  ok    requireActiveTenant lit la requete et echoue ferme sans en-tete');
})();

/* ------------------------------------------------------- forme de l'erreur */
check("TenantError porte son statut et reste une Error", () => {
  const e = new TenantError(404, 'organization_not_found');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'TenantError');
  assert.equal(e.status, 404);
  assert.equal(isTenantError(e), true);
  assert.equal(isTenantError(new Error('organization_not_found')), false);
});

console.log(`\nContexte de locataire actif : ${checks} controles, tous verts.`);
console.log("Rappel : ce test couvre le module. L'etancheite en base est prouvee par");
console.log('npm run test:neon:cross-tenant, et le parcours reel par npm run test:multi-tenant:browser.\n');
