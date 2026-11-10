-- ============================================================================
-- 20261106120000 — P10.7 : forme canonique et durée de vie bornée du jeton HMAC
--
-- POURQUOI CETTE MIGRATION, ET POURQUOI ELLE EST ADDITIVE
-- ---------------------------------------------------------------------------
-- La chaîne de confiance P10.5/P10.6 est déjà correcte sur l'essentiel :
--   * l'application SIGNE (HMAC-SHA256, `api/_lib/identite-jeton.ts`) ;
--   * la base VÉRIFIE (`tracefab_identity_jeton_utilisateur`, SECURITY
--     DEFINER, `search_path` épinglé, aucune fonction ne rend un MAC) ;
--   * la clé vit dans `public.tracefab_identity_cles`, illisible par
--     `tracefab_app` (mesuré : `has_table_privilege(... 'SELECT') = false`) ;
--   * le corps signé lie l'organisation au GUC `tracefab.active_organization_id`
--     et l'expiration à l'horloge de la BASE ;
--   * `tracefab_current_user_id()` ne retombe JAMAIS sur le GUC brut quand un
--     jeton est présent, et rend NULL en mode strict sans jeton ;
--   * la rotation essaie toutes les clés actives sans sortie anticipée (69e).
--
-- Deux défauts ont été MESURÉS sur PostgreSQL jetable (PGlite 0.5.12,
-- PostgreSQL 18.6, chaîne complète de 70 migrations, clé générée en mémoire),
-- et non déduits d'une lecture de code :
--
--   D1  SÉRIALISATION NON CANONIQUE. `split_part(p_jeton, '.', 1|2)` ignore
--       tout ce qui suit le DEUXIÈME point. Un jeton valide auquel on ajoute
--       `.EXTRA` était ACCEPTÉ et rendait l'identité signée. La chaîne n'était
--       donc pas sans ambiguïté : deux chaînes différentes, une seule preuve.
--       Mesure du 2026-11-06 : `corps.mac.EXTRA` -> identité rendue.
--
--   D2  ABSENCE DE PLAFOND D'EXPIRATION. `exp` était seulement comparé à
--       `now()`. Un corps signé avec `exp = 999999999999` était ACCEPTÉ pour
--       plusieurs dizaines de milliers d'années. Seul le titulaire de la clé
--       peut signer un tel corps, mais une fuite ou une erreur d'outillage
--       devenait alors PERMANENTE jusqu'à révocation manuelle de la clé.
--       Mesure du 2026-11-06 : `exp=999999999999` -> identité rendue.
--
--   D3  COMPARAISON DU MAC NON CONSTANTE. `v_candidat = v_mac` (texte) et
--       `v_mac <> v_attendu` (68e) laissent une différence de temps mesurable
--       selon le premier octet faux. Le commentaire de la 68e affirmait
--       « aucun oracle » ; l'absence d'oracle LOGIQUE ne supprime pas l'oracle
--       TEMPOREL. La correction compare les 32 octets par XOR accumulé, sans
--       sortie anticipée, pour chaque clé active.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS — important pour la revue
--   * elle NE modifie AUCUNE migration déjà appliquée : c'est un nouveau
--     dossier, un `CREATE OR REPLACE` sur une seule fonction existante ;
--   * elle ne change PAS le format `v1|<user>|<org>|tracefab_identity|<exp>` :
--     aucun jeton légitime émis par `signerIdentite()` ne devient invalide ;
--     aucun test P10.5/P10.6/P10.7 n'a à être réécrit ;
--   * elle ne crée NI table, NI rôle, NI politique, NI fonction nouvelles :
--     aucun nom n'entre dans `tracefab_runtime_function_registry`, aucun GRANT
--     n'est posé, `CREATE OR REPLACE` préserve OID, propriétaire et ACL ;
--   * elle ne touche à AUCUNE donnée métier et ne modifie aucun secret ;
--   * elle n'active PAS `tracefab_identity_politique.strict` : la bascule reste
--     un acte d'exploitation distinct, soumis à autorisation humaine ;
--   * elle NE règle PAS le rejeu inter-transactions d'un jeton volé : voir le
--     rapport `docs/security/2026-11-06-p107-rapport-final.md`, risque R1. Un
--     mécanisme anti-rejeu à usage unique casserait les retries HTTP/worker ;
--     il exige une conception v2 liée à `pg_current_xact_id()` validée sur une
--     Preview réelle, ce que cette mission n'a pas pu obtenir. La seule borne
--     ajoutée ici est TEMPORELLE (600 s), jamais « anti-rejeu complet ».
--
-- PLAFOND RETENU : 600 secondes. L'application émet 60 s
-- (`DUREE_JETON_SECONDES`) ; les suites P10.5/P10.6/P10.7 signent à +60 s et
-- +120 s. Dix minutes laissent une marge de 10× sans autoriser un jeton
-- perpétuel. Ce plafond est une propriété du VÉRIFICATEUR, pas de l'émetteur :
-- une application compromise ne peut pas s'accorder une durée de vie plus
-- longue, même avec la clé.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tracefab_identity_jeton_utilisateur(p_jeton TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $verif$
DECLARE
  v_corps       TEXT;
  v_mac         TEXT;
  v_mac_octets  BYTEA;
  v_parties     TEXT[];
  v_secret      BYTEA;
  v_attendu     BYTEA;
  v_diff        INTEGER;
  v_valide      BOOLEAN := false;
  v_org_guc     TEXT;
  v_exp         BIGINT;
  v_maintenant  BIGINT;
  v_i           INTEGER;
BEGIN
  IF p_jeton IS NULL OR p_jeton = '' THEN
    RETURN NULL;
  END IF;

  -- D1 — FORME CANONIQUE : un seul point, exactement 64 chiffres hexadécimaux
  -- en minuscules après lui, et rien d'autre. `split_part` ne peut plus ignorer
  -- une suffixe, et `decode` ne peut plus recevoir une longueur inattendue.
  -- Les corps légitimes ne contiennent aucun point (UUID, org, usage, entier).
  IF p_jeton !~ '^[^.]+\.[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  v_corps      := split_part(p_jeton, '.', 1);
  v_mac        := split_part(p_jeton, '.', 2);
  v_mac_octets := pg_catalog.decode(v_mac, 'hex');
  v_parties    := pg_catalog.string_to_array(v_corps, '|');

  IF v_parties IS NULL
     OR pg_catalog.array_length(v_parties, 1) <> 5
     OR v_parties[1] <> 'v1'
     OR v_parties[4] <> 'tracefab_identity' THEN
    RETURN NULL;
  END IF;

  -- Expiration : 10 chiffres exactement, sans signe, sans zéro initial, sans
  -- padding. D2 : bornée des deux côtés par l'horloge de la BASE.
  IF v_parties[5] !~ '^[1-9][0-9]{9}$' THEN
    RETURN NULL;
  END IF;
  v_exp        := v_parties[5]::BIGINT;
  v_maintenant := extract(epoch FROM pg_catalog.now())::BIGINT;
  IF v_exp <= v_maintenant OR v_exp > v_maintenant + 600 THEN
    RETURN NULL;
  END IF;

  -- Liaison au contexte : l'organisation signée doit être celle de la session.
  -- Un jeton de A ne vaut jamais pour B, même avec la clé.
  v_org_guc := coalesce(
    pg_catalog.current_setting('tracefab.active_organization_id', true), '');
  IF v_parties[3] <> v_org_guc THEN
    RETURN NULL;
  END IF;

  -- D3 — comparaison en temps constant, SANS sortie anticipée, sur TOUTES les
  -- clés actives (rotation sans coupure, 69e migration). Le nombre d'octets
  -- comparés et le nombre de clés essayées ne dépendent ni du MAC fourni ni du
  -- rang de la clé qui a signé.
  FOR v_secret IN
    SELECT k.secret FROM public.tracefab_identity_cles k
     WHERE k.actif
     ORDER BY k.version DESC
  LOOP
    v_attendu := public.hmac(pg_catalog.convert_to(v_corps, 'UTF8'), v_secret, 'sha256');
    v_diff := 0;
    FOR v_i IN 0..31 LOOP
      v_diff := v_diff | (pg_catalog.get_byte(v_attendu, v_i)
                          # pg_catalog.get_byte(v_mac_octets, v_i));
    END LOOP;
    IF v_diff = 0 THEN
      v_valide := true;
    END IF;
  END LOOP;

  IF NOT v_valide THEN
    RETURN NULL;
  END IF;

  -- L'identité vient du CORPS SIGNÉ, jamais d'un GUC. Tous les échecs rendent
  -- le même NULL : aucun oracle sur la cause (MAC, date, organisation, forme).
  IF v_parties[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN v_parties[2]::UUID;
END
$verif$;

-- ---------------------------------------------------------------------------
-- Postconditions : la correction ne doit pas avoir affaibli le vérificateur.
-- `CREATE OR REPLACE` préserve propriétaire et ACL, mais on le MESURE plutôt
-- que de le supposer. Aucun secret, aucune donnée métier lue ici.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_secdef  BOOLEAN;
  v_config  TEXT[];
  v_proprietaire TEXT;
BEGIN
  SELECT p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_secdef, v_config, v_proprietaire
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.tracefab_identity_jeton_utilisateur(text)'::pg_catalog.regprocedure;

  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'P10.7 : la verification des jetons a perdu SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(coalesce(v_config, ARRAY[]::TEXT[])) c
     WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'P10.7 : la verification des jetons a perdu son search_path epingle';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app')
     AND NOT pg_catalog.has_function_privilege(
       'tracefab_app', 'public.tracefab_identity_jeton_utilisateur(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P10.7 : le role applicatif a perdu EXECUTE sur la verification';
  END IF;
END
$$;
