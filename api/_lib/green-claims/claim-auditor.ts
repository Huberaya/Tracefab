import type { Prisma, PrismaClient } from '@prisma/client';
import type { GreenClaimsAuditResult, GreenClaimItem, ClaimStatus, RiskLevel } from './types.js';

export interface AuditProductClaimsParams {
  productId: string;
  userId?: string;
}

export async function executeProductGreenClaimsAudit(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: AuditProductClaimsParams
): Promise<GreenClaimsAuditResult> {
  const { productId } = params;

  // Execute PostgreSQL stored procedure tracefab_audit_product_green_claims
  const rows = await prisma.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_audit_product_green_claims(${productId}::uuid);
  `;

  if (!rows || rows.length === 0) {
    throw new Error('green_claims_audit_failed');
  }

  const r = rows[0];

  return {
    id: r.id,
    productId: r.product_id,
    productVersion: r.product_version,
    totalClaimsAnalyzed: Number(r.total_claims_analyzed),
    verifiedClaimsCount: Number(r.verified_claims_count),
    prohibitedClaimsCount: Number(r.prohibited_claims_count),
    unsubstantiatedClaimsCount: Number(r.unsubstantiated_claims_count),
    greenClaimsScore: Number(r.green_claims_score),
    auditVerdict: r.audit_verdict,
    blockingIssues: r.blocking_issues || [],
    auditSummary: r.audit_summary,
    auditedAt: r.audited_at ? new Date(r.audited_at).toISOString() : new Date().toISOString(),
  };
}

export function evaluateClaimInMemory(
  claimText: string,
  hasOrganicCert = false,
  hasRecycledCert = false
): { status: ClaimStatus; riskLevel: RiskLevel; isBlocking: boolean; explanation: string; advice: string } {
  const lower = claimText.toLowerCase();

  // 1. Prohibited: Carbon neutrality through offsets
  if (/neutre en carbone|neutralité carbone|carbon neutral|zéro émission|compensé carbone/i.test(lower)) {
    return {
      status: 'prohibited_claim',
      riskLevel: 'critical',
      isBlocking: true,
      explanation: 'L’allégation de neutralité carbone basée sur la compensation est strictement interdite par la Directive Européenne (UE) 2024/825.',
      advice: 'Supprimer l’allégation. Publier l’empreinte carbone brute calculée selon le PEF sans affirmer la neutralité.',
    };
  }

  // 2. Prohibited: Generic vague terms
  if (/éco-responsable|eco-responsable|vert|durable|ami de la nature|propre/i.test(lower)) {
    return {
      status: 'prohibited_claim',
      riskLevel: 'high',
      isBlocking: true,
      explanation: 'Les mentions génériques non mesurables sont prohibées sans certification d’excellence environnementale globale (ex: Écolabel Européen).',
      advice: 'Remplacer par une assertion précise sur la matière (ex: "Contient 98% de coton biologique certifié").',
    };
  }

  // 3. Bio / Organic
  if (/bio|biologique|organic/i.test(lower)) {
    if (hasOrganicCert) {
      return {
        status: 'verified',
        riskLevel: 'low',
        isBlocking: false,
        explanation: 'Allégation biologique étayée par un certificat valide conforme à la directive Green Claims.',
        advice: '',
      };
    }
    return {
      status: 'unsubstantiated',
      riskLevel: 'high',
      isBlocking: true,
      explanation: 'Allégation biologique sans certificat de transaction GOTS ou OCS vérifié.',
      advice: 'Téléverser et faire certifier un certificat GOTS valide pour la matière composant ce produit.',
    };
  }

  // 4. Recycled
  if (/recyclé|recycled|rpet/i.test(lower)) {
    if (hasRecycledCert) {
      return {
        status: 'verified',
        riskLevel: 'low',
        isBlocking: false,
        explanation: 'Allégation de matière recyclée vérifiée avec chaîne de contrôle conforme GRS.',
        advice: '',
      };
    }
    return {
      status: 'unsubstantiated',
      riskLevel: 'high',
      isBlocking: true,
      explanation: 'Mention recyclée non justifiée par un certificat de chaîne de traçabilité (GRS / RCS).',
      advice: 'Fournir un certificat GRS attestant du taux exact de fibres recyclées.',
    };
  }

  // Default
  return {
    status: 'partially_substantiated',
    riskLevel: 'medium',
    isBlocking: false,
    explanation: 'Allégation nécessitant un justificatif probatoire d’audit tiers.',
    advice: 'Associer un rapport de test laboratoire ou une certification tierce partie.',
  };
}
