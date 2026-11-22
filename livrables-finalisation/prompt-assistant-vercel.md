# Message à transmettre à l'assistant disposant d'un accès Vercel / Neon

Copier le bloc ci-dessous tel quel.

---

## Contexte

Projet : **TraceFab**, dépôt `Huberaya/Tracefab`, branche `main` = `e7713dc`.
Chantier : **P10.7**, activation de l'identité HMAC signée sur l'environnement **Vercel Preview**.

L'agent côté code a terminé tout ce qui ne demande pas d'accès distant :

- Sondes C3 et C4 **PASS** sur le déploiement Preview réel.
- Preuves runtime reproductibles, expurgées, publiées.
- Trois défauts corrigés dans la chaîne de preuve (PR #132, `MERGEABLE` / `CLEAN`, CI 4/4 verte).

Il reste **une seule action**, qui exige un accès Vercel (et éventuellement Neon) qu'il n'a pas :
poser `TRACEFAB_IDENTITY_KEY` sur l'environnement **Preview**, avec la valeur de la clé déjà
stockée en base.

**Autorisation du propriétaire : accordée** pour cette variable, sur **Preview uniquement**.

## État mesuré (à ne pas refaire)

Le runtime Preview joint une base Neon migrée, avec les objets d'identité présents :

```
base_oid           : 16396
base_nom           : neondb
hote_empreinte     : 55c809d501c6     (SHA-256 tronqué du hostname réellement injecté)
schemas_empreinte  : 4a145f39b5da
tracefab_identity_cles           : present
tracefab_identity_politique      : present
tracefab_current_user_email      : present
mode_strict        : true
rls_forcee         : true
identityTokens.configured        : false      <-- c'est ce false qu'il faut lever
```

Ces empreintes permettent de **vérifier** qu'on travaille sur la bonne base, pas de la nommer.

## Tâche demandée

### 1. Retrouver la bonne base, sans supposer

Ne pas se fier à un nom de branche Neon. Prendre la valeur de `DATABASE_URL` de l'environnement
**Preview** (Vercel → projet `tracefab` → Settings → Environment Variables), puis la vérifier :

```bash
node scripts/diagnostic_base_preview_p107.mjs --url "<DATABASE_URL Preview>"
```

L'outil est en lecture seule (`default_transaction_read_only`), refuse l'hôte de Production,
refuse tout hôte non-Neon, et n'affiche jamais l'URL ni le mot de passe.

Il doit répondre que l'URL joint bien `base_oid 16396` / `hote_empreinte 55c809d501c6`.
**Si ce n'est pas le cas, s'arrêter** : c'est une autre base, et il faut le signaler au lieu de continuer.

### 2. Lire la clé active — sans jamais l'afficher

La clé à utiliser est **celle qui est déjà en base**. Il n'y a rien à générer.

```sql
SELECT encode(secret, 'hex') FROM public.tracefab_identity_cles
 WHERE actif ORDER BY version DESC LIMIT 1;
```

La valeur doit faire **64 caractères hexadécimaux** (32 octets).

**Ne pas l'afficher, ne pas la copier dans un message, ne pas la journaliser.** La faire transiter
directement de la requête vers l'écriture Vercel, dans le même script si possible.

### 3. Poser la variable sur Preview

- Nom : `TRACEFAB_IDENTITY_KEY`
- Environnement : **Preview uniquement** (jamais Production, jamais Development)
- Type : `sensitive` (ou `encrypted` selon ce que propose l'interface)
- Valeur : la clé lue à l'étape 2, telle quelle (hex minuscule, 64 caractères)

Puis **redéployer** la Preview pour que la variable soit prise en compte : une variable ajoutée
n'affecte pas un déploiement déjà construit.

## Contrat de clé (vérifié dans le code)

| Aspect | Valeur |
|---|---|
| Format | hexadécimal, `^[0-9a-fA-F]+$` |
| Longueur | ≥ 64 caractères, **paire** |
| Décodage | `Buffer.from(cle, 'hex')` → 32 octets |
| Lien avec la base | la base recalcule `hmac(corps, k.secret, 'sha256')` avec sa clé active et compare. Une clé différente de celle en base donne **C1 FAIL**, pas PASS |

## Vérification attendue après coup

```bash
gh workflow run p107-preuves-runtime.yml --ref main
```

Le résultat doit montrer :

```
identityTokens.configured : true
identitySysteme.configured : true
mode                      : signe
C1.1 / C1.2 / C1.3        : PASS
C2.1 / C2.2 / C2.3        : PASS
```

`C1.2` est le point décisif : il prouve un **aller-retour réel** — le runtime signe un jeton, la
base le vérifie et l'accepte. Ce n'est pas une simple présence de variable.

Si `C1.2` échoue alors que la variable est présente, c'est que la clé posée ne correspond pas à
celle de cette base : reprendre à l'étape 1.

## Règles à respecter

- **Ne pas** modifier la Production, ni ses variables.
- **Ne pas** exécuter `prisma migrate deploy` / `resolve`, ni toucher `_prisma_migrations`.
- **Ne pas** modifier les rôles, grants, politiques RLS ou le schéma.
- **Ne pas** supprimer de branche Neon.
- **Ne pas** désactiver la protection Vercel / SSO.
- **Ne pas** afficher, coller ou transmettre la valeur de la clé.
- **Ne pas** fusionner de PR.

## Variante autorisée si la lecture de la clé existante est impossible

Générer une nouvelle clé et l'écrire **à la fois** en base et dans Vercel — c'est une rotation :

```bash
# valeur générée dans une variable shell, jamais affichée
TF_IDENTITY_KEY_HEX="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
TF_ALLOW_PROVISIONING=oui DATABASE_ADMIN_URL="<url admin>" \
  node scripts/provisionner_cle_identite.mjs --retirer-anciennes
```

Puis poser `$TF_IDENTITY_KEY_HEX` dans Vercel Preview, et vérifier comme ci-dessus.
Cette variante écrit en base : elle ne doit être retenue que si la première est bloquée.

## Ce qu'il faut me renvoyer

1. La confirmation que l'URL Preview joint bien `base_oid 16396` / `hote_empreinte 55c809d501c6`.
2. L'identifiant du redéploiement Preview effectué.
3. Le résultat brut de `C1.1` à `C2.3` (verdicts uniquement, jamais la clé).
4. Si quelque chose a échoué : le message d'erreur exact, sans secret.
