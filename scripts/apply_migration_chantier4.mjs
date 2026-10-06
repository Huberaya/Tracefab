import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Applying Chantier 4 DDL and stored procedures to Neon...');

  // 1. Table green_claims_rules
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS green_claims_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_code TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK (category IN ('prohibited_generic_term', 'carbon_neutrality_ban', 'substantiation_required', 'recycled_content_threshold', 'organic_claim_proof')),
      rule_title TEXT NOT NULL,
      description TEXT NOT NULL,
      target_pattern TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
      legal_basis TEXT NOT NULL DEFAULT 'Directive (UE) Allégations Environnementales / Directive 2024/825',
      remediation_advice TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ green_claims_rules table verified');

  // Seed standard rules
  await prisma.$executeRawUnsafe(`
    INSERT INTO green_claims_rules (rule_code, category, rule_title, description, target_pattern, severity, legal_basis, remediation_advice)
    VALUES
      ('GENERIC_ECO_CLAIM', 'prohibited_generic_term', 'Interdiction des allégations génériques vagues', 
       'Les mentions vagues telles que "éco-responsable", "vert", "durable", "ami de la nature" sont interdites sans excellence environnementale certifiée.',
       '(éco-responsable|eco-responsable|vert|green|durable|sustainable|naturel|bon pour la planète|ami de la nature)',
       'critical', 'Directive (UE) 2024/825 Art. 2', 
       'Remplacer par une allégation spécifique et mesurable (ex: "Confectionné avec 98% de coton biologique certifié GOTS").'),

      ('CARBON_NEUTRAL_BAN', 'carbon_neutrality_ban', 'Interdiction des allégations de neutralité carbone basées sur la compensation',
       'Les allégations selon lesquelles un produit a un impact neutre, réduit ou positif sur le climat grâce à des crédits carbone sont interdites.',
       '(neutre en carbone|neutralité carbone|carbon neutral|zéro émission|compensé carbone|climate positive)',
       'critical', 'Directive (UE) 2024/825 Art. 2.2', 
       'Indiquer uniquement l''empreinte carbone réelle mesurée en kg CO2e selon la méthode PEF, sans alléguer la neutralité.'),

      ('ORGANIC_UNSUBSTANTIATED', 'organic_claim_proof', 'Allégation biologique requérant un certificat de transaction valide',
       'Toute allégation mentionnant "biologique", "organic", "bio" doit être étayée par un certificat GOTS ou OCS actif pour la matière concernée.',
       '(bio|biologique|organic)',
       'high', 'Règlement (UE) 2018/848 & Guide DGCCRF', 
       'Rattacher un certificat GOTS ou OCS valide et vérifier que le pourcentage de fibre bio déclaré est supérieur ou égal à 70%.'),

      ('RECYCLED_UNSUBSTANTIATED', 'recycled_content_threshold', 'Allégation recyclée requérant preuve de chaîne de contrôle',
       'Les mentions "recyclé", "fibres recyclées", "rPET" exigent une traçabilité GRS ou RCS prouvant le pourcentage de contenu recyclé pré ou post-consommation.',
       '(recyclé|recycled|rpet|econyl)',
       'high', 'Norme ISO 14021 & Directive Green Claims', 
       'Associer un certificat GRS ou RCS et spécifier le pourcentage exact de matière recyclée dans la composition.'),

      ('BIODEGRADABLE_MISLEADING', 'prohibited_generic_term', 'Allégation de biodégradabilité trompeuse',
       'Revendiquer la biodégradabilité globale d''un vêtement est interdit si certaines composantes (fils, boutons, élasthanne) ne le sont pas en conditions naturelles.',
       '(biodégradable|biodegradable|compostable)',
       'critical', 'Loi AGEC Art. 13 & Directive Green Claims', 
       'Préciser les composants individuels biodégradables et les normes industrielles de référence (ex: EN 13432).')
    ON CONFLICT (rule_code) DO UPDATE SET
      category = EXCLUDED.category,
      rule_title = EXCLUDED.rule_title,
      description = EXCLUDED.description,
      target_pattern = EXCLUDED.target_pattern,
      severity = EXCLUDED.severity,
      legal_basis = EXCLUDED.legal_basis,
      remediation_advice = EXCLUDED.remediation_advice;
  `);
  console.log('✓ green_claims_rules seeded');

  // 2. Table product_green_claims
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS product_green_claims (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
      product_version INTEGER NOT NULL DEFAULT 1,
      brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      claim_text TEXT NOT NULL,
      claim_type TEXT NOT NULL DEFAULT 'product_level' CHECK (claim_type IN ('product_level', 'material_level', 'packaging', 'process')),
      target_subject_id UUID,
      status TEXT NOT NULL DEFAULT 'unsubstantiated' CHECK (status IN ('verified', 'partially_substantiated', 'unsubstantiated', 'prohibited_claim')),
      risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      is_blocking_for_dpp BOOLEAN NOT NULL DEFAULT false,
      supporting_certification_id UUID REFERENCES certifications(id) ON DELETE SET NULL,
      supporting_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
      compliance_explanation TEXT NOT NULL DEFAULT '',
      remediation_suggestion TEXT,
      verified_at TIMESTAMPTZ,
      verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ product_green_claims table verified');

  // 3. Table green_claims_audits
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS green_claims_audits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
      product_version INTEGER NOT NULL DEFAULT 1,
      brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      total_claims_analyzed INTEGER NOT NULL DEFAULT 0,
      verified_claims_count INTEGER NOT NULL DEFAULT 0,
      prohibited_claims_count INTEGER NOT NULL DEFAULT 0,
      unsubstantiated_claims_count INTEGER NOT NULL DEFAULT 0,
      green_claims_score INTEGER NOT NULL DEFAULT 100 CHECK (green_claims_score >= 0 AND green_claims_score <= 100),
      audit_verdict TEXT NOT NULL DEFAULT 'compliant' CHECK (audit_verdict IN ('compliant', 'warning_attention_needed', 'non_compliant_greenwashing_risk')),
      blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
      audit_summary TEXT NOT NULL DEFAULT '',
      audited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      audited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT green_claims_audit_unique UNIQUE (product_id, product_version)
    );
  `);
  console.log('✓ green_claims_audits table verified');

  // 4. Indexes
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_product_green_claims_prod ON product_green_claims(product_id, product_version);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_product_green_claims_org ON product_green_claims(brand_organization_id, status);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_green_claims_audits_prod ON green_claims_audits(product_id, product_version);`);

  // 5. RLS and security
  await prisma.$executeRawUnsafe(`ALTER TABLE green_claims_rules ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE green_claims_rules FORCE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE product_green_claims ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE product_green_claims FORCE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE green_claims_audits ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE green_claims_audits FORCE ROW LEVEL SECURITY;`);

  await prisma.$executeRawUnsafe(`GRANT SELECT ON green_claims_rules TO PUBLIC;`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON product_green_claims TO PUBLIC;`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON green_claims_audits TO PUBLIC;`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS green_claims_rules_select ON green_claims_rules;`);
  await prisma.$executeRawUnsafe(`CREATE POLICY green_claims_rules_select ON green_claims_rules FOR SELECT TO PUBLIC USING (is_active = true);`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS product_claims_select_org ON product_green_claims;`);
  await prisma.$executeRawUnsafe(`CREATE POLICY product_claims_select_org ON product_green_claims FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id));`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS product_claims_mutate_brand ON product_green_claims;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY product_claims_mutate_brand ON product_green_claims
      FOR ALL TO PUBLIC USING (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
      WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS green_claims_audits_select_org ON green_claims_audits;`);
  await prisma.$executeRawUnsafe(`CREATE POLICY green_claims_audits_select_org ON green_claims_audits FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id));`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS green_claims_audits_mutate_brand ON green_claims_audits;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY green_claims_audits_mutate_brand ON green_claims_audits
      FOR ALL TO PUBLIC USING (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
      WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
  `);
  console.log('✓ RLS and security policies enforced');

  // 6. Stored procedure tracefab_audit_product_green_claims
  await prisma.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION tracefab_audit_product_green_claims(p_product_id UUID)
RETURNS green_claims_audits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_claim RECORD;
  v_cert_record RECORD;
  
  v_total_claims INTEGER := 0;
  v_verified_count INTEGER := 0;
  v_prohibited_count INTEGER := 0;
  v_unsubstantiated_count INTEGER := 0;
  v_score INTEGER := 100;
  v_verdict TEXT := 'compliant';
  v_blocking JSONB := '[]'::jsonb;
  v_audit green_claims_audits;
BEGIN
  -- Vérification produit & droits
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'green_claims_product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'green_claims_brand_role_required';
  END IF;

  -- 1. Si aucune allégation déclarée manuellement, analyser la description du produit
  IF NOT EXISTS (SELECT 1 FROM product_green_claims WHERE product_id = p_product_id AND product_version = v_product.version) THEN
    IF v_product.description IS NOT NULL AND length(trim(v_product.description)) > 0 THEN
      DECLARE
        v_desc TEXT := lower(v_product.description);
      BEGIN
        IF v_desc ~* '(bio|biologique|organic)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Fibres Biologiques', 'product_level');
        END IF;

        IF v_desc ~* '(recyclé|recycled|rpet)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Fibres Recyclées', 'product_level');
        END IF;

        IF v_desc ~* '(éco-responsable|durable|vert|naturel)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Vêtement Éco-responsable', 'product_level');
        END IF;

        IF v_desc ~* '(neutre en carbone|zéro émission|compensé)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Neutre en carbone', 'product_level');
        END IF;
      END;
    END IF;
  END IF;

  -- 2. Évaluer chaque allégation du produit
  FOR v_claim IN (
    SELECT * FROM product_green_claims
    WHERE product_id = p_product_id AND product_version = v_product.version
  ) LOOP
    v_total_claims := v_total_claims + 1;
    
    DECLARE
      v_claim_lower TEXT := lower(v_claim.claim_text);
      v_status TEXT := 'unsubstantiated';
      v_risk TEXT := 'medium';
      v_blocking_flag BOOLEAN := false;
      v_explanation TEXT := '';
      v_advice TEXT := '';
      v_cert_id UUID := NULL;
    BEGIN
      -- A. Vérifier si l'allégation contient un terme expressément interdit (neutralité carbone ou terme vague)
      IF v_claim_lower ~* '(neutre en carbone|neutralité carbone|carbon neutral|zéro émission|compensé carbone)' THEN
        v_status := 'prohibited_claim';
        v_risk := 'critical';
        v_blocking_flag := true;
        v_explanation := 'L''allégation de neutralité carbone basée sur la compensation est strictement interdite par la Directive Européenne (UE) 2024/825.';
        v_advice := 'Supprimer l''allégation. Publier l''empreinte carbone brute calculée selon le PEF sans affirmer la neutralité.';
        v_prohibited_count := v_prohibited_count + 1;

      ELSIF v_claim_lower ~* '(éco-responsable|vert|durable|ami de la nature|propre)' THEN
        v_status := 'prohibited_claim';
        v_risk := 'high';
        v_blocking_flag := true;
        v_explanation := 'Les mentions génériques non mesurables sont prohibées sans certification d''excellence environnementale globale (ex: Écolabel Européen).';
        v_advice := 'Remplacer par une assertion précise sur la matière (ex: "Contient 98% de coton biologique certifié").';
        v_prohibited_count := v_prohibited_count + 1;

      -- B. Vérifier si allégation bio étayée par certificat GOTS / OCS
      ELSIF v_claim_lower ~* '(bio|biologique|organic)' THEN
        SELECT id INTO v_cert_record
        FROM certifications
        WHERE (product_id = p_product_id OR owner_organization_id = v_product.brand_organization_id)
          AND standard_code IN ('GOTS', 'OCS', 'GOTS_ORGANIC', 'ORGANIC_100')
          AND status IN ('documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
          AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        LIMIT 1;

        IF FOUND THEN
          v_status := 'verified';
          v_risk := 'low';
          v_cert_id := v_cert_record.id;
          v_explanation := 'Allégation biologique étayée par un certificat valide conforme à la directive Green Claims.';
          v_verified_count := v_verified_count + 1;
        ELSE
          v_status := 'unsubstantiated';
          v_risk := 'high';
          v_blocking_flag := true;
          v_explanation := 'Allégation biologique sans certificat de transaction GOTS ou OCS vérifié.';
          v_advice := 'Téléverser et faire certifier un certificat GOTS valide pour la matière composant ce produit.';
          v_unsubstantiated_count := v_unsubstantiated_count + 1;
        END IF;

      -- C. Vérifier si allégation recyclé étayée par certificat GRS / RCS
      ELSIF v_claim_lower ~* '(recyclé|recycled|rpet)' THEN
        SELECT id INTO v_cert_record
        FROM certifications
        WHERE (product_id = p_product_id OR owner_organization_id = v_product.brand_organization_id)
          AND standard_code IN ('GRS', 'RCS', 'RECYCLED_CLAIM')
          AND status IN ('documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
          AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        LIMIT 1;

        IF FOUND THEN
          v_status := 'verified';
          v_risk := 'low';
          v_cert_id := v_cert_record.id;
          v_explanation := 'Allégation de matière recyclée vérifiée avec chaîne de contrôle conforme GRS.';
          v_verified_count := v_verified_count + 1;
        ELSE
          v_status := 'unsubstantiated';
          v_risk := 'high';
          v_blocking_flag := true;
          v_explanation := 'Mention recyclée non justifiée par un certificat de chaîne de traçabilité (GRS / RCS).';
          v_advice := 'Fournir un certificat GRS attestant du taux exact de fibres recyclées.';
          v_unsubstantiated_count := v_unsubstantiated_count + 1;
        END IF;

      ELSE
        v_status := 'partially_substantiated';
        v_risk := 'medium';
        v_explanation := 'Allégation nécessitant un justificatif probatoire d''audit tiers.';
      END IF;

      UPDATE product_green_claims
      SET status = v_status,
          risk_level = v_risk,
          is_blocking_for_dpp = v_blocking_flag,
          supporting_certification_id = v_cert_id,
          compliance_explanation = v_explanation,
          remediation_suggestion = v_advice,
          verified_at = now(),
          updated_at = now()
      WHERE id = v_claim.id;

      IF v_blocking_flag THEN
        v_blocking := v_blocking || jsonb_build_object(
          'claim_id', v_claim.id,
          'claim_text', v_claim.claim_text,
          'reason', v_explanation,
          'remediation', v_advice
        );
      END IF;
    END;
  END LOOP;

  -- 3. Calcul du Score Global de Conformité
  IF v_total_claims = 0 THEN
    v_score := 100;
    v_verdict := 'compliant';
  ELSE
    v_score := GREATEST(0, 100 - (v_prohibited_count * 40) - (v_unsubstantiated_count * 25));
    IF v_prohibited_count > 0 OR v_score < 50 THEN
      v_verdict := 'non_compliant_greenwashing_risk';
    ELSIF v_unsubstantiated_count > 0 OR v_score < 80 THEN
      v_verdict := 'warning_attention_needed';
    ELSE
      v_verdict := 'compliant';
    END IF;
  END IF;

  -- 4. Enregistrement / Mise à jour dans green_claims_audits
  INSERT INTO green_claims_audits (
    product_id,
    product_version,
    brand_organization_id,
    total_claims_analyzed,
    verified_claims_count,
    prohibited_claims_count,
    unsubstantiated_claims_count,
    green_claims_score,
    audit_verdict,
    blocking_issues,
    audit_summary,
    audited_at
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_product.brand_organization_id,
    v_total_claims,
    v_verified_count,
    v_prohibited_count,
    v_unsubstantiated_count,
    v_score,
    v_verdict,
    v_blocking,
    format('Audit Green Claims : %s allégations (%s vérifiées, %s interdites, %s non étayées). Score : %s/100.', 
           v_total_claims, v_verified_count, v_prohibited_count, v_unsubstantiated_count, v_score),
    now()
  )
  ON CONFLICT (product_id, product_version) DO UPDATE SET
    total_claims_analyzed = EXCLUDED.total_claims_analyzed,
    verified_claims_count = EXCLUDED.verified_claims_count,
    prohibited_claims_count = EXCLUDED.prohibited_claims_count,
    unsubstantiated_claims_count = EXCLUDED.unsubstantiated_claims_count,
    green_claims_score = EXCLUDED.green_claims_score,
    audit_verdict = EXCLUDED.audit_verdict,
    blocking_issues = EXCLUDED.blocking_issues,
    audit_summary = EXCLUDED.audit_summary,
    audited_at = EXCLUDED.audited_at
  RETURNING * INTO v_audit;

  -- 5. Injection dans dpp_records
  UPDATE dpp_records
  SET public_projection = jsonb_set(
    COALESCE(public_projection, '{}'::jsonb),
    '{green_claims_compliance}',
    jsonb_build_object(
      'score', v_audit.green_claims_score,
      'verdict', v_audit.audit_verdict,
      'verified_claims_count', v_audit.verified_claims_count,
      'is_greenwashing_risk', (v_audit.audit_verdict = 'non_compliant_greenwashing_risk'),
      'audited_at', v_audit.audited_at
    ),
    true
  )
  WHERE product_id = p_product_id;

  RETURN v_audit;
END;
$$;
  `);
  console.log('✓ tracefab_audit_product_green_claims stored procedure registered');

  console.log('All Chantier 4 DDL and stored procedures applied successfully to Neon!');
}

run()
  .catch((e) => {
    console.error('Error applying Chantier 4:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
