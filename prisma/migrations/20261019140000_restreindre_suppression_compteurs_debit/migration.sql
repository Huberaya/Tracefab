-- Restreindre la suppression des compteurs de débit aux fenêtres expirées.
--
-- RISQUE MESURÉ, pas déduit.
--
-- La migration 20261008100000 pose une politique unique :
--
--     CREATE POLICY rate_limit_counters_global ON rate_limit_counters
--       FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--
-- Le commentaire de cette migration justifie le `USING (true)` : la table n'a
-- pas de locataire, elle est indexée par empreinte client et écrite sur des
-- routes publiques qui n'ont aucun contexte utilisateur armé. Une politique
-- interrogeant tracefab_current_user_id() bloquerait précisément les requêtes
-- que le limiteur doit compter. **Cette justification est valable et elle est
-- conservée pour la lecture, l'insertion et la mise à jour.**
--
-- Elle ne couvre pas la suppression. Reproduit sur base jetable, sous le rôle
-- applicatif, avec des données synthétiques (2 compteurs actifs à 47 et 3
-- coups, 1 compteur expiré) :
--
--     compteurs avant              : 3
--     DELETE FROM rate_limit_counters (sans filtre) : 3 lignes supprimées
--     compteurs après              : 0
--
-- Un attaquant qui compromet le rôle applicatif peut donc remettre à zéro
-- l'état de limitation de débit de tous les clients, et réouvrir la force
-- brute. Les rôles effectivement concernés sont le propriétaire et
-- tracefab_app ; PUBLIC n'a aucun privilège sur cette table.
--
-- BESOIN LÉGITIME, vérifié sur tout le dépôt. Le runtime n'écrit cette table
-- qu'à deux endroits, dans api/_lib/rate-limit.ts :
--
--     :403  INSERT ... ON CONFLICT (bucket_key, window_start)
--           DO UPDATE SET hits = rate_limit_counters.hits + 1 RETURNING hits
--     :415  DELETE FROM rate_limit_counters WHERE expires_at < NOW()
--
-- La suppression légitime ne porte donc QUE sur des fenêtres déjà expirées :
-- c'est le nettoyage opportuniste déclenché une fois sur cinquante environ.
-- Aucune suppression de compteur actif n'est utile à l'application.
--
-- CORRECTION. La politique unique est remplacée par quatre politiques par
-- commande. La lecture, l'insertion et la mise à jour gardent exactement leur
-- portée globale actuelle ; seule la suppression est bornée.
--
-- Aucun objet distant n'est modifié par ce fichier tant qu'il n'est pas
-- appliqué, et rien n'est supprimé qui ne soit remplacé ici même.

-- 1. Remplacer la politique globale par quatre politiques par commande.
DROP POLICY IF EXISTS rate_limit_counters_global ON rate_limit_counters;

DROP POLICY IF EXISTS rate_limit_counters_select ON rate_limit_counters;
CREATE POLICY rate_limit_counters_select ON rate_limit_counters
  FOR SELECT TO PUBLIC
  USING (true);

DROP POLICY IF EXISTS rate_limit_counters_insert ON rate_limit_counters;
CREATE POLICY rate_limit_counters_insert ON rate_limit_counters
  FOR INSERT TO PUBLIC
  WITH CHECK (true);

-- La mise à jour reste globale : le limiteur incrémente le compteur d'une
-- requête anonyme, donc aucune condition tenant à l'utilisateur n'est
-- exprimable. Le risque résiduel — un UPDATE direct ramenant hits à zéro —
-- est couvert par le déclencheur du point 2, parce qu'une clause WITH CHECK
-- ne peut pas comparer NEW à OLD.
DROP POLICY IF EXISTS rate_limit_counters_update ON rate_limit_counters;
CREATE POLICY rate_limit_counters_update ON rate_limit_counters
  FOR UPDATE TO PUBLIC
  USING (true) WITH CHECK (true);

-- La seule restriction nouvelle : on ne peut supprimer qu'une fenêtre déjà
-- expirée. Le nettoyage légitime `WHERE expires_at < NOW()` continue de
-- fonctionner, puisqu'il ne vise que des lignes que cette clause laisse
-- visibles.
DROP POLICY IF EXISTS rate_limit_counters_purge_expiree ON rate_limit_counters;
CREATE POLICY rate_limit_counters_purge_expiree ON rate_limit_counters
  FOR DELETE TO PUBLIC
  USING (expires_at < now());

-- 2. Empêcher la remise à zéro d'un compteur par UPDATE.
--
-- Une clause WITH CHECK ne voit que NEW : elle ne peut donc pas exprimer
-- « hits ne diminue pas ». Un déclencheur BEFORE UPDATE le peut. Il refuse
-- toute diminution de hits et toute suppression déguisée par mise à jour de
-- la fenêtre, qui sont les deux seules façons de neutraliser un compteur sans
-- le supprimer.
--
-- Le chemin légitime — hits = hits + 1 — ne diminue jamais hits et ne change
-- ni bucket_key ni window_start, donc il n'est pas affecté. C'est vérifié par
-- scripts/test_compteurs_debit.mjs, qui échoue si l'incrémentation cesse de
-- fonctionner.
CREATE OR REPLACE FUNCTION tracefab_guard_rate_limit_counter()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.hits < OLD.hits THEN
    RAISE EXCEPTION
      'rate_limit_counter_hits_cannot_decrease (avant=%, apres=%)',
      OLD.hits, NEW.hits
      USING ERRCODE = '42501';
  END IF;

  IF NEW.bucket_key <> OLD.bucket_key
     OR NEW.window_start <> OLD.window_start THEN
    RAISE EXCEPTION
      'rate_limit_counter_identity_is_immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tracefab_rate_limit_counter_guard ON rate_limit_counters;
CREATE TRIGGER tracefab_rate_limit_counter_guard
  BEFORE UPDATE ON rate_limit_counters
  FOR EACH ROW
  EXECUTE FUNCTION tracefab_guard_rate_limit_counter();
