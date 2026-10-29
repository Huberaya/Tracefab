# Écart constaté entre la production et le dépôt

**Date :** 27 octobre 2026
**Base examinée :** `ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech` (production)
**Mode :** lecture seule, requêtes fournies au propriétaire et exécutées par lui
**Aucune écriture n'a été effectuée sur cette base.**

---

## 1. Ce qui a été demandé, et ce qui a été obtenu

Trois requêtes `SELECT` exécutées dans l'éditeur SQL de Neon, puis une mesure
exécutée localement à partir du code réellement déployé.

| # | Question | Réponse obtenue |
|---|---|---|
| 1 | La correction qualité est-elle appliquée ? | `migrations_appliquees: 56`, `correction_qualite_deja_appliquee: false` |
| 2 | Quelle règle est en place ? | `barriere_exige_une_evaluation: true`, `contient_la_barriere: false` |
| 3 | Combien de dossiers concernés ? | `produits: 18`, `produits_prets_sans_evaluation: 0`, `dossiers_publies_sans_evaluation: 0` |
| 4 | Les 8 dernières migrations appliquées | la plus récente est `20261023120000_revoke_app_default_dml`, le 22/10 à 23 h 23 |
| 5 | Le profil d'exigences actif | `textile_readiness_mvp` v1.0, **9 exigences** |

## 2. Une erreur de ma part, corrigée

La requête 2 était **mal conçue** : elle testait la présence du mot
`data_quality_scores` dans le corps de la fonction. Or ce mot figure aussi dans
la version d'origine, pour un autre contrôle (`quality.no_blocking_issues`). Le
test répond donc `true` dans les deux états et ne discrimine rien.

Reproduit en exécution sur les deux états :

| État | `data_quality_scores` (ma sonde) | `quality.no_open_issues` |
|---|---|---|
| Production (56 migrations) | `true` | `false` |
| Dépôt (58 migrations) | `true` | `true` |

C'est le second champ qui portait l'information. Une sonde qui ne distingue pas
les deux états qu'elle prétend séparer est pire qu'aucune sonde : elle produit
une certitude fausse. Elle est remplacée par l'extraction de la liste réelle des
exigences (voir §5).

## 3. Diagnostic : deux migrations manquent

Le dépôt contient **58** migrations, la production en a **56**. La plus récente
appliquée date du 22 octobre ; deux migrations postérieures ne le sont pas :

| Migration | Ce qu'elle installe | État en production |
|---|---|---|
| `20261021170000_dpp_readiness_truthful_gates` | le profil DPP à **13 exigences** et la fonction associée | **absente** |
| `20261027100000_dpp_quality_gate_requires_assessment` | la correction de la barrière qualité (objet de la branche) | **absente** |

Confirmation indépendante : le profil actif en base porte **9 exigences**, ce qui
correspond exactement à la définition d'origine
(`20260923130000_tracefab_neon_initial`), et à aucun autre état du dépôt.

Le chevauchement entre ce que la base sait calculer aujourd'hui (9 exigences) et
ce que l'API déployée attend (13 exigences) explique tout le reste :

- calculées par la base et attendues par l'API : **7** ;
- attendues par l'API et jamais calculées : **6** — `product.required_attributes`,
  `product.not_draft`, `traceability.documented`, `materials.origin_documented`,
  `quality.no_open_issues`, `evidence.product_data` ;
- calculées par la base et ignorées par l'API : **2** — `product.data_ready`,
  `quality.no_blocking_issues`.

## 4. Conséquence mesurée — le parcours DPP est bloqué en production

Mesure exécutée : `buildDppSummary` (le code déployé, `api/_lib/dpp.ts` à la
révision de production `bf55f2a`) appliqué à un dossier **parfait** produit par
la base de production — 9 exigences évaluées, toutes satisfaites, aucune anomalie.

| Indicateur | Valeur obtenue |
|---|---|
| exigences évaluées par la base | 9 |
| exigences attendues par l'API | 13 |
| exigences satisfaites | 7 |
| **score affiché** | **54 %** |
| **statut** | **`in_progress`** |
| **bouton « Valider & prêt à publier »** | **jamais affiché** |

**Autrement dit : en production, aucun dossier ne peut atteindre « prêt à
publier », quel que soit le travail accompli.** Ce n'est pas un défaut de
données, ni un défaut de code : c'est l'écart entre la base et le code déployé.
La logique de l'API est volontairement fermée en cas d'absence — une exigence
non évaluée n'est jamais considérée comme satisfaite — et elle fait exactement
son travail : elle refuse de déclarer prêt ce qui n'a pas été évalué.

Pour la mission « premier DPP textile réel », cela signifie que **la phase C ne
peut pas aboutir en production aujourd'hui**, et cela ne vient ni des données du
T-shirt ni des écrans : les deux sont prêts, la base est en retard.

## 5. Sonde de remplacement (à utiliser désormais)

```sql
SELECT array_agg(m[1] ORDER BY m[1]) AS exigences_installees
FROM pg_proc p,
     regexp_matches(p.prosrc, '''([a-z_]+\.[a-z_]+)''', 'g') AS m
WHERE p.proname = 'tracefab_dpp_requirement_met';
```

Résultat attendu selon l'état :

- **9 ou 10 exigences** (`product.data_ready` présente) → état d'origine ;
- **13 exigences**, dont `quality.no_open_issues` et `product.not_draft` → à jour.

Et pour lever le seul doute résiduel (§3) :

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name IN (
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment'
);
```

Si aucune ligne ne revient, ces migrations n'ont jamais été tentées. Si une
ligne revient avec `rolled_back_at` renseigné, elles ont été appliquées puis
annulées — même conclusion opérationnelle, cause différente.

## 6. Ce qui n'est PAS arrivé — la bonne nouvelle

- **Aucun dossier n'a été publié sans contrôle** : `dossiers_publies_sans_evaluation: 0`.
- **Aucun produit n'est marqué prêt sans évaluation** : `produits_prets_sans_evaluation: 0`.
- Les 18 produits n'ont donc **rien à défaire**. Le blocage est survenu *avant*
  qu'un faux « vert » ne sorte.

C'est une différence importante avec ce que le journal craignait : le défaut
existait dans le code, mais aucune donnée de production n'en a été contaminée.

## 7. Cause racine

`package.json` → script `build` : **aucune étape n'applique les migrations**.

```
"build": "npm run db:generate && npm run verify:prisma-client && … && npm run test:error-reporting"
```

Le déploiement Vercel publie donc le code sans mettre la base à jour ; les
migrations doivent être appliquées **manuellement** (`npm run db:deploy`). Cette
étape n'a pas été faite pour les deux migrations ci-dessus. Le registre du dépôt
(`docs/experience/CHANTIERS-RESTANTS.md`) le signalait déjà comme un risque
structurel, dans une alerte datée du 17 octobre.

## 8. Remédiation recommandée — dans cet ordre, sans exception

### Étape 0 — Banc d'essai, sans risque

Neon permet de créer une **branche** (copie instantanée par pointeur, sans
duplication). C'est l'endroit correct pour essayer :

1. créer une branche depuis la production ;
2. y lancer `npm run db:deploy` avec l'URL **de la branche** ;
3. y exécuter les vérifications du §9 ;
4. supprimer la branche si le résultat ne convient pas.

La production n'est pas touchée tant que l'étape 1 de la §8.2 n'est pas faite.

### Étape 1 — Ordre impératif des deux migrations

| Ordre | Migration | Pourquoi cet ordre |
|---|---|---|
| **1** | `20261021170000_dpp_readiness_truthful_gates` | installe le profil à 13 exigences et la fonction |
| **2** | `20261027100000_dpp_quality_gate_requires_assessment` | corrige une branche de cette même fonction |

**L'ordre inverse annulerait silencieusement la correction.** Les deux
migrations font un `CREATE OR REPLACE` sur la même fonction : appliquer la
correction avant la mise à jour du profil ferait réécrire la fonction par la
version fautive, sans aucune erreur. `prisma migrate deploy` applique l'ordre
lexicographique, qui est le bon ici — c'est une raison de plus de passer par
lui et **jamais** par une exécution manuelle du SQL.

### Étape 2 — Application en production

Par un opérateur, avec sauvegarde ou branche de restauration disponible, sur un
créneau choisi. Commande :

```
DATABASE_URL='postgresql://…' npm run db:deploy
```

C'est une action d'exploitation : elle n'est ni déclenchée ni exécutée par
l'agent qui a écrit ce rapport.

### Étape 3 — Recalcul des 18 produits

Après migration, les évaluations persistées portent encore l'ancien profil à
9 exigences. Les dossiers resteront à 54 % tant qu'ils n'auront pas été
recalculés (`POST /api/products/:id/dpp`), exigence par exigence, puis revus.
C'est un travail de données, pas de code — et il devra être planifié : 18
produits à recalculer, puis à évaluer qualité par qualité.

## 9. Vérifications après application

```sql
-- 1. le profil doit passer à 13 exigences
SELECT profile_version, status,
       jsonb_array_length(definition -> 'requirements') AS nb_exigences
FROM dpp_requirement_profiles WHERE profile_key = 'textile_readiness_mvp';

-- 2. la fonction doit porter la correction
--    ATTENTION : la fonction implante PLUS de clés que le profil n'en compte.
--    Elle conserve deux branches héritées (`product.data_ready`,
--    `quality.no_blocking_issues`) qui ne sont plus évaluées. Compter les clés
--    de la fonction et attendre « 13 » est donc faux — première version de ce
--    contrôle, corrigée après l'avoir vu échouer sur une base migrée.
--    Ce qui fait foi est la correspondance PROFIL → FONCTION.
SELECT
  (SELECT array_agg(e ->> 'key' ORDER BY e ->> 'key')
     FROM dpp_requirement_profiles,
          jsonb_array_elements(definition -> 'requirements') e
    WHERE profile_key = 'textile_readiness_mvp' AND status = 'active') AS exigences_du_profil,
  (SELECT array_agg(m[1] ORDER BY m[1])
     FROM pg_proc p, regexp_matches(p.prosrc, '''([a-z_]+\.[a-z_]+)''', 'g') AS m
    WHERE p.proname = 'tracefab_dpp_requirement_met') AS cles_implantees;
-- attendu : 13 exigences de profil, toutes présentes dans les clés implantées,
--           dont quality.no_open_issues.

-- 3. le registre doit compter 59 migrations
--    (58 lors du constat du 27/10 matin + la 59e corrective
--     20261027130000_dpp_review_preservation_and_publication_coherence)
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;

-- 4. aucune régression de privilège
SELECT has_function_privilege('public', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS public_peut,
       has_function_privilege('tracefab_app', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS app_peut;
-- attendu : false, false
```

## 10. Ce qu'il ne faut pas faire

| À éviter | Pourquoi |
|---|---|
| Exécuter le SQL des migrations à la main | `_prisma_migrations` ne serait pas écrit ; les garde-fous du dépôt échouent sur toute dérive, et l'étape 1 deviendrait invisible |
| Appliquer la correction seule | elle serait écrasée par la migration suivante (§8.1) |
| Appeler « prêt à publier » sans recalcul | les 18 dossiers resteraient à 54 % et la revue serait refusée |
| Considérer le blocage comme un défaut d'interface | l'interface et l'API sont correctes ; c'est la base qui est en retard |

---

## Annexe — ce que ce constat ne prouve pas

- Que le code déployé en production soit exactement `bf55f2a`. C'est l'hypothèse
  la plus probable (déploiement Vercel de `main` réussi le 26/10 à 18 h), et elle
  est **vérifiable sans base** : ouvrir un dossier DPP en production ; si le
  compteur affiche « sur 13 exigences », le code est celui-là ; s'il affiche
  « sur 9 », le code est plus ancien et le diagnostic doit être repris.
- Que les 56 migrations appliquées soient identiques à celles du dépôt : seuls
  les noms et les dates ont été lus, pas les empreintes (`checksum`).
- Que d'autres bases (préproduction, branches Neon) présentent le même écart.
