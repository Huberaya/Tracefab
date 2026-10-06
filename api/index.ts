import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from './_lib/http.js';

type RouteHandler = (req: VercelRequest, res: VercelResponse) => unknown;
type Route = { pattern: RegExp; params: string[]; load: () => Promise<{ default: RouteHandler }> };

const routes: Route[] = [
  { pattern: /^catalog\/questionnaires$/, params: [], load: () => import('./_routes/catalog/questionnaires.js') },
  { pattern: /^catalog\/schemas$/, params: [], load: () => import('./_routes/catalog/schemas.js') },
  { pattern: /^config$/, params: [], load: () => import('./_routes/config.js') },
  { pattern: /^dpp\/validate$/, params: [], load: () => import('./_routes/dpp/validate.js') },
  { pattern: /^data\-request\-items\/([^\/]+)\/response$/, params: ['itemId'], load: () => import('./_routes/data-request-items/[itemId]/response.js') },
  { pattern: /^data\-requests\/([^\/]+)\/items\/from\-template$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items/from-template.js') },
  { pattern: /^data\-requests\/([^\/]+)\/items$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items.js') },
  { pattern: /^data\-requests\/([^\/]+)\/send$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/send.js') },
  { pattern: /^data\-requests\/([^\/]+)\/submit$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/submit.js') },
  { pattern: /^data\-requests\/([^\/]+)$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId].js') },
  { pattern: /^data\-requests$/, params: [], load: () => import('./_routes/data-requests.js') },
  { pattern: /^data\-responses\/([^\/]+)\/review$/, params: ['responseId'], load: () => import('./_routes/data-responses/[responseId]/review.js') },
  { pattern: /^documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/download.js') },
  { pattern: /^health$/, params: [], load: () => import('./_routes/health.js') },
  { pattern: /^integrations\/plm$/, params: [], load: () => import('./_routes/integrations/plm.js') },
  { pattern: /^internal\/notification\-outbox\/health$/, params: [], load: () => import('./_routes/internal/notification-outbox/health.js') },
  { pattern: /^internal\/notification\-outbox\/process$/, params: [], load: () => import('./_routes/internal/notification-outbox/process.js') },
  { pattern: /^internal\/notification\-outbox\/reminders$/, params: [], load: () => import('./_routes/internal/notification-outbox/reminders.js') },
  { pattern: /^internal\/notification\-outbox\/schedule$/, params: [], load: () => import('./_routes/internal/notification-outbox/schedule.js') },
  { pattern: /^operations\/overview$/, params: [], load: () => import('./_routes/operations/overview.js') },
  { pattern: /^invitations\/accept$/, params: [], load: () => import('./_routes/invitations/accept.js') },
  { pattern: /^webhooks\/clerk$/, params: [], load: () => import('./_routes/webhooks/clerk.js') },
  { pattern: /^materials\/([^\/]+)$/, params: ['materialId'], load: () => import('./_routes/materials/[materialId].js') },
  { pattern: /^materials$/, params: [], load: () => import('./_routes/materials.js') },
  { pattern: /^me$/, params: [], load: () => import('./_routes/me.js') },
  { pattern: /^organizations\/([^\/]+)\/invitations$/, params: ['organizationId'], load: () => import('./_routes/organizations/[organizationId]/invitations.js') },
  { pattern: /^organizations$/, params: [], load: () => import('./_routes/organizations.js') },
  { pattern: /^products\/([^\/]+)\/data\-points$/, params: ['productId'], load: () => import('./_routes/products/[productId]/data-points.js') },
  { pattern: /^products\/([^\/]+)\/identifiers$/, params: ['productId'], load: () => import('./_routes/products/[productId]/identifiers.js') },
  { pattern: /^products\/([^\/]+)\/materials$/, params: ['productId'], load: () => import('./_routes/products/[productId]/materials.js') },
  { pattern: /^products\/([^\/]+)\/revision$/, params: ['productId'], load: () => import('./_routes/products/[productId]/revision.js') },
  { pattern: /^products\/([^\/]+)\/dpp\/publish\-review$/, params: ['productId'], load: () => import('./_routes/products/[productId]/dpp/publish-review.js') },
  { pattern: /^products\/([^\/]+)\/dpp$/, params: ['productId'], load: () => import('./_routes/products/[productId]/dpp.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/generate\-baseline$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/generate-baseline.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/nodes\/([^\/]+)$/, params: ['productId', 'nodeId'], load: () => import('./_routes/products/[productId]/supply-chain/nodes/[nodeId].js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/nodes$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/nodes.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/links\/([^\/]+)$/, params: ['productId', 'linkId'], load: () => import('./_routes/products/[productId]/supply-chain/links/[linkId].js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/links$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/links.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain.js') },
  { pattern: /^products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/products/[productId].js') },
  { pattern: /^products$/, params: [], load: () => import('./_routes/products.js') },
  { pattern: /^quality\/calculate\-index$/, params: [], load: () => import('./_routes/quality/calculate-index.js') },
  { pattern: /^quality\/audit\-pack$/, params: [], load: () => import('./_routes/quality/audit-pack.js') },
  { pattern: /^quality\/overview$/, params: [], load: () => import('./_routes/quality/overview.js') },
  { pattern: /^schema\-bindings$/, params: [], load: () => import('./_routes/schema-bindings.js') },
  { pattern: /^quality\/products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/quality/products/[productId].js') },
  { pattern: /^quality\/suppliers\/([^\/]+)$/, params: ['supplierId'], load: () => import('./_routes/quality/suppliers/[supplierId].js') },
  { pattern: /^quality\-issues\/([^\/]+)\/acknowledge$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/acknowledge.js') },
  { pattern: /^quality\-issues\/([^\/]+)\/waive$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/waive.js') },
  { pattern: /^questionnaires\/([^\/]+)$/, params: ['questionnaireKey'], load: () => import('./_routes/questionnaires/[questionnaireKey].js') },
  { pattern: /^questionnaires$/, params: [], load: () => import('./_routes/questionnaires.js') },
  { pattern: /^supplier\/certifications\/ocr\-extract$/, params: [], load: () => import('./_routes/supplier/certifications/ocr-extract.js') },
  { pattern: /^supplier\/certifications\/([^\/]+)$/, params: ['certificationId'], load: () => import('./_routes/supplier/certifications/[certificationId].js') },
  { pattern: /^supplier\/certifications$/, params: [], load: () => import('./_routes/supplier/certifications.js') },
  { pattern: /^supplier\/shares$/, params: [], load: () => import('./_routes/supplier/shares.js') },
  { pattern: /^supplier\/data\-points\/([^\/]+)$/, params: ['dataPointId'], load: () => import('./_routes/supplier/data-points/[dataPointId].js') },
  { pattern: /^supplier\/data\-points$/, params: [], load: () => import('./_routes/supplier/data-points.js') },
  { pattern: /^supplier\/documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/download.js') },
  { pattern: /^supplier\/documents\/([^\/]+)\/scan$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/scan.js') },
  { pattern: /^supplier\/documents\/upload\-intent$/, params: [], load: () => import('./_routes/supplier/documents/upload-intent.js') },
  { pattern: /^supplier\/documents$/, params: [], load: () => import('./_routes/supplier/documents.js') },
  { pattern: /^supplier\/member\-invitations\/([^\/]+)$/, params: ['invitationId'], load: () => import('./_routes/supplier/member-invitations/[invitationId].js') },
  { pattern: /^supplier\/members$/, params: [], load: () => import('./_routes/supplier/members.js') },
  { pattern: /^supplier\/onboarding$/, params: [], load: () => import('./_routes/supplier/onboarding.js') },
  { pattern: /^supplier\/organizations$/, params: [], load: () => import('./_routes/supplier/organizations.js') },
  { pattern: /^supplier\/profile\/submit$/, params: [], load: () => import('./_routes/supplier/profile/submit.js') },
  { pattern: /^supplier\/profile$/, params: [], load: () => import('./_routes/supplier/profile.js') },
  { pattern: /^supplier\/quality$/, params: [], load: () => import('./_routes/supplier/quality.js') },
  { pattern: /^supplier\/sites\/([^\/]+)$/, params: ['siteId'], load: () => import('./_routes/supplier/sites/[siteId].js') },
  { pattern: /^supplier\/sites$/, params: [], load: () => import('./_routes/supplier/sites.js') },
  { pattern: /^suppliers\/([^\/]+)\/profile\/submit$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile/submit.js') },
  { pattern: /^suppliers\/([^\/]+)\/profile$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile.js') },
  { pattern: /^suppliers$/, params: [], load: () => import('./_routes/suppliers.js') },
  { pattern: /^traceability\/mass\-balance$/, params: [], load: () => import('./_routes/traceability/mass-balance.js') },
  { pattern: /^traceability\/lineage\-graph$/, params: [], load: () => import('./_routes/traceability/lineage-graph.js') },
  { pattern: /^traceability\/audit\-chain$/, params: [], load: () => import('./_routes/traceability/audit-chain.js') }
];

function requestPath(req: VercelRequest) {
  const value = req.query.path;
  if (Array.isArray(value)) return value.join('/');
  if (typeof value === 'string' && value) return value;
  const pathname = (req.url || '').split('?')[0].replace(/^\/api\/?/, '');
  return pathname.replace(/^\/+|\/+$/g, '');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = requestPath(req);
  const route = routes.find((candidate) => candidate.pattern.test(path));
  if (!route) return json(res, 404, { error: 'route_not_found' });
  const match = route.pattern.exec(path);
  if (match) {
    const query = { ...req.query };
    route.params.forEach((param, index) => { query[param] = decodeURIComponent(match[index + 1]); });
    req.query = query;
  }
  const module = await route.load();
  return module.default(req, res);
}
