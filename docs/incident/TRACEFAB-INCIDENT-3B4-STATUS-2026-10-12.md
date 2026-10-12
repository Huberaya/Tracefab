# TRACEFAB — Incident de sécurité 3B.4
## État de remédiation vérifié — 2026-10-12

### Résumé exécutif

**Statut : OUVERT — confinement partiel, non clôturé.**

Ce document distingue les changements effectivement enregistrés des vérifications impossibles depuis le connecteur GitHub seul. Aucune valeur de secret n'est reproduite ici.

### 1. Changement de code préparé

Branche : `security/incident-3b-remove-production-db-from-ci`  
PR brouillon : [#35 — Isoler la CI des identifiants de production](https://github.com/Huberaya/Tracefab/pull/35)

Dans `.github/workflows/ci.yml`, le changement :
- retire l'injection de `secrets.DATABASE_URL` dans l'environnement du job CI ;
- retire l'étape qui lançait les suites `test:neon:security`, `test:neon:supplier`, `test:neon:product`, `test:neon:quality` et `test:neon:collection` contre la base de production ;
- conserve le chemin de test RLS sur un service PostgreSQL éphémère.

**Limite :** cette PR n'est pas fusionnée. GitHub Actions étant désactivé pendant le confinement, le workflow n'a pas pu être exécuté pour valider le changement. Ne pas réactiver Actions uniquement pour tester cette PR sans revue préalable.

### 2. Faits confirmés dans le dépôt

- La branche `main` contient le workflow `.github/workflows/ci.yml` avec une base PostgreSQL locale jetable et des identifiants fixes réservés à ce service de test.
- Avant la correction proposée, ce même job injectait aussi `secrets.DATABASE_URL` et comportait une étape de tests Neon conditionnelle. La PR #35 retire cette injection.
- Le dépôt contient des références aux variables d'environnement et des exemples de configuration. Une référence à un nom de variable n'est pas en elle-même une fuite de sa valeur.
- La recherche du code indexé de la branche par défaut a retrouvé les chaînes de connexion attendues dans `.env.example`, la documentation et le workflow CI. Cela ne constitue pas un audit exhaustif de tout l'historique Git.
- Le fichier `vercel.json` configure une tâche planifiée quotidienne à 07:00 UTC vers `/api/internal/notification-outbox/schedule`. Le fichier seul ne prouve ni l'existence d'un déploiement de production actif ni l'état de protection de cette route.

### 3. Confinement

- Selon la capture d'écran fournie par le propriétaire, GitHub Actions est configuré sur « Disable actions ». L'état n'a pas été vérifié indépendamment par API.
- Ne pas réactiver Actions tant qu'une revue du workflow et un plan de validation sûr ne sont pas approuvés.
- Ne pas fusionner la PR #35 automatiquement.
- La désactivation d'Actions n'arrête pas à elle seule les déploiements ou cron Vercel.

### 4. Actions encore requises — bloquantes pour la clôture

| ID | Action | Preuve de clôture attendue | Accès requis |
|---|---|---|---|
| IR-01 | Qualifier EXP-01, EXP-02 et CL-11 : déterminer la nature, le rôle, la portée et la validité des valeurs mentionnées dans les rapports antérieurs sans les recopier | Inventaire expurgé : nom logique, fournisseur, rôle, période d'exposition, verdict | Rapports originaux et consoles du fournisseur |
| IR-02 | Révoquer/renouveler tout identifiant réellement exposé après identification de ses consommateurs | Confirmation du fournisseur, date, consommateur mis à jour, test de connexion | Neon, Vercel, Clerk ou autre fournisseur concerné |
| IR-03 | Auditer l'historique Git complet et toutes les branches actives, pas seulement la recherche de code de `main` | Rapport d'analyse historique avec chemins/commits, sans valeurs sensibles | Accès Git/historique complet et outil de scan de secrets |
| IR-04 | Vérifier les journaux CI historiques, sorties de jobs et artefacts pour toute valeur sensible | Fenêtre de temps examinée, runs et artefacts contrôlés, résultat expurgé | GitHub Actions et journaux disponibles |
| IR-05 | Vérifier le déploiement Vercel, les environnements, les journaux et le cron notification-outbox | Déploiement réellement actif, protections de route, dernière exécution et résultat | Console Vercel et journaux de production |
| IR-06 | Examiner la PR #35, puis valider la CI sur une base jetable sans secret de production | Revue de code, exécution de CI, résultats et commit validé | GitHub, après décision explicite de réactivation |
| IR-07 | Examiner séparément la PR #34 et sa migration non vérifiée `20261010120000` avant toute décision de fusion | Analyse migration/dépendances et validation sur environnement isolé | Revue du code et environnement de test |
| IR-08 | Produire le rapport final de clôture | Chaque exposition classée, rotation prouvée, contrôles exécutés, risques résiduels acceptés explicitement | Toutes les preuves ci-dessus |

### 5. Procédure de rotation — ne pas exécuter à l'aveugle

1. Identifier le fournisseur et le rôle exact de chaque identifiant potentiellement exposé.
2. Identifier tous ses consommateurs (runtime Vercel, migrations, CI, scripts d'exploitation et tâches planifiées).
3. Créer le nouvel identifiant à privilèges minimaux, mettre à jour les consommateurs concernés et tester les connexions sans afficher les valeurs.
4. Révoquer l'ancien identifiant, vérifier les journaux et confirmer l'absence d'erreurs de production.
5. Si `DATABASE_URL` sert de clé de repli à `api/_lib/rate-limit.ts`, définir et valider explicitement `TRACEFAB_RATE_LIMIT_SALT` avant la rotation : changer la clé HMAC modifie les empreintes de compteur et peut réinitialiser les quotas en cours.
6. Ne jamais remplacer `DATABASE_URL` runtime par un rôle d'application sans vérifier les droits, les migrations et le besoin éventuel d'un `DIRECT_URL` distinct.

### 6. Limites de ce rapport

Ce rapport est fondé sur les fichiers et métadonnées accessibles via GitHub et sur la capture d'écran fournie. Il ne prétend pas :
- avoir scanné l'intégralité de l'historique Git et de toutes les références ;
- avoir inspecté les journaux complets de tous les runs ;
- avoir accédé à Neon, Vercel ou Clerk ;
- avoir renouvelé ou révoqué un secret ;
- avoir validé la production ;
- avoir clôturé l'incident.

**Critère de clôture :** aucune clôture tant que IR-01 à IR-08 ne sont pas traités ou formellement acceptés avec justification, responsable et preuve.
