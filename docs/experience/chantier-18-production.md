# Chantier 18 — Production Readiness

**PR #30** · branche `experience/chantier-18-production` · commit `a777841`
**CI verte sur GitHub**, les quatre étages.

---

## Trois manques structurels, fermés

### 1. Il n'y avait aucune barrière d'erreur

`api/index.ts` répartissait vers les gestionnaires **sans `try/catch`**. Une
exception non rattrapée remontait au runtime serverless : le client recevait un
500 opaque, l'erreur n'atterrissait nulle part, personne n'était prévenu.

Ce n'était pas théorique. **13 des 125 routes n'ont aucun `try/catch`** — dont
`dpp/portfolio.ts`, que j'ai écrite moi-même au chantier 13. `storage.ts` jette
sur mauvaise configuration. Le chargement dynamique du module peut échouer.
N'importe lequel de ces trois chemins produisait une panne muette.

Désormais : identifiant de corrélation rendu au client, erreur dans un journal
JSON structuré, et une réponse déjà commencée n'est jamais écrasée.

### 2. Aucun suivi d'erreurs

Zéro occurrence de Sentry, Datadog ou équivalent. 105 routes font un
`console.error` dans les journaux Vercel — que personne ne regarde.

`api/_lib/error-reporting.ts` : journal `stderr` **inconditionnel**, plus un
POST optionnel vers un collecteur configurable.

**Aucune dépendance ajoutée.** Le dépôt signe lui-même en SigV4 et appelle
Resend au `fetch` ; y planter un SDK de fournisseur aurait juré avec tout le
reste. N'importe quel collecteur accepte un webhook JSON.

**Les secrets sont caviardés avant sortie.**

```
avant : explosion avec postgres://user:motdepasse@host/db et sk_live_ABCDEFGH12345678
après : explosion avec postgres://[caviarde] et [cle-caviardee]
```

Chaînes Postgres, clés Clerk, Resend, AWS, en-têtes Bearer, JWT, paramètres
signés. Une clé d'API archivée dans un collecteur de logs est une fuite
permanente — et c'est un accident banal, pas un scénario exotique.

### 3. La readiness ne vérifiait rien de vivant

L'endpoint existant annonçait lui-même `configurationOnly: true`. Il constatait
que les variables sont **définies**.

Une clé présente n'est pas une clé valide. Un bucket nommé n'est pas un bucket
joignable. Le jour de la mise en production, la différence est tout.

`?probe=live` exerce réellement la base, le stockage, l'antivirus, Resend et
les deux collecteurs. Opt-in délibérément : on n'appelle pas cinq services
externes à chaque passage d'une supervision. Le mode par défaut est inchangé,
`test_p2_readiness` reste vert.

> **Un défaut trouvé en cours de route.** Ma première sonde e-mail traitait une
> clé Resend invalide comme valide : Resend répond **400** sur une clé
> malformée, pas 401. Je ne considérais comme refus que 401 et 403. Seul un 2xx
> vaut acceptation. C'est exactement le faux positif que la sonde existe pour
> empêcher — une sonde qui ment est pire que pas de sonde.

---

## Documents d'exploitation

| Document | Contenu |
|---|---|
| `variables-environnement.md` | Contrat des **39 variables** : criticité, rôle, conséquence d'absence |
| `runbook-sauvegarde-restauration.md` | Restauration Neon, fenêtre d'historique, réconciliation stockage |
| `checklist-mise-en-production.md` | Chaque ligne vérifiable par une commande |

### Le point du runbook que la documentation Neon ne dit pas à votre place

TRACEFAB stocke dans **deux systèmes qui ne partagent pas la même ligne de
temps** : Postgres pour les données, S3 pour les fichiers.

Restaurer la base ramène les *lignes* `documents`, pas les *objets*. Un fichier
supprimé après l'instant restauré laisse une ligne qui pointe vers le vide ;
un fichier déposé après devient un orphelin que plus rien ne référence.

**Toute restauration impose donc une réconciliation du stockage.** Le runbook
en fait une section obligatoire, pas une remarque.

Les faits Neon sont vérifiés, pas supposés : restauration instantanée sur les
branches racines seulement, fenêtre de 6 h à 30 jours selon la formule,
l'opération écrase et ne fusionne pas, Neon conserve l'état antérieur dans une
branche de sauvegarde.

---

## Le garde-fou

`scripts/test_production_readiness.ts`, câblé au job **socle** de la CI —
l'étage le plus rapide, pour que l'échec tombe en moins de trente secondes.

Deux choses le distinguent d'une checklist déguisée en test :

**Il exécute le vrai caviardage** au lieu de constater que des motifs existent
dans le fichier. Sept secrets réalistes lui sont soumis à chaque passage.

**Il compare le contrat de variables au code.** Toute variable lue par `api/`
et absente du document fait échouer la CI. Il en a trouvé deux que le motif
`process.env.X` manquait, parce qu'elles sont lues dynamiquement via
`configuredInteger('X', …)` : `TRACEFAB_NOTIFICATION_BATCH_LIMIT` et
`TRACEFAB_REMINDER_HORIZON_HOURS`.

Vérifié par morsure : en retirant la barrière d'erreur, 5 contrôles tombent.
Puis ils repassent au vert une fois la barrière remise.

---

## Deux fois où mon propre test m'a pris en défaut

Je les note parce qu'elles disent quelque chose sur la façon d'écrire un
garde-fou.

1. Mon contrôle « la remontée ne dépend d'aucun fournisseur » cherchait
   `sentry|datadog|…` dans le fichier. **Mon propre commentaire les citait en
   exemple.** Un contrôle doit viser la structure — ici les lignes `import` —
   jamais la présence d'un mot.
2. Mon recensement de variables a signalé `TRACEFAB_ALGORITHMIC_AUDITOR`, qui
   n'est pas une variable mais une valeur sentinelle. Un motif trop large
   produit du bruit, et le bruit fait désactiver les garde-fous.

C'est la même leçon que l'audit cross-tenant du chantier 17, qui avait signalé
36 fausses fuites.

---

## État de la pile

Cinq PR ouvertes, **à fusionner dans cet ordre** :

```
main 7cfc669
 └── #26  chantier 15 — i18n                     3273913
      └── #27  chantier 13 — DPP actionnable          a07d704
           └── #28  chantier 14 — passeport dynamique     2c65e7a
                └── #29  chantier 17 — CI                     c9128a4
                     └── #30  chantier 18 — production            a777841
```

---

## Ce qui reste, et qui est écrit dans la checklist

| Sujet | État | Chantier |
|---|---|---|
| CSP sans `'unsafe-inline'` | non fait | 16 |
| Limitation de débit sur l'API | **aucune** | 16 |
| Pagination des listes | **aucune** | 16 |

**L'absence de limitation de débit est la plus exposée des trois.** Une API
publique sans plafond est une facture et une indisponibilité qui attendent leur
déclencheur. Le passeport public `/api/dpp/:gtin` est ouvert par construction.

Deux dettes connues restent aussi ouvertes depuis le chantier 17 : la métrique
de qualité affichée différemment sur l'accueil (92,4 %) et dans la console
(91,4 %), et le français codé en dur dans la lignée produit. Les deux figurent
dans la checklist pour qu'on ne les découvre pas le jour J.
