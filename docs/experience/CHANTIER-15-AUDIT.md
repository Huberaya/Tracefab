# Chantier 15 — i18n complet : audit & plan (mis à jour après livraison)

> Audit exécuté le 2026-10-08 sur instruction utilisateur. Dépendance 04 déjà
> livrée. L'utilisateur a demandé le chantier 15 avant les chantiers 13–14 ;
> ces derniers restent donc à faire.

## A. Audit

### A.1 Infrastructure existante (réelle)
- `assets/js/tf-i18n.js` : moteur opérationnel, sept locales complètes
  (`en/fr/de/it/es/nl/pt`), détection `?lang=`/stockage, fusion des bundles,
  `data-i18n`, `data-i18n-html`, `data-i18n-attr`, `meta.*`, garde
  `TF_I18N_SKIP_META` pour les SPA.
- `assets/i18n/en.js` + six JSON : environ 2 600 clés à parité stricte ; les
  namespaces des chantiers 03→12 existent déjà. Les vues principales de
  console, portail, DPP, passeport, site et quality center utilisaient
  largement ces catalogues depuis les chantiers antérieurs.
- `tr.json` / `zh.json` : 412 clés seulement (environ 16 % du catalogue)
  exposées au portail comme locales complètes. Le reste de l'application
  retombait en anglais sans avertissement. Des tables `BCP47` conservaient
  aussi ces deux locales retirées.
- Estimate initial de l'audit global : environ 466 littéraux avant les
  chantiers d'expérience 02→12. Cet estimate était historique, pas le nombre
  résiduel du présent chantier : les remplacements `bt()`/`t()` des chantiers
  antérieurs avaient déjà localisé la grande majorité de ces vues.

### A.2 Derniers écarts réellement observés
L'analyse du HTML produit et de ses templates a repéré notamment :
- Brand Console : labels de tableau/formulaire, empty state, progression,
  actions Ouvrir/Acquitter/Valider, métadonnées produit, `MISSION CONTROL`
  anglais, tagline de cycle de données, identité/logos de SPA, notification
  d'import catalogue ; plusieurs anciens fallbacks `bc()` / `tcc()` / `ia()`
  recopiant les chaînes en dur malgré des clés déjà complètes.
- Supplier Portal : compteurs, labels, dates, notifications avec variables,
  choix Oui/Non/Choisir, état « demande introuvable », identité de SPA.
- Quality Center : description anglaise/française incohérente, label de marque.
- Operations, Product Intelligence et Accept Invitation : identités de SPA ou
  métadonnées qui héritaient du titre/description de la landing, ou restaient
  en anglais.
- Pages marketing profondes : titres/descriptions EN figés, le mécanisme de
  métadonnées générique pointait vers la landing.
- DPP et Supplier Passport : métadonnées déjà localisées par les namespaces
  `dpp` et `passport` ; leur mécanisme existant a été conservé.

### A.3 Verdict
| Surface | Avant | Après |
|---|---|---|
| Runtime de traduction | REAL, 7 langues complètes | Inchangé + `TF_I18N_PAGE_META` |
| tr / zh | PARTIELLES (16 %), annoncées au portail | Retirées honnêtement ; aucune sélection, aucune génération |
| Textes métier de l'interface ciblés | Quelques labels, compteurs, notifications et fallback literals restants | 93 nouvelles clés console/portail + 1 clé QC ; fallbacks dupliqués supprimés |
| Métadonnées page/SPA | Mix EN, description FR, titre de landing hérité | Localisées sur les pages auditées |
| Copy des données démo | Données d'exemple codées, identités d'organisations | Conservées comme données de démo ; noms de pays formatés selon la locale |

## B. Changements décidés et livrés

1. `tf-i18n.js` : nouveau crochet `window.TF_I18N_PAGE_META = { title,
   description }`, évalué au boot et à chaque changement de langue ; le repli
   existant `meta.title/meta.description` et `TF_I18N_SKIP_META` sont préservés.
2. `siteMeta.*` : title+description pour Platform, Security, Resources, About,
   Contact ; déclarations avant le runtime.
3. `appMeta.*` : métadonnées de Brand Console, Supplier Portal, Quality Center,
   Operations, Product Intelligence et Accept Invitation ; labels de marque
   localisés pour Operations, Invitation et Supplier Passport. DPP et Supplier
   Passport gardent leurs métadonnées `data-i18n*` existantes.
4. Namespace `i18n15` **118 clés × 7 langues** : `siteMeta` 10, `appMeta` 14,
   `console` 57, `portal` 36, `qc` 1. Source unique
   `scripts/_chantier15_i18n.json`, générateur idempotent
   `scripts/build_i18n_chantier15.mjs`.
5. Helpers `b15(key, vars)`, `s15(key, vars)`, `q15(key)` et `o15(key)` ; labels
   et notifications avec interpolation localisée. Les fallbacks inline redondants
   de 57 `bc()`, 35 `tcc()` et 26 `ia()` call sites ont été retirés : les clés
   existent dans les catalogues complets, et en cas d'absence le helper retombe
   sur l'identifiant de clé, pas sur une chaîne métier cachée.
6. Suppression de tr/zh (option explicitement prévue par la feuille de route) :
   `assets/i18n/tr.json` et `zh.json` supprimés ; options portail et
   `TF_I18N_SUPPORTED` étendu retirés ; maps `BCP47` ramenées aux sept langues ;
   les noms de pays de la démo console viennent désormais de
   `Intl.DisplayNames(locale)`, pas d'une liste française figée.
7. Tous les générateurs i18n ne produisent plus que les sept langues complètes,
   dont `build_app_i18n.mjs` et `build_portal_overview_i18n.mjs`. Les contrats
   des chantiers 04→12 vérifient désormais l'absence des locales retirées.

## C. Fichiers

- Runtime/UI : `assets/js/tf-i18n.js`, `brand-console/index.html`,
  `supplier-portal/index.html`, `quality-center/index.html`,
  `operations/index.html`, `product-intelligence/index.html`,
  `invitations/accept/index.html`, `passport/index.html`,
  `platform|security|resources|about|contact/index.html`.
- Catalogues et source : `assets/i18n/en.js` + `fr/de/it/es/nl/pt.json`,
  suppression `assets/i18n/tr.json` + `zh.json`,
  `scripts/_chantier15_i18n.json`.
- Génération/tests : `scripts/build_i18n_chantier15.mjs`,
  `scripts/build_app_i18n.mjs`, `scripts/build_portal_overview_i18n.mjs`,
  `scripts/test_i18n_consolidation.mjs`, contrats des chantiers 04–12,
  `scripts/test_i18n_chantier15.mjs`, `package.json`.
- Documentation : ce rapport, `CHANTIER-15-I18N-COMPLETE.md`.
