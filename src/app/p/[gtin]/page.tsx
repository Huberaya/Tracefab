import React from 'react';
import type { Metadata } from 'next';
import { prisma } from '../../../../api/_lib/prisma';
import { resolveDppPassData } from '../../../../api/_lib/wallet/dpp-data-resolver';
import type { DppPassData } from '../../../../api/_lib/wallet/types';
import { DppHeader } from '../../../components/dpp/DppHeader';
import { DppWalletActions } from '../../../components/dpp/DppWalletActions';
import { DppCompositionSection } from '../../../components/dpp/DppCompositionSection';
import { DppPefEcoScoreSection } from '../../../components/dpp/DppPefEcoScoreSection';
import { DppSupplyChainSection } from '../../../components/dpp/DppSupplyChainSection';
import { DppCareInstructionsSection } from '../../../components/dpp/DppCareInstructionsSection';
import { DppAuditFooter } from '../../../components/dpp/DppAuditFooter';

interface PageProps {
  params: {
    gtin: string;
  };
}

// Fallback demo data if queried without database seed
function getDemoDppData(identifier: string): DppPassData {
  return {
    productId: 'demo-prod-ess-001',
    brandName: 'Atelier Demo',
    brandLegalName: 'Atelier Demo SAS',
    productName: 'Essentiel Coton Biologique',
    productReference: identifier || 'AT-ESS-001',
    sku: 'AT-ESS-001-NVY-M',
    gtin: identifier.length >= 8 ? identifier : '3760345833592',
    serialNumber: `DPP-${identifier}-2026`,
    category: 'Textile / T-shirt',
    countryOfManufacture: 'PT',
    countryOfDesign: 'FR',
    weightGrams: 240,
    certifiedComposition: '85% Coton biologique peigné (GOTS), 15% Coton recyclé (GRS)',
    materials: [
      { name: 'Coton biologique peigné (GOTS)', percentage: 85, role: 'main', originCountry: 'TR' },
      { name: 'Coton recyclé pré-consommation (GRS)', percentage: 15, role: 'secondary', originCountry: 'PT' },
    ],
    pefScore: 84,
    pefGrade: 'A',
    carbonFootprintKgCo2e: 2.85,
    waterScarcityM3: 0.62,
    circularityScore: 92,
    dppUrl: `https://tracefab.com/p/${identifier}`,
    digitalLinkUri: `urn:epc:id:sgtin:3760123.001.2026`,
    verificationDate: '2026-10-06',
    transactionCertificateNumber: 'TC-CU-881294-GOTS-2026',
    supplyChainSummary: 'Égrenage (TR) ➔ Filature (PT) ➔ Tricotage (PT) ➔ Confection (PT)',
    careInstructions: 'Lavage en machine à 30°C sur envers. Séchage à plat. Repassage à fer doux.',
    recyclingInstructions: '100% recyclable. Déposer dans une borne textile Re-fashion ou rapporter en boutique.',
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const gtin = decodeURIComponent(params.gtin || '');
  let data: DppPassData | null = null;
  try {
    data = await resolveDppPassData(prisma, gtin);
  } catch {
    // database offline or testing mode
  }
  const item = data || getDemoDppData(gtin);

  return {
    title: `Passeport Numérique — ${item.productName} | ${item.brandName}`,
    description: `Passeport Numérique de Produit (DPP) certifié ESPR : composition 100%, éco-score PEF ${item.pefGrade}, et traçabilité supply chain.`,
    openGraph: {
      title: `${item.productName} — Passeport Numérique ESPR`,
      description: `Traçabilité textile certifiée et éco-score PEF. Fabriqué en ${item.countryOfManufacture}.`,
      type: 'website',
    },
  };
}

export default async function DppConsumerPage({ params }: PageProps) {
  const gtin = decodeURIComponent(params.gtin || '');

  let data: DppPassData | null = null;
  try {
    data = await resolveDppPassData(prisma, gtin);
  } catch (err) {
    console.warn('Database resolve error, using fallback demo data:', err);
  }

  const dpp = data || getDemoDppData(gtin);

  // CIRPASS / ESPR Product Schema.org JSON-LD
  const jsonLd = {
    '@context': ['https://schema.org', { espr: 'https://ec.europa.eu/commission/presscorner/detail/en/ip_24_1749#' }],
    '@type': 'Product',
    identifier: dpp.digitalLinkUri,
    name: dpp.productName,
    model: dpp.productReference,
    sku: dpp.sku,
    gtin: dpp.gtin,
    brand: {
      '@type': 'Brand',
      name: dpp.brandName,
      legalName: dpp.brandLegalName,
    },
    countryOfOrigin: dpp.countryOfManufacture,
    countryOfDesign: dpp.countryOfDesign,
    material: dpp.materials.map((m) => ({
      '@type': 'DefinedTerm',
      name: m.name,
      percentage: m.percentage,
    })),
  };

  return (
    <main className="min-h-screen bg-[#0d1610] pb-12">
      {/* JSON-LD Schema.org for SEO and CIRPASS crawlers */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero Header */}
      <DppHeader data={dpp} />

      {/* Official Apple & Google Wallet Actions Bar */}
      <DppWalletActions
        productId={dpp.productId}
        gtin={dpp.gtin}
        reference={dpp.productReference}
      />

      {/* Section 1: Certified Composition */}
      <DppCompositionSection data={dpp} />

      {/* Section 2: PEF Eco-Score */}
      <DppPefEcoScoreSection data={dpp} />

      {/* Section 3: Traceability & Supply Chain */}
      <DppSupplyChainSection data={dpp} />

      {/* Section 4: Care, Repair & Recycling */}
      <DppCareInstructionsSection />

      {/* Section 5: Legal & Audit Footer */}
      <DppAuditFooter data={dpp} />
    </main>
  );
}
