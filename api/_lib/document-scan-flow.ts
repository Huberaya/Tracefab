import type { Prisma } from '@prisma/client';
import {
  DOCUMENT_SELECT,
  beginDocumentScan,
  completeDocumentScan,
  isDefinitiveScanError,
  performDocumentScanChecks,
  rejectDocumentScan,
  serializeDocument,
  type DocumentRecord,
} from './documents.js';
import { withTracefabUserContext } from './context.js';

export type ScanFlowResult =
  | { kind: 'not_found' }
  | { kind: 'done'; body: { document: ReturnType<typeof serializeDocument>; scan: { status: 'clean' | 'rejected' } } }
  | { kind: 'rejected'; body: { document: ReturnType<typeof serializeDocument>; scan: { status: 'rejected' }; reason: string } }
  | { kind: 'retryable'; error: string };

/** Principal authentifie (Clerk) — jamais une entree de requete. */
export type ScanActor = { id: string; email: string };

/**
 * Flux de scan partage par les parcours marque et fournisseur.
 *
 * Phase 1 (transaction courte) : resolution du document dans l'organisation
 *   du demandeur, bascule `scanning` — la politique RLS et le controle de
 *   propriete s'appliquent ;
 * Phase 2 (SANS transaction) : integrite objet + antivirus, fail-closed ;
 * Phase 3 (transaction courte) : finalisation (available / rejected).
 *
 * Une erreur transitoire (stockage ou antivirus indisponible) ne modifie pas
 * le verdict : le document reste `scanning` et l'appel peut etre rejoue.
 */
export async function runDocumentScanFlow(
  user: ScanActor,
  documentId: string,
  ownerOrganizationId: string,
): Promise<ScanFlowResult> {
  const started: DocumentRecord | null = await withTracefabUserContext(user.id, user.email, async (tx) => {
    const current = await tx.documents.findFirst({
      where: {
        id: documentId,
        owner_organization_id: ownerOrganizationId,
        status: { in: ['uploaded', 'scanning'] },
      },
      select: DOCUMENT_SELECT,
    });
    if (!current) return null;
    return beginDocumentScan(tx, current);
  });
  if (!started) return { kind: 'not_found' };

  let checks;
  try {
    checks = await performDocumentScanChecks(started);
  } catch (error) {
    if (isDefinitiveScanError(error)) {
      const rejected = await withTracefabUserContext(user.id, user.email, (tx) =>
        rejectDocumentScan(tx, started.id, Number(started.byte_size)),
      );
      return {
        kind: 'rejected',
        body: {
          document: serializeDocument(rejected),
          scan: { status: 'rejected' },
          reason: error instanceof Error ? error.message : 'document_scan_failed',
        },
      };
    }
    // Fail-closed : pas de verdict fiable, le document n'est jamais « sain ».
    return {
      kind: 'retryable',
      error: error instanceof Error ? error.message : 'document_scan_unavailable',
    };
  }

  const document = await withTracefabUserContext(user.id, user.email, (tx: Prisma.TransactionClient) =>
    completeDocumentScan(tx, started.id, checks),
  );
  return {
    kind: 'done',
    body: {
      document: serializeDocument(document),
      scan: { status: document.status === 'available' ? 'clean' : 'rejected' },
    },
  };
}
