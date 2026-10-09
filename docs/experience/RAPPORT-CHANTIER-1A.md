# Chantier 1A — rapport de fin de mission

Branche `correctifs/chantier-1a` · commits `ce94c9e`, `dcb250b`, `1809135`
CI run **#51 : SUCCESS**, quatre jobs. Preuves dans `preuves-1a/`.

---

## 1. L'audit était périmé, et c'est la première chose à dire

L'audit porte sur `b61d771`. Le dépôt était à `b0c976f`, **cinq commits plus
loin**. Son blocage principal — la migration 35 qui échoue sur une base vierge
— était déjà corrigé avant que l'audit ne soit écrit.

Je ne l'ai pas supposé : je l'ai reproduit. Un worktree de `b61d771` sur un
cluster PostgreSQL 17.11 neuf donne bien `P3018` / `42704` /
`role "tracefab_app" does not exist`
(`preuves-1a/A1-echec-commit-audite.txt`). Le même protocole à HEAD applique
les 35 migrations sans erreur (`preuves-1a/A2-succes-head.txt`).

**Les quatre autres défauts, eux, étaient réels.** Un audit périmé n'est pas un
audit faux.

## 2. Le défaut le plus grave n'était pas dans la liste : les passeports mentaient

Les deux routes Wallet **publiques** ne consultaient pas la base. Elles
rendaient `getFallbackDppData()`, un produit entièrement inventé. Comme
l'identifiant scanné ne servait qu'à composer le GTIN affiché, **n'importe quel
code-barres** produisait un laissez-passer crédible portant :

- composition « 100% Coton Biologique Régénératif » ;
- 2,15 kg CO₂e, grade PEF A, circularité 92 ;
- chaîne « Ferme Izmir (TR) → … → Hub Lyon (FR) » ;
- et un **numéro de certificat de transaction GOTS**, `TC-CU-881294-GOTS-2026`.

Livré dans le portefeuille d'un consommateur, sans aucune mention de
démonstration. Un numéro de certificat inventé n'est pas une maquette.

Le résolveur « réel » n'était pas exempt : faute d'analyse PEF il servait
grade B / 3,42 kg CO₂e / 0,85 m³ / circularité 85 ; faute de matière déclarée,
« 100% Coton peigné ». Et les deux générateurs affichaient sur **chaque**
passeport « ESPR CONFORME » puis « certifié conforme au Règlement Écoconception
ESPR 2024/1781 et à la loi AGEC article 13 » — une affirmation de conformité
qu'aucune vérification n'étaye, et que votre propre consigne interdit.

## 3. La cause racine était le type, pas le code

`DppPassData` déclarait `pefScore: number`, `countryOfManufacture: string`,
`certifiedComposition: string` — **obligatoires**. Un type obligatoire ne crée
pas la donnée : il contraint la couche qui le construit à inventer quelque
chose. Les replis n'étaient pas de la négligence, ils étaient la seule façon de
satisfaire le contrat.

Ces champs sont devenus optionnels. `undefined` signifie « non renseigné », et
toute surface omet la rubrique au lieu de la combler. Le compilateur ne suffit
pas ici — `${data.pefGrade}` dans un littéral de gabarit accepte `undefined`
sans broncher — donc chaque site de lecture a été repris à la main.

## 4. Mon correctif serveur a créé un risque côté page, que j'ai dû corriger aussi

La page publique appliquait la règle « une valeur absente laisse la valeur
affichée intacte ». Elle tenait tant que l'API comblait tout. Dès que le
résolveur a cessé d'inventer, cette règle est devenue **le pire cas** :
conserver le chiffre de démonstration sur une page dont la bannière de
démonstration venait de disparaître.

Une rubrique absente affiche désormais `—`. La marque affichée est celle du
produit : « Atelier Demo / Paris, France » n'était pas câblée du tout, un
produit réel se serait affiché sous une marque fictive. Le monogramme suit.

## 5. Le provisionnement des comptes était cassé sous le rôle de production

`requireClerkUser` exécutait son `prisma.user.upsert` **avant** tout armement de
contexte. `users` porte `FORCE ROW LEVEL SECURITY` et exige
`tracefab.worker_context = 'true'` en insertion. Sous `tracefab_app`, première
connexion **et** reconnexion échouaient.

Prouvé en SQL direct : `INSERT` → `new row violates row-level security policy
for table "users"` ; le même `INSERT` passe dans une transaction qui arme le
contexte. Le défaut est invisible aujourd'hui uniquement parce que
`DATABASE_URL` pointe encore sur `neondb_owner`. **Le jour du basculement, plus
personne ne se connecte.**

L'upsert est enveloppé dans `withTracefabWorkerContext`, avec le commentaire
expliquant pourquoi le contexte utilisateur est inutilisable ici : il lui
faudrait l'utilisateur que cette requête est précisément en train d'établir.

## 6. Un en-tête suffisait à multiplier son budget par 300

`classify()` interrogeait les justificatifs **avant** le chemin, et
`carriesCredentials` se contentait d'un en-tête non vide. `Authorization:
Bearer x` faisait donc passer une écriture anonyme de 10 par 5 minutes à 600
par minute, et un laissez-passer Wallet de 20 à 600.

Le code assumait ce choix : « la route rejettera de toute façon ». Mais le
budget est consommé **avant** la route, et pour une route authentifiée ce rejet
coûte un appel réseau à Clerk. Le limiteur protégeait tout sauf ce qui coûte
cher.

La nature de la route prime désormais sur ce que le client déclare, et un jeton
doit être structurellement plausible — trois segments base64url, `sub` présent,
expiration non dépassée. Gratuit, et suffisant pour qu'aucun budget ne s'obtienne
par ajout d'un en-tête.

Le repli en panne de compteur, auparavant permissif pour tout le monde, refuse
maintenant pour `wallet` et `public-write`. Ce n'est pas une perte de
disponibilité : le compteur vit dans le même PostgreSQL que les données, donc
ces routes échoueraient de toute façon — on refuse plus tôt, sans avoir payé.

## 7. L'exclusion de `test:regression` masquait une garde qui ne protégeait pas

J'avais exclu ce test de la CI par son nom, en invoquant la dépendance au
rendu. Le test portait pourtant déjà sa propre garde d'environnement.
L'exclusion faisait donc double emploi — tout en retirant son message des
journaux.

Je l'ai levée. **Et la CI a échoué** : 19 surfaces, 2 à 6 % de pixels
différents. La garde n'avait pas joué. Elle comparait la version de Chromium et
trois largeurs d'avance, identiques sur le runner, alors que la rastérisation
différait.

Deux cycles ont été perdus sur des hypothèses. La réponse était dans la
répartition des écarts : **0,33 % sur l'accueil**, composé en très grands
caractères, contre **2 à 6 % sur les consoles**, denses en texte de 11 à 14 px.
Les deux machines résolvent la même police — `Arial → Liberation Sans` des deux
côtés — mais ne l'instruisent pas pareil. Hinting et lissage ne se voient qu'aux
petites tailles, là où la grille de pixels contraint le glyphe.

Le témoin rend désormais les piles déclarées dans `tracefab-core.css`, à 11, 13,
16 et 64 px, et hache la capture. L'empreinte est journalisée à chaque
exécution, y compris quand la garde laisse passer — sans cela, une coïncidence
reste invisible. C'est cette absence de journal qui a coûté les deux cycles.

**Conclusion gênante mais exacte : c'est l'exclusion qui tenait la CI verte, pas
la garde.** Pendant des semaines, la suite annonçait une couverture visuelle
qu'elle n'avait pas.

## 8. Ce que j'ai prouvé, et comment

| Preuve | Nature |
|---|---|
| `preuves-1a/A1-echec-commit-audite.txt` | Échec reproduit sur cluster neuf au commit audité |
| `preuves-1a/A2-succes-head.txt` | 35 migrations appliquées à HEAD |
| `preuves-1a/C1-wallet-public-refuse.txt` | Routes Wallet publiques : 404 contre PostgreSQL réel, sous `tracefab_app` |

Quatre gardes exécutables ajoutées, **toutes vérifiées par mutation** — un test
qui ne casse pas quand on casse le code ne prouve rien :

| Garde | Portée | Mutations détectées |
|---|---|---|
| `test:neon:rls:auth` | Provisionnement + isolation, sous le rôle applicatif réel | étage base de la CI |
| `test:rate-limit` | Classement, budgets, panne de compteur | 5 / 5 |
| `test:dpp-sans-invention` | Aucune valeur métier inventée ne sort | 5 / 5 |
| `test:dpp-public` | Aucune valeur de démonstration présentée comme réelle | 2 / 2 |

`test:neon:rls:auth` s'exécute sous `tracefab_app` (`rolbypassrls=false`,
`rolsuper=false`) et refuse de se déclarer vert sous un rôle privilégié.

## 9. Mes propres erreurs pendant ce chantier

- J'ai passé `res` là où `evaluate()` attend un horodatage. La fenêtre devenait
  `NaN`, le compteur repartait à 1 à chaque appel, et mon test aurait validé un
  plafond qui ne s'applique jamais. Détecté parce que la section F échouait.
- J'ai comparé un laissez-passer Google en sérialisant le résultat complet —
  qui contient la carte **encodée en base64**. Toute chaîne interdite y serait
  restée invisible. Le test décode maintenant la charge utile.
- Deux cycles de CI dépensés en hypothèses sur l'empreinte, faute d'avoir
  journalisé la valeur calculée dès le départ.

## 10. Ce qui reste ouvert — et ce que je recommande

**Bloqué par absence de secret.** `/tmp/neon.env` est absent de cet
environnement : aucun accès à la base de production. Le basculement de
`DATABASE_URL` de `neondb_owner` vers `tracefab_app` n'a donc pas pu être fait.
**C'est lui qui rend visible le défaut du point 5**, et c'est la seule action
qui transforme toute l'isolation RLS en protection effective plutôt qu'en
dispositif dormant. À faire en premier, et à faire en connaissant le point 5.

**Constaté, non corrigé — hors périmètre d'un chantier de correctifs :**

- `digitalLinkUri` compose un URN SGTIN avec un préfixe GS1 fixe (`3760123`)
  qui n'appartient pas aux marques concernées.
- La page DPP publique n'hydrate que 5 rubriques ; le reste de son contenu
  demeure statique, donc inchangé entre un passeport réel et la démonstration.
- `public_slug` n'est unique que par marque. Quatre marques portent aujourd'hui
  `mb-shirt-001` : une URL publique sans marque reste ambiguë. L'ordre est
  figé pour être déterministe, ce qui rend le comportement stable sans lever
  l'ambiguïté.

**Je m'arrête ici, comme demandé.** Aucun nouveau chantier fonctionnel n'a été
ouvert. La branche `correctifs/chantier-1a` est poussée et verte ; elle n'a pas
été fusionnée dans `main` — cette décision vous revient.
