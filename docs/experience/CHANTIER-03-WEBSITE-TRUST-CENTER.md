# Chantier 03 — Website & Trust Center

_8 octobre 2026 · branche `arena/df246958-tracefab`._

## Objectif

Donner au site public la profondeur que promet la landing : pages Platform /
Security / Resources / About / Contact, narration « fragmentation →
intelligence layer », et **capture réelle des leads** (le modal démo de la
landing affichait un succès factice sans rien transmettre).

## Ce qui existait

- Landing premium une-page ; son footer « Resources » pointait vers des
  fichiers `.md` **non servis** par `vercel.json` (404 en production).
- Modal « Request a demo » : succès simulé côté client, zéro backend.
- Namespace i18n mature (7 langues complètes, parité testée).

## Ce qui a changé

### 1. Cinq pages publiques

`/platform/` (huit piliers + « how it works »), `/security/` (Trust Center :
isolation RLS, auth serveur, stockage privé, statuts de donnée, audit log,
pipeline notifications, edge durci, « readiness, jamais certification »),
`/resources/` (neuf sujets clés), `/about/` (mission, Europe/Global,
signature en cinq verbes, rôles), `/contact/` (trois portes d'entrée +
formulaire réel). Shell commun : header avec sélecteur de langue, footer
brand, SEO complet (canonical, hreflang 7 langues, OG, JSON-LD), design
system v3, touch.css en dernier.

### 2. Capture réelle des leads

- Migration additive `20261008100000_website_leads` : table pré-tenant
  `tracefab_leads`, RLS forcée, write-only (insertion sous
  `tracefab.public_ingest`, lecture réservée au contexte worker), bornes
  CHECK sur toutes les colonnes, aucune IP/header persisté.
- Route `POST /api/leads` (enregistrée dans `api/index.ts`) : validation
  stricte, rate limiting best-effort par IP, notification Resend
  opportuniste vers `TRACEFAB_LEADS_NOTIFICATION_EMAIL`.
- Landing : le modal poste réellement (`kind=demo`), avec état busy, erreur
  affichée (`role=alert`) et succès sincère ; la phrase « formulaire non
  connecté » disparaît d'`index.html` et des sept catalogues.
- Contact : intérêt « démo / pilote / autre » → `kind` demo/pilot/contact.

### 3. i18n

Nouveau namespace `site.*` (136 clés × 7 langues) injecté par
`scripts/build_site_i18n.mjs` (idempotent, parité vérifiée à la source).
Locales partielles tr/zh : repli anglais, aucune clé ajoutée (la parité
testée ne les concerne pas). Valeurs `modal.successTxt/sending/errorTxt` et
`footer.resources1..4` mises à jour dans les sept catalogues.

### 4. Socle

`sitemap.xml` étendu (5 nouvelles URLs), `.env.example` documenté,
README/footer cohérents, doc architecture n°29.

## Ce qui n'a PAS changé

Aucune page applicative (consoles, portail, DPP) touchée ; aucun contrat
d'API existant modifié ; la landing ne change ni de structure ni de tests.

## Vérifications

Matrice offline : **32/32 PASS** (dont le nouveau
`test:website:chantier3` — 70+ assertions : route, migration, pages, SEO,
modal, i18n, sitemap). `leads.ts` et `email.ts` compilent sans erreur ; les
erreurs résiduelles d'`api:typecheck` dans ce sandbox proviennent du client
Prisma non générable ici (binaires hors réseau) et touchent l'arbre API
préexistant de façon identique.

Non exécutable ici : rendu navigateur des cinq pages (Playwright absent).

## Résiduel

- Le volet « demande de démo bookable sur créneau » (calendrier) n'existe
  pas : la promesse est « nous revenons vers vous », tenue par l'email.
- Les pages resources décrivent des sujets de lecture ; les contenus longs
  (articles) sont un chantier éditorial ultérieur (Chantier 19).
- Rate limiting distribué : Chantier 16.
