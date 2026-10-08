# Chantier 04 — Application Shell (palette de commandes, recherche globale, notifications)

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif

Donner aux deux applications (Brand Console, Supplier Portal) une couche
d'expérience commune de niveau produit : palette de commandes Ctrl/Cmd+K,
recherche globale (navigation, actions, entités) et centre de notifications
avec badge de comptage — sans casser aucun comportement existant.

## Principes directeurs

1. **Le shell n'invente rien.** Il ne fait aucun appel réseau. Il ne lit que
   l'état déjà chargé par l'application hôte (`window.tracefabBrandConsole`,
   `window.tracefabSupplierPortal`). Aucune donnée fictive, aucun risque de
   présenter une donnée inexistante comme réelle.
2. **Additif uniquement.** Aucun code existant supprimé ; les objets exposés
   par les deux SPAs sont étendus (jamais réduits) ; l'i18n est injecté par
   un générateur idempotent, borné à son namespace `shell`.
3. **Hors des zones re-rendues.** Les overlays (palette, panneau
   notifications) sont accrochés une seule fois à `<body>` ; les boutons
   déclencheurs vivent dans la topbar (re-rendue) mais leurs gestionnaires
   sont des listeners délégués au niveau `document`, donc survivent au
   re-rendu.
4. **i18n complet, FR irréprochable.** 29 clés `shell.*` en EN/FR/DE/IT/ES/
   NL/PT. TR/ZH (locales partielles) restent exclues du namespace — repli
   anglais automatique via tf-i18n.
5. **Accessibilité.** Rôles ARIA combobox/listbox, navigation clavier
   (flèches, Entrée, Échap), focus piégé et restitué, badge porteur
   d'`aria-label`, respect de `prefers-reduced-motion`.

## Ce qui existait avant

- Brand Console : topbar avec sélecteur de langue/organisation et bouton
  « New request » ; exposition minimale `window.tracefabBrandConsole =
  { state, sync }` ; aucune recherche globale, aucune palette, aucun centre
  de notifications (les alertes n'existaient que sous forme de colonnes de
  tableaux).
- Supplier Portal : idem, exposition `{ state, sync, render, goView }`,
  demandes visibles uniquement dans la vue Requests ; fin de fichier HTML
  corrompue (fragments `</script></body></html>` dupliqués, hérités du dépôt).
- tf-i18n.js : runtime consolidé avec aplatissement des objets imbriqués et
  garde de consolidation des générateurs (test_i18n_consolidation.mjs).

## Ce qui a été ajouté

| Fichier | Rôle |
| --- | --- |
| `assets/js/tf-shell.js` | Bibliothèque TFShell : palette (sections Navigation / Actions / Recherche, filtrage insensible aux accents), centre de notifications (sévérités critical/warning/info, actions contextuelles), badge compteur auto-rafraîchi (4 s), raccourci Ctrl/Cmd+K global, délégation `[data-shell-open]` / `[data-shell-badge]`, garde anti double-initialisation. |
| `assets/design-system/tracefab-shell.css` | Styles `.tfsh-*` : overlays sombres (z-index 9600), entrées de liste, badges, déclencheurs topbar, responsive mobile plein écran, `prefers-reduced-motion`. |
| `scripts/_chantier04_shell_i18n.json` | Source unique des 29 clés × 7 langues. |
| `scripts/build_shell_i18n.mjs` | Générateur additif/idempotent : insère le bloc `shell` dans `en.js` et l'écrit dans les 6 locales complètes ; refuse toute clé manquante/superflue ; aucun motif de suppression (compatible garde de consolidation). |
| `scripts/test_shell_chantier4.mjs` | Test de contrat (voir ci-dessous). |
| `package.json` | Script `test:shell:chantier4` ajouté à la chaîne `npm test`. |

## Ce qui a été modifié

- **brand-console/index.html**
  - Chargement de `tracefab-shell.css` (avant `tracefab-touch.css`, qui doit
    rester chargé en dernier) et de `tf-shell.js`.
  - Topbar : deux déclencheurs (palette ⌘K + cloche avec badge) ajoutés
    avant le sélecteur de langue.
  - Exposition étendue : `{ state, sync, render, openProduct, openSupplier,
    openRequest }`.
  - Script de câblage `wireShell()` : navigation (17 vues), actions
    (nouvelle demande, nouveau produit, invitation fournisseur — ouverture
    des modales existantes via `state.modal`), entités (produits,
    fournisseurs, demandes), notifications dérivées des demandes :
    échéance dépassée → critique ; échéance ≤ 72 h → avertissement ;
    statut `submitted` → info « réponse à contrôler ».
- **supplier-portal/index.html**
  - Mêmes chargements CSS/JS et mêmes déclencheurs topbar.
  - Exposition étendue : `{ state, sync, render, goView, openRequest }`.
  - Câblage : navigation (12 vues), entités (demandes, matières,
    certifications, documents), notifications : demandes `in_progress`
    (réponse attendue), échéances dépassées (critique), certifications
    expirant sous 60 jours (avertissement), CAP ouverts (avertissement).
  - Nettoyage des fragments parasites en fin de fichier (aucun contenu
    utile supprimé).

## Ce qui a été supprimé

Rien, hormis les 6 fragments HTML parasites (`</script></body></html>`,
`body></html>`) en fin de `supplier-portal/index.html` — aucun effet
fonctionnel, défaut hérité du dépôt.

## Contrats vérifiés par `scripts/test_shell_chantier4.mjs`

1. Bibliothèque : aucun `fetch`/XHR/axios/`import()`, API `init/refresh`,
   déclencheurs délégués, Ctrl/Cmd+K, Échap, badges.
2. CSS : classes `.tfsh-*` et `prefers-reduced-motion`.
3. Intégration console/portail : chargements, déclencheurs, hooks exposés,
   câblage `TFShell.init`.
4. Honnêteté des providers : aucun appel réseau dans les blocs de câblage,
   lecture exclusive de `state.*`.
5. i18n : 29 clés × 7 langues paritaires ; bloc présent dans `en.js` et les
   6 locales complètes ; TR/ZH exclus.
6. Générateur : idempotent (seconde exécution sans effet), compatible avec
   la garde de consolidation.

## Non-régression

- `npm run test:i18n` vert : parité stricte 2185 clés × 6 locales, garde
  générateurs OK.
- Matrice hors-ligne : **21/23 suites PASS**. Les 2 échecs
  (`test:wallet:chantier9`, `test:storage:chantier10`) proviennent de
  l'impossibilité de générer le client Prisma dans la sandbox
  (`binaries.prisma.sh` bloqué) — échec identique sur le commit de base,
  sans lien avec ce chantier.
- Aucune route API, aucune migration, aucun schéma modifiés : auth,
  invitations fournisseurs, demandes de données, documents, certifications,
  qualité, traçabilité, DPP et isolation tenant sont intacts.

## Limitations connues

- Les notifications sont dérivées de l'état chargé au moment du
  rafraîchissement du badge (4 s) ; il n'y a pas de push temps réel
  (websockets/SSE) — hors périmètre, à traiter avec le chantier
  « Notification Observability ».
- La recherche d'entités est volontairement limitée aux collections déjà en
  mémoire ; pas de recherche serveur.
- TR/ZH utilisent le repli anglais pour `shell.*` (politique locales
  partielles existante).

## Prochaine étape suggérée

Chantier 05 du programme de transformation (à confirmer avec l'utilisateur) :
poursuite selon la roadmap du rapport d'audit
(`docs/audit/01-world-class-transformation-audit.md`).
