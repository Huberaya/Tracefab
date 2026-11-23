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
import fs from 'node:fs';
import path from 'node:path';
import {
  requestedTenantId,
  resolveActiveTenant,
  requireActiveTenant,
  tenantFilter,
  isTenantError,
  TenantError,
  TENANT_HEADER,
} from '../api/_lib/tenant.js';
import { currentSupplier } from '../api/_lib/supplier-profile.js';
import { accessibleRequest, accessibleSupplierRequest } from '../api/_lib/data-requests.js';

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

/* ------------------------------------------- armement sur les routes ----- */
check('withTracefabUserContext recoit le locataire actif (4 arguments) partout hors bootstrap et lot PR #101', () => {
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  // 5 routes d'amorcage utilisateur / adhesions (avant le choix d'un locataire).
  const bootstrapAllowlist = new Set([
    'api/_routes/invitations/accept.ts',
    'api/_routes/me.ts',
    'api/_routes/organizations.ts',
    'api/_routes/supplier/onboarding.ts',
    'api/_routes/supplier/organizations.ts',
  ]);

  // Exemptions temporaires (Phase 2) : ces 4 routes documentaires du lot A de
  // #101 (documents/upload-intent.ts utilise deja withTracefabRequestContext)
  // seront basculees des la fermeture complete de #101.
  const pr101DeferredAllowlist = new Set([
    'api/_routes/documents/[documentId]/download.ts',
    'api/_routes/documents/[documentId]/security-report.ts',
    'api/_routes/supplier/documents/[documentId]/download.ts',
    'api/_routes/supplier/documents/upload-intent.ts',
  ]);

  const walkTs = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkTs(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  const countTopLevelArgs = (src, startIdx) => {
    let depth = 1;
    let i = startIdx;
    let commas = 0;
    let inStr = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      const next = src[i + 1];
      if (inLineComment) { if (ch === '\n') inLineComment = false; i += 1; continue; }
      if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; } i += 1; continue; }
      if (inStr) {
        if (escaped) { escaped = false; i += 1; continue; }
        if (ch === '\\') { escaped = true; i += 1; continue; }
        if (inStr === '`' && ch === '$' && next === '{') {
          i += 2;
          let tDepth = 1;
          while (i < src.length && tDepth > 0) {
            if (src[i] === '{') tDepth += 1;
            else if (src[i] === '}') tDepth -= 1;
            i += 1;
          }
          continue;
        }
        if (ch === inStr) inStr = null;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i += 1; continue; }
      if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) {
        commas += 1;
      }
      i += 1;
    }
    const inner = src.slice(startIdx, i).trim();
    if (!inner.length) return 0;
    let j = i - 1;
    while (j >= startIdx && /\s/.test(src[j])) j -= 1;
    const trailingComma = src[j] === ',';
    return commas + 1 - (trailingComma ? 1 : 0);
  };

  const violations = [];
  let armedCalls = 0;

  for (const sub of ['api/_routes', 'api/_lib']) {
    for (const absFile of walkTs(path.join(rootDir, sub)).sort()) {
      const rel = path.relative(rootDir, absFile).replace(/\\/g, '/');
      if (rel === 'api/_lib/context.ts') continue;
      const src = fs.readFileSync(absFile, 'utf8');
      const re = /\bwithTracefabUserContext\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const argCount = countTopLevelArgs(src, m.index + m[0].length);
        const line = src.slice(0, m.index).split('\n').length;
        if (argCount === 4) {
          armedCalls += 1;
        } else if (!bootstrapAllowlist.has(rel) && !pr101DeferredAllowlist.has(rel)) {
          violations.push(`${rel}:${line} (${argCount} arguments — 4 attendus)`);
        }
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `withTracefabUserContext sans 4e argument activeOrganizationId :\n  - ${violations.join('\n  - ')}`,
  );
  assert.ok(armedCalls >= 65, `au moins 65 appels armes attendus, observe : ${armedCalls}`);
});

/* ------------------------------------------- helpers metier fail-closed -- */
await (async () => {
  let supplierDbCalls = 0;
  const mockSupplierTx = {
    organization_memberships: {
      async findFirst({ where }) {
        supplierDbCalls += 1;
        if (where.organization_id === GINGER) {
          return { organization_id: GINGER, role: 'admin', organizations: { id: GINGER } };
        }
        return null;
      },
    },
    suppliers: {
      async findUnique({ where }) {
        supplierDbCalls += 1;
        return where.organization_id === GINGER ? { id: 'sup-ginger', organization_id: GINGER } : null;
      },
    },
  };

  assert.equal(await currentSupplier(mockSupplierTx, USER, null), null);
  assert.equal(await currentSupplier(mockSupplierTx, USER, undefined), null);
  assert.equal(await currentSupplier(mockSupplierTx, USER, ''), null);
  assert.equal(supplierDbCalls, 0, 'currentSupplier sans organizationId doit retourner null sans toucher la base');

  const resolvedSupplier = await currentSupplier(mockSupplierTx, USER, GINGER);
  assert.equal(resolvedSupplier?.organization_id, GINGER);
  assert.equal(await currentSupplier(mockSupplierTx, USER, RECETTE), null);
  checks += 1;
  console.log('  ok    currentSupplier echoue ferme sans organizationId et borne au seul locataire demande');
})();

await (async () => {
  const REQ_A = '44444444-4444-4444-8444-444444444444';
  const REQ_B = '55555555-5555-4555-8555-555555555555';
  const SUP_ORG = '66666666-6666-4666-8666-666666666666';
  let reqDbCalls = 0;
  const mockReqTx = {
    organization_memberships: {
      async findMany({ where }) {
        reqDbCalls += 1;
        if (where.user_id !== USER) return [];
        const all = [
          { organization_id: GINGER, role: 'admin', status: 'active', organizations: { status: 'active', type: 'brand' } },
          { organization_id: RECETTE, role: 'admin', status: 'active', organizations: { status: 'active', type: 'brand' } },
          { organization_id: SUP_ORG, role: 'admin', status: 'active', organizations: { status: 'active', type: 'supplier' } },
        ];
        return all.filter((m) => {
          if (where.organization_id && m.organization_id !== where.organization_id) return false;
          if (where.organizations?.type && m.organizations.type !== where.organizations.type) return false;
          return true;
        });
      },
    },
    data_requests: {
      async findFirst({ where }) {
        reqDbCalls += 1;
        const rows = [
          { id: REQ_A, brand_organization_id: GINGER, supplier_organization_id: SUP_ORG, status: 'sent' },
          { id: REQ_B, brand_organization_id: RECETTE, supplier_organization_id: SUP_ORG, status: 'sent' },
        ];
        return rows.find((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.supplier_organization_id?.in && !where.supplier_organization_id.in.includes(r.supplier_organization_id)) return false;
          if (where.OR) {
            return where.OR.some((clause) =>
              (clause.brand_organization_id && r.brand_organization_id === clause.brand_organization_id)
              || (clause.supplier_organization_id && r.supplier_organization_id === clause.supplier_organization_id)
            );
          }
          return true;
        }) ?? null;
      },
    },
  };

  assert.equal(await accessibleRequest(mockReqTx, USER, REQ_A, undefined, null), null);
  assert.equal(await accessibleSupplierRequest(mockReqTx, USER, REQ_A, undefined, null), null);
  assert.equal(reqDbCalls, 0, 'accessibleRequest / accessibleSupplierRequest sans organizationId ne doivent pas toucher la base');

  // Compte multi-marques (GINGER + RECETTE) : depuis le locataire actif GINGER,
  // REQ_B (appartenant a RECETTE) est invisible malgre l'adhesion a RECETTE.
  assert.equal((await accessibleRequest(mockReqTx, USER, REQ_A, undefined, GINGER))?.id, REQ_A);
  assert.equal(await accessibleRequest(mockReqTx, USER, REQ_B, undefined, GINGER), null);
  assert.equal((await accessibleRequest(mockReqTx, USER, REQ_B, undefined, RECETTE))?.id, REQ_B);
  assert.equal((await accessibleSupplierRequest(mockReqTx, USER, REQ_A, undefined, SUP_ORG))?.id, REQ_A);
  assert.equal(await accessibleSupplierRequest(mockReqTx, USER, REQ_A, undefined, GINGER), null);
  checks += 1;
  console.log('  ok    accessibleRequest / accessibleSupplierRequest bornent strictement au locataire actif');
})();

console.log(`\nContexte de locataire actif : ${checks} controles, tous verts.`);
console.log("Rappel : ce test couvre le module. L'etancheite en base est prouvee par");
console.log('npm run test:neon:cross-tenant, et le parcours reel par npm run test:multi-tenant:browser.\n');
