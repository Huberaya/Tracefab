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
PRODUCT_SQL_PATH = ROOT / "supabase/migrations/20260922020000_tracefab_product_data.sql"
COLLECTION_SQL_PATH = ROOT / "supabase/migrations/20260922030000_tracefab_data_collection.sql"
DOCUMENT_SQL_PATH = ROOT / "supabase/migrations/20260922040000_tracefab_documents_certifications.sql"
QUALITY_SQL_PATH = ROOT / "supabase/migrations/20260922050000_tracefab_data_quality.sql"
TRACEABILITY_SQL_PATH = ROOT / "supabase/migrations/20260922060000_tracefab_traceability.sql"
SQL = SQL_PATH.read_text(encoding="utf-8")
SUPPLIER_SQL = SUPPLIER_SQL_PATH.read_text(encoding="utf-8")
PRODUCT_SQL = PRODUCT_SQL_PATH.read_text(encoding="utf-8")
COLLECTION_SQL = COLLECTION_SQL_PATH.read_text(encoding="utf-8")
DOCUMENT_SQL = DOCUMENT_SQL_PATH.read_text(encoding="utf-8")
QUALITY_SQL = QUALITY_SQL_PATH.read_text(encoding="utf-8")
TRACEABILITY_SQL = TRACEABILITY_SQL_PATH.read_text(encoding="utf-8")

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

if "CREATE TABLE IF NOT EXISTS product_identifiers" not in PRODUCT_SQL:
    errors.append("product identifiers table missing")

for required_marker in (
    "product_data_readiness",
    "tracefab_validate_product_brand_ownership",
    "computed_product_fields_are_not_client_writable",
    "tracefab_validate_product_material_ownership",
    "tracefab_calculate_product_data_completion",
    "tracefab_refresh_product_data_readiness",
    "tracefab_create_product",
    "tracefab_update_product_data",
    "tracefab_start_product_revision",
    "product_identifiers_select_brand",
):
    if required_marker not in PRODUCT_SQL:
        errors.append(f"product data marker missing: {required_marker}")

if re.search(r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+tracefab_calculate_product_data_completion", PRODUCT_SQL, re.IGNORECASE):
    errors.append("internal product readiness function is publicly granted")

for required_marker in (
    "relationship_id UUID REFERENCES brand_supplier_relationships",
    "idx_responses_current_item",
    "tracefab_validate_data_request_integrity",
    "tracefab_validate_data_response_integrity",
    "tracefab_validate_data_request_item_mutation",
    "tracefab_create_data_request",
    "tracefab_add_data_request_item",
    "tracefab_send_data_request",
    "tracefab_submit_data_response",
    "tracefab_submit_data_request",
    "tracefab_review_data_response",
    "requests_update_brand",
    "request_items_update_brand",
):
    if required_marker not in COLLECTION_SQL:
        errors.append(f"data collection marker missing: {required_marker}")

if "CREATE POLICY responses_insert_supplier" in COLLECTION_SQL or "CREATE POLICY responses_update_supplier" in COLLECTION_SQL:
    errors.append("direct authenticated response mutation policy found")

if re.search(r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+tracefab_refresh_data_request_progress", COLLECTION_SQL, re.IGNORECASE):
    errors.append("internal data request progress function is publicly granted")

for required_marker in (
    "tracefab-private",
    "tracefab_register_document",
    "tracefab_finalize_document_upload",
    "tracefab_soft_delete_document",
    "storage_tracefab_insert",
    "tracefab_register_certification",
    "tracefab_update_certification",
    "tracefab_review_certification",
    "certifications_insert_owner",
    "verifications_insert_authorized",
):
    if required_marker not in DOCUMENT_SQL:
        errors.append(f"document/certification marker missing: {required_marker}")

if "CREATE POLICY storage_tracefab_delete" in DOCUMENT_SQL:
    errors.append("direct Storage delete policy found")
if "CREATE POLICY documents_insert_owner" in DOCUMENT_SQL:
    errors.append("direct document insert policy found")
if "CREATE POLICY certifications_insert_owner" in DOCUMENT_SQL:
    errors.append("direct certification insert policy found")
if "CREATE POLICY verifications_insert_authorized" in DOCUMENT_SQL:
    errors.append("direct verification insert policy found")

if re.search(r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+tracefab_finalize_document_upload.*TO\s+authenticated", DOCUMENT_SQL, re.IGNORECASE):
    errors.append("document finalization is granted to authenticated")

for required_marker in (
    "CREATE TABLE IF NOT EXISTS data_quality_issues",
    "quality_issue_severity",
    "quality_issue_status",
    "tracefab_validate_quality_issue_subject",
    "tracefab_upsert_quality_issue",
    "tracefab_compute_supplier_quality",
    "tracefab_compute_product_quality",
    "tracefab_acknowledge_quality_issue",
    "tracefab_waive_quality_issue",
    "quality_issues_select_owner",
):
    if required_marker not in QUALITY_SQL:
        errors.append(f"data quality marker missing: {required_marker}")

if "CREATE POLICY quality_issues_insert" in QUALITY_SQL or "CREATE POLICY quality_issues_update" in QUALITY_SQL:
    errors.append("direct quality issue mutation policy found")

if re.search(r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+tracefab_upsert_quality_issue", QUALITY_SQL, re.IGNORECASE):
    errors.append("internal quality issue upsert function is publicly granted")

for required_marker in (
    "tracefab_validate_supply_chain_node",
    "tracefab_validate_supply_chain_link",
    "tracefab_create_supply_chain_node",
    "tracefab_update_supply_chain_node",
    "tracefab_add_supply_chain_link",
    "tracefab_update_supply_chain_link",
    "tracefab_get_product_traceability",
    "nodes_select_traceability_graph",
    "links_select_traceability_graph",
):
    if required_marker not in TRACEABILITY_SQL:
        errors.append(f"traceability marker missing: {required_marker}")

if "CREATE POLICY nodes_insert_authorized" in TRACEABILITY_SQL or "CREATE POLICY links_insert_brand" in TRACEABILITY_SQL:
    errors.append("direct traceability mutation policy found")

if errors:
    print("schema validation failed:")
    print("- " + "\n- ".join(errors))
    sys.exit(1)

print(f"schema validation passed: {len(actual_tables)} core tables, {len(policies)} core policies plus supplier/product migration markers")
