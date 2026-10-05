import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from './_lib/http';

type RouteHandler = (req: VercelRequest, res: VercelResponse) => unknown;
type Route = { pattern: RegExp; params: string[]; load: () => Promise<{ default: RouteHandler }> };

const routes: Route[] = [
  { pattern: /^config$/, params: [], load: () => import('./_routes/config') },
  { pattern: /^data\-request\-items\/([^\/]+)\/response$/, params: ['itemId'], load: () => import('./_routes/data-request-items/[itemId]/response') },
  { pattern: /^data\-requests\/([^\/]+)\/items\/from\-template$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items/from-template') },
  { pattern: /^data\-requests\/([^\/]+)\/items$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/items') },
  { pattern: /^data\-requests\/([^\/]+)\/send$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/send') },
  { pattern: /^data\-requests\/([^\/]+)\/submit$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/submit') },
  { pattern: /^data\-requests\/([^\/]+)$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]') },
  { pattern: /^data\-requests$/, params: [], load: () => import('./_routes/data-requests') },
  { pattern: /^data\-responses\/([^\/]+)\/review$/, params: ['responseId'], load: () => import('./_routes/data-responses/[responseId]/review') },
  { pattern: /^documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/download') },
  { pattern: /^health$/, params: [], load: () => import('./_routes/health') },
  { pattern: /^internal\/notification\-outbox\/health$/, params: [], load: () => import('./_routes/internal/notification-outbox/health') },
  { pattern: /^internal\/notification\-outbox\/process$/, params: [], load: () => import('./_routes/internal/notification-outbox/process') },
  { pattern: /^internal\/notification\-outbox\/reminders$/, params: [], load: () => import('./_routes/internal/notification-outbox/reminders') },
  { pattern: /^internal\/notification\-outbox\/schedule$/, params: [], load: () => import('./_routes/internal/notification-outbox/schedule') },
  { pattern: /^invitations\/accept$/, params: [], load: () => import('./_routes/invitations/accept') },
  { pattern: /^materials\/([^\/]+)$/, params: ['materialId'], load: () => import('./_routes/materials/[materialId]') },
  { pattern: /^materials$/, params: [], load: () => import('./_routes/materials') },
  { pattern: /^me$/, params: [], load: () => import('./_routes/me') },
  { pattern: /^organizations\/([^\/]+)\/invitations$/, params: ['organizationId'], load: () => import('./_routes/organizations/[organizationId]/invitations') },
  { pattern: /^organizations$/, params: [], load: () => import('./_routes/organizations') },
  { pattern: /^products\/([^\/]+)\/identifiers$/, params: ['productId'], load: () => import('./_routes/products/[productId]/identifiers') },
  { pattern: /^products\/([^\/]+)\/materials$/, params: ['productId'], load: () => import('./_routes/products/[productId]/materials') },
  { pattern: /^products\/([^\/]+)\/revision$/, params: ['productId'], load: () => import('./_routes/products/[productId]/revision') },
  { pattern: /^products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/products/[productId]') },
  { pattern: /^products$/, params: [], load: () => import('./_routes/products') },
  { pattern: /^quality\/products\/([^\/]+)$/, params: ['productId'], load: () => import('./_routes/quality/products/[productId]') },
  { pattern: /^quality\/suppliers\/([^\/]+)$/, params: ['supplierId'], load: () => import('./_routes/quality/suppliers/[supplierId]') },
  { pattern: /^quality\-issues\/([^\/]+)\/acknowledge$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/acknowledge') },
  { pattern: /^quality\-issues\/([^\/]+)\/waive$/, params: ['issueId'], load: () => import('./_routes/quality-issues/[issueId]/waive') },
  { pattern: /^questionnaires\/([^\/]+)$/, params: ['questionnaireKey'], load: () => import('./_routes/questionnaires/[questionnaireKey]') },
  { pattern: /^questionnaires$/, params: [], load: () => import('./_routes/questionnaires') },
  { pattern: /^supplier\/certifications\/([^\/]+)$/, params: ['certificationId'], load: () => import('./_routes/supplier/certifications/[certificationId]') },
  { pattern: /^supplier\/certifications$/, params: [], load: () => import('./_routes/supplier/certifications') },
  { pattern: /^supplier\/data\-points\/([^\/]+)$/, params: ['dataPointId'], load: () => import('./_routes/supplier/data-points/[dataPointId]') },
  { pattern: /^supplier\/data\-points$/, params: [], load: () => import('./_routes/supplier/data-points') },
  { pattern: /^supplier\/documents\/([^\/]+)\/download$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/download') },
  { pattern: /^supplier\/documents\/([^\/]+)\/scan$/, params: ['documentId'], load: () => import('./_routes/supplier/documents/[documentId]/scan') },
  { pattern: /^supplier\/documents\/upload\-intent$/, params: [], load: () => import('./_routes/supplier/documents/upload-intent') },
  { pattern: /^supplier\/documents$/, params: [], load: () => import('./_routes/supplier/documents') },
  { pattern: /^supplier\/member\-invitations\/([^\/]+)$/, params: ['invitationId'], load: () => import('./_routes/supplier/member-invitations/[invitationId]') },
  { pattern: /^supplier\/members$/, params: [], load: () => import('./_routes/supplier/members') },
  { pattern: /^supplier\/organizations$/, params: [], load: () => import('./_routes/supplier/organizations') },
  { pattern: /^supplier\/profile\/submit$/, params: [], load: () => import('./_routes/supplier/profile/submit') },
  { pattern: /^supplier\/profile$/, params: [], load: () => import('./_routes/supplier/profile') },
  { pattern: /^supplier\/quality$/, params: [], load: () => import('./_routes/supplier/quality') },
  { pattern: /^supplier\/sites\/([^\/]+)$/, params: ['siteId'], load: () => import('./_routes/supplier/sites/[siteId]') },
  { pattern: /^supplier\/sites$/, params: [], load: () => import('./_routes/supplier/sites') },
  { pattern: /^suppliers\/([^\/]+)\/profile\/submit$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile/submit') },
  { pattern: /^suppliers\/([^\/]+)\/profile$/, params: ['supplierId'], load: () => import('./_routes/suppliers/[supplierId]/profile') },
  { pattern: /^suppliers$/, params: [], load: () => import('./_routes/suppliers') }
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
