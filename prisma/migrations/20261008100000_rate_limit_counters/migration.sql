-- Compteurs de limitation de debit.
--
-- Fenetre fixe : une ligne par (empreinte client, debut de fenetre). La cle
-- primaire composite rend l'increment atomique via ON CONFLICT DO UPDATE,
-- ce qui est la seule facon d'avoir un plafond juste quand plusieurs
-- instances serverless comptent en parallele.
--
-- `bucket_key` est un HMAC-SHA256 de l'adresse du client : la table ne
-- contient aucune donnee personnelle. Une IPv4 simplement hachee se
-- retrouverait par force brute, il n'y a que quatre milliards de valeurs.

CREATE TABLE rate_limit_counters (
  bucket_key   TEXT NOT NULL,
  window_start TIMESTAMPTZ(6) NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT rate_limit_counters_pkey PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX idx_rate_limit_expires ON rate_limit_counters (expires_at);

-- RLS activee et forcee comme sur toutes les autres tables applicatives.
--
-- La politique est deliberement globale, et c'est le seul cas du schema.
-- Cette table n'a pas de locataire : elle est indexee par empreinte client,
-- pas par organisation, et elle est ecrite sur des routes publiques qui par
-- definition n'ont aucun contexte utilisateur arme. Une politique qui
-- interrogerait tracefab_current_user_id() bloquerait exactement les
-- requetes que le limiteur doit compter.
--
-- On conserve malgre tout ENABLE et FORCE plutot que de laisser la table
-- sans RLS : l'invariant du schema est que chaque table porte une politique
-- explicite et relue. Une table sans RLS se lit comme un oubli ; une
-- politique globale commentee se lit comme une decision.
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters TO PUBLIC;

CREATE POLICY rate_limit_counters_global ON rate_limit_counters
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
