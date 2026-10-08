/**
 * Règle d'accès à la console Admin — partie pure.
 *
 * Ce module n'importe rien : ni Prisma, ni Clerk, ni `process.env`. La frontière
 * de sécurité la plus importante du Command Center est donc exécutable et
 * contre-vérifiable dans un test, sans client de base généré ni jeton.
 *
 * Le schéma ne connaît qu'un seul type de rôle : `membership_role`, toujours
 * rattaché à une organisation. Il n'existe donc pas de « super admin » global, et
 * en inventer un aurait ajouté un second système d'autorisation à côté du
 * premier. Un Admin / Founder est défini par DEUX conditions :
 *
 *   1. un membership actif de rôle `owner` ou `admin` ;
 *   2. dans une organisation dont le type est `platform` et le statut `active`.
 *
 * `organization_type.platform` existe déjà dans le schéma. Une marque appartient à
 * une organisation `brand`, un fournisseur à une organisation `supplier` : ni l'un
 * ni l'autre ne peut satisfaire la condition 2.
 *
 * PostgreSQL applique exactement la même règle (politiques RLS
 * `tracefab_is_platform_org`). Les deux doivent dire la même chose, sinon l'une
 * des deux ment — `test:admin:chantier01` vérifie les deux.
 */

export const ADMIN_ROLES = ['owner', 'admin'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface PlatformOrganization {
  id: string;
  type: string;
  legal_name: string;
  display_name: string | null;
  status: string;
}

export interface PlatformMembershipCandidate {
  organization_id: string;
  role: string;
  status: string;
  organizations: PlatformOrganization;
}

export interface PlatformAdminAccess {
  role: AdminRole;
  organization: PlatformOrganization;
}

/**
 * Choisit l'organisation platform et le rôle qui donnent accès, ou renvoie `null`.
 *
 * Règles :
 *   - un membership non `active` ne compte pas, quel que soit son rôle ;
 *   - une organisation non `platform` ou non `active` ne compte pas ;
 *   - `owner` l'emporte sur `admin` ;
 *   - à rôle égal, la première organisation dans l'ordre reçu l'emporte, pour que
 *     le résultat ne dépende pas d'un ordre de base non garanti.
 */
export function selectPlatformAdminAccess(
  memberships: PlatformMembershipCandidate[],
): PlatformAdminAccess | null {
  let best: PlatformAdminAccess | null = null;

  for (const membership of memberships || []) {
    if (membership.status !== 'active') continue;
    if (membership.organizations.type !== 'platform') continue;
    if (membership.organizations.status !== 'active') continue;

    const role = membership.role as AdminRole;
    if (!ADMIN_ROLES.includes(role)) continue;

    if (!best || (role === 'owner' && best.role !== 'owner')) {
      best = { role, organization: membership.organizations };
    }
  }

  return best;
}

export function isAdminAccessDenied(error: unknown) {
  return error instanceof Error && error.message === 'admin_access_denied';
}
