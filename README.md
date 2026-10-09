# TRACEFAB

**The intelligence layer for the global textile supply chain.**

TRACEFAB transforme les données fragmentées de la chaîne textile mondiale en une
intelligence produit structurée, fiable, traçable et réutilisable : collecte
fournisseur, preuves documentaires, qualité de la donnée, traçabilité et
préparation au Digital Product Passport (DPP).

> Voir — Structurer — Vérifier — Tracer — Prouver.

---

## Statut

🚧 **Transformation en cours** — état mesuré du dépôt et feuille de route en
12 chantiers :
[`docs/audit/01-world-class-transformation-audit.md`](docs/audit/01-world-class-transformation-audit.md)

| | |
|---|---|
| **Backend / données** | ✅ Solide : multi-tenant RLS, 125 routes API, moteur qualité, collecte, preuves, DPP readiness |
| **Frontends** | 🟠 Fonctionnels : Brand Console (17 vues), Supplier Portal (14 vues), pages publiques en démo |
| **Infra externe** | 🟠 En contrat : S3 privé, antivirus, Resend prod et webhook d'alerte à raccorder sur staging |
| **Décisions de conception** | 📚 28 docs d'architecture dans `docs/architecture/` |

---

## Principes

1. **Le produit central est la donnée** fournisseur structurée — pas le QR code.
2. **Multi-tenant dès la première migration** (RLS forcée, contexte Clerk transactionnel).
3. **Une donnée déclarée n'est pas une preuve.** L'enum `data_value_status` porte sept états distincts : `declared`, `documented`, `checked_for_consistency`, `verified_by_reviewer`, `certified_by_third_party`, `expired`, `needs_review`.
4. **Les documents sont privés par défaut** ; partage par périmètre explicite.
5. **Le DPP est une projection versionnée**, jamais une affirmation de conformité réglementaire.
6. Le domaine TRACEFAB reste séparé de la marketplace Ethimarket.

---

## Démarrage rapide

```bash
npm install
cp .env.example .env          # puis renseigner DATABASE_URL, Clerk, etc.
npm run db:generate           # génère le client Prisma
DATABASE_URL="…" npm run db:deploy
```

| Besoin | Commande |
|---|---|
| Vérifier les types | `npm run typecheck` puis `npm run api:typecheck` |
| Valider le schéma historique | `npm run schema:static` |
| Tests complets (matrice offline) | `npm test` |
| Tests contre une base Neon | `npm run test:neon:security`, `test:neon:supplier:advanced`, `test:neon:quality`, … |
| Parcours navigateur (mode démo) | `npm run test:brand-console:browser`, `test:supplier-portal:browser` |
| Copie métier non traduite | `npm run test:copy` |
| Cibles tactiles et feuille console | `npm run test:touch`, `npm run test:console-css` |
| Statut des migrations | `npm run db:status` |

La build Vercel (`npm run build`) enchaîne typecheck, schéma et les suites de
non-régression ; elle échoue volontairement au premier test rouge.

---

## Surfaces

| URL | Surface | Description |
|---|---|---|
| `/` | Landing publique | Positionnement, chaîne supply chain interactive, i18n 7 langues |
| `/brand-console/` | Brand Console | Vue marque : produits, fournisseurs, collecte, qualité, risque, DPP… (17 vues) |
| `/supplier-portal/` | Supplier Portal | Vue fournisseur : profil, sites, certificats, demandes, preuves… (14 vues) |
| `/quality-center/` | Quality Center | Scores, issues explicables, acquittements et waivers |
| `/dpp/` · `/p/:gtin` | Passeport produit public | Démo publique + GS1 digital link |
| `/passport/` | Passeport fournisseur universel | Partage contrôlé avec demandes d'accès |
| `/product-intelligence/` | Fiche produit démo | 11 onglets d'analyse (données de démonstration) |
| `/operations/` | Opérations | Santé de l'outbox de notifications et dépendances |
| `/invitations/accept` | Acceptation d'invitation | Flow Clerk + API |

Chaque SPA fonctionne sur la vraie API, et bascule en mode démonstration avec
`?demo=1` (balisé par une bannière).

> `/passport/` n'a pas de route déclarée dans `vercel.json` : il est servi par
> `handle: filesystem` et le build `**/*.html`. Cela fonctionne, mais repose sur
> une règle implicite.

---

## Architecture

```text
api/                  125 routes serverless, routeur central api/index.ts
  _routes/            124 handlers par domaine
  _lib/               auth Clerk, contexte RLS, stockage SigV4, moteurs métier
prisma/               schéma (44 modèles) + 32 migrations Neon canoniques
supabase/migrations/  historique de conception (ne pas appliquer sur Neon)
brand-console/ supplier-portal/ dpp/ passport/ quality-center/
operations/ product-intelligence/ invitations/      SPA statiques
assets/               design system CSS + catalogue i18n (1 626 clés, 7 langues)
src/                  domaine TypeScript + renderer Next.js DPP (expérimental)
catalog/              référentiels versionnés : schémas, questionnaires, standards
scripts/              107 scripts de test et d'outillage
docs/                 architecture (28), expérience (26), opérations, audit
```

### API par domaine

| Domaine | Exemples de routes |
|---|---|
| Organisations & équipes | `organizations`, `organizations/:id/invitations`, `invitations/accept`, `webhooks/clerk` |
| Fournisseurs | `supplier/profile`, `supplier/sites`, `supplier/members`, `supplier/onboarding`, `supplier/passport` |
| Produits | `products`, `products/:id/revision`, `/materials`, `/identifiers`, `/data-points` |
| Collecte | `data-requests`, `/items/from-template`, `/send`, `/submit`, `/remind`, `data-responses/:id/review` |
| Preuves & certifications | `documents/upload-intent`, `/download`, `/verify-ai`, `supplier/certifications`, `catalog/certification-standards` |
| Qualité | `quality/overview`, `quality/products/:id`, `quality-issues/:id/acknowledge`, `quality/caps` |
| Supply chain & traçabilité | `products/:id/supply-chain/*`, `traceability/lineage-graph`, `traceability/audit-chain`, `mass-balance/*` |
| DPP & wallets | `products/:id/dpp`, `dpp/:gtin`, `dpp/:gtin/apple-wallet`, `gs1/digital-link/:gtin` |
| Conformité | `products/:id/pef`, `products/:id/green-claims`, `catalog/audit-export` |
| Intégrations | `integrations/plm`, `integrations/ingest` (parsers Centric, Lectra, SAP, GS1 EPCIS) |
| Interne | `internal/notification-outbox/*` (worker, rappels, santé), `internal/p2/readiness`, `operations/overview` |

Les mutations sensibles passent par des fonctions SQL `SECURITY DEFINER`
(`tracefab_invite_supplier`, `tracefab_review_data_response`,
`tracefab_compute_dpp_readiness`, …) : l'API ne contourne jamais les
transitions d'état.

---

## Sécurité

- **Clerk** côté serveur : `verifyToken` + allow-list d'origines (`TRACEFAB_AUTHORIZED_PARTIES`).
- **RLS activée sur 45 tables, forcée sur 44** ; contexte utilisateur injecté par transaction (`tracefab.user_id`).
- **Documents privés** : URLs présignées SigV4 générées côté serveur, hash SHA-256, contrat antivirus, contrôle tenant au téléchargement.
- **Invitations** : token renvoyé une seule fois, seul le hash SHA-256 est stocké.
- **Notifications** : outbox transactionnelle, rappels planifiés (Vercel Cron), worker protégé par secret, Notification Observability (logs corrélés, alertes webhook timeout-safe).
- **Audit log** append-only (who / what / when / before / after).
- Headers stricts dans `vercel.json` (HSTS, CSP, nosniff, frame-deny…).
- Détails : `docs/architecture/02-multi-tenancy-and-security.md` et `docs/operations/production-hardening.md`.

---

## Dépendances externes (staging / production)

| Service | Variable(s) | État |
|---|---|---|
| PostgreSQL Neon | `DATABASE_URL` | Schéma déployable via Prisma |
| Clerk (auth) | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, webhook | À configurer en `pk_live_` |
| Email transactionnel | `RESEND_API_KEY`, `EMAIL_FROM`, `TRACEFAB_APP_URL` | Fallback manuel contrôlé si absent |
| Stockage privé S3 | `PRIVATE_STORAGE_*` | Contrat signé, bucket à provisionner |
| Scanner antivirus | `PRIVATE_STORAGE_ANTIVIRUS_URL/TOKEN` | Contrat HTTP à raccorder |
| Cron Vercel | `CRON_SECRET` | Route planifiée déclarée dans `vercel.json` |
| Alerte incidents | `TRACEFAB_NOTIFICATION_ALERT_URL/TOKEN` | Optionnel |

L'état réel de ces intégrations est vérifiable via `GET /api/internal/p2/readiness`.

---

## Ce qui reste à faire

Douze chantiers, chacun adossé à un constat vérifiable — détail et commandes
de vérification dans l'audit.

**Produit** — moteur de questions sur données réelles pour *TRACEFAB
Intelligence* (la vue sert aujourd'hui des données de démonstration) ·
passeports publics dynamiques (`dpp/index.html` ne contient aucun `fetch`,
alors que `/api/dpp/:gtin` existe) · command palette et recherche globale ·
centre de notifications in-app · carte géographique.

**Plateforme** — pagination et rate limiting API · CI GitHub Actions
(`.github/workflows/` n'existe pas encore).

**Infrastructure** — raccorder S3 privé, antivirus, Resend production et le
webhook d'alerte.

> L'externalisation des chaînes métier est **terminée** : la mesure du jour
> (`npm run test:copy`, 612 chaînes sur 9 pages) ne relève aucune copie non
> traduite hors invariants justifiés — marque, normes, toponymes, données de
> démonstration.

Feuille de route complète et chiffrée :
[`docs/audit/01-world-class-transformation-audit.md`](docs/audit/01-world-class-transformation-audit.md).

---

## Documentation

| Dossier | Contenu |
|---|---|
| `docs/architecture/` | 28 documents : modèle de données, multi-tenancy, RLS, API, collecte, qualité, traçabilité, DPP, stockage, notifications, Neon/Clerk… |
| `docs/experience/` | 26 documents : chantiers UX, personas, i18n, landing, bilans |
| `docs/operations/` | Durcissement production, réconciliation Neon |
| `docs/audit/` | État mesuré du dépôt et feuille de route (8 octobre 2026) |
| `TRACEFAB_MARKET_READINESS_AUDIT.md` | Audit de maturité du 6 octobre 2026 (source historique) |

---

*TRACEFAB — See it. Structure it. Verify it. Trace it. Prove it.*
