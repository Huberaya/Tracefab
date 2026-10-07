import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';

/**
 * Evidence Center — brand-side document list.
 *
 * The four per-document routes (`download`, `verify-ai`, `security-report`,
 * `verification-report`) and `upload-intent` already existed and were called by
 * nothing: no surface could enumerate the documents those routes act on, so the
 * whole evidence layer was unreachable from a brand account.
 *
 * Authorization is delegated to the existing `tracefab_can_access_document(uuid)`
 * SQL function — the same gate `verification-report` and `security-report` use.
 * This endpoint therefore cannot widen what a caller is allowed to see; it only
 * enumerates what that function already permits (owner-organization membership,
 * explicit `data_shares`, evidence attached to a data response, or a document
 * backing a certification on an accessible organization or product).
 *
 * Read-only. No schema change.
 */

const KINDS = new Set(['certificate', 'technical_spec', 'origin_proof', 'audit_report', 'invoice', 'other']);
const STATUSES = new Set(['uploaded', 'scanning', 'available', 'rejected']);

type Row = {
  id: string;
  owner_organization_id: string;
  owner_organization_name: string | null;
  original_filename: string;
  content_type: string;
  byte_size: string | number;
  sha256: string | null;
  kind: string;
  status: string;
  visibility: string;
  expires_at: string | null;
  created_at: string;
  available_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown> | null;
  verification_count: string | number;
  latest_verification_status: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { user } = await requireClerkUser(req);

    const kindParam = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
    const statusParam = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (kindParam && !KINDS.has(kindParam)) return json(res, 400, { error: 'invalid_document_kind' });
    if (statusParam && !STATUSES.has(statusParam)) return json(res, 400, { error: 'invalid_document_status' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    const rows = await withTracefabUserContext(user.id, user.email, async (tx) =>
      tx.$queryRaw<Array<Row>>`
        SELECT
          d.id,
          d.owner_organization_id,
          o.display_name AS owner_organization_name,
          d.original_filename,
          d.content_type,
          d.byte_size::text AS byte_size,
          d.sha256,
          d.kind::text AS kind,
          d.status::text AS status,
          d.visibility::text AS visibility,
          d.expires_at::text AS expires_at,
          d.created_at::text AS created_at,
          d.available_at::text AS available_at,
          d.updated_at::text AS updated_at,
          d.metadata,
          (SELECT COUNT(*) FROM verification_records v WHERE v.document_id = d.id) AS verification_count,
          (SELECT v.status::text
             FROM verification_records v
            WHERE v.document_id = d.id
            ORDER BY v.created_at DESC
            LIMIT 1) AS latest_verification_status
        FROM documents d
        JOIN organizations o ON o.id = d.owner_organization_id
        WHERE d.status <> 'deleted'
          AND tracefab_can_access_document(d.id)
          AND (${kindParam}::text = '' OR d.kind::text = ${kindParam}::text)
          AND (${statusParam}::text = '' OR d.status::text = ${statusParam}::text)
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `,
    );

    const documents = rows.map((row) => ({
      id: row.id,
      ownerOrganizationId: row.owner_organization_id,
      ownerOrganizationName: row.owner_organization_name,
      originalFilename: row.original_filename,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      kind: row.kind,
      status: row.status,
      visibility: row.visibility,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      availableAt: row.available_at,
      updatedAt: row.updated_at,
      metadata: row.metadata ?? {},
      verificationCount: Number(row.verification_count),
      latestVerificationStatus: row.latest_verification_status,
    }));

    // Agrégats calculés sur le jeu renvoyé : aucune valeur n'est inventée.
    const countBy = (pick: (d: (typeof documents)[number]) => string) =>
      documents.reduce<Record<string, number>>((acc, d) => {
        const key = pick(d) || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

    return json(res, 200, {
      documents,
      count: documents.length,
      byKind: countBy((d) => d.kind),
      byStatus: countBy((d) => d.status),
      byVerification: countBy((d) => d.latestVerificationStatus || 'unverified'),
      expiringWithin90Days: documents.filter((d) => {
        if (!d.expiresAt) return false;
        const days = (new Date(d.expiresAt).getTime() - Date.now()) / 86400000;
        return days >= 0 && days <= 90;
      }).length,
      kinds: [...KINDS],
      statuses: [...STATUSES],
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
