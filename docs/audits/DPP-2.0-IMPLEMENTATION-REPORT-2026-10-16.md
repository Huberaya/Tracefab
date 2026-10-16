# TRACEFAB — rapport Passeport numérique textile 2.0

## A. Verdict général

**PARTIELLEMENT VALIDÉ** — Les fondations d'un passeport vivant ont été livrées : événements append-only, corrections explicites, niveaux de confiance, publication/retrait transactionnels, historique public en liste blanche et contrôles tenant/rôle. Les assertions statiques et tests existants ciblés passent. La migration n'a pas été appliquée sur une base jetable ni en production ; le parcours PostgreSQL réel et l'interface chronologique restent donc à valider.

## B. État initial

- Départ : branche `arena/ff089d6e-tracefab`, commit `94306b84a62c6148be6b77ddb1d35d1fafc146ed`, répertoire propre.
- `main` local et `origin/main` au même SHA au démarrage.
- PR ouverte pertinente indirectement : #47, tests H1.4/e2e, sans fichiers DPP modifiés.
- Existant : produit/composition/graphe/documents versionnés, readiness DPP, revue, RLS public/tenant, résolution GTIN/slug, DPP public et Wallet.
- Défaut bloquant : la revue s'arrêtait à `ready_to_publish`, alors que la résolution publique exigeait `published`; aucune route de transition vers `published` ni pose/retrait coordonné du slug.
- Défaut produit : aucun registre de cycle de vie compréhensible ni correction événementielle.
- Limite : accès réseau à `binaries.prisma.sh` interdit. `npm ci` a installé les paquets mais le postinstall `prisma generate` a échoué ; typecheck global inexploitable avec un client Prisma non généré.

### Matrice de vérité initiale

| Capacité | État initial | Preuve |
|---|---|---|
| Readiness versionnée | Implémentée, validation incomplète | `api/_routes/products/[productId]/dpp.ts`, `dpp_records`, `tracefab_compute_dpp_readiness` |
| Revue avant publication | Opérationnelle et testée statiquement | `publish-review.ts`, `scripts/test_dpp_chantier4.mjs` |
| Publication publique de bout en bout | Partielle / incohérente | revue → `ready_to_publish`; `tracefab_product_is_public` exige `published` |
| Résolution publique réelle | Implémentée, validation DB disponible mais non exécutée ici | `api/_routes/dpp/[gtin].ts`, `scripts/test_neon_dpp_provenance.mjs` |
| Isolation public/privé | Implémentée, à revalider sur la nouvelle migration | contexte public + RLS + migrations de durcissement |
| Événements de cycle de vie | Absente | aucun modèle/route dédié |
| Corrections sans effacement | Partielle | versions de data points/réponses, mais pas d'historique DPP unifié |
| Preuves reliées | Partielle | documents liés aux données/certificats, pas aux événements DPP |
| IA documentaire | Implémentée, validation opérationnelle externe incomplète | routes `verify-ai`, migrations Document AI |
| Interopérabilité GS1 | Implémentée, validation incomplète | route Digital Link, identifiants, tests locaux/Neon séparés |
| Conformité ESPR | Absente en tant que conformité démontrée | profil annoncé comme readiness, pas exigence juridique finale |

## C. Changements réalisés

| Problème | Solution | Fichiers | Test / résultat |
|---|---|---|---|
| Pas d'historique DPP unifié | table append-only, trigger anti-update/delete, correction par référence | migration `20261016130000...`, schéma Prisma | 20 assertions statiques : PASS |
| Confiance ambiguë | statuts déclaratif → tiers vérifié, permissions renforcées | migration, route events | assertions rôles/statuts : PASS |
| Preuves sans lien événementiel | UUID documents sur événement + contrôle d'appartenance tenant | migration, `events.ts` | assertion anti-cross-tenant : PASS statique |
| Publication impossible | fonction transactionnelle publish/suspend/withdraw | migration, `publication.ts` | assertions transition/retrait : PASS statique |
| Historique public risqué | RLS + `public_summary` volontaire + sélection en liste blanche | migration, route DPP publique | assertion absence de 5 champs privés : PASS |
| Statut `published` mal sérialisé | ajout au type, libellé et normalisation | `api/_lib/dpp.ts` | assertion : PASS |
| Routes absentes | routes events/publication enregistrées avant route générique | `api/index.ts` | `npm run test:routes` : PASS (127/127) |
| Documentation absente | architecture, transitions, sécurité, déploiement | `docs/architecture/18-dynamic-dpp-lifecycle.md` | revue statique |

## D. Passeport dynamique

- Une donnée évolue dans les tables métier existantes ; un événement `data_submitted` ou `data_corrected` en décrit la provenance et la correction.
- `data_corrected` exige `corrects_event_id` vers un événement du même produit.
- Les événements sont insert-only ; un trigger rejette UPDATE/DELETE. Limite documentée : ce n'est pas une immutabilité cryptographique et un propriétaire DB privilégié reste techniquement puissant.
- L'état public change dans une seule transaction : record DPP, slug public, événement et audit.
- Les preuves sont des documents appartenant au tenant, associés explicitement à l'événement.
- Les niveaux de confiance ne sont pas calculés comme un score arbitraire.
- La vue publique ne sélectionne que type, dates, niveau de validation et résumé explicitement public.
- Exécuté : tests statiques et tests de registre de routes/readiness. Non exécuté : migration sur PostgreSQL et scénario E2E DB.

## E. Sécurité

Contrôles livrés :

- RLS activée et forcée ;
- privilèges d'écriture directs révoqués ;
- fonctions SECURITY DEFINER avec `search_path=public`, contrôles produit/tenant/rôle ;
- preuve obligatoirement détenue par l'organisation du produit ;
- statuts élevés réservés aux rôles de contrôle ;
- publication réservée owner/admin/manager ;
- historique public en liste blanche ; événements rejetés non publiés ;
- audit des transitions ;
- limites d'entrée, maximum 50 preuves et 200 événements retournés.

Risques ouverts : politiques et fonctions non exécutées sur PostgreSQL jetable ; délai cache public maximal de 60 secondes après retrait ; pas d'antivirus ajouté ; intervention d'un propriétaire DB non cryptographiquement empêchée.

## F. Tests et CI

Commit testé : état de travail précédant le commit final, puis vérifications finales à reporter dans l'historique Git.

| Commande | Résultat | Limite |
|---|---|---|
| `node scripts/test_dynamic_dpp_lifecycle.mjs` | PASS, 20 assertions | statique, pas PostgreSQL |
| `npm run test:routes` | PASS, 127 routes/fichiers | registre statique |
| `npm run test:dpp:chantier4` | PASS | une partie simule l'algorithme |
| `npm run schema:static` | PASS | validation structurelle historique |
| `npm ci` | ÉCHEC postinstall | téléchargement Prisma interdit par politique réseau |
| `npm run api:typecheck` | NON VALIDÉ | client Prisma non généré ; nombreuses erreurs globales dérivées |
| `prisma validate` | NON VALIDÉ | binaire Prisma indisponible |

Aucune CI n'est déclarée verte pour le SHA final tant qu'elle n'est pas observable.

## G. Intégration Git

- Branche : `arena/ff089d6e-tracefab` uniquement.
- Aucun changement de `main`, aucun merge, aucun déploiement, aucune migration de production.
- PR #47 examinée : pas de conflit de fichiers DPP anticipé.
- La compatibilité SQL réelle avec `main` reste à prouver par base jetable et CI.

## H. Dépendances externes

| Besoin | Raison | Action | Responsable | Test de levée |
|---|---|---|---|---|
| Accès aux binaires Prisma ou cache CI | génération/typecheck | exécuter dans CI habituelle | mainteneur CI | `npm ci && npm run build` |
| PostgreSQL jetable avec migrations | valider RLS/fonctions/transactions | déployer la migration hors production | mainteneur DB/CI | scénario E2E tenant/public |
| Configuration Clerk de test | handlers authentifiés | utiliser secrets CI existants, jamais les partager | mainteneur CI | appels API par rôles |

## I. Limites restantes

- Pas d'interface chronologique dans la page publique ou la console.
- Pas de notification de changement.
- Pas de granularité lot/unité au-delà des métadonnées d'événement.
- Pas de signature numérique des événements ou preuves.
- Pas de purge/invalidation CDN active au retrait.
- Pas de conformité à un standard revendiquée ; GS1 et ESPR nécessitent une analyse officielle/versionnée séparée.
- Pas de test de concurrence ni de panne DB exécuté sur ce lot.
- Pas de métriques persistées. Définitions proposées : couverture provenance = champs publiés avec source / champs publiés ; couverture preuve = affirmations avec preuve valide / affirmations ; délai publication = `published.recorded_at - data_submitted.recorded_at`; événements rejetés = compte statut `rejected`; tous calculés depuis les tables réelles, jamais depuis des valeurs de démonstration.

## J. Prochaine étape

**Créer et exécuter dans la CI une épreuve PostgreSQL jetable du parcours complet** : deux tenants, création/ready/revue/publication, événement documenté, correction, lecture publique en liste blanche, tentative cross-tenant, suspension, puis vérification que l'URL publique ne résout plus et que l'historique privé est conservé.
