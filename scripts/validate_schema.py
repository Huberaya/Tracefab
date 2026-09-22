#!/usr/bin/env python3
"""Static guardrails for the first Tracefab migration.

This does not replace execution against PostgreSQL/Supabase. It catches accidental
scope expansion or incomplete edits when the local environment has no database CLI.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "supabase/migrations/20260922000000_tracefab_core.sql"
SUPPLIER_SQL_PATH = ROOT / "supabase/migrations/20260922010000_tracefab_supplier_profile.sql"
SQL = SQL_PATH.read_text(encoding="utf-8")
SUPPLIER_SQL = SUPPLIER_SQL_PATH.read_text(encoding="utf-8")

EXPECTED_TABLES = {
    "organizations",
    "organization_memberships",
    "organization_invitations",
    "brand_supplier_relationships",
    "suppliers",
    "supplier_sites",
    "tracefab_products",
    "materials",
    "product_materials",
    "supply_chain_nodes",
    "supply_chain_links",
    "data_requests",
    "data_request_items",
    "documents",
    "data_responses",
    "data_points",
    "data_shares",
    "certifications",
    "verification_records",
    "data_quality_scores",
    "dpp_records",
    "audit_logs",
}

actual_tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS ([a-z_]+)", SQL))
policies = re.findall(r"CREATE POLICY ([a-z_]+)", SQL)
errors: list[str] = []

missing = EXPECTED_TABLES - actual_tables
unexpected = actual_tables - EXPECTED_TABLES
if missing:
    errors.append(f"missing tables: {sorted(missing)}")
if unexpected:
    errors.append(f"unexpected tables: {sorted(unexpected)}")
if len(actual_tables) != 22:
    errors.append(f"expected 22 tables, found {len(actual_tables)}")
if len(policies) != 61:
    errors.append(f"expected 61 policies, found {len(policies)}")
if re.search(r"TO anon", SQL, re.IGNORECASE):
    errors.append("anonymous role appears in a policy")
if re.search(r"USING\s*\(\s*true\s*\)", SQL, re.IGNORECASE):
    errors.append("unrestricted USING (true) policy found")
if re.search(r"ON ALL TABLES IN SCHEMA", SQL, re.IGNORECASE):
    errors.append("broad all-tables grant found")
if "tracefab_create_organization" not in SQL:
    errors.append("organization bootstrap function missing")
if "tracefab_can_access_shared_subject" not in SQL:
    errors.append("object-scoped share helper missing")

for required_marker in (
    "profile_completion",
    "relationship_id UUID REFERENCES brand_supplier_relationships",
    "tracefab_invite_supplier",
    "tracefab_accept_organization_invitation",
    "tracefab_update_supplier_profile",
    "tracefab_submit_supplier_profile",
    "relationships_validate_organizations",
    "shares_validate_relationship",
    "invitations_validate_relationship",
    "invitations_select_participant",
    "invitations_update_participant",
):
    if required_marker not in SUPPLIER_SQL:
        errors.append(f"supplier profile marker missing: {required_marker}")

if re.search(r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+tracefab_calculate_supplier_profile_completion", SUPPLIER_SQL, re.IGNORECASE):
    errors.append("internal supplier completeness function is publicly granted")

if errors:
    print("schema validation failed:")
    print("- " + "\n- ".join(errors))
    sys.exit(1)

print(f"schema validation passed: {len(actual_tables)} tables, {len(policies)} policies")
