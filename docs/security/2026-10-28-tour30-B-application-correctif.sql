-- TRACEFAB — application du correctif `supplier_portal` en production.
--
-- AUTORISATION : donnee par le proprietaire du depot au tour 30.
-- PREREQUIS  : la confrontation de lecture seule (fichier A) doit avoir ete
--              jouee AVANT. Appliquer un correctif sans savoir a quoi on
--              l'applique, c'est reparer a l'aveugle.
--
-- CE QUE CE SCRIPT FAIT, ET RIEN DE PLUS
--
--   1. identite de la cible (base, role, serveur) — pour ne pas se tromper de base ;
--   2. etat AVANT : la corrective est-elle deja en historique ? la fonction et
--      le declencheur sont-ils dans l'etat attendu ?
--   3. application du fichier de migration, DANS UNE TRANSACTION ;
--   4. quatre sondes de comportement, dans une transaction ANNULEE ;
--   5. etat APRES : declencheur, fonction, privilèges inchanges.
--
-- CE QUE CE SCRIPT NE FAIT PAS
--
--   - il n'ecrit PAS dans `_prisma_migrations`. C'est une regle du depot, et
--     elle a une consequence qu'il faut regarder en face : la migration restera
--     « non appliquee » aux yeux de Prisma. Le prochain `migrate deploy`
--     rejouera donc ce fichier. C'est sans danger **parce qu'il est idempotent**
--     (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS` puis `CREATE`), et c'est
--     verifie par `test:supplier-invitation-corrective` — mais c'est une raison
--     de plus pour que `deploy` reste gele tant que le reste n'est pas qualifie ;
--   - il ne pose aucun `GRANT`/`REVOKE` ;
--   - il ne touche aucune politique RLS, aucune donnee.

\echo '=== 1. Identite de la cible (lecture seule) ==='
SELECT current_database()              AS base,
       current_user                     AS role_courant,
       coalesce(inet_server_addr()::text, 'socket local') AS serveur,
       current_setting('server_version') AS version;

\echo ''
\echo '=== 2. Etat AVANT ==='
SELECT 'historique' AS quoi,
       CASE WHEN EXISTS (SELECT 1 FROM _prisma_migrations
                          WHERE migration_name = '20261028140000_supplier_invitation_owner_relationship_scope')
            THEN 'DEJA PRESENTE — ne pas rejouer a l aveugle'
            ELSE 'absente (attendu)' END AS etat
UNION ALL
SELECT 'fonction', CASE WHEN EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname = 'tracefab_validate_member_invitation_role')
       THEN 'presente' ELSE 'ABSENTE — le declencheur ne peut pas exister' END
UNION ALL
SELECT 'declencheur', CASE WHEN EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger
          WHERE tgname = 'organization_invitations_validate_role')
       THEN 'present' ELSE 'ABSENT' END
UNION ALL
SELECT 'corps — portee de relation', CASE WHEN EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname = 'tracefab_validate_member_invitation_role'
            AND pg_catalog.pg_get_functiondef(p.oid)
                LIKE '%supplier_organization_id%')
       THEN 'correctif deja en place' ELSE 'version anterieure' END;

-- ETAT ATTENDU : historique absent ; fonction et declencheur presents ;
-- « version anterieure ». Tout autre resultat = on s'arrete et on relit.

\echo ''
\echo '=== 3. Application (une transaction) ==='
-- A executer depuis le shell, pour que psql annule TOUT en cas d'erreur :
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 \
--        -f prisma/migrations/20261028140000_supplier_invitation_owner_relationship_scope/migration.sql
--
-- `-1` = une seule transaction. Si une instruction echoue, rien n'est applique :
-- c'est exactement la garantie que les lanceurs hors bande n'offraient pas.
\echo '   (commande a lancer depuis le shell, voir ci-dessus)'

\echo ''
\echo '=== 4. Sondes de comportement — transaction ANNULEE ==='
-- Les sondes inserent puis ANNULENT. Aucune ligne ne reste. Les exceptions sont
-- capturees localement pour que la transaction ne soit pas avortee, et pour que
-- le message obtenu soit lisible.
BEGIN;

DO $sondes$
DECLARE
  v_org      uuid;
  v_autre    uuid;
  v_relation uuid;
  v_cible    uuid;
  v_terminee uuid;
  v_user     uuid;
  v_msg      text;
BEGIN
  -- `invited_by` est NOT NULL : la sonde doit fournir un utilisateur reel, sinon
  -- elle echouerait sur la contrainte avant d'atteindre le declencheur, et ne
  -- prouverait rien.
  SELECT id INTO v_user FROM users LIMIT 1;
  SELECT id INTO v_org FROM organizations LIMIT 1;
  SELECT id INTO v_autre FROM organizations WHERE id <> v_org LIMIT 1;
  SELECT id INTO v_relation FROM brand_supplier_relationships LIMIT 1;

  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE NOTICE 'SONDE IMPOSSIBLE : aucune organisation ou aucun utilisateur en base';
    RETURN;
  END IF;

  -- (a) owner SANS relation : doit rester refuse.
  BEGIN
    INSERT INTO organization_invitations
      (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
    VALUES (v_org, 'sonde-a@exemple.invalid', 'owner', NULL, md5(random()::text), v_user, now() + interval '1 day');
    RAISE NOTICE 'SONDE (a) owner sans relation : ACCEPTE — ECHEC ATTENDU refus';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE NOTICE 'SONDE (a) owner sans relation : refuse — %', v_msg;
  END;

  -- (b) owner avec une relation INEXISTANTE : doit etre refuse par le
  --     declencheur, pas par la cle etrangere (le declencheur tire avant).
  BEGIN
    INSERT INTO organization_invitations
      (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
    VALUES (v_org, 'sonde-b@exemple.invalid', 'owner', gen_random_uuid(), md5(random()::text), v_user, now() + interval '1 day');
    RAISE NOTICE 'SONDE (b) relation inexistante : ACCEPTE — ECHEC';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE NOTICE 'SONDE (b) relation inexistante : refuse — %', v_msg;
  END;

  -- (c) owner avec une relation reelle, presentee depuis une organisation qui
  --     n'est NI la marque NI le fournisseur de cette relation : doit etre
  --     refuse (isolation inter-organisations). C'est le contournement que la
  --     regle du depot laissait ouvert — sans ce refus, un tiers fabrique un
  --     `owner` avec la relation d'autrui.
  IF v_relation IS NOT NULL THEN
    SELECT id INTO v_cible
      FROM organizations
     WHERE id NOT IN (SELECT brand_organization_id FROM brand_supplier_relationships WHERE id = v_relation)
       AND id NOT IN (SELECT supplier_organization_id FROM brand_supplier_relationships WHERE id = v_relation)
     LIMIT 1;
    -- A defaut d'un tiers, la marque elle-meme suffit : elle n'est pas le
    -- fournisseur de sa propre relation, donc c'est deja un mismatch.
    IF v_cible IS NULL THEN
      SELECT brand_organization_id INTO v_cible FROM brand_supplier_relationships WHERE id = v_relation;
    END IF;

    BEGIN
      INSERT INTO organization_invitations
        (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
      VALUES (v_cible, 'sonde-c@exemple.invalid', 'owner', v_relation,
              md5(random()::text), v_user, now() + interval '1 day');
      RAISE NOTICE 'SONDE (c) relation presentee depuis une autre organisation : ACCEPTEE — ECHEC ATTENDU refus';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RAISE NOTICE 'SONDE (c) relation presentee depuis une autre organisation : refuse — %', v_msg;
    END;
  ELSE
    RAISE NOTICE 'SONDE (c) non jouee : aucune relation pour la region';
  END IF;

  -- (e) owner sur une relation TERMINEE : c'est LE comportement qui change.
  --     Avant le correctif, rien ne regarde le statut de la relation, et cette
  --     invitation passe ; apres, elle est refusee. C'est la seule sonde dont
  --     le resultat doit differer avant / apres — si elle ne differe pas, le
  --     correctif n'a pas ete applique.
  BEGIN
    SELECT id INTO v_terminee FROM brand_supplier_relationships
     WHERE status = 'ended' LIMIT 1;
    IF v_terminee IS NULL THEN
      RAISE NOTICE 'SONDE (e) non jouee : aucune relation terminee en base';
    ELSE
      BEGIN
        INSERT INTO organization_invitations
          (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
        SELECT r.supplier_organization_id, 'sonde-e@exemple.invalid', 'owner', r.id,
               md5(random()::text), v_user, now() + interval '1 day'
          FROM brand_supplier_relationships r WHERE r.id = v_terminee;
        RAISE NOTICE 'SONDE (e) relation terminee : ACCEPTEE — correctif ABSENT ou sans effet';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        RAISE NOTICE 'SONDE (e) relation terminee : refuse — % (attendu apres correctif)', v_msg;
      END;
    END IF;
  END;

  -- (d) admin + relation : doit rester ACCEPTE. Le declencheur ne vise que owner.
  IF v_relation IS NOT NULL THEN
    BEGIN
      INSERT INTO organization_invitations
        (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
      VALUES ((SELECT supplier_organization_id FROM brand_supplier_relationships WHERE id = v_relation),
              'sonde-d@exemple.invalid', 'admin', v_relation, md5(random()::text), v_user, now() + interval '1 day');
      RAISE NOTICE 'SONDE (d) admin + relation : accepte (attendu)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RAISE NOTICE 'SONDE (d) admin + relation : refuse — % (attendu : accepte)', v_msg;
    END;
  END IF;
END
$sondes$;

ROLLBACK;
\echo '   transaction annulee : aucune ligne inseree.'

\echo ''
\echo '=== 5. Etat APRES (lecture seule) ==='
SELECT t.tgname                                  AS declencheur,
       p.proname                                 AS fonction,
       p.prosecdef                               AS security_definer,
       coalesce(array_to_string(p.proconfig, ','), '(aucun)') AS search_path,
       t.tgtype::int                             AS portee_tir,
       pg_catalog.pg_get_userbyid(p.proowner)     AS proprietaire,
       coalesce(array_to_string(p.proacl, '|'), '(defaut)')   AS acl
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgname = 'organization_invitations_validate_role';

-- ATTENDU : portee_tir = 23 (BEFORE | INSERT | UPDATE | FOR EACH ROW),
-- security_definer = true, search_path non vide, acl INCHANGEE (aucun GRANT).
