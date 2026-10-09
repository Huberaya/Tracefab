# Runbook — sauvegarde et restauration

À exécuter sous pression, sans réfléchir à l'architecture. Chaque section
commence par ce qu'il faut taper.

---

## Ce qu'il faut savoir avant l'incident

TRACEFAB stocke ses données dans **deux systèmes qui ne partagent pas la même
ligne de temps** :

| Système | Contenu | Restauration |
|---|---|---|
| **Neon / Postgres** | Produits, fournisseurs, demandes, métadonnées de documents, scores | Instantanée, à la milliseconde près, dans la fenêtre d'historique |
| **Stockage privé S3** | Les fichiers eux-mêmes : certificats, rapports d'essai, factures | **Hors de la ligne de temps Postgres** |

> **La conséquence qui surprend tout le monde.** Restaurer la base ramène les
> *lignes* `documents`, pas les *objets*. Si un fichier a été supprimé du
> stockage après l'instant de restauration, la base pointera vers un objet
> absent. Inversement, les fichiers déposés après cet instant deviendront des
> orphelins que plus aucune ligne ne référence.
>
> Toute restauration de base impose donc une **réconciliation stockage**
> (section 4). Ce n'est pas optionnel.

### Fenêtre d'historique Neon

| Formule | Fenêtre maximale |
|---|---|
| Free | 6 heures, plafonnée à 1 Go de changements |
| Launch | jusqu'à 7 jours |
| Scale | jusqu'à 30 jours |

Seules les **branches racines** (dont `main`) supportent la restauration
instantanée. Une branche enfant se réinitialise depuis son parent.

**À vérifier aujourd'hui, pas le jour de l'incident :** la fenêtre configurée
sur le projet. Une fenêtre de 6 heures signifie qu'une corruption découverte le
lundi matin après un week-end est irrécupérable.

---

## 1. Avant de restaurer — regarder sans toucher

Ne restaurez jamais en premier. Neon permet d'interroger le passé.

**Option A — Time Travel Assist**, dans la console Neon, section *Restore* :
saisir l'horodatage et exécuter une requête de contrôle.

```sql
-- Les données étaient-elles saines à cet instant ?
SELECT count(*) FROM tracefab_products;
SELECT count(*) FROM documents WHERE deleted_at IS NULL;
```

**Option B — bifurquer pour inspecter**, sans rien écraser :

```bash
neon branches create --name enquete --parent 2026-10-08T14:30:00Z
# Se connecter à la branche "enquete", vérifier, puis la supprimer.
```

C'est l'option à préférer : elle ne touche pas à la production.

---

## 2. Restaurer la base

```bash
# Ramène main à un instant donné, en conservant l'état actuel sous un autre nom
neon branches restore main ^self@2026-10-08T14:30:00Z \
  --preserve-under-name main_avant_restauration_20261008
```

Ce qu'il faut avoir en tête :

- **La restauration écrase, elle ne fusionne pas.** Données *et* schéma de
  toutes les bases de la branche reviennent à l'instant visé. Tout ce qui a été
  écrit après est exclu.
- Neon conserve l'état antérieur dans une branche de sauvegarde. La
  restauration est donc réversible — ne supprimez pas cette branche avant
  d'avoir validé.
- L'opération prend quelques secondes. **Les chaînes de connexion ne changent
  pas.** Les connexions en cours sont interrompues ; l'application se
  reconnecte seule, comme après un démarrage à froid.

### Immédiatement après

```bash
# Les migrations sont-elles à l'état attendu ?
npx prisma migrate status

# RLS toujours armée ? Si la restauration a ramené un schéma antérieur,
# des politiques peuvent manquer.
npm run test:cross-tenant
```

---

## 3. Si la fenêtre d'historique est dépassée

La restauration instantanée n'est plus possible. Deux recours :

1. **Un instantané** (*snapshot*), s'il en existe un. Les instantanés
   survivent à la fenêtre glissante et se restaurent en une étape, sur la
   branche existante ou sur une nouvelle branche que l'on inspecte d'abord.
2. **Un export logique**, s'il a été produit :

```bash
pg_restore --no-owner --no-privileges -d "$DATABASE_URL" sauvegarde.dump
```

> **À mettre en place si ce n'est pas fait.** Les formules payantes permettent
> de planifier des sauvegardes automatiques qui ne comptent pas dans le quota
> d'instantanés manuels. Sans instantané ni export, une corruption découverte
> au-delà de la fenêtre est définitive.

---

## 4. Réconcilier le stockage — obligatoire après toute restauration

Le stockage S3 n'a pas bougé pendant la restauration. Deux divergences à
traiter, dans cet ordre.

**a. Lignes pointant vers un objet absent** — l'utilisateur verra une erreur de
téléchargement.

```sql
-- Lister les clés à vérifier côté stockage
SELECT id, storage_key, created_at
FROM documents
WHERE deleted_at IS NULL
ORDER BY created_at DESC;
```

Pour chaque clé, un `HEAD` sur le bucket. Celles qui répondent 404 doivent être
marquées comme manquantes et leurs demandes de données rouvertes — un document
de preuve absent invalide la couverture de preuve du produit concerné.

**b. Objets orphelins** — déposés après l'instant de restauration, plus
référencés par aucune ligne. Ils consomment du quota et contiennent des données
client : ils doivent être recensés avant toute suppression, jamais effacés en
masse sans inventaire.

**Vérification de bout en bout une fois la réconciliation faite :**

```bash
curl -s -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness?probe=live" | jq
```

---

## 5. Prévenir

Une restauration est visible des clients : des données ont disparu entre
l'instant restauré et maintenant.

- Si des soumissions fournisseurs ont été perdues, les fournisseurs concernés
  doivent être prévenus et leurs demandes rouvertes. **Un fournisseur qui
  découvre seul que son travail a disparu ne recommence pas.**
- Les scores de maturité DPP et les indices qualité se recalculent à partir
  des données. Ils bougeront. Un client qui suit son score verra la variation.

---

## 6. À vérifier tous les trimestres

Un runbook jamais répété est une fiction.

- [ ] Créer une branche depuis un horodatage, s'y connecter, vérifier que les
      données sont cohérentes, supprimer la branche. **Chronométrer.**
- [ ] Confirmer la fenêtre d'historique du projet et qu'elle couvre le délai de
      détection réaliste, week-ends compris.
- [ ] Confirmer qu'un instantané récent existe.
- [ ] Rejouer la section 4 sur un échantillon : prendre dix clés en base,
      vérifier leur présence dans le bucket.
- [ ] Vérifier que `?probe=live` répond `200` et que chaque sonde est verte.
