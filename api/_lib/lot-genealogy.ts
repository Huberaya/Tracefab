import type { Prisma } from '@prisma/client';

export type TierLevel = 'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4';

export interface LotGenealogyNode {
  nodeId: string;
  lotId: string;
  tier: TierLevel;
  activityType: string;
  organizationId?: string;
  supplierName: string;
  facilityLocation: string;
  gpsCoordinates?: { latitude: number; longitude: number };
  quantityKg: number;
  components: Array<{
    fiberOrMaterial: string;
    percentage: number;
    originCountry: string;
    isRecycledOrBio: boolean;
  }>;
  parentLotIds: string[];
  childLotIds: string[];
  evidenceIds: string[];
  auditStatus: 'VERIFIED' | 'PENDING' | 'DISCREPANCY';
}

export interface MultiTierTraceabilityGraph {
  productId: string;
  sku: string;
  totalDepth: number;
  isContinuousChain: boolean;
  rootNodes: LotGenealogyNode[];
  leafNodes: LotGenealogyNode[];
  nodes: Record<string, LotGenealogyNode>;
  auditDefects: string[];
}

/**
 * Builds and evaluates a multi-tier recursive lot lineage graph for a textile product.
 * Verifies that Tier 1 assembly links back without breaks to Tier 4 raw agricultural/recycled origins.
 */
export function buildLotLineageGraph(
  productId: string,
  sku: string,
  nodes: LotGenealogyNode[]
): MultiTierTraceabilityGraph {
  const nodeMap: Record<string, LotGenealogyNode> = {};
  const defects: string[] = [];

  for (const node of nodes) {
    nodeMap[node.lotId] = node;
  }

  // Populate bi-directional parent/child linkages
  for (const node of nodes) {
    for (const parentId of node.parentLotIds) {
      const parent = nodeMap[parentId];
      if (!parent) {
        defects.push(`Lot [${node.lotId} (${node.tier})] references missing upstream parent [${parentId}]. Lineage break detected.`);
      } else if (!parent.childLotIds.includes(node.lotId)) {
        parent.childLotIds.push(node.lotId);
      }
    }
  }

  // Identify roots (Tier 4 origins with no upstream parents) and leaves (Tier 1 finished garments)
  const rootNodes = nodes.filter(n => n.parentLotIds.length === 0);
  const leafNodes = nodes.filter(n => n.childLotIds.length === 0);

  // Check continuity: Every leaf must trace back to at least one Tier 4 origin
  let hasValidTier4Roots = false;
  for (const root of rootNodes) {
    if (root.tier === 'TIER_4') {
      hasValidTier4Roots = true;
    } else {
      defects.push(`Root lot [${root.lotId}] is at [${root.tier}], but origin must start at TIER_4 (Agricultural/Recycling origin).`);
    }
  }

  // Check blend ratios: For any composite node, composition sum must equal 100% (+/- 0.5%)
  for (const node of nodes) {
    if (node.components.length > 0) {
      const totalPercentage = node.components.reduce((sum, c) => sum + c.percentage, 0);
      if (Math.abs(totalPercentage - 100) > 0.5) {
        defects.push(`Lot [${node.lotId}] composition sum is ${totalPercentage}%, expected 100%.`);
      }
    }
  }

  // Determine tree depth
  let maxDepth = 0;
  function measureDepth(currentLotId: string, visited = new Set<string>()): number {
    if (visited.has(currentLotId)) {
      defects.push(`Circular dependency cycle detected at Lot [${currentLotId}].`);
      return 0;
    }
    visited.add(currentLotId);
    const node = nodeMap[currentLotId];
    if (!node || node.parentLotIds.length === 0) return 1;

    let parentDepth = 0;
    for (const pId of node.parentLotIds) {
      parentDepth = Math.max(parentDepth, measureDepth(pId, new Set(visited)));
    }
    return 1 + parentDepth;
  }

  for (const leaf of leafNodes) {
    maxDepth = Math.max(maxDepth, measureDepth(leaf.lotId));
  }

  const isContinuousChain = defects.length === 0 && hasValidTier4Roots && leafNodes.length > 0;

  return {
    productId,
    sku,
    totalDepth: maxDepth,
    isContinuousChain,
    rootNodes,
    leafNodes,
    nodes: nodeMap,
    auditDefects: defects,
  };
}
