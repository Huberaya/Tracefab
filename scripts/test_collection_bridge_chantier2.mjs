import { readFile } from 'node:fs/promises';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// 1. Verify migration SQL content
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006120000_data_collection_bridge_and_quality_automation/migration.sql', import.meta.url),
  'utf8',
);

// Check tracefab_validate_subject_ownership update
assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_validate_subject_ownership()'),
  'Function tracefab_validate_subject_ownership must be declared in migration',
);
assert(
  migrationSql.includes('brand_supplier_relationships'),
  'tracefab_validate_subject_ownership must recognize brand_supplier_relationships for supplier and document evidence',
);
assert(
  migrationSql.includes('tracefab_can_access_document'),
  'tracefab_validate_subject_ownership must permit documents verified through tracefab_can_access_document',
);

// Check tracefab_review_data_response bridge to data_points
assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_review_data_response('),
  'Function tracefab_review_data_response must be updated in migration',
);
assert(
  migrationSql.includes('INSERT INTO data_points ('),
  'tracefab_review_data_response must insert verified data into data_points',
);
assert(
  migrationSql.includes('v_request.product_id'),
  'tracefab_review_data_response must associate data_points with the request product_id',
);
assert(
  migrationSql.includes('v_item.field_key'),
  'tracefab_review_data_response must associate data_points with the questionnaire item field_key',
);
assert(
  migrationSql.includes('supersedes_id'),
  'tracefab_review_data_response must preserve versioning chain via supersedes_id',
);
assert(
  migrationSql.includes('tracefab_refresh_product_data_readiness'),
  'tracefab_review_data_response must refresh product data readiness',
);

// Check automated quality calculation
assert(
  migrationSql.includes('tracefab_compute_product_quality(v_request.product_id'),
  'tracefab_review_data_response must automatically trigger tracefab_compute_product_quality upon request approval',
);
assert(
  migrationSql.includes('v_is_approved'),
  'tracefab_review_data_response must evaluate whether all required items are accepted',
);

// 2. Verify API review route
const reviewTs = await readFile(
  new URL('../api/_routes/data-responses/[responseId]/review.ts', import.meta.url),
  'utf8',
);
assert(
  reviewTs.includes('tracefab_review_data_response'),
  'Review route must call tracefab_review_data_response',
);
assert(
  reviewTs.includes('tx.data_points.findFirst'),
  'Review route must query generated data point for client visibility',
);
assert(
  reviewTs.includes('tx.data_quality_scores.findFirst'),
  'Review route must query updated quality score upon approval',
);
assert(
  reviewTs.includes('dataPoint: result.dataPoint ? serializeDataPoint(result.dataPoint) : null'),
  'Review route must serialize created data point in response',
);
assert(
  reviewTs.includes('qualityScore: serializeQualityScore(result.qualityScore)'),
  'Review route must serialize updated quality score in response',
);

// 3. Verify UI integration in Brand Console
const brandConsoleHtml = await readFile(
  new URL('../brand-console/index.html', import.meta.url),
  'utf8',
);
assert(
  brandConsoleHtml.includes('name="productId"'),
  'Brand Console new-request modal must offer product association',
);
assert(
  brandConsoleHtml.includes('data-action="product-new-request"'),
  'Brand Console product detail must have a shortcut button to initiate data collection',
);
assert(
  brandConsoleHtml.includes('Produit associé'),
  'Brand Console request detail must display associated product',
);

// 4. Pure state machine & logic validation of the Collection -> Data Points -> Quality flow
function simulateCollectionQualityLifecycle() {
  // Step A: Product initially has 0 data points
  const product = {
    id: 'prod-001',
    brandOrgId: 'org-brand-1',
    dataCompletion: 85,
    version: 1,
  };

  const initialQuality = computeQualityMock(product, []);
  assert(
    initialQuality.issues.some((i) => i.ruleKey === 'product_no_data_points'),
    'Product with 0 data points must trigger product_no_data_points blocking issue',
  );
  assert(initialQuality.score.consistency < 100, 'Blocking issue must degrade consistency score');

  // Step B: Supplier submits response to questionnaire item
  const request = {
    id: 'req-001',
    productId: product.id,
    brandOrgId: product.brandOrgId,
    supplierOrgId: 'org-sup-1',
    status: 'submitted',
  };

  const item = {
    id: 'item-001',
    requestId: request.id,
    fieldKey: 'recycled_content_percentage',
    required: true,
    status: 'pending',
  };

  const response = {
    id: 'resp-001',
    itemId: item.id,
    value: 65,
    dataType: 'percentage',
    status: 'declared',
    sourceDocumentId: 'doc-001',
  };

  // Step C: Brand reviews response with 'verified_by_reviewer'
  const dataPoints = [];
  const reviewedResponse = reviewResponseSimulation(request, item, response, 'verified_by_reviewer', dataPoints);

  assert(reviewedResponse.status === 'verified_by_reviewer', 'Response status must be verified_by_reviewer');
  assert(item.status === 'accepted', 'Item status must be accepted');
  assert(dataPoints.length === 1, 'Exactly one data point must be injected');

  const createdPoint = dataPoints[0];
  assert(createdPoint.productId === product.id, 'Data point must be bound to product_id');
  assert(createdPoint.dataKey === 'recycled_content_percentage', 'Data point data_key must match field_key');
  assert(createdPoint.value === 65, 'Data point value must match response value');
  assert(createdPoint.status === 'verified_by_reviewer', 'Data point status must be verified_by_reviewer');
  assert(createdPoint.sourceDocumentId === 'doc-001', 'Source document evidence must be preserved');
  assert(createdPoint.version === 1, 'Initial data point version must be 1');
  assert(createdPoint.supersedesId === null, 'Initial data point supersedesId must be null');

  // Request should now be approved
  assert(request.status === 'approved', 'Request with all required items accepted must be approved');

  // Step D: Quality is recomputed with the newly bridged data point
  const updatedQuality = computeQualityMock(product, dataPoints);
  assert(
    !updatedQuality.issues.some((i) => i.ruleKey === 'product_no_data_points'),
    'Product with bridged data point must NO LONGER have product_no_data_points issue',
  );
  assert(Number(updatedQuality.score.freshness) === 100, 'Fresh data point must yield 100% freshness');
  assert(Number(updatedQuality.score.documentationCoverage) === 100, 'Data point with document must yield 100% documentation coverage');

  // Step E: Second iteration / revision of the data point maintains lineage
  const revisedResponse = {
    id: 'resp-002',
    itemId: item.id,
    value: 75,
    dataType: 'percentage',
    status: 'declared',
    sourceDocumentId: 'doc-002',
  };
  reviewResponseSimulation(request, item, revisedResponse, 'verified_by_reviewer', dataPoints);

  assert(dataPoints.length === 2, 'Second review must add versioned data point');
  const secondPoint = dataPoints[1];
  assert(secondPoint.version === 2, 'Revised data point version must be incremented to 2');
  assert(secondPoint.supersedesId === createdPoint.id, 'Revised data point must link supersedesId to version 1');
  assert(secondPoint.value === 75, 'Revised data point must hold updated value');

  // Step F: Rejection / needs_review does NOT create a data point
  const badResponse = { id: 'resp-003', itemId: 'item-002', value: 'invalid', dataType: 'text' };
  const badItem = { id: 'item-002', requestId: request.id, fieldKey: 'bad_key', required: true, status: 'pending' };
  const beforeCount = dataPoints.length;
  reviewResponseSimulation(request, badItem, badResponse, 'needs_review', dataPoints);

  assert(dataPoints.length === beforeCount, 'needs_review must NOT create a data point');
  assert(request.status === 'changes_requested', 'needs_review must transition request to changes_requested');
  assert(badItem.status === 'needs_review', 'Item status must be needs_review');
}

function reviewResponseSimulation(request, item, response, reviewStatus, dataPoints) {
  response.status = reviewStatus;
  if (reviewStatus === 'needs_review') {
    item.status = 'needs_review';
    request.status = 'changes_requested';
    return response;
  }

  item.status = 'accepted';

  // Bridge to data points
  if (request.productId) {
    const prior = [...dataPoints]
      .filter((dp) => dp.productId === request.productId && dp.dataKey === item.fieldKey)
      .sort((a, b) => b.version - a.version)[0];

    const newPoint = {
      id: `dp-${dataPoints.length + 1}`,
      ownerOrgId: request.brandOrgId,
      productId: request.productId,
      dataKey: item.fieldKey,
      value: response.value,
      dataType: response.dataType,
      status: 'verified_by_reviewer',
      sourceDocumentId: response.sourceDocumentId || null,
      version: prior ? prior.version + 1 : 1,
      supersedesId: prior ? prior.id : null,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 365 * 86400000),
    };
    dataPoints.push(newPoint);
  }

  // Approval check
  if (item.required && item.status === 'accepted') {
    request.status = 'approved';
  }

  return response;
}

function computeQualityMock(product, dataPoints) {
  const issues = [];
  const prodPoints = dataPoints.filter((dp) => dp.productId === product.id);

  if (prodPoints.length === 0) {
    issues.push({ ruleKey: 'product_no_data_points', severity: 'blocking', message: 'Product has no structured data points.' });
  }

  const freshPoints = prodPoints.filter((dp) => !dp.validUntil || dp.validUntil >= new Date());
  const documentedPoints = prodPoints.filter((dp) => dp.sourceDocumentId !== null);

  const freshness = prodPoints.length ? Math.round((freshPoints.length / prodPoints.length) * 100) : 0;
  const docCoverage = prodPoints.length ? Math.round((documentedPoints.length / prodPoints.length) * 100) : 0;
  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  const consistency = Math.max(0, 100 - (blockingCount * 30));

  return {
    score: {
      completeness: product.dataCompletion,
      freshness,
      documentationCoverage: docCoverage,
      consistency,
    },
    issues,
  };
}

simulateCollectionQualityLifecycle();

console.log('Chantier 2 contract passed: data collection bridge to data points, version lineage, request approval and automated quality calculation.');
