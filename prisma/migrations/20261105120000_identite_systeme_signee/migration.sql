-- ============================================================================
-- 20261105120000 — l'ORIGINE d'une operation systeme cesse d'etre supposee
--
-- LE DEFAUT CORRIGE, ET SA MESURE
--
-- Huit fonctions SECURITY DEFINER et quatre fonctions d'outbox ecrivent dans
-- `organizations`, `organization_memberships`, `users` et
-- `tracefab_notification_outbox` sans lire la moindre identite. Elles sont
-- declarees au registre runtime, donc `tracefab_app` a EXECUTE dessus.
--
-- Mesure du 2026-11-05, base jetable dont le proprietaire des objets est un role
-- NON superutilisateur (forme des roles d'administration de Neon), cle HMAC
-- provisionnee, `tracefab_app` sans SUPERUSER, sans BYPASSRLS, sans appartenance
-- atteignable :
--
--   1. l'attaquant obtient un jeton d'identite VALIDE pour SA propre
--      organisation (la chaine HMAC de P10.5 fonctionne : elle n'est pas
--      contournee, elle est constatee) ;
--   2. il appelle
--        SELECT tracefab_sync_clerk_membership('mem_x', <org B>, <lui>, 'owner');
--   3. une adhesion `owner` est ecrite chez B ;
--   4. `tracefab_has_org_role(<org B>, 'owner')` rend `true` ;
--   5. il signe un jeton pour B, que la base accepte legitimement — il est
--      desormais reellement membre — et lit les 2 produits de B ;
--   6. une ligne d'audit `clerk.membership.sync` est ecrite chez B.
--
-- POURQUOI LE JETON D'IDENTITE N'A RIEN VU
--
-- Une identite signee ne protege que les chemins qui la LISENT. Ces fonctions
-- ne la lisent pas : elles ne decident pas « qui appelle », elles DECIDENT qui
-- devient membre. Le controle manquant n'etait pas un controle d'identite, mais
-- un controle d'ORIGINE : qui a le droit de demander une operation systeme ?
--
-- POURQUOI LA PROPRIETE `tracefab_worker` NE SUFFIT PAS
--
-- 20261028120100 a rendu ces fonctions possedees par `tracefab_worker` pour que
-- les politiques RLS `current_user = 'tracefab_worker'` s'ouvrent a elles. Cela
-- repond a « avec QUELLES droits la fonction s'execute », pas a « QUI peut
-- l'appeler ». Un role NOLOGIN reste atteignable par quiconque detient EXECUTE :
-- l'identite de l'executant ne dit rien de l'origine de la demande.
--
-- LA CORRECTION : UNE IDENTITE SYSTEME SIGNEE, VERIFIEE PAR LA BASE
--
--   1. l'application signe une identite SYSTEME — corps
--      `v1|tracefab_system|<identite>|<expiration>`, HMAC-SHA256, meme cle que
--      le jeton utilisateur, donc meme rotation et meme revocation ;
--   2. elle la pose dans `tracefab.identity_systeme` (GUC transactionnel) ;
--   3. la base VERIFIE cette signature dans `tracefab_identite_systeme()`, qui
--      rend `true` ou `false`. Usage different du jeton utilisateur : un jeton
--      emis pour l'un ne vaut pas pour l'autre ;
--   4. chaque operation systeme commence par
--      `IF NOT public.tracefab_identite_systeme() THEN RAISE ... authentication_required`.
--
-- Ce que cela change pour l'attaquant mesure : il lui faut la CLE pour produire
-- un jeton systeme. La cle n'est pas dans la base (`tracefab_app` ne peut pas
-- lire `tracefab_identity_cles` : 42501, mesure P10.5) et le role runtime ne
-- peut rien signer. Le chemin « appel direct de la fonction » se referme.
--
-- Ce que cela NE change PAS, et qui est ecrit pour ne pas etre decouvert plus
-- tard : un detenteur de `TRACEFAB_IDENTITY_KEY` peut emettre un jeton systeme.
-- C'est le propre d'une authentification par secret partage, c'est le meme
-- modele que `TRACEFAB_NOTIFICATION_WORKER_SECRET` pour les routes worker, et
-- c'est incomparablement plus etroit que l'etat anterieur (aucun secret requis).
-- Voir docs/security/2026-11-05-p107-identite-systeme.md § 6.
--
-- ORDRE DE DEPLOIEMENT — IMPORTANT
--
--   ETAPE 1 (cette migration) : les operations systeme ACCEPTENT une identite
--       systeme signee ET l'absence de jeton (mode permissif). L'application
--       peut donc etre deployee avant ou apres sans coupure.
--   ETAPE 2 (ACTE D'EXPLOITATION, pas une migration) :
--       `node scripts/activer_identite_systeme_stricte.mjs --activer` pose
--       `systeme_strict = true` ; l'absence de jeton est alors refusee. Il ne
--       doit etre execute qu'apres avoir mesure
--       `GET /api/internal/p2-readiness` -> `identitySysteme.mode = "signe"` et
--       `identitySysteme.verifiee_par_la_base = true`, et rejoue le webhook
--       Clerk sur l'environnement cible.
--
--       POURQUOI CETTE ETAPE N'EST PAS DANS LA CHAINE DE MIGRATIONS : basculer
--       dans une migration exige une cle ACTIVE, donc un secret, et une base
--       neuve n'en a aucun. Mesure du 2026-11-05 : deux suites du depot
--       (`test:neon:privileges-role-app`, base ephemere) sont tombees en P0001
--       sur la migration qui portait le basculement. Le depot applique deja la
--       regle inverse pour `strict` (identite utilisateur) : « `strict` reste
--       `false` ; le basculement est une decision d'exploitation »
--       (20261102120000). Le mode systeme suit la meme regle.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - elle ne modifie aucune migration anterieure (empreintes intactes) ;
--   - elle ne cree, ne supprime et ne renomme aucune fonction du registre : les
--     noms restent declares, donc `tracefab_apply_runtime_function_grants()`
--     continue de les accorder et le controle « aucun EXECUTE hors registre »
--     reste vrai ;
--   - elle ne transfere aucune propriete ;
--   - elle n'accorde aucun privilege nouveau au runtime : elle lui accorde
--     EXECUTE sur la VERIFICATION, exactement comme pour le jeton utilisateur ;
--   - elle ne touche a aucune donnee metier ;
--   - elle ne cree aucune cle et ne change pas `strict` (mode utilisateur).
--
-- RETOUR ARRIERE
--   `UPDATE public.tracefab_identity_politique SET systeme_strict = false;`
--   par le proprietaire. Une ligne, immediat, sans migration defaite.
-- ============================================================================

-- 1. Le mode, et son emplacement -------------------------------------------
--    Le drapeau vit dans la table de politique existante : une seconde table
--    serait une seconde ACL a defendre, pour un booleen. Il est distinct de
--    `strict` (identite UTILISATEUR) parce que les deux bascules n'ont ni le
--    meme risque ni le meme calendrier : couper l'identite utilisateur en mode
--    strict sans jeton ferme toutes les routes authentifiees, couper l'identite
--    systeme ferme le webhook Clerk et l'outbox. Les coupler obligerait a
--    basculer les deux ensemble, c'est-a-dire a choisir le pire des deux.
ALTER TABLE public.tracefab_identity_politique
  ADD COLUMN IF NOT EXISTS systeme_strict BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tracefab_identity_politique.systeme_strict IS
  'P10.7 : refuse une operation systeme SANS identite systeme signee. false = mode permissif de transition (deploiement en deux temps).';

-- 2. La verification de l'identite systeme ----------------------------------
--    SECURITY DEFINER, possedee par le proprietaire des objets : elle lit
--    `tracefab_identity_cles`, que le runtime ne peut pas lire. C'est la meme
--    asymetrie que pour le jeton utilisateur, et c'est ce qui rend la
--    falsification impossible pour un detenteur des seuls identifiants de la
--    base.
--
--    Elle rend un BOOLEEN, jamais un motif : MAC invalide, jeton expire, usage
--    errone et organisation incoherente rendent tous `false`. Aucun oracle.
--
--    Elle NE SIGNE RIEN et ne rend jamais de MAC : il n'existe aucune fonction
--    accessible au runtime qui produise une signature.
CREATE OR REPLACE FUNCTION public.tracefab_identite_systeme_jeton_valide(p_jeton TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $verif$
DECLARE
  v_corps   TEXT;
  v_mac     TEXT;
  v_parties TEXT[];
  v_candidat TEXT;
  v_valide  BOOLEAN := false;
  v_secret  BYTEA;
BEGIN
  IF p_jeton IS NULL OR p_jeton = '' THEN
    RETURN false;
  END IF;

  -- Forme EXACTE : deux parties, un seul point. `split_part(..., '.', 2)`
  -- suffirait a accepter un jeton a deux points en ignorant silencieusement ce
  -- qui suit : `corps.mac.nimporte_quoi` serait valide, donc le meme jeton
  -- aurait plusieurs ecritures valides. Une serialisation ambiguë est
  -- exactement ce qu'une signature doit interdire (mesure du 2026-11-05 : le
  -- test de forme ambigue etait ACCEPTE tant que ce controle n'existait pas).
  IF array_length(string_to_array(p_jeton, '.'), 1) <> 2 THEN
    RETURN false;
  END IF;
  v_corps := split_part(p_jeton, '.', 1);
  v_mac   := split_part(p_jeton, '.', 2);
  IF v_corps = '' OR v_mac = '' THEN
    RETURN false;
  END IF;

  v_parties := string_to_array(v_corps, '|');

  -- Forme stricte : version v1, usage SYSTEME (jamais l'usage utilisateur).
  IF v_parties IS NULL
     OR array_length(v_parties, 1) <> 4
     OR v_parties[1] <> 'v1'
     OR v_parties[2] <> 'tracefab_system' THEN
    RETURN false;
  END IF;

  -- L'identite designee est FIXE. Un nom libre transformerait le jeton en droit
  -- d'endosser n'importe quel role : ce n'est pas le besoin.
  IF v_parties[3] <> 'tracefab_worker' THEN
    RETURN false;
  END IF;

  -- Expiration : horloge de la BASE, jamais celle de l'appelant.
  IF v_parties[4] !~ '^[0-9]{1,12}$'
     OR v_parties[4]::BIGINT <= extract(epoch FROM pg_catalog.now())::BIGINT THEN
    RETURN false;
  END IF;

  -- Toute cle ACTIVE est essayee, sans sortie anticipee : le nombre d'essais ne
  -- depend pas du rang de la cle qui a signe, donc aucune information sur la cle
  -- ne fuit par le temps de reponse. Meme mecanisme que le jeton utilisateur :
  -- la rotation se fait donc sans coupure, et la revocation est immediate.
  FOR v_secret IN
    SELECT k.secret FROM public.tracefab_identity_cles k WHERE k.actif ORDER BY k.version DESC
  LOOP
    v_candidat := pg_catalog.encode(
      public.hmac(pg_catalog.convert_to(v_corps, 'UTF8'), v_secret, 'sha256'), 'hex');
    IF v_candidat = v_mac THEN
      v_valide := true;
    END IF;
  END LOOP;

  RETURN v_valide;
END
$verif$;

REVOKE ALL ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) FROM PUBLIC;

-- 3. Le predicat utilise par les operations systeme -------------------------
--    SECURITY INVOKER : il ne donne aucun droit qu'il ne possede pas, et il est
--    appele DEPUIS des fonctions SECURITY DEFINER (donc avec leurs droits).
CREATE OR REPLACE FUNCTION public.tracefab_identite_systeme()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $pred$
  SELECT CASE
           -- Jeton present : il est TOUJOURS verifie, y compris en mode
           -- permissif. Un jeton invalide ne retombe jamais sur « pas de jeton ».
           WHEN nullif(current_setting('tracefab.identity_systeme', true), '') IS NOT NULL
             THEN public.tracefab_identite_systeme_jeton_valide(
                    current_setting('tracefab.identity_systeme', true))
           -- Mode strict sans jeton : refus.
           WHEN coalesce((SELECT p.systeme_strict FROM public.tracefab_identity_politique p
                           WHERE p.singleton), false)
             THEN false
           -- Mode permissif sans jeton : etat de transition, MESURE et non
           -- suppose. C'est exactement ce que l'etape 2 de deploiement ferme.
           ELSE true
         END;
$pred$;

REVOKE ALL ON FUNCTION public.tracefab_identite_systeme() FROM PUBLIC;

-- 3 bis. Le worker doit pouvoir evaluer le predicat ------------------------
--    Les operations systeme possedees par `tracefab_worker` sont SECURITY
--    DEFINER : a l'interieur, `current_user` vaut `tracefab_worker`. Le predicat
--    etant SECURITY INVOKER, il est donc evalue avec les droits du WORKER.
--    Sans ce GRANT, `tracefab_notification_outbox_health()` et
--    `tracefab_clerk_organization_uuid()` echouent en
--    « 42501 permission denied for function tracefab_identite_systeme »
--    (mesure : la transaction est avortee et les operations suivantes
--    echouent en 25P02).
--
--    Ce n'est pas un elargissement : le predicat ne rend qu'un booleen, il est
--    deja lisible par le runtime, et le worker n'est pas connectable. C'est le
--    meme raisonnement que le GRANT de verification pose par 20261031120000.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme() TO tracefab_worker';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) TO tracefab_worker';
  END IF;
END
$$;

-- 4. Le registre runtime ----------------------------------------------------
--    SEULE la VERIFICATION entre au registre, et c'est mesure, pas suppose.
--
--    Une premiere version y inscrivait aussi le predicat
--    `tracefab_identite_systeme()`. C'etait faux pour deux raisons, constatees
--    par `test:neon:registre-fonctions` le 2026-11-05 :
--
--      - le registre est une liste de droits du RUNTIME. Le predicat n'est
--        appele que depuis les corps des treize operations, qui sont SECURITY
--        DEFINER : il s'execute donc avec les droits de leur proprietaire
--        (`tracefab_worker`, GRANT en 3 bis). Le runtime n'en a aucun usage ;
--      - l'y inscrire faisait echouer le controle « la base ne declare rien que
--        le module ignore » : le module derive ses noms des appels de `api/` et
--        des politiques, et le predicat n'y figure pas — a juste titre.
--
--    `scripts/lib/derivation_droits_runtime.mjs` porte desormais cette regle en
--    CODE (R6 : le predicat ne doit jamais etre cite par `api/` ni figurer dans
--    une allowlist runtime), donc la correction ne peut pas etre defaite par une
--    migration future sans qu'un test ne le dise.
DO $$
BEGIN
  INSERT INTO public.tracefab_runtime_function_registry (name, registered_by)
  VALUES ('tracefab_identite_systeme_jeton_valide', '20261105120000_identite_systeme_signee')
  ON CONFLICT (name) DO NOTHING;
END
$$;

-- 5. Les gardes d'origine, dans les operations systeme ----------------------
--    Une fonction par ligne, corps d'origine conserve. Ajouter une garde en tete
--    de chaque corps ne peut pas changer le comportement des appelants
--    legitimes : en mode permissif sans jeton, la garde rend `true` et le corps
--    s'execute a l'identique. C'est ce qui rend cette etape deployable seule, et
--    c'est ce qui rend l'etape 2 sure.
DO $gardes$
DECLARE
  GARDE CONSTANT TEXT := 'IF NOT public.tracefab_identite_systeme() THEN RAISE EXCEPTION ''authentication_required'' USING ERRCODE = ''42501'', HINT = ''P10.7 : cette operation systeme exige une identite systeme signee (TRACEFAB_IDENTITY_KEY cote application).''; END IF;';
  cible RECORD;
  def TEXT;
  marqueur TEXT;
  pos_marqueur INTEGER;
  pos_begin INTEGER;
  pos_insertion INTEGER;
  corps TEXT;
  corps_offset INTEGER;
  premier_mot TEXT;
  nouvelle TEXT;
  n INTEGER := 0;
BEGIN
  FOR cible IN
    SELECT p.oid, p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef
       AND p.proname IN (
         'tracefab_sync_clerk_membership',
         'tracefab_sync_clerk_organization',
         'tracefab_revoke_clerk_membership',
         'tracefab_upsert_clerk_user',
         'tracefab_ensure_clerk_user',
         'tracefab_soft_delete_clerk_user',
         'tracefab_archive_clerk_organization',
         'tracefab_clerk_organization_uuid',
         'tracefab_notification_outbox_health',
         'tracefab_claim_notification_outbox',
         'tracefab_complete_notification_outbox',
         'tracefab_enqueue_due_data_request_reminders',
         'tracefab_enqueue_manual_data_request_reminder')
  LOOP
    def := cible.def;

    -- Idempotence : une fonction deja gardee n'est pas gardee deux fois.
    IF position('tracefab_identite_systeme()' IN def) > 0 THEN
      RAISE NOTICE 'P10.7 : % porte deja la garde d''origine', cible.proname;
      CONTINUE;
    END IF;

    -- On refuse de DEVINER ou commence le corps : une heuristique sur le texte
    -- d'une fonction est le raccourci qui reecrit autre chose que ce qu'on croit.
    -- `regexp_match` vit dans `pg_catalog` depuis PostgreSQL 10, mais sa
    -- signature a trois arguments (drapeaux) n'existe que depuis la 15. On passe
    -- donc par `substring(... from ...)`, qui est stable depuis toujours.
    marqueur := (pg_catalog.regexp_match(def, '(?:^|\n)AS \$([A-Za-z_]*)\$'))[1];
    IF marqueur IS NULL THEN
      RAISE EXCEPTION 'P10.7 : marqueur de corps introuvable dans % — migration interrompue plutot que reecriture approximative', cible.proname;
    END IF;
    pos_marqueur := position('AS $' || marqueur || '$' IN def);
    IF pos_marqueur = 0 THEN
      RAISE EXCEPTION 'P10.7 : corps introuvable dans %', cible.proname;
    END IF;

    -- Le corps en expression (LANGUAGE sql) ne peut pas recevoir d'instruction :
    -- ces deux fonctions sont traitees en 5 bis, ou elles sont recreees en
    -- plpgsql avec un corps identique.
    IF def LIKE '%LANGUAGE sql%' THEN
      RAISE NOTICE 'P10.7 : % est en SQL pur, traitee en 5 bis', cible.proname;
      CONTINUE;
    END IF;

    -- Position du bloc d'INSTRUCTIONS. On ne se fie pas a la premiere
    -- occurrence de `BEGIN` / `DECLARE` : le corps peut contenir ces mots dans
    -- un commentaire ou une chaine, et une heuristique sur le texte d'une
    -- fonction est exactement le raccourci qui reecrit autre chose que ce qu'on
    -- croit. On rejoue donc l'analyse du corps apres le marqueur :
    --   - `DECLARE` ne compte que s'il est le PREMIER mot du corps ;
    --   - `BEGIN` ne compte que s'il est en debut de ligne, ce que PostgreSQL
    --     garantit dans la sortie de `pg_get_functiondef`.
    corps := substring(def FROM pos_marqueur + length('AS $' || marqueur || '$'));
    corps_offset := pos_marqueur + length('AS $' || marqueur || '$');

    premier_mot := (pg_catalog.regexp_match(corps, '^[[:space:]]*([A-Za-z]+)'))[1];
    IF premier_mot = 'DECLARE' THEN
      pos_begin := position(E'\nBEGIN' IN corps);
      IF pos_begin = 0 THEN
        RAISE EXCEPTION 'P10.7 : bloc BEGIN introuvable apres DECLARE dans %', cible.proname;
      END IF;
      -- +1 pour passer le saut de ligne, +2 pour passer le mot BEGIN.
      pos_insertion := corps_offset + pos_begin + 1 + 5;
    ELSE
      pos_begin := position('BEGIN' IN corps);
      IF pos_begin = 0 THEN
        RAISE EXCEPTION 'P10.7 : bloc BEGIN introuvable dans %', cible.proname;
      END IF;
      pos_insertion := corps_offset + pos_begin + 5;
    END IF;

    nouvelle := overlay(def PLACING E'\n  ' || GARDE FROM pos_insertion FOR 0);

    EXECUTE nouvelle;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'P10.7 : % operation(s) systeme gardee(s) en plpgsql', n;
END
$gardes$;

-- 5 bis. Les deux fonctions en SQL pur -------------------------------------
--    `tracefab_clerk_organization_uuid` et `tracefab_notification_outbox_health`
--    sont ecrites en SQL (une expression). Leur ajouter une instruction exige soit
--    de les reecrire en plpgsql — ce qui change leur langage, donc leur plan et
--    leur `pg_get_functiondef`, pour un controle qui n'a pas besoin d'elles — soit
--    de les envelopper. On les RECREE en plpgsql, corps identique, garde en tete :
--    le langage n'est pas un contrat public, et une reecriture en plpgsql ne
--    change ni la signature, ni le type de retour, ni les privileges.
CREATE OR REPLACE FUNCTION public.tracefab_clerk_organization_uuid(p_clerk_organization_id TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF NOT public.tracefab_identite_systeme() THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501',
      HINT = 'P10.7 : cette operation systeme exige une identite systeme signee.';
  END IF;
  RETURN (SELECT o.id FROM public.organizations o
           WHERE o.clerk_organization_id = p_clerk_organization_id
           LIMIT 1);
END
$f$;

CREATE OR REPLACE FUNCTION public.tracefab_notification_outbox_health()
RETURNS TABLE (
  pending INTEGER,
  processing INTEGER,
  sent INTEGER,
  failed INTEGER,
  ready INTEGER,
  "staleProcessing" INTEGER,
  exhausted INTEGER,
  "oldestReadyAt" TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF NOT public.tracefab_identite_systeme() THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501',
      HINT = 'P10.7 : cette operation systeme exige une identite systeme signee.';
  END IF;
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE o.status = 'pending')::integer,
    COUNT(*) FILTER (WHERE o.status = 'processing')::integer,
    COUNT(*) FILTER (WHERE o.status = 'sent')::integer,
    COUNT(*) FILTER (WHERE o.status = 'failed')::integer,
    COUNT(*) FILTER (WHERE o.status IN ('pending', 'failed') AND o.available_at <= now() AND o.attempts < 5)::integer,
    COUNT(*) FILTER (WHERE o.status = 'processing' AND o.locked_at < now() - interval '15 minutes')::integer,
    COUNT(*) FILTER (WHERE o.status = 'failed' AND o.attempts >= 5)::integer,
    MIN(o.available_at) FILTER (WHERE o.status IN ('pending', 'failed') AND o.available_at <= now() AND o.attempts < 5)
  FROM public.tracefab_notification_outbox o;
END
$f$;

-- 5 ter. `tracefab_claim_notification_outbox` en plpgsql -------------------
--    Meme raison que 5 bis : corps SQL en expression, aucune instruction
--    possible. Le corps est repris mot pour mot — `FOR UPDATE SKIP LOCKED`,
--    `LEAST/GREATEST`, la borne a 50 — et seule la garde est ajoutee.
--
--    Le `DEFAULT 10` d'origine est CONSERVE : `CREATE OR REPLACE FUNCTION`
--    refuse de retirer un defaut existant (« cannot remove parameter defaults »,
--    mesure) et l'ajouter sans le retirer creerait une surcharge, donc un nom
--    ambigu que `tracefab_apply_runtime_function_grants` refuse. On garde donc la
--    signature exacte, et seule la langue du corps change.
CREATE OR REPLACE FUNCTION public.tracefab_claim_notification_outbox(p_limit INTEGER DEFAULT 10)
RETURNS SETOF public.tracefab_notification_outbox
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF NOT public.tracefab_identite_systeme() THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501',
      HINT = 'P10.7 : cette operation systeme exige une identite systeme signee.';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.id
      FROM public.tracefab_notification_outbox o
     WHERE (
       o.status IN ('pending', 'failed')
       OR (o.status = 'processing' AND o.locked_at < now() - interval '15 minutes')
     )
       AND o.available_at <= now()
       AND o.attempts < 5
     ORDER BY o.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
  )
  UPDATE public.tracefab_notification_outbox o
     SET status = 'processing',
         attempts = o.attempts + 1,
         locked_at = now(),
         updated_at = now()
    FROM candidates
   WHERE o.id = candidates.id
  RETURNING o.*;
END
$f$;

-- 6. La sonde de controle ---------------------------------------------------
--    Un test de non-regression doit pouvoir mesurer ces proprietes en une
--    instruction, sans lire le catalogue ligne par ligne et sans se
--    desynchroniser d'une liste ecrite a la main. Elle ne rend que des booleens
--    et des entiers : aucune donnee metier, aucun secret.
CREATE OR REPLACE FUNCTION public.tracefab_sec_probe_identite_systeme()
RETURNS TABLE (
  operations_systeme_gardees INTEGER,
  operations_systeme_non_gardees INTEGER,
  mode_systeme_strict BOOLEAN,
  runtime_endosse_worker BOOLEAN,
  worker_connectable BOOLEAN,
  runtime_lit_les_cles BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $probe$
  SELECT
    (SELECT count(*)::integer
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND p.proname = ANY (ARRAY[
          'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
          'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
          'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
          'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
          'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
          'tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders',
          'tracefab_enqueue_manual_data_request_reminder'])
        AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%tracefab_identite_systeme()%'),
    (SELECT count(*)::integer
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND p.proname = ANY (ARRAY[
          'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
          'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
          'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
          'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
          'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
          'tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders',
          'tracefab_enqueue_manual_data_request_reminder'])
        AND pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%tracefab_identite_systeme()%'),
    (SELECT coalesce((SELECT p.systeme_strict FROM public.tracefab_identity_politique p WHERE p.singleton), false)),
    (SELECT pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER')),
    (SELECT w.rolcanlogin FROM pg_catalog.pg_roles w WHERE w.rolname = 'tracefab_worker'),
    (SELECT pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'SELECT'));
$probe$;

--    DROIT D'EXECUTION DE LA SONDE : AUCUN POUR LE RUNTIME, ET C'EST DELIBERE.
--
--    Une premiere version accordait EXECUTE a `tracefab_app`, en meme temps
--    qu'elle inscrivait la sonde au registre runtime. C'etait une erreur de
--    conception, mesuree le 2026-11-05 par deux suites du depot :
--
--      - `test:neon:privileges-role-app` exige que l'EXECUTE du runtime soit
--        EXACTEMENT l'union (appels SQL de `api/` + fonctions des politiques
--        RLS + dependances de corps). Une sonde d'EXPLOITATION n'entre dans
--        aucune de ces trois categories : l'y ajouter aurait demande de
--        modifier l'allowlist pour y faire entrer un droit que l'application
--        n'appelle jamais — c'est-a-dire d'affaiblir un controle pour faire
--        passer une migration ;
--      - `test:neon:registre-fonctions` refuse tout GRANT EXECUTE direct a
--        `tracefab_app` par une migration posterieure : le registre existe
--        precisement pour que ces droits se declarent en une seule fois.
--
--    La sonde est donc lisible par le PROPRIETAIRE (la connexion
--    d'exploitation) et par personne d'autre : `REVOKE ALL ... FROM PUBLIC` la
--    ferme, et aucun GRANT ne la rouvre. Ce n'est pas une perte : le role
--    applicatif n'a aucun usage d'une sonde de catalogue, et la readiness
--    mesure ce qui lui est utile par `tracefab_identite_systeme_jeton_valide()`,
--    qui elle reste accordee ci-dessous.
REVOKE ALL ON FUNCTION public.tracefab_sec_probe_identite_systeme() FROM PUBLIC;

-- 6 bis. Ce que le RUNTIME doit pouvoir appeler, et rien de plus -----------
--    La verification du jeton systeme : c'est elle qui rend la readiness
--    mesurable cote runtime (« la base SAIT verifier ce que l'application vient
--    de signer »). Meme choix que pour le jeton utilisateur en 20261031120000 :
--    accorder la VERIFICATION, jamais la production de signature (le runtime ne
--    lit pas les cles : 42501, mesure).
--
--    Ce GRANT est explicite et non pose par `tracefab_apply_runtime_function_grants()`
--    parce que les fonctions de verification dependent de la cle : elles sont
--    creees et accordees par cette migration, au meme titre que la verification
--    du jeton utilisateur en 20261031120000. La source de verite reste le CODE :
--    `scripts/lib/derivation_droits_runtime.mjs` re-derive la liste des droits du
--    runtime depuis les appels SQL de `api/` et depuis les politiques, et refuse
--    (regle R5) une verification accordee sans appel applicatif. Ce n'est donc
--    pas une liste ecrite a la main qui pourrait deriver en silence.
REVOKE ALL ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) TO tracefab_app;

-- 7. Redistribution des droits ---------------------------------------------
--    Appelee APRES le GRANT explicite de 6 bis : la fonction ne touche qu'aux
--    noms qu'elle connait (operations systeme, fonctions de politique), et son
--    controle final « aucun EXECUTE hors registre » porte sur les fonctions de
--    `public` possedees par le proprietaire des migrations ou par le worker. La
--    verification du jeton systeme n'appartient a aucune de ces deux familles :
--    elle garde donc l'octroi explicite de 6 bis, exactement comme la
--    verification du jeton utilisateur en 20261031120000.
DO $$
BEGIN
  IF to_regprocedure('public.tracefab_apply_runtime_function_grants()') IS NOT NULL THEN
    PERFORM public.tracefab_apply_runtime_function_grants();
  END IF;
END
$$;

-- 8. Postconditions ---------------------------------------------------------
--    Une migration qui installe un controle d'origine doit prouver qu'il est
--    present PARTOUT, et qu'il ne casse pas le chemin legitime.
DO $post$
DECLARE
  v_non_gardees TEXT;
  v_mode BOOLEAN;
  v_app_verifie BOOLEAN;
  v_app_predicat BOOLEAN;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_non_gardees
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname = ANY (ARRAY[
       'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
       'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
       'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
       'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
       'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
       'tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders',
       'tracefab_enqueue_manual_data_request_reminder'])
     AND pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%tracefab_identite_systeme()%';
  IF v_non_gardees IS NOT NULL THEN
    RAISE EXCEPTION 'P10.7 : ces operations systeme n''ont pas de garde d''origine : %', v_non_gardees;
  END IF;

  SELECT p.systeme_strict INTO v_mode FROM public.tracefab_identity_politique p WHERE p.singleton;
  IF v_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'P10.7 : systeme_strict devrait valoir false a l''issue de cette migration (deploiement en deux temps)';
  END IF;

  -- Le runtime doit pouvoir VERIFIER (sinon la readiness ne peut rien dire)...
  SELECT pg_catalog.has_function_privilege('tracefab_app',
           'public.tracefab_identite_systeme_jeton_valide(text)', 'EXECUTE') INTO v_app_verifie;
  IF NOT v_app_verifie THEN
    RAISE EXCEPTION 'P10.7 : le runtime ne peut pas verifier une identite systeme';
  END IF;

  -- ... et le PREDICAT, lui, ne doit PAS etre un droit du runtime : il n'est
  -- appele que depuis les corps SECURITY DEFINER, avec les droits de leur
  -- proprietaire. Postcondition INVERSEE, volontairement : une version
  -- anterieure EXIGEAIT ce droit, ce qui elargissait le perimetre sans usage.
  SELECT pg_catalog.has_function_privilege('tracefab_app',
           'public.tracefab_identite_systeme()', 'EXECUTE') INTO v_app_predicat;
  IF v_app_predicat THEN
    RAISE EXCEPTION 'P10.7 : le predicat d''identite systeme est un droit du runtime alors qu''il n''est appele que par les corps SECURITY DEFINER — perimetre elargi sans usage';
  END IF;

  -- ... et il ne doit toujours PAS pouvoir lire les cles : sinon la signature
  -- ne prouve plus rien, l'attaquant pourrait la produire.
  IF pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'SELECT') THEN
    RAISE EXCEPTION 'P10.7 : tracefab_app lit les cles d''identite — la signature ne prouverait rien';
  END IF;
END
$post$;
