# Contexte worker : la falsification est neutralisée, et livrable

Date : 28/10/2026 · Branche : `arena/c27ddaa4-tracefab` · Base d'essai : PostgreSQL 18.4 jetable, 62 migrations, rôle `tracefab_app` sans `BYPASSRLS`.

Ce document remplace `2026-10-28-correction-contexte-worker.md` (version « bloquée ») :
les deux obstacles identifiés la veille sont levés, sans modifier l'historique des
migrations et sans écrire dans `_prisma_migrations`.

---

## 1. Le défaut, et pourquoi il durait

Onze politiques RLS s'ouvraient sur un GUC de session :

```sql
current_setting('tracefab.worker_context', true) = 'true'
```

Un GUC est positionnable par n'importe quel rôle. Mesure sur base jetable, rôle
`tracefab_app` sans `BYPASSRLS` :

| État | organizations | users | organization_memberships |
|---|---|---|---|
| sans contexte | 0 | 0 | 0 |
| après `SET tracefab.worker_context = 'true'` | 2 | 2 | 2 |

L'isolation ne tenait donc pas à la base mais à la bonne volonté de l'appelant.

Une piste « propre » a été mesurée puis écartée : `REVOKE SET ON PARAMETER` ne
protège pas un paramètre personnalisé — après révocation, `set_config()` **et**
`SET` passent encore. Il n'existe pas de version sûre de ce mécanisme.

## 2. Les deux obstacles levés

### 2.1 La liste blanche des fonctions ne pouvait pas grandir

`20261021120000_limit_app_function_execute` figeait les fonctions exécutables par
`tracefab_app` dans un tableau `runtime_names`, et vérifiait à la fin que **chaque
nom existe déjà** — sinon `42883`. Une migration postérieure ne pouvait donc rien
ajouter sans modifier un fichier déjà appliqué, ce qui change son empreinte et
exige d'écrire dans `_prisma_migrations`.

**Réponse : `20261028120000_runtime_function_registry`.**

Les noms quittent le code de la migration pour une table, `tracefab_runtime_function_registry`.
Une migration ultérieure ajoute un nom par `INSERT`. Le contrôle n'est pas levé, il
est **déplacé et renforcé** — la fonction `tracefab_apply_runtime_function_grants()`
vérifie, à chaque application :

1. chaque nom enregistré désigne **exactement une** fonction, publique, appartenant
   à un propriétaire de confiance — sinon `42883` ;
2. toute fonction appelée par une politique RLS est enregistrée ;
3. aucun `EXECUTE` ne subsiste hors registre — sinon `42501` ;
4. chaque nom enregistré est réellement exécutable ;
5. aucune `SECURITY DEFINER` n'est exécutable par `PUBLIC`.

La migration ne fait pas que créer le registre : elle reconstruit le périmètre
existant à partir de lui, et échouerait si les 84 noms hérités n'étaient pas
retrouvés à l'identique.

### 2.2 Une fonction `SECURITY DEFINER` ne pouvait pas voir les tables protégées

C'est le point que la version précédente du candidat avait faux, et il ne se voit
pas en test local : toutes les tables sensibles sont en `FORCE ROW LEVEL SECURITY`,
donc **même le propriétaire de la table est soumis aux politiques**. Or
`current_user` vaut le *propriétaire* à l'intérieur d'une fonction `SECURITY DEFINER`.

Mesure directe (rôle propriétaire **non superutilisateur**, `FORCE RLS` activée) :

| Propriétaire de la fonction | Ce que la fonction voit |
|---|---|
| propriétaire des migrations | **0 ligne** |
| `tracefab_worker` (le rôle testé par la politique) | **1 ligne** |

Le candidat précédent avait été validé sous `postgres`, qui **contourne** la RLS :
il aurait donc été muet sur la base gérée. Les six fonctions appartiennent
désormais à `tracefab_worker`, ce qui rend `current_user` égal à lui-même à
l'intérieur de leur exécution — et seulement là.

## 3. Ce qui a été livré

### `20261028120000_runtime_function_registry`

- table `tracefab_runtime_function_registry` : RLS **activée et forcée**, unique
  politique réservée au propriétaire, aucun privilège applicatif utile ;
- reprise des 84 noms hérités, à l'identique ;
- `tracefab_apply_runtime_function_grants()` : `SECURITY INVOKER`, `search_path`
  figé à `pg_catalog`, `EXECUTE` retiré à `PUBLIC` **et** au rôle applicatif —
  sinon le runtime pourrait s'ouvrir lui-même n'importe quelle fonction.

### `20261028120100_worker_identity_not_forgeable`

- `tracefab_worker` : `NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE
  NOCREATEDB` — aucun mot de passe, aucune session, donc aucun secret à créer ;
- les onze politiques lisent `current_user`, plus le GUC ;
- `tracefab_app` ne peut pas endosser le worker (`SET ROLE` et
  `SET SESSION AUTHORIZATION` refusés, aucune appartenance croisée) ;
- six opérations système nommées, possédées par `tracefab_worker`, déclarées au
  registre ;
- privilèges du worker limités aux tables que ces six fonctions touchent ;
- **réduction** : `INSERT/UPDATE/DELETE/TRUNCATE` sur `users` est retiré à
  `tracefab_app`, les écritures passant désormais par les fonctions.

  *Conséquence à connaître* : la politique `users_update_self` (un utilisateur
  modifie sa propre ligne) existe toujours dans le schéma mais n'est plus
  atteignable par le runtime. Aucune route n'écrivait dans `users` en direct —
  `/api/me` est en lecture seule — donc le privilège était sans usage. Pour une
  édition de profil, il faudra une **fonction nommée** déclarée au registre, pas
  un `GRANT` sur la table : c'est le contrôle `test:tables-ecriture-directe` qui
  l'exige, et c'est ce qui empêche un privilège d'écriture de revenir sans
  chemin applicatif.

### `20261028120200_document_reserved_fields_internal_only`

Défaut **distinct** trouvé pendant cet audit, et de la même famille : le drapeau
`tracefab.internal_document_update` autorisait l'écriture des champs gérés par le
pipeline documentaire (`status`, `byte_size`, `sha256`, `uploaded_by`,
`available_at`, `deleted_at`, `deleted_by`), et `tracefab_app` possédait `UPDATE`
sur `documents` — donc pouvait poser le drapeau lui-même.

Mesure, base jetable reconstruite depuis zéro, session `tracefab_app` avec le
contexte d'un propriétaire de l'organisation propriétaire du document :

| Tentative | Résultat avant correctif |
|---|---|
| `UPDATE documents SET status='available'` sans drapeau | `P0001 managed_document_fields_are_not_client_writable` |
| `set_config('tracefab.internal_document_update','true')` puis `UPDATE status` | **succès, 1 ligne** |
| idem puis `UPDATE sha256` | **succès, 1 ligne** |

Un adhérent pouvait donc auto-approuver un document et publier un fichier jamais
scanné. Correctif :

- fonction `tracefab_mark_document_scanning(uuid)`, `SECURITY DEFINER`, mêmes
  garde-fous que l'ancien chemin (document existant, état scannable, rôle
  d'écriture dans l'organisation propriétaire) ; c'est elle qui pose le drapeau,
  côté serveur ;
- déclaration au registre runtime, donc `EXECUTE` accordé par le mécanisme
  existant — et non par un `GRANT` écrit à la main ;
- `INSERT, UPDATE, DELETE, TRUNCATE` retirés à `tracefab_app` sur `documents`.
  Le runtime ne fait que **lire** cette table (`findFirst`/`findMany` dans
  `api/`) : les quatre écritures passent désormais toutes par des fonctions
  `SECURITY DEFINER`.

Après correctif, sous `tracefab_app` : `UPDATE`, `INSERT` et `DELETE` sur
`documents` renvoient `42501`, `SELECT` fonctionne, et
`tracefab_mark_document_scanning` réussit pour un ayant-droit, échoue en
`document_scan_role_required` pour un autre locataire.

## 4. Preuves mesurées

| # | Propriété | Mesure |
|---|---|---|
| 1 | sans contexte, le rôle applicatif ne voit rien | 0 / 0 / 0 |
| 2 | GUC worker posé par l'appelant | **0 / 0 / 0** (avant : 2 / 2 / 2) |
| 3 | contexte tenant légitime préservé | sa propre organisation : 1 ; les autres : 0 |
| 4 | six opérations worker sous identité autorisée | 6/6 fonctionnelles |
| 5 | DPP : rien sans contexte, contexte public forcé n'ouvre ni org ni adhésion | conforme |
| 6 | ni l'un ni l'autre ne peut endosser l'autre | `SET ROLE` refusé, 0 appartenance |
| 7 | aucun privilège élargi | 0 table lisible par le worker seul |
| 8 | registre | 91 noms = 91 `EXECUTE`, **0 hors registre** |
| 9 | champs réservés de `documents` | `UPDATE`/`INSERT`/`DELETE` → **42501** sous `tracefab_app`, même drapeau interne posé ; `SELECT` préservé ; transition légitime par fonction : OK |
| 10 | isolation inter-locataires après correctif | 22/22 assertions vertes (`test:neon:isolation-lignes`) |

**Le test est mordant** : en remettant une seule politique sur le GUC, la propriété 2
échoue immédiatement et la suite sort en code 1. Vérifié, pas supposé.

## 5. Tests bloquants ajoutés en CI

| Test | Ce qu'il refuse |
|---|---|
| `test:neon:worker-non-forgeable` | la falsification du GUC, l'usurpation d'identité, tout élargissement |
| `test:neon:registre-fonctions` | nom fantôme, divergence module↔base, `EXECUTE` hors registre, perte du périmètre hérité, **modification de `20261021120000`** (empreinte épinglée), `GRANT` direct contournant le registre |
| `test:neon:isolation-lignes` | l'écriture de `documents` par le rôle applicatif, y compris sur son propre document et après avoir posé le drapeau interne ; `tente()` isole désormais chaque refus dur dans un point de sauvegarde, sinon un `42501` masquait les assertions suivantes |

## 6. Déploiement

**Prérequis à vérifier en lecture seule avant toute exécution** (non exécutés ici) :

1. le rôle de connexion des migrations possède `CREATEROLE` — la migration crée
   `tracefab_worker` ;
2. il peut attribuer la propriété d'une fonction (`ALTER FUNCTION … OWNER TO`),
   ce qui est vrai s'il peut créer un rôle et s'en accorder l'appartenance ;
3. l'historique `_prisma_migrations` contient bien les 59 migrations antérieures
   et aucune migration en échec.

**Ordre** : `prisma migrate deploy` applique `20261028120000` puis
`20261028120100`. Les deux sont transactionnelles.

**Vérification après application** (lecture seule) :

```sql
-- 90 noms, 0 hors registre, worker sans LOGIN
SELECT count(*) FROM public.tracefab_runtime_function_registry;
SELECT c.relname FROM public.tracefab_runtime_function_registry;
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
   AND p.proname NOT IN (SELECT name FROM public.tracefab_runtime_function_registry);
SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'tracefab_worker';
```

Attendu : `90`, `0`, `f | f | f`.

## 7. Retour arrière

Le retour arrière est **techniquement possible et opérationnellement déconseillé** :
revenir au GUC rouvre la faille. Il n'est légitime que pour rétablir un service
pendant une fenêtre de quelques minutes.

```sql
-- 1. Remettre les onze politiques sur le GUC (état d'origine exact) :
--    exécuter docs/security/candidats/2026-10-28-retour-arriere-contexte-worker.sql
-- 2. Détacher les fonctions de l'identité worker
ALTER FUNCTION public.tracefab_upsert_clerk_user(TEXT,TEXT,TEXT) OWNER TO <propriétaire des migrations>;
-- … idem pour les cinq autres
-- 3. Rendre au rôle applicatif l'écriture directe sur users (rétablit l'ancien chemin)
GRANT INSERT, UPDATE, DELETE ON TABLE public.users TO tracefab_app;
-- 4. Détruire le registre
DROP FUNCTION public.tracefab_apply_runtime_function_grants();
DROP TABLE public.tracefab_runtime_function_registry;
-- 5. Détruire l'identité worker
DROP ROLE tracefab_worker;
-- 6. Défaire 20261028120200 (champs réservés de documents)
DROP FUNCTION public.tracefab_mark_document_scanning(UUID);
GRANT INSERT, UPDATE, DELETE ON TABLE public.documents TO tracefab_app;
DELETE FROM public.tracefab_runtime_function_registry WHERE name = 'tracefab_mark_document_scanning';
```

**Ordre à respecter** : `documents` doit retrouver son `GRANT` d'écriture *avant*
que le code applicatif ne revienne à l'ancien `UPDATE` direct, sinon le parcours
de scan échoue en `42501` entre les deux étapes.

Les migrations restant enregistrées dans `_prisma_migrations`, un redéploiement
ultérieur ne les rejouera pas : c'est un retour arrière **manuel**, à documenter
comme incident si utilisé.

## 8. Ce qui reste ouvert

- **P0 non clos** : la falsification est neutralisée dans un correctif livrable,
  mais les migrations **ne sont appliquées à aucune base distante**. Tant que ce
  n'est pas fait en production, le défaut y subsiste.
- **Identité DB de production non mesurée** (`databaseIdentity.measured !== true`).
- `test:neon:auth-provisioning` et `test:neon:security` n'ont pas pu être exécutés
  hors ligne : le client Prisma ne se génère pas ici (`binaries.prisma.sh`
  inaccessible). Ils tournent en CI, où le client est généré.
