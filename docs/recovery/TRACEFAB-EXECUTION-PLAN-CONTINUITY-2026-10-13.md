# TRACEFAB — Analyse complète des deux conversations ChatGPT

**Date :** 2026-10-13
**Objectif :** Établir la continuité du travail et suivre le plan d'exécution des problèmes
**Sources :** 
- Conversation 1 (antérieure) : https://chatgpt.com/share/6acde229-53cc-83ed-bd16-5a533a0507d3
- Conversation 2 (récente) : https://chatgpt.com/share/6acde23f-e97c-83ed-8fa3-03fae7a0c0e2

---

## 1. CONTEXTE GÉNÉRAL DU PROJET

### 1.1 Origine et vision

TRACEFAB est une startup B2B SaaS / RegTech / Supply Chain Data pour l'industrie textile, conçue pour :

- **Problème fondamental** : Les marques européennes doivent collecter des données auprès de leur chaîne d'approvisionnement pour le Digital Product Passport (DPP) textile (ESPR - Ecodesign for Sustainable Products Regulation)
- **Solution** : Infrastructure de collecte, structuration et fiabilisation des données fournisseurs
- **Positionnement** : Pas un simple logiciel DPP, mais la **couche de données supply chain** qui l'alimente
- **Calendrier réglementaire** : ESPR applicable depuis juillet 2024, acte délégué textile prévu T4 2027, obligations effectives 2028+

### 1.2 Architecture technique actuelle

- **Frontend** : Pages HTML statiques (brand-console, supplier-portal, dpp, quality-center, operations)
- **Backend** : API Node.js/TypeScript avec routeur central (`api/index.ts`)
- **Base de données** : Neon PostgreSQL avec Prisma ORM
- **Authentification** : Clerk
- **Déploiement** : Vercel
- **Stockage** : S3-compatible (privé)

### 1.3 Fonctionnalités principales

1. **Brand Console** : Gestion marques, fournisseurs, produits, tableaux de bord
2. **Supplier Portal** : Portail fournisseurs pour collecte de données
3. **DPP Engine** : Génération passeports numériques produits
4. **Quality Center** : Moteur qualité, plans d'action correctifs
5. **Catalog** : Import/export produits, fournisseurs, questionnaires
6. **Documents** : Upload, scan antivirus, stockage privé
7. **Notifications** : Système de rappels et relances automatiques
8. **Rate Limiting** : Protection anti-abus avec HMAC

---

## 2. HISTORIQUE DES CHANTIERS DE DÉVELOPPEMENT

### 2.1 Phase initiale (Sept-Oct 2026)

| Chantier | Description | Statut |
|----------|-------------|--------|
| 1-9 | Core product features | MERGED (PR #1-#33) |
| 10 | Cloud storage | MERGED |
| 11 | Security audit initial | MERGED |
| 12 | Multi-tenant isolation | MERGED |
| 13-20 | DPP readiness, passport, quality | MERGED |
| 21-25 | PLM/ERP, PEF, green claims | MERGED |

### 2.2 Phase de sécurisation (Oct 2026)

| Chantier | Description | Statut | Branche |
|----------|-------------|--------|---------|
| 2B | Blocages intégration (Clerk, Wallet, sel) | RAPPORT | `docs/experience/CHANTIER-2B-BLOCAGES.md` |
| 2C | Sécurisation GitHub | RAPPORT | `docs/experience/CHANTIER-2C-SECURISATION-GITHUB.md` |
| 2C-2 | Protection et Neon | RAPPORT | `docs/experience/CHANTIER-2C-2-PROTECTION-ET-NEON.md` |
| 2C-3 | Validation et sécurisation | RAPPORT | `docs/experience/CHANTIER-2C-3-VALIDATION-ET-SECURISATION.md` |
| 2C.1 | Suppression risque CI/production | CORRIGÉ | PR #35 (draft) |
| 2C.24-31 | Audits sécurité avancés | RAPPORTS | Divers fichiers docs/ |
| 3B | Incident sécurité | OUVERT | `docs/incident/TRACEFAB-INCIDENT-3B4-STATUS-2026-10-12.md` |

### 2.3 Chantier 1A (PR #34)

**Titre** : Chantier 1A complet : RLS exécutée, auth provisionnée, provenance DPP, rate limiter, rendu figé
**Branche** : `arena/91844ee9-tracefab`
**Statut** : OPEN, MERGEABLE, 100 fichiers modifiés
**Contenu** :
- Bootstrap rôle `tracefab_app`
- Migration 36 (`20261010120000_publication_explicite`)
- Rate limiter avec table counters
- Contexte public DPP
- Protection rendu visuel

**Problème** : Non fusionnable car la migration n'est pas appliquée en production

---

## 3. PROBLÈMES IDENTIFIÉS (AUDIT AUD-01)

### 3.1 Constats critiques (P0-P1)

| ID | Domaine | Constat | Criticité | Statut |
|----|---------|---------|-----------|--------|
| AUD01-F01 | RLS / rôle | RLS inerte si rôle porte BYPASSRLS (`neondb_owner`) | P1 | NEEDS EXTERNAL VALIDATION |
| AUD01-F02 | Livraison rôle | `tracefab_app` + bootstrap absents de `main` | P1 | STATIC ONLY |
| AUD01-F03 | GUC / RLS | Échappatoires worker/outbox par `set_config` client | P1 | STATIC ONLY |
| AUD01-F04 | SECURITY DEFINER | 14 fonctions paramétrées sans garde interne | P1 | STATIC ONLY |
| AUD01-F05 | Privilèges | EXECUTE sur toutes les fonctions, présentes et futures | P2 | STATIC ONLY |
| AUD01-F06 | Documents | `finalize_document_upload` sans garde ; route protège | P2 | STATIC ONLY |
| AUD01-F07 | Routes | 2 fonctions sans garde exposées ; contrôles de route présents | P2 | STATIC ONLY |
| AUD01-F08 | Anti-abus | `rate_limit_counters` en TO PUBLIC | P2 | STATIC ONLY |
| AUD01-F09 | Passeports | Insertion ouverte de demandes d'accès | P3 | STATIC ONLY |
| AUD01-F10 | Robustesse | Cast non protégé de `tracefab.user_id` | P3 | STATIC ONLY |
| AUD01-F11 | Preuve | Titre job CI plus large que couverture | P2 | PASS (périmètre) |
| AUD01-F12 | Architecture | Pas de rôle worker distinct | INFO | STATIC ONLY |
| AUD01-F13 | Documentation | Dossier sécurité : comptes faux et FORCE présenté comme cloisonnant | P2 | STATIC ONLY |

### 3.2 Constats CI/CD (AUD-02)

| ID | Domaine | Constat | Criticité |
|----|---------|---------|-----------|
| P0-01 | CI/Production | Étape CI qui écrit sur base de production | P0 |
| P0-02 | Protection main | `main` non protégée, aucun ruleset | P0 |
| P1-01 | Environnements | Preview/Production sans relecteur ni restriction | P1 |
| P1-02 | Secrets | `DATABASE_URL` potentiellement exposé dans CI | P1 |
| P1-03 | Actions | Actions non épinglées par SHA | P1 |
| P1-04 | Documentation | .env.example incomplet (13 variables manquantes) | P1 |
| P1-05 | Observabilité | Pas de collecteur d'erreurs configuré | P1 |
| P2-01 | CSP | `style-src 'unsafe-inline'` non documenté | P2 |
| P2-02 | Forks | Dépôt public avec forks autorisés | P2 |
| P2-03 | Scanning | Secret scanning non vérifié | P2 |
| P2-04 | CI | Commentaires CI contradictoires sur secrets | P2 |
| P2-05 | Certification | Aucune démarche SOC 2/ISO 27001 | P2 |

---

## 4. INCIDENT DE SÉCURITÉ EN COURS (3B.4)

### 4.1 Description

Un secret de base de données de production (`DATABASE_URL`) a été :
1. Utilisé dans une étape CI déclenchée sur tout push
2. Potentiellement exposé dans des logs et artefacts
3. Présent dans 12 fichiers non suivis et copies hors dépôt

### 4.2 Actions de clôture (IR-01 à IR-08)

| ID | Action | Statut |
|----|--------|--------|
| IR-01 | Neutraliser secret au niveau dépôt | EN ATTENTE |
| IR-02 | Choisir Patch B (recommandé) | EN ATTENTE |
| IR-03 | Désigner mainteneur pour PR corrective | EN ATTENTE |
| IR-04 | Auditer branches distantes | EN ATTENTE |
| IR-05 | Rotation du secret | EN ATTENTE |
| IR-06 | Quarantaine copies/artefacts | EN ATTENTE |
| IR-07 | Protéger environnement Production | EN ATTENTE |
| IR-08 | Décider réécriture b0c976f (non recommandée) | EN ATTENTE |

---

## 5. PLAN D'EXÉCUTION DES PROBLÈMES

### 5.1 Phase 1 : Sécurité immédiate (Priorité absolue)

**Objectif** : Neutraliser les risques critiques avant toute correction fonctionnelle

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 1.1 | Neutraliser `DATABASE_URL` au niveau dépôt | A (Admin) | Propriétaire | Secret recensé et neutralisé |
| 1.2 | Appliquer Patch B (suppression littéral + mot de passe temporaire) | C (Mainteneur) | IA B | CI verte sans secret exposé |
| 1.3 | Rotation du secret Neon | D (Admin) | Propriétaire | Ancienne valeur inopérante |
| 1.4 | Quarantaine artefacts sensibles | A (Admin) | Propriétaire | Fichiers sécurisés |

### 5.2 Phase 2 : Protection infrastructure (Priorité haute)

**Objectif** : Sécuriser GitHub, Vercel et la chaîne CI/CD

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 2.1 | Protéger `main` (ruleset : PR obligatoire, 4 checks, 0 approbation temporaire) | C (Propriétaire) | Propriétaire | `protected: true` via API |
| 2.2 | Configurer environnement Production (relecteurs, restriction branches) | C (Propriétaire) | Propriétaire | Protection active |
| 2.3 | Épingler actions GitHub par SHA | B (IA B) | IA B | 12 usages modifiés |
| 2.4 | Désactiver workflow `Figer la reference visuelle` | C (Propriétaire) | Propriétaire | `disabled_manually` |
| 2.5 | Compléter `.env.example` (13 variables) | B (IA B) | IA B | Variables documentées |
| 2.6 | Activer secret scanning et push protection | C (Propriétaire) | Propriétaire | Fonctionnalités actives |

### 5.3 Phase 3 : Résolution erreur production (Priorité haute)

**Objectif** : Identifier et corriger l'erreur `internal_error`

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 3.1 | Test discriminant (curl /api/health et /api/catalog/schemas) | A (Propriétaire) | Propriétaire | Résultats fournis |
| 3.2 | Lecture journal Vercel par `correlationId` | A (Propriétaire) | Propriétaire | Erreur identifiée |
| 3.3 | Appliquer Correctif A (postinstall + dependencies) | B puis C | IA B | Préversion 200 |
| 3.4 | Garde-fou build (échec si Prisma non généré) | B | IA B | Test vert |

### 5.4 Phase 4 : Base de données et RLS (Priorité haute)

**Objectif** : Prouver l'isolation multi-tenant

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 4.1 | Vérifier rôle réel en production (`rolbypassrls`) | A (Admin) | Propriétaire | `rolbypassrls=false` mesuré |
| 4.2 | Appliquer migration 36 (`publication_explicite`) | D (Admin) | Propriétaire | Migration appliquée |
| 4.3 | Corriger régression privilège (`tracefab_material_visible_via_product`) | B puis D | IA B | `REVOKE FROM PUBLIC` + `GRANT TO tracefab_app` |
| 4.4 | Basculer vers `tracefab_app` (si 4.1 = BYPASSRLS) | D (Admin) | Propriétaire | `DATABASE_URL` utilise `tracefab_app` |
| 4.5 | Tester isolation RLS dynamique | A (Admin) | Propriétaire | `test:neon:rls` vert sur production |

### 5.5 Phase 5 : Authentification et autorisations (Priorité moyenne)

**Objectif** : Sécuriser les chemins d'accès

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 5.1 | Vérifier chemins d'usurpation GUC (worker, outbox) | B | IA B | Tests négatifs verts |
| 5.2 | Ajouter gardes internes aux fonctions SECURITY DEFINER | B | IA B | `test:rls:definer` vert |
| 5.3 | Protéger `finalize_document_upload` | B | IA B | Garde interne + test |
| 5.4 | Définir responsabilités UPDATE (colonnes modifiables) | D (Décision) | Propriétaire | Spécification écrite |

### 5.6 Phase 6 : Tests et qualité (Priorité moyenne)

**Objective** : Prouver le bon fonctionnement

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 6.1 | Exécuter 20 parcours E2E contre production | A (Admin) | Propriétaire | `test:journeys` vert |
| 6.2 | Exécuter 3 personas contre production | A (Admin) | Propriétaire | `audit:personas` vert |
| 6.3 | Vérifier passeport public réel (sans bannière démo) | A (Admin) | Propriétaire | Données réelles affichées |
| 6.4 | Tester dépôt document complet (upload → scan → download) | A (Admin) | Propriétaire | Parcours bout en bout |
| 6.5 | Tester invitation réelle (EMAIL_FROM vérifié) | A (Admin) | Propriétaire | Email reçu |
| 6.6 | Vérifier crons actifs (notification-outbox) | A (Admin) | Propriétaire | Journaux d'exécution lus |

### 5.7 Phase 7 : Observabilité et exploitation (Priorité basse)

**Objectif** : Préparer la mise en production

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 7.1 | Configurer `TRACEFAB_ERROR_WEBHOOK_URL` | C (Admin) | Propriétaire | Erreur test reçue |
| 7.2 | Désigner responsable collecteur d'erreurs | D (Décision) | Propriétaire | Nom inscrit |
| 7.3 | Configurer `TRACEFAB_NOTIFICATION_ALERT_URL` | C (Admin) | Propriétaire | Alerte testée |
| 7.4 | Définir fenêtre historique Neon (couverture week-end) | D (Admin) | Propriétaire | Configuration consignée |
| 7.5 | Tester restauration Neon (au moins une fois) | D (Admin) | Propriétaire | Restauration réussie |

### 5.8 Phase 8 : Données et véracité (Priorité moyenne)

**Objectif** : Garantir la qualité des données

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 8.1 | Vérifier aucune revendication conformité dans Wallet/API | B | IA B | Tests verts |
| 8.2 | Vérifier aucune donnée démo présentée comme réelle | B | IA B | Tests verts |
| 8.3 | Décider règle URL publique (slug unique vs URL marque) | D (Décision) | Propriétaire | Décision écrite |
| 8.4 | Traiter produit archivé publié (`INACTIF-001`) | D (Décision) | Propriétaire | Décision écrite |
| 8.5 | Compléter ou dépublier produits sans matière/identifiant | D (Décision) | Propriétaire | Décision écrite |

### 5.9 Phase 9 : Documentation et conformité (Priorité basse)

**Objectif** : Préparer les documents contractuels

| # | Action | Niveau | Responsable | Critère de clôture |
|---|--------|--------|-------------|-------------------|
| 9.1 | Corriger dossier sécurité (chiffres, phrase RLS) | B | IA B | Texte corrigé |
| 9.2 | Lister sous-traitants exacts | B | IA B | Liste à jour |
| 9.3 | Confirmer engagements sécurité (security@, accusé 24h) | D (Décision) | Propriétaire | Confirmation écrite |
| 9.4 | Vérifier absence promesse intégration PLM/ERP non déployée | B | IA B | Supports commerciaux OK |

---

## 6. DÉCISIONS HUMAINES REQUISES

| # | Décision | Qui | Bloque | Éléments à fournir |
|---|----------|-----|--------|-------------------|
| D1 | Fusionner PR #34, extraire en correctifs, ou refuser | Propriétaire | P0-01, P0-03, P0-05 | Impact migration, relecture figer, detect-secrets |
| D2 | Nombre approbations requises sur `main` (0 ou 1) | Propriétaire | P0-02 | Un seul collaborateur aujourd'hui |
| D3 | Vercel : conserver déploiement auto ou conditionner | Propriétaire | P0-02 | Protection GitHub ne gouverne pas Vercel |
| D4 | Supprimer secret dépôt `DATABASE_URL` + créer `TRACEFAB_RATE_LIMIT_SALT` | Administrateur | P0-01, P1-02 | `gh secret list` (403 actuellement) |
| D5 | Rotation mot de passe production (oui/non) | Propriétaire | — | Journaux accès Neon non consultés |
| D6 | Règle URL publique : slug global ou URL portant marque | Produit | P1-03 | 4 marques partagent `mb-shirt-001` |
| D7 | Sort produits archivés publiés (`INACTIF-001`) | Produit | P1-03 | Produit archivé reste public |
| D8 | Produits publiés sans matière/identifiant : compléter ou dépublier | Produit + données | P1-03 | 4 des 8 produits publiés |
| D9 | Certificats Apple/Google Wallet : installer ou retirer boutons | Produit + admin | P0-03 | Hôtes injoignables |
| D10 | Fenêtre historique Neon : durée et couverture week-end | Administrateur | P0-06 | À relever dans console |
| D11 | Sort `test:neon:supplier:advanced` : suppression ou garde | Technique | P1-06 | Script destructeur non appelé |
| D12 | Sel limiteur : génération et dépôt hors dépôt | Administrateur | P1-02 | Ne jamais recopier valeur |
| D13 | Test intrusion et certifications SOC 2/ISO 27001 | Direction | P2-05 | Aucune démarche engagée |
| D14 | Facturation/abonnements Stripe : nécessaire dès premier client ? | Direction | — | Absent du dépôt |

---

## 7. CHECKLIST DE LANCEMENT

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

## 8. ÉTAT ACTUEL (2026-10-13)

### 8.1 Ce qui est fait

- Bilan de récupération Chantier 1 complété (lecture seule)
- Cause racine erreur production identifiée (Prisma client non généré)
- Tests statiques exécutés (7/7 verts)
- Correctif A préparé (non appliqué)
- Documentation complète dans `docs/recovery/TRACEFAB-RECOVERY-ASSEURANCE-2026-10-13.md`

### 8.2 Ce qui reste bloqué

- Accès Vercel : journaux inaccessibles
- Accès Neon : audit base réelle impossible
- Accès Clerk : test authentification impossible
- Secrets : EXP-01, EXP-02, EXP-03, CL-11, DEC-36 introuvables
- Décisions humaines : 14 décisions en attente

### 8.3 Prochaine action recommandée

1. **Propriétaire** : exécuter test discriminant (curl /api/health et /api/catalog/schemas)
2. **Propriétaire** : fournir résultats et journal Vercel si disponible
3. **Propriétaire** : décider du sort de PR #34 et de la protection de `main`
4. **IA B** : appliquer Correctif A après validation
5. **IA B** : appliquer corrections sécurité Phase 1-2 après autorisations

---

## 9. SUIVI DES CHANTIERS

### 9.1 Chantiers terminés

| Chantier | Date | Résultat |
|----------|------|----------|
| 2C.1 | 2026-10-10 | CI/production isolé, actions épinglées |
| 2C.2 | 2026-10-10 | Protection Neon documentée |
| 2C.3 | 2026-10-10 | Validation sécurisation |
| 2C.24-25 | 2026-10-11 | Audits sécurité avancés |
| 2C.26-31 | 2026-10-11 | Clôture incertitudes |
| AUD-01 | 2026-10-11 | Audit indépendant sécurité |
| Chantier 1 | 2026-10-13 | Bilan récupération (lecture seule) |

### 9.2 Chantiers en cours

| Chantier | Statut | Blocage |
|----------|--------|---------|
| Chantier 2 (Confinement) | BLOQUÉ | Journaux CI, consoles fournisseurs |
| Chantier 3 (Erreur production) | CORRIGÉ, TESTS EN ATTENTE | Accès Vercel |
| Chantier 4 (Base données) | EN COURS | Accès Neon |
| Chantier 5 (Authentification) | EN COURS | Base réelle |
| Chantier 6 (Tests) | EN COURS | PostgreSQL local absent |
| Chantier 7 (Staging/production) | NON COMMENCÉ | Autorisations déploiement |
| Chantier 8 (Stabilisation) | NON COMMENCÉ | Dépend chantiers 3-7 |

### 9.3 Chantiers à venir

| Chantier | Objectif | Prérequis |
|----------|----------|-----------|
| AUD-02 | Audit CI/CD et secrets | Lecture seule |
| AUD-03 | Audit intégrations (Clerk, Wallet) | Lecture seule |
| Correctif A | Résoudre erreur production | Validation propriétaire |
| Correctif B | Suppression littéral CI | Validation propriétaire |
| Correctif C | Régression privilège SQL | Validation propriétaire |
| Migration 36 | Publication explicite | Application en production |

---

*Fin de l'analyse complète.*