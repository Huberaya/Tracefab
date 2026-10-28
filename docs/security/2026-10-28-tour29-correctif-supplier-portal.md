# Tour 29 — correctif `supplier_portal` préparé hors production

Branche `arena/c27ddaa4-tracefab`. Aucune écriture, aucune connexion de
production, aucun déploiement. `prisma migrate deploy` reste **gelé**.

## 0. Vérification de la CI de `b4c1d88` sur le SHA exact

Fait, indépendamment du récit du tour précédent :

```
6 check-runs, tous `head_sha = b4c1d88f4012e49987765f58b057ec205fe79eaf`
  success  Socle — types, compilation, isolation          (job 122828061336)
  success  Base — isolation RLS executee
  success  Parcours — navigateur reel
  success  Verification — suite de tests
  success  Chaîne 34/36/41 sur Postgres 17 jetable
  success  Vercel Preview Comments
```

Et, dans le job *Socle* du même SHA, les quatre étapes ajoutées :

```
success — Reconciliation de l historique de migrations
success — Releve M6 executable et inoffensif
success — Divergences d empreinte — effet reel mesure
success — Reprise des migrations — incidents reproduits puis franchis
```

Le `deployment Vercel` est un statut séparé des check-runs GitHub : il n'est pas
compté ici.

## 1. Revue critique des assertions du tour 28 — deux étaient faibles

En relisant mon propre test, deux assertions ne prouvaient pas ce que leur
libellé annonçait :

| Assertion | Faiblesse | Correction |
|---|---|---|
| « AVEC le rôle, l'effet est IDENTIQUE » | vérifiait seulement que le bloc **passe** (code 0), pas que les privilèges accordés sont les mêmes | comparaison **fonction par fonction** des `EXECUTE` réellement détenus par `tracefab_app` |
| « la production porte la règle la plus stricte » | **dérivée** : reformulait deux assertions déjà présentes | remplacée par une assertion indépendante : le dépôt n'accepte jamais un cas que la production refuse, et la seule différence est une acceptation supplémentaire côté dépôt |

Après correction, la mesure donne : `privileges : production=5, depot=5`, et
`les privileges obtenus sont IDENTIQUES, fonction par fonction`. La conclusion
« absence d'effet » de `public_read_context` repose désormais sur une
comparaison, pas sur une absence d'erreur.

## 2. Migration corrective — `20261028140000`

`prisma/migrations/20261028140000_supplier_invitation_owner_relationship_scope/`

Elle repose le corps de `tracefab_validate_member_invitation_role` tel que
versionné, plus son déclencheur. Ce qu'elle **ne fait pas**, et c'est aussi
important que ce qu'elle fait :

- elle ne réécrit **aucune** migration historique — réécrire `20261005090000`
  changerait son empreinte une seconde fois et laisserait la production avec un
  historique ne correspondant à aucun contenu ;
- elle n'écrit **pas** dans `_prisma_migrations` ;
- elle ne pose **aucun `GRANT`** (vérifié par assertion : pas de `GRANT` hors
  commentaire) — le registre runtime reste la seule voie d'octroi, ce qui
  satisfait la condition 6 de `test:neon:registre-fonctions` ;
- elle n'élargit **rien** : `owner` sans relation reste refusé.

## 3. Preuve, dans l'ordre demandé

`npm run test:supplier-invitation-corrective` — 21 vérifications, exécutées en CI.

| Étape | Mesure |
|---|---|
| **Avant** (corps de production) | `owner+relation = refusé`, `owner seul = refusé`, `admin+relation = accepté` |
| **Défaut reproduit** | l'invitation `owner` + relation échoue, comme en production |
| **Après** migration | `owner+relation = accepté`, `owner seul = refusé`, `admin+relation = accepté` |
| **Changement minimal** | le comportement ne change que sur **un** cas, `owner` + relation |
| **Déclencheur** | existe et pointe sur la fonction corrigée (sans cela la correction serait écrite mais jamais appelée) |
| **Idempotence** | rejeu sans erreur, comportement inchangé, déclencheur non dupliqué |
| **Privilèges** | la fonction reste `SECURITY DEFINER` ; aucun `GRANT` ajouté |
| **Chaîne** | les **64** migrations s'appliquent sur une base vierge, la corrective en dernière position |

La migration est jouée **en entier** dans le test, pas seulement le corps de la
fonction : une migration dont on n'exécute qu'un morceau n'est pas la migration.

**Contrôle négatif** : correctif remplacé par le corps de production → 3 échecs,
exit 1. Le test mord.

## 4. Effets de bord traités

Ajouter une 64ᵉ migration casse deux instruments qui comptaient :

- `test:chantiers` refusait un registre annonçant 63 → registre mis à jour
  (« Dépôt : 64 migrations » + description de la 64ᵉ) ;
- `test:reprise-migrations` portait `slice(0, 58)` et l'assertion « 5
  manquantes » → rendu indépendant du nombre total : `58` est le nombre de
  lignes de l'historique **de production**, pas une propriété du dépôt.

Conséquence attendue et non corrigée : le réconciliateur signale désormais
**8** migrations non attestées (les 7 précédentes + la corrective). C'est
l'état réel, et il changera au déploiement.

## 5. État de la chaîne P0

| Point | État |
|---|---|
| `plm_erp_gs1` | **`BLOCKED`** — confrontation production non exécutée (autorisation de connexion absente) |
| `supplier_portal` | **correctif prêt et prouvé** — non appliqué |
| `public_read_context` | **clos sous réserve** — voir §6 |
| Migrations hors bande (5, à 0 étape) | **non confrontées** à leur état de schéma réel |
| `deploy` | **gelé** |

## 6. `public_read_context` — ce que « absence d'effet » couvre exactement

La conclusion vaut pour **le rôle et les conditions réellement testés** :

- rôle `tracefab_app` **existant** — le cas de la production ;
- sur les **cinq** fonctions concernées ;
- comparaison des `EXECUTE` réellement détenus, pas seulement du succès du bloc.

Elle ne dit rien de : un autre rôle, une base où `tracefab_app` serait absent,
ou l'état des privilèges **par défaut** du schéma. Ces cas ne sont pas couverts
et ne sont donc pas affirmés.

## 7. Ce qui reste à autoriser

1. la **requête de confrontation** de `plm_erp_gs1` (lecture seule) — valeurs de
   référence déjà calculées et imprimées par `test:divergences-migrations` ;
2. l'**application** de `20261028140000` en production — écriture, donc hors de
   portée sans accord explicite ;
3. la confrontation des **cinq migrations hors bande** à leur état de schéma.

Rien de tout cela n'est engagé. Le correctif est préparé, pas appliqué.
