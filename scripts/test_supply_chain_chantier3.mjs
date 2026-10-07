import { readFile } from 'node:fs/promises';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('=== TEST SUITE CHANTIER 3: SUPPLY CHAIN & GRAPH TRACEABILITY ===');

// 1. Verify Migration SQL
console.log('1. Checking migration SQL...');
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006140000_supply_chain_traceability_api/migration.sql', import.meta.url),
  'utf8',
);

assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_get_product_traceability'),
  'Migration must enhance tracefab_get_product_traceability',
);
assert(
  migrationSql.includes('tracefab_can_access_document'),
  'tracefab_get_product_traceability must check document access via tracefab_can_access_document',
);
assert(
  migrationSql.includes('site_name') && migrationSql.includes('site_country') && migrationSql.includes('site_city'),
  'tracefab_get_product_traceability must resolve supplier site details (name, country, city)',
);
assert(
  migrationSql.includes('material_name'),
  'tracefab_get_product_traceability must resolve material name',
);
assert(
  migrationSql.includes('organization_name'),
  'tracefab_get_product_traceability must resolve organization name',
);
assert(
  migrationSql.includes('n.product_id = p_product_id'),
  'tracefab_get_product_traceability must include standalone product nodes even before links are created',
);

// 2. Verify API routes and helper library
console.log('2. Checking API routes and helper modules...');
const routerTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(routerTs.includes('supply-chain'), 'Router must register supply-chain route');
assert(routerTs.includes('generate-baseline'), 'Router must register generate-baseline route');
assert(routerTs.includes('supply-chain/nodes'), 'Router must register supply chain nodes route');
assert(routerTs.includes('supply-chain/links'), 'Router must register supply chain links route');

const supplyChainLib = await readFile(new URL('../api/_lib/supply-chain.ts', import.meta.url), 'utf8');
assert(supplyChainLib.includes('groupGraphByStages'), 'Helper must define groupGraphByStages');
assert(supplyChainLib.includes('computeTraceabilitySummary'), 'Helper must define computeTraceabilitySummary');
assert(supplyChainLib.includes('TEXTILE_PROCESS_CODES'), 'Helper must define TEXTILE_PROCESS_CODES');
assert(supplyChainLib.includes('PROCESS_LABELS'), 'Helper must define PROCESS_LABELS');

const getRoute = await readFile(new URL('../api/_routes/products/[productId]/supply-chain.ts', import.meta.url), 'utf8');
assert(getRoute.includes('tracefab_get_product_traceability'), 'GET route must call tracefab_get_product_traceability');

const baselineRoute = await readFile(
  new URL('../api/_routes/products/[productId]/supply-chain/generate-baseline.ts', import.meta.url),
  'utf8',
);
assert(baselineRoute.includes('tracefab_create_supply_chain_node'), 'Baseline route must create supply chain nodes');
assert(baselineRoute.includes('tracefab_add_supply_chain_link'), 'Baseline route must create supply chain links');
assert(baselineRoute.includes('product_materials'), 'Baseline route must inspect product materials to build tiers');

const addNodeRoute = await readFile(
  new URL('../api/_routes/products/[productId]/supply-chain/nodes.ts', import.meta.url),
  'utf8',
);
assert(addNodeRoute.includes('tracefab_create_supply_chain_node'), 'Nodes POST route must call tracefab_create_supply_chain_node');

const nodeDetailRoute = await readFile(
  new URL('../api/_routes/products/[productId]/supply-chain/nodes/[nodeId].ts', import.meta.url),
  'utf8',
);
assert(nodeDetailRoute.includes('tracefab_update_supply_chain_node'), 'Node detail route must support updates');
assert(nodeDetailRoute.includes('deleteMany'), 'Node detail route must support deletion');

const addLinkRoute = await readFile(
  new URL('../api/_routes/products/[productId]/supply-chain/links.ts', import.meta.url),
  'utf8',
);
assert(addLinkRoute.includes('tracefab_add_supply_chain_link'), 'Links POST route must call tracefab_add_supply_chain_link');

const linkDetailRoute = await readFile(
  new URL('../api/_routes/products/[productId]/supply-chain/links/[linkId].ts', import.meta.url),
  'utf8',
);
assert(linkDetailRoute.includes('tracefab_update_supply_chain_link'), 'Link detail route must support updates');
assert(linkDetailRoute.includes('deleteMany'), 'Link detail route must support deletion');

// 3. Verify Brand Console UI
console.log('3. Checking Brand Console UI implementation...');
const brandConsoleHtml = await readFile(new URL('../brand-console/index.html', import.meta.url), 'utf8');
assert(
  brandConsoleHtml.includes("navButton('supplyChain'") || brandConsoleHtml.includes('data-view="supplyChain"'),
  'Brand console must have Traçabilité navigation',
);
assert(brandConsoleHtml.includes('supplyChainView('), 'Brand console must implement supplyChainView renderer');
assert(
  brandConsoleHtml.includes('.pipeline') || brandConsoleHtml.includes('class="pipeline"'),
  'Brand console must include pipeline CSS styles',
);
// Adapte le 7 octobre 2026. L'assertion d'origine exigeait le litteral
// 'Tier 4 · Matieres', une concatenation qui n'existe plus apres la refonte.
// L'exigence reelle que ce test protege est que la profondeur de chaine reste
// lisible dans la console : les cinq rangs ET le vocabulaire d'etapes. C'est
// ce qui est verifie ci-dessous, rang et etape separement.
// Tier 0 n'est pas une etiquette de rang dans la console, ni avant ni apres
// la refonte : verifie sur origin/main, seuls Tier 1 a 4 existent. L'etape du
// produit fini est bien presente, elle est nommee 'Produit Fini & Passeport
// DPP' et verifiee dans la boucle d'etapes ci-dessous.
for (const rang of ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4']) {
  assert(brandConsoleHtml.includes(rang), `Brand console must display ${rang}`);
}
for (const etape of ['Matières', 'Filature', 'Tissage', 'Confection', 'Produit Fini']) {
  assert(brandConsoleHtml.includes(etape), `Brand console must name the ${etape} stage`);
}
assert(brandConsoleHtml.includes('data-action="generate-baseline-chain"'), 'Brand console must offer baseline generation action');
assert(brandConsoleHtml.includes('data-action="new-chain-node"'), 'Brand console must offer add node action');
assert(brandConsoleHtml.includes('data-action="new-chain-link"'), 'Brand console must offer add link action');
assert(brandConsoleHtml.includes('data-delete-chain-link'), 'Brand console must allow link deletion');
assert(brandConsoleHtml.includes('product-supply-chain-from-detail'), 'Brand console product detail must have direct link to supply chain');

// 4. Algorithm & Multi-Tier Classification Pure Unit Tests
console.log('4. Testing classification & summary algorithms...');

// Mock stage categorizer matching api/_lib/supply-chain.ts
const PROCESS_STAGE_MAPPING = {
  ginning: 'tier4_raw_materials',
  harvesting: 'tier4_raw_materials',
  farming: 'tier4_raw_materials',
  extraction: 'tier4_raw_materials',
  recycling: 'tier4_raw_materials',
  spinning: 'tier3_spinning',
  extrusion: 'tier3_spinning',
  carding: 'tier3_spinning',
  combing: 'tier3_spinning',
  weaving: 'tier2_fabric',
  knitting: 'tier2_fabric',
  dyeing: 'tier2_fabric',
  printing: 'tier2_fabric',
  finishing: 'tier2_fabric',
  tanning: 'tier2_fabric',
  sewing: 'tier1_assembly',
  assembly: 'tier1_assembly',
  cutting: 'tier1_assembly',
  finishing_garment: 'tier1_assembly',
  confection: 'tier1_assembly',
  packaging: 'tier0_product',
  distribution: 'tier0_product',
  retail: 'tier0_product',
};

function classifyStages(nodes) {
  const stages = {
    tier4_raw_materials: [],
    tier3_spinning: [],
    tier2_fabric: [],
    tier1_assembly: [],
    tier0_product: [],
    other_nodes: [],
  };

  for (const node of nodes) {
    if (node.node_type === 'product') {
      stages.tier0_product.push(node);
      continue;
    }
    if (node.node_type === 'material') {
      stages.tier4_raw_materials.push(node);
      continue;
    }
    const stage = node.process_code ? PROCESS_STAGE_MAPPING[node.process_code] : null;
    if (stage && stages[stage]) {
      stages[stage].push(node);
    } else if (node.node_type === 'site') {
      stages.tier1_assembly.push(node);
    } else {
      stages.other_nodes.push(node);
    }
  }
  return stages;
}

function computeSummary(nodes, links) {
  const nodeCount = nodes.length;
  const linkCount = links.length;
  const documentedNodes = nodes.filter(
    (n) => n.status === 'verified_by_reviewer' || n.status === 'documented' || Boolean(n.source_document_id),
  ).length;
  const documentationRate = nodeCount > 0 ? Math.round((documentedNodes / nodeCount) * 100) : 0;
  const stages = classifyStages(nodes);
  const coveredKeys = ['tier4_raw_materials', 'tier3_spinning', 'tier2_fabric', 'tier1_assembly', 'tier0_product']
    .filter((k) => stages[k].length > 0);
  const isCompleteChain = coveredKeys.length >= 4 && linkCount >= Math.max(1, nodeCount - 2);

  return {
    nodeCount,
    linkCount,
    documentationRate,
    stagesCoveredCount: coveredKeys.length,
    isCompleteChain,
  };
}

// Test scenario 1: Empty graph
const emptyStages = classifyStages([]);
assert(emptyStages.tier4_raw_materials.length === 0, 'Empty stages tier 4 must be 0');
const emptySummary = computeSummary([], []);
assert(emptySummary.documentationRate === 0, 'Empty summary rate must be 0');
assert(emptySummary.isCompleteChain === false, 'Empty summary cannot be complete');

// Test scenario 2: Full 5-tier textile chain
const mockNodes = [
  { id: 'n-cotton', node_type: 'material', label: 'Coton bio GOTS', process_code: 'farming', status: 'documented', source_document_id: 'doc-1' },
  { id: 'n-spin', node_type: 'process', label: 'Filature Peignée', process_code: 'spinning', status: 'verified_by_reviewer', source_document_id: 'doc-2' },
  { id: 'n-weav', node_type: 'process', label: 'Tissage Jersey', process_code: 'weaving', status: 'verified_by_reviewer', source_document_id: 'doc-3' },
  { id: 'n-dye', node_type: 'process', label: 'Teinture Oeko-Tex', process_code: 'dyeing', status: 'verified_by_reviewer', source_document_id: 'doc-4' },
  { id: 'n-sew', node_type: 'site', label: 'Atelier de confection Porto', process_code: 'sewing', status: 'verified_by_reviewer', source_document_id: 'doc-5' },
  { id: 'n-prod', node_type: 'product', label: 'T-Shirt Bio 100%', process_code: 'packaging', status: 'documented' },
];

const mockLinks = [
  { id: 'l1', source_node_id: 'n-cotton', target_node_id: 'n-spin', link_type: 'transformed_at', sequence_number: 1 },
  { id: 'l2', source_node_id: 'n-spin', target_node_id: 'n-weav', link_type: 'next_step', sequence_number: 2 },
  { id: 'l3', source_node_id: 'n-weav', target_node_id: 'n-dye', link_type: 'next_step', sequence_number: 3 },
  { id: 'l4', source_node_id: 'n-dye', target_node_id: 'n-sew', link_type: 'next_step', sequence_number: 4 },
  { id: 'l5', source_node_id: 'n-sew', target_node_id: 'n-prod', link_type: 'manufactured_at', sequence_number: 5 },
];

const classified = classifyStages(mockNodes);
assert(classified.tier4_raw_materials.length === 1, 'Tier 4 must contain cotton');
assert(classified.tier3_spinning.length === 1, 'Tier 3 must contain spinning');
assert(classified.tier2_fabric.length === 2, 'Tier 2 must contain weaving and dyeing');
assert(classified.tier1_assembly.length === 1, 'Tier 1 must contain sewing workshop');
assert(classified.tier0_product.length === 1, 'Tier 0 must contain product');

const summary = computeSummary(mockNodes, mockLinks);
assert(summary.nodeCount === 6, 'Total nodes must be 6');
assert(summary.linkCount === 5, 'Total links must be 5');
assert(summary.documentationRate === 100, 'Documentation rate must be 100%');
assert(summary.stagesCoveredCount === 5, 'Stages covered must be 5');
assert(summary.isCompleteChain === true, 'Supply chain must be marked complete');

// 5. Tenant Boundary & Graph Consistency Simulation
console.log('5. Testing tenant boundary & graph validation rules...');

function validateGraphLink(brandOrgId, product, sourceNode, targetNode) {
  // Brand product ownership check
  if (product.brandOrgId !== brandOrgId) {
    throw new Error('Access denied: Product does not belong to active organization');
  }
  // Source and target must belong to product supply chain graph
  if (sourceNode.productId !== product.id || targetNode.productId !== product.id) {
    throw new Error('Invalid link: Source and target nodes must belong to the same product');
  }
  // Disallow direct self-loops
  if (sourceNode.id === targetNode.id) {
    throw new Error('Invalid link: Self-referential node links are not permitted');
  }
  return true;
}

const brandA = 'org-brand-alpha';
const brandB = 'org-brand-beta';
const productA = { id: 'prod-aaa', brandOrgId: brandA };
const nodeA1 = { id: 'node-a1', productId: 'prod-aaa' };
const nodeA2 = { id: 'node-a2', productId: 'prod-aaa' };
const nodeB1 = { id: 'node-b1', productId: 'prod-bbb' };

// Valid link
assert(validateGraphLink(brandA, productA, nodeA1, nodeA2) === true, 'Valid link within tenant must succeed');

// Cross-tenant access denied
let crossTenantBlocked = false;
try {
  validateGraphLink(brandB, productA, nodeA1, nodeA2);
} catch (e) {
  crossTenantBlocked = e.message.includes('Access denied');
}
assert(crossTenantBlocked, 'Cross-tenant graph access must be rejected');

// Cross-product node linkage blocked
let crossProductBlocked = false;
try {
  validateGraphLink(brandA, productA, nodeA1, nodeB1);
} catch (e) {
  crossProductBlocked = e.message.includes('same product');
}
assert(crossProductBlocked, 'Linking nodes from different products must be rejected');

// Self loop blocked
let selfLoopBlocked = false;
try {
  validateGraphLink(brandA, productA, nodeA1, nodeA1);
} catch (e) {
  selfLoopBlocked = e.message.includes('Self-referential');
}
assert(selfLoopBlocked, 'Self-loop links must be rejected');

console.log('Chantier 3 verification complete! All tests passed.');
