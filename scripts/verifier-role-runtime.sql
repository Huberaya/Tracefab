-- Identifier le role PostgreSQL reellement utilise par le runtime.
-- STRICTEMENT EN LECTURE SEULE : aucune ecriture, aucune creation, aucun
-- privilege modifie, aucune migration. A coller dans l'editeur SQL de Neon,
-- sur la branche pointee par la Preview (pas sur la branche de production).
--
-- Aucune chaine de connexion n'est affichee : seuls le nom du role et deux
-- booleens remontent.

-- 1. Le role de connexion, le role effectif, et les deux proprietes decisives.
SELECT current_user                                                          AS role_de_connexion,
       session_user                                                          AS role_de_session,
       (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)      AS est_superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)      AS contourne_rls;

-- 2. La mesure qui tranche, sans se fier aux proprietes ci-dessus.
--    Un role qui contourne la RLS voit toutes les lignes ; un role soumis a
--    la RLS, sans contexte arme, n'en voit aucune.
SELECT count(*) AS lignes_visibles_sans_contexte FROM tracefab_products;

-- 3. Les deux roles candidats et leur posture, pour separer le role du
--    runtime de celui des migrations.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('neondb_owner', 'tracefab_app')
ORDER BY rolname;
