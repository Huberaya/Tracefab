import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from './_lib/http';
import route0 from './_routes/config';
import route1 from './_routes/data-request-items/[itemId]/response';
import route2 from './_routes/data-requests/[requestId]/items/from-template';
import route3 from './_routes/data-requests/[requestId]/items';
import route4 from './_routes/data-requests/[requestId]/send';
import route5 from './_routes/data-requests/[requestId]/submit';
import route6 from './_routes/data-requests/[requestId]';
import route7 from './_routes/data-requests';
import route8 from './_routes/data-responses/[responseId]/review';
import route9 from './_routes/documents/[documentId]/download';
import route10 from './_routes/health';
import route11 from './_routes/internal/notification-outbox/health';
import route12 from './_routes/internal/notification-outbox/process';
import route13 from './_routes/internal/notification-outbox/reminders';
import route14 from './_routes/internal/notification-outbox/schedule';
import route15 from './_routes/invitations/accept';
import route16 from './_routes/materials/[materialId]';
import route17 from './_routes/materials';
import route18 from './_routes/me';
import route19 from './_routes/organizations/[organizationId]/invitations';
import route20 from './_routes/organizations';
import route21 from './_routes/products/[productId]/identifiers';
import route22 from './_routes/products/[productId]/materials';
import route23 from './_routes/products/[productId]/revision';
import route24 from './_routes/products/[productId]';
import route25 from './_routes/products';
import route26 from './_routes/quality/products/[productId]';
import route27 from './_routes/quality/suppliers/[supplierId]';
import route28 from './_routes/quality-issues/[issueId]/acknowledge';
import route29 from './_routes/quality-issues/[issueId]/waive';
import route30 from './_routes/questionnaires/[questionnaireKey]';
import route31 from './_routes/questionnaires';
import route32 from './_routes/supplier/certifications/[certificationId]';
import route33 from './_routes/supplier/certifications';
import route34 from './_routes/supplier/data-points/[dataPointId]';
import route35 from './_routes/supplier/data-points';
import route36 from './_routes/supplier/documents/[documentId]/download';
import route37 from './_routes/supplier/documents/[documentId]/scan';
import route38 from './_routes/supplier/documents/upload-intent';
import route39 from './_routes/supplier/documents';
import route40 from './_routes/supplier/member-invitations/[invitationId]';
import route41 from './_routes/supplier/members';
import route42 from './_routes/supplier/organizations';
import route43 from './_routes/supplier/profile/submit';
import route44 from './_routes/supplier/profile';
import route45 from './_routes/supplier/quality';
import route46 from './_routes/supplier/sites/[siteId]';
import route47 from './_routes/supplier/sites';
import route48 from './_routes/suppliers/[supplierId]/profile/submit';
import route49 from './_routes/suppliers/[supplierId]/profile';
import route50 from './_routes/suppliers';

type Route = { pattern: RegExp; params: string[]; handler: (req: VercelRequest, res: VercelResponse) => unknown };

const routes: Route[] = [
  { pattern: /^config$/, params: [], handler: route0 },
  { pattern: /^data\-request\-items\/([^\/]+)\/response$/, params: ['itemId'], handler: route1 },
  { pattern: /^data\-requests\/([^\/]+)\/items\/from\-template$/, params: ['requestId'], handler: route2 },
  { pattern: /^data\-requests\/([^\/]+)\/items$/, params: ['requestId'], handler: route3 },
  { pattern: /^data\-requests\/([^\/]+)\/send$/, params: ['requestId'], handler: route4 },
  { pattern: /^data\-requests\/([^\/]+)\/submit$/, params: ['requestId'], handler: route5 },
  { pattern: /^data\-requests\/([^\/]+)$/, params: ['requestId'], handler: route6 },
  { pattern: /^data\-requests$/, params: [], handler: route7 },
  { pattern: /^data\-responses\/([^\/]+)\/review$/, params: ['responseId'], handler: route8 },
  { pattern: /^documents\/([^\/]+)\/download$/, params: ['documentId'], handler: route9 },
  { pattern: /^health$/, params: [], handler: route10 },
  { pattern: /^internal\/notification\-outbox\/health$/, params: [], handler: route11 },
  { pattern: /^internal\/notification\-outbox\/process$/, params: [], handler: route12 },
  { pattern: /^internal\/notification\-outbox\/reminders$/, params: [], handler: route13 },
  { pattern: /^internal\/notification\-outbox\/schedule$/, params: [], handler: route14 },
  { pattern: /^invitations\/accept$/, params: [], handler: route15 },
  { pattern: /^materials\/([^\/]+)$/, params: ['materialId'], handler: route16 },
  { pattern: /^materials$/, params: [], handler: route17 },
  { pattern: /^me$/, params: [], handler: route18 },
  { pattern: /^organizations\/([^\/]+)\/invitations$/, params: ['organizationId'], handler: route19 },
  { pattern: /^organizations$/, params: [], handler: route20 },
  { pattern: /^products\/([^\/]+)\/identifiers$/, params: ['productId'], handler: route21 },
  { pattern: /^products\/([^\/]+)\/materials$/, params: ['productId'], handler: route22 },
  { pattern: /^products\/([^\/]+)\/revision$/, params: ['productId'], handler: route23 },
  { pattern: /^products\/([^\/]+)$/, params: ['productId'], handler: route24 },
  { pattern: /^products$/, params: [], handler: route25 },
  { pattern: /^quality\/products\/([^\/]+)$/, params: ['productId'], handler: route26 },
  { pattern: /^quality\/suppliers\/([^\/]+)$/, params: ['supplierId'], handler: route27 },
  { pattern: /^quality\-issues\/([^\/]+)\/acknowledge$/, params: ['issueId'], handler: route28 },
  { pattern: /^quality\-issues\/([^\/]+)\/waive$/, params: ['issueId'], handler: route29 },
  { pattern: /^questionnaires\/([^\/]+)$/, params: ['questionnaireKey'], handler: route30 },
  { pattern: /^questionnaires$/, params: [], handler: route31 },
  { pattern: /^supplier\/certifications\/([^\/]+)$/, params: ['certificationId'], handler: route32 },
  { pattern: /^supplier\/certifications$/, params: [], handler: route33 },
  { pattern: /^supplier\/data\-points\/([^\/]+)$/, params: ['dataPointId'], handler: route34 },
  { pattern: /^supplier\/data\-points$/, params: [], handler: route35 },
  { pattern: /^supplier\/documents\/([^\/]+)\/download$/, params: ['documentId'], handler: route36 },
  { pattern: /^supplier\/documents\/([^\/]+)\/scan$/, params: ['documentId'], handler: route37 },
  { pattern: /^supplier\/documents\/upload\-intent$/, params: [], handler: route38 },
  { pattern: /^supplier\/documents$/, params: [], handler: route39 },
  { pattern: /^supplier\/member\-invitations\/([^\/]+)$/, params: ['invitationId'], handler: route40 },
  { pattern: /^supplier\/members$/, params: [], handler: route41 },
  { pattern: /^supplier\/organizations$/, params: [], handler: route42 },
  { pattern: /^supplier\/profile\/submit$/, params: [], handler: route43 },
  { pattern: /^supplier\/profile$/, params: [], handler: route44 },
  { pattern: /^supplier\/quality$/, params: [], handler: route45 },
  { pattern: /^supplier\/sites\/([^\/]+)$/, params: ['siteId'], handler: route46 },
  { pattern: /^supplier\/sites$/, params: [], handler: route47 },
  { pattern: /^suppliers\/([^\/]+)\/profile\/submit$/, params: ['supplierId'], handler: route48 },
  { pattern: /^suppliers\/([^\/]+)\/profile$/, params: ['supplierId'], handler: route49 },
  { pattern: /^suppliers$/, params: [], handler: route50 }
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
  return route.handler(req, res);
}
