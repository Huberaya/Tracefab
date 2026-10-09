# Chantiers restants — état vérifié

Relevé du 9 octobre 2026, établi en interrogeant le dépôt, l'API GitHub et
la base Neon de production. Pas en relisant les en-têtes.

**`main` = `5b78ac6` · 0 PR ouverte · CI run #26 verte · Neon : 33/33
migrations appliquées.**

---

## Clos depuis la dernière version

**Les huit PR sont fusionnées.** #26 → #33, dans l'ordre, chaque PR
ré-adressée vers `main` après sa parente. 14 commits, 116 fichiers.
Contrôle décisif : l'arborescence de `main` est identique octet pour octet
à celle du sommet de la pile. Rien n'a été perdu.

**Les migrations sont appliquées sur Neon.** Deux étaient en attente, pas
une : la 32 (`force_rls_schema_bindings`) précédait la 33. Appliquées via
l'URL directe — le pooler ne tient pas le verrou consultatif d'une
migration. Vérifié en base : 47 tables, 46 ENABLE, 46 FORCE,
`rate_limit_counters` créée avec sa clé composite, son index et sa
politique. L'incrément atomique `ON CONFLICT DO UPDATE` a été testé pour de
vrai, puis la ligne de sonde supprimée.

---

## 1 · La couche RLS est inerte en production

**Le plus important de cette liste.**

Le rôle de connexion `neondb_owner` porte `rolbypassrls = true`. Mis à
l'épreuve, pas seulement lu : sans aucun contexte RLS armé, une requête sur
`audit_logs` renvoie **4 lignes sur 4**, alors que sa politique
`audit_select_admin` exige un rôle d'organisation.

`BYPASSRLS` est un attribut de rôle qui prime sur `ENABLE` comme sur
`FORCE`. Le `FORCE` ne lève que l'exemption du *propriétaire de table* ; il
ne touche pas celle du rôle. Le commentaire de la migration 32 affirme que
`FORCE` ferme la fuite pour `neondb_owner` — c'est faux tant que ce rôle
garde `BYPASSRLS`.

**Corollaire sur les rapports précédents :** le « 46 ENABLE / 46 FORCE »
cité aux chantiers 16 à 20 compte des **drapeaux dans le catalogue**. Il ne
prouve aucune isolation. Il a été présenté comme une garantie ; c'en était
un inventaire.

Cela ne signifie pas que les données fuient entre clients : l'isolation
réelle passe aujourd'hui par le code applicatif et le plafond de lignes.
Mais la **deuxième couche, celle qui devait rattraper une erreur de la
première, ne protège rien.**

Le correctif : un rôle applicatif dédié, sans `BYPASSRLS` et non
propriétaire des tables, vers lequel pointerait `DATABASE_URL` — plus un
test qui **prouve** l'isolation au lieu de compter des drapeaux. Non
entrepris : changer le rôle de connexion en production casse l'application
si un droit manque.

## 2 · L'étage base de la CI n'a jamais tourné

`GET /actions/secrets` renvoie **aucun secret**. Le job
« Base — isolation RLS executee » est donc vert en sautant toutes ses
étapes utiles : installation, génération Prisma, scénarios croisés.

Le nom du job **affirme une exécution qui n'a jamais eu lieu**. Je l'ai
écrit au chantier 17 avec l'intention « sauté plutôt que rouge » ;
l'intention était bonne, le résultat ment.

Deux gestes : déposer `DATABASE_URL` en secret du dépôt, et renommer le job
pour qu'il dise ce qu'il fait quand le secret manque.

## 3 · Trois surfaces existent et sont injoignables

Zéro lien de navigation entrant, toutes formes confondues :

| Page | Liens entrants | Remarque |
|---|---|---|
| `/product-intelligence/` | **0** | **exigée explicitement par le cahier des charges** |
| `/passport/` | 0 | seules des URL d'API la mentionnent |
| `/operations/` | 0 | idem |

Construites, testées, traduites — et inatteignables en cliquant. Même
nature que la chaîne de valeur du chantier 3 : du code correct derrière une
porte absente.

## 4 · i18n résiduelle sur deux de ces pages

`passport/` porte 6 attributs `data-i18n`, `operations/` en porte 1. Les
deux chargent pourtant le catalogue. L'essentiel de leur copie reste figé
dans le balisage.

## 5 · Pas de cache long sur `/assets/`

`vercel.json` n'expose que `/(.*)` et `/api/(.*)`. Les fichiers JS ne sont
pas nommés par empreinte de contenu : sans cela, un cache long servirait du
code périmé.

## 6 · Quatre engagements contractuels à trancher

`docs/commercial/dossier-securite.md`, lignes 149 à 152 :

| Ligne | État |
|---|---|
| Signalement de vulnérabilité | « adresse dédiée » |
| Délai d'accusé de réception | « engagement à définir » |
| Notification d'incident | « délai contractuel à définir » |
| Sous-traitants ultérieurs | « liste à publier » |

Décisions juridiques, pas techniques.

## 7 · Processus — phases 6 à 12 jamais validées

Le cahier des charges impose un arrêt et une validation après chaque phase.
La phase 4 a été validée, la 5 autorisée. Les suivantes ont été livrées
sans validation formelle. Elles passent `test:phases` (40/40) et l'audit
personas, mais l'arrêt prévu n'a pas eu lieu.

## 8 · Hors périmètre

Les chantiers **01 à 12** relèvent de l'autre agent. Ce document ne couvre
que 13 à 20.

---

## Déjà réglé — ne pas reprendre

| Point | État vérifié |
|---|---|
| Huit PR en attente de fusion | fusionnées, `main` porte tout |
| Migration 33 sur Neon | appliquée, avec la 32 qui la précédait |
| `tsx` non déclaré | déclaré, `^4.23.15` |
| Deux polices d'affichage | une seule ; « Plus Jakarta Sans » ne survit que dans un artefact de comparaison |
| 27 cibles tactiles sous 40 px | plancher posé, `--tf-touch-min: 40px` |
| Branche parallèle `arena/e72cecf4` | abandonnée — décision close |
| Copie métier en dur dans les SPA | `test:copy` vert, cécité aux capitales et aux mots isolés levée |
| Chiffres divergents entre surfaces | `test:coherence`, 336 valeurs sur 48 clés et 7 langues |
