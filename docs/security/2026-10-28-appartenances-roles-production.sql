-- TRACEFAB — appartenances de roles en production : LE SENS, LECTURE SEULE.
--
-- Question tranchee ici, et une seule : `tracefab_app` est-il membre de
-- `neondb_owner`, ou `neondb_owner` est-il membre de `tracefab_app` ?
--
-- Pourquoi la question n'est pas cosmetique. Les deux sens portent le meme nom
-- dans le catalogue et n'ont pas du tout le meme effet :
--
--   tracefab_app  -> neondb_owner : l'application heberge les privileges du
--                                   compte fournisseur, ET peut faire
--                                   `SET ROLE neondb_owner`, qui porte
--                                   BYPASSRLS. La RLS est alors neutralisable.
--   neondb_owner  -> tracefab_app : le compte fournisseur recoit les privileges
--                                   de l'application (qu'il possede deja en
--                                   tant que proprietaire). Sans effet pour
--                                   l'application.
--
-- Ce qui a ete MESURE sur un PostgreSQL jetable, et qui corrige l'intuition
-- courante (scripts/test_appartenances_roles.mjs, 16 verifications) :
--
--   * les ATTRIBUTS de role (SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB) ne
--     s'heritent PAS par appartenance ; seuls les PRIVILEGES sur les objets
--     s'heritent. L'appartenance seule ne casse donc pas la RLS ;
--   * c'est `SET ROLE` qui donne BYPASSRLS, et il ne demande ni INHERIT ni
--     ADMIN, seulement l'appartenance ;
--   * `inherit_option = false` coupe l'heritage des privileges mais laisse
--     `SET ROLE` ouvert : ce n'est donc pas un garde-fou suffisant ;
--   * `pg_has_role(x, y, 'MEMBER')` ignore les options d'heritage, alors que
--     `pg_has_role(x, y, 'USAGE')` les respecte. Les deux ensemble disent si
--     l'appartenance existe ET si elle est active.
--
-- Le script est en LECTURE SEULE : catalogue systeme uniquement, aucun SELECT
-- sur une table metier, aucun appel de fonction applicative, aucun SET ROLE.
-- Il s'execute avec n'importe quel role capable de lire `pg_auth_members`,
-- y compris `neondb_owner` lui-meme.
--
-- Mode d'emploi (SQL Editor Neon, branche Primary : c'est la production) :
--   executer les DEUX requetes, une par une, et coller chaque sortie.
--   La sortie est a UNE SEULE COLONNE, prefixee, pour rester comparable.
--   Verifier le nombre de lignes avant de conclure : Q1 rend 3 lignes,
--   Q2 rend 2 lignes. Moins de lignes = lecture incomplete, pas un resultat.

-- =====================================================================
-- NOTE DE VERSION. `admin_option`, `inherit_option` et `set_option` existent
-- depuis PostgreSQL 16. Sur une version anterieure, Q1 et Q2 echouent sur une
-- colonne inconnue : ce n'est pas une absence d'appartenance, c'est une
-- requete inapplicable. Dans ce cas, le repli en fin de fichier suffit a
-- trancher le SENS ; il ne rend pas les options, et le rapport doit le dire.
--
-- Q1 — Les appartenances qui touchent l'application, dans TOUS les sens.
--      Repond a : existe-t-il une arete entre tracefab_app et les comptes
--      fournisseur, et dans quel sens, avec quelles options ?
--
--      ATTENDU : AUTANT DE LIGNES QU'IL EXISTE D'ARETES — donc 0, 1, 2 ou
--      plus. Contrairement a Q2 et Q3, le nombre de lignes n'est PAS fixe ici :
--      `pg_auth_members` n'enumere que les aretes qui existent, jamais les
--      aretes absentes. ZERO LIGNE EST UN RESULTAT, pas une lecture
--      incomplete. (Le script de verification du depot avait d'abord annonce
--      trois lignes : c'etait faux, et une attente fausse sur ce point fait
--      passer un etat sain pour une mesure ratee.)
-- =====================================================================
SELECT format(
         'appartenance|%s|membre_de|%s|admin=%s|inherit=%s|set=%s',
         pg_get_userbyid(am.member),
         pg_get_userbyid(am.roleid),
         am.admin_option,
         am.inherit_option,
         am.set_option
       ) AS ligne
  FROM pg_catalog.pg_auth_members am
 WHERE pg_get_userbyid(am.member) IN ('tracefab_app', 'neondb_owner', 'neon_service')
    OR pg_get_userbyid(am.roleid) IN ('tracefab_app', 'neondb_owner', 'neon_service')
 ORDER BY 1;

-- =====================================================================
-- Q2 — Le verdict, sans interpretation. C'est CETTE requete qui decide.
--
--      `usage` = privileges effectivement herites (respecte inherit_option).
--      `membre` = l'arete existe, quelles que soient les options.
--      `setrole_possible` = l'arete suffit-elle a endosser le role fourni ?
--        Elle suffit quand set_option = true, et aussi quand le membre detient
--        admin_option sur le role fourni (il peut alors s'accorder SET ROLE).
--        Lu par NOM dans pg_auth_members : aucune fonction inventee.
--
--      ATTENDU : 2 lignes, une par sens.
--        ligne "tracefab_app_vers_neondb_owner" : danger si membre=true,
--          quel que soit usage — c'est le chemin SET ROLE.
--        ligne "neondb_owner_vers_tracefab_app" : benin.
--      Si les deux lignes rendent membre=false, aucune arete n'existe et la
--      RLS n'est pas contournable par ce chemin : ecrire NON PROUVE pour le
--      reste (les attributs directs se lisent en Q3 plus bas), jamais PASS.
-- =====================================================================
SELECT format(
         -- Les booleens passent par un CASE : `format('%s', true)` rend `t`,
         -- pas `true`. La sortie doit etre lisible telle quelle par un humain
         -- qui la colle dans un rapport, et comparable sans interpretation.
         'verdict|%s|membre=%s|usage=%s|setrole_possible=%s',
         sens,
         CASE WHEN pg_catalog.pg_has_role(membre, fourni, 'MEMBER')
              THEN 'true' ELSE 'false' END,
         CASE WHEN pg_catalog.pg_has_role(membre, fourni, 'USAGE')
              THEN 'true' ELSE 'false' END,
         -- `set_role_possible` est lu dans le catalogue, par NOM : pas de
         -- fonction inventee, pas de conversion text -> oid implicite.
         CASE WHEN EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members am
             JOIN pg_catalog.pg_roles m ON m.oid = am.member
             JOIN pg_catalog.pg_roles f ON f.oid = am.roleid
            WHERE m.rolname = sens.membre
              AND f.rolname = sens.fourni
              AND (am.set_option OR am.admin_option)
         ) THEN 'true' ELSE 'false' END
       ) AS ligne
  FROM (VALUES
          ('tracefab_app_vers_neondb_owner', 'tracefab_app', 'neondb_owner'),
          ('neondb_owner_vers_tracefab_app', 'neondb_owner', 'tracefab_app')
       ) AS sens(sens, membre, fourni)
 ORDER BY 1;

-- =====================================================================
-- Q3 — Les attributs DIRECTS de l'application (pas ceux d'un role herite).
--      A joindre au verdict : `rolbypassrls` doit rester false sur la ligne
--      `tracefab_app` elle-meme, sinon le probleme n'est pas l'appartenance
--      mais le role applicatif lui-meme.
--      ATTENDU : 3 lignes.
-- =====================================================================
SELECT format(
         'role|%s|super=%s|bypassrls=%s|createrole=%s|createdb=%s|login=%s|inherit=%s',
         r.rolname,
         CASE WHEN r.rolsuper      THEN 'true' ELSE 'false' END,
         CASE WHEN r.rolbypassrls  THEN 'true' ELSE 'false' END,
         CASE WHEN r.rolcreaterole THEN 'true' ELSE 'false' END,
         CASE WHEN r.rolcreatedb   THEN 'true' ELSE 'false' END,
         CASE WHEN r.rolcanlogin   THEN 'true' ELSE 'false' END,
         CASE WHEN r.rolinherit    THEN 'true' ELSE 'false' END
       ) AS ligne
  FROM pg_catalog.pg_roles r
 WHERE r.rolname IN ('tracefab_app', 'neondb_owner', 'neon_service')
 ORDER BY 1;

-- =====================================================================
-- Q4 — L'identite REELLE de la session (et non celle qu'on croit etre).
--      A executer dans la meme session que les requetes applicatives quand on
--      veut prouver sous quelle identite l'application se connecte. Rend une
--      ligne.
-- =====================================================================
SELECT format(
         'session|user=%s|current_user=%s|session_user=%s',
         current_user, current_user, session_user
       ) AS ligne;

-- =====================================================================
-- CE QUE CHAQUE ISSUE AUTORISE A CONCLURE
--
-- Q2 ligne 1, membre=true            -> la RLS est contournable par SET ROLE.
--                                       Corrigence a preparer (REVOKE
--                                       tracefab_app FROM neondb_owner... non :
--                                       REVOKE neondb_owner FROM tracefab_app),
--                                       mais PAS d'execution sans autorisation
--                                       explicite et separee. A documenter en
--                                       remediation.
-- Q2 ligne 1, membre=false           -> l'appartenance dangereuse n'existe pas.
--                                       Ne pas en deduire que le role
--                                       applicatif est sain : Q3 le dit.
-- Q1 vide, Q2 vide                    -> le role ne peut pas lire
--                                       pg_auth_members, ou les roles n'ont pas
--                                       ces noms. Lecture INCOMPLETE : NON
--                                       PROUVE, jamais PASS.
-- Q2 ou Q3 rend moins de lignes que l'attendu (2 et 3) -> lecture partielle.
--                                       Relancer, ne pas conclure. Q1 n'est
--                                       PAS concernee : son compte est le fait
--                                       mesure.
-- Plus de lignes que l'attendu       -> arete ou role supplementaire. La lire,
--                                       la qualifier, ne pas la filtrer.
-- =====================================================================

-- =====================================================================
-- REPLI — PostgreSQL < 16 (pas de set_option / inherit_option).
-- Le sens est tranche par `pg_has_role` et par une jointure sans les options.
-- ATTENDU : 2 lignes. `membre`/`usage` ont le meme sens qu'en Q2.
-- =====================================================================
-- REPLI-SQL-DEBUT
-- SELECT format('verdict-simple|%s|membre=%s|usage=%s',
--          v.sens,
--          pg_catalog.pg_has_role(v.membre, v.fourni, 'MEMBER'),
--          pg_catalog.pg_has_role(v.membre, v.fourni, 'USAGE')) AS ligne
--   FROM (VALUES
--           ('tracefab_app_vers_neondb_owner', 'tracefab_app', 'neondb_owner'),
--           ('neondb_owner_vers_tracefab_app', 'neondb_owner', 'tracefab_app')
--        ) AS v(sens, membre, fourni)
--  ORDER BY 1;
-- REPLI-SQL-FIN
