-- P10.7 follow-up: the BIGINT cast rounds numeric timestamps to nearest second.
-- Flooring is required so a token expiring at now+601 is never accepted as 600.
CREATE OR REPLACE FUNCTION public.tracefab_identite_systeme_jeton_valide(p_jeton text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_corps   TEXT;
  v_mac     TEXT;
  v_parties TEXT[];
  v_candidat TEXT;
  v_valide  BOOLEAN := false;
  v_secret  BYTEA;
  v_exp     BIGINT;
  v_maintenant BIGINT;
  v_attendu BYTEA;
  v_mac_octets BYTEA;
  v_diff    INTEGER := 0;
  v_i       INTEGER;
  -- Plafond de duree de vie, cote VERIFICATEUR et non cote emetteur.
  -- 600 s : l'application emet 60 s ; la marge absorbe une derive d'horloge
  -- entre l'emetteur et la base sans jamais rendre un jeton perenne.
  c_plafond CONSTANT BIGINT := 600;
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

  -- FORME CANONIQUE DU MAC : 64 caracteres, MINUSCULES uniquement.
  --
  -- Ce controle n'est pas cosmetique. La comparaison a temps constant passe par
  -- `decode(v_mac,'hex')`, qui accepte AUSSI les majuscules : sans cette ligne,
  -- `ABC...` et `abc...` designent le meme jeton. Un jeton aurait alors deux
  -- ecritures valides — exactement l'ambiguite de serialisation que le controle
  -- « un seul point » ferme plus haut, reintroduite par la porte de derriere.
  --
  -- MESURE : la premiere version de cette correction acceptait un MAC en
  -- majuscules ; la matrice de test l'a signale avant toute fusion.
  IF v_mac !~ '^[0-9a-f]{64}$' THEN
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
  --
  -- PLAFOND, ET POURQUOI IL EST ICI ET PAS SEULEMENT DANS L'EMETTEUR.
  -- Une premiere version ne comparait `exp` qu'a `now()`. Un corps signe avec
  -- `exp = 999999999999` etait donc ACCEPTE pour ~31 000 ans. Seul un
  -- detenteur de la cle peut produire un tel corps, mais une fuite de cle ou
  -- une erreur d'outillage devenait alors PERMANENTE jusqu'a revocation
  -- manuelle — c'est-a-dire jusqu'a ce que quelqu'un y pense.
  --
  -- MESURE DU 2026-11-06 sur base jetable (70 migrations, cle active) :
  --   exp = now+60     -> true   (attendu)
  --   exp = now+601    -> true   (DEFAUT : aucun plafond)
  --   exp = now+86400  -> true   (DEFAUT)
  --   exp = 999999999999 -> true (DEFAUT : 31 000 ans)
  -- Apres cette correction : les trois derniers rendent `false`.
  --
  -- `now()` est lu UNE fois : deux appels encadrant le controle laisseraient
  -- une fenetre ou la valeur change entre la borne basse et la borne haute.
  v_maintenant := floor(extract(epoch FROM pg_catalog.now()))::BIGINT;
  IF v_parties[4] !~ '^[0-9]{1,12}$' THEN
    RETURN false;
  END IF;
  v_exp := v_parties[4]::BIGINT;
  IF v_exp <= v_maintenant OR v_exp > v_maintenant + c_plafond THEN
    RETURN false;
  END IF;

  -- Toute cle ACTIVE est essayee, sans sortie anticipee : le nombre d'essais ne
  -- depend pas du rang de la cle qui a signe, donc aucune information sur la cle
  -- ne fuit par le temps de reponse. Meme mecanisme que le jeton utilisateur :
  -- la rotation se fait donc sans coupure, et la revocation est immediate.
  FOR v_secret IN
    SELECT k.secret FROM public.tracefab_identity_cles k WHERE k.actif ORDER BY k.version DESC
  LOOP
    v_attendu := public.hmac(pg_catalog.convert_to(v_corps, 'UTF8'), v_secret, 'sha256');
    v_mac_octets := pg_catalog.decode(v_mac, 'hex');
    -- COMPARAISON A TEMPS CONSTANT.
    -- `v_candidat = v_mac` (comparaison de TEXT) s'arrete au premier caractere
    -- different : le temps de reponse depend du prefixe correct, ce qui est un
    -- oracle TEMPOREL. L'absence d'oracle LOGIQUE (la fonction ne rend qu'un
    -- booleen) ne supprime pas cet oracle-la.
    --
    -- On XOR les 32 octets sans sortie anticipee, et on accumule. `decode`
    -- rend NULL si le texte n'est pas de l'hexadecimal valide : on refuse
    -- alors explicitement plutot que de laisser `v_diff` rester a 0.
    IF v_mac_octets IS NULL OR pg_catalog.length(v_mac_octets) <> 32 THEN
      RETURN false;
    END IF;
    -- REMISE A ZERO OBLIGATOIRE A CHAQUE CLE.
    -- `v_diff` est declare une seule fois. Sans cette ligne, l'accumulateur
    -- conserve les bits du tour precedent : des qu'une cle ne correspond pas,
    -- toutes les suivantes sont condamnees, et seule la cle de plus haute
    -- version peut valider. C'est exactement la ROTATION que la migration
    -- promet de preserver (« toute cle ACTIVE est essayee »).
    --
    -- MESURE : c'est le test F de `test:p107:identite-systeme` qui l'a vu —
    -- « pendant le chevauchement, un jeton signe par l ANCIENNE cle est
    -- accepte » a echoue, alors que la nouvelle cle fonctionnait.
    v_diff := 0;
    FOR v_i IN 0..31 LOOP
      v_diff := v_diff | (pg_catalog.get_byte(v_attendu, v_i) # pg_catalog.get_byte(v_mac_octets, v_i));
    END LOOP;
    IF v_diff = 0 THEN
      v_valide := true;
    END IF;
  END LOOP;

  RETURN v_valide;
END
$function$

;

REVOKE ALL ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) FROM PUBLIC;
