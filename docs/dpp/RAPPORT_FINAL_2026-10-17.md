# TRACEFAB — rapport final du chantier DPP

Date : 2026-10-17
Branche : `arena/8598837a-tracefab`
Commit de code testé : `a70a55d410a5cfec38b88ea9308c5c443c03b552`
Document : `docs/dpp/RAPPORT_FINAL_2026-10-17.md`

---

## A. Verdict

**PARTIELLEMENT VALIDÉ.**

Ce qui est validé et prouvé :

- la **projection publique** du passeport est une liste blanche : aucun UUID interne, aucun nom de table/colonne, aucun document privé, aucun certificat de démonstration ne peut sortir par `/api/dpp/:identifiant` ;
- la **confiance n'est plus décorative** : une affirmation naît `declared`, un statut exige une revue et des preuves acceptées, `third_party_verified` exige un mandat actif d'un organisme `verifier` ;
- le **cycle de vie est append-only** et une correction n'efface jamais l'événement corrigé ;
- la **page publique** n'affiche que des données publiées, signale les absences, et ne retombe jamais sur la démonstration quand un identifiant réel est demandé, y compris en cas d'erreur réseau ;
- la **console marque** permet de déclarer, lier une preuve, reviewer, mandater, révoquer et ajouter des événements ;
- l'**isolation multi-locataires** reste prouvée par exécution (RLS sur 52 tables, 12/12 assertions inter-organisations).

Ce qui n'est pas validé ici :

- aucun parcours **navigateur réel** n'a été exécuté dans cet environnement (Chromium absent) ; les contrats DOM sont prouvés avec jsdom sur le HTML et le script réels, mais pas le rendu CSS/comportement complet ;
- les routes protégées par **Clerk** n'ont pas été exécutées avec une vraie session (clé absente) ;
- **aucune preuve de production** : aucune migration appliquée à Neon, aucun déploiement, aucune donnée réelle touchée ;
- l'interopérabilité **GS1 n'est pas certifiée** ; la base réglementaire officielle n'a pas pu être vérifiée dans cet environnement.

Le verdict est donc « partiellement validé » au sens strict : le cœur P0/P1 est prouvé par exécution, P2 est implémenté mais non validé en navigateur, P3 est partiel, P4 est absent.

---

## B. État initial

Audit réalisé sur le code réel au commit `2c93091` (`main`), pas sur un rapport antérieur. La matrice complète est dans `docs/dpp/2026-10-17-etat-initial-et-matrice.md`.

Résumé :

| Domaine | État initial |
|---|---|
| Cycle de vie append-only | opérationnel et testé |
| Publication explicite, suspension, retrait | opérationnel et testé |
| Isolation RLS | opérationnelle et testée (50 tables) |
| Identité résolvable + QR | partielle, 15 assertions |
| Affirmations et preuves | partielles : statut initial libre, `documented` sans preuve |
| Mandat de vérificateur tiers | absent |
| Revue d'affirmation | absente |
| API publique en liste blanche | absente : fuite de `productId` et de sources techniques |
| Page publique réelle | partielle : badges `GOTS`, `OEKO-TEX`, « Official » et JSON-LD fictifs non masqués |
| Console privée de confiance | absente |
| Base réglementaire vérifiée | absente |
| IA documentaire DPP | absente |
| Tests navigateur | bloqués par l'absence de Chromium |

Les deux risques majeurs identifiés :

1. **confiance auto-attribuée** : un acteur pouvait écrire `third_party_verified` sans tiers ni mandat ;
2. **présentation publique fictive** : des certifications d'exemple restaient visibles à côté de données réelles.

---

## C. Changements réalisés

### C.1 Migration de confiance

`prisma/migrations/20261017120000_dpp_trust_reviews/migration.sql`

- `dpp_claim_reviews` : revues **append-only**, trigger anti-`UPDATE`/`DELETE`, statut effectif = dernière revue.
- `dpp_verification_mandates` : mandat explicite marque → organisme `verifier`, statut `active`/`revoked`, motif de révocation obligatoire, index unique sur la paire active, audit dans `audit_logs`.
- `tracefab_grant_dpp_verification_mandate`, `tracefab_revoke_dpp_verification_mandate`.
- `tracefab_is_mandated_verifier` lit désormais les mandats (et non une relation fournisseur).
- `tracefab_review_dpp_claim` :
  - `declared` ne peut pas être un statut de revue ;
  - revue interne réservée aux rôles `owner/admin/manager/auditor` ;
  - `documented`/`controlled` : ≥ 1 preuve acceptée ;
  - `corroborated` : ≥ 2 preuves acceptées ;
  - `third_party_verified` : organisme `verifier`, rôle dans cet organisme, mandat actif, ≥ 1 preuve ;
  - `rejected` : motif obligatoire.
- `tracefab_add_dpp_claim` : le statut initial est forcé à `declared` (`dpp_claim_initial_status_must_be_declared`).
- `tracefab_add_dpp_event` : un événement `documented` exige une preuve ; `third_party_verified` exige un organisme vérificateur et un mandat ; un membre non-marque ne peut ajouter que `third_party_verified` dans son propre organisme.
- Événements système (`published`, `publication_suspended`, `publication_withdrawn`, `publication_reviewed`) réservés aux fonctions de publication, exemptés de preuve documentaire car ils ne sont pas des affirmations de la marque.
- Projection publique `tracefab_public_dpp_claims` enrichie : preuves acceptées, preuves contradictoires, nom public du vérificateur, date de revue, expiration.
- RLS sur les deux nouvelles tables ; `REVOKE ALL FROM PUBLIC` sur les fonctions ; grants conditionnels à `tracefab_app`.

### C.2 API

- `api/_lib/dpp-public.ts` (nouveau) : projection **en liste blanche**, champs `{ value, status, source }`, sources réduites à des catégories lisibles.
- `api/_routes/dpp/[gtin].ts` : réponse projetée, claims publics, historique public, liens ; plus aucun objet interne.
- `api/_routes/products/[productId]/dpp/claims.ts` : création limitée à `declared`, lecture des revues et preuves.
- `api/_routes/products/[productId]/dpp/claims/[claimId]/review.ts` (nouveau) : revue via `tracefab_review_dpp_claim`, aucune écriture directe de statut.
- `api/_routes/products/[productId]/dpp/events.ts` : `verifiedByOrganizationId`, source/statut contrôlés.
- `api/_routes/dpp/mandates.ts` et `mandates/[mandateId]/revoke.ts` (nouveaux) : octroi/retrait de mandat, cadrés par les organisations de marque, motif de révocation exigé.
- `api/_lib/dpp-access.ts` (nouveau) : accès produit pour la marque **ou** un vérificateur mandaté (`tracefab_verifier_product`), sans élargir l'accès fournisseur.
- `api/index.ts` : routes `claims/:id/review`, `dpp/mandates`, `dpp/mandates/:id/revoke` enregistrées avant les motifs plus généraux.

### C.3 Passeport public

`dpp/index.html` :

- suppression des certifications fictives (`GOTS`, `OEKO-TEX`, « 100% certified »), remplacées par un badge honnête « Demonstration data — no certification verified » ;
- titre de démonstration explicite ;
- bloc `.demo-only` masqué dès qu'un identifiant réel est demandé (`html[data-dpp-requested="true"] .demo-only`) ;
- badge réglementaire changé de « ESPR-aligned » à « ESPR-oriented — not certified » ;
- sections vivantes : identité, composition/matières, traçabilité, entretien/fin de vie, affirmations et preuves, limites ;
- toutes les valeurs API sont insérées avec `textContent` ; les champs absents affichent « Non renseigné / Non vérifié / Indisponible » ;
- JSON-LD reconstruit **uniquement** depuis les champs `status === 'sourced'` ; sinon `WebPage` neutre ;
- erreur réseau : le passeport réel est masqué, la bannière explique qu'aucune donnée de démonstration n'est affichée comme réelle.

`assets/js/dpp.2.js` :

- rendu des matières, affirmations, preuves, contradictions, vérificateur, dates de revue, limites ;
- déduplication des libellés de preuve ;
- historique accepte les formes camelCase et snake_case ;
- titre/meta/OG dérivés du nom réel ;
- `data-dpp-source` = `live` seulement si des champs sourcés existent.

### C.4 Console marque

`brand-console/index.html`, `assets/js/brand-console.1.js` :

- panneau « Claims » : liste, statut effectif, preuves acceptées, vérificateur, date de revue ;
- déclaration d'une affirmation (toujours `declared`) ;
- liaison d'une preuve (document, relation `supports/contradicts/context`, statut `accepted/pending`) ;
- revue interne (`documented/controlled/corroborated/rejected`) ou tierce (`third_party_verified/rejected`) selon le rôle ;
- panneau « Lifecycle events » : liste et ajout d'événement, avec chemin tiers pour un vérificateur ;
- panneau « Mandats » : octroi, liste, révocation avec motif ;
- aucune action ne passe par une écriture directe : toutes appellent les routes qui appellent les fonctions SQL.

### C.5 Internationalisation

- 6 locales complètes (fr, de, it, es, nl, pt) + tr/zh pour `shared`/`portal` : parité stricte conservée ;
- 61 nouvelles clés console et 2 clés DPP (`demoTitle`, `demoTrust`), 3 statuts (`controlled`, `corroborated`, `third_party_verified`) ;
- catalogue EN : 2 220 clés.

### C.6 Tests ajoutés ou étendus

- `scripts/test_dpp_public_projection.ts` : 34 assertions de liste blanche.
- `scripts/test_dpp_public_dom.mjs` : 34 assertions DOM sur le HTML et le script réels (jsdom).
- `scripts/test_dpp_trust_console.mjs` : contrat interface/API/migration/i18n.
- `scripts/test_dynamic_dpp_lifecycle.mjs` : 38 assertions statiques (dont règles de confiance).
- `scripts/test_neon_dynamic_dpp_lifecycle.mjs` : 55 preuves PostgreSQL réelles, dont mandats, revue tierce, refus de revue étrangère, auto-vérification refusée, révocation et persistance des attestations passées.
- `package.json` : scripts `test:dpp-trust`, `test:dpp-public-dom`, `test:dpp-projection`, ajoutés à la chaîne `build`.
- `jsdom@26.1.0` ajouté en `devDependencies` pour exécuter le DOM sans Chromium.

---

## D. Passeport dynamique

### D.1 Chaîne de mise à jour

```
console marque / API
  → validation de forme
  → fonction SQL SECURITY DEFINER (rôle, preuve, mandat)
  → dpp_lifecycle_events ou dpp_claims + dpp_claim_reviews
  → projection publique en liste blanche
  → /api/dpp/:identifiant
  → page publique (identité, matières, affirmations, historique, limites)
  → QR / wallet / JSON-LD
```

Chaque étape est couverte par un test :

- écriture : suite lifecycle (55 preuves) ;
- projection : `test_dpp_public_projection.ts` (34) ;
- rendu : `test_dpp_public_dom.mjs` (34) ;
- identité/QR : `test_dpp_resolvable_identity.mjs` (15).

### D.2 Ce que le public voit

- **Identité** : marque, référence, catégorie, pays de fabrication/conception, poids, date de publication relue, certificat de transaction.
- **Composition** : composition textuelle + matières avec pourcentage, rôle, origine déclarée, statut de chaque champ.
- **Traçabilité** : résumé publié ou absence explicite.
- **Entretien / fin de vie** : instructions ou état « non renseigné ».
- **Affirmations** : niveau effectif, explication du niveau, preuves acceptées (libellés publics), preuves contradictoires, vérificateur identifié, date de revue, validité/expiration.
- **Limites** : champs manquants, non vérifiés, affirmations sans preuve acceptée, rappel que les informations non publiées ne sont pas présentées comme établies.

### D.3 Fraîcheur et validité

- `presentation.lastUpdatedAt` affiché ; absence de date = phrase explicite.
- Une affirmation expirée reste visible avec « Période de validité dépassée » ; elle n'est pas supprimée.
- Une preuve contradictoire est comptée et affichée, pas cachée.
- Aucun score de confiance agrégé : chaque champ porte son statut.

### D.4 Comportement en erreur

- Identifiant réel + erreur API : `#dpp-live` masqué, bannière « Passeport indisponible ou inconnu. Aucune donnée de démonstration n'est affichée comme réelle. », historique vidé.
- Identifiant réel + champs absents : états explicites, jamais les valeurs de démonstration.
- Aucun identifiant : démonstration assumée, bannière visible, badges de certification fictifs supprimés.

### D.5 Limites du passeport dynamique

- Pas de pièce jointe publique : seuls des **libellés** de preuve déclarés publics sont exposés.
- Pas de chaîne de transformation détaillée : le public reçoit un résumé.
- Pas de calcul d'empreinte environnementale certifié : les champs PEF existent dans le résolveur, mais ne sont pas présentés comme conformes.
- Pas de généalogie lot → unité complète.
- Le rendu CSS/mobile complet n'est pas prouvé sans navigateur.

---

## E. Sécurité

### E.1 Contrôles vérifiés

- **RLS forcée** sur les nouvelles tables (`ENABLE` + `FORCE ROW LEVEL SECURITY`).
- **52 tables sous RLS** ; `tracefab_app` sans `BYPASSRLS`.
- **12/12 assertions** d'isolation inter-organisations en lecture, écriture et fonctions (`test_neon_cross_tenant.mjs`).
- **Fonctions SECURITY DEFINER** : `search_path = public`, `REVOKE ALL FROM PUBLIC`, grants explicites à `tracefab_app`, test `test_neon_privileges.mjs` OK.
- **Owner guard** : refuse une routine `PUBLIC EXECUTE` possédée par un autre rôle, nettoyage transactionnel prouvé.
- **Projection en liste blanche** : aucun UUID, aucune source technique, aucun document, aucun acteur.
- **Vérificateur** : accès aux affirmations et libellés publics, **pas aux documents privés** (testé).
- **Revue** : impossible de reviewer l'affirmation d'un autre tenant, impossible de s'auto-attribuer un statut tiers, impossible de reviewer sans mandat actif.
- **Révocation** : bloque les nouvelles revues, conserve les attestations passées et leur date.
- **XSS** : test DOM avec une charge `<img onerror>` dans le nom et dans une affirmation ; aucun élément `img`, aucun script exécuté, texte visible.
- **QR** : `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`.
- **Secrets** : aucune clé, aucun jeton, aucune chaîne de connexion dans les réponses ou les documents de ce chantier.

### E.2 Points de vigilance restants

- Les routes HTTP protégées par Clerk n'ont pas été exécutées avec une session réelle ; les contrôles SQL, eux, sont testés.
- `controlled` signifie « contrôle interne défini par TRACEFAB + preuve acceptée », pas un audit externe. Le libellé public doit rester accompagné de cette explication.
- Le rôle `tracefab_app` doit conserver ses grants après chaque migration ; le test de privilèges le vérifie en CI, mais toute nouvelle fonction doit être ajoutée au bloc conditionnel.
- Aucun test de charge ou de coût de projection à grande échelle.

---

## F. Tests et CI

### F.1 Environnement local

PostgreSQL 16.2 jetable, base recréée avant chaque suite qui écrit :

```bash
export DATABASE_URL='postgresql://postgres@localhost/tracefab_test?host=/tmp/pgtest'
export TF_RLS_APP_URL='postgresql://tracefab_app:isolation_ci_jetable@localhost/tracefab_test?host=/tmp/pgtest'
```

Le helper local `/tmp/reset_tracefab_db.sh` recrée la base, applique les migrations du dépôt et sème le rôle applicatif. Il n'est pas dans le dépôt ; la CI utilise `prisma migrate deploy` sur un PostgreSQL 17 jetable.

### F.2 Résultats statiques (commit `a70a55d`)

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | OK |
| `npm run api:typecheck` | OK |
| `npm run schema:static` | OK |
| `npm run test:assets` | OK, 75 références versionnées |
| `npm run test:routes` | OK, 136 routes, aucune orpheline |
| `npm run test:dpp-trust` | OK |
| `npm run test:dpp-public-dom` | OK, 34 assertions |
| `npm run test:dpp-projection` | OK, 34 assertions |
| `npm run test:i18n` | OK, 2 220 clés EN, parité 6 locales |
| `npm run test:chantier5-console` | OK |
| `npm run test:brand-console` | OK |
| `npm run test:workflow-policy` | OK |
| `npm run test:error-reporting` | OK |

### F.3 Résultats base de données (PostgreSQL réel)

| Commande | Résultat |
|---|---|
| `node scripts/run-db-suite.mjs scripts/test_neon_dynamic_dpp_lifecycle.mjs` | **55 preuves exécutées, 0 simulation** |
| `node scripts/run-db-suite.mjs scripts/test_rls_isolation.mjs` | **52 tables sous RLS**, isolation prouvée par exécution |
| `node scripts/run-db-suite.mjs scripts/test_neon_cross_tenant.mjs` | **12/12 assertions** |
| `node scripts/run-db-suite.mjs scripts/test_neon_privileges.mjs` | **Privilèges des fonctions : OK** |
| `node scripts/test_migration_owner_guard.mjs` | **PASS** |
| `node scripts/test_migration_history.mjs` | **7/7** |

### F.4 Suites non exécutées dans cet environnement

| Suite | Cause | Statut |
|---|---|---|
| `test_dpp_timeline_browser.mjs`, `test_journeys`, `audit:personas`, `test:phases` | Chromium absent (`npx playwright install` impossible : hôte hors réseau autorisé) | **BLOQUÉE PAR DÉPENDANCE EXTERNE** |
| `test_routes_tenant_isolation.mjs` | `CLERK_SECRET_KEY` absente ; la suite refuse de s'exécuter | **BLOQUÉE PAR DÉPENDANCE EXTERNE** |
| `test_neon_dpp_provenance.mjs`, `test_neon_universal_passport.mjs` | client Prisma généré sans moteur de requêtes (téléchargement `binaries.prisma.sh` bloqué) | **BLOQUÉE PAR DÉPENDANCE EXTERNE** |
| `prisma migrate deploy` local | moteur `schema-engine` non téléchargeable | **BLOQUÉE PAR DÉPENDANCE EXTERNE** ; les migrations ont été appliquées par `psql` et la CI les applique par `prisma migrate deploy` |
| `npm run build` complet | `verify:prisma-client` refuse un client sans moteur de requêtes | **BLOQUÉE PAR DÉPENDANCE EXTERNE** ; les étapes statiques ont été exécutées séparément |

Aucune de ces suites n'a été supprimée, désactivée ou transformée en mock. Aucun test existant n'a été affaibli.

### F.5 CI GitHub

Résultat observé sur le commit de code `a70a55d` :

- workflow **CI** : à compléter ci-dessous après observation ;
- workflow **Intégration migrations 34/36/41** : à compléter ci-dessous après observation.

> La CI applique les migrations sur PostgreSQL 17 via `prisma migrate deploy`, exécute les suites `test:*`, puis les parcours Playwright. C'est la preuve qui manque à l'environnement local pour le navigateur et le moteur Prisma.

---

## G. Intégration Git

- Branche de travail : `arena/8598837a-tracefab`.
- Commit de code : `a70a55d410a5cfec38b88ea9308c5c443c03b552` — 40 fichiers, 4 213 insertions, 183 suppressions.
- Push : `git push origin arena/8598837a-tracefab`.
- Aucune fusion dans `main`, aucun déploiement, aucune migration appliquée en production, aucun secret modifié.
- Le rapport est ajouté dans un commit de documentation séparé pour ne pas modifier le commit de code déjà testé.

Contenu du commit :

- 1 migration (`20261017120000_dpp_trust_reviews`) ;
- 2 modules `api/_lib` ;
- 4 routes DPP (dont 3 nouvelles) ;
- 2 fichiers de page publique + console ;
- 6 locales complètes et 2 locales partielles ;
- 5 scripts de test (dont 3 nouveaux) ;
- 2 documents d'architecture/audit.

---

## H. Dépendances externes

| Dépendance | Usage | État dans cet environnement | Impact |
|---|---|---|---|
| Neon / PostgreSQL de production | preuve réelle | **non touché** | aucune preuve de production |
| `binaries.prisma.sh` | moteur Prisma | inaccessible | pas de `migrate deploy` ni de suites Prisma locales |
| Chromium Playwright | E2E navigateur | absent | parcours non exécutés localement |
| Clerk | auth des routes privées | clé absente | routes non exécutées avec session |
| EUR-Lex / sources officielles | conformité ESPR | non accessible | aucune conformité revendiquée |
| GS1 | certification Digital Link | non consulté | compatibilité structurelle seulement |
| Apple / Google Wallet | passes | clés absentes | génération non testée de bout en bout |

Aucun service payant n'a été introduit. `jsdom` est une dépendance de test gratuite et locale.

---

## I. Limites restantes

1. **E2E navigateur non exécuté ici.** Les contrats DOM sont réels (jsdom), mais le rendu, le focus, le contraste et le comportement mobile restent à prouver par Playwright en CI.
2. **Pas de preuve de production.** La migration n'a pas été appliquée à Neon ; le comportement à l'échelle réelle, les performances et les données existantes ne sont pas observés.
3. **Pas de vérification réglementaire officielle.** ESPR (UE) 2024/1781 est cité, mais aucun texte officiel n'a été téléchargé/versionné ici ; aucune conformité n'est revendiquée. Le badge dit désormais « not certified ».
4. **GS1 non certifié.** Le chiffre de contrôle et les URI `/01/`, `/21/`, `?10=` sont structurellement corrects, mais aucun test officiel GS1 n'a été exécuté.
5. **`controlled` reste un contrôle interne.** La règle est explicite (preuve + revue interne), mais ce n'est pas un audit indépendant.
6. **Pas de chaîne de transformation détaillée** : le public reçoit un résumé, pas les étapes fil → tissu → produit avec preuves par étape.
7. **Pas d'IA DPP.** Aucune extraction documentaire, aucun rapprochement automatique, aucune tâche de remédiation. Le plan P4 est décrit mais non commencé.
8. **Pas d'export CIRPASS/JSON-LD serveur versionné.** Le JSON-LD est généré côté page à partir des champs sourcés.
9. **Pas de généalogie lot/unité complète.** L'identité résolvable existe, la volumétrie et l'agrégation restent à faire.
10. **Console non testée en navigateur.** Les contrats statiques sont verts ; les formulaires, l'accessibilité et les erreurs réseau de la console restent à valider.
11. **CI non encore observée au moment de la rédaction.** Voir F.5 ; ne pas confondre un test local vert avec une CI verte.
12. **`verification_records` / certifications** n'ont pas été recâblés dans la revue d'affirmation ; deux modèles de confiance coexistent (historique et nouveau), ce qui doit être unifié en P2/P3.

---

## J. Prochaine étape

1. **Observer la CI** sur `a70a55d` (et sur le commit de ce rapport) : vérifier `CI`, `Intégration migrations 34/36/41`, puis les parcours Playwright. Si une suite échoue, corriger sans désactiver de contrôle.
2. **Exécuter les parcours navigateur** en local ou en CI : `test:journeys`, `test:phases`, `audit:personas`, puis les tests console (claims, preuves, mandats, révocation).
3. **Faire une répétition à blanc de la migration** sur une base Neon de staging, avec `prisma migrate deploy`, vérifier les grants `tracefab_app`, puis seulement envisager la production (action propriétaire, hors de ce mandat).
4. **Unifier les deux modèles de vérification** : `verification_records`/`certifications` et `dpp_claim_reviews`, pour éviter deux vérités.
5. **P3** : export CIRPASS/JSON-LD serveur versionné, validation GS1 avec un référentiel officiel, niveaux de compatibilité documentés.
6. **P4** : extraction documentaire avec validation humaine, rapprochement déterministe d'abord, aucune écriture automatique, coût plafonné, sources officielles versionnées par catégorie/marché.
7. **Compléter la traçabilité de transformation** : graphe fil → tissu → produit, preuve par étape, lot/unité, agrégation de volumes.
8. **Ne pas merger** avant revue humaine du diff, de la migration et des limites ci-dessus.
