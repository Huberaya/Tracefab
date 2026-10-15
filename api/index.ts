import type { VercelRequest, VercelResponse } from './_lib/vercel-types.js';
import { json } from './_lib/http.js';
import { correlationId, reportError } from './_lib/error-reporting.js';
import { applyHeaders, evaluate } from './_lib/rate-limit.js';

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
  { pattern: /^data\-requests\/([^\/]+)\/send$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/send.js') },
  { pattern: /^data\-requests\/([^\/]+)\/submit$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/submit.js') },
  { pattern: /^data\-requests\/([^\/]+)\/remind$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId]/remind.js') },
  { pattern: /^data\-requests\/([^\/]+)$/, params: ['requestId'], load: () => import('./_routes/data-requests/[requestId].js') },
  { pattern: /^data\-requests$/, params: [], load: () => import('./_routes/data-requests.js') },
  { pattern: /^data\-responses\/([^\/]+)\/review$/, params: ['responseId'], load: () => import('./_routes/data-responses/[responseId]/review.js') },
  { pattern: /^documents\/upload\-intent$/, params: [], load: () => import('./_routes/documents/upload-intent.js') },
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
  { pattern: /^integrations\/plm$/, params: [], load: () => import('./_routes/integrations/plm.js') },
  { pattern: /^integrations\/ingest$/, params: [], load: () => import('./_routes/integrations/ingest.js') },
  { pattern: /^integrations\/jobs$/, params: [], load: () => import('./_routes/integrations/jobs.js') },
  { pattern: /^integrations$/, params: [], load: () => import('./_routes/integrations.js') },
  { pattern: /^gs1\/digital\-link\/([^\/]+)$/, params: ['gtin'], load: () => import('./_routes/gs1/digital-link/[gtin].js') },
  { pattern: /^invitations\/accept$/, params: [], load: () => import('./_routes/invitations/accept.js') },
  { pattern: /^webhooks\/clerk$/, params: [], load: () => import('./_routes/webhooks/clerk.js') },
  { pattern: /^materials\/([^\/]+)$/, params: ['materialId'], load: () => import('./_routes/materials/[materialId].js') },
  { pattern: /^materials$/, params: [], load: () => import('./_routes/materials.js') },
  { pattern: /^mass\-balance\/certificates$/, params: [], load: () => import('./_routes/mass-balance/certificates.js') },
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
  { pattern: /^dpp\/validate$/, params: [], load: () => import('./_routes/dpp/validate.js') },
  { pattern: /^dpp\/portfolio$/, params: [], load: () => import('./_routes/dpp/portfolio.js') },
  { pattern: /^dpp\/([^\/]+)\/apple\-wallet$/, params: ['gtin'], load: () => import('./_routes/dpp/[gtin]/apple-wallet.js') },
  { pattern: /^dpp\/([^\/]+)\/google\-wallet$/, params: ['gtin'], load: () => import('./_routes/dpp/[gtin]/google-wallet.js') },
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
  { pattern: /^quality\/audit\-pack$/, params: [], load: () => import('./_routes/quality/audit-pack.js') },
  { pattern: /^quality\/calculate\-index$/, params: [], load: () => import('./_routes/quality/calculate-index.js') },
  { pattern: /^traceability\/audit\-chain$/, params: [], load: () => import('./_routes/traceability/audit-chain.js') },
  { pattern: /^traceability\/lineage\-graph$/, params: [], load: () => import('./_routes/traceability/lineage-graph.js') },
  { pattern: /^traceability\/mass\-balance$/, params: [], load: () => import('./_routes/traceability/mass-balance.js') },
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
  { pattern: /^supplier\/certifications\/ocr\-extract$/, params: [], load: () => import('./_routes/supplier/certifications/ocr-extract.js') },
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
  { pattern: /^supplier\/shares$/, params: [], load: () => import('./_routes/supplier/shares.js') },
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
  // Limitation de debit.
  //
  // Placee ici, apres la resolution de la route et AVANT route.load() : une
  // requete rejetee ne declenche pas le chargement du module, donc pas le
  // demarrage a froid qu'elle cherchait peut-etre a provoquer.
  //
  // Le limiteur ne jette jamais. S'il echoue lui-meme (exception), la
  // requete passe et l'incident reste visible par l'absence des en-tetes
  // RateLimit-* : une exception interne au limiteur ne doit pas devenir une
  // panne. En revanche, quand le compteur partage est injoignable, ce n'est
  // plus une exception mais une decision documentee : les classes sensibles
  // (ecriture anonyme, Wallet) sont refusees en 503 par le module lui-meme.
  try {
    const decision = await evaluate(path, req);
    applyHeaders(res, decision);
    if (!decision.allowed) {
      if (decision.reason === 'counter_unavailable') {
        return json(res, 503, {
          error: 'rate_limiter_unavailable',
          retryAfterSeconds: decision.resetSeconds,
        });
      }
      return json(res, 429, { error: 'rate_limited', retryAfterSeconds: decision.resetSeconds });
    }
  } catch {
    // Volontairement silencieux cote client. L'incident reste visible par
    // l'absence des en-tetes RateLimit-* sur la reponse.
  }

  // Barriere d'erreur centrale.
  //
  // Sans elle, une exception non rattrapee dans un gestionnaire remonte au
  // runtime serverless : le client recoit un 500 opaque, l'erreur n'atterrit
  // nulle part, et personne n'est prevenu. 13 des 125 routes n'ont aucun
  // try/catch, et des helpers comme storage.ts jettent sur mauvaise
  // configuration. Le chargement dynamique du module peut echouer lui aussi.
  const correlation = correlationId();
  try {
    const module = await route.load();
    return await module.default(req, res);
  } catch (error) {
    await reportError(error, {
      route: route.pattern.source,
      method: req.method,
      path,
      status: 500,
    }, correlation);

    // Un gestionnaire peut avoir deja commence a repondre avant de jeter.
    // Ecrire une seconde fois provoquerait une erreur par-dessus l'erreur.
    if (res.headersSent || res.writableEnded) return undefined;

    // Le client recoit l'identifiant de correlation, et rien d'autre : le
    // detail de l'exception reste dans le journal et le collecteur.
    return json(res, 500, { error: 'internal_error', correlationId: correlation });
  }
}
