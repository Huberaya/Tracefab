# Chantier 19 — Commercial Readiness

**PR #31** · branche `experience/chantier-19-commercial` · commit `3636a08`
**CI verte sur GitHub**, les quatre étages.

C'est le dernier chantier de mon lot (13 → 19).

---

## Le pilote

`scripts/seed_pilot.ts` crée un locataire complet et cohérent : **1 marque,
10 fournisseurs** répartis sur 3 rangs et **10 pays**, **20 produits**, et des
demandes de données couvrant les **six états** du cycle de collecte. Puis il
imprime le rapport qui se pose sur la table.

### Pourquoi amorcer en base

Une démonstration qui tourne sur des données câblées dans le navigateur ne
prouve pas que la plateforme fonctionne. Celle-ci traverse Postgres, RLS, les
calculs de qualité et de maturité. Le prospect voit le produit, pas une
maquette animée.

### Le rapport

| Indicateur | Valeur |
|---|---|
| Périmètre | 10 fournisseurs · 20 produits · 15 sites · 10 pays |
| Qualité des données fournisseurs | 80,3 % |
| Couverture de preuve | 70 % |
| Vérification par tiers | 25 % |
| Traçabilité établie | 75 % |
| Maturité DPP moyenne | 76,1 % |
| À traiter | 7 produits avec lacune · 4 sous 60 % |

**Le pilote n'est volontairement pas tout vert.** Un pilote parfait ne démontre
rien. C'est l'écart qui donne envie du produit, et c'est lui qui amène le
prospect à demander comment on le comble — c'est-à-dire à parler de la suite.

### La validation

`--dry-run` valide le plan sans écrire : références uniques, GTIN à 13
chiffres, six états couverts, aucun fournisseur orphelin, **aucun produit
vérifié sans preuve**. C'est le mode que joue la CI.

Vérifié par morsure sur les deux branches : un produit vérifié sans preuve et
une demande rattachée à un fournisseur inexistant sont tous deux rejetés.

> **Un risque que j'ai trouvé en route.** `scripts/` n'est pas dans le
> périmètre de `tsconfig.json` : les appels Prisma du seeder n'étaient
> type-checkés par rien. Un seeder qui ne colle pas au schéma ne sert à rien —
> il échoue en démonstration, devant le client. Je les type-check désormais
> séparément.

---

## La démonstration scriptée

8 minutes. **Chaque étape a été jouée contre l'application réelle et
chronométrée.** Les libellés cités sont ceux qui s'affichent, pas ceux qu'on
aimerait voir.

| Temps | Étape | Vérifié |
|---|---|---|
| 0:00 | Accueil, la promesse en trois lignes | ✓ |
| 1:00 | Console — *Operational Control Center* | ✓ |
| 2:00 | Descente produit → lignée, 8 étapes | ✓ |
| 3:30 | Quality Center — *Can you trust your data?* | ✓ |
| 4:30 | Portefeuille DPP 88,0 %, 5 écarts cliquables | ✓ |
| 5:30 | Portail fournisseur | ✓ |
| 6:30 | Passeport public, bannière démo absente | ✓ |
| 7:30 | Clôture sur une question | — |

Le document inclut les trois objections récurrentes avec leur réponse, ce qu'il
ne faut **pas** promettre (les intégrations PLM/ERP ne sont déployées chez
personne), et la consigne de dire à voix haute que la maturité DPP n'est pas
une certification — un responsable conformité qui entend cette phrase sans
l'avoir demandée vous fait crédit pour le reste de l'entretien.

Il mentionne aussi **le français codé en dur dans la lignée**. Mieux vaut
l'annoncer que le laisser découvrir : le prospect le verra de toute façon.

---

## Le dossier sécurité

Réponses verifiables au questionnaire acheteur, chacune référencée dans le
code :

- **RLS 45 `ENABLE` / 49 `FORCE`.** `FORCE` est l'argument à souligner : les
  politiques s'appliquent même au propriétaire de la table.
- **125 routes à modèle d'accès déclaré**, vérifié à chaque poussée. Une route
  ajoutée sans déclaration fait échouer la CI.
- URL signées bornées, **antivirus obligatoire avant acceptation** — si
  l'analyseur ne répond pas, le dépôt échoue, il n'est jamais accepté par
  défaut.
- Caviardage des secrets dans toute sortie de journal.
- Coffre secrets d'affaires aligné sur la **directive UE 2016/943**.

### La section qui compte le plus

Celle des manques : limitation de débit **absente**, CSP avec
`'unsafe-inline'`, pagination absente, aucun test d'intrusion, aucune
certification engagée.

Un dossier qui ne mentionne aucune limite n'est pas lu comme rassurant, il est
lu comme incomplet — et la limite se découvre pendant l'audit, au pire moment.

Le document se termine sur **quatre lignes délibérément vides** : adresse de
signalement de vulnérabilité, délai d'accusé de réception, délai de
notification d'incident, liste des sous-traitants. Ce sont les premières
questions d'un DPO. Elles demandent un engagement contractuel que je ne peux
pas inventer à votre place — **à remplir avant la première diffusion client.**

---

## Les garde-fous

4 contrôles ajoutés à `test_production_readiness`, qui portent maintenant
**30/30** :

- le dossier sécurité doit conserver sa section de limites ;
- l'absence de limitation de débit doit y rester écrite ;
- il ne doit revendiquer aucune certification obtenue ;
- la démonstration doit rappeler que la maturité DPP n'est pas une
  certification.

Un dossier sécurité qui perdrait sa section de limites au fil des relectures
deviendrait un engagement qu'on ne tient pas. Mieux vaut qu'une machine le
surveille.

---

## Mon lot est terminé

| Chantier | État | PR |
|---|---|---|
| 13 — DPP actionnable | livré | #27 |
| 14 — Passeport dynamique | livré | #28 |
| 15 — i18n | livré | #26 |
| **16 — Sécurité & Performance** | **non fait** | — |
| 17 — Tests E2E & CI | livré | #29 |
| 18 — Production Readiness | livré | #30 |
| 19 — Commercial Readiness | livré | #31 |

Six PR ouvertes, **à fusionner dans cet ordre** :

```
main 7cfc669
 └── #26  chantier 15 — i18n
      └── #27  chantier 13 — DPP actionnable
           └── #28  chantier 14 — passeport dynamique
                └── #29  chantier 17 — CI
                     └── #30  chantier 18 — production
                          └── #31  chantier 19 — commercial
```

---

## Ce que je recommande maintenant

### 1. Fusionner la pile

Elle est verte de bout en bout, mais six PR empilées se périment. Chaque jour
qui passe augmente le risque de conflit avec les chantiers 01→12 de l'autre
agent.

### 2. Le chantier 16, et dans cet ordre

**La limitation de débit d'abord.** C'est le seul manque de tout le lot qui
soit exploitable par un tiers : `/api/dpp/:gtin` est public par construction,
sans plafond. C'est une facture et une indisponibilité qui attendent leur
déclencheur. Les deux autres points — CSP et pagination — sont des dettes de
qualité, pas des portes ouvertes.

### 3. Vos deux arbitrages, toujours ouverts

- **92,4 % contre 91,4 %** : la même métrique affichée différemment sur
  l'accueil et dans la console.
- **Le français codé en dur** dans la lignée produit, que `test:copy` ne voit
  pas parce que la garde ne descend pas dans les vues de détail.

Les deux figurent dans la checklist de mise en production et dans le script de
démonstration. Ils ne bloquent rien, mais ils se verront.
