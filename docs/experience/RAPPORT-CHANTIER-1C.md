# Chantier 1C — rapport de fin de mission

Le passeport fournisseur public n'invente plus d'entreprise.
Barrière complète verte : 70 scripts `test:*`, build, `tsc`, typecheck API,
audits e2e et personas, régression visuelle sur 38 références.

---

## 1. Comment j'ai choisi ce périmètre

Vous m'avez demandé le « chantier 1C ». Ni le dépôt ni l'historique git ne
définissent 1B ou 1C : l'appellation vient de vous, et je n'en avais pas la
teneur. Plutôt que de deviner, j'ai audité les surfaces du même registre que
1A — celles qui peuvent présenter une donnée fabriquée comme réelle — et j'ai
retenu le défaut le plus grave que j'y ai trouvé.

Il s'est avéré être exactement la maladie traitée en 1A (`fallback-data.ts`
supprimé côté wallet), intacte sur une autre surface. Si vous aviez autre chose
en tête pour 1C, dites-le : ce travail reste utile de toute façon.

---

## 2. Le défaut

`assets/js/passport.1.js` enveloppait son appel API dans un `try/catch`. Le
`catch` contenait un fournisseur complet et nommé :

```
Nhãn Textile Portugal — PT — fondé en 1998 — 251-1000 salariés
✓ AUDITED PROFILE
"Integrated textile manufacture certified GOTS & OEKO-TEX"
```

**Toute** réponse non-OK y menait. Constaté par exécution, avant correction :

| Cas | Ce que voyait le visiteur |
|---|---|
| `404` — passeport jamais publié ou révoqué | Nhãn Textile Portugal, GOTS, OEKO-TEX, « ✓ AUDITED PROFILE » |
| `500` — panne passagère sur un **vrai** passeport | le même fournisseur fictif, à la place du vrai |

La bannière « passeport de démonstration » restait visible, et la page portait
`data-tf-demo`. C'est ce qui a permis au défaut de survivre : il *semblait*
couvert. Il ne l'était pas. **La bannière qualifie la page, pas l'entreprise
qu'on y lit.** Personne ne déduit d'un bandeau que la société affichée n'est pas
celle qu'il cherchait — et dans le second cas, le visiteur avait toutes les
raisons de croire qu'il lisait bien le fournisseur dont il avait le lien.

---

## 3. Pourquoi il ne suffisait pas de supprimer le repli

La page de démonstration passait **par ce même `catch`**. Sans `?ref`, elle
interrogeait `nhan-textile-pt`, recevait 404, et tombait dans le repli.

La démonstration était donc indissociable d'une panne, et réciproquement : toute
panne devenait une démonstration. Supprimer le repli aurait supprimé la
démonstration du même geste.

C'est la vraie leçon de ce chantier : le défaut n'était pas une maladresse
locale dans un `catch`, c'était **le mode démonstration construit sur le chemin
d'erreur**.

---

## 4. Ce que j'ai fait

- **Mode démonstration explicite.** `MODE_DEMONSTRATION` se décide sur l'URL
  (absence de `?ref` et `?token`), jamais sur un échec. Le jeu de données est
  nommé `PASSEPORT_DEMONSTRATION` et sorti du chemin d'erreur.
- **Deux écrans distincts**, parce que la conduite à tenir diffère :
  - `403` / `404` / `410` → « Ce passeport n'est pas disponible », avec
    l'invitation à redemander un lien au fournisseur ;
  - toute autre panne → « Passeport momentanément inaccessible », avec reprise.
  Les confondre, ce serait se tromper de cause devant le visiteur.
- **Bannière retirée sur ces écrans.** Rien n'y est montré ; l'y laisser
  décrirait un contenu absent.
- **5 clés i18n sur 7 locales** (`unavailableTitle`, `unavailableBody`,
  `unreachableTitle`, `unreachableBody`, `retry`).

---

## 5. Un défaut que le repli masquait

En retirant le repli, la page est devenue **blanche** sur un cas que je n'avais
pas prévu. Le gabarit lisait `d.certifications.length`, `d.sites.length` et
`d.materials.length` sans vérification : une réponse réelle à laquelle il
manquait un tableau faisait lever `render()` en pleine construction.

Tant que le repli existait, ce cas n'arrivait jamais — l'exception était
rattrapée et le fournisseur fictif s'affichait. **Le repli ne masquait pas
seulement les pannes du serveur : il masquait aussi une fragilité du rendu.**

Collections absentes valent désormais collections vides, et le cas est gardé
explicitement (section D bis).

---

## 6. La garde

`npm run test:passport-public` — **36 assertions**, exécutées dans un vrai
navigateur, l'API étant simulée par interception :

| Section | Ce qu'elle exige |
|---|---|
| A | la démonstration reste entière, sous sa bannière |
| B | `403`/`404`/`410` → écran « indisponible », aucun fournisseur fictif, ni GOTS, ni OEKO-TEX, ni « AUDITED », bannière retirée |
| C | `500`/`502` → écran « panne », **distinct** du précédent, avec reprise |
| D | un vrai passeport s'affiche, et seul |
| D bis | un passeport sans certifications, sites ni matières s'affiche quand même — la page n'est pas blanche |
| E | structure : le `catch` ne contient aucun fournisseur, le mode démonstration vient de l'URL |

La section E mérite un mot. Les sections B et C pourraient redevenir vertes par
accident — par exemple si quelqu'un remet le repli mais que l'API simulée
répond autrement. La garde de structure ferme cette porte en exigeant que
l'objet reste **hors** du chemin d'erreur.

**Cinq mutations vérifiées**, chacune détectée :

| Mutation | Assertions rouges |
|---|---|
| repli fictif réintroduit sur erreur | 6 |
| 404 et panne confondus | 3 |
| bannière laissée sur l'écran d'erreur | 3 |
| durcissement des collections retiré | 3 |
| mode démonstration redevenu implicite | 5 |

---

## 7. Une correction apportée au test lui-même

Ma première version attendait `networkidle`. La cinquième mutation se
manifestait alors par une **expiration de 30 secondes** au lieu d'une assertion
rouge : le test signalait une panne de navigateur là où il aurait dû désigner le
défaut, et il n'atteignait jamais la section E, pourtant écrite pour ce cas
précis.

L'attente est maintenant bornée et ne dépend plus du réseau. La suite est passée
de 6 s à 2,4 s, et la mutation produit cinq assertions rouges nommées.

---

## 8. Ce qui reste ouvert

- **Bloqué par absence de secret** — inchangé depuis 1A : `/tmp/neon.env` est
  absent, donc le basculement de `DATABASE_URL` de `neondb_owner` vers
  `tracefab_app` reste à faire. C'est lui qui transforme l'isolation RLS en
  protection effective plutôt qu'en dispositif dormant.
- `brand-console.1.js` contient aussi un repli, mais **bénin** : il ne sert que
  de source aux chiffres de démonstration si `tf-demo-figures.js` n'a pas été
  chargé, et `test:coherence` vérifie qu'il ne diverge pas. Vérifié, non touché.
