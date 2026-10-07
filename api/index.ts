import type { VercelRequest, VercelResponse } from './_lib/vercel-types.js';
import { json } from './_lib/http.js';

type RouteHandler = (req: VercelRequest, res: VercelResponse) => unknown;
type Route = { pattern: RegExp; params: string[]; load: () => Promise<{ default: RouteHandler }> };

const routes: Route[] = [
  { pattern: /^catalog\/products\/import$/, params: [], load: () => import('./_routes/catalog/products/import.js') },
  { pattern: /^catalog\/products\/export$/, params: [], load: () => import('./_routes/catalog/products/export.js') },
  { pattern: /^catalog\/products\/import\-jobs\/([^\/]+)$/, params: ['jobId'], load: () => import('./_routes/catalog/products/import-jobs/[jobId].js') },
  { pattern: /^catalog\/suppliers\/import$/, params: [], load: () => import('./_routes/catalog/suppliers/import.js') },
  { pattern: /^catalog\/audit\-export$/, params: [], load: () => import('./_routes/catalog/audit-export.js') },
  { pattern: /^supplier\/materials\/import\-bom$/, params: [], load: () => import('./_routes/supplier/materials/import-bom.js') },
  { pattern: /^catalog\/import\/products$/, params: [], load: () => import('./_routes/catalog/import/products.js') },
  { pattern: /^catalog\/import\/suppliers$/, params: [], load: () => import('./_routes/catalog/import/suppliers.js') },
  { pattern: /^catalog\/export\/products$/, params: [], load: () => import('./_routes/catalog/export/products.js') },
  { pattern: /^catalog\/export\/suppliers$/, params: [], load: () => import('./_routes/catalog/export/suppliers.js') },
  { pattern: /^catalog\/export\/audit\-dossier$/, params: [], load: () => import('./_routes/catalog/export/audit-dossier.js') },
  { pattern: /^catalog\/questionnaires$/, params: [], load: () => import('./_routes/catalog/questionnaires.js') },
  { pattern: /^catalog\/schemas$/, params: [], load: () => import('./_routes/catalog/schemas.js') },
  { pattern: /^catalog\/certification\-standards$/, params: [], load: () => import('./_routes/catalog/certification-standards.js') },
  { pattern: /^config$/, params: [], load: () => import('./_routes/config.js') },
  { pattern: /^data\-request\-items\/([^\/]+)\/response$/, params: ['itemId'], load: () => import('./_routes/data-request-items/[itemId]/response.js') },
  { pattern: /^data\-requests\/([^\/]+)\/items\/from\-template$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items/from-template.js') },
  { pattern: /^data\-requests\/([^\/]+)\/items$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items.js') },
  { pattern: /^data\-requests\/([^\/]+)\/remind$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/remind.js') },
  { pattern: /^data\-requests\/([^\/]+)\/send$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/send.js') },
  { pattern: /^data\-requests\/([^\/]+)\/submit$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/submit.js') },
  { pattern: /^data\-requests\/([^\/]+)$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId].js') },
  { pattern: /^data\-requests$/, params: [], load: () => import('./_routes/data-requests.js') },
  { pattern: /^data\-responses\/([^\/]+)\/review$/, params: ['responseId'], load: () => import('./_routes/data-responses/[responseId]/review.js') },
  { pattern: /^documents\/upload\-intent$/, params: [], load: () => import('./_routes/documents/upload-intent.js') },
  { pattern: /^documents$/, params: [], load: () => import('./_routes/documents.js') },
  { pattern: /^documents\/([^\/]+)\/security\-report$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/security-report.js') },
  { pattern: /^documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/download.js') },
  { pattern: /^documents\/([^\/]+)\/verify\-ai$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/verify-ai.js') },
  { pattern: /^documents\/([^\/]+)\/verification\-report$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/verification-report.js') },
  { pattern: /^health$/, params: [], load: () => import('./_routes/health.js') },
  { pattern: /^internal\/notification\-outbox\/health$/, params: [], load: () => import('./_routes/internal/notification-outbox/health.js') },
  { pattern: /^internal\/notification\-outbox\/process$/, params: [], load: () => import('./_routes/internal/notification-outbox/process.js') },
  { pattern: /^internal\/notification\-outbox\/reminders$/, params: [], load: () => import('./_routes/internal/notification-outbox/reminders.js') },
  { pattern: /^internal\/notification\-outbox\/schedule$/, params: [], load: () => import('./_routes/internal/notification-outbox/schedule.js') },
  { pattern: /^internal\/p2\/readiness$/, params: [], load: () => import('./_routes/internal/p2-readiness.js') },
  { pattern: /^operations\/overview$/, params: [], load: () => import('./_routes/operations/overview.js') },
  { pattern: /^organization\/storage\/usage$/, params: [], load: () => import('./_routes/organization/storage/usage.js') },
  { pattern: /^integrations\/ingest$/, params: [], load: () => import('./_routes/integrations/ingest.js') },
  { pattern: /^integrations\/jobs$/, params: [], load: () => import('./_routes/integrations/jobs.js') },
  { pattern: /^integrations$/, params: [], load: () => import('./_routes/integrations.js') },
  { pattern: /^gs1\/digital\-link\/([^\/]+)$/, params: ['gtin'], load: () => import('./_routes/gs1/digital-link/[gtin].js') },
  { pattern: /^invitations\/accept$/, params: [], load: () => import('./_routes/invitations/accept.js') },
  { pattern: /^webhooks\/clerk$/, params: [], load: () => import('./_routes/webhooks/clerk.js') },
  { pattern: /^materials\/([^\/]+)$/, params: ['materialId'], load: () => import('./_routes/materials/[materialId].js') },
  { pattern: /^materials$/, params: [], load: () => import('./_routes/materials.js') },
  { pattern: /^mass\-balance\/certificates$/, params: [], load: () => import('./_routes/mass-balance/certificates.js') },
  { pattern: /^traceability\/audit\-chain$/, params: [], load: () => import('./_routes/traceability/audit-chain.js') },
  { pattern: /^traceability\/lineage\-graph$/, params: [], load: () => import('./_routes/traceability/lineage-graph.js') },
  { pattern: /^traceability\/mass\-balance$/, params: [], load: () => import('./_routes/traceability/mass-balance.js') },
  { pattern: /^me$/, params: [], load: () => import('./_routes/me.js') },
  { pattern: /^organizations\/([^\/]+)\/invitations$/, params: ['organizationId'], load: () => import('./_routes/organizations/[organizationId]/invitations.js') },
  { pattern: /^organizations$/, params: [], load: () => import('./_routes/organizations.js') },
  { pattern: /^products\/([^\/]+)\/data\-points$/, params: ['productId'], load: () => import('./_routes/products/[productId]/data-points.js') },
  { pattern: /^products\/([^\/]+)\/identifiers$/, params: ['productId'], load: () => import('./_routes/products/[productId]/identifiers.js') },
  { pattern: /^products\/([^\/]+)\/materials$/, params: ['productId'], load: () => import('./_routes/products/[productId]/materials.js') },
  { pattern: /^products\/([^\/]+)\/revision$/, params: ['productId'], load: () => import('./_routes/products/[productId]/revision.js') },
  { pattern: /^products\/([^\/]+)\/mass\-balance\/allocate$/, params: ['productId'], load: () => import('./_routes/products/[productId]/mass-balance/allocate.js') },
  { pattern: /^products\/([^\/]+)\/mass\-balance$/, params: ['productId'], load: () => import('./_routes/products/[productId]/mass-balance.js') },
  { pattern: /^products\/([^\/]+)\/pef\/calculate$/, params: ['productId'], load: () => import('./_routes/products/[productId]/pef/calculate.js') },
  { pattern: /^products\/([^\/]+)\/pef$/, params: ['productId'], load: () => import('./_routes/products/[productId]/pef.js') },
  { pattern: /^pef\/factors$/, params: [], load: () => import('./_routes/pef/factors.js') },
  { pattern: /^products\/([^\/]+)\/green\-claims\/audit$/, params: ['productId'], load: () => import('./_routes/products/[productId]/green-claims/audit.js') },
  { pattern: /^products\/([^\/]+)\/green\-claims$/, params: ['productId'], load: () => import('./_routes/products/[productId]/green-claims.js') },
  { pattern: /^dpp\/([^\/]+)\/apple\-wallet$/, params: ['gtin'], load: () => import('./_routes/dpp/[gtin]/apple-wallet.js') },
  { pattern: /^dpp\/([^\/]+)\/google\-wallet$/, params: ['gtin'], load: () => import('./_routes/dpp/[gtin]/google-wallet.js') },
  { pattern: /^dpp\/validate$/, params: [], load: () => import('./_routes/dpp/validate.js') },
  { pattern: /^dpp\/([^\/]+)$/, params: ['gtin'], load: () => import('./_routes/dpp/[gtin].js') },
  { pattern: /^green\-claims\/rules$/, params: [], load: () => import('./_routes/green-claims/rules.js') },
  { pattern: /^products\/([^\/]+)\/dpp\/publish\-review$/, params: ['productId'], load: () => import('./_routes/products/[productId]/dpp/publish-review.js') },
  { pattern: /^products\/([^\/]+)\/dpp$/, params: ['productId'], load: () => import('./_routes/products/[productId]/dpp.js') },
  { pattern: /^products\/([^\/]+)\/wallet\/apple$/, params: ['productId'], load: () => import('./_routes/products/[productId]/wallet/apple.js') },
  { pattern: /^products\/([^\/]+)\/wallet\/google$/, params: ['productId'], load: () => import('./_routes/products/[productId]/wallet/google.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/generate\-baseline$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/generate-baseline.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/nodes\/([^\/]+)$/, params: ['productId', 'nodeId'], load: () => import('./_routes/products/[productId]/supply-chain/nodes/[nodeId].js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/nodes$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/nodes.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/links\/([^\/]+)$/, params: ['productId', 'linkId'], load: () => import('./_routes/products/[productId]/supply-chain/links/[linkId].js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain\/links$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/links.js') },
  { pattern: /^products\/([^\/]+)\/supply\-chain$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain.js') },
  { pattern: /^products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/products/[productId].js') },
  { pattern: /^products$/, params: [], load: () => import('./_routes/products.js') },
  { pattern: /^quality\/overview$/, params: [], load: () => import('./_routes/quality/overview.js') },
  { pattern: /^schema\-bindings$/, params: [], load: () => import('./_routes/schema-bindings.js') },
  { pattern: /^quality\/products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/quality/products/[productId].js') },
  { pattern: /^quality\/suppliers\/([^\/]+)$/, params: ['supplierId'], load: () => import('./_routes/quality/suppliers/[supplierId].js') },
  { pattern: /^quality\-issues\/([^\/]+)\/acknowledge$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/acknowledge.js') },
  { pattern: /^quality\-issues\/([^\/]+)\/waive$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/waive.js') },
  { pattern: /^quality\/issues\/([^\/]+)\/cap$/, params: ['issueId'], load: () => import('./_routes/quality/issues/[issueId]/cap.js') },
  { pattern: /^quality\/caps\/([^\/]+)\/messages$/, params: ['capId'], load: () => import('./_routes/quality/caps/[capId]/messages.js') },
  { pattern: /^quality\/caps\/([^\/]+)\/submit\-remediation$/, params: ['capId'], load: () => import('./_routes/quality/caps/[capId]/submit-remediation.js') },
  { pattern: /^quality\/caps\/([^\/]+)\/review$/, params: ['capId'], load: () => import('./_routes/quality/caps/[capId]/review.js') },
  { pattern: /^quality\/caps$/, params: [], load: () => import('./_routes/quality/caps.js') },
  { pattern: /^questionnaires\/([^\/]+)$/, params: ['questionnaireKey'], load: () => import('./_routes/questionnaires/[questionnaireKey].js') },
  { pattern: /^questionnaires$/, params: [], load: () => import('./_routes/questionnaires.js') },
  { pattern: /^supplier\/certifications\/([^\/]+)\/auto\-verify$/, params: ['certificationId'], load: () => import('./_routes/supplier/certifications/[certificationId]/auto-verify.js') },
  { pattern: /^supplier\/certifications\/([^\/]+)$/, params: ['certificationId'], load: () => import('./_routes/supplier/certifications/[certificationId].js') },
  { pattern: /^supplier\/certifications$/, params: [], load: () => import('./_routes/supplier/certifications.js') },
  { pattern: /^supplier\/data\-points\/([^\/]+)$/, params: ['dataPointId'], load: () => import('./_routes/supplier/data-points/[dataPointId].js') },
  { pattern: /^supplier\/data\-points$/, params: [], load: () => import('./_routes/supplier/data-points.js') },
  { pattern: /^supplier\/documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/download.js') },
  { pattern: /^supplier\/documents\/([^\/]+)\/scan$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/scan.js') },
  { pattern: /^supplier\/documents\/upload\-intent$/, params: [], load: () => import('./_routes/supplier/documents/upload-intent.js') },
  { pattern: /^supplier\/storage\/usage$/, params: [], load: () => import('./_routes/supplier/storage/usage.js') },
  { pattern: /^supplier\/documents$/, params: [], load: () => import('./_routes/supplier/documents.js') },
  { pattern: /^supplier\/member\-invitations\/([^\/]+)$/, params: ['invitationId'], load: () => import('./_routes/supplier/member-invitations/[invitationId].js') },
  { pattern: /^supplier\/members$/, params: [], load: () => import('./_routes/supplier/members.js') },
  { pattern: /^supplier\/onboarding$/, params: [], load: () => import('./_routes/supplier/onboarding.js') },
  { pattern: /^supplier\/passport\/access\-requests$/, params: [], load: () => import('./_routes/supplier/passport/access-requests.js') },
  { pattern: /^supplier\/passport$/, params: [], load: () => import('./_routes/supplier/passport.js') },
  { pattern: /^passport\/([^\/]+)\/request\-access$/, params: ['tokenOrSlug'], load: () => import('./_routes/passport/[tokenOrSlug]/request-access.js') },
  { pattern: /^passport\/([^\/]+)$/, params: ['tokenOrSlug'], load: () => import('./_routes/passport/[tokenOrSlug].js') },
  { pattern: /^supplier\/organizations$/, params: [], load: () => import('./_routes/supplier/organizations.js') },
  { pattern: /^supplier\/profile\/submit$/, params: [], load: () => import('./_routes/supplier/profile/submit.js') },
  { pattern: /^supplier\/profile$/, params: [], load: () => import('./_routes/supplier/profile.js') },
  { pattern: /^supplier\/quality$/, params: [], load: () => import('./_routes/supplier/quality.js') },
  { pattern: /^supplier\/shares$/, params: [], load: () => import('./_routes/supplier/shares.js') },
  { pattern: /^supplier\/sites\/([^\/]+)$/, params: ['siteId'], load: () => import('./_routes/supplier/sites/[siteId].js') },
  { pattern: /^supplier\/sites$/, params: [], load: () => import('./_routes/supplier/sites.js') },
  { pattern: /^suppliers\/([^\/]+)\/profile\/submit$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile/submit.js') },
  { pattern: /^suppliers\/([^\/]+)\/profile$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile.js') },
  { pattern: /^suppliers$/, params: [], load: () => import('./_routes/suppliers.js') }
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
