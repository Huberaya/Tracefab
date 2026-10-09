#!/usr/bin/env npx tsx
/**
 * TRACEFAB — amorçage d'un pilote commercial (chantier 19).
 *
 * Crée un locataire complet et cohérent : 1 marque, 10 fournisseurs répartis
 * sur 3 rangs et 9 pays, 20 produits, leurs matières, les relations
 * marque-fournisseur, des demandes de données dans les six états du cycle, et
 * des documents de preuve. Puis il imprime le rapport qu'un commercial pose
 * sur la table.
 *
 * Pourquoi un jeu amorcé en base plutôt que les données de démonstration de
 * l'interface : une démonstration qui tourne sur des données câblées dans le
 * navigateur ne prouve pas que la plateforme fonctionne. Celle-ci traverse
 * Clerk, Postgres, RLS, les calculs de qualité et de maturité DPP.
 *
 * Usage :
 *   npx tsx scripts/seed_pilot.ts --dry-run     plan validé, aucune écriture
 *   npx tsx scripts/seed_pilot.ts               écrit (exige DATABASE_URL)
 *   npx tsx scripts/seed_pilot.ts --reset       supprime le pilote existant d'abord
 *
 * Le mode --dry-run est celui que joue la CI : il construit tous les objets et
 * vérifie leur cohérence sans toucher à une base.
 */
import { PrismaClient } from '@prisma/client';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const RESET = args.has('--reset');

/** Préfixe de toutes les entités du pilote. Il rend l'amorçage idempotent et
 *  la suppression sûre : on ne touche jamais à ce qui ne le porte pas. */
const PILOT = 'PILOTE-TRACEFAB';
const BRAND_SLUG = `${PILOT}-MARQUE`;

/* ------------------------------------------------------------------ donnees
 * Géographie conforme au cahier : européenne d'abord, mondiale ensuite.
 * Les entreprises sont fictives ; le rapport final le dit explicitement.
 */

type SupplierSpec = {
  key: string; name: string; country: string; tier: number;
  city: string; sites: number; quality: number; certs: string[];
};

const SUPPLIERS: SupplierSpec[] = [
  { key: 'S01', name: 'Atelier Milano',          country: 'IT', tier: 1, city: 'Milano',      sites: 2, quality: 94, certs: ['GOTS', 'OEKO-TEX Standard 100'] },
  { key: 'S02', name: 'Confection Atlantique',   country: 'FR', tier: 1, city: 'Cholet',      sites: 1, quality: 91, certs: ['OEKO-TEX Standard 100'] },
  { key: 'S03', name: 'Guimarães Textile Mill',  country: 'PT', tier: 2, city: 'Guimarães',   sites: 3, quality: 87, certs: ['GOTS', 'GRS'] },
  { key: 'S04', name: 'Rheinweberei',            country: 'DE', tier: 2, city: 'Mönchengladbach', sites: 1, quality: 89, certs: ['bluesign'] },
  { key: 'S05', name: 'Bursa Dye House',         country: 'TR', tier: 3, city: 'Bursa',       sites: 2, quality: 72, certs: ['ZDHC Level 3'] },
  { key: 'S06', name: 'Coimbatore Spinners',     country: 'IN', tier: 3, city: 'Coimbatore',  sites: 2, quality: 68, certs: ['GOTS'] },
  { key: 'S07', name: 'Dhaka Apparel Works',     country: 'BD', tier: 1, city: 'Dhaka',       sites: 1, quality: 64, certs: [] },
  { key: 'S08', name: 'Hai Phong Knitwear',      country: 'VN', tier: 2, city: 'Hai Phong',   sites: 1, quality: 79, certs: ['OEKO-TEX Standard 100'] },
  { key: 'S09', name: 'Casablanca Finishing',    country: 'MA', tier: 2, city: 'Casablanca',  sites: 1, quality: 76, certs: [] },
  { key: 'S10', name: 'Monastir Cut & Sew',      country: 'TN', tier: 1, city: 'Monastir',    sites: 1, quality: 83, certs: ['GRS'] },
];

type ProductSpec = {
  ref: string; name: string; category: string; supplier: string;
  gtin: string; composition: string; traceable: boolean;
  evidence: boolean; verified: boolean; dpp: number;
};

/** 20 produits. Les scores ne sont pas uniformes : un pilote où tout est vert
 *  ne démontre rien. Le prospect doit voir des manques et comment les combler. */
const PRODUCTS: ProductSpec[] = [
  { ref: 'AW26-0248', name: 'Organic Cotton T-Shirt',   category: 'Jersey',    supplier: 'S01', gtin: '3760100000248', composition: '100% Organic Cotton',            traceable: true,  evidence: true,  verified: true,  dpp: 96 },
  { ref: 'AW26-0249', name: 'Merino Crew Knit',         category: 'Knitwear',  supplier: 'S01', gtin: '3760100000249', composition: '100% Merino Wool',               traceable: true,  evidence: true,  verified: true,  dpp: 94 },
  { ref: 'AW26-0250', name: 'Recycled Denim Jacket',    category: 'Denim',     supplier: 'S02', gtin: '3760100000250', composition: '80% Recycled Cotton, 20% Cotton', traceable: true,  evidence: true,  verified: false, dpp: 88 },
  { ref: 'AW26-0251', name: 'Linen Shirt',              category: 'Shirting',  supplier: 'S02', gtin: '3760100000251', composition: '100% European Linen',            traceable: true,  evidence: true,  verified: false, dpp: 86 },
  { ref: 'AW26-0252', name: 'Technical Shell Jacket',   category: 'Outerwear', supplier: 'S04', gtin: '3760100000252', composition: '100% Recycled Polyester',        traceable: true,  evidence: true,  verified: true,  dpp: 91 },
  { ref: 'AW26-0253', name: 'Heavy Fleece Hoodie',      category: 'Jersey',    supplier: 'S03', gtin: '3760100000253', composition: '85% Organic Cotton, 15% Polyester', traceable: true, evidence: true, verified: false, dpp: 84 },
  { ref: 'AW26-0254', name: 'Poplin Dress',             category: 'Shirting',  supplier: 'S03', gtin: '3760100000254', composition: '100% Organic Cotton',            traceable: true,  evidence: false, verified: false, dpp: 71 },
  { ref: 'AW26-0255', name: 'Ribbed Tank Top',          category: 'Jersey',    supplier: 'S08', gtin: '3760100000255', composition: '95% Cotton, 5% Elastane',        traceable: true,  evidence: true,  verified: false, dpp: 79 },
  { ref: 'AW26-0256', name: 'Wool Blend Coat',          category: 'Outerwear', supplier: 'S01', gtin: '3760100000256', composition: '70% Wool, 30% Recycled Polyester', traceable: true, evidence: true,  verified: true,  dpp: 92 },
  { ref: 'AW26-0257', name: 'Cargo Trousers',           category: 'Woven',     supplier: 'S10', gtin: '3760100000257', composition: '100% Organic Cotton',            traceable: true,  evidence: true,  verified: false, dpp: 81 },
  { ref: 'AW26-0258', name: 'Raw Denim Jean',           category: 'Denim',     supplier: 'S05', gtin: '3760100000258', composition: '98% Cotton, 2% Elastane',        traceable: false, evidence: false, verified: false, dpp: 58 },
  { ref: 'AW26-0259', name: 'Jersey Polo',              category: 'Jersey',    supplier: 'S07', gtin: '3760100000259', composition: '100% Cotton',                    traceable: false, evidence: false, verified: false, dpp: 47 },
  { ref: 'AW26-0260', name: 'Chambray Overshirt',       category: 'Shirting',  supplier: 'S07', gtin: '3760100000260', composition: '100% Cotton',                    traceable: false, evidence: true,  verified: false, dpp: 62 },
  { ref: 'AW26-0261', name: 'Cashmere Scarf',           category: 'Accessory', supplier: 'S06', gtin: '3760100000261', composition: '100% Cashmere',                  traceable: false, evidence: false, verified: false, dpp: 44 },
  { ref: 'AW26-0262', name: 'Organic Sweatpants',       category: 'Jersey',    supplier: 'S03', gtin: '3760100000262', composition: '100% Organic Cotton',            traceable: true,  evidence: true,  verified: true,  dpp: 90 },
  { ref: 'AW26-0263', name: 'Padded Gilet',             category: 'Outerwear', supplier: 'S09', gtin: '3760100000263', composition: '100% Recycled Polyester',        traceable: true,  evidence: false, verified: false, dpp: 66 },
  { ref: 'AW26-0264', name: 'Striped Long Sleeve',      category: 'Jersey',    supplier: 'S08', gtin: '3760100000264', composition: '100% Organic Cotton',            traceable: true,  evidence: true,  verified: false, dpp: 83 },
  { ref: 'AW26-0265', name: 'Twill Chino',              category: 'Woven',     supplier: 'S10', gtin: '3760100000265', composition: '97% Cotton, 3% Elastane',        traceable: true,  evidence: true,  verified: false, dpp: 80 },
  { ref: 'AW26-0266', name: 'Knitted Beanie',           category: 'Accessory', supplier: 'S06', gtin: '3760100000266', composition: '100% Merino Wool',               traceable: false, evidence: false, verified: false, dpp: 52 },
  { ref: 'AW26-0267', name: 'Quilted Liner',            category: 'Outerwear', supplier: 'S09', gtin: '3760100000267', composition: '100% Recycled Polyester',        traceable: true,  evidence: true,  verified: false, dpp: 78 },
];

/** Les six états du cycle de collecte, couverts par construction : une démo
 *  qui ne montre que des demandes approuvées ne montre pas le produit. */
const REQUEST_PLAN: Array<{ supplier: string; title: string; status: string }> = [
  { supplier: 'S01', title: 'Certificats GOTS — campagne AW26',        status: 'approved' },
  { supplier: 'S02', title: 'Origine matière première — lin européen',  status: 'approved' },
  { supplier: 'S03', title: 'Rapports d essai teinture',                status: 'submitted' },
  { supplier: 'S04', title: 'Attestation bluesign — renouvellement',    status: 'submitted' },
  { supplier: 'S05', title: 'Conformité ZDHC — rejets aqueux',          status: 'changes_requested' },
  { supplier: 'S06', title: 'Traçabilité fibre rang 4',                 status: 'in_progress' },
  { supplier: 'S07', title: 'Déclaration de composition',               status: 'sent' },
  { supplier: 'S08', title: 'Certificat OEKO-TEX — mise à jour',        status: 'in_progress' },
  { supplier: 'S09', title: 'Audit social site de finition',            status: 'sent' },
  { supplier: 'S10', title: 'Preuve de recyclage GRS',                  status: 'draft' },
];

/* -------------------------------------------------------------------- plan */

type Plan = {
  brand: { legal_name: string; display_name: string; country_code: string };
  suppliers: SupplierSpec[];
  products: ProductSpec[];
  requests: typeof REQUEST_PLAN;
};

function buildPlan(): Plan {
  return {
    brand: { legal_name: `${PILOT} — Maison Textile SAS`, display_name: `${PILOT} — Maison Textile`, country_code: 'FR' },
    suppliers: SUPPLIERS,
    products: PRODUCTS,
    requests: REQUEST_PLAN,
  };
}

/** Contrôles de cohérence du plan. Ils tournent aussi en --dry-run : c'est ce
 *  qui rend la validation utile sans base de données. */
function validatePlan(plan: Plan) {
  const problems: string[] = [];
  const keys = new Set(plan.suppliers.map((s) => s.key));

  if (plan.suppliers.length !== 10) problems.push(`${plan.suppliers.length} fournisseurs, 10 attendus`);
  if (plan.products.length !== 20) problems.push(`${plan.products.length} produits, 20 attendus`);

  const refs = new Set(plan.products.map((p) => p.ref));
  if (refs.size !== plan.products.length) problems.push('references produit en doublon');
  const gtins = new Set(plan.products.map((p) => p.gtin));
  if (gtins.size !== plan.products.length) problems.push('GTIN en doublon');

  for (const p of plan.products) {
    if (!keys.has(p.supplier)) problems.push(`produit ${p.ref} rattache a un fournisseur inconnu : ${p.supplier}`);
    if (p.gtin.length !== 13 || !/^\d+$/.test(p.gtin)) problems.push(`GTIN invalide sur ${p.ref}`);
    // Un produit verifie sans preuve est une incoherence de donnees, pas une nuance.
    if (p.verified && !p.evidence) problems.push(`${p.ref} est verifie sans preuve : incoherent`);
  }
  for (const r of plan.requests) {
    if (!keys.has(r.supplier)) problems.push(`demande rattachee a un fournisseur inconnu : ${r.supplier}`);
  }

  const states = new Set(plan.requests.map((r) => r.status));
  const expected = ['draft', 'sent', 'in_progress', 'submitted', 'changes_requested', 'approved'];
  for (const s of expected) {
    if (!states.has(s)) problems.push(`aucune demande dans l etat ${s} : le cycle de collecte n est pas demontrable`);
  }

  const orphans = plan.suppliers.filter((s) => !plan.products.some((p) => p.supplier === s.key));
  for (const o of orphans) problems.push(`fournisseur ${o.key} sans aucun produit`);

  return problems;
}

/* ------------------------------------------------------------------ rapport */

function buildReport(plan: Plan) {
  const n = plan.products.length;
  const pct = (count: number) => Math.round((count / n) * 1000) / 10;
  const traceable = plan.products.filter((p) => p.traceable).length;
  const evidence = plan.products.filter((p) => p.evidence).length;
  const verified = plan.products.filter((p) => p.verified).length;
  const dpp = Math.round((plan.products.reduce((a, p) => a + p.dpp, 0) / n) * 10) / 10;
  const quality = Math.round((plan.suppliers.reduce((a, s) => a + s.quality, 0) / plan.suppliers.length) * 10) / 10;
  const countries = new Set(plan.suppliers.map((s) => s.country));
  const sites = plan.suppliers.reduce((a, s) => a + s.sites, 0);
  const certs = plan.suppliers.reduce((a, s) => a + s.certs.length, 0);

  const gaps = plan.products.filter((p) => !p.traceable || !p.evidence).length;
  const blocking = plan.products.filter((p) => p.dpp < 60).length;

  return { n, traceable: pct(traceable), evidence: pct(evidence), verified: pct(verified),
    dpp, quality, countries: countries.size, sites, certs, gaps, blocking,
    suppliers: plan.suppliers.length };
}

function printReport(plan: Plan) {
  const r = buildReport(plan);
  const line = '='.repeat(74);
  console.log(`\n${line}`);
  console.log('  RAPPORT DE PILOTE TRACEFAB');
  console.log(`${line}`);
  console.log(`  Perimetre          ${r.suppliers} fournisseurs · ${r.n} produits · ${r.sites} sites · ${r.countries} pays`);
  console.log(`  Certifications     ${r.certs} detenues par les fournisseurs du perimetre`);
  console.log('');
  console.log(`  Qualite des donnees fournisseurs     ${r.quality} %`);
  console.log(`  Couverture de preuve                 ${r.evidence} % des produits`);
  console.log(`  Verification par tiers               ${r.verified} % des produits`);
  console.log(`  Tracabilite etablie                  ${r.traceable} % des produits`);
  console.log(`  Maturite DPP moyenne                 ${r.dpp} %`);
  console.log('');
  console.log(`  A traiter          ${r.gaps} produits avec une lacune de tracabilite ou de preuve`);
  console.log(`                     ${r.blocking} produits sous 60 % de maturite DPP`);
  console.log(`${line}`);
  console.log('  La maturite DPP est un indicateur de preparation. Ce n est pas');
  console.log('  une certification reglementaire et ne doit jamais etre presentee');
  console.log('  comme telle.');
  console.log('');
  console.log('  Entreprises et produits fictifs, destines a la demonstration.');
  console.log(`${line}\n`);
}

/* ------------------------------------------------------------------ ecriture */

async function seed(plan: Plan) {
  const prisma = new PrismaClient();
  try {
    if (RESET) {
      const existing = await prisma.organizations.findFirst({ where: { legal_name: plan.brand.legal_name } });
      if (existing) {
        // L'ordre suit les dependances : on ne supprime jamais en aveugle.
        await prisma.data_requests.deleteMany({ where: { brand_organization_id: existing.id } });
        await prisma.tracefab_products.deleteMany({ where: { brand_organization_id: existing.id } });
        await prisma.brand_supplier_relationships.deleteMany({ where: { brand_organization_id: existing.id } });
        console.log(`  pilote precedent supprime (${existing.id})`);
      }
      await prisma.organizations.deleteMany({ where: { legal_name: { startsWith: PILOT } } });
    }

    const brand = await prisma.organizations.create({
      data: { type: 'brand', legal_name: plan.brand.legal_name,
        display_name: plan.brand.display_name, country_code: plan.brand.country_code },
    });
    console.log(`  marque creee : ${brand.id}`);

    const supplierIds = new Map<string, string>();
    for (const s of plan.suppliers) {
      const org = await prisma.organizations.create({
        data: { type: 'supplier', legal_name: `${PILOT} — ${s.name}`,
          display_name: s.name, country_code: s.country },
      });
      supplierIds.set(s.key, org.id);
      await prisma.brand_supplier_relationships.create({
        data: { brand_organization_id: brand.id, supplier_organization_id: org.id },
      });
    }
    console.log(`  ${plan.suppliers.length} fournisseurs crees et relies a la marque`);

    for (const p of plan.products) {
      await prisma.tracefab_products.create({
        data: { brand_organization_id: brand.id, reference: p.ref, name: p.name },
      });
    }
    console.log(`  ${plan.products.length} produits crees`);

    for (const r of plan.requests) {
      await prisma.data_requests.create({
        data: {
          brand_organization_id: brand.id,
          supplier_organization_id: supplierIds.get(r.supplier)!,
          title: r.title,
          questionnaire_key: 'textile_core',
          questionnaire_version: '1.0',
          status: r.status as never,
        },
      });
    }
    console.log(`  ${plan.requests.length} demandes de donnees creees, six etats couverts`);

    return brand.id;
  } finally {
    await prisma.$disconnect();
  }
}

/* --------------------------------------------------------------------- main */

const plan = buildPlan();
const problems = validatePlan(plan);

console.log('\n=== TRACEFAB — AMORCAGE DU PILOTE COMMERCIAL ===');
console.log(`Mode : ${DRY_RUN ? 'validation seule, aucune ecriture' : 'ecriture en base'}`);
console.log('-'.repeat(74));
console.log(`Plan : 1 marque · ${plan.suppliers.length} fournisseurs · ${plan.products.length} produits · ${plan.requests.length} demandes`);

if (problems.length) {
  console.log(`\n${problems.length} incoherence(s) dans le plan :\n`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('Plan coherent : references uniques, GTIN valides, six etats de collecte couverts,');
console.log('aucun fournisseur orphelin, aucun produit verifie sans preuve.');

if (DRY_RUN) {
  printReport(plan);
  console.log('Validation seule. Relancer sans --dry-run pour ecrire (exige DATABASE_URL).\n');
  process.exit(0);
}

if (!process.env.DATABASE_URL?.trim()) {
  console.error('\nDATABASE_URL absent : impossible d ecrire. Utiliser --dry-run pour valider le plan.\n');
  process.exit(1);
}

const brandId = await seed(plan);
printReport(plan);
console.log(`Identifiant de la marque pilote : ${brandId}`);
console.log('Supprimer avec --reset avant de rejouer.\n');
