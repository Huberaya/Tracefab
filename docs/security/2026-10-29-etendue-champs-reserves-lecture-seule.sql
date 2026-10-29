-- TRACEFAB — etendue exacte des champs encore modifiables par `tracefab_app`.
-- Branche `production`, base `neondb`. LECTURE SEULE, IMPOSEE.
--
-- POURQUOI CE SCRIPT
--
-- La lecture du 29/10 a releve deux droits d'ecriture que les correctifs
-- devaient retirer : `documents.status` et `tracefab_products.version`. Deux
-- colonnes nommees ne font pas une etendue. Ce script enumere TOUTES les
-- colonnes sur lesquelles `tracefab_app` detient INSERT ou UPDATE, table par
-- table, y compris les tables que le mandat ne nomme pas mais que les
-- correctifs touchent (`organization_invitations`, `brand_supplier_relationships`).
--
-- MODE LECTURE SEULE, ET POURQUOI IL EST EN TETE DU FICHIER
--
-- La serie precedente a rendu `transaction_read_only = off`. Ce n'est pas une
-- ecriture — aucune n'a ete demandee — mais rien, dans la session, n'empechait
-- qu'une le soit. `BEGIN READ ONLY` refuse toute ecriture au niveau du moteur :
-- si une instruction du script se trompait de nature, la transaction echouerait
-- au lieu de modifier la production. C'est un garde-fou structurel, pas une
-- convention.
--
-- ATTENTION : `BEGIN READ ONLY;` ouvre une transaction. L'editeur SQL de Neon
-- la ferme en fin de script ; si vous collez requete par requete, collez AUSSI
-- le `BEGIN READ ONLY;` initial et le `COMMIT;` final, sinon les requetes
-- suivantes tournent hors transaction (donc hors du mode lecture seule).
--
-- MODE D'EMPLOI
--   1. coller le bloc COMPLET (BEGIN ... COMMIT), pas les requetes isolees ;
--   2. verifier au debut la ligne `session|read_only=on` ;
--   3. comparer le nombre de lignes :
--      Q1 = une ligne par table inventoriee (4 tables, plus `ABSENTE` si l'une
--           manque) ;
--      Q2 = une ligne par colonne EcRIVABLE (donc 0 ligne si tout est ferme) ;
--      Q3 = 1 ligne (verdict) ;
--      Q4 = 1 ligne (verdict worker).

BEGIN READ ONLY;

-- =====================================================================
-- Q0 — Le mode est-il VRAIMENT celui qu'on croit ? En tete, avant tout
--      constat : un script qui se dit en lecture seule et ne l'est pas
--      rend tous les suivants suspects.
--      ATTENDU : 1 ligne, `read_only=on`.
-- =====================================================================
SELECT format('session|read_only=%s|user=%s',
         current_setting('transaction_read_only'),
         current_user) AS ligne;

-- =====================================================================
-- Q1 — Inventaire des quatre tables sensibles.
--      ATTENDU : 4 lignes.
-- =====================================================================
WITH cibles(nom) AS (VALUES
  ('documents'), ('tracefab_products'),
  ('organization_invitations'), ('brand_supplier_relationships')
)
SELECT format('table|%s|%s|proprietaire=%s|nb_colonnes=%s',
         c.nom,
         CASE WHEN cl.oid IS NULL THEN 'ABSENTE' ELSE 'presente' END,
         coalesce(pg_get_userbyid(cl.relowner), '-'),
         coalesce((SELECT count(*)::text FROM information_schema.columns ic
                    WHERE ic.table_schema = 'public' AND ic.table_name = c.nom), '0')
       ) AS ligne
  FROM cibles c
  LEFT JOIN pg_catalog.pg_class cl
         ON cl.relname = c.nom AND cl.relnamespace = 'public'::regnamespace
 ORDER BY 1;

-- =====================================================================
-- Q2 — L'ETENDUE : chaque colonne ou `tracefab_app` peut ecrire.
--      C'est la reponse a « quels champs sont encore modifiables ». Une
--      ligne = une colonne ecrivable. Zero ligne = aucune ecriture.
--
--      ATTENDU APRES CORRECTIF : 0 ligne sur `documents`.
--      ATTENDU APRES CORRECTIF sur `tracefab_products` : les 20 colonnes
--      metier seulement — jamais `version`, `data_completion`,
--      `data_readiness`, `data_ready_at`.
-- =====================================================================
SELECT format('colonne|%s|%s|insert=%s|update=%s',
         ic.table_name,
         ic.column_name,
         CASE WHEN pg_catalog.has_column_privilege('tracefab_app', quote_ident(ic.table_name), quote_ident(ic.column_name), 'INSERT')
              THEN 'oui' ELSE 'non' END,
         CASE WHEN pg_catalog.has_column_privilege('tracefab_app', quote_ident(ic.table_name), quote_ident(ic.column_name), 'UPDATE')
              THEN 'oui' ELSE 'non' END
       ) AS ligne
  FROM information_schema.columns ic
 WHERE ic.table_schema = 'public'
   AND ic.table_name IN ('documents', 'tracefab_products',
                         'organization_invitations', 'brand_supplier_relationships')
   AND (pg_catalog.has_column_privilege('tracefab_app', quote_ident(ic.table_name), quote_ident(ic.column_name), 'INSERT')
     OR pg_catalog.has_column_privilege('tracefab_app', quote_ident(ic.table_name), quote_ident(ic.column_name), 'UPDATE'))
 ORDER BY 1;

-- =====================================================================
-- Q3 — Le verdict sur les DEUX colonnes que la lecture a nommees, plus
--      les champs calcules. C'est cette ligne que l'on cite dans un
--      rapport, pas une lecture au fil de Q2.
--      ATTENDU : 1 ligne. `documents_status=non` et `products_version=non`
--      signifient que les correctifs sont en place.
-- =====================================================================
SELECT format(
         'verdict|documents_status=%s|documents_sha256=%s|products_version=%s|products_data_completion=%s',
         CASE WHEN pg_catalog.has_table_privilege('tracefab_app', 'public.documents', 'UPDATE')
              THEN 'TABLE-OUVERTE'
              ELSE CASE WHEN pg_catalog.has_column_privilege('tracefab_app', 'public.documents', 'status', 'UPDATE')
                        THEN 'oui' ELSE 'non' END END,
         CASE WHEN pg_catalog.has_table_privilege('tracefab_app', 'public.documents', 'UPDATE')
              THEN 'TABLE-OUVERTE'
              ELSE CASE WHEN pg_catalog.has_column_privilege('tracefab_app', 'public.documents', 'sha256', 'UPDATE')
                        THEN 'oui' ELSE 'non' END END,
         CASE WHEN pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_products', 'UPDATE')
              THEN 'TABLE-OUVERTE'
              ELSE CASE WHEN pg_catalog.has_column_privilege('tracefab_app', 'public.tracefab_products', 'version', 'UPDATE')
                        THEN 'oui' ELSE 'non' END END,
         CASE WHEN pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_products', 'UPDATE')
              THEN 'TABLE-OUVERTE'
              ELSE CASE WHEN pg_catalog.has_column_privilege('tracefab_app', 'public.tracefab_products', 'data_completion', 'UPDATE')
                        THEN 'oui' ELSE 'non' END END
       ) AS ligne;

-- =====================================================================
-- Q4 — L'identite worker : les objets REELS du depot, pas ceux d'une
--      liste de noms supposee.
--
--      Les lectures du 29/10 cherchaient `tracefab_worker_context`,
--      `tracefab_set_worker_context`, `tracefab_current_worker_id`,
--      `tracefab_is_worker_context_valid`. Ces quatre noms n'existent dans
--      AUCUNE migration du depot : le correctif n'est pas un jeu de fonctions
--      de contexte. Il consiste en un role `tracefab_worker` NOLOGIN, des
--      politiques indexees sur `current_user`, et six fonctions nommees.
--      Ce sont CES objets que la lecture doit chercher.
--
--      ATTENDU : 1 ligne. `fonctions=6`, `role=present` et
--      `politiques_current_user=11` signifient que 20261028120100 est
--      appliquee. `fonctions=0`, `role=absent` et
--      `politiques_current_user=0` signifient qu'elle ne l'est pas — ce qui est
--      l'etat lu.
-- =====================================================================
SELECT format('worker|role=%s|registre=%s|fonctions=%s|politiques_current_user=%s',
         CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker')
              THEN 'present' ELSE 'absent' END,
         CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = 'tracefab_runtime_function_registry')
              THEN 'present' ELSE 'absent' END,
         (SELECT count(*)::text FROM pg_catalog.pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('tracefab_upsert_clerk_user', 'tracefab_ensure_clerk_user',
                               'tracefab_soft_delete_clerk_user', 'tracefab_clerk_organization_uuid',
                               'tracefab_archive_clerk_organization', 'tracefab_notification_outbox_health')),
         -- `strpos` ET NON `LIKE`, et ce n'est pas un detail de style :
         -- dans un motif LIKE, `_` est un JOKER qui vaut n'importe quel
         -- caractere. `LIKE '%tracefab_worker%'` matche donc
         -- `'tracefab.worker_context'` — c'est-a-dire precisement l'ANCIENNE
         -- forme, celle que le correctif doit avoir remplacee. Le compteur
         -- affichait 11 dans les deux etats et ne distinguait rien. Mesure
         -- faite : la version LIKE rendait 11 sur une base NON corrigee.
         (SELECT count(*)::text FROM pg_catalog.pg_policy
           WHERE strpos(coalesce(pg_catalog.pg_get_expr(polqual, polrelid), ''), 'tracefab_worker') > 0
              OR strpos(coalesce(pg_catalog.pg_get_expr(polwithcheck, polrelid), ''), 'tracefab_worker') > 0)
       ) AS ligne;

-- =====================================================================
-- Q5 — Les quatre noms supposees, verifies explicitement pour lever le
--      doute plutot que de le laisser dans un coin.
--      ATTENDU : 1 ligne, `trouvees=0`.
-- =====================================================================
SELECT format('noms-supposes|trouvees=%s|detail=%s',
         (SELECT count(*)::text FROM pg_catalog.pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('tracefab_worker_context', 'tracefab_set_worker_context',
                               'tracefab_current_worker_id', 'tracefab_is_worker_context_valid')),
         coalesce((SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_catalog.pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace
                      AND p.proname IN ('tracefab_worker_context', 'tracefab_set_worker_context',
                                        'tracefab_current_worker_id', 'tracefab_is_worker_context_valid')),
                  'aucune')
       ) AS ligne;

COMMIT;

-- =====================================================================
-- CE QUE CHAQUE ISSUE AUTORISE A CONCLURE
--
-- Q0 `read_only=off`            -> le COLLAGE n'a pas pris le BEGIN, ou
--                                 l'editeur a ouvert sa propre transaction.
--                                 Relancer le bloc complet : on ne conclut
--                                 rien d'une serie qui n'etait pas en lecture
--                                 seule.
-- Q3 `TABLE-OUVERTE`            -> l'ecriture n'est pas restreinte aux
--                                 colonnes : elle est ouverte a la TABLE.
--                                 C'est plus grave que ce que la lecture du
--                                 29/10 relevait, et le correctif
--                                 20261028130000 n'est pas la seule chose a
--                                 appliquer.
-- Q3 `oui`                      -> le droit de colonne est encore la : le
--                                 correctif correspondant n'est pas applique.
-- Q3 `non` sur les quatre        -> les correctifs sont en place, quelles que
--                                 soient les lignes de Q2.
-- Q2 liste `version` en update=oui ET Q3 `products_version=oui`
--                               -> coherent, correctif absent.
-- Q4 `fonctions=6` et `role=present` -> 20261028120100 appliquee.
-- Q5 `trouvees=0`               -> confirme que les quatre noms de la liste
--                                 initiale ne designent rien dans ce depot :
--                                 ils ne doivent plus servir de critere.
-- =====================================================================
