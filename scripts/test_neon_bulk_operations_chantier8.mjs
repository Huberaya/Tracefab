// R11 (30/10) : garde de cible AVANT tout import susceptible de construire un
// client ou d'ouvrir une connexion. Import placé en PREMIÈRE position : en ESM
// il s'évalue avant les imports suivants. Aucune écriture sans cible jetable.
import './lib/garde_import.mjs';

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createTestPrisma, fermerPrismaDeTest } from './lib/test_prisma_client.mjs';

/**
 * P8 (30/10) — ce test ne s'exécutait jamais, et laissait des données.
 *
 * TROIS DÉFAUTS, TROIS CORRECTIONS
 *
 * 1. LIAISON IMPOSSIBLE. `bulk-importer.ts` importe `'../plm-erp/gtin-engine.js'`
 *    alors que le fichier est en `.ts` : convention du bundler Next, que Node
 *    ESM ne résout pas. Le graphe échouait en `ERR_MODULE_NOT_FOUND` AVANT
 *    d'évaluer la garde. Le hook `lib/resolveur_ts.mjs` est enregistré ici,
 *    puis les modules de l'API sont importés DYNAMIQUEMENT — l'ordre est
 *    indispensable : `register()` doit précéder le chargement. Aucun module
 *    applicatif n'est modifié.
 *
 * 2. CLIENT SANS ADAPTATEUR. `new PrismaClient()` sans `datasourceUrl` exige un
 *    moteur Prisma natif, absent hors CI. Le client vient désormais de
 *    `createTestPrisma` (moteur standard en CI, WASM + pg sinon) et se ferme
 *    par `fermerPrismaDeTest`, qui ferme aussi le pool pg — sans quoi la base
 *    de test resterait verrouillée par une connexion survivante.
 *
 * 3. FIXTURE EMPRUNTÉE, DONNÉES LAISSÉES. Le test prenait la première
 *    organisation « brand » et le premier utilisateur de la base, puis
 *    forçait leur membership en `admin`. Sur une base déjà peuplée, cela
 *    rétrogradait le propriétaire unique de cette organisation : le trigger
 *    `tracefab_validate_membership_mutation` levait
 *    `last_owner_membership_required`. Et sur une base vide, il créait une
 *    organisation et un utilisateur qu'il ne supprimait jamais.
 *
 *    Le test possède maintenant SA fixture : un utilisateur et une
 *    organisation créés pour l'exécution, identifiables par un suffixe
 *    unique, et supprimés dans `finally` — succès comme échec.
 */
register('./lib/resolveur_ts.mjs', import.meta.url);

const { bulkImportProducts, bulkImportSuppliers, parseCompositionString } = await import('../api/_lib/bulk-operations/bulk-importer.ts');
const { exportProductsCsv, exportSuppliersCsv, exportAuditDossierJson } = await import('../api/_lib/bulk-operations/compliance-exporter.ts');
const { parseCsvRows } = await import('../api/_lib/bulk-operations/csv-parser.ts');

const prisma = await createTestPrisma(process.env.DATABASE_URL);

// Suffixe unique : deux exécutions consécutives sur la même base ne peuvent
// pas entrer en collision, et les lignes créées sont reconnaissables.
const SUFFIXE = `${process.pid}-${Date.now().toString(36)}`;

/** Ce que cette exécution a créé. Rien d'autre ne sera jamais supprimé. */
const fixture = { userId: null, organizationId: null };

/**
 * Supprime UNIQUEMENT les données de la fixture de cette exécution.
 *
 * L'ordre suit les dépendances réelles du schéma, de la feuille vers la
 * racine :
 *
 *   invitations   (FK organizations, users)
 *   relations     (FK organizations ; CASCADE)
 *   fournisseurs  (FK organizations)
 *   produits      (CASCADE vers product_materials / product_identifiers)
 *   matériaux     (product_materials.material_id est en RESTRICT : ils ne
 *                  peuvent partir qu'après les produits)
 *   memberships   (FK organizations, users)
 *   organisation  (racine de tout ce qui précède)
 *   utilisateur   (dernier : organizations.created_by est en SET NULL)
 *
 * Le nettoyage est idempotent : si l'exécution a échoué DANS la transaction,
 * celle-ci a déjà été annulée et les suppressions ne touchent aucune ligne.
 * Aucune donnée étrangère ne peut l'être : chaque suppression est bornée par
 * l'identifiant de l'organisation ou de l'utilisateur créés ici.
 */
async function nettoyerFixture() {
  const { userId, organizationId: orgId } = fixture;
  if (!orgId && !userId) return;

  const q = async (sql, params) => prisma.$executeRawUnsafe(sql, ...params);

  // Les fournisseurs créés par `tracefab_invite_supplier` sont rattachés à
  // l'organisation de marque par `brand_supplier_relationships`.
  const fournisseurs = orgId
    ? (await prisma.$queryRawUnsafe(
      'SELECT supplier_organization_id::text AS id FROM brand_supplier_relationships WHERE brand_organization_id = $1::uuid',
      orgId,
    )).map((r) => r.id)
    : [];

  if (userId) {
    // `invited_by` porte notre utilisateur : cela couvre aussi une invitation
    // dont la relation aurait disparu.
    await q('DELETE FROM organization_invitations WHERE invited_by = $1::uuid', [userId]);
  }
  if (orgId) {
    await q('DELETE FROM organization_invitations WHERE organization_id = $1::uuid', [orgId]);
    await q('DELETE FROM brand_supplier_relationships WHERE brand_organization_id = $1::uuid', [orgId]);
    await q('DELETE FROM tracefab_products WHERE brand_organization_id = $1::uuid', [orgId]);
    await q('DELETE FROM materials WHERE owner_organization_id = $1::uuid', [orgId]);
    if (fournisseurs.length > 0) {
      await q('DELETE FROM suppliers WHERE organization_id = ANY($1::uuid[])', [fournisseurs]);
      await q('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [fournisseurs]);
    }
    await q('DELETE FROM organization_memberships WHERE organization_id = $1::uuid', [orgId]);
    await q('DELETE FROM organizations WHERE id = $1::uuid', [orgId]);
  }
  if (userId) {
    await q('DELETE FROM users WHERE id = $1::uuid', [userId]);
  }

  // Preuve de nettoyage : plus rien ne doit subsister sous nos identifiants.
  const restes = [];
  if (orgId) {
    const [o] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM organizations WHERE id = $1::uuid', orgId);
    const [p] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1::uuid', orgId);
    const [m] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM materials WHERE owner_organization_id = $1::uuid', orgId);
    const [b] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM brand_supplier_relationships WHERE brand_organization_id = $1::uuid', orgId);
    if (o.n + p.n + m.n + b.n !== 0) restes.push(`organisation=${o.n} produits=${p.n} matériaux=${m.n} relations=${b.n}`);
  }
  if (userId) {
    const [u] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM users WHERE id = $1::uuid', userId);
    const [i] = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM organization_invitations WHERE invited_by = $1::uuid', userId);
    if (u.n + i.n !== 0) restes.push(`utilisateur=${u.n} invitations=${i.n}`);
  }
  if (restes.length > 0) throw new Error(`fixture non nettoyée : ${restes.join(' · ')}`);
  console.log(`[CLEANUP] Fixture ${SUFFIXE} supprimée (organisation ${orgId ? 'oui' : 'non créée'}, utilisateur ${userId ? 'oui' : 'non créé'}).`);
}

async function run() {
  console.log('=== TEST INTEGRATION NEON CHANTIER 8: BULK IMPORT & REGULATORY EXPORT ===\n');

  let echec = false;
  try {
    // 1. Fixture PROPRE au test : aucun emprunt à l'existant.
    const testUser = await prisma.user.create({
      data: {
        clerkUserId: `clerk_tf-c8-${SUFFIXE}`,
        email: `tf-c8-${SUFFIXE}@example.test`,
        fullName: `Chantier 8 ${SUFFIXE}`,
      },
    });
    fixture.userId = testUser.id;

    const brandOrg = await prisma.organizations.create({
      data: {
        legal_name: `Atelier Test Chantier 8 ${SUFFIXE} SAS`,
        display_name: `Atelier Chantier 8 ${SUFFIXE}`,
        country_code: 'FR',
        type: 'brand',
        created_by: testUser.id,
      },
    });
    fixture.organizationId = brandOrg.id;

    console.log(`[SETUP] Using Brand Organization: "${brandOrg.display_name || brandOrg.legal_name}" (${brandOrg.id})`);

    // Run within a transaction setting tracefab context
    await prisma.$transaction(async (tx) => {
      const timestamp = Date.now().toString().slice(-6);

      // Le membership porte sur NOTRE organisation : aucun propriétaire
      // préexistant n'est touché, et le rôle `owner` reflète la réalité (c'est
      // ce même utilisateur qui vient de créer l'organisation).
      await tx.$executeRaw`
        INSERT INTO organization_memberships (id, organization_id, user_id, role, clerk_membership_id)
        VALUES (gen_random_uuid(), ${brandOrg.id}::uuid, ${testUser.id}::uuid, 'owner'::membership_role, ${'mem_bulk_' + SUFFIXE})
      `;
      await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${testUser.id}, true)`;

      const csvContent = `reference,name,category,sku,countryOfManufacture,weightGrams,materialsSummary,gtin
TF-BULK-01-${timestamp},"Pull Laine Mérinos Bio",Pull,SKU-MERINOS-01,PT,380,"100% Laine Mérinos",376034583359
TF-BULK-02-${timestamp},"Veste Jean Selvedge",Veste,SKU-DENIM-02,TN,720,"98% Coton biologique, 2% Élasthanne",400638133393`;

      const parsedRows = parseCsvRows(csvContent);
      assert.equal(parsedRows.length, 2, 'Should parse 2 CSV rows');

      const importRows = parsedRows.map((r) => ({
        reference: r.reference,
        name: r.name,
        category: r.category,
        sku: r.sku,
        countryOfManufacture: r.countryOfManufacture,
        weightGrams: r.weightGrams ? Number(r.weightGrams) : undefined,
        materialComposition: r.materialsSummary,
        gtin: r.gtin
      }));

      const importResult = await bulkImportProducts(tx, brandOrg.id, importRows, testUser?.id);

      console.log('Bulk Product Import Summary:', {
        totalProcessed: importResult.totalProcessed,
        createdCount: importResult.createdCount,
        updatedCount: importResult.updatedCount,
        skippedCount: importResult.skippedCount,
        errors: importResult.errors
      });

      assert.equal(importResult.totalProcessed, 2);
      assert.equal(importResult.createdCount, 2, 'Both products should be created');
      assert.equal(importResult.skippedCount, 0);

      // Verify products in database
      const p1 = await tx.tracefab_products.findFirst({
        where: { brand_organization_id: brandOrg.id, reference: `TF-BULK-01-${timestamp}` },
        include: { product_materials: { include: { materials: true } }, product_identifiers: true }
      });

      assert.ok(p1, 'Product 1 must exist in Neon DB');
      assert.equal(p1.name, 'Pull Laine Mérinos Bio');
      assert.equal(p1.country_of_manufacture, 'PT');
      assert.equal(Number(p1.weight_grams), 380);
      assert.ok(p1.product_materials.length >= 1, 'Product 1 must have materials linked');
      assert.equal(p1.product_materials[0].materials.name, 'Laine Mérinos');

      // Verify GTIN-13 check digit calculation:
      // '376034583359' (12 digits) -> check digit 2 -> '3760345833592'
      const gtinIdent1 = p1.product_identifiers.find((i) => i.identifier_type === 'gtin');
      assert.ok(gtinIdent1, 'GTIN identifier must be created');
      assert.equal(gtinIdent1.identifier_value, '3760345833592', 'GTIN-13 check digit 2 must be calculated correctly');
      console.log(`✓ Product 1 created with GTIN: ${gtinIdent1.identifier_value} and Material: ${p1.product_materials[0].materials.name}`);

      const p2 = await tx.tracefab_products.findFirst({
        where: { brand_organization_id: brandOrg.id, reference: `TF-BULK-02-${timestamp}` },
        include: { product_materials: { include: { materials: true } }, product_identifiers: true }
      });
      assert.ok(p2, 'Product 2 must exist in Neon DB');
      assert.equal(p2.product_materials.length, 2, 'Product 2 must have 2 blended materials');
      const gtinIdent2 = p2.product_identifiers.find((i) => i.identifier_type === 'gtin');
      assert.ok(gtinIdent2);
      assert.equal(gtinIdent2.identifier_value, '4006381333931', 'GTIN-13 check digit 1 must be calculated correctly');
      console.log(`✓ Product 2 created with GTIN: ${gtinIdent2.identifier_value} and 2 blended materials`);

      // TEST 2: Export Products CSV
      console.log('\n[STEP 2] Testing Products CSV Compliance Export...');
      const productsCsv = await exportProductsCsv(tx, brandOrg.id);
      assert.ok(productsCsv.length > 50, 'Products CSV must not be empty');
      assert.ok(productsCsv.includes(`TF-BULK-01-${timestamp}`), 'CSV must include newly imported reference 1');
      assert.ok(productsCsv.includes(`TF-BULK-02-${timestamp}`), 'CSV must include newly imported reference 2');
      assert.ok(productsCsv.includes('3760345833592'), 'CSV must include GTIN barcode');
      assert.ok(productsCsv.includes('Laine Mérinos'), 'CSV must include material composition');
      console.log('✓ Products CSV compliance export generated successfully with required headers and data');

      // TEST 3: Bulk Supplier Onboarding
      console.log('\n[STEP 3] Testing Bulk Supplier Onboarding...');
      const supplierRows = [
        {
          legalName: `Filature Guimarães SAS ${timestamp}`,
          displayName: `Filature Guimarães ${timestamp}`,
          email: `contact.guimaraes.${SUFFIXE}@example.test`,
          countryCode: 'PT',
          tier: 'spinning'
        },
        {
          legalName: `Atelier Confection Tunisien ${timestamp}`,
          displayName: `Confection Tunis ${timestamp}`,
          email: `contact.confection.${SUFFIXE}@example.test`,
          countryCode: 'TN',
          tier: 'assembly'
        }
      ];

      const suppResult = await bulkImportSuppliers(tx, brandOrg.id, supplierRows, testUser?.id);
      console.log('Bulk Supplier Import Summary:', {
        totalProcessed: suppResult.totalProcessed,
        createdCount: suppResult.createdCount,
        skippedCount: suppResult.skippedCount,
        errors: suppResult.errors,
        invitationsCount: suppResult.invitations.length
      });

      assert.equal(suppResult.totalProcessed, 2);
      assert.equal(suppResult.createdCount, 2, 'Both suppliers should be onboarded');
      assert.equal(suppResult.invitations.length, 2, 'Both invitations should be generated');

      // Verify relationship in database
      const rels = await tx.brand_supplier_relationships.findMany({
        where: { brand_organization_id: brandOrg.id },
        include: { organizations_brand_supplier_relationships_supplier_organization_idToorganizations: true }
      });
      const onboarded1 = rels.find((r) => r.organizations_brand_supplier_relationships_supplier_organization_idToorganizations?.legal_name === `Filature Guimarães SAS ${timestamp}`);
      assert.ok(onboarded1, 'Supplier 1 relationship must exist in Neon DB');
      console.log(`✓ Supplier "${onboarded1.organizations_brand_supplier_relationships_supplier_organization_idToorganizations.legal_name}" successfully onboarded via tracefab_invite_supplier`);

      // TEST 4: Export Suppliers CSV
      console.log('\n[STEP 4] Testing Suppliers CSV Compliance Export...');
      const suppliersCsv = await exportSuppliersCsv(tx, brandOrg.id);
      assert.ok(suppliersCsv.length > 50, 'Suppliers CSV must not be empty');
      assert.ok(suppliersCsv.includes(`Filature Guimarães SAS ${timestamp}`), 'CSV must include onboarded supplier');
      console.log('✓ Suppliers CSV compliance export generated successfully');

      // TEST 5: Regulatory Audit Dossier JSON (CSRD / ESPR)
      console.log('\n[STEP 5] Testing CSRD & ESPR Regulatory Audit Dossier JSON Export...');
      const dossier = await exportAuditDossierJson(tx, brandOrg.id);
      assert.ok(dossier, 'Dossier must be returned');
      assert.equal(dossier.metadata.standard, 'ESPR_CSRD_AUDIT_DOSSIER_V1');
      assert.equal(dossier.metadata.auditReadiness, 'READY_FOR_THIRD_PARTY_VERIFICATION');
      assert.equal(dossier.brand.id, brandOrg.id);
      assert.ok(Array.isArray(dossier.products), 'Dossier must include products');
      assert.ok(Array.isArray(dossier.suppliers), 'Dossier must include suppliers');
      assert.ok(Array.isArray(dossier.materials), 'Dossier must include materials');
      assert.ok(dossier.products.some((p) => p.reference === `TF-BULK-01-${timestamp}`), 'Dossier must include test product 1');
      console.log(`✓ Regulatory audit dossier generated with ${dossier.products.length} products, ${dossier.suppliers.length} suppliers, and ${dossier.materials.length} certified materials`);
    }, { timeout: 30000 });

    console.log('\n=============================================================');
    console.log('SUCCESS: All Chantier 8 Neon live integration tests passed!');
    console.log('=============================================================\n');
  } catch (err) {
    echec = true;
    console.error('Test failed with error:', err);
  } finally {
    // Le nettoyage s'exécute quoi qu'il arrive : succès, assertion fausse,
    // exception de préparation, ou transaction annulée. Il est borné aux
    // identifiants de la fixture et vérifie lui-même qu'il ne reste rien.
    try {
      await nettoyerFixture();
    } catch (err) {
      echec = true;
      console.error('[CLEANUP] Échec du nettoyage :', err);
    } finally {
      await fermerPrismaDeTest(prisma);
    }
  }

  // Fermeture faite, nettoyage vérifié : c'est seulement ici que le code de
  // sortie est décidé. Un échec de nettoyage ne peut pas être masqué par un
  // succès fonctionnel.
  process.exit(echec ? 1 : 0);
}

run();
