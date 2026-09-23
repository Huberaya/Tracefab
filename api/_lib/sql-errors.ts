type SqlErrorDefinition = {
  status: number;
  message?: string;
};

const DEFINITIONS: Record<string, SqlErrorDefinition> = {
  authentication_required: { status: 401 },
  brand_admin_role_required: { status: 403 },
  brand_organization_required: { status: 400 },
  valid_supplier_email_required: { status: 400 },
  supplier_legal_name_required: { status: 400 },
  hashed_invitation_token_required: { status: 400 },
  active_supplier_invitation_exists: { status: 409 },
  invalid_or_expired_invitation: { status: 400 },
  invitation_email_mismatch: { status: 403 },
  user_already_member: { status: 409 },
  supplier_not_found: { status: 404 },
  supplier_profile_role_required: { status: 403 },
  supplier_profile_status_does_not_allow_submission: { status: 409 },
};

/**
 * Convert a deliberately small, stable set of PostgreSQL business exceptions
 * into API responses. Raw database error messages are never returned because
 * they can contain implementation details or values from a failed query.
 */
export function sqlBusinessError(error: unknown): { status: number; error: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.keys(DEFINITIONS).find((candidate) => message.includes(candidate));
  if (code) return { status: DEFINITIONS[code].status, error: code };

  if (message.includes('supplier_profile_incomplete')) {
    return { status: 422, error: 'supplier_profile_incomplete' };
  }

  return null;
}
