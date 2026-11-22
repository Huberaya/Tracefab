-- ============================================================================
-- P10.7 — RETOUR ARRIERE du mode strict de l'identite SYSTEME
--
-- A executer par le PROPRIETAIRE de la base sur l'environnement concerne, sous
-- autorisation humaine explicite. Ce fichier n'est joue par aucune chaine
-- automatique : une operation qui change un mode de securite se decide, elle ne
-- se declenche pas.
--
-- CE QU'IL FAIT, ET RIEN DE PLUS
--   il remet le mode permissif : une operation systeme SANS jeton redevient
--   acceptee. Il ne touche ni aux cles, ni aux privileges, ni aux fonctions, ni
--   aux donnees metier. Les jetons signes restent acceptes dans les deux modes :
--   le retour arriere ne casse donc pas le chemin legitime, il rouvre seulement
--   l'ancien.
--
-- QUAND L'UTILISER
--   si, apres bascule, le webhook Clerk ou l'outbox de notifications echouent en
--   42501 `authentication_required` — c'est-a-dire si l'application deployee
--   n'emet pas encore de jeton systeme. Le diagnostic est dans
--   docs/security/2026-11-05-p107-identite-systeme.md § 6 (R5).
--
-- DUREE : une instruction, immediate, sans migration defaite.
-- ============================================================================

-- 1. Etat AVANT, pour la trace de l'incident (une ligne, aucun secret).
SELECT systeme_strict, modifie_le FROM public.tracefab_identity_politique WHERE singleton;

-- 2. Le retour arriere.
UPDATE public.tracefab_identity_politique
   SET systeme_strict = false,
       modifie_le = now()
 WHERE singleton;

-- 3. Preuve : le mode doit etre revenu a false, et les treize gardes doivent
--    toujours etre en place — un retour arriere de MODE ne defait pas la
--    correction, il rouvre seulement la transition.
SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton;
SELECT operations_systeme_gardees, operations_systeme_non_gardees, mode_systeme_strict
  FROM public.tracefab_sec_probe_identite_systeme();

-- 4. A verifier ENSUITE, hors SQL : `GET /api/internal/p2-readiness?identity=1`
--    doit rapporter `identitySysteme.mode = "signe"` et
--    `verifiee_par_la_base = true`. Si ce n'est pas le cas, la cause est
--    anterieure au basculement : la cle n'est pas provisionnee, ou l'application
--    n'est pas la revision qui signe le contexte systeme.
