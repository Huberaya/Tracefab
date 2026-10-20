import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('prisma/migrations/20261020120000_structured_supply_chain_graph_membership/migration.sql', 'utf8');
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const consoleJs = readFileSync('assets/js/brand-console.1.js', 'utf8');
const createLink = readFileSync('api/_routes/products/[productId]/supply-chain/links.ts', 'utf8');
const updateLink = readFileSync('api/_routes/products/[productId]/supply-chain/links/[linkId].ts', 'utf8');

assert(schema.includes('graph_product_id'), 'Prisma schema must expose canonical graph membership');
assert(migration.includes('ADD COLUMN IF NOT EXISTS graph_product_id UUID REFERENCES tracefab_products'), 'Migration must add a product FK');
assert(migration.includes("HAVING count(DISTINCT product_id) = 1"), 'Backfill must reject ambiguous historical membership');
assert(migration.includes('traceability_node_graph_product_is_immutable'), 'Graph membership must be immutable');
assert(migration.includes('traceability_link_node_product_mismatch'), 'Cross-product links must be rejected');
assert(migration.includes('WHERE n.graph_product_id = p_product_id'), 'Graph reads must include standalone structured nodes');
assert(migration.includes('tracefab_delete_supply_chain_node'), 'Node deletion must be controlled');
assert(migration.includes('tracefab_delete_supply_chain_link'), 'Link deletion must be controlled');
assert(migration.includes("tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)"), 'Evidence identifiers must stay access-redacted');
assert(createLink.includes('${input.sequenceNumber}::integer'), 'Create sequence SQL type must be exact');
assert(updateLink.includes('${sequenceNumber}::integer'), 'Update sequence SQL type must be exact');
assert(consoleJs.includes('syncChainNodeReferences'), 'Node form must submit exactly one semantic reference');
assert(!consoleJs.includes('<option value="site">${bt(\'mdSupplierSite\')}</option>'), 'Unsupported site creation must not be offered');
assert(consoleJs.includes('<option value="other" selected>'), 'A neutral valid process code must be selected by default');
assert(consoleJs.includes('keepDistinctChainNodes'), 'Link form must keep endpoints distinct');

console.log('Supply-chain vertical contract passed: schema, SQL, API, RLS and forms agree.');
