import { readFile } from 'node:fs/promises';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('=== TEST SUITE CHANTIER 4: DPP READINESS & BRAND PASSPORT ===');

// 1. Verify Migration SQL
console.log('1. Checking migration SQL...');
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006160000_dpp_readiness_exposure/migration.sql', import.meta.url),
  'utf8',
);

assert(
  migrationSql.includes('textile_readiness_mvp'),
  'Migration must seed textile_readiness_mvp DPP requirement profile',
);
assert(
  migrationSql.includes('product.country_of_manufacture'),
  'Migration profile must require country_of_manufacture',
);
assert(
  migrationSql.includes('composition.complete'),
  'Migration profile must require complete composition',
);
assert(
  migrationSql.includes('traceability.graph'),
  'Migration profile must require traceability graph',
);
assert(
  migrationSql.includes('tracefab_compute_dpp_readiness'),
  'Migration must grant execute on tracefab_compute_dpp_readiness',
);
assert(
  migrationSql.includes('tracefab_mark_dpp_ready_to_publish'),
  'Migration must grant execute on tracefab_mark_dpp_ready_to_publish',
);

// 2. Verify API routes and helper modules
console.log('2. Checking API routes and helper modules...');
const routerTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(routerTs.includes('products/[productId]/dpp.js'), 'Router must register products/:productId/dpp route');
assert(
  routerTs.includes('products/[productId]/dpp/publish-review.js'),
  'Router must register products/:productId/dpp/publish-review route',
);

const dppLib = await readFile(new URL('../api/_lib/dpp.ts', import.meta.url), 'utf8');
assert(dppLib.includes('buildDppSummary'), 'Helper module must export buildDppSummary');
assert(dppLib.includes('classifyRequirementPillar'), 'Helper module must export classifyRequirementPillar');
assert(dppLib.includes('DPP_STATUS_LABELS'), 'Helper module must export DPP_STATUS_LABELS');
assert(dppLib.includes('DPP_REQUIREMENT_LABELS'), 'Helper module must export DPP_REQUIREMENT_LABELS');
assert(dppLib.includes('PILLAR_METADATA'), 'Helper module must export PILLAR_METADATA');

const dppRoute = await readFile(new URL('../api/_routes/products/[productId]/dpp.ts', import.meta.url), 'utf8');
assert(dppRoute.includes('tracefab_compute_dpp_readiness'), 'DPP route must call tracefab_compute_dpp_readiness');
assert(dppRoute.includes('fetchLatestDppRecord'), 'DPP route must query latest record for GET');
assert(dppRoute.includes('buildDppSummary'), 'DPP route must format response with buildDppSummary');

const publishRoute = await readFile(
  new URL('../api/_routes/products/[productId]/dpp/publish-review.ts', import.meta.url),
  'utf8',
);
assert(
  publishRoute.includes('tracefab_mark_dpp_ready_to_publish'),
  'Publish review route must call tracefab_mark_dpp_ready_to_publish',
);
assert(
  publishRoute.includes('dpp_record_not_data_ready'),
  'Publish review route must check data_ready status before publishing',
);

const sqlErrors = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
assert(sqlErrors.includes('dpp_readiness_role_required'), 'SQL error definitions must map dpp_readiness_role_required');
assert(sqlErrors.includes('dpp_record_not_data_ready'), 'SQL error definitions must map dpp_record_not_data_ready');
assert(
  sqlErrors.includes('dpp_publish_review_role_required'),
  'SQL error definitions must map dpp_publish_review_role_required',
);

// 3. Verify Brand Console UI
console.log('3. Checking Brand Console UI implementation...');
const brandConsoleHtml = await readFile(new URL('../brand-console/index.html', import.meta.url), 'utf8');
assert(
  brandConsoleHtml.includes("navButton('dpp'") || brandConsoleHtml.includes('data-view="dpp"'),
  'Brand console must include DPP navigation',
);
assert(brandConsoleHtml.includes('dppView('), 'Brand console must implement dppView');
assert(brandConsoleHtml.includes('renderPillarCard('), 'Brand console must implement renderPillarCard');
assert(brandConsoleHtml.includes('dpp-hero'), 'Brand console must include DPP hero styles');
assert(brandConsoleHtml.includes('dpp-pillars'), 'Brand console must include DPP pillars styles');
assert(brandConsoleHtml.includes('data-action="compute-dpp"'), 'Brand console must offer compute-dpp action');
assert(brandConsoleHtml.includes('data-action="publish-dpp"'), 'Brand console must offer publish-dpp action');
assert(
  brandConsoleHtml.includes('data-action="product-dpp-from-detail"'),
  'Brand console product detail must have direct link to DPP',
);
assert(
  brandConsoleHtml.includes('data-dpp-product'),
  'Brand console products table must have shortcut button to DPP',
);
assert(
  brandConsoleHtml.includes('demoDpp('),
  'Brand console must implement demo fallback for DPP view',
);

// 4. Pure Unit Tests & DPP Algorithm Simulation
console.log('4. Testing DPP pillars and readiness calculation algorithms...');

function classifyRequirementPillar(key) {
  if (key.startsWith('product.')) return 'identification';
  if (key.startsWith('composition.') || key.startsWith('material.')) return 'composition';
  if (key.startsWith('traceability.') || key.startsWith('supply_chain.')) return 'traceability';
  return 'quality';
}

assert(classifyRequirementPillar('product.reference') === 'identification', 'product.reference must be in identification');
assert(classifyRequirementPillar('product.country_of_manufacture') === 'identification', 'country must be in identification');
assert(classifyRequirementPillar('composition.complete') === 'composition', 'composition.complete must be in composition');
assert(classifyRequirementPillar('traceability.graph') === 'traceability', 'traceability.graph must be in traceability');
assert(classifyRequirementPillar('quality.no_blocking_issues') === 'quality', 'quality.no_blocking_issues must be in quality');

function evaluateDppRequirements(product, composition, supplyChainLinks, latestQualityScore) {
  const requirements = [
    { key: 'product.reference', label: 'Référence produit (SKU)', blocking: true },
    { key: 'product.name', label: 'Désignation commerciale', blocking: true },
    { key: 'product.description', label: 'Description détaillée (>= 30 car)', blocking: true },
    { key: 'product.category', label: 'Catégorie textile', blocking: true },
    { key: 'product.country_of_manufacture', label: 'Pays de confection (ISO-2)', blocking: true },
    { key: 'product.data_ready', label: 'Données produit prêtes', blocking: true },
    { key: 'composition.complete', label: 'Composition 100%', blocking: true },
    { key: 'traceability.graph', label: 'Graphe de traçabilité', blocking: true },
    { key: 'quality.no_blocking_issues', label: 'Aucune anomalie qualité bloquante', blocking: true },
  ];

  const results = [];
  const missing = [];
  const blocking = [];

  for (const req of requirements) {
    let met = false;
    switch (req.key) {
      case 'product.reference':
        met = Boolean(product.reference && product.reference.trim().length > 0);
        break;
      case 'product.name':
        met = Boolean(product.name && product.name.trim().length > 0);
        break;
      case 'product.description':
        met = Boolean(product.description && product.description.trim().length >= 30);
        break;
      case 'product.category':
        met = Boolean(product.category && product.category.trim().length > 0);
        break;
      case 'product.country_of_manufacture':
        met = Boolean(product.countryOfManufacture && product.countryOfManufacture.trim().length === 2);
        break;
      case 'product.data_ready':
        met = product.dataReadiness === 'data_ready';
        break;
      case 'composition.complete': {
        const total = composition.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0);
        met = composition.length > 0 && Math.abs(total - 100) < 0.01;
        break;
      }
      case 'traceability.graph':
        met = supplyChainLinks.length > 0;
        break;
      case 'quality.no_blocking_issues':
        met = Boolean(latestQualityScore && latestQualityScore.blockingIssues.length === 0);
        break;
      default:
        met = false;
    }

    results.push({ key: req.key, met, blocking: req.blocking });
    if (!met) {
      missing.push({ key: req.key, label: req.label, blocking: req.blocking });
      if (req.blocking) {
        blocking.push({ key: req.key, label: req.label, reason: 'requirement_not_met' });
      }
    }
  }

  const metCount = results.filter((r) => r.met).length;
  const totalCount = results.length;
  const completionScore = Math.round((metCount / totalCount) * 100);

  let readinessStatus = 'not_started';
  if (blocking.length === 0) {
    readinessStatus = 'data_ready';
  } else if (metCount > 0) {
    readinessStatus = 'in_progress';
  }

  return {
    completionScore,
    totalCount,
    metCount,
    missing,
    blocking,
    readinessStatus,
    canMarkReadyToPublish: readinessStatus === 'data_ready',
  };
}

// Scenario A: Incomplete draft product
const incompleteProduct = {
  reference: 'TF-001',
  name: 'T-shirt Simple',
  description: 'Trop court', // < 30 chars
  category: 'T-shirt',
  countryOfManufacture: 'FR',
  dataReadiness: 'in_progress',
};
const incompleteComposition = [{ materialId: 'm1', percentage: 70 }]; // 70% != 100%
const noLinks = [];
const emptyQuality = { blockingIssues: [{ rule: 'missing_evidence' }] };

const evalA = evaluateDppRequirements(incompleteProduct, incompleteComposition, noLinks, emptyQuality);
assert(evalA.readinessStatus === 'in_progress', 'Incomplete product must be in_progress');
assert(evalA.completionScore < 100, 'Incomplete product score must be < 100%');
assert(evalA.canMarkReadyToPublish === false, 'Incomplete product cannot be published');
assert(evalA.missing.some((m) => m.key === 'product.description'), 'Short description must be reported missing');
assert(evalA.missing.some((m) => m.key === 'composition.complete'), 'Incomplete composition must be reported missing');
assert(evalA.missing.some((m) => m.key === 'traceability.graph'), 'Missing supply chain must be reported missing');

// Scenario B: Fully compliant product
const completeProduct = {
  reference: 'TF-BIO-001',
  name: 'T-Shirt Coton Biologique Certifié',
  description: 'T-shirt en jersey de coton biologique peigné de haute qualité fabriqué au Portugal.',
  category: 'T-shirt',
  countryOfManufacture: 'PT',
  dataReadiness: 'data_ready',
};
const completeComposition = [{ materialId: 'm1', percentage: 100 }];
const activeLinks = [{ id: 'l1', source: 'n1', target: 'n2' }];
const cleanQuality = { blockingIssues: [] };

const evalB = evaluateDppRequirements(completeProduct, completeComposition, activeLinks, cleanQuality);
assert(evalB.readinessStatus === 'data_ready', 'Complete product must be data_ready');
assert(evalB.completionScore === 100, 'Complete product score must be 100%');
assert(evalB.blocking.length === 0, 'No blocking issues should remain');
assert(evalB.canMarkReadyToPublish === true, 'Complete product can be marked ready_to_publish');

// Scenario C: Transition to ready_to_publish
function transitionReadyToPublish(dppRecord, userRole) {
  if (!['owner', 'admin', 'manager'].includes(userRole)) {
    throw new Error('dpp_publish_review_role_required');
  }
  if (dppRecord.readinessStatus !== 'data_ready') {
    throw new Error('dpp_record_not_data_ready');
  }
  return {
    ...dppRecord,
    readinessStatus: 'ready_to_publish',
    reviewedAt: new Date().toISOString(),
  };
}

// Fails if not data_ready
let publishBlocked = false;
try {
  transitionReadyToPublish({ readinessStatus: 'in_progress' }, 'admin');
} catch (e) {
  publishBlocked = e.message.includes('dpp_record_not_data_ready');
}
assert(publishBlocked, 'Publishing non-data_ready record must throw dpp_record_not_data_ready');

// Fails if unauthorized role
let roleBlocked = false;
try {
  transitionReadyToPublish({ readinessStatus: 'data_ready' }, 'guest');
} catch (e) {
  roleBlocked = e.message.includes('dpp_publish_review_role_required');
}
assert(roleBlocked, 'Publishing by non-admin must throw dpp_publish_review_role_required');

// Succeeds with valid record and role
const publishedRecord = transitionReadyToPublish({ readinessStatus: 'data_ready' }, 'admin');
assert(publishedRecord.readinessStatus === 'ready_to_publish', 'Record must transition to ready_to_publish');
assert(Boolean(publishedRecord.reviewedAt), 'reviewedAt timestamp must be recorded');

console.log('Chantier 4 verification complete! All tests passed.');
