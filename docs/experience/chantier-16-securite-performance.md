# Chantier 16 — Sécurité & Performance

**PR #32** · branche `experience/chantier-16-securite-performance` · commit `d6e406a`
**CI verte sur GitHub**, les quatre étages.

C'était le dernier manque de mon lot, et le seul qui était exploitable par un
tiers. Mon lot 13 → 19 est maintenant complet.

---

## 1. La limitation de débit

### Ce qu'il y avait avant : rien

Aucune route n'avait de plafond. Zéro `429` dans tout le code.

`/api/dpp/:gtin` est **publique par construction** — un passeport doit pouvoir
être lu par n'importe quel téléphone qui scanne un QR. Et
`/api/passport/:token/request-access` est un **POST anonyme qui écrit en
base**. Il n'y avait rien entre un script et la facture Neon.

Sur 125 routes : 102 sont protégées par le contexte locataire, 5 par un secret
worker, 1 par signature. **13 sont réellement anonymes, dont 8 touchent la
base.**

### Deux étages, parce qu'aucun ne suffit seul

| Étage | Ce qu'il fait | Ce qu'il ne fait pas |
|---|---|---|
| **Mémoire** | Gratuit, instantané. Arrête la rafale qui tape une instance chaude, sans jamais toucher la base. | Un compteur en mémoire est multiplié par le nombre d'instances serverless. **C'est un ralentisseur, pas un plafond.** |
| **Postgres** | Fenêtre fixe incrémentée atomiquement, partagée par toutes les instances. **Le seul vrai plafond.** | Coûte un aller-retour par requête — largement moins cher que la requête qu'il empêche : résoudre un passeport DPP joint une dizaine de tables. |

### Les budgets

| Classe | Budget | Pourquoi |
|---|---|---|
| Lecture publique | 120 / min | Un scan de QR légitime en fait un. |
| Laissez-passer | 20 / min | Signature cryptographique : cher en CPU. |
| **Écriture anonyme** | **10 / 5 min** | La plus sensible. C'est elle qui écrit. |
| Avec justificatif | 600 / min | Un tableau de bord en émet beaucoup. Trop serrer casserait l'application pour des utilisateurs légitimes. |
| `health`, `internal/*`, `webhooks/*` | dispensés | Chaque dispense est justifiée en commentaire — une dispense est un trou. |

Les budgets sont par client **et par classe**, donc un client qui répartit sa
charge les cumule. C'est volontaire : séparer les classes évite qu'une rafale
de lectures ne consomme le budget d'écriture.

### En cas de panne, on laisse passer

Si la base est injoignable, l'étage base est ignoré et mis en quarantaine
30 secondes ; seul l'étage mémoire s'applique.

**Un limiteur cassé ne doit pas rendre le service indisponible** — ce serait
transformer un incident de base en panne totale. C'est un choix assumé, et
c'est la limite la plus importante à connaître de ce module.

### Deux détails qui font la différence entre un limiteur et un théâtre

**L'adresse du client n'est jamais écrite en clair.** La table stocke un HMAC.
Une IPv4 simplement hachée se retrouve par force brute — il n'y a que quatre
milliards de valeurs. Le sel est dérivé d'un secret que le déploiement possède
déjà : aucune variable supplémentaire à poser, donc aucune chance de l'oublier.

**`x-forwarded-for` est falsifiable.** Un limiteur qui lui fait confiance
distribue un budget infini à qui pense à changer l'en-tête. On préfère les
en-têtes que la plateforme écrit elle-même, et on ne retient de
`x-forwarded-for` que le **dernier saut**, celui qu'un client ne peut pas
choisir.

### Vérifié contre un vrai Postgres

J'ai monté un Postgres 17 pour ce chantier et appliqué les 32 migrations. Ce
n'est plus de la lecture de code :

- blocage à la **121ᵉ** lecture publique, verdict rendu par la base ;
- blocage à la **11ᵉ** écriture anonyme ;
- `health` : 300 appels, aucun rejet, aucun en-tête de débit ;
- chemin HTTP complet : **429** avec `Retry-After` et les en-têtes `RateLimit-*` ;
- panne de base testée **depuis un processus neuf** — 135 ms au premier appel,
  1 ms pour les 50 suivants, la quarantaine fonctionne.

> **Mon premier test de la panne était faux.** J'avais changé `DATABASE_URL`
> après que Prisma se soit connecté : le client gardait la bonne connexion et
> répondait « base ». Un test qui ne casse pas ce qu'il prétend casser ne
> prouve rien.

---

## 2. Le plafond de lignes

**36 `findMany` sans `take`.** Avec 1 248 produits de démonstration cela ne se
voit pas ; avec le catalogue d'une marque réelle, `GET /api/products`
sérialise la table entière et la fonction ne répond plus.

Les corriger un par un aurait laissé le problème entier : **le 37ᵉ, écrit
demain, serait illimité lui aussi.** Le plafond est donc posé sur le client
Prisma — il couvre ce qui existe et ce qui n'est pas encore écrit.

5 000 lignes est un filet, pas une pagination. Et **la troncature se
journalise** : un plafond qui se déclenche sans que personne ne le sache est
une perte de données déguisée en lenteur résolue.

`products.ts` reçoit en plus une vraie pagination par curseur, comme
implémentation de référence. Curseur sur clé et non `OFFSET`, dont le coût
croît avec le numéro de page.

> **Limite connue :** la console et le portail ne consomment pas encore
> `nextCursor`. Le plafond par défaut est choisi très au-dessus de tout
> locataire existant pour que personne ne rencontre cette limite avant que les
> clients ne soient mis à jour.

---

## 3. La CSP sans `'unsafe-inline'`

Tant qu'il était là, **une seule injection réussie quelque part devenait une
exécution de script complète**. C'est la différence entre une faille et une
prise de contrôle.

Le retirer exigeait deux choses, et n'en faire qu'une n'apporte aucun gain de
sécurité : **19 blocs `<script>` inline (407 Ko)** et **77 attributs `on*=`**.

### Le HTML

| Page | Avant | Après |
|---|---|---|
| brand-console | 291 672 o | **41 169 o** |
| supplier-portal | 128 593 o | **20 825 o** |

### Les gestionnaires

Les attributs deviennent une délégation `data-tf-act`, un écouteur par type
d'événement posé sur `document`. `closest()` reproduit exactement le
comportement d'un attribut inline.

Effet secondaire utile : les gestionnaires de page sont enregistrés **dans la
portée du module**, donc `state` et `render` sont directement accessibles. Cela
supprime l'exposition sur `window` que le code faisait jusqu'ici pour
contourner la portée globale des attributs inline — un contournement que le
code lui-même documentait en commentaire.

### Ce que je n'ai pas fait, et pourquoi

**`style-src` garde `'unsafe-inline'`.** Il y a 450 attributs `style=` à
déplacer vers des classes. L'injection de style n'est pas l'injection de
script — elle permet au pire de l'exfiltration par sélecteurs CSS, pas une
prise de contrôle. 450 modifications pour ce gain-là, avec le risque de
régression visuelle partout, n'est pas un bon échange.

### Vérifié dans un vrai navigateur

CSP de production appliquée à la réponse, écouteur de violations posé, les
**9 pages** chargées : **aucune violation, aucune erreur**.

Et testé par morsure : en neutralisant `tf-actions.js`, les clics ne font plus
rien. **Le test sait échouer** — sans cette preuve, « aucune violation » ne
distinguerait pas une page qui marche d'une page dont tous les boutons sont
morts.

---

## 4. Les tests, et pourquoi ils ne sont pas affaiblis

Sortir 407 Ko de JavaScript du HTML a cassé **26 suites** d'un coup. Elles
lisaient `brand-console/index.html` pour y vérifier du comportement qui ne s'y
trouve plus.

Elles lisent désormais la **source complète de la page** : le HTML avec ses
propres blocs de script remis en place, d'après un **manifeste exact** écrit
par le codemod — pas une déduction sur les noms de fichiers, qui aurait fini
par réinsérer un script tiers et faire verdir un test pour une mauvaise raison.

La preuve qu'aucune assertion n'a été affaiblie : `test:copy` retrouve ses
**17 329 chaînes** et ses exceptions **chiffre pour chiffre**, dont les
`contenu du jeu de démonstration (85)` qui avaient disparu.

Deux assertions ont dû changer de forme — elles visaient `onclick="goView(…)"`.
Elles portent maintenant sur `data-tf-arg`, c'est-à-dire sur la cible
transportée, qui est la seule chose qui comptait.

---

## 5. Deux défauts réels dans le semeur du chantier 19

Le vrai Postgres monté pour ce chantier m'a permis d'exécuter le semeur de
pilote, qui jusque-là n'avait tourné qu'en `--dry-run`.

**Il échouait.** `data_request_relationship_mismatch` : une demande de données
exige un `relationship_id` désignant exactement le couple (marque,
fournisseur). Le semeur ne l'écrivait pas.

**Et sans `--reset`, il empilait un second pilote en silence** — 22
fournisseurs, 40 produits, et des chiffres de rapport qui ne veulent plus rien
dire. Le validateur vérifiait l'unicité *à l'intérieur* du plan, pas face à la
base.

Les deux sont corrigés. Le semeur refuse désormais d'amorcer par-dessus un
pilote existant, et **le rapport ne s'imprime plus quand rien n'a été écrit**.

> Un mode à blanc ne peut pas voir ces défauts : il ne touche pas la base.
> C'est la leçon la plus utile de ce chantier — **j'ai livré au chantier 19 un
> outil que je n'avais jamais exécuté.** Il aurait échoué devant un client.

---

## 6. Les garde-fous

**17 contrôles ajoutés, 46/46 verts**, chacun vérifié par morsure : piège
planté, garde déclenchée, piège retiré.

Un piège m'a échappé au premier passage. Ma garde cherchait `$allModels` ; j'ai
renommé en `$allModelsDesactive` pour débrancher le plafond, et la garde est
restée verte — **la chaîne était toujours là, en sous-chaîne**. L'ancre est
maintenant structurelle. C'est la troisième fois sur ce projet que je me fais
prendre par une garde qui cherche un mot au lieu d'une structure.

---

## Vérification

53 `test:*`, `build`, `tsc`, `api:typecheck`, e2e `PERFECT EXECUTION`,
personas 3/3, **20/20 parcours**, 40/40 phases, RLS **46 ENABLE / 50 FORCE**.

---

## Mon lot est complet

| Chantier | État | PR |
|---|---|---|
| 13 — DPP actionnable | livré | #27 |
| 14 — Passeport dynamique | livré | #28 |
| 15 — i18n | livré | #26 |
| **16 — Sécurité & Performance** | **livré** | **#32** |
| 17 — Tests E2E & CI | livré | #29 |
| 18 — Production Readiness | livré | #30 |
| 19 — Commercial Readiness | livré | #31 |

Sept PR ouvertes, **à fusionner dans cet ordre** :

```
main 7cfc669
 └── #26 → #27 → #28 → #29 → #30 → #31 → #32
```

---

## Ce qui reste, et que je n'ai pas fait

### Avant toute mise en production

1. **Fusionner la pile.** Sept PR empilées se périment, et le risque de
   conflit avec les chantiers 01→12 augmente chaque jour.
2. **Remplir les quatre lignes vides du dossier sécurité** : adresse de
   signalement de vulnérabilité, délai d'accusé de réception, délai de
   notification d'incident, liste des sous-traitants. Elles demandent un
   engagement contractuel.
3. **Appliquer la migration 33** (`rate_limit_counters`) sur Neon. Sans elle,
   le limiteur fonctionne mais sur son seul étage mémoire — donc sans vrai
   plafond.

### Dette assumée, écrite dans la checklist

- **`style-src 'unsafe-inline'`** — 450 attributs `style=`.
- **Les fichiers JS ne sont pas empreintés** (`brand-console.1.js` et non
  `brand-console.a3f91c.js`). Tant qu'ils ne le sont pas, on ne peut pas leur
  poser de cache long sans risquer de servir du JavaScript périmé contre un
  HTML neuf. C'est le prochain gain de performance, et il est net.
- **Pas de test d'intrusion**, aucune certification engagée.
- **Les deux arbitrages produit toujours ouverts** : `92,4 %` contre `91,4 %`
  sur la même métrique, et le français codé en dur dans la lignée produit.
