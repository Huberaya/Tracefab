# P10.7 — Accéder à une Preview protégée par Vercel Authentication

Ce document existe parce que le mécanisme était **utilisé sans être documenté** :
le workflow `p107-preuves-runtime.yml` lisait `VERCEL_AUTOMATION_BYPASS_SECRET`
et `scripts/sonde_preview.mjs` envoyait `x-vercel-protection-bypass`, mais aucun
fichier de `docs/` ne décrivait ni la procédure, ni le nom attendu, ni la
rotation. Une configuration qui n'est écrite nulle part n'est pas
reproductible : elle dépend de la mémoire de celui qui l'a faite.

## 1. Le problème, mesuré

Le 2026-11-16, la Preview de la branche
`release/p107-runtime-production-20261110` répondait :

```
HTTP 302 → https://vercel.com/sso-api?url=...
corps : {"error":"vercel_auth_enabled","message":"Protected by Vercel Authentication"}
```

Aucune requête n'atteint l'application. Les critères C1–C4 sont donc
**inobtenables**, et un 302 lu comme un échec de C3 produit un faux négatif —
c'est-à-dire un rapport qui accuse l'application quand c'est l'observateur qui
n'a pas le droit d'entrer.

## 2. La voie officielle, et la seule utilisée

Vercel expose **Protection Bypass for Automation** : un secret qui, présenté
dans l'en-tête `x-vercel-protection-bypass`, laisse passer une requête
automatisée **sans désactiver la protection**. C'est la seule méthode employée
ici.

Ce qui n'est **jamais** fait :

- désactiver Vercel Authentication ;
- retirer le SSO du projet ;
- rendre la Preview publique ;
- partager un cookie de session ou un jeton personnel.

## 3. Procédure de mise en place

1. Vercel → projet concerné → **Settings → Deployment Protection**.
2. Section **Protection Bypass for Automation** → **Generate**.
3. Copier la valeur **une seule fois** (elle n'est plus affichée ensuite).
4. GitHub → Settings → Secrets and variables → Actions → **New secret** :
   nom **`VERCEL_AUTOMATION_BYPASS_SECRET`**, valeur collée.
5. Ne jamais l'écrire dans un fichier du dépôt, un ticket, une conversation ou
   un journal.

Le nom est celui que lit le workflow. Un nom différent — par exemple un
`TRACEFAB_AUTOMATION_BYPASS` évoqué dans un message d'erreur antérieur — ne
serait **pas** lu : le workflow et le script attendent exactement
`VERCEL_AUTOMATION_BYPASS_SECRET`.

## 4. Ce que le code fait de la valeur

`scripts/preuve_runtime_p107.mjs` :

```js
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
// ...
if (BYPASS) h['x-vercel-protection-bypass'] = BYPASS;
```

Propriétés vérifiables dans le code :

- l'en-tête n'est ajouté que s'il existe une valeur ;
- il n'est envoyé qu'à l'hôte sondé, jamais à un autre domaine ;
- **la valeur n'est jamais journalisée** : aucun `console.log` ne la prend pour
  argument, et le fichier de preuve écrit ne contient que le SHA, la cible et
  des verdicts ;
- le workflow mesure la **présence** (`[ -n "$BYPASS" ]`), jamais le contenu.

## 5. Alternative sans secret : `vercel curl`

Une personne disposant d'une session Vercel authentifiée peut atteindre la
Preview sans créer de secret :

```bash
vercel curl '/api/internal/p2/readiness?identity=1' \
  --deployment https://<preview>.vercel.app \
  --header 'x-tracefab-runtime-probe-token: <jeton>'
```

Cette voie ne remplace **pas** le mécanisme du workflow : elle n'est pas
reproductible dans GitHub Actions (elle exige une session interactive), et sa
sortie doit être reportée à la main dans le rapport. Elle est acceptable pour
lever un blocage ponctuel, pas pour rendre les preuves reproductibles.

## 6. Rotation d'un secret compromis

Toute valeur ayant figuré dans une conversation, un journal, une capture ou un
ticket est **compromise**, même si elle n'a jamais été utilisée.

1. Vercel → Deployment Protection → **Protection Bypass for Automation** →
   révoquer / **Regenerate**.
2. Mettre à jour le secret GitHub `VERCEL_AUTOMATION_BYPASS_SECRET`.
3. Vérifier que le run suivant rapporte `bypass=PRESENT` **et** que la Preview
   répond autre chose que `302`.
4. Ne pas déclarer l'accès rétabli tant que les deux points ci-dessus ne sont
   pas observés ensemble.

À ce jour, cette rotation **reste à faire par le propriétaire des accès**. Le
dernier état mesuré est `bypass=ABSENT` : le contournement n'est donc pas — et
n'a pas été — opérationnel dans les runs de cette branche.

## 7. Comment savoir que l'accès fonctionne

Le workflow affiche une annotation :

```
sonde=PRESENT bypass=PRESENT vercel_token=ABSENT
```

- `bypass=ABSENT` → aucun accès automatisé ; C1–C4 sont **BLOCKED**.
- `bypass=PRESENT` mais réponse `302` → le secret ne correspond pas à ce
  déploiement (exemple : régénéré côté Vercel, pas côté GitHub) ; **BLOCKED**.
- réponse `401` avec un corps applicatif → la requête **atteint** l'application ;
  les preuves deviennent mesurables.

Un `302` n'est jamais un succès. Un `401` applicatif n'est jamais un échec de
configuration.
