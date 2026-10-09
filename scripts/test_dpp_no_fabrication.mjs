#!/usr/bin/env node
/**
 * TRACEFAB — aucune donnée de passeport n'est fabriquée.
 *
 * CE QUI A ÉTÉ TROUVÉ
 *   Trois couches inventaient des données métier, chacune masquant la précédente :
 *
 *   1. `api/_lib/wallet/fallback-data.ts` renvoyait « Atelier Demo » — PEF 84,
 *      grade A, carbone 2.15, circularité 92 — et les deux routes consommateur
 *      `/api/dpp/:gtin/apple-wallet` et `google-wallet` l'appelaient SANS
 *      consulter la base, avec un GTIN par défaut à `3760123456789`. N'importe
 *      quel code-barres scanné produisait une carte signée.
 *   2. `dpp-data-resolver.ts` remplaçait chaque champ absent : `pefScore: 78`,
 *      `pefGrade: 'B'`, `carbonFootprintKgCo2e: 3.42`, `waterScarcityM3: 0.85`,
 *      `circularityScore: 85`, `weightGrams: 250`, `countryOfManufacture: 'PT'`,
 *      `countryOfDesign: 'FR'`, `category: 'Textile'`,
 *      `certifiedComposition: '100% Coton peigné'`,
 *      `supplyChainSummary: 'Filature ➔ Tissage ➔ Ennoblissement ➔ Confection
 *      auditée'`, `brandName: 'Tracefab Brand'` — et `verificationDate` retombait
 *      sur `new Date()`, une date de vérification inventée à aujourd'hui. Le
 *      numéro de certificat était `TC-VERIFIED-MB-${mb.id.slice(0,8)}` : un
 *      identifiant de réconciliation présenté comme un certificat vérifié.
 *   3. Les deux générateurs Wallet ré-inventaient par-dessus :
 *      `data.certifiedComposition || 'Fibres naturelles certifiées'`,
 *      `data.countryOfManufacture || 'UE'`, et `'ESPR CONFORME'` en dur.
 *
 *   Nettoyer une seule couche n'aurait rien changé. Ce test les couvre toutes.
 *
 * DEUX PARTIES
 *   A. statique : les valeurs inventées ne peuvent pas revenir sans faire rougir
 *      ce test — y compris dans les générateurs, que la partie B n'exécute pas.
 *   B. exécution : le VRAI résolveur, contre une vraie base PostgreSQL, sous le
 *      rôle runtime `tracefab_app` (BYPASSRLS=false), en contexte public.
 *
 *   node --experimental-strip-types scripts/test_dpp_no_fabrication.mjs
 *   La partie B exige DPP_TEST_OWNER_URL et DPP_TEST_APP_URL ; sans eux elle
 *   s'annonce NON EXÉCUTÉE plutôt que de se déclarer réussie.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let checks = 0;
let failures = 0;
const ok = (n) => { checks++; console.log(`  ok    ${n}`); };
const ko = (n, d) => { failures++; console.error(`  FAIL  ${n}\n        ${d}`); };

/* Les valeurs inventées, telles qu'elles étaient. Si l'une réapparaît dans la
   chaîne Wallet, c'est que la fabrication est revenue. */
const FABRIQUE = [
  '100% Coton peigné',
  'Filature ➔ Tissage',
  'Confection auditée',
  'Tracefab Brand',
  'Fibres naturelles certifiées',
  'Fibres certifiées',
  'Nœuds certifiés GOTS/GRS auditables',
  'Traçabilité complète des étapes',
  'Validé sous registre bilanciel',
  'Lavage à 30°C sur envers',
  'borne textile Re-fashion',
  'ESPR CONFORME',
  'Atelier Demo',
  'Matière textile',
  'TC-VERIFIED-MB-',
];

const FICHIERS = [
  'api/_lib/wallet/dpp-data-resolver.ts',
  'api/_lib/wallet/apple-pass-generator.ts',
  'api/_lib/wallet/google-wallet-generator.ts',
  'api/_lib/wallet/display.ts',
  'api/_routes/dpp/[gtin]/apple-wallet.ts',
  'api/_routes/dpp/[gtin]/google-wallet.ts',
  'api/_routes/dpp/[gtin].ts',
];

/* ------------------------------------------------------------------ A ----- */
console.log('\nA. Aucune valeur inventée dans la chaîne DPP / Wallet');

if (existsSync(join(ROOT, 'api/_lib/wallet/fallback-data.ts'))) {
  ko('fallback-data.ts existe encore',
    'un module entier de données « Atelier Demo » reste importable par une route réelle');
} else {
  ok('fallback-data.ts a été supprimé');
}

for (const f of FICHIERS) {
  const src = read(f);
  // Les commentaires expliquent le défaut corrigé : ils citent ces valeurs.
  // On ne lit donc que le code, commentaire retiré.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const hits = FABRIQUE.filter((v) => code.includes(v));
  if (hits.length === 0) ok(`${f} : aucune valeur inventée`);
  else ko(`${f} contient encore des valeurs inventées`, hits.join(' · '));
}

/* Les replis `champ || 'texte'` sur une donnée métier. */
const REPLIS = /data\.(certifiedComposition|countryOfManufacture|countryOfDesign|supplyChainSummary|transactionCertificateNumber|careInstructions|recyclingInstructions|brandName|pefScore|pefGrade|weightGrams|category)\s*(\|\||\?\?)\s*['"`]/g;
for (const f of ['api/_lib/wallet/apple-pass-generator.ts', 'api/_lib/wallet/google-wallet-generator.ts']) {
  const hits = [...read(f).matchAll(REPLIS)].map((m) => m[0]);
  if (hits.length === 0) ok(`${f} : aucun repli textuel sur un champ métier`);
  else ko(`${f} remplace encore une donnée absente par un texte`, hits.join(' · '));
}

/* Le module de repli ne doit plus être importé par une route. */
const importsRepli = FICHIERS.filter((f) => /from\s+'.*fallback-data/.test(read(f)));
if (importsRepli.length === 0) ok('aucune route n’importe plus de données de repli');
else ko('des routes importent encore fallback-data', importsRepli.join(', '));

/* Les routes consommateur doivent consulter la base et refuser l'inconnu. */
for (const f of ['api/_routes/dpp/[gtin]/apple-wallet.ts', 'api/_routes/dpp/[gtin]/google-wallet.ts']) {
  const src = read(f);
  const resout = /resolveDppPassData\(/.test(src) && /withTracefabPublicContext/.test(src);
  const refuse = /404/.test(src) && /product_passport_not_found/.test(src);
  const gtinStricte = /mode:\s*'gtin'/.test(src);
  const pasDeDefaut = !/\|\|\s*'3760123456789'/.test(src);
  if (resout && refuse && gtinStricte && pasDeDefaut) {
    ok(`${f} : résout en base, en contexte public, par GTIN strict, et renvoie 404`);
  } else {
    ko(`${f} ne garantit pas une résolution réelle`,
      `base=${resout} 404=${refuse} gtin-strict=${gtinStricte} pas-de-GTIN-par-defaut=${pasDeDefaut}`);
  }
}

/* ------------------------------------------------------------------ B ----- */
console.log('\nB. Le vrai résolveur, exécuté contre PostgreSQL');

const OWNER = process.env.DPP_TEST_OWNER_URL;
const APP = process.env.DPP_TEST_APP_URL;

if (!OWNER || !APP) {
  console.log('  NON EXECUTE — DPP_TEST_OWNER_URL et/ou DPP_TEST_APP_URL absents :');
  console.log('  le resolveur n a pas ete execute contre une base reelle ici.');
} else {
  const pg = (await import('pg')).default;
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { resolveDppPassData, isValidGtin } = await import('../api/_lib/wallet/dpp-data-resolver.ts');

  /* --- validation du GTIN, avant toute resolution ----------------------- */
  const casGtin = [
    ['3760345833592', true],   // chiffre de controle exact
    ['3760345833593', false],  // chiffre de controle faux
    ['4006381333931', true],
    ['12345', false],          // trop court
    ['abcdefghijklm', false],  // pas des chiffres
    ['', false],
  ];
  for (const [v, attendu] of casGtin) {
    if (isValidGtin(v) === attendu) ok(`GTIN ${JSON.stringify(v)} → ${attendu}`);
    else ko(`GTIN ${JSON.stringify(v)}`, `attendu ${attendu}, obtenu ${!attendu}`);
  }

  const owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();

  /* Fixtures deterministes : un produit publie SANS donnee, un AVEC donnee,
     un brouillon. Les identifiants sont fixes pour que le test soit rejouable. */
  const orgId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const nuId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const pleinId = 'aaaaaaaa-0000-4000-8000-000000000003';
  const brouillonId = 'aaaaaaaa-0000-4000-8000-000000000004';
  const GTIN_NU = '9780306406157';
  const GTIN_PLEIN = '9780134685991';

  await owner.query('BEGIN');
  await owner.query(`insert into organizations (id, type, legal_name, display_name, country_code)
                     values ($1,'brand','Marque Sonde DPP','Marque Sonde','FR')
                     on conflict (id) do update set display_name = excluded.display_name`, [orgId]);
  for (const [id, ref, slug, statut] of [
    [nuId, 'SONDE-NU-001', 'sonde-nu-001', 'active'],
    [pleinId, 'SONDE-PLEIN-001', 'sonde-plein-001', 'active'],
    // Un brouillon n'a PAS de public_slug : c'est l'etat reel, la migration
    // 20261009180000 n'en pose que sur les produits actifs.
    [brouillonId, 'SONDE-BROUILLON-001', null, 'draft'],
  ]) {
    await owner.query(
      `insert into tracefab_products (id, brand_organization_id, reference, name, status, public_slug)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do update set status = excluded.status, public_slug = excluded.public_slug`,
      [id, orgId, ref, `Sonde ${ref}`, statut, slug]);
    await owner.query('delete from product_identifiers where product_id = $1', [id]);
  }
  await owner.query(
    `insert into product_identifiers (product_id, identifier_type, identifier_value)
     values ($1,'gtin',$2)`, [nuId, GTIN_NU]);
  await owner.query(
    `insert into product_identifiers (product_id, identifier_type, identifier_value)
     values ($1,'gtin',$2)`, [pleinId, GTIN_PLEIN]);

  // Le produit « plein » porte une composition et une evaluation PEF reelles.
  const matId = 'aaaaaaaa-0000-4000-8000-000000000005';
  await owner.query(
    `insert into materials (id, owner_organization_id, material_type, name)
     values ($1,$2,'fiber','Lin européen de sonde') on conflict (id) do nothing`, [matId, orgId]);
  await owner.query('delete from product_materials where product_id = $1', [pleinId]);
  await owner.query(
    `insert into product_materials (product_id, material_id, material_role, percentage, unit)
     values ($1,$2,'shell',100,'%')`, [pleinId, matId]);
  await owner.query('delete from product_pef_assessments where product_id = $1', [pleinId]);
  await owner.query(
    `insert into product_pef_assessments (product_id, brand_organization_id, pef_eco_score, pef_grade, carbon_footprint_kg_co2e, water_scarcity_m3, circularity_score)
     values ($1, $2, 41, 'C', 6.71, 1.93, 62)`, [pleinId, orgId]);
  // pef_eco_score est un INTEGER en base (mesure, pas suppose) : 41.5 serait
  // arrondi a 42. La fixture utilise donc une valeur que la colonne conserve.
  await owner.query('delete from dpp_records where product_id = $1', [pleinId]);
  // dpp_records exige product_version, requirement_profile_key et
  // requirement_profile_version (NOT NULL sans defaut, lu dans la base).
  await owner.query(
    `insert into dpp_records (product_id, product_version, requirement_profile_key, requirement_profile_version, computed_at)
     values ($1, 1, 'espr_textile', 'v1', '2026-03-04T10:00:00Z')`, [pleinId]);
  // Le produit « nu » est deliberement vide : aucune composition, aucun PEF,
  // aucun noeud, aucun dpp_record. C'est lui qui prouve l'absence de fabrication.
  await owner.query('delete from product_materials where product_id = $1', [nuId]);
  await owner.query('delete from product_pef_assessments where product_id = $1', [nuId]);
  await owner.query('delete from dpp_records where product_id = $1', [nuId]);
  await owner.query('COMMIT');

  /* Le resolveur tourne sous le ROLE RUNTIME, en contexte public : c'est la
     configuration de production, pas le proprietaire qui contourne la RLS. */
  const appPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP }) });
  const enContextePublic = (fn) => appPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'true', true)`;
    return fn(tx);
  });

  /*
   * `current_user` est de type PostgreSQL `name`, que l'adaptateur
   * @prisma/adapter-pg ne sait pas deserialiser (UnsupportedNativeDataType).
   * Le cast en text est obligatoire des qu'on passe par Prisma ; c'est pour cela
   * que test:neon:rls et seed_rls_fixture, qui utilisent `pg` directement, n'ont
   * jamais rencontre le probleme. Verifie : aucun $queryRaw de l'API ne selectionne
   * current_user.
   */
  const qui = await appPrisma.$queryRaw`select current_user::text as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`;
  if (qui[0].b) ko(`le rôle « ${qui[0].u} » porte BYPASSRLS`, 'les politiques ne seraient pas évaluées');
  else ok(`résolveur exécuté sous « ${qui[0].u} », BYPASSRLS=false`);

  /* --- 1. produit publie mais vide : rien ne doit etre invente ---------- */
  const nu = await enContextePublic((tx) => resolveDppPassData(tx, GTIN_NU, undefined, { mode: 'gtin' }));
  if (!nu) {
    ko('le produit publié nu n’a pas été résolu', 'la barrière de publication bloque un produit qui porte un public_slug');
  } else {
    const doiventEtreNuls = [
      'certifiedComposition', 'supplyChainSummary', 'pefScore', 'pefGrade',
      'carbonFootprintKgCo2e', 'waterScarcityM3', 'circularityScore',
      'verificationDate', 'transactionCertificateNumber', 'careInstructions',
      'recyclingInstructions', 'countryOfManufacture', 'countryOfDesign',
      'weightGrams', 'category',
    ];
    const fabriques = doiventEtreNuls.filter((k) => nu[k] !== null && nu[k] !== undefined);
    if (fabriques.length === 0) {
      ok(`produit publié sans donnée : les ${doiventEtreNuls.length} champs métier sont null, aucun n’est inventé`);
    } else {
      ko('des champs sont remplis sans donnée sourcée',
        fabriques.map((k) => `${k}=${JSON.stringify(nu[k])}`).join(' · '));
    }
    if (nu.materials.length === 0) ok('aucune composition n’est fabriquée pour un produit sans matière');
    else ko('une composition apparaît sans matière en base', JSON.stringify(nu.materials));

    if (nu.provenance && nu.provenance.status === 'incomplete') {
      ok('un produit vide est déclaré « incomplete », pas « live »');
    } else {
      ko('un produit vide est annoncé comme live', JSON.stringify(nu.provenance));
    }
    if (nu.provenance && nu.provenance.notProvided.includes('pefScore')) {
      ok('la provenance liste explicitement pefScore comme non renseigné');
    } else {
      ko('la provenance ne signale pas pefScore comme absent', JSON.stringify(nu.provenance));
    }
    if (nu.provenance && nu.provenance.resolvedBy === 'gtin') {
      ok('la provenance indique une résolution par GTIN');
    } else {
      ko('resolvedBy inattendu', String(nu.provenance && nu.provenance.resolvedBy));
    }
  }

  /* --- 2. produit reel : les valeurs viennent de la base ---------------- */
  const plein = await enContextePublic((tx) => resolveDppPassData(tx, GTIN_PLEIN, undefined, { mode: 'gtin' }));
  if (!plein) {
    ko('le produit publié avec données n’a pas été résolu', 'GTIN ' + GTIN_PLEIN);
  } else {
    if (plein.pefScore === 41 && plein.pefGrade === 'C' && plein.carbonFootprintKgCo2e === 6.71) {
      ok('les valeurs PEF viennent de la base (41 / C / 6.71), pas d’un défaut');
    } else {
      ko('les valeurs PEF ne viennent pas de la base',
        `${plein.pefScore} / ${plein.pefGrade} / ${plein.carbonFootprintKgCo2e}`);
    }
    if (plein.certifiedComposition === '100% Lin européen de sonde') {
      ok('la composition est celle enregistrée en base');
    } else {
      ko('la composition ne vient pas de la base', String(plein.certifiedComposition));
    }
    if (plein.verificationDate === '2026-03-04') {
      ok('verificationDate vient de dpp_records.computed_at, pas de la date du jour');
    } else {
      ko('verificationDate ne vient pas de dpp_records', String(plein.verificationDate));
    }
    if (plein.provenance && plein.provenance.status === 'live' && plein.provenance.sourced.length > 0) {
      ok(`un produit sourcé est déclaré « live » (${plein.provenance.sourced.length} champs sourcés)`);
    } else {
      ko('un produit sourcé n’est pas déclaré live', JSON.stringify(plein.provenance));
    }
  }

  /* --- 3. C.6 : un brouillon et une resolution laxiste ------------------ */
  const brouillon = await enContextePublic((tx) => resolveDppPassData(tx, 'SONDE-BROUILLON-001'));
  if (brouillon === null) ok('un brouillon n’est jamais résolu, même par sa référence');
  else ko('un brouillon a été résolu sur une route publique', brouillon.productReference);

  /*
   * ÉCART CONNU, NON CORRIGÉ (audit C.8) — signalé, pas validé.
   *
   * `public_slug` et `status` sont deux colonnes indépendantes, et les
   * politiques publiques ne testent que `public_slug IS NOT NULL`. Rien
   * n'empêche donc un brouillon porteur d'un slug d'être publiquement lisible.
   *
   * Aujourd'hui l'écart est dormant : la migration 20261009180000 ne pose un
   * slug que sur les produits `status = 'active'`. Mais c'est une coïncidence de
   * données, pas une garantie de schéma — et c'est précisément ce que l'audit
   * reproche : la publication dérive du statut au lieu de reposer sur un état de
   * publication explicite et une autorisation démontrable.
   *
   * Ce bloc MESURE l'écart sans le déclarer conforme. Il n'incrémente ni les
   * contrôles réussis ni les échecs : un écart connu n'est pas un test passé.
   */
  const brouillonSlug = 'aaaaaaaa-0000-4000-8000-000000000006';
  await owner.query(
    `insert into tracefab_products (id, brand_organization_id, reference, name, status, public_slug)
     values ($1,$2,'SONDE-BROUILLON-SLUG','Sonde brouillon avec slug','draft','sonde-brouillon-slug')
     on conflict (id) do update set public_slug = excluded.public_slug`, [brouillonSlug, orgId]);
  const ecart = await enContextePublic((tx) => resolveDppPassData(tx, 'sonde-brouillon-slug'));
  console.log(ecart
    ? '  ÉCART  un brouillon porteur d’un public_slug EST publiquement résolu (C.8, non corrigé)'
    : '  ok     l’écart C.8 est refermé : un brouillon n’est plus lisible même avec un slug');
  await owner.query('delete from tracefab_products where id = $1', [brouillonSlug]);

  const parReference = await enContextePublic((tx) => resolveDppPassData(tx, 'SONDE-NU-001', undefined, { mode: 'gtin' }));
  if (parReference === null) ok('en mode GTIN, une référence interne ne résout rien');
  else ko('le mode GTIN a accepté une référence interne', parReference.productReference);

  const gtinFaux = await enContextePublic((tx) => resolveDppPassData(tx, '3760345833593', undefined, { mode: 'gtin' }));
  if (gtinFaux === null) ok('un GTIN au chiffre de contrôle faux est rejeté');
  else ko('un GTIN invalide a été résolu', gtinFaux.productReference);

  await appPrisma.$disconnect();
  await owner.query('BEGIN');
  for (const id of [nuId, pleinId, brouillonId]) {
    await owner.query('delete from product_identifiers where product_id = $1', [id]);
    await owner.query('delete from product_materials where product_id = $1', [id]);
    await owner.query('delete from product_pef_assessments where product_id = $1', [id]);
    await owner.query('delete from dpp_records where product_id = $1', [id]);
    await owner.query('delete from tracefab_products where id = $1', [id]);
  }
  await owner.query('delete from materials where id = $1', [matId]);
  await owner.query('delete from organizations where id = $1', [orgId]);
  await owner.query('COMMIT');
  await owner.end();
}

/* ------------------------------------------------------------------------ */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:dpp:no-fabrication FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:dpp:no-fabrication passed — ${checks} contrôles, 0 échec.`);
