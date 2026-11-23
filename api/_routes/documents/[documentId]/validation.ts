import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../_lib/quality.js';

/**
 * Decision humaine sur une preuve documentaire : acceptee, rejetee (motif
 * obligatoire) ou a revoir, avec motif et historique.
 *
 * REUTILISATION, PAS DE NOUVEAU SYSTEME : la decision est enregistree par les
 * fonctions metier deja presentes et deja allowlistees —
 * `tracefab_add_dpp_claim` et `tracefab_link_dpp_claim_evidence` — qui portent
 * les controles de role, d'appartenance du document et d'integrite du dossier.
 * `dpp_claim_evidence.verification_result` + `verification_reason` + la
 * succession des claims constituent l'historique des decisions, relisible par
 * `GET /api/products/:id/dpp/claims` et `verification-report`.
 *
 * Garde supplementaire ici : le locataire ACTIF (`accessibleProduct`), le
 * statut `available` du document et l'acces au document. Aucun document d'une
 * autre organisation, meme avec un identifiant connu, ne peut etre relu ni
 * valide : la reponse est 404, jamais 403.
 *
 * Aucune publication, aucune certification et aucun statut « verifie » ne
 * sont inventes par cette route.
 */
type ReviewBody = { decision?: unknown; reason?: unknown };

function routeDocumentId(req: VercelRequest): string | null {
  const value = req.query.documentId;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });

    // Refus anonyme avant toute lecture du corps.
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<ReviewBody>(req);
    const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
    const reason = body.reason === undefined || body.reason === null
      ? null
      : typeof body.reason === 'string' ? body.reason.trim() : null;

    if (!['accepted', 'rejected', 'needs_review'].includes(decision)) {
      return json(res, 400, { error: 'invalid_document_decision' });
    }
    if (decision === 'rejected' && (!reason || reason.length < 3)) {
      return json(res, 400, { error: 'document_rejection_reason_required' });
    }
    if (reason !== null && (typeof body.reason !== 'string' || reason.length > 1000)) {
      return json(res, 400, { error: 'invalid_document_review_reason' });
    }

    const relationship = decision === 'accepted' ? 'supports'
      : decision === 'rejected' ? 'contradicts' : 'context';
    // Un claim par decision : l'historique reste append-only, comme le reste
    // du dossier DPP. La cle reste dans le format attendu par le depot.
    const claimKey = `evidence.review.${String(documentId).replace(/-/g, '')}.${Date.now()}`;
    const statement = `Document review: ${decision}`;

    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; status: string; metadata: Record<string, unknown> | null;
      }>>`
        SELECT id, status::text AS status, metadata
        FROM documents
        WHERE id = ${documentId}::uuid
          AND status <> 'deleted'
          AND tracefab_can_access_document(id)
        LIMIT 1
      `;
      if (!rows[0]) return { kind: 'not_found' as const };
      if (rows[0].status !== 'available') return { kind: 'not_available' as const };
      const metadata = rows[0].metadata;
      const productId = metadata && typeof metadata === 'object' ? metadata.productId : null;
      if (!isUuid(productId)) return { kind: 'unlinked' as const };
      if (!await accessibleProduct(tx, productId as string)) return { kind: 'not_found' as const };

      const created = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM tracefab_add_dpp_claim(
          ${productId as string}::uuid, ${claimKey}, ${statement}, NULL,
          'declared'::dpp_event_validation_status, NULL::uuid, 'model',
          NULL, NULL::date, NULL::date, NULL::uuid, NULL
        )
      `;
      const claimId = created[0]?.id;
      if (!claimId) throw new Error('claim_creation_failed');

      const evidence = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM tracefab_link_dpp_claim_evidence(
          ${claimId}::uuid, ${documentId}::uuid, ${relationship},
          ${reason}, ${decision}, ${reason}, NULL
        )
      `;
      return { kind: 'ok' as const, claimId, evidence: evidence[0] ?? null };
    });

    if (result.kind === 'not_found') return json(res, 404, { error: 'document_not_found' });
    if (result.kind === 'not_available') return json(res, 409, { error: 'document_not_available' });
    if (result.kind === 'unlinked') return json(res, 422, { error: 'document_not_linked_to_product' });

    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, {
      decision,
      reason,
      relationship,
      claimId: result.claimId,
      evidence: result.evidence,
      note: 'Decision enregistree dans le dossier DPP. Aucune publication ni certification n a ete declenchee.',
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error) {
      const message = error.message;
      if (message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
      if (/role_required/.test(message)) return json(res, 403, { error: message });
      if (/^invalid_|^document_|^product_|^claim_/.test(message)) return json(res, 400, { error: message });
    }
    console.error('POST /api/documents/:documentId/validation failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
