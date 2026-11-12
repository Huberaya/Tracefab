/**
 * LA LISTE FERMEE DES MIGRATIONS QUI EXIGENT UN BAIL `tracefab_worker`.
 *
 * POURQUOI ELLE EST ICI ET PLUS DANS LE RUNNER
 *
 * Six migrations testent l'appartenance `tracefab_worker` de `current_user`
 * avant de transferer ou de modifier des objets proteges par ce role. Un
 * migrateur non membre ne peut pas s'accorder lui-meme ce droit : le runner
 * l'accorde depuis la connexion administrative, DANS la transaction de la
 * migration, puis le revoque avant COMMIT.
 *
 * Cette liste etait definie dans `scripts/migrer_fidelement.mjs`, qui est un
 * SCRIPT (effets de bord au chargement) : aucun autre outil ne pouvait la lire
 * sans l'executer. Les bancs qui appliquent la chaine « comme le runner » —
 * `scripts/test_privileges_role_app.mjs` le fait transaction par transaction
 * pour pouvoir intercaler ses mesures d'ACL — devaient donc soit recopier la
 * liste (deux definitions qui divergent, mesuree le 2026-11-12 : la suite
 * echouait sur `worker_membership_must_be_managed_by_runner` en pleine chaine,
 * avec 8 assertions vertes sur 8 et une migration en echec), soit contourner
 * la garde. Une seule definition, importable, rend la seconde option inutile.
 *
 * La liste est CLOSE et limitee aux migrations MESUREES. Toute migration qui
 * exige le bail sans y figurer echoue bruyamment (`worker_membership_must_be_
 * managed_by_runner`) : c'est le comportement voulu, la garde du runner reste
 * fermee par defaut. Ajouter une migration ici est une decision explicite.
 */

export const MIGRATIONS_AVEC_WORKER_TEMPORAIRE = Object.freeze([
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261031120000_identite_hmac_liee_au_contexte',
  '20261105235900_active_tenant_policy_and_worker_closure',
  '20261108120100_worker_fonctions_systeme_completes',
  '20261108120200_corrections_p106_ownership_et_appartenance',
]);

const ENSEMBLE = new Set(MIGRATIONS_AVEC_WORKER_TEMPORAIRE);

/** Vrai si cette migration exige le bail worker dans sa transaction. */
export function exigeBailWorker(nom) {
  return ENSEMBLE.has(String(nom));
}
