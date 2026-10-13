# TRACEFAB — PLAN D'EXÉCUTION DES PROBLÈMES

**Date :** 2026-10-13
**Statut :** ⛔ LANCEMENT BLOQUÉ — 6 conditions bloquantes ouvertes
**Projet :** TRACEFAB (Huberaya/Tracefab)
**Application :** https://tracefab.vercel.app/

---

## RÉSUMÉ EXÉCUTIF

Le projet TRACEFAB a été audité de manière exhaustive entre le 9 et le 13 octobre 2026. 
L'audit a révélé **4 problèmes critiques (P0)**, **6 problèmes élevés (P1)** et **12 problèmes moyens (P2)**.

**Cause racine de l'erreur `internal_error`** : Le client Prisma n'est pas généré dans le build Vercel, car `vercel.json` contient un tableau `builds` qui fait ignorer les réglages de build du projet, et aucun `postinstall` ni `installCommand` ne déclenche `prisma generate`.

---

## PHASE 1 : SÉCURITÉ IMMÉDIATE (Priorité absolue)

**Objectif** : Neutraliser les risques critiques avant toute correction fonctionnelle
**Bloquant** : OUI — Toute autre action dépend de cette phase

### 1.1 — Neutraliser le secret DATABASE_URL au niveau dépôt

| Élément | Détail |
|---------|--------|
| **Action** | Recenser les consommateurs du secret `DATABASE_URL` au niveau du dépôt GitHub, puis le neutraliser |
| **Responsable** | Propriétaire (administrateur GitHub) |
| **Niveau** | A (Administration) |
| **Critère de clôture** | Secret recensé, tous les consommateurs identifiés, valeur neutralisée |
| **Preuve** | Capture écran GitHub Settings montrant le secret supprimé ou désactivé |
| **Risque** | Peut casser les workflows qui dépendent de ce secret — d'où la nécessité de recenser d'abord |

**Procédure :**
1. Aller dans GitHub → Settings → Secrets and variables → Actions
2. Identifier tous les workflows et jobs qui utilisent `secrets.DATABASE_URL`
3. Vérifier qu'aucun workflow critique ne dépend de ce secret pour fonctionner
4. Supprimer ou désactiver le secret
5. Documenter les consommateurs identifiés et l'impact de la suppression

### 1.2 — Appliquer le Patch B (suppression du littéral dans CI)

| Élément | Détail |
|---------|--------|
| **Action** | Supprimer la valeur littérale du mot de passe dans `.github/workflows/ci.yml` et la remplacer par un mot de passe temporaire généré à chaque exécution |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | C (Modification distante) |
| **Critère de clôture** | CI verte sans secret exposé, mot de passe temporaire généré dynamiquement |
| **Preuve** | Diff montrant la suppression du littéral, run CI vert |
| **Autorisation requise** | Oui — validation du propriétaire nécessaire |

**Contenu du Patch B :**
```yaml
# Dans .github/workflows/ci.yml, job base-de-donnees :
# AVANT (littéral exposé) :
env:
  TF_APP_PASSWORD: isolation_ci_jetable

# APRÈS (temporaire) :
env:
  TF_APP_PASSWORD: ${{ github.run_id }}_${{ github.run_attempt }}_ci_jetable
```

### 1.3 — Rotation du secret Neon

| Élément | Détail |
|---------|--------|
| **Action** | Générer un nouveau mot de passe pour le rôle de connexion Neon de production |
| **Responsable** | Propriétaire (administrateur Neon) |
| **Niveau** | D (Opération critique) |
| **Critère de clôture** | Nouveau mot de passe actif, ancienne valeur inopérante |
| **Preuve** | Capture écran Neon montrant le nouveau mot de passe, test de connexion avec l'ancienne valeur échouant |
| **Prérequis** | Identifier tous les consommateurs (Vercel, CI, scripts) avant de rotation |

**Procédure :**
1. Accéder à la console Neon → Dashboard → Connection details
2. Générer un nouveau mot de passe pour le rôle `neondb_owner` (ou `tracefab_app` si déjà migré)
3. Mettre à jour la variable `DATABASE_URL` dans Vercel (Settings → Environment Variables)
4. Mettre à jour le secret GitHub `DATABASE_URL` si nécessaire (après la Phase 1.1)
5. Vérifier que l'application fonctionne avec le nouveau mot de passe
6. Tester que l'ancien mot de passe ne fonctionne plus

### 1.4 — Quarantaine des artefacts sensibles

| Élément | Détail |
|---------|--------|
| **Action** | Identifier et sécuriser tous les fichiers contenant des valeurs sensibles exposées |
| **Responsable** | Propriétaire |
| **Niveau** | A (Administration) |
| **Critère de clôture** | 12 fichiers non suivis et copies hors dépôt sécurisés |
| **Preuve** | Liste des fichiers identifiés, confirmation de leur sécurisation |

**Fichiers concernés :**
- 12 fichiers non suivis dans le dépôt
- 2 copies hors dépôt mentionnées dans le rapport 2C.31
- 1 fichier de diff dans `/tmp/arena-workspace/`

---

## PHASE 2 : PROTECTION INFRASTRUCTURE (Priorité haute)

**Objectif** : Sécuriser GitHub, Vercel et la chaîne CI/CD
**Bloquant** : OUI pour la mise en production

### 2.1 — Protéger la branche `main`

| Élément | Détail |
|---------|--------|
| **Action** | Créer un ruleset actif sur `main` avec les protections suivantes |
| **Responsable** | Propriétaire (administrateur GitHub) |
| **Niveau** | C (Configuration) |
| **Critère de clôture** | `protected: true` vérifié via API |
| **Preuve** | `gh api repos/Huberaya/Tracefab/branches/main/protection` renvoyant les protections |

**Configuration requise :**
- Exiger une Pull Request (pas de push direct)
- Exiger les 4 checks CI :
  - `Socle — types, compilation, isolation`
  - `Verification — suite de tests`
  - `Parcours — navigateur reel`
  - `Base — isolation RLS executee`
- Bloquer les force-push et les suppressions
- **0 approbation requise** tant qu'un second relecteur n'existe pas (sinon aucune PR ne sera fusionnable avec un seul collaborateur)

### 2.2 — Configurer l'environnement Production

| Élément | Détail |
|---------|--------|
| **Action** | Configurer les protections de l'environnement Production dans GitHub |
| **Responsable** | Propriétaire (administrateur GitHub) |
| **Niveau** | C (Configuration) |
| **Critère de clôture** | Protection active, relecteurs configurés |
| **Preuve** | Capture écran montrant la configuration |

**Configuration requise :**
- Ajouter au moins un relecteur requis
- Activer la prévention de l'auto-approbation
- Restreindre les déploiements à la branche `main`
- Décider si les administrateurs peuvent contourner la règle
- Déplacer les secrets de production dans l'environnement (et non au niveau du dépôt)

### 2.3 — Épingler les actions GitHub par SHA

| Élément | Détail |
|---------|--------|
| **Action** | Remplacer les 12 usages d'actions GitHub par des références par SHA complet |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | 12 usages modifiés, aucun tag flottant restant |
| **Preuve** | Diff montrant les SHA, vérification que chaque SHA correspond à la version attendue |

**Actions à épingler :**

| Action | Version | SHA complet |
|--------|---------|-------------|
| `actions/checkout` (5 usages) | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` (5 usages) | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` (2 usages) | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

### 2.4 — Désactiver le workflow `Figer la reference visuelle`

| Élément | Détail |
|---------|--------|
| **Action** | Désactiver manuellement ce workflow dans GitHub |
| **Responsable** | Propriétaire (administrateur GitHub) |
| **Niveau** | C (Configuration) |
| **Critère de clôture** | État API `disabled_manually` |
| **Preuve** | `gh api repos/Huberaya/Tracefab/actions/workflows` montrant l'état |

**Risque documenté :** Ce workflow possède `contents: write` et exécute le code de la branche déclenchante. Tant que `main` n'est pas protégée, un contributeur ayant le droit d'écriture peut exécuter son propre code avec ce jeton.

### 2.5 — Compléter le fichier `.env.example`

| Élément | Détail |
|---------|--------|
| **Action** | Ajouter les 13 variables manquantes dans `.env.example` |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Toutes les variables du code sont documentées |
| **Preuve** | Diff montrant les variables ajoutées, test `test:production-readiness` vert |

**Variables manquantes :**
1. `TRACEFAB_RATE_LIMIT_SALT`
2. `TRACEFAB_APPLE_WALLET_*` (certificats Apple Wallet)
3. `TRACEFAB_GOOGLE_WALLET_*` (certificats Google Wallet)
4. `TRACEFAB_ERROR_WEBHOOK_URL`
5. `TRACEFAB_ERROR_WEBHOOK_TOKEN`
6. `TRACEFAB_NOTIFICATION_ALERT_URL`
7. `TRACEFAB_NOTIFICATION_ALERT_TOKEN`
8. `TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS`
9. `TRACEFAB_STAGING_*` (variables de staging si applicable)
10. `TRACEFAB_PLM_*` (variables PLM/ERP)
11. `PRIVATE_STORAGE_*` (variables S3 complètes)
12. `TRACEFAB_SCAN_*` (variables scanner antivirus)
13. `TRACEFAB_WALLET_*` (variables Wallet supplémentaires)

### 2.6 — Activer le secret scanning et la push protection

| Élément | Détail |
|---------|--------|
| **Action** | Activer les fonctionnalités de sécurité GitHub |
| **Responsable** | Propriétaire (administrateur GitHub) |
| **Niveau** | C (Configuration) |
| **Critère de clôture** | Fonctionnalités actives |
| **Preuve** | Capture écran montrant l'activation |

**Procédure :**
1. Aller dans GitHub → Settings → Code security and analysis
2. Activer "Secret scanning"
3. Activer "Push protection"
4. Vérifier que les alertes sont configurées

---

## PHASE 3 : RÉSOLUTION ERREUR PRODUCTION (Priorité haute)

**Objectif** : Identifier et corriger l'erreur `internal_error` sur https://tracefab.vercel.app
**Bloquant** : OUI pour le fonctionnement de l'application

### 3.1 — Test discriminant (à exécuter par le propriétaire)

| Élément | Détail |
|---------|--------|
| **Action** | Exécuter les deux commandes curl et fournir les résultats |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | Résultats fournis avec les codes HTTP et les corps de réponse |
| **Preuve** | Sortie des commandes curl |

**Commandes à exécuter :**
```bash
curl -sS -i https://tracefab.vercel.app/api/health
curl -sS -i https://tracefab.vercel.app/api/catalog/schemas
```

**Interprétation des résultats :**

| `/api/health` | `/api/catalog/schemas` | Interprétation | Suite |
|---------------|------------------------|----------------|-------|
| 500 `internal_error` **+ correlationId** | 200 | **Client Prisma non initialisé** (cause confirmée) | Appliquer Correctif A |
| 503 `database_unavailable` | 200 | Base de données injoignable | Lire journal Vercel par `correlationId` |
| 200 | 200 | Application fonctionnelle | L'erreur est résolue ou n'a jamais existé |
| 500 `internal_error` **+ correlationId** | 500 `internal_error` **+ correlationId** | Erreur globale (pas seulement Prisma) | Lire journal Vercel |

### 3.2 — Lecture du journal Vercel

| Élément | Détail |
|---------|--------|
| **Action** | Rechercher l'erreur dans les journaux Vercel en utilisant le `correlationId` |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | Erreur identifiée, cause racine confirmée |
| **Preuve** | Extrait de journal Vercel (sans données sensibles) |

**Procédure :**
1. Ouvrir le tableau de bord Vercel → Projet `tracefab`
2. Ouvrir Logs ou Runtime Logs
3. Rechercher l'identifiant de corrélation : `c3696f22-41d0-4981-8d99-4e6a177021a3`
4. Si l'identifiant ne donne aucun résultat, filtrer les erreurs autour de l'heure du test
5. Copier le type d'erreur et son message (en masquant les données sensibles)

### 3.3 — Appliquer le Correctif A

| Élément | Détail |
|---------|--------|
| **Action** | Rendre la génération du client Prisma obligatoire dans le build Vercel |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B puis C (Préparation puis déploiement) |
| **Critère de clôture** | Préversion Vercel renvoyant 200 sur `/api/health` et `/api/dpp/:gtin` |
| **Preuve** | Diff de `package.json` et/ou `vercel.json`, test sur préversion |
| **Autorisation requise** | Oui — validation du propriétaire nécessaire |

**Option 1 — Modifier `package.json` (recommandée) :**
```json
{
  "scripts": {
    "postinstall": "prisma generate",
    // ... autres scripts
  },
  "dependencies": {
    "@clerk/backend": "^3.23.0",
    "@prisma/client": "^6.19.3",
    "archiver": "^8.0.0",
    "jsonwebtoken": "^9.0.3",
    "prisma": "^6.19.3"
  },
  "devDependencies": {
    "@types/archiver": "^8.0.0",
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^20.19.43",
    "axe-core": "^4.14.0",
    "pg": "^8.23.1",
    "playwright": "^1.63.0",
    "tsx": "^4.23.15",
    "typescript": "^5.9.2"
  }
}
```

**Option 2 — Modifier `vercel.json` (alternative) :**
```json
{
  "builds": [
    {
      "src": "api/index.ts",
      "use": "@vercel/node@3",
      "config": {
        "includeFiles": ["catalog/**/*.json"],
        "installCommand": "npm ci && npx prisma generate"
      }
    },
    // ... autres builds
  ]
}
```

### 3.4 — Garde-fou build (échec si Prisma non généré)

| Élément | Détail |
|---------|--------|
| **Action** | Ajouter un test qui vérifie que le client Prisma est correctement initialisé |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Test vert, échec provoqué volontairement une fois pour vérifier la détection |
| **Preuve** | Script de test, sortie montrant la détection de l'erreur |

**Implémentation suggérée :**
```javascript
// scripts/verify-prisma-generated.mjs
import { PrismaClient } from '@prisma/client';

try {
  const pc = new PrismaClient();
  await pc.$connect();
  console.log('✅ Prisma client initialisé avec succès');
  await pc.$disconnect();
  process.exit(0);
} catch (e) {
  console.error('❌ Prisma client non initialisé:', e.message);
  process.exit(1);
}
```

Ajouter au script `build` dans `package.json` :
```json
{
  "scripts": {
    "build": "npm run db:generate && node scripts/verify-prisma-generated.mjs && npm run typecheck && ..."
  }
}
```

---

## PHASE 4 : BASE DE DONNÉES ET RLS (Priorité haute)

**Objectif** : Prouver l'isolation multi-tenant en production
**Bloquant** : OUI pour la mise en production

### 4.1 — Vérifier le rôle réel en production

| Élément | Détail |
|---------|--------|
| **Action** | Exécuter la requête SQL pour vérifier si le rôle de connexion porte BYPASSRLS |
| **Responsable** | Propriétaire (administrateur Neon) |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | `rolbypassrls=false` mesuré en production |
| **Preuve** | Résultat de la requête SQL |

**Requête à exécuter dans la console Neon (SQL Editor) :**
```sql
SELECT 
  rolname,
  rolsuper,
  rolinherit,
  rolcreaterole,
  rolcreatedb,
  rolcanlogin,
  rolreplication,
  rolbypassrls,
  rolconnlimit
FROM pg_roles 
WHERE rolname IN ('neondb_owner', 'tracefab_app', 'postgres')
ORDER BY rolname;
```

**Interprétation :**
- Si `neondb_owner` a `rolbypassrls=true` : la RLS est **inerte** en production
- Si `tracefab_app` existe et a `rolbypassrls=false` : la RLS est **active** (si `DATABASE_URL` utilise ce rôle)

### 4.2 — Appliquer la migration 36 (`publication_explicite`)

| Élément | Détail |
|---------|--------|
| **Action** | Appliquer la migration présente dans la PR #34 |
| **Responsable** | Propriétaire (administrateur Neon) |
| **Niveau** | D (Opération critique) |
| **Critère de clôture** | Migration appliquée, aucune migration en attente |
| **Preuve** | `npx prisma migrate status` montrant toutes les migrations appliquées |
| **Prérequis** | Vérifier l'impact de la migration sur les données existantes |

**Procédure :**
1. Vérifier l'impact de la migration sur les données existantes (notamment les produits avec `public_slug`)
2. Appliquer la migration : `npx prisma migrate deploy`
3. Vérifier que toutes les migrations sont appliquées : `npx prisma migrate status`
4. Tester que les routes DPP fonctionnent correctement

### 4.3 — Corriger la régression de privilège SQL

| Élément | Détail |
|---------|--------|
| **Action** | Créer une migration de remplacement pour corriger le `GRANT EXECUTE … TO PUBLIC` sur `tracefab_material_visible_via_product` |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B puis D (Préparation puis application) |
| **Critère de clôture** | `REVOKE FROM PUBLIC` + `GRANT TO tracefab_app`, test négatif « PUBLIC refusé » |
| **Preuve** | Migration rejouée sur base isolée + test de non-régression |
| **Autorisation requise** | Oui — modification des privilèges en production |

**Migration de correction (à préparer) :**
```sql
-- Migration: 20261013120000_fix_materials_public_grant
-- Corrige la régression introduite par 20261009120000

-- Révoquer le privilège PUBLIC (trop large)
REVOKE EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) FROM PUBLIC;

-- Accorder le privilège uniquement au rôle applicatif
GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO tracefab_app;

-- Vérifier que le rôle applicatif peut toujours appeler la fonction
-- (test à exécuter après application)
```

### 4.4 — Basculer vers le rôle `tracefab_app`

| Élément | Détail |
|---------|--------|
| **Action** | Modifier `DATABASE_URL` pour utiliser le rôle `tracefab_app` au lieu de `neondb_owner` |
| **Responsable** | Propriétaire (administrateur Neon/Vercel) |
| **Niveau** | D (Opération critique) |
| **Critère de clôture** | `DATABASE_URL` utilise `tracefab_app`, RLS active |
| **Preuve** | Test de connexion avec le nouveau rôle, vérification que les politiques RLS sont évaluées |
| **Prérequis** | Le rôle `tracefab_app` doit exister (créé par la migration 36 ou le script `bootstrap_app_role.mjs`) |

**Procédure :**
1. Vérifier que le rôle `tracefab_app` existe dans Neon
2. Si non, exécuter le script `bootstrap_app_role.mjs` (présent dans la PR #34)
3. Créer un nouveau `DATABASE_URL` avec le rôle `tracefab_app`
4. Mettre à jour la variable dans Vercel
5. Vérifier que l'application fonctionne
6. Tester que les politiques RLS sont bien évaluées (requêtes retournant moins de données)

### 4.5 — Tester l'isolation RLS dynamique

| Élément | Détail |
|---------|--------|
| **Action** | Exécuter les tests RLS contre la production avec le rôle restreint |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | `test:neon:rls` vert sur production |
| **Preuve** | Sortie du test montrant l'isolation effective |

**Commande :**
```bash
DATABASE_URL="postgresql://tracefab_app:PASSWORD@HOST/neondb" npm run test:neon:rls
```

---

## PHASE 5 : AUTHENTIFICATION ET AUTORISATIONS (Priorité moyenne)

**Objectif** : Sécuriser les chemins d'accès
**Bloquant** : Non pour un lancement minimal, mais nécessaire pour la conformité

### 5.1 — Vérifier les chemins d'usurpation GUC

| Élément | Détail |
|---------|--------|
| **Action** | Vérifier que les variables de session `tracefab.*` ne peuvent pas être utilisées pour contourner la sécurité |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Tests négatifs verts |
| **Preuve** | Tests montrant que les tentatives d'usurpation échouent |

### 5.2 — Ajouter des gardes internes aux fonctions SECURITY DEFINER

| Élément | Détail |
|---------|--------|
| **Action** | Ajouter des vérifications internes dans les 14 fonctions SECURITY DEFINER identifiées |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | `test:rls:definer` vert |
| **Preuve** | Tests montrant que les fonctions rejettent les appels non autorisés |

### 5.3 — Protéger `finalize_document_upload`

| Élément | Détail |
|---------|--------|
| **Action** | Ajouter une garde interne dans la fonction `finalize_document_upload` |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Garde interne + test de non-régression |
| **Preuve** | Code modifié, tests verts |

---

## PHASE 6 : TESTS ET QUALITÉ (Priorité moyenne)

**Objectif** : Prouver le bon fonctionnement de l'application
**Bloquant** : Non pour un lancement minimal, mais nécessaire pour la confiance

### 6.1 — Exécuter les 20 parcours E2E contre production

| Élément | Détail |
|---------|--------|
| **Action** | Exécuter les tests de parcours contre l'URL de production |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | `test:journeys` vert |
| **Preuve** | Sortie du test |

**Commande :**
```bash
npm run test:journeys -- --base https://tracefab.vercel.app
```

### 6.2 — Exécuter les 3 personas contre production

| Élément | Détail |
|---------|--------|
| **Action** | Exécuter l'audit des personas contre l'URL de production |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | `audit:personas` vert |
| **Preuve** | Sortie du test |

**Commande :**
```bash
npm run audit:personas -- --base https://tracefab.vercel.app
```

### 6.3 — Vérifier le passeport public réel

| Élément | Détail |
|---------|--------|
| **Action** | Vérifier qu'un passeport public s'affiche avec des données réelles (pas de bannière démo) |
| **Responsable** | Propriétaire |
| **Niveau** | A (Investigation) |
| **Critère de clôture** | Données réelles affichées, pas de bannière "démonstration" |
| **Preuve** | Capture d'écran du passeport |

---

## PHASE 7 : OBSERVABILITÉ ET EXPLOITATION (Priorité basse)

**Objectif** : Préparer la mise en production complète
**Bloquant** : Non

### 7.1 — Configurer le collecteur d'erreurs

| Élément | Détail |
|---------|--------|
| **Action** | Configurer `TRACEFAB_ERROR_WEBHOOK_URL` dans Vercel |
| **Responsable** | Propriétaire |
| **Niveau** | C (Configuration) |
| **Critère de clôture** | Erreur test reçue dans le collecteur |
| **Preuve** | Log montrant l'erreur reçue |

### 7.2 — Désigner un responsable du collecteur d'erreurs

| Élément | Détail |
|---------|--------|
| **Action** | Nommer une personne responsable de surveiller le collecteur d'erreurs |
| **Responsable** | Propriétaire (décision) |
| **Niveau** | D (Décision) |
| **Critère de clôture** | Nom inscrit, personne formée |
| **Preuve** | Document ou email confirmant la désignation |

---

## PHASE 8 : DONNÉES ET VÉRACITÉ (Priorité moyenne)

**Objectif** : Garantir la qualité des données
**Bloquant** : Non pour un lancement minimal, mais nécessaire pour la crédibilité

### 8.1 — Vérifier l'absence de revendications de conformité

| Élément | Détail |
|---------|--------|
| **Action** | Vérifier qu'aucune page, Wallet ou API ne contient de revendication de conformité |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Tests verts |
| **Preuve** | Tests montrant l'absence de revendications |

### 8.2 — Décider de la règle d'URL publique

| Élément | Détail |
|---------|--------|
| **Action** | Choisir entre slug global unique ou URL portant la marque |
| **Responsable** | Propriétaire (décision produit) |
| **Niveau** | D (Décision) |
| **Critère de clôture** | Décision écrite |
| **Contexte** | 4 marques partagent actuellement le slug `mb-shirt-001` |

---

## PHASE 9 : DOCUMENTATION ET CONFORMITÉ (Priorité basse)

**Objectif** : Préparer les documents contractuels
**Bloquant** : Non

### 9.1 — Corriger le dossier de sécurité

| Élément | Détail |
|---------|--------|
| **Action** | Mettre à jour les chiffres et la phrase sur la RLS |
| **Responsable** | IA B (agent de développement) |
| **Niveau** | B (Préparation de correction) |
| **Critère de clôture** | Texte corrigé, chiffres re-mesurés |
| **Preuve** | Diff du document |

**Corrections à apporter :**
- Chiffres : 45 → 46 tables, 49 → 45 FORCE, 32 → 35 migrations
- Phrase RLS : « FORCE cloisonne les requêtes manuelles » → « FORCE ne protège que si le rôle ne porte pas BYPASSRLS »

---

## DÉCISIONS HUMAINES REQUISES

| # | Décision | Qui | Bloque | Éléments à fournir |
|---|----------|-----|--------|-------------------|
| **D1** | Fusionner PR #34, extraire en correctifs, ou refuser | Propriétaire | P0-01, P0-03, P0-05 | Impact migration, relecture figer, detect-secrets |
| **D2** | Nombre approbations requises sur `main` (0 ou 1) | Propriétaire | P0-02 | Un seul collaborateur aujourd'hui |
| **D3** | Vercel : conserver déploiement auto ou conditionner | Propriétaire | P0-02 | Protection GitHub ne gouverne pas Vercel |
| **D4** | Supprimer secret dépôt `DATABASE_URL` + créer `TRACEFAB_RATE_LIMIT_SALT` | Administrateur | P0-01, P1-02 | `gh secret list` (403 actuellement) |
| **D5** | Rotation mot de passe production (oui/non) | Propriétaire | — | Journaux accès Neon non consultés |
| **D6** | Règle URL publique : slug global ou URL portant marque | Produit | P1-03 | 4 marques partagent `mb-shirt-001` |
| **D7** | Sort produits archivés publiés (`INACTIF-001`) | Produit | P1-03 | Produit archivé reste public |
| **D8** | Produits publiés sans matière/identifiant : compléter ou dépublier | Produit + données | P1-03 | 4 des 8 produits publiés |
| **D9** | Certificats Apple/Google Wallet : installer ou retirer boutons | Produit + admin | P0-03 | Hôtes injoignables |
| **D10** | Fenêtre historique Neon : durée et couverture week-end | Administrateur | P0-06 | À relever dans console |
| **D11** | Sort `test:neon:supplier:advanced` : suppression ou garde | Technique | P1-06 | Script destructeur non appelé |
| **D12** | Sel limiteur : génération et dépôt hors dépôt | Administrateur | P1-02 | Ne jamais recopier valeur |
| **D13** | Test intrusion et certifications SOC 2/ISO 27001 | Direction | P2-05 | Aucune démarche engagée |
| **D14** | Facturation/abonnements Stripe : nécessaire dès premier client ? | Direction | — | Absent du dépôt |

---

## CHECKLIST DE LANCEMENT

### A. Sécurité et accès

- [ ] Secret `DATABASE_URL` neutralisé au niveau dépôt
- [ ] Patch B appliqué (littéral supprimé + mot de passe temporaire)
- [ ] Rotation secret Neon effectuée et ancienne valeur inopérante
- [ ] Quarantaine artefacts sensibles réalisée
- [ ] `main` protégée avec 4 checks requis
- [ ] Environnement Production configuré (relecteurs, restriction branches)
- [ ] Actions GitHub épinglées par SHA
- [ ] Workflow `Figer la reference visuelle` désactivé
- [ ] `TRACEFAB_RATE_LIMIT_SALT` défini, distinct de tout autre secret
- [ ] Rotation secrets si doute d'exposition (procédure Vercel documentée)
- [ ] Secret scanning et push protection activés
- [ ] En-têtes sécurité en place (HSTS, nosniff, frame-ancestors, CSP sans unsafe-inline)

### B. Base de données

- [ ] `npx prisma migrate status` : aucune migration en attente
- [ ] Migration `20261010120000_publication_explicite` : appliquée ou écartée
- [ ] Fenêtre historique Neon configurée (couverture week-end)
- [ ] Instantané récent existe
- [ ] Restauration répétée au moins une fois (environnement isolé)
- [ ] Réconciliation stockage/lignes exécutée et consignée
- [ ] Isolation statique : 125 routes, 0 hors modèle déclaré
- [ ] Isolation exécutée sous rôle restreint, contre production

### C. Application et parcours

- [ ] CI verte sur référence déployée (4 étages)
- [ ] 20 parcours passent contre URL production
- [ ] 3 personas passent contre production
- [ ] Passeport public réel affiché (sans bannière démo)
- [ ] Aucun GTIN inconnu ne rend données fabriquées
- [ ] Aucun pass Wallet ne porte affirmation conformité
- [ ] Dépôt document aboutit bout en bout (dépôt → antivirus → téléchargement)
- [ ] Invitation réelle reçue, `EMAIL_FROM` sur domaine vérifié
- [ ] 2 crons actifs et journaux d'exécution lus

### D. Observabilité et exploitation

- [ ] `TRACEFAB_ERROR_WEBHOOK_URL` pointe collecteur réel
- [ ] Responsable nommé inscrit et a lu collecteur
- [ ] `TRACEFAB_NOTIFICATION_ALERT_URL` configurée, alerte testée
- [ ] Alerte sur indisponibilité compteur débit
- [ ] `?probe=live` repassé après ouverture trafic

### E. Données et véracité

- [ ] Aucune revendication conformité dans pages
- [ ] Aucune revendication conformité dans Wallet/API
- [ ] Aucune donnée démo présentée comme réelle
- [ ] 7 langues s'affichent sans clé brute
- [ ] Produits publiés complets (matière, identifiant) ou retirés
- [ ] Règle URL publique tranchée (slug unique)
- [ ] Troncature liste annoncée à utilisateur

### F. Documents contractuels

- [ ] Dossier sécurité : chiffres relus, phrase RLS corrigée
- [ ] `.env.example` complet (13 variables manquantes)
- [ ] Contrat variables à jour (45 lignes)
- [ ] Liste sous-traitants exacte
- [ ] Engagements sécurité renseignés (security@, accusé 24h)
- [ ] Aucune promesse intégration PLM/ERP non déployée
- [ ] Maturité DPP non présentée comme certification

### G. Juste après ouverture

- [ ] Première erreur réelle observée dans collecteur
- [ ] Utilisateur réel connecté et a atteint console
- [ ] Fournisseur réel a reçu invitation et ouvert portail
- [ ] Document réel a traversé antivirus et téléchargement
- [ ] Relevé J+1 : taux 429, 500, queue outbox

---

## ÉTAT ACTUEL (2026-10-13)

### Ce qui est fait

- ✅ Bilan de récupération Chantier 1 complété (lecture seule)
- ✅ Cause racine erreur production identifiée (Prisma client non généré)
- ✅ Tests statiques exécutés (7/7 verts)
- ✅ Correctif A préparé (non appliqué)
- ✅ Documentation complète dans `docs/recovery/`

### Ce qui reste bloqué

- ❌ Accès Vercel : journaux inaccessibles
- ❌ Accès Neon : audit base réelle impossible
- ❌ Accès Clerk : test authentification impossible
- ❌ Secrets : EXP-01, EXP-02, EXP-03, CL-11, DEC-36 introuvables
- ❌ Décisions humaines : 14 décisions en attente

### Prochaine action recommandée

1. **Propriétaire** : exécuter le test discriminant (Phase 3.1)
2. **Propriétaire** : fournir les résultats et le journal Vercel si disponible
3. **Propriétaire** : décider du sort de PR #34 et de la protection de `main`
4. **IA B** : appliquer le Correctif A après validation
5. **IA B** : appliquer les corrections sécurité Phase 1-2 après autorisations

---

*Fin du plan d'exécution.*