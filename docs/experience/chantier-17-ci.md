# Chantier 17 — Tests E2E & CI

**PR #29** · branche `experience/chantier-17-ci` · commit `03d89d1`
**CI verte sur les runners GitHub**, les quatre étages, exécution #2.

---

## Pourquoi ce chantier passait en premier

Vous aviez trois PR empilées — #26, #27, #28 — validées à la main, une fois,
sur ma machine. Aucune preuve reproductible. Le dépôt ne contenait **aucun
`.github/`** : les 63 suites, la compilation, les types, l'audit end-to-end,
les personas et les phases 9-12 existaient tous, et ne tournaient que si
quelqu'un y pensait.

C'était l'erreur de séquencement la plus coûteuse du plan. Elle est fermée.

---

## Ce qui tourne maintenant à chaque poussée

| Étage | Contenu | Durée |
|---|---|---|
| **Socle** | types, types API, isolation multi-locataires | 27 s |
| **Vérification** | `build` complet + les 63 scripts `test:*` | 208 s |
| **Parcours** | 20 parcours navigateur, 3 personas, phases 9-12 | 107 s |
| **Base** | scénarios RLS réellement exécutés | 11 s |

Les trois derniers étages tournent **en parallèle** après le socle : le chemin
critique est d'environ **3 minutes 30**. `concurrency` annule l'exécution
précédente sur la même référence.

Deux choix de conception méritent un mot :

- **L'échec le plus probable tombe le plus vite.** Les types et l'isolation
  passent avant tout le reste. Inutile d'attendre trois minutes pour apprendre
  qu'une virgule manque.
- **L'étage base se saute si `DATABASE_URL` est absent**, au lieu de rougir.
  Une CI qui rougit pour une raison étrangère au code finit par être ignorée.

---

## Les 20 parcours end-to-end

Non mockés : les pages réelles, servies avec les réécritures de `vercel.json`,
le vrai JavaScript applicatif, aucun stub de rendu. **Chaque parcours échoue
aussi sur la moindre erreur JavaScript console** — un écran qui s'affiche en
crachant dans la console n'est pas un écran qui marche.

**Accueil** — promesse et colonne vertébrale 7 couches · ancres de navigation
qui résolvent · le CTA engage réellement le parcours · mobile 390 px sans
débordement · bascule FR sans fuite de clé brute.

**Console** — compteurs Overview · les 17 vues · catalogue vers fiche produit ·
fournisseurs vers profil · la question de confiance · portefeuille DPP avec son
avertissement de non-certification · un écart qui mène à son écran de
correction · cohérence entre portefeuille et détail · lignée Fibre vers DPP en
8 étapes.

**Passeport public** — mode démo assumé sur `/dpp/` · hydratation réelle sur
`/p/<gtin>` · route `/dpp/<gtin>` ajoutée au chantier 14.

Le script démarre son propre serveur s'il n'en trouve pas : utilisable seul,
sans cérémonie.

---

## L'audit d'isolation multi-locataires

Les **125 routes** de `api/index.ts` doivent déclarer leur modèle d'accès :
locataire, publique, worker, webhook ou référentiel. Chaque exemption porte sa
justification écrite dans le fichier.

**Une route ni classée ni authentifiée fait échouer la CI.** C'est la vraie
protection. Le danger n'a jamais été qu'un maillon casse — c'est qu'une route
nouvelle arrive sans la chaîne, un vendredi soir, sans que personne ne le voie.

Répartition constatée : 102 locataire · 10 publiques · 7 référentiel ·
5 worker · 1 webhook. Verrou base : 45 `ENABLE` / 49 `FORCE ROW LEVEL SECURITY`
sur 32 migrations.

### Un point de méthode que je dois vous dire

Ma première version cherchait la colonne `brand_organization_id` dans le code
des routes. Elle a signalé **36 fuites. Toutes fausses.**

L'isolation de TRACEFAB n'est pas dans la requête, elle est dans Postgres :
`withTracefabUserContext` ouvre une transaction et y arme `tracefab.user_id`,
que les politiques RLS lisent. Une route qui écrit
`where: { supplier_id: supplier.id }` est parfaitement protégée sans jamais
nommer la colonne que je cherchais.

J'ai donc changé l'invariant testé : **l'armement de RLS et l'absence de client
`prisma` brut**, pas la présence d'une chaîne de caractères. Puis j'ai inséré
une route piège pour vérifier que le garde-fou mord — il mord sur les quatre
contrôles.

Un test qu'on n'a jamais vu échouer ne prouve rien.

---

## Un correctif que je n'avais pas prévu

`test_brand_console_browser`, `test_quality_center_browser` et
`test_supplier_portal_browser` servaient les pages avec `python3 -m http.server`.

Ce serveur **ignore `vercel.json`**. Ces trois tests validaient donc un routage
qui n'existe pas en production — exactement le défaut que j'avais corrigé au
chantier 14 sur le serveur de prévisualisation, resté tapi dans les tests. Ils
passent désormais par `dev_static_server.mjs`.

---

## Deux défauts trouvés, volontairement non corrigés

La CI a fait son travail dès le premier jour : elle a trouvé deux choses que
personne ne regardait. Je ne les ai pas corrigées parce que l'une demande votre
arbitrage et l'autre touche un territoire partagé.

### 1. La même métrique affiche deux valeurs

| | Qualité des données | Couverture preuves | Vérifié | Traçable |
|---|---|---|---|---|
| **Votre cahier** | 92,4 % | 84 % | 78 % | 91 % |
| **Page d'accueil** | 92,4 % | — | — | — |
| **Console Overview** | **91,4 %** | 85,3 % | 77,9 % | 91,8 % |

Un dirigeant lit 92,4 % sur l'accueil, ouvre la console, lit 91,4 %. C'est
exactement le genre de détail qui coûte la confiance qu'on a mis une page
entière à construire.

L'origine n'est pas un typo. Le commit `193a905` — « la vue d'ensemble compte ce
qui existe vraiment » — a rendu l'Overview **calculé** depuis le jeu de démo :
moyenne de `dataQuality: 85 + random*15` sur les fournisseurs. La décision est
défendable, elle est même meilleure en principe. Mais elle n'a pas été
répercutée sur l'accueil, et les cinq indicateurs dérivent tous du cahier.

**Deux sorties possibles**, et c'est un arbitrage produit, pas technique :

- **Calibrer le jeu de démo** pour que le calcul retombe sur vos chiffres. C'est
  ce que j'ai fait au chantier 13 pour verrouiller le 88,0 % du DPP.
- **Aligner l'accueil sur le calcul** et accepter que vos chiffres de cahier
  étaient des cibles illustratives.

### 2. Copie française codée en dur dans la lignée produit

```html
<div class="lineage-step-label">02. FILATURE</div>
```

Pas de `data-i18n`. Sur une console dont la langue source est l'anglais, et que
le chantier 15 était censé avoir purgée. Les huit étapes sont concernées, et
les sous-titres mélangent les langues : « Ferme GOTS », « Bilan Massique », puis
« Certified Workshop », « GS1 Link ».

Le plus gênant n'est pas la faute, c'est que **`test:copy` est vert**. La garde
anti-copie-codée-en-dur ne navigue jamais dans les vues de détail : elle ne voit
que ce qui s'affiche au premier écran. C'est précisément la critique que je vous
avais faite sur le chantier 15 — « le vrai reste à faire, c'est la copie des vues
où il faut cliquer pour arriver » — et la voici confirmée par un autre chemin.

Le correctif tient en deux temps : étendre la garde pour qu'elle descende dans
les vues navigables, puis traduire ce qu'elle trouvera. Je ne l'ai pas fait ici
pour ne pas mélanger un chantier d'outillage avec un chantier de contenu.

---

## État de la pile

Quatre PR ouvertes, **à fusionner dans cet ordre** :

```
main 7cfc669
 └── #26  experience/chantier-15-i18n              3273913
      └── #27  experience/chantier-13-dpp-actionable    a07d704
           └── #28  experience/chantier-14-passeport-dynamique  2c65e7a
                └── #29  experience/chantier-17-ci            03d89d1
```

La CI s'applique désormais aux quatre : chaque poussée sur n'importe quelle
branche déclenche les quatre étages.

---

## Également livré dans #28 : l'arbitrage `src/`

Votre décision appliquée, commit `2c65e7a`, **17 fichiers, −1 691 lignes**.

Supprimé : `src/app/` (5 fichiers), `src/components/dpp/` (7 composants),
`next.config.mjs`, `next-env.d.ts`. Dépendances retirées : `next`, `react`,
`react-dom`, `@types/react`, `@types/react-dom`. `tsconfig.json` nettoyé de ses
globs `.next/**`, qui ne résolvaient plus rien.

Conservé : les 9 modules de `src/domain/tracefab/`.

**Point d'honnêteté.** Ces 9 modules ne sont importés par **aucun** fichier du
dépôt : ni les coques HTML, ni `api/`, ni les scripts. C'est du code mort que
`tsc` typecheck sans que rien ne l'exécute. Les conserver est un pari sur leur
réutilisation, pas la préservation d'une fonctionnalité vivante. Si le
chantier 16 ne les recycle pas, la question se reposera.
