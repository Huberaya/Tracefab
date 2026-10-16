-- Identités publiques stables du DPP, avec granularité et remplacement explicites.
CREATE TABLE dpp_resolvable_identifiers (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE RESTRICT,
 owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 public_id TEXT NOT NULL UNIQUE CHECK(public_id ~ '^[a-z0-9][a-z0-9-]{7,79}$'),
 granularity TEXT NOT NULL CHECK(granularity IN ('model','variant','batch','unit')),
 qualifier TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','replaced','retired')),
 replaced_by_id UUID REFERENCES dpp_resolvable_identifiers(id) ON DELETE RESTRICT,
 created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 retired_at TIMESTAMPTZ, reason TEXT,
 CHECK((status='replaced' AND replaced_by_id IS NOT NULL) OR (status<>'replaced' AND replaced_by_id IS NULL)),
 CHECK(status='active' OR length(trim(COALESCE(reason,'')))>0)
);
CREATE INDEX idx_dpp_resolvable_product ON dpp_resolvable_identifiers(product_id,status);
CREATE UNIQUE INDEX idx_dpp_resolvable_scope_unique ON dpp_resolvable_identifiers(product_id,granularity,COALESCE(qualifier,'')) WHERE status='active';
ALTER TABLE dpp_resolvable_identifiers ENABLE ROW LEVEL SECURITY;ALTER TABLE dpp_resolvable_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY dpp_identity_private_select ON dpp_resolvable_identifiers FOR SELECT USING(tracefab_can_access_org(owner_organization_id));
CREATE POLICY dpp_identity_public_select ON dpp_resolvable_identifiers FOR SELECT USING(tracefab_public_context() AND tracefab_product_is_public(product_id));
CREATE POLICY dpp_identity_function_insert ON dpp_resolvable_identifiers FOR INSERT WITH CHECK(tracefab_is_org_member(owner_organization_id));
CREATE POLICY dpp_identity_function_update ON dpp_resolvable_identifiers FOR UPDATE USING(tracefab_has_org_role(owner_organization_id,ARRAY['owner','admin','manager']::membership_role[]));

CREATE OR REPLACE FUNCTION tracefab_create_dpp_identity(p_product_id UUID,p_public_id TEXT,p_granularity TEXT,p_qualifier TEXT DEFAULT NULL)
RETURNS dpp_resolvable_identifiers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p tracefab_products;r dpp_resolvable_identifiers;BEGIN SELECT * INTO p FROM tracefab_products WHERE id=p_product_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found';END IF;
 IF NOT tracefab_has_org_role(p.brand_organization_id,ARRAY['owner','admin','manager']::membership_role[]) THEN RAISE EXCEPTION 'dpp_identity_role_required';END IF;
 INSERT INTO dpp_resolvable_identifiers(product_id,owner_organization_id,public_id,granularity,qualifier,created_by)
 VALUES(p_product_id,p.brand_organization_id,lower(trim(p_public_id)),p_granularity,NULLIF(trim(p_qualifier),''),tracefab_current_user_id()) RETURNING * INTO r;RETURN r;END $$;

CREATE OR REPLACE FUNCTION tracefab_replace_dpp_identity(p_identity_id UUID,p_replacement_public_id TEXT,p_reason TEXT)
RETURNS dpp_resolvable_identifiers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old dpp_resolvable_identifiers;replacement dpp_resolvable_identifiers;BEGIN SELECT * INTO old FROM dpp_resolvable_identifiers WHERE id=p_identity_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'dpp_identity_not_found';END IF;
 IF NOT tracefab_has_org_role(old.owner_organization_id,ARRAY['owner','admin','manager']::membership_role[]) THEN RAISE EXCEPTION 'dpp_identity_role_required';END IF;
 IF lower(trim(p_replacement_public_id)) !~ '^[a-z0-9][a-z0-9-]{7,79}$' OR length(trim(COALESCE(p_reason,'')))=0 THEN RAISE EXCEPTION 'invalid_replacement_identity';END IF;
 -- Libère d'abord l'unicité de portée, puis crée le remplaçant dans la même transaction.
 UPDATE dpp_resolvable_identifiers SET status='retired',retired_at=now(),reason=trim(p_reason) WHERE id=old.id;
 INSERT INTO dpp_resolvable_identifiers(product_id,owner_organization_id,public_id,granularity,qualifier,created_by)
 VALUES(old.product_id,old.owner_organization_id,lower(trim(p_replacement_public_id)),old.granularity,old.qualifier,tracefab_current_user_id()) RETURNING * INTO replacement;
 UPDATE dpp_resolvable_identifiers SET status='replaced',replaced_by_id=replacement.id WHERE id=old.id RETURNING * INTO old;RETURN old;END $$;

REVOKE ALL ON dpp_resolvable_identifiers FROM PUBLIC;GRANT SELECT ON dpp_resolvable_identifiers TO PUBLIC;
REVOKE ALL ON FUNCTION tracefab_create_dpp_identity(UUID,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_replace_dpp_identity(UUID,TEXT,TEXT) FROM PUBLIC;
DO $g$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tracefab_app') THEN
 GRANT EXECUTE ON FUNCTION tracefab_create_dpp_identity(UUID,TEXT,TEXT,TEXT) TO tracefab_app;
 GRANT EXECUTE ON FUNCTION tracefab_replace_dpp_identity(UUID,TEXT,TEXT) TO tracefab_app;
END IF;END $g$;
COMMENT ON TABLE dpp_resolvable_identifiers IS 'Identifiants DPP stables par modèle, variante, lot ou unité. Remplacement conservé, jamais disparition silencieuse.';
