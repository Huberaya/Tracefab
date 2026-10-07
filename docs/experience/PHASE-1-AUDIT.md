# TRACEFAB — PHASE 1 · AUDIT UX / UI

**Date :** 2026-10-07
**Périmètre :** audit complet du dépôt avant toute modification.
**Règle appliquée :** on ne reconstruit rien à partir de zéro, on ne supprime rien, on ne touche pas au backend.

---

## 1. CE QUI EXISTE DÉJÀ (inventaire)

Le dépôt est **bien plus complet côté backend que côté expérience**. C'est le constat le plus
important de cet audit : TRACEFAB n'est pas un prototype à qui il manque des fonctionnalités — c'est
une plateforme profonde que son interface sous-représente.

### 1.1 Backend / plateforme de données — mature

| Domaine | Preuve dans le dépôt | État |
| --- | --- | --- |
| Surface d'API | `api/index.ts` + **124 modules de routes** dans `api/_routes/**` | Niveau production |
| Bibliothèques métier | **69 modules** dans `api/_lib/**` | Niveau production |
| Modèle de données | `prisma/schema.prisma` — **44 modèles, 26 enums** | Mature |
| Migrations | **32** migrations Prisma + 8 migrations Supabase historiques | Mature |
| Sécurité | `FORCE RLS`, durcissement security-definer, contrôle d'accès aux documents, synchro annuaire Clerk | Mature |
| Tests automatisés | **54** suites `scripts/test_*` câblées dans `npm test` | Mature |
| Catalogue i18n | `locales/{en,fr,de,it,es,nl,pt}/translation.json` — 143 clés chacun | Présent mais **périmé** |

Domaines fonctionnels confirmés comme déjà implémentés (et donc à préserver) : Brand Console ·
Portail Fournisseur · Onboarding et invitations fournisseurs · Produits et révisions produit ·
Matières · Fournisseurs et sites · Data Requests / Data Request Items / Data Responses · Points de
données structurés · Documents et stockage de preuves privé (intentions d'upload, scan antivirus,
quotas, téléchargement signé) · Certifications et catalogue de référentiels · Quality Center
(vue d'ensemble, qualité produit, qualité fournisseur, anomalies, plans d'action correctifs) ·
Traçabilité (nœuds et liens de chaîne, génération de baseline) · Enregistrements DPP, préparation,
revue de publication, GS1 Digital Link, Apple/Google Wallet · Outbox de notifications, ordonnanceur,
relances, observabilité · Multi-tenancy et organisations · Auth Clerk + webhooks · Neon/Prisma ·
Audit packs et coffre d'audit · Import/export en masse, importeur de nomenclatures, import/export de
catalogue · Vérification documentaire par IA · Ingestion PLM/ERP + GS1 · Moteur d'empreinte PEF ·
Moteur allégations vertes / anti-greenwashing · Bilan massique et certificats de transaction ·
Passeport Fournisseur Universel.

> **Rien de tout cela n'est recréé, remplacé ou supprimé.** La phase 2 et les suivantes ne font
> qu'ajouter une couche d'expérience par-dessus.

### 1.2 Front-end — c'est la couche faible

| Surface | Fichier | Taille | Verdict |
| --- | --- | --- | --- |
| Landing | `index.html` | 74 Ko, 100 % CSS/JS inline | À reconstruire (phase 3) |
| Brand Console | `brand-console/index.html` | 218 Ko en un seul fichier | À restyler (phase 5) |
| Portail Fournisseur | `supplier-portal/index.html` | 127 Ko en un seul fichier | À restyler (phase 6) |
| DPP public | `dpp/index.html` | 46 Ko | À restyler (phase 11) |
| Quality Center | `quality-center/index.html` | 15 Ko — **coque quasi vide (17 nœuds DOM)** | À construire (phase 8) |
| Operations | `operations/index.html` | 8 Ko — **coque quasi vide (17 nœuds DOM)** | À construire (phase 8) |
| Acceptation d'invitation | `invitations/accept/index.html` | 6,5 Ko | À conserver |
| App Next.js | `src/app/**` (Next 16 / React 19) | 5 fichiers | **Orpheline — voir 2.1** |

---

## 2. DÉFAUTS CRITIQUES IDENTIFIÉS

### 2.1 🔴 BLOQUANT — les assets du design system et de l'i18n sont **en 404 en production**

`vercel.json` déclare un tableau `builds` explicite :

```json
"builds": [ { "src": "api/index.ts" }, { "src": "**/*.html", "use": "@vercel/static" } ]
```

Quand `builds` est explicite, **seuls les fichiers correspondants sont déployés**. Tout ce qui n'est
ni un `.html` ni le point d'entrée de l'API est donc absent du déploiement. Vérifié en direct :

```
200  https://tracefab.vercel.app/
404  https://tracefab.vercel.app/i18n-engine.js
404  https://tracefab.vercel.app/auto-translate.js
404  https://tracefab.vercel.app/assets/design-system/tracefab-ds.css
200  https://tracefab.vercel.app/api/health
```

Conséquences :
* Tout le **moteur multilingue est mort en production** (`public/i18n-engine.js`,
  `public/auto-translate.js`, `public/translations_deep.json`).
* Le **CSS du design system partagé n'est jamais chargé** (`assets/design-system/tracefab-ds.css`) :
  chaque page redéclare donc sa propre copie inline des tokens — et elles ont déjà divergé
  (`#0b7656` dans le DS, `#163627` dans la landing, `#0d1610` dans l'app Next).
* Aucune couche CSS/JS partagée n'est possible tant que ce point n'est pas corrigé.

C'est la première chose que la phase 2 doit réparer.

### 2.2 🔴 L'intégrité linguistique est rompue

* `index.html` est en `<html lang="fr">` alors que le hero, la navigation et les CTA sont en anglais.
* La page mélange les langues **à l'intérieur d'un même scroll** : hero anglais → section WOW
  anglaise → « Planifiez des Chaînes Textiles Plus Intelligentes » en français → « Tout Ce Dont Vous
  Avez Besoin » → « Cartographiez Les Grands Hubs Textiles ».
* La Brand Console affiche une barre latérale anglaise avec un corps français (« Overview /
  Products » face à « Produits actifs / Demandes récentes / Actions rapides »), et le sélecteur de
  langue indique **English** alors que le contenu est en français.
* `locales/*/translation.json` décrit un hero *précédent* (`"Turn your textile supply chain into
  trusted data."`) qui n'existe plus dans le markup → le catalogue est orphelin.
* Seulement **42** points d'ancrage `data-i18n` dans une landing de 74 Ko : le contenu métier est
  codé en dur dans les composants, ce qui viole directement l'exigence « le contenu métier ne doit
  jamais être codé en dur ».

### 2.3 🟠 Défauts de contraste / lisibilité

La troisième section de la landing affiche un texte quasi invisible (titre gris foncé sur fond
quasi noir, mesuré largement sous le 4,5:1 du WCAG AA). Le motif de « titre fantôme » à faible
contraste est utilisé à plusieurs endroits comme décoration, alors qu'il porte du contenu.

### 2.4 🟠 Le hero ne représente pas une infrastructure

Le visuel de hero actuel est **une simple bande horizontale de 7 boîtes plates**. Pas de connexions,
pas de flux, pas de centre, pas de hiérarchie, pas de profondeur. Cela se lit comme une liste de
fonctionnalités, pas comme un noyau de données. L'exigence du brief — *« les données doivent sembler
circuler »* — n'est pas remplie.

### 2.5 🟠 Aucune architecture visible

Le modèle à 7 couches (Supply Chain → Product Data → Evidence → Data Quality → Traceability →
Intelligence → DPP) n'existe nulle part dans l'UI. Les couches sont évoquées sous forme d'étiquettes
dans la bande du hero (« LAYER 01 … LAYER 07 ») mais sans explication, sans progression, sans
exploration en profondeur — et la numérotation saute la couche 06.

### 2.6 🟠 Langage visuel « SaaS générique »

Trois sections consécutives utilisent le même motif : *sur-titre + titre centré + 3 cartes égales*.
Coins arrondis, ombres portées, cartes vertes en dégradé et badges façon emoji placent TRACEFAB dans
la catégorie « SaaS durabilité » générique plutôt que dans le registre Linear/Stripe/Attio. Le vert
d'accent est utilisé partout, il ne signale donc plus rien.

### 2.7 🟠 Les tableaux de bord ne ressemblent pas à un centre de contrôle

Les KPI de la Brand Console affichent `1`, `2`, `2`, `1` en mode démo, sans indication d'échelle,
sans tendance, sans dimension qualité, sans file d'attention. La densité d'information est une
fraction de ce que le backend sait déjà servir (`/api/operations/overview`, `/api/quality/overview`,
`/api/products/:id/dpp`, …).

### 2.8 🟡 Deux front-ends en parallèle

`src/app/**` est une app Next.js 16 / React 19 avec une route DPP et Tailwind 4 — mais `vercel.json`
ne la construit jamais, il n'y a ni script `dev` ni script `start`, et `npm run build` n'exécute que
`prisma generate && tsc --noEmit && schema:static`. L'app Next est du code mort aujourd'hui, tandis
que `dpp/index.html` sert le DPP en production. **Décision : la coque statique reste la référence ;
l'app Next est laissée intacte et non déployée jusqu'à ce qu'une phase ultérieure tranche son sort.**
Aucun fichier supprimé.

### 2.9 🟡 Les données de démonstration ne sont pas signalées de façon cohérente

Des chiffres comme `1,248`, `100%`, `SHA-256 SEALED`, `94.2% Documented` apparaissent sans marqueur
de démo sur la landing, alors que les consoles affichent bien une bannière de démo. Le brief exige
que les valeurs de démonstration soient *clairement identifiées comme telles* partout.

### 2.10 🟡 Base de référence performance & accessibilité

Mesuré en local (Chromium headless, 1440×900 et 390×844) :

| Route | Nœuds DOM | CSS inline | Chargement | Erreurs console |
| --- | --- | --- | --- | --- |
| `/` | 320 | 33,7 Ko | ~1,5 s | 404 sur `/i18n-engine.js` |
| `/brand-console/` | 170 | 17,6 Ko | ~1,4 s | 404 sur `/auto-translate.js` |
| `/supplier-portal/` | 136 | 12,4 Ko | ~1,4 s | 404 sur `/auto-translate.js` |
| `/dpp/` | 267 | 13,9 Ko | ~1,5 s | 404 sur `/auto-translate.js` |
| `/quality-center/` | 17 | 4,8 Ko | ~1,4 s | 404 + coque vide |
| `/operations/` | 17 | 2,5 Ko | ~1,4 s | 404 + coque vide |

Bonne nouvelle : aucun débordement horizontal, exactement un `<h1>` par page, aucune image cassée.
Mauvaise nouvelle : chaque page embarque une feuille de style inline dupliquée, chaque page tombe en
404 sur son runtime i18n, et deux pages sont vides.

---

## 3. LE TEST DES TROIS PERSONAS — BASE DE RÉFÉRENCE (avant)

| Persona | Question | Verdict aujourd'hui |
| --- | --- | --- |
| **CEO / Fondateur** | « Est-ce que je comprends la valeur en < 30 s ? » | ⚠️ En partie. L'accroche est forte, mais l'écran suivant est une bande de boîtes plates, puis une section au mélange de langues cassé. Aucune sensation d'échelle ni de système. |
| **Responsable durabilité / conformité** | « Est-ce que je vois la profondeur fonctionnelle ? » | ❌ Non. Rien sur la landing ne montre les preuves, les niveaux de vérification, les paliers de qualité de données, la préparation réglementaire ou les 7 couches. La vraie profondeur de la plateforme est invisible. |
| **Fournisseur** | « Est-ce que je sais immédiatement quoi faire ? » | ❌ Non. La landing ne s'adresse jamais aux fournisseurs. Le portail existe mais n'est ni accessible ni expliqué depuis le site. |

---

## 4. CE QUE VONT FAIRE LES PHASES 2 & 3

1. **Réparer le déploiement des assets statiques** (`vercel.json`) pour qu'un véritable design system
   partagé puisse exister.
2. **Créer `tracefab-core.css`** — une couche de tokens propriétaire (couleur, typo, espace, grille,
   animation, échelle de confiance) remplaçant les copies inline page par page, plus
   `tracefab-site.css` pour les composants de la landing.
3. **Créer un runtime i18n natif** (`tf-i18n.js` + `assets/i18n/*.json`) dans lequel **aucun contenu
   métier n'est codé en dur** : EN · FR · DE · IT · ES · NL dès le premier jour.
4. **Reconstruire** le header, le hero, le visuel d'infrastructure de données du hero et la première
   section WOW (graphe d'écosystème interactif), plus la colonne vertébrale architecturale à 7
   couches et un vrai pied de page.
5. **Archiver** — et non supprimer — la landing précédente dans `archive/index.legacy.html`.

Les phases 5 à 12 (dashboard, product intelligence, portail fournisseur, collecte de données,
preuves, qualité, traçabilité, DPP, DPP public, déploiement i18n) ne suivront **qu'après
validation**, conformément au processus imposé.

---

## 5. CONTRAINTES NON NÉGOCIABLES REPORTÉES SUR TOUTES LES PHASES

* Ne pas modifier `api/**`, `prisma/**`, `supabase/**`, `catalog/**`.
* Ne pas changer les contrats d'API ni les noms de routes. Les `routes` et les `crons` de
  `vercel.json` restent intacts ; seul le tableau `builds` gagne des entrées d'assets statiques.
* Garder `npm test` au vert (`typecheck`, `api:typecheck`, `schema:static`, 54 suites).
* Tout chiffre de démonstration doit être visiblement étiqueté comme donnée de démonstration.
* La préparation DPP est toujours décrite comme un **indicateur de préparation**, jamais comme une
  certification juridique.
