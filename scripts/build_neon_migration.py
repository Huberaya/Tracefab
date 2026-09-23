#!/usr/bin/env python3
"""Build the Neon/Clerk initial migration from the historical Tracefab SQL.

The historical files were written for Supabase. Neon is still PostgreSQL, so
this builder keeps the domain SQL while replacing Supabase Auth/Storage
integration with a Clerk identity table and an API-owned transaction context.
The generated file is reviewed and applied as one initial migration on the
empty Tracefab Neon database.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "supabase" / "migrations"
OUTPUT = ROOT / "prisma" / "migrations" / "20260923130000_tracefab_neon_initial" / "migration.sql"

prefix = r'''-- Tracefab Neon initial migration
--
-- Canonical runtime database: PostgreSQL on Neon.
-- Authentication: Clerk. The API resolves Clerk's subject to users.clerk_user_id
-- and sets tracefab.user_id for each transaction before protected queries.
-- This migration deliberately does not create a public DPP projection.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION tracefab_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('tracefab.user_id', true), '')::UUID;
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_self ON users
  FOR SELECT TO PUBLIC USING (id = tracefab_current_user_id());
CREATE POLICY users_update_self ON users
  FOR UPDATE TO PUBLIC
  USING (id = tracefab_current_user_id())
  WITH CHECK (id = tracefab_current_user_id());

'''


def transform(path: Path, text: str) -> str:
    # Neon has no Supabase Storage schema. Document metadata remains in the
    # database; object upload/download is an application object-storage concern.
    if path.name == "20260922040000_tracefab_documents_certifications.sql":
        text = re.sub(
            r"\nINSERT INTO storage\.buckets.*?\nSET public = false,\n    file_size_limit = 52428800;\n",
            "\n-- Object storage bucket provisioning is handled outside PostgreSQL on Neon.\n",
            text,
            flags=re.S,
        )
        text = re.sub(
            r"\nDROP POLICY IF EXISTS storage_tracefab_select ON storage\.objects;.*?\n-- -----------------------------------------------------------------------------\n-- 4\. Function privileges and documentation",
            "\n-- Object storage policies are implemented by the trusted API/object-storage adapter.\n\n-- -----------------------------------------------------------------------------\n-- 4. Function privileges and documentation",
            text,
            flags=re.S,
        )

    # Replace Supabase Auth references with the Clerk-to-Postgres identity map.
    text = text.replace("auth.users", "users")
    text = text.replace("auth.uid()", "tracefab_current_user_id()")

    # Neon uses a single private API connection role. RLS predicates still
    # enforce the transaction user context; the database URL never reaches the browser.
    text = re.sub(r"\bTO\s+(authenticated|anon|service_role)\b", "TO PUBLIC", text, flags=re.I)
    text = re.sub(r"\bFROM\s+(authenticated|anon|service_role)\b", "FROM PUBLIC", text, flags=re.I)

    return text


chunks = [prefix]
for source in sorted(SOURCE_DIR.glob("202609220*.sql")):
    chunks.append(f"\n-- SOURCE: {source.name}\n")
    chunks.append(transform(source, source.read_text(encoding="utf-8")))

chunks.append(r'''

-- -----------------------------------------------------------------------------
-- Neon application order model
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE tracefab_order_status AS ENUM ('draft', 'submitted', 'confirmed', 'fulfilled', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  status tracefab_order_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracefab_orders_buyer
  ON orders(buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracefab_orders_product
  ON orders(product_id, created_at DESC);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_select_participant ON orders
  FOR SELECT TO PUBLIC USING (
    buyer_user_id = tracefab_current_user_id()
    OR (organization_id IS NOT NULL AND tracefab_is_org_member(organization_id))
  );
CREATE POLICY orders_insert_buyer ON orders
  FOR INSERT TO PUBLIC WITH CHECK (buyer_user_id = tracefab_current_user_id());
CREATE POLICY orders_update_participant ON orders
  FOR UPDATE TO PUBLIC
  USING (buyer_user_id = tracefab_current_user_id())
  WITH CHECK (buyer_user_id = tracefab_current_user_id());

COMMENT ON TABLE users IS 'Clerk identities synchronized by the trusted Tracefab API.';
COMMENT ON COLUMN users.clerk_user_id IS 'Clerk user subject; never a password or session token.';
COMMENT ON TABLE orders IS 'Operational Tracefab order records; separate from DPP readiness and not public by default.';
COMMENT ON TABLE dpp_records IS 'Operational DPP readiness projection; not final legal compliance and not a public DPP.';
''')

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text("".join(chunks), encoding="utf-8")
print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")
''