# Inventaire des consommateurs de `neondb_owner` — 27/10/2026

**Statut : lecture seule. Aucune variable, aucun rôle, aucun mot de passe, aucun
déploiement, aucune branche n'a été modifié. Aucune migration lancée.**
**Autorisation explicite requise avant toute opération de production.**

Périmètre demandé : identifier tous les consommateurs possibles de
`neondb_owner`, distinguer les confirmés des hypothèses, préparer la rotation
coordonnée, ne rien exécuter en production.

---

## 1. Méthode, et ce que chaque source peut prouver

| Source | Accès | Ce qu'elle prouve |
|---|---|---|
| Dépôt `Huberaya/Tracefab` (révision `8d8dd3b` puis `7eec19d`) | exhaustif | **qui peut** se connecter, et par quelle variable — statiquement |
| Sonde de runtime `GET /api/internal/p2/readiness?identity=1` | opérateur | **quelle identité** le runtime utilise réellement (lecture seule, authentifiée) |
| `pg_stat_activity` en production | opérateur | **qui est connecté** à un instant donné, y compris hors Vercel |
| Console Vercel → Environment Variables | opérateur | **noms** et environnements des variables (jamais les valeurs) |
| API Vercel (connecteur de cette session) | **refusé** | `Access denied` — aucun inventaire de variables possible depuis ici |
| Secrets GitHub Actions (liste) | **refusé** | `HTTP 403 Resource not accessible by integration` |

Les deux refus sont des **limites de la session**, pas des absences de risque :
elles déplacent l'inventaire vers l'opérateur.

Analyse reproductible : `npm run inventaire:consommateurs`
(`scripts/inventaire_consommateurs_base.mjs`), verrouillée par
`npm run test:inventaire:consommateurs` (9 cas). Le script lit le dépôt, ne
contacte aucune base, et **ignore les commentaires** — la première version
comptait deux clients Prisma et un secret de base ; les trois « violations »
étaient des commentaires, défaut corrigé et verrouillé.

---

## 2. Ce que le dépôt établit (confirmé, par lecture exhaustive)

| Constat | Preuve |
|---|---|
| Le code applicatif n'utilise **qu'une seule** variable de base : `DATABASE_URL` | `scripts/inventaire_consommateurs_base.mjs` — 4 occurrences, aucune autre variable `*DATABASE*`, `*POSTGRES*`, `*NEON*` |
| **Un seul** client Prisma dans `api/` | `api/_lib/prisma.ts:28` — contrôle d'invariant du script |
| Aucune connexion `pg` brute dans `api/` | recherche `from 'pg'` : aucune occurrence dans `api/` |
| **Un cron** dépend de cette variable | `vercel.json` → `/api/internal/notification-outbox/schedule`, `0 7 * * *` (quotidien) |
| Aucun workflow GitHub ne lit de secret de base | les seuls secrets référencés sont `VERCEL_READONLY_TOKEN` ; toutes les URL de base des workflows sont `localhost` (Postgres jetable) |
| 70 scripts du dépôt ouvrent une connexion ; 8 refusent explicitement la production | dont `verifier_identite_branche.mjs`, `simuler_recalcul_dpp.mjs`, `migration`… |

**Conséquence structurante** : il n'existe **qu'un point d'entrée**. Le rôle
utilisé par l'application est, par construction, celui de `DATABASE_URL` en
environnement Production — ni plus, ni moins. Il n'y a pas de « second client
caché » à chercher dans le code.

---

## 3. Consommateurs possibles de `neondb_owner`

### 3.1 Contradiction de sources, à trancher par mesure

Trois sources du dossier ne disent pas la même chose :

| Source | Affirmation |
|---|---|
| `docs/operations/variables-environnement.md` (§ Identité effective) | la sonde doit rendre `currentUser == "tracefab_app"`, `bypassesRls == false` |
| `.github/workflows/ci.yml:488` (commentaire) | « le runtime se connecte **aujourd'hui** avec `neondb_owner`, qui porte `BYPASSRLS` » |
| `docs/security/2026-10-21-production-migration-reconciliation.md` | « le rôle effectif des requêtes Vercel Production **reste à mesurer** depuis le runtime » |

**Aucune de ces trois lignes n'est une preuve.** Deux sont des intentions ou des
commentaires, la troisième dit explicitement que la mesure manque. La valeur de
production n'a jamais été exposée ni mesurée dans ce dossier.

### 3.2 Tableau des consommateurs

| # | Consommateur | Rôle | Statut | Preuve / méthode |
|---|---|---|---|---|
| 1 | Runtime Vercel (toutes les routes `api/`) | rôle porté par `DATABASE_URL` Production | **INCONNU, mesurable** | sonde `?identity=1` (§ 4.1) |
| 2 | Cron `notification-outbox/schedule` (quotidien 07:00) | idem runtime | **INCONNU, hérite de #1** | `vercel.json` ; même variable, aucun secret distinct |
| 3 | Migrations Prisma (`prisma migrate deploy`) en production | doit être un rôle DDL — `neondb_owner` est le candidat | **HYPOTHÈSE** | les migrations exigent `CREATE/ALTER` ; `tracefab_app` n'a ni `CREATEROLE` ni DDL. Le credential utilisé n'est donc **pas** celui du runtime s'il est `tracefab_app` → il vit ailleurs (poste opérateur, `.env` local, ou variable dédiée non inventoriée) |
| 4 | Variables Vercel **Preview** (plusieurs `DATABASE_URL`) | branches de test | **INCONNU** | signalé par l'opérateur ; noms et environnements à relever |
| 5 | Variables Vercel **Development** | poste/CI locale | **INCONNU** | idem |
| 6 | Secrets GitHub Actions | — | **AUCUN usage de base** pour le nommage connu ; liste réelle **non consultable** (403) | grep exhaustif des workflows |
| 7 | Scripts du dépôt lancés à la main | selon l'URL fournie | **POSSIBLE** | 70 scripts connectés, 8 refusent la production ; les 62 autres n'ont pas de garde |
| 8 | Services externes (BI, sauvegarde, monitoring, intégrations Neon) | — | **INCONNU** | hors dépôt, hors session : seul l'opérateur peut l'établir |

### 3.3 Ce que `neondb_owner` peut faire (mesuré antérieurement, en lecture seule)

`rolbypassrls = true`, `rolcreaterole = true`, `rolcreatedb = true`
(`docs/security/2026-10-21-production-migration-reconciliation.md`).

Ce n'est donc pas « un accès en lecture » : c'est un rôle capable de lire toutes
les organisations **sans RLS**, de créer des rôles et des bases. Le secret exposé
est, tant qu'il vit, un accès administrateur aux données de production.

---

## 4. Preuves d'utilisation à établir (lecture seule)

### 4.1 Identité réelle du runtime — **la mesure décisive**

La sonde passe par le **même client Prisma** que les routes ; un `psql` sur la
même URL mesurerait une autre connexion et ne prouverait rien. Elle est
authentifiée, ne renvoie que des noms de rôle et deux booléens, et n'écrit rien.

```bash
# à exécuter par l'opérateur ; le secret de worker reste dans son environnement
curl --fail-with-body -sS \
  -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness?identity=1" \
  | jq '{ready, databaseIdentity}'
```

Lecture du résultat :

- `currentUser: "tracefab_app"` → le runtime n'utilise **pas** `neondb_owner` ;
  l'exposition se limite alors aux consommateurs #3, #4, #7, #8 ;
- `currentUser: "neondb_owner"` → **le runtime de production tourne sur le rôle
  compromis** ; la rotation touche l'application elle-même et doit être
  coordonnée avec la variable Vercel ;
- `measured: false` ou 503 → la sonde n'a pas pu mesurer : ne rien conclure,
  l'absence de mesure n'est pas une preuve d'innocuité.

### 4.2 Autres sessions connectées (hors Vercel)

```sql
-- lecture seule, instantané ; à répéter à une heure d'activité
SELECT usename, application_name, count(*) AS sessions,
       min(backend_start) AS plus_ancienne
  FROM pg_stat_activity
 WHERE backend_type = 'client backend'
 GROUP BY usename, application_name
 ORDER BY sessions DESC;
```

Un `usename = neondb_owner` avec un `application_name` inconnu (ni Prisma, ni
script identifié) désigne un consommateur hors inventaire. Limite : cette vue
montre les sessions **présentes au moment de la requête** ; un job quotidien ou
hebdomadaire peut ne jamais y apparaître. À corréler avec les journaux.

### 4.3 Tâche planifiée

Le cron de 07:00 est le seul consommateur récurrent certain du runtime. Son
succès le lendemain de la rotation est une preuve d'exploitation ; son échec
`password authentication failed` désigne une variable oubliée.

---

## 5. Rotation coordonnée — procédure exacte

**Principe directeur : on ne revient jamais au secret compromis.** Un retour
arrière qui réinstalle l'ancien mot de passe rouvrirait la faille ; il n'est donc
pas une option, même en cas d'incident.

### 5.1 Fenêtre et risque d'indisponibilité

- **Durée** : 10 à 15 minutes, hors heures d'usage (le cron tourne à 07:00).
- **Indisponibilité** : toutes les routes qui touchent la base échouent entre la
  rotation Neon et le redéploiement Vercel effectif. Les pages statiques
  continuent de servir ; les appels API renvoient des erreurs 500 jusqu'au
  redéploiement.
- **Aggravant si `currentUser = neondb_owner`** : c'est l'application entière qui
  dépend de la clé tournée. **Non aggravant si `tracefab_app`** : la production
  n'est pas interrompue, seuls les consommateurs annexes le sont.

### 5.2 Conditions de déclenchement (toutes requises)

1. résultat de la sonde § 4.1 **connu** (pas « probable ») ;
2. liste des **noms** de variables Vercel relevée, par environnement ;
3. inventaire des consommateurs hors Vercel fait ou explicitement accepté comme
   incomplet, avec risque assumé par écrit ;
4. fenêtre annoncée et acceptée ;
5. **autorisation explicite du propriétaire** pour l'écriture en production.

Si l'une manque : **ne pas tourner la clé**. Le risque d'une panne non maîtrisée
n'est pas préférable au risque, déjà réel, d'un secret vivant — mais la décision
appartient au propriétaire, pas à l'opérateur.

### 5.3 Ordre des opérations

| # | Action | Effet | Preuve à conserver |
|---|---|---|---|
| 1 | Relever les **noms** des variables Vercel (Production, Preview, Development) et des cron jobs | aucun | liste horodatée |
| 2 | Sonde § 4.1 sur la production | lecture seule | JSON `databaseIdentity` |
| 3 | Annoncer la fenêtre | aucun | — |
| 4 | Neon → branche de production → Roles → `neondb_owner` → **Reset password** | immédiat, irréversible pour l'ancien mot de passe | capture de l'heure |
| 5 | Mettre à jour **chaque** variable relevée à l'étape 1, dans **tous** les environnements concernés | aucun effet tant que non redéployé | noms modifiés (jamais les valeurs) |
| 6 | **Redéployer** (une variable seule n'est pas prise en compte) | prise d'effet | déploiement `Ready` + SHA |
| 7 | Sonde § 4.1 **à nouveau** | lecture seule | identité identique à l'étape 2 |
| 8 | Rotation des **branches enfants** où le rôle peut se connecter | chacune indépendamment | liste des branches tournées |
| 9 | Surveillance | — | voir § 6 |

### 5.4 Retour arrière — sans réactiver le secret compromis

| Situation | Ce qu'on fait | Ce qu'on ne fait **jamais** |
|---|---|---|
| L'application échoue après la rotation | remettre **le nouveau** mot de passe là où l'ancien figurait, puis redéployer ; en dernier recours, créer un second rôle de secours et basculer la variable dessus | remettre l'ancien mot de passe dans Neon ou dans Vercel |
| Un consommateur oublié tombe | identifier la variable manquante par l'erreur `28P01` et la mettre à jour | élargir les droits d'un rôle pour « faire passer » |
| Le nouveau secret est lui-même exposé | refaire une rotation, et changer **le canal** de transmission (gestionnaire de secrets, jamais un chat) | réutiliser une chaîne ayant transité par un canal non sûr |
| On veut revenir à l'état antérieur des **données** | restauration de branche / Time Travel Neon | restaurer un instantané antérieur à la rotation pour réparer un problème d'**authentification** : l'instantané peut ramener l'ancien mot de passe |

---

## 6. Preuves de clôture (à exiger, dans cet ordre)

L'incident **n'est pas clos** tant que les cinq preuves ne sont pas réunies.

1. **L'ancien mot de passe est refusé** sur la production : tentative
   d'authentification → `28P01 password authentication failed`.
   *(Réalisé pour la branche de validation le 27/10 : `28P01` constaté. Refusé
   aujourd'hui sur la production : la connexion a réussi.)*
2. **Le nouveau fonctionne pour les consommateurs légitimes** : sonde § 4.1
   exécutée après redéploiement, `measured: true`, identité identique à celle
   relevée avant rotation.
3. **Les parcours applicatifs fonctionnent** : appel authentifié sur une route
   qui lit la base, et un appel qui écrit ; réponse attendue, pas 500.
4. **La tâche planifiée fonctionne** : exécution du cron de 07:00 réussie le
   lendemain (`notification_schedule_completed` dans les journaux).
5. **Aucune erreur d'authentification résiduelle** sur 24 h : recherche de
   `password authentication failed` dans les journaux applicatifs ; chaque
   occurrence désigne un emplacement de secret oublié.

Preuve complémentaire utile : `pg_stat_activity` ne montre plus aucune session
`neondb_owner` inconnue.

---

## 7. Risques résiduels, énoncés sans adoucissement

1. **Le secret exposé est vivant sur la production** (mesuré : connexion
   acceptée le 27/10). C'est le risque principal, et il ne diminue pas tant que
   la rotation n'est pas faite. Chaque heure qui passe augmente l'exposition.
2. **Le rôle est puissant** : `BYPASSRLS`, `CREATEROLE`, `CREATEDB`. Ce n'est pas
   une lecture de données, c'est un accès administrateur.
3. **L'inventaire est incomplet par construction** : les valeurs Vercel (API
   refusée), la liste des secrets GitHub (403) et les consommateurs hors dépôt
   (BI, sauvegardes, intégrations) ne sont pas établis depuis cette session.
4. **Les branches enfants partagent l'origine** : chaque branche issue de la
   production a hérité du mot de passe à sa création et conserve l'ancien
   jusqu'à sa propre rotation. Une rotation de production ne les nettoie pas.
5. **L'identité du runtime n'est pas mesurée** : trois documents se contredisent
   (§ 3.1). Tant que la sonde n'a pas répondu, on ne sait pas si tourner la clé
   interrompt l'application.
6. **La fenêtre de rotation est une indisponibilité assumée**, pas un
   incident : à annoncer avant, pas à découvrir après.

---

## 8. Ce qui n'a pas été fait

- aucun mot de passe, rôle, variable, branche ou déploiement modifié ;
- aucune migration lancée ;
- aucune valeur secrète lue, déchiffrée ou publiée ;
- aucune tentative d'accès aux données de production au-delà d'une
  **authentification** (connexion acceptée, **zéro requête**).

**Prochaine action attendue : l'autorisation explicite du propriétaire**, après
lecture du § 5.2 et du § 7.
