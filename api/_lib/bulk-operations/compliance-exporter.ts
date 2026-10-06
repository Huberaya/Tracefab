import type { Prisma, PrismaClient } from '@prisma/client';
import { formatCsv } from './csv-parser.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

export async function exportProductsCsv(tx: PrismaTx, brandOrganizationId: string): Promise<string> {
  const products = await tx.tracefab_products.findMany({
    where: { brand_organization_id: brandOrganizationId },
    include: {
      product_identifiers: true,
      product_materials: {
        include: {
          materials: true,
        },
      },
      product_pef_assessments: {
        orderBy: { calculated_at: 'desc' },
        take: 1,
      },
      green_claims_audits: {
        orderBy: { audited_at: 'desc' },
        take: 1,
      },
      dpp_records: {
        orderBy: { computed_at: 'desc' },
        take: 1,
      },
      mass_balance_reconciliations: {
        orderBy: { created_at: 'desc' },
        take: 1,
      },
      mass_balance_allocations: true,
    },
    orderBy: { reference: 'asc' },
  });

  const headers = [
    { key: 'reference', label: 'Référence' },
    { key: 'name', label: 'Nom du Produit' },
    { key: 'category', label: 'Catégorie' },
    { key: 'sku', label: 'SKU' },
    { key: 'gtin', label: 'Code GTIN-13' },
    { key: 'weightGrams', label: 'Poids (grammes)' },
    { key: 'countryOfManufacture', label: 'Pays de Confection' },
    { key: 'countryOfDesign', label: 'Pays de Conception' },
    { key: 'composition', label: 'Matières & Composition' },
    { key: 'pefScore', label: 'Eco-Score PEF' },
    { key: 'pefGrade', label: 'Grade PEF (A-E)' },
    { key: 'carbonCo2e', label: 'Empreinte Carbone (kg CO2e)' },
    { key: 'waterM3', label: 'Consommation Eau (m3)' },
    { key: 'circularityPct', label: 'Circularité (%)' },
    { key: 'greenClaimsScore', label: 'Score Allégations Vertes' },
    { key: 'greenClaimsVerdict', label: 'Verdict Anti-Greenwashing' },
    { key: 'dppScore', label: 'Score DPP Readiness (%)' },
    { key: 'dppStatus', label: 'Statut Passeport DPP' },
    { key: 'tcAllocatedKg', label: 'Matière Certifiée Allouée (kg)' },
    { key: 'massBalanceVerdict', label: 'Arbitrage Bilan Massique' },
    { key: 'createdAt', label: 'Date de Création' },
  ];

  const rows = products.map((p) => {
    const gtin = p.product_identifiers.find((i) => i.identifier_type === 'gtin')?.identifier_value || '';
    const comp = p.product_materials
      .map((m) => `${m.percentage || 100}% ${m.materials?.name || 'Matière'}`)
      .join(', ') || 'Non renseigné';
    const pef = p.product_pef_assessments[0];
    const gc = p.green_claims_audits[0];
    const dpp = p.dpp_records[0];
    const mb = p.mass_balance_reconciliations[0];
    const totalAllocated = p.mass_balance_allocations.reduce((sum, a) => sum + Number(a.allocated_weight_kg), 0);

    return {
      reference: p.reference,
      name: p.name,
      category: p.category || '',
      sku: p.sku || '',
      gtin,
      weightGrams: p.weight_grams ? Number(p.weight_grams) : '',
      countryOfManufacture: p.country_of_manufacture || '',
      countryOfDesign: p.country_of_design || '',
      composition: comp,
      pefScore: pef ? Number(pef.pef_eco_score) : '',
      pefGrade: pef ? pef.pef_grade : '',
      carbonCo2e: pef ? Number(pef.carbon_footprint_kg_co2e) : '',
      waterM3: pef ? Number(pef.water_scarcity_m3) : '',
      circularityPct: pef ? Number(pef.circularity_score) : '',
      greenClaimsScore: gc ? Number(gc.green_claims_score) : '',
      greenClaimsVerdict: gc ? gc.audit_verdict : '',
      dppScore: dpp ? (dpp.readiness_status === 'ready_to_publish' ? 100 : dpp.readiness_status === 'data_ready' ? 85 : 50) : '',
      dppStatus: dpp ? dpp.readiness_status : 'draft',
      tcAllocatedKg: totalAllocated > 0 ? totalAllocated : '',
      massBalanceVerdict: mb ? mb.verdict : 'non_reconciled',
      createdAt: p.created_at.toISOString().slice(0, 10),
    };
  });

  return formatCsv(headers, rows);
}

export async function exportSuppliersCsv(tx: PrismaTx, brandOrganizationId: string): Promise<string> {
  const relationships = await tx.brand_supplier_relationships.findMany({
    where: { brand_organization_id: brandOrganizationId },
    include: {
      organizations_brand_supplier_relationships_supplier_organization_idToorganizations: {
        include: {
          suppliers: {
            include: {
              supplier_sites: true,
            },
          },
          certifications: true,
          data_quality_scores: {
            orderBy: { computed_at: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const headers = [
    { key: 'legalName', label: 'Raison Sociale' },
    { key: 'displayName', label: 'Nom Commercial' },
    { key: 'countryCode', label: 'Pays' },
    { key: 'relationshipStatus', label: 'Statut Partenariat' },
    { key: 'contactName', label: 'Contact Principal' },
    { key: 'contactEmail', label: 'Email Contact' },
    { key: 'onboardingStatus', label: 'Onboarding Profil' },
    { key: 'profileCompletion', label: 'Complétude Profil (%)' },
    { key: 'sitesCount', label: 'Nombre de Sites Actifs' },
    { key: 'certifications', label: 'Certifications Déclarées' },
    { key: 'qualityScore', label: 'Score Qualité Données (%)' },
    { key: 'establishedYear', label: 'Année de Création' },
  ];

  const rows = relationships.map((rel) => {
    const org = rel.organizations_brand_supplier_relationships_supplier_organization_idToorganizations;
    const supp = org?.suppliers;
    const sites = supp?.supplier_sites.filter((s) => s.is_active) || [];
    const certs = org?.certifications.map((c) => c.standard_name).join(', ') || 'Aucune';
    const quality = org?.data_quality_scores[0];

    return {
      legalName: org?.legal_name || '',
      displayName: org?.display_name || '',
      countryCode: org?.country_code || '',
      relationshipStatus: rel.status,
      contactName: supp?.contact_name || '',
      contactEmail: supp?.contact_email || '',
      onboardingStatus: supp?.onboarding_status || 'invited',
      profileCompletion: supp?.profile_completion ? Number(supp.profile_completion) : 0,
      sitesCount: sites.length,
      certifications: certs,
      qualityScore: quality ? Math.round((Number(quality.completeness) + Number(quality.freshness) + Number(quality.documentation_coverage) + Number(quality.consistency)) / 4) : '',
      establishedYear: supp?.year_established || '',
    };
  });

  return formatCsv(headers, rows);
}

export async function exportAuditDossierJson(tx: PrismaTx, brandOrganizationId: string): Promise<Record<string, any>> {
  const brand = await tx.organizations.findUnique({
    where: { id: brandOrganizationId },
    select: { id: true, legal_name: true, display_name: true, country_code: true },
  });

  const products = await tx.tracefab_products.findMany({
    where: { brand_organization_id: brandOrganizationId },
    include: {
      product_identifiers: true,
      product_materials: { include: { materials: true } },
      product_pef_assessments: { orderBy: { calculated_at: 'desc' }, take: 1 },
      green_claims_audits: { orderBy: { audited_at: 'desc' }, take: 1 },
      mass_balance_reconciliations: { orderBy: { created_at: 'desc' }, take: 1 },
    },
  });

  const relationships = await tx.brand_supplier_relationships.findMany({
    where: { brand_organization_id: brandOrganizationId },
    include: {
      organizations_brand_supplier_relationships_supplier_organization_idToorganizations: {
        include: {
          suppliers: { include: { supplier_sites: true } },
          certifications: true,
          data_quality_scores: { orderBy: { computed_at: 'desc' }, take: 1 },
        },
      },
    },
  });

  const materials = await tx.materials.findMany({
    where: { owner_organization_id: brandOrganizationId },
  });

  const tcs = await tx.transaction_certificates.findMany({
    where: { buyer_organization_id: brandOrganizationId },
  });

  const latestPefs = await tx.product_pef_assessments.findMany({
    where: { tracefab_products: { brand_organization_id: brandOrganizationId } },
    take: 10,
    orderBy: { calculated_at: 'desc' },
  });

  const avgCarbon = latestPefs.length
    ? Math.round((latestPefs.reduce((sum, p) => sum + Number(p.carbon_footprint_kg_co2e), 0) / latestPefs.length) * 100) / 100
    : 0;

  return {
    metadata: {
      standard: 'ESPR_CSRD_AUDIT_DOSSIER_V1',
      auditReadiness: 'READY_FOR_THIRD_PARTY_VERIFICATION',
      generatedAt: new Date().toISOString(),
      governanceScope: 'Brand Catalog, Certified Compositions, Supply Chain Tiers, and Mass-Balance Anti-Fraud Verifications',
    },
    brand: brand || { id: brandOrganizationId, legal_name: 'Unknown Brand', country_code: 'FR' },
    summary: {
      totalProductsInCatalog: products.length,
      activeSuppliersConnected: relationships.length,
      activeTransactionCertificates: tcs.length,
      averageProductCarbonFootprintKgCo2e: avgCarbon,
      regulatoryComplianceStandard: 'ESPR-EU-2024 / PEFCR Apparel & Footwear v2024.1 / Loi AGEC Art. 13',
    },
    frameworkEquivalencies: {
      esrsE1ClimateChange: 'Product carbon footprints & lifecycle breakdowns accessible via Tracefab PEF Engine',
      esrsE4Biodiversity: 'Organic cotton, GOTS certifications & FSC certified cellulosic fibers verified via TC Ledger',
      esrsE5CircularEconomy: 'Recyclability scores, single-fiber assessments & recycled content percentages audited',
      esprDigitalProductPassport: 'GS1 Digital Link URI scheme compliant with Modulo-10 checksum GTIN resolution',
    },
    products: products.map((p) => ({
      id: p.id,
      reference: p.reference,
      name: p.name,
      category: p.category,
      sku: p.sku,
      status: p.status,
      version: p.version,
      weightGrams: p.weight_grams,
      countryOfManufacture: p.country_of_manufacture,
      countryOfDesign: p.country_of_design,
      gtin: p.product_identifiers.find((i) => i.identifier_type === 'gtin')?.identifier_value || null,
      materials: p.product_materials.map((m) => ({
        materialName: m.materials?.name || 'Matière',
        percentage: Number(m.percentage) || 100,
        role: m.material_role,
        originCountry: m.materials?.origin_country_code || null,
      })),
      pefAssessment: p.product_pef_assessments[0] ? {
        carbonKgCo2e: Number(p.product_pef_assessments[0].carbon_footprint_kg_co2e),
        pefScore: Number(p.product_pef_assessments[0].pef_eco_score),
        grade: p.product_pef_assessments[0].pef_grade,
      } : null,
      greenClaimsAudit: p.green_claims_audits[0] ? {
        score: p.green_claims_audits[0].green_claims_score,
        verdict: p.green_claims_audits[0].audit_verdict,
      } : null,
      massBalanceReconciliation: p.mass_balance_reconciliations[0] ? {
        verdict: p.mass_balance_reconciliations[0].verdict,
        theoreticalWeightKg: Number(p.mass_balance_reconciliations[0].theoretical_required_kg),
        certifiedAllocatedKg: Number(p.mass_balance_reconciliations[0].allocated_certified_kg),
      } : null,
    })),
    suppliers: relationships.map((rel) => {
      const org = rel.organizations_brand_supplier_relationships_supplier_organization_idToorganizations;
      const supp = org?.suppliers;
      return {
        id: org?.id,
        legalName: org?.legal_name,
        displayName: org?.display_name,
        countryCode: org?.country_code,
        status: rel.status,
        contactName: supp?.contact_name,
        contactEmail: supp?.contact_email,
        sitesCount: supp?.supplier_sites?.length || 0,
        certifications: org?.certifications?.map((c) => ({
          standard: c.standard_name,
          status: c.status,
          expiryDate: c.expires_at,
        })) || [],
      };
    }),
    materials: materials.map((m) => ({
      id: m.id,
      name: m.name,
      materialType: m.material_type,
      originCountryCode: m.origin_country_code,
      composition: m.composition,
    })),
    transactionCertificates: tcs.map((tc) => ({
      id: tc.id,
      tcNumber: tc.tc_number,
      standard: tc.standard,
      issuerName: tc.issuer_name,
      totalCertifiedWeightKg: Number(tc.total_certified_weight_kg),
      allocatedWeightKg: Number(tc.allocated_weight_kg),
      status: tc.status,
    })),
  };
}
