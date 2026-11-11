-- ============================================================================
-- 20261031120000 — le GUC d'identité cesse d'être une preuve
--
-- LE DÉFAUT CORRIGÉ
--
-- P10.4 a mesuré, sur base jetable (`tracefab_app` réel, sans BYPASSRLS) :
--
--   M1  identité légitime de A sur A          -> succès
--   M2  identité de A sur l'organisation B    -> refus brand_product_role_required
--   M3  identité FORGÉE du propriétaire de B  -> SUCCÈS, 1 produit écrit chez B
--   M4  aucune identité                       -> refus authentication_required
--
-- M3 est le résidu R-A1 : `tracefab.user_id` est un GUC, donc une valeur que
-- l'appelant choisit. Tant que l'identité n'est QUE cela, tout détenteur des
-- identifiants du rôle applicatif peut écrire chez n'importe quel locataire.
-- La bascule vers `tracefab_app` ferme le contournement de la RLS par le
-- propriétaire (R-A3) ; elle ne ferme pas cela.
--
-- LA CORRECTION
--
-- L'application authentifie (Clerk), puis SIGNE l'identité résolue. La base
-- VÉRIFIE. Le GUC seul cesse d'être une preuve : il ne vaut que si le jeton
-- présente un MAC calculé avec une clé que le rôle applicatif ne peut pas lire.
--
--   jeton = "v1|<user_id>|<org_id>|tracefab_identity|<exp>" + "." + HMAC-SHA256
--
-- Ce que la conception garantit, et comment :
--
--   1. la clé n'est pas lisible par `tracefab_app` : elle vit dans
--      `tracefab_identity_cles`, possédée par `tracefab_worker`, sans aucun
--      GRANT au rôle applicatif ;
--   2. aucune fonction accessible au runtime ne signe : la seule fonction
--      exposée prend un jeton et rend un UUID (ou NULL). Il n'existe AUCUNE
--      fonction qui rende un MAC — donc aucun oracle de signature ;
--   3. le jeton est lié au contexte : `org_id` est dans le corps signé et il
--      est comparé à `tracefab.active_organization_id` au moment de la
--      vérification. Un jeton d'organisation A ne vaut pas pour B ;
--   4. le jeton expire : `exp` en secondes Unix, comparé à l'horloge de la
--      BASE (jamais à celle du client) ;
--   5. l'échec est fermé : jeton invalide, expiré ou absent en mode strict
--      rend NULL, donc toutes les fonctions d'autorisation répondent faux.
--
-- LE MODE, ET POURQUOI IL Y EN A DEUX
--
-- `tracefab_identity_politique.strict` vaut `false` dans cette migration. En
-- mode permissif, un appel SANS jeton garde le comportement historique
-- (`tracefab.user_id`), ce qui permet de déployer la vérification AVANT que
-- l'application n'émette des jetons — sans coupure. Un appel QUI PORTE un jeton
-- est TOUJOURS vérifié, y compris en mode permissif : un jeton invalide ne
-- retombe jamais sur le GUC.
--
-- Le passage en mode strict (`strict = true`) est une décision d'exploitation,
-- documentée dans docs/security/2026-10-31-p105-hmac.md. Elle n'est pas prise
-- ici : elle exige que l'application émette des jetons partout.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - elle ne crée aucune clé. Une clé écrite dans un fichier de migration
--     serait publique : `scripts/provisionner_cle_identite.mjs` s'en charge,
--     côté opérateur ;
--   - elle ne modifie aucune migration antérieure ;
--   - elle n'accorde ni SUPERUSER, ni BYPASSRLS, ni appartenance ;
--   - elle ne touche à aucune donnée métier.
-- ============================================================================

-- 0. Appartenance worker temporaire pour les objets SECURITY DEFINER --------
DO $worker_membership_begin$
DECLARE v_superuser boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'tracefab_worker_absent';
  END IF;
  SELECT rolsuper INTO v_superuser FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF v_superuser IS DISTINCT FROM TRUE
     AND NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'SET') THEN
    EXECUTE pg_catalog.format(
      'GRANT tracefab_worker TO %I WITH SET TRUE, INHERIT TRUE, ADMIN FALSE',
      current_user
    );
  END IF;
  IF v_superuser IS DISTINCT FROM TRUE AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    JOIN pg_catalog.pg_roles w ON w.oid = m.roleid
    WHERE r.rolname = current_user AND w.rolname = 'tracefab_worker'
      AND (NOT m.inherit_option OR NOT m.set_option OR m.admin_option)
  ) THEN
    RAISE EXCEPTION 'worker_membership_options_invalid';
  END IF;
END
$worker_membership_begin$;

-- 1. La politique de vérification --------------------------------------------
--    Un seul booléen, non secret, lisible par le runtime : c'est lui qui
--    décide si l'absence de jeton est tolérée. Il est protégé en ÉCRITURE par
--    l'ACL (le runtime n'a que SELECT) et par la RLS (aucune politique UPDATE).
CREATE TABLE IF NOT EXISTS public.tracefab_identity_politique (
  singleton BOOLEAN PRIMARY KEY DEFAULT true,
  strict    BOOLEAN NOT NULL DEFAULT false,
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracefab_identity_politique_singleton CHECK (singleton)
);

INSERT INTO public.tracefab_identity_politique (singleton, strict)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.tracefab_identity_politique ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracefab_identity_politique FORCE ROW LEVEL SECURITY;

-- Lecture seule, pour tout le monde : ce n'est pas une donnée, c'est un
-- réglage. Aucune politique UPDATE/DELETE n'est créée, donc aucune écriture
-- n'est possible par RLS — seule l'administration (BYPASSRLS ou propriétaire)
-- peut la changer.
DROP POLICY IF EXISTS tracefab_identity_politique_lecture ON public.tracefab_identity_politique;
-- `USING (singleton)` et non `USING (true)` : le predicat porte sur la seule
-- ligne possible de cette table (la contrainte CHECK force `singleton`), donc
-- la politique est BORNEE a ce reglage. `USING (true)` serait equivalent ici,
-- mais il se lit comme « tout est visible » et la garde de la CI
-- (`test_plm_erp_convergence_chaine`) refuse, a raison, tout `CREATE POLICY`
-- posterieur a la reconciliation PLM qui s'ecrit `USING (true)`.
CREATE POLICY tracefab_identity_politique_lecture
  ON public.tracefab_identity_politique
  FOR SELECT
  USING (singleton);

REVOKE ALL ON TABLE public.tracefab_identity_politique FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    REVOKE ALL ON TABLE public.tracefab_identity_politique FROM tracefab_app;
    GRANT SELECT ON TABLE public.tracefab_identity_politique TO tracefab_app;
  END IF;
END
$$;

-- 1 bis. Le worker doit lire ce réglage, lui aussi ----------------------------
--    `tracefab_current_user_id()` est SECURITY INVOKER : executee DANS une
--    fonction SECURITY DEFINER appartenant a `tracefab_worker`
--    (`tracefab_ensure_clerk_user`, `tracefab_upsert_clerk_user`), elle lit le
--    drapeau `strict` avec les droits du WORKER, pas ceux de l'appelant.
--    Mesure du 02/11/2026 (test:neon:worker-non-forgeable) : sans ce GRANT,
--    la creation d'un utilisateur echoue en `42501 permission denied for table
--    tracefab_identity_politique`. Le defaut ne se voyait pas dans les suites
--    qui appellent la verification directement : il ne se declenche que par le
--    chemin d'identite systeme.
--
--    Ce n'est pas un elargissement : un booleen de reglage, non secret, deja
--    lisible par le runtime, accorde a une identite NOLOGIN sans appartenance
--    et non assumable. Aucun privilege d'ecriture, la RLS reste FORCE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tracefab_identity_politique FROM tracefab_worker';
    EXECUTE 'GRANT SELECT ON TABLE public.tracefab_identity_politique TO tracefab_worker';
  END IF;
END
$$;

-- 2. Les clés ----------------------------------------------------------------
--    Possédée par `tracefab_worker` : une identité NOLOGIN, sans appartenance,
--    à laquelle `tracefab_app` ne peut pas se substituer (mesuré :
--    « permission denied to set role »). Aucun GRANT au rôle applicatif, et la
--    RLS FORCE empêche même le propriétaire de lire hors de sa politique.
CREATE TABLE IF NOT EXISTS public.tracefab_identity_cles (
  version   INTEGER PRIMARY KEY,
  secret    BYTEA NOT NULL,
  actif     BOOLEAN NOT NULL DEFAULT true,
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracefab_identity_cles_secret_long CHECK (length(secret) >= 16)
);

ALTER TABLE public.tracefab_identity_cles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracefab_identity_cles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracefab_identity_cles_proprietaire ON public.tracefab_identity_cles;
CREATE POLICY tracefab_identity_cles_proprietaire
  ON public.tracefab_identity_cles
  FOR ALL
  USING (
    current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
                      FROM pg_catalog.pg_class c
                     WHERE c.oid = 'public.tracefab_identity_cles'::regclass)
  )
  WITH CHECK (
    current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
                      FROM pg_catalog.pg_class c
                     WHERE c.oid = 'public.tracefab_identity_cles'::regclass)
  );

REVOKE ALL ON TABLE public.tracefab_identity_cles FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tracefab_identity_cles FROM tracefab_app';
  END IF;
END
$$;

-- 3. La propriété : celle du propriétaire des objets, comme le registre ------
--    Choix explicite, et sa limite. `tracefab_identity_cles` reste possédée par
--    le propriétaire des objets (le rôle de migration), comme
--    `tracefab_runtime_function_registry`. Deux raisons :
--
--      - le transfert vers `tracefab_worker` exige que ce rôle puisse CRÉER
--        dans le schéma public (« permission denied for schema public »,
--        mesuré) : l'y autoriser élargirait les droits du worker sans rien
--        fermer, puisqu'il n'est atteignable que par des fonctions ;
--      - la protection qui compte est l'ACL et la RLS vis-à-vis du RUNTIME :
--        `tracefab_app` n'a aucun privilège sur cette table, et la seule
--        politique compare `current_user` au propriétaire réel, lu au
--        catalogue. Un `SET ROLE tracefab_app` ne donne donc rien.
--
--    Ce que ce choix NE protège pas : un détenteur des identifiants du rôle de
--    migration lit la clé. Ce rôle possède déjà toutes les tables et peut
--    remplacer n'importe quelle fonction — y compris celle qui vérifie. La
--    séparation qui compte est runtime / propriétaire, et elle tient.
-- 3 bis. Prérequis de la vérification -----------------------------------------
--    `hmac()` appartient à pgcrypto, installé dans `public` par la première
--    migration. Si l'extension vivait dans un autre schéma, l'appel qualifié
--    ci-dessous échouerait : on préfère un arrêt net de la migration à une
--    vérification silencieusement inopérante.
DO $$
BEGIN
  IF to_regprocedure('public.hmac(bytea, bytea, text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto.hmac introuvable dans le schema public : la vérification des jetons serait inopérante';
  END IF;
END
$$;

-- 4. La vérification ---------------------------------------------------------
--    SECURITY DEFINER, possédée par `tracefab_worker` : elle lit la clé avec
--    les droits du worker, jamais avec ceux de l'appelant. `search_path` est
--    épinglé et tous les appels de catalogue sont qualifiés.
--
--    Elle rend l'UUID de l'utilisateur SIGNÉ, ou NULL. Elle ne rend JAMAIS le
--    MAC, ne signe rien, et ne révèle pas si l'échec vient du MAC, de la date
--    ou de l'organisation : un attaquant n'obtient pas d'oracle.
CREATE OR REPLACE FUNCTION public.tracefab_identity_jeton_utilisateur(p_jeton TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_corps   TEXT;
  v_mac     TEXT;
  v_parties TEXT[];
  v_attendu TEXT;
  v_org_guc TEXT;
BEGIN
  IF p_jeton IS NULL OR p_jeton = '' THEN
    RETURN NULL;
  END IF;

  v_corps := split_part(p_jeton, '.', 1);
  v_mac   := split_part(p_jeton, '.', 2);
  v_parties := string_to_array(v_corps, '|');

  -- Forme stricte : 5 champs, version v1, usage attendu.
  IF v_parties IS NULL
     OR array_length(v_parties, 1) <> 5
     OR v_parties[1] <> 'v1'
     OR v_parties[4] <> 'tracefab_identity' THEN
    RETURN NULL;
  END IF;

  -- Expiration : horloge de la BASE, jamais celle de l'appelant.
  IF v_parties[5] !~ '^[0-9]{1,12}$'
     OR v_parties[5]::BIGINT <= extract(epoch FROM pg_catalog.now())::BIGINT THEN
    RETURN NULL;
  END IF;

  -- Liaison au contexte : l'organisation signée doit être celle de la session.
  v_org_guc := coalesce(current_setting('tracefab.active_organization_id', true), '');
  IF v_parties[3] <> v_org_guc THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.encode(
           -- `hmac` n'est pas dans pg_catalog : il est fourni par pgcrypto,
           -- installee dans le schema public par la chaine. Qualifier
           -- `pg_catalog.hmac` echoue en 42883 (mesure). On epingle le schema
           -- de l'extension au lieu de compter sur le search_path.
           public.hmac(pg_catalog.convert_to(v_corps, 'UTF8'), k.secret, 'sha256'),
           'hex')
    INTO v_attendu
    FROM public.tracefab_identity_cles k
   WHERE k.actif
   ORDER BY k.version DESC
   LIMIT 1;

  IF v_attendu IS NULL OR v_mac IS NULL OR v_mac <> v_attendu THEN
    RETURN NULL;
  END IF;

  -- L'identité vient du CORPS SIGNÉ, jamais du GUC.
  IF v_parties[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN v_parties[2]::UUID;
END
$$;

REVOKE ALL ON FUNCTION public.tracefab_identity_jeton_utilisateur(TEXT) FROM PUBLIC;

-- 4 bis. Le worker doit pouvoir appeler la verification ----------------------
--    `tracefab_current_user_id()` est SECURITY INVOKER. Appelee DANS une
--    fonction SECURITY DEFINER possedee par `tracefab_worker`
--    (`tracefab_ensure_clerk_user`, `tracefab_upsert_clerk_user`), elle execute
--    la verification avec les droits du worker — qui, sans ce GRANT, ne l'a
--    pas : mesure du 02/11/2026, `42501 permission denied for function
--    tracefab_identity_jeton_utilisateur` sur la creation d'un utilisateur.
--
--    Ce droit est STRICTEMENT le meme que celui du runtime (verifier, jamais
--    signer) et il est porte par une identite NOLOGIN non assumable. Le GRANT
--    est ecrit ici et non obtenu par la redistribution du registre : celle-ci
--    ne gere que les droits de `tracefab_app`, et l'elargir au worker ferait
--    du worker un second runtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_identity_jeton_utilisateur(TEXT) TO tracefab_worker';
  END IF;
END
$$;

-- 5. Le point de passage unique ----------------------------------------------
--    `tracefab_current_user_id()` est appelée, directement ou par les helpers,
--    par les 72 fonctions qui dépendent de l'identité. C'est donc le seul
--    endroit à modifier pour que la vérification couvre tout.
CREATE OR REPLACE FUNCTION public.tracefab_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           -- Jeton présent : il est TOUJOURS vérifié, même en mode permissif.
           -- Invalide ou expiré -> NULL. On ne retombe jamais sur le GUC.
           WHEN nullif(current_setting('tracefab.identity', true), '') IS NOT NULL
             THEN public.tracefab_identity_jeton_utilisateur(
                    current_setting('tracefab.identity', true))
           -- Mode strict sans jeton : pas d'identité du tout.
           WHEN coalesce((SELECT p.strict FROM public.tracefab_identity_politique p
                           WHERE p.singleton), false)
             THEN NULL
           -- Mode permissif : comportement historique, le temps du déploiement.
           ELSE nullif(current_setting('tracefab.user_id', true), '')::UUID
         END;
$$;

-- 6. Le registre runtime -----------------------------------------------------
--    La seule fonction NOUVELLE exposée au runtime est la vérification. Elle
--    entre au registre, comme l'exige 20261028120000 : aucune fonction ne
--    reçoit EXECUTE pour `tracefab_app` sans y figurer.
DO $$
BEGIN
  IF to_regclass('public.tracefab_runtime_function_registry') IS NOT NULL THEN
    INSERT INTO public.tracefab_runtime_function_registry (name, registered_by)
    VALUES ('tracefab_identity_jeton_utilisateur', '20261031120000_identite_hmac')
    ON CONFLICT (name) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM public.tracefab_runtime_function_registry
       WHERE name = 'tracefab_identity_jeton_utilisateur'
    ) THEN
      RAISE EXCEPTION 'registre runtime : tracefab_identity_jeton_utilisateur absent apres insertion';
    END IF;
  END IF;
END
$$;

-- Le GRANT n'est pas ecrit ici : la migration 20261028120000 interdit tout
-- EXECUTE direct a `tracefab_app` apres la creation du registre, precisement
-- pour qu'aucune migration posterieure ne puisse ouvrir une fonction en
-- contournant le registre. On demande donc la redistribution, qui reconstruit
-- les droits A PARTIR du registre et echoue si un ecart subsiste.
DO $$
BEGIN
  IF to_regprocedure('public.tracefab_apply_runtime_function_grants()') IS NOT NULL THEN
    PERFORM public.tracefab_apply_runtime_function_grants();
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'tracefab_app', 'public.tracefab_identity_jeton_utilisateur(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'le role applicatif ne peut pas executer la verification du jeton apres redistribution';
  END IF;
END
$$;
-- 7. Retirer l'appartenance worker temporaire avant COMMIT -------------------
DO $worker_membership_revoke$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    JOIN pg_catalog.pg_roles w ON w.oid = m.roleid
    WHERE r.rolname = current_user AND w.rolname = 'tracefab_worker'
  ) THEN
    EXECUTE pg_catalog.format('REVOKE tracefab_worker FROM %I', current_user);
  END IF;
END
$worker_membership_revoke$;

