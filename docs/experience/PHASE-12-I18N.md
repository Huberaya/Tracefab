# PHASE 12 — i18n

Architecture multilingue native · 9 pages, 7 langues, 1 629 clés.

---

## 1. État de la couverture

| Mesure | Résultat |
|---|---|
| Pages avec la pile i18n | 9 / 9 |
| Pages avec sélecteur de langue | 9 / 9 |
| Pages en `lang="en"` par défaut | 9 / 9 |
| Parité stricte sur fr/de/it/es/nl/pt | complète |
| Clés de catalogue | 1 629 |

La phase 1 du cahier des charges demandait EN/FR/DE/IT/ES/NL. Le portugais a
été ajouté en cours de route. **Mise à jour Chantier 15 (2026-10-08)** : les
catalogues turc et chinois partiels ont été retirés du produit ; seules les
sept langues complètes sont désormais exposées. Voir
`CHANTIER-15-I18N-COMPLETE.md`.

L'architecture est inchangée depuis les tranches précédentes : `t(clé,
secours)` résout locale active → anglais par défaut → secours de l'appelant →
chaîne vide. `test_i18n_consolidation.mjs` dérive ses attentes de `en.js`, il
n'y a donc pas de liste de clés à maintenir en double.

## 2. Le défaut grave : un générateur qui amputait le catalogue

C'est la trouvaille de cette phase, et elle n'était pas visible depuis
l'application.

J'ai voulu ajouter deux clés à la portée `quality`. Cette portée appartient à
un générateur (`scripts/build_quality_i18n.mjs`), la règle est donc de passer
par lui. Je l'ai étendu, je l'ai lancé, il a affiché son message de succès
habituel :

```
  portee 'quality' : 46 cles x 7 langues
  table complete, aucun trou.
  ecrit  assets/i18n/en.js
```

**`en.js` venait de passer de 22 racines à 18.** Les portées `ops`,
`passport`, `invite` et `dpp` avaient disparu — 249 lignes supprimées, sans
une seule erreur à l'écran.

La cause tient dans un caractère de regex :

```js
enSrc = enSrc.replace(/,\n\n  \/\/ --- Quality Center[\s\S]*?\n  \}(?=\n\};)/, '');
```

Le `(?=\n\};)` borne la suppression sur l'accolade finale de **tout l'objet**.
Le `[\s\S]*?` paresseux s'étend donc jusqu'à la dernière racine du catalogue,
pas jusqu'à la fin de la sienne. Tant que `quality` était la dernière portée
écrite, le résultat était juste **par accident**. Dès que des portées ont été
ajoutées après elle, le générateur est devenu destructeur.

### Deux autres générateurs portaient la même mine

- `build_dpp_i18n.mjs` : identique, et fonctionnel aujourd'hui **uniquement
  parce que `dpp` se trouve être la dernière racine**. La première portée
  ajoutée après elle l'aurait fait exploser.
- `build_app_i18n.mjs` : pire sur le papier — sa suppression part de la ligne
  499 et va jusqu'à la fin, soit `console`, `portal`, `quality`, `ops`,
  `passport`, `invite`, `dpp`, pour ne réécrire que `shared`, `console` et
  `portal`. Il n'a jamais nui parce qu'il échoue volontairement en amont : il
  lit la source pré-migration, qui n'existe plus.

### La correction

Les trois bornent désormais sur la fermeture de leur propre portée
(accolade à deux espaces), ce qui est indépendant de leur position :

```js
enSrc = enSrc.replace(/,?\n\n  \/\/ --- Quality Center[\s\S]*?\n  \}/, '');
```

Vérifié en exécutant les six générateurs à la suite : **22 racines avant,
22 après chacun**, 0 valeur modifiée, seules les clés voulues ajoutées.

### Et une garde, pour que ça ne revienne pas en silence

`test_i18n_consolidation.mjs` refuse maintenant le motif dans tout
`scripts/build_*_i18n.mjs`. La garde retire les commentaires avant
d'analyser — la correction est documentée en toutes lettres dans les
générateurs, et une garde qui se déclenche sur sa propre explication ne vaut
rien. Contrôle négatif prouvé : réintroduire le lookahead dans le code fait
échouer le test ; le remettre dans un commentaire ne le fait pas.

## 3. Le second défaut : des codes machine montrés à l'utilisateur

`quality-center/` et `operations/` dépendent de l'API. En état dégradé, elles
affichaient :

> **Quality unavailable**
> api_not_available_in_static_preview

Le code brut, tel quel. Un responsable conformité n'apprend rien de
`clerk_not_configured` ou de `HTTP 503`. C'est la même classe de défaut que
celle corrigée sur la page d'invitation en tranche 11, sur deux pages de plus.

Pire : **le sélecteur de langue n'existait pas sur l'écran d'erreur.** Un
utilisateur allemand tombant sur la panne ne pouvait même pas basculer sa
langue pour comprendre ce qui se passait.

Les deux pages rendent désormais une phrase traduite dans les 7 langues,
conservent le code en `console.error` pour le support, et affichent le
sélecteur en mode dégradé :

| | EN | FR | DE |
|---|---|---|---|
| Titre | Quality unavailable | Qualité indisponible | Qualität nicht verfügbar |
| Message | The quality service is temporarily unreachable. Your data is intact. | Le service qualité est temporairement injoignable. Vos données sont intactes. | Der Qualitätsdienst ist vorübergehend nicht erreichbar. Ihre Daten sind unversehrt. |

Le message ne se contente pas de nommer la panne : il dit que les données sont
intactes, ce qui est l'information que l'utilisateur cherche réellement.

## 4. Résultats des contrôles

Batterie `npm run test:phases`, volet phase 12 — **6/6** :

```
✓ Parite stricte sur les 6 locales           complete
✓ Phase 1 du brief : EN/FR/DE/IT/ES/NL       presentes
✓ Pile i18n sur toutes les pages             9/9
✓ Selecteur de langue sur toutes les pages   9/9
✓ Toutes les pages en lang="en" par defaut   9/9
✓ Aucune copie metier en dur hors catalogue  1629 cles catalogue
```

Barrière complète : 45 tests + `build` + `tsc --noEmit` + `e2e_audit.py` 4/4 +
personas 6/6 · 4/4 · 4/4. Tout au vert.

## 5. Verdict

**Phase 12 conforme après correction.** La couverture était déjà complète ;
c'est l'outillage qui était dangereux, et l'état dégradé qui parlait en
langage machine. Les deux sont réglés, et le piège du générateur est
désormais tenu par un test avec contrôle négatif.
