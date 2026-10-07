# Consolidation i18n

Chantier 6 du reste-à-faire. Branche `merge/experience`.

---

## Ce que c'était

Trois catalogues concurrents, plus un quatrième déjà retiré avant mon
intervention (un `auto-translate.js` qui réécrivait le DOM et produisait une
interface à moitié traduite — un commentaire dans les deux SPA en garde la
trace, et il m'a servi d'avertissement).

| Catalogue | Contenu | Consommateur |
|---|---|---|
| `assets/i18n/` + `tf-i18n.js` | 549 clés × 7 locales | landing, product-intelligence |
| `brandTranslations` inline | 7 langues × 55 clés, 15 Ko | brand-console |
| `translations` inline | 9 langues × 55 clés, 19 Ko | supplier-portal |
| `dppLangs` inline | 7 langues × ~71 clés | dpp public |
| `locales/<lang>/translation.json` | 7 langues, ~65 Ko | **aucun** |

## Ce que c'est devenu

Un seul catalogue, `assets/i18n/`, servi par le runtime qui existait déjà,
`assets/js/tf-i18n.js`. La console et le portail le consomment désormais.

    assets/i18n/en.js        référence, chargée en synchrone
    assets/i18n/<lang>.json  625 clés — les 549 d'origine + 76 applicatives
    assets/i18n/tr.json      55 clés — portées servies au portail
    assets/i18n/zh.json      55 clés — idem

## Trois défauts réels corrigés au passage

Ce ne sont pas des améliorations cosmétiques : chacun était visible par un
utilisateur.

**1. La langue était perdue entre la vitrine et l'application.** La landing
écrivait `tracefab.lang`, les trois SPA lisaient `tracefab_lang`. Un point
contre un tiret bas. Choisir l'italien sur la page d'accueil puis entrer
dans la console ramenait à l'anglais. Le runtime écrit maintenant une clé
canonique, reprend l'ancienne si elle existe, et maintient un miroir
transitoire pour tout lecteur non encore migré.

**2. Le portail repliait en français.** Sa résolution était
`translations[lang]?.[key] || translations['fr'][key]`. Comme le portugais,
le turc et le chinois ne couvraient que 25 clés sur 55, un fournisseur turc
voyait **du français** sur les 30 clés manquantes. Le repli est désormais
anglais, conformément à la langue source du produit, et les 30 clés ont été
traduites dans les trois langues.

**3. Un changement de langue ne redessinait pas l'interface.** Les SPA ne se
re-rendaient que si l'on passait par leur propre sélecteur. Un changement
venu d'ailleurs — la landing, un autre onglet — laissait l'écran dans
l'ancienne langue. Les deux applications écoutent maintenant
`tf:languagechange`, ce qui donne un chemin de rendu unique quelle que soit
l'origine du changement. **Ce défaut n'a pas été trouvé par relecture : il a
été trouvé parce que le test vérifie le DOM rendu et pas seulement la
fonction de traduction.** Le premier jet passait tous les contrôles sauf
celui-là.

## Le choix de conception qui rend la migration sûre

Les noms de clés d'origine sont **conservés**, seule une portée est
préfixée. Les quelque 700 sites d'appel `bt('stDraft')` et `t('sites')` ne
sont pas touchés : seule l'implémentation du résolveur change.

```js
function bt(key) {
  const T = window.TF_I18N;
  if (!T) return key;
  return T.t('console.' + key, null) || T.t('shared.' + key, key);
}
```

Trois portées :

| Portée | Clés | Rôle |
|---|---|---|
| `shared` | 34 | 29 libellés de statut + 5 libellés communs |
| `console` | 21 | propres à la console |
| `portal` | 21 | propres au portail |

Les portées ne sont pas décoratives. Trois clés sont homonymes mais de
valeur différente selon le contexte : `materials` vaut « Materials » côté
marque et « Materials & Yarns » côté fournisseur ; de même pour `quality` et
`documents`. Les fusionner aurait silencieusement changé la copie d'une des
deux applications. Les séparer était la seule option correcte.

## Deux pièges évités

**Le titre de page.** `tf-i18n.js` applique `meta.title` à chaque changement
de langue. Branché tel quel, il aurait donné le titre de la landing à la
console et au portail. D'où le drapeau `TF_I18N_SKIP_META`, que le test
vérifie.

**Les tests qui lisent le HTML.** Plusieurs tests assertent des chaînes
littérales dans `brand-console/index.html` et `supplier-portal/index.html`.
Supprimer 34 Ko de dictionnaire pouvait les casser. J'ai vérifié avant :
`Rapports & Audits`, `Partages actifs`, `Soumettre à la marque` et
`Dérogation` existent ailleurs dans les pages, en dur. Aucun test n'a bougé.

## Vérification

`npm run test:i18n` (`scripts/test_i18n_consolidation.mjs`), ajouté à
`npm run build`. Il contrôle quatre propriétés, dont deux dans un vrai
navigateur :

    ok  catalogue EN : 625 cles
    ok  fr, de, it, es, nl, pt : parite stricte avec EN (625 cles)
    ok  tr, zh : portees shared+portal completes (55 cles, repli EN ailleurs)
    ok  aucun dictionnaire inline dans les deux SPA
    ok  console : fonds commun traduit (shared.stDraft = Entwurf)
    ok  console : portee propre traduite (console.reports = Berichte & Audits)
    ok  console : le DOM rendu est bien en allemand
    ok  console : titre de page preserve apres changement de langue
    ok  console : les deux cles de stockage sont synchronisees
    ok  continuite : la langue de la landing est reprise par la console
    ok  portail : le turc est servi (shared.stDraft = Taslak)

Sans navigateur ou sans serveur, les contrôles navigateur sont **ignorés et
signalés**, jamais silencieusement comptés comme réussis.

Non-régression : 32 tests sur 33 passent, plus `typecheck`, `api:typecheck`
et `schema:static`. Le seul échec reste `test:supplychain:chantier3`,
identique sur `origin/main`.

## Reproductibilité

    npm run i18n:build          # régénère les portées applicatives
    node scripts/build_app_i18n.mjs --check   # signale les écarts sans écrire

Le script liste les traductions absentes plutôt que de les masquer. Il
signale aujourd'hui 42 clés `console.*` absentes en turc et en chinois :
c'est volontaire et sans effet, la console n'offrant que 7 langues.

## Ce que cela ne règle pas

La capture `.visual/i18n/brand-console-de.png` le montre mieux qu'un
paragraphe : en allemand, la **navigation** est entièrement traduite
(Übersicht, Lieferanten, Rückverfolgbarkeit, Berichte & Audits) alors que le
**corps de page** reste français — « Centre de Pilotage Opérationnel »,
« Points d'Attention », « Demandes de données récentes ».

C'est le chantier 7, distinct : ~379 chaînes en dur dans la console, ~304
dans le portail, ~71 dans le DPP public. La consolidation était le
préalable — les extraire avant aurait signifié alimenter trois
dictionnaires concurrents.

Restent aussi hors périmètre, et documentés dans le suivi :

- **`dppLangs`**, le dictionnaire du DPP public. Son mécanisme est
  différent : il modifie le DOM impérativement au lieu de re-rendre un
  gabarit. Le migrer demande une réécriture de sa logique d'application, pas
  un simple branchement, et cette page est la vitrine grand public : je ne
  l'ai pas touchée sans votre accord.
- **`locales/`**, l'arbre mort. Non supprimé parce qu'un test qui n'est pas
  de moi en verrouille le contenu. Décision à prendre, point 10 du suivi.

## Point d'attention mineur

En turc, `document.documentElement.lang = 'tr'` fait appliquer par CSS la
règle de casse turque : `text-transform: uppercase` rend « Supplier Portal »
en « SUPPLİER PORTAL », avec le i point suspendu. Le comportement est
typographiquement correct pour du turc, mais il s'applique ici à un nom
propre anglais. À corriger par un `text-transform: none` ciblé sur les
éléments de marque si le rendu vous gêne.

---

## Addendum — `dpp/`, `quality-center/` et le quatrième moteur

### Ce qui a été fait

- **`quality-center/`** : migrée. Portée `quality.*` (44 clés) + `shared.*`.
  Générateur idempotent `scripts/build_quality_i18n.mjs`.
- **`dpp/`** : le dictionnaire inline `dppLangs` (3 462 octets) est supprimé.
  Portée `dpp.*` (10 clés). Générateur `scripts/build_dpp_i18n.mjs`.
  `applyDppLang()` ne fait plus que déléguer à `T.setLanguage()` ; le rendu
  est isolé dans `renderDppLang()`, branché sur `tf:languagechange`.

### Le piège : `public/auto-translate.js`

Un **quatrième** système, absent du relevé initial, tournait en parallèle sur
`dpp/`, `quality-center/` et `operations/`. Il ne lit aucun catalogue : il
parcourt les nœuds texte et les substitue depuis un glossaire **à source
française** de 101 entrées, se réapplique à chaque mutation du DOM via un
`MutationObserver`, et garde sa langue **en cache depuis le chargement**
(ancienne clé `tracefab_lang`), sans qu'aucune page n'appelle son API
`window.setTracefabGlobalLanguage()`.

Conséquence mesurée : **89 valeurs françaises du catalogue partagé sont aussi
des clés de ce glossaire**. Toute chaîne française rendue par `tf-i18n` était
donc susceptible d'être repeinte dans la langue en cache du moteur.

Décisions, selon la dépendance réelle de chaque page :

| Page | Décision |
|---|---|
| `quality-center/` | **retiré** — copie visible entièrement portée par `q()`/`s()` |
| `dpp/` | **conservé et synchronisé** — son corps reste en français en dur |
| `operations/` | inchangé — orpheline, non migrée |

### Leçon de méthode

Le diagnostic a été long parce que **toutes les mesures locales étaient
bonnes** : le catalogue sur disque, le catalogue servi en HTTP, le bundle en
mémoire, et `t()` évalué à l'instant même du rendu renvoyaient tous la bonne
valeur française. Seul le DOM final était faux.

Ce qui a tranché : **piéger les écritures sur l'élément lui-même** plutôt que
d'observer le résultat. Une seule écriture a été capturée, portant la bonne
valeur — donc le coupable n'écrivait ni via `innerHTML` ni via `textContent`
sur ce nœud, mais mutait ses nœuds texte enfants. À retenir : quand la valeur
écrite est correcte et la valeur lue ne l'est pas, chercher un **second
écrivain**, pas une erreur de résolution.
