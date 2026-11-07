# Preuves — isolation globale des accès et du stockage (6 novembre 2026)

**Branche de travail** : `arena/0f697b3e-tracefab` (imposée, `active`).
**SHA initial** : `788df22019c0d2b39301678ecfbc43ac868561bf` (`788df22`).
**PR #109** : ouverte, base `main`, tête distante
`fix/active-tenant-closure-20261103` = `751004e04ed1563f56d4d9c003c895ddecb5c638`
(≠ branche de travail ; son patch a été appliqué localement, jamais poussé sur
cette branche distante). Aucune fusion, aucun déploiement Production, aucune
migration ou écriture sur une base distante, aucune lecture de valeur secrète.

Ce rapport sépare strictement les **trois niveaux** exigés. Le SHA exact du
commit qui porte ce rapport est fourni dans le bilan final (un fichier ne peut
pas contenir sa propre empreinte Git).

---

## Niveau 1 — PostgreSQL jetable (local, PGlite) : **RÉALISÉ**

| Commande | Résultat | Portée |
| --- | --- | --- |
| `npm run test:isolation:globale` | exit 0 — **77 contrôles, 0 échec** | chaîne complète de 70 migrations, rôle `tracefab_app`, GUC réels, fixtures A/B/C/S/S2, 10 scénarios, refus fail-closed, clés de stockage, catalogue `SECURITY DEFINER` |
| `npm run test:tenant:matrix` | exit 0 — 138 routes, 102 métier contrôlées, 0 non classifiée, matrice commitée à jour | `docs/security/route-tenant-matrix.json` |
| `npm run test:tenant:autorisations` | exit 0 — 8 colonnes, 10 scénarios, tous exécutés | `docs/security/matrice-autorisations-tenant-actif.md` |
| `npm run test:private-storage` | exit 0 | bucket privé, quota, scan fail-closed, URLs présignées après garde, téléchargement fournisseur borné au tenant |
| `npm run test:active-tenant-routes` | exit 0 — 79 contrôles | validation centralisée, sélecteur sans tenant implicite, traduction `TenantError` |
| `npm run test:neon:registre-fonctions` | exit 0 — module = registre = **95 noms** | aucun `GRANT EXECUTE` direct, migration historique inchangée (empreinte contrôlée) |
| 9 suites `scripts/*_pglite*.mjs` | 9 exit 0 | chaîne 70/70, rejouabilité, P10.7 fail-closed (52 assertions), effets, invitation fournisseur |
| `npm run typecheck && npm run api:typecheck` | exit 0 | TypeScript applicatif et API |
| `npm test` (chaîne officielle) | exit 0 | typechecks, schéma statique, ~50 contrats métier |
| Boucle CI filtrée (`test:*`, 154 scripts) | **154/154 exit 0** | reproduction locale de l'étape « Suite complete des scripts test:* » de `.github/workflows/ci.yml` |
| `npm run test:p107:contrat-identite`, `test:p107:sonde-fail-closed`, `test:p107:sonde-hmac` | exit 0 | identité signée, refus avant connexion |

### Défaut mesuré, puis fermé (pas seulement affirmé)

Sur les **69 migrations historiques**, tenant `A` armé, compte membre de `A`,
`B` et `S` : `SELECT id FROM documents` renvoyait les documents des **trois**
organisations ; `tracefab_can_access_document(<doc B>)` = vrai ; produits de A
et B visibles. Après la 70e migration : documents privés de B et S **invisibles**,
`tracefab_can_access_document(<doc B>)` = faux, document de A conservé,
partages S→A et S→B correctement séparés, cycle sans tenant (worker/public)
inchangé. Sections A / A2 / A3 du test.

### Fuite découverte puis corrigée au cours du chantier

Une branche « certification fournisseur » permettait à la marque B de lire un
document de A via un certificat nommant S et une autre relation active avec S.
Correction : le certificat **et** le document doivent appartenir au fournisseur,
ou la relation active avec la marque émettrice doit être cohérente avec le
propriétaire. Scénario 3 renforcé, non assoupli.

### Limites honnêtes du niveau 1

- `npm ci` complet avec génération Prisma en ligne échoue dans ce bac à sable
  (`binaries.prisma.sh`, TLS bloqué). `PRISMA_SKIP_POSTINSTALL_GENERATE=true npm ci`
  + `npm run db:generate:offline` donnent un client **types-only** : suffisant
  pour le typecheck, insuffisant pour un runtime. `npm run verify:prisma-client`
  sort donc 1 **localement pour raison d'environnement** ; en CI le réseau est
  disponible et `npm run build` doit le valider.
- `npm run test:regression` (image de référence liée aux polices système) est
  exclu de la boucle CI par le dépôt lui-même ; il échoue localement sur une
  différence de métriques de fontes, sans aucun rapport avec ce chantier.
- Les 72 scripts `test:neon:*`, `test:jetables:*`, `test:p105:*`, `test:p106:*`,
  `test:p107:*` (phase base) et 3 gardes de cible exigent `DATABASE_URL` +
  `TF_RLS_APP_URL` + rôles `tracefab_app`/`tracefab_migrator`. Ils sortent
  **2 = NON EXÉCUTÉ**, jamais 0, conformément à leur contrat fail-closed. Ils
  sont câblés un par un dans le job CI « Base » contre un PostgreSQL jetable ;
  leur résultat sur le SHA final sera à lire dans le run CI, pas ici.
- Aucune preuve HTTP réelle sur l'API (Clerk, navigateur, téléchargement de
  fichier, export/import) n'a été produite localement : les tests navigateur du
  dépôt valident le shell statique et le proxy Clerk, pas l'API déployée.

---

## Niveau 2 — Vercel Preview + Neon isolé : **NON RÉALISÉ**

Exigé : SHA exact, authentification réelle, deux organisations, utilisateur
multi-org, partages, tests HTTP, documents, absence de fuite, variables Preview
prouvées isolées.

État mesuré le 6 novembre 2026 via le connecteur Vercel activé :

- `validate_credential` → `success: true` ;
- `get_authenticated_user` → compte `baya-ibraimmayoanouedu-8164`,
  équipe par défaut `team_BdnOPU97H1GOmMxy7T06nijQ`, **`limited: true`** ;
- `list_projects` (avec et sans `team_id`) et `list_deployments` →
  **`Access denied`** : le jeton ne dispose pas des portées de lecture
  nécessaires.

Aucune liste de déploiements, aucun SHA déployé, aucune variable d'environnement
(ni même leurs noms), aucun état de branche Neon n'a donc pu être vérifié. Le
check Vercel vert de la PR #109 (`Ah3VP9tsJCzqUjj3ktVovNaGAzy4`) reste une
preuve de build, **pas** un parcours métier validé. **Une Preview READY ne sera
jamais présentée ici comme une validation.**

Éléments à autoriser par l'opérateur (préparés, non exécutés) :

1. jeton Vercel avec portées de lecture `projects`/`deployments`/`env` (les
   valeurs secrètes ne seront jamais lues, seulement noms + cibles
   `preview`/`production`) ;
2. une branche Neon **isolée** et l'assurance que `DATABASE_URL` de Preview
   pointe exclusivement sur elle ;
3. deux organisations de test, un utilisateur multi-organisations et les
   relations/partages de la matrice (§2) ;
4. un compte Clerk de test et l'exécution des parcours HTTP sur le SHA final :
   consultation produit/documents, téléchargement, export, import, portail
   fournisseur, bascule de tenant, refus inter-tenant par ID exact.

---

## Niveau 3 — Production, vérifications non destructives : **NON RÉALISÉ**

Aucune lecture de l'état de `main`, du SHA déployé, de `_prisma_migrations`, des
rôles, des politiques RLS, des protections ou de la cohérence des variables
(sans valeurs) n'a pu être faute de portées/canaux autorisés. Aucune écriture,
migration, modification de variable ou déploiement Production n'a été effectué.
Une réussite niveau 1 ou niveau 2 ne sera **jamais** extrapolée en validation
Production.

À autoriser : accès en lecture seule à Neon Production (catalogue,
`_prisma_migrations`, `pg_roles`, `pg_policies`, table des registres) et à Vercel
Production (SHA déployé, noms des variables par cible), sans valeurs secrètes.

---

## Synthèse des livrables versionnés

- `prisma/migrations/20261105180000_active_tenant_access_guards/migration.sql` :
  70e migration additive (2 gardes + 1 prédicat RLS + 2 fonctions historiques
  liées au tenant + 1 politique RESTRICTIVE + registre). Aucun fichier de
  migration appliqué n'a été réécrit ; procédure de réversibilité documentée
  dans le SQL.
- `api/_lib/context.ts`, `api/index.ts`, `api/_lib/documents.ts`,
  `api/_lib/quality.ts`, 9 routes documentaires/evidence,
  `api/_routes/supplier/documents/[documentId]/download.ts`,
  `api/_routes/supplier/organizations.ts`.
- `scripts/test_isolation_globale_pglite.mjs`,
  `scripts/test_route_tenant_matrix.mjs`,
  `scripts/test_matrice_autorisations.mjs`,
  `docs/security/route-tenant-matrix.json`,
  `docs/security/matrice-autorisations-tenant-actif.md`,
  `docs/experience/CHANTIERS-RESTANTS.md` (compte 70), `package.json`,
  `.github/workflows/ci.yml`.
- Contrats obsolètes mis à jour sans affaiblissement :
  `test_security_chantier1.mjs`, `test_document_ai_chantier1.mjs`,
  `test_active_tenant_routes.mjs`, `test_private_storage.mjs` (ils exigent
  désormais le garde de tenant actif et interdisent l'union des adhésions).

## Décision

Les niveaux 2 et 3 ne sont pas exécutés ; les 16 critères de clôture ne sont
donc pas tous satisfaits. Le chantier est **incomplet** et la décision ne peut
pas être **GO**. Voir le bilan final A–F.
