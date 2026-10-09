# Chantiers restants — état vérifié

Relevé du 9 octobre 2026, établi en interrogeant le dépôt, l'API GitHub et
la base Neon de production. Pas en relisant les en-têtes.

**0 PR ouverte · Neon : 36/36 migrations appliquées, dont la 35
`public_read_context` et la 36 `explicit_publication_state` (§15).**

> **La CI a été rouge sur trois livraisons de suite** (#38, #39, #40) pendant
> que j'annonçais « vert ». Je validais en local et ne regardais pas la CI. Les
> deux causes et leur correction sont au §11. La règle qui manquait : après
> chaque poussée, lire la conclusion des jobs avant d'annoncer quoi que ce soit.
>
> **Run #41 sur `486249f` : `success`**, les quatre jobs verts — `Socle`,
> `Parcours`, `Vérification`, `Base — isolation RLS exécutée`. Conclusion lue
> via l'API GitHub, pas supposée. C'est la première CI verte depuis #37.

> Ce bloc ne porte plus de SHA. Il en portait un, `5b78ac6`, resté figé
> pendant que `main` avançait de sept commits : un en-tête qui se périme à
> chaque commit ne documente rien, il désinforme. Les faits conservés ici
> sont ceux qui ne bougent qu'avec une décision. `npm run test:chantiers`
> les vérifie contre le dépôt.

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

## 1 · La couche RLS est inerte en production — RÉGLÉ

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

**TRAITÉ — voir `CHANTIER-1-RLS-PREUVE.md`.** Le rôle `tracefab_app`
(`rolbypassrls=false`, non propriétaire) existe sur Neon. La première requête
jamais évaluée sous ce rôle a révélé que `materials` était **inexécutable** —
récursion infinie entre `materials_select_authorized` et
`product_materials_select_authorized` ; corrigée par la migration
`20261009120000_fix_materials_policy_recursion`. `npm run test:neon:rls`
prouve désormais l'étanchéité par exécution, contrôles négatifs inclus.

### La bascule — RÉGLÉE

La partie restante n'était pas de la plomberie. Sous `tracefab_app` sans
contexte, neuf tables de locataire rendaient **0 ligne** et six routes
publiques cassaient. Le réflexe aurait été d'ajouter des politiques de lecture
publique ; l'investigation a montré que le vrai manque était ailleurs :
**l'application n'avait jamais défini ce qui est public.**

`/api/dpp/:id` résolvait **n'importe quel** produit par `id`, `reference`,
`sku` ou GTIN — **brouillons compris**, sans la moindre barrière de
publication. `BYPASSRLS` faisait que rien ne s'y opposait. Ce n'est pas un
défaut de RLS, c'est un défaut produit que la RLS a rendu visible.

Trois décisions structurent la migration `20261009180000_public_read_context` :

| Décision | Raison |
|---|---|
| Barrière = `public_slug` explicite | Un produit n'est public que si quelqu'un l'a publié. Le statut `active` ne suffit pas : il décrit un cycle de vie interne, pas une intention de publication. |
| Marque via `tracefab_public_brand(uuid)` | **La RLS filtre des lignes, jamais des colonnes.** Une politique de ligne sur `organizations` aurait publié `legal_name`, `registration_number` et `clerk_organization_id`. La fonction ne projette que `display_name` et `country_code`. |
| Prédicats en `SECURITY DEFINER` | Une politique qui lit la table qu'elle protège récurse — c'est exactement la panne corrigée par la migration 34. |

Les 8 produits actifs ont reçu un `public_slug` dérivé de `reference`, déjà
unique par marque : la contrainte `(brand_organization_id, public_slug)` ne
pouvait donc pas être violée. **Les 9 brouillons restent invisibles.**

Côté application, `withTracefabPublicContext()` pose un drapeau **local à la
transaction** — une connexion poolée ne peut pas le transporter d'une requête
anonyme vers la suivante. Le webhook Clerk passe en contexte worker : il parle
au nom du système, il n'a aucun `user_email` à poser.

### Le garde-fou

`npm run test:neon:rls` gagne une section E de 6 contrôles. **Trois mutations
ont été injectées en production puis annulées, état vérifié après chaque
remise en état :**

| Mutation | Capturée par |
|---|---|
| un brouillon rendu public | « 1 produit lisible publiquement n'est pas actif : draft:1 » |
| `organizations` ouverte en lecture publique | « expose 40 lignes — `legal_name` et `registration_number` fuient » |
| fonction de marque élargie à `legal_name` | « rend les colonnes [country_code, display_name, legal_name] » |

La première mutation a d'abord **échappé** au test, et c'est le résultat le
plus utile de la séance : le contrôle comparait ce que voit l'application à
`public_slug IS NOT NULL`, c'est-à-dire **au prédicat que la politique applique
elle-même**. Tautologie : il ne pouvait détecter qu'une politique cassée, jamais
une publication abusive. D'où le contrôle E2b, qui s'appuie sur une source
indépendante — le statut éditorial.

### Trouvé en chemin, non résolu

`public_slug` n'est unique **que par marque**. Quatre marques portent
aujourd'hui le slug `mb-shirt-001` : une URL publique sans marque est donc
ambiguë, et `findFirst` sans tri rendait une ligne arbitraire. L'ambiguïté
préexistait sur `reference` ; elle est désormais au moins **déterministe**
(`orderBy created_at, id`). La lever vraiment suppose une décision de produit :
slug global, ou URL portant la marque.

Quatre des huit produits publiés n'ont **ni matière ni identifiant** — ce sont
des fixtures de bilan matière. Leur DPP public est donc squelettique. Donnée
préexistante, hors périmètre de cette bascule, mais à voir avant toute
ouverture réelle au public.

**Reste à faire :** `DATABASE_URL` pointe encore `neondb_owner`. Tout est en
place pour basculer la variable d'environnement sur `tracefab_app` ; c'est
désormais un changement de configuration, plus un changement de code.

## 2 · L'étage base de la CI n'a jamais tourné

**RÉGLÉ.** `GET /actions/secrets` renvoyait **0 secret** et **0 variable**.
Le job « Base — isolation RLS executee » était vert en sautant installation,
génération Prisma et scénarios croisés. Preuve conservée — exécution #28,
commit `b40751d` :

```
job « Base — isolation RLS executee » : SUCCESS
   success    Verifier la presence du secret
   skipped    Installer les dependances
   skipped    Generer le client Prisma
   skipped    Scenarios croises executes contre Postgres
```

Déposer le secret de production aurait été le mauvais remède : exposer des
identifiants de production à tout workflow, et faire tourner l'épreuve sur des
données réelles. Le job monte désormais un **Postgres 17 jetable**, applique
les migrations, crée le rôle et deux locataires, puis exécute l'épreuve —
sans aucun secret, y compris depuis un fork. Exécution #30, commit `4c1000f` :

```
   success    Appliquer les migrations sur la base jetable
   success    Creer le role tracefab_app et deux locataires
   success    Isolation RLS prouvee par execution
```

Le job a d'abord échoué sur `Cannot find package 'pg'` : **`pg` n'avait jamais
été déclaré** dans `package.json`. Les scripts qui l'importent ne marchaient
qu'en local, où il avait été posé à la main. Déclaré depuis.

Deux défauts du test lui-même, trouvés en le faisant tourner : il comparait des
cardinalités (deux locataires symétriques voient le même nombre de lignes tout
en étant cloisonnés) et il n'inspectait que les tables déjà marquées RLS, donc
une table dégrèvée sortait de sa surveillance. Les deux corrigés, vérifiés par
mutation.

## 3 · Surfaces injoignables — RÉGLÉ

**Il y en avait quatre, pas trois.** `/invitations/accept/` manquait à
l'inventaire. Mesure avant correction, liens entrants toutes formes
confondues (`href`, chaîne citée dans un bundle, `data-tf-arg`) :

| Surface | Avant | Après |
|---|---:|---:|
| `/product-intelligence/` | **0** | 4 |
| `/passport/` | **0** | 4 |
| `/operations/` | **0** | 0, assumé |
| `/invitations/accept/` | **0** | 0, assumé |

Les quatre ne relevaient pas du même problème, et les traiter pareil aurait
été une erreur.

**`/product-intelligence/`** est exigée par le cahier des charges, complète et
conforme — 11 onglets, barre latérale aux 13 entrées de la spécification. Elle
rejoint la liste « Platform » du pied de page, aux côtés des quatre autres
surfaces produit, et la console l'ouvre depuis la fiche produit
(« Open intelligence record »).

**`/passport/`** est le passeport fournisseur public. Le portail fournisseur
le décrivait sans jamais y mener : il propose maintenant « View my public
passport », et la fiche fournisseur de la console « View public passport ».

**`/operations/`** est une console interne d'exploitation, protégée par Clerk,
dépendante du service operations — elle affiche d'ailleurs « Operator view
unavailable » sans lui. Elle ne s'adresse ni aux marques ni aux fournisseurs.
La placer dans une navigation client aurait été une faute. Elle reste sans
lien, **par décision écrite**.

**`/invitations/accept/`** s'atteint par le lien d'un courriel porteur d'un
jeton. Un lien de menu vers une page d'acceptation sans jeton n'aurait aucun
sens. Sans lien, par décision écrite.

### Le garde-fou

`npm run test:surfaces` — aucune suite ne pouvait voir le problème : elles
vérifiaient ce que contient chaque page, jamais si on peut y arriver. Une page
sans lien entrant passe tous les tests de contenu du monde.

Le test exige de chaque surface soit un lien entrant, soit une déclaration
motivée dans `SANS_LIEN_ASSUME`. Il échoue aussi si une surface déclarée sans
lien en reçoit un, pour que la déclaration ne survive pas à sa raison d'être.
Vérifié par mutation dans les deux sens.

### Trouvé en chemin

La fiche produit de la console affichait **« Intelligence Produit » en
français dans une page anglaise**, codé en dur à côté d'un « Version » tout
aussi figé. Le garde-fou de copie ne l'avait pas vu. Les deux chaînes sont
passées en clés (`console.pxProductIntel`, `console.pxVersion`), traduites
dans les sept locales.

## 4 · i18n résiduelle — le constat était faux, le vrai défaut était ailleurs

**Ce que ce paragraphe affirmait :** « `passport/` porte 6 attributs
`data-i18n`, `operations/` en porte 1. L'essentiel de leur copie reste figé
dans le balisage. »

**Mesure :** 3 attributs dans `passport/index.html`, 0 dans `operations/`. Et
surtout, l'attribut `data-i18n` est la mauvaise métrique pour ces pages : leur
copie est rendue en JavaScript, pas écrite dans le balisage.

| | appels de résolveur | clés déclarées | locales |
|---|---:|---:|---:|
| `passport.1.js` | 53 `pt_()` | 59 | 7 |
| `operations.1.js` | 33 `o()` | 30 | 7 |

Chaînes visibles codées en dur dans les deux paquets : **0** pour le passeport,
et pour operations uniquement des noms propres techniques (`tracefab`,
`Vercel Cron`). Vérifié aussi au navigateur : sur `/passport/`, 46 des 83 nœuds
de texte changent entre EN et FR ; les 37 restants sont des noms de langues,
des noms propres (`Nhãn Textile Portugal`, `GOTS`) et des données de
démonstration — tous légitimement non traduits.

**Résidu réel : une seule chaîne.** `<small>Universal Supplier Passport</small>`
dans l'ossature du passeport, sans `data-i18n`. Corrigée
(`passport.brandLine`), traduite dans les sept locales.

### Le vrai défaut, trouvé en mesurant

Quand l'API ne répond pas, `/passport/` bascule **en silence** sur un
fournisseur fictif et l'affiche comme un fait établi :

- « PROFIL AUDITÉ », « ✓ AI VERIFIED »
- 92 % de complétude, 100 % de preuves documentaires, 3 certifications
- un certificateur nommé : **Control Union Certifications B.V.**, une
  entreprise qui existe réellement

Aucune mention de démonstration, nulle part. Ce n'est pas un défaut
cosmétique : c'est une affirmation fausse au sujet d'un tiers nommé, sur une
page publique, dans un produit dont l'argument central est la preuve. Cela
contredit frontalement la consigne « les chiffres de démonstration doivent
être clairement identifiés comme tels ».

Les autres surfaces le faisaient correctement — `/dpp/` porte une bannière,
la console affiche « Demo mode », `/product-intelligence/` annonce
« DEMONSTRATION RECORD ». Le passeport était le seul à se taire, et rien ne
pouvait le signaler.

**Corrigé :** bannière de démonstration sur le modèle de celle du DPP, visible
par défaut, masquée dès que de vraies données arrivent ; `data-tf-demo` posé
sur la page entière en mode repli ; sept locales.

### Le garde-fou

`npm run test:demo-declaree` — une page servie sans API affiche des données de
repli ; si elles contiennent des chiffres ou des mentions de confiance
(`verified`, `audited`, `certified` et leurs équivalents), la page doit porter
un marqueur de démonstration visible. Une page sans rien d'affirmatif (état
d'erreur, formulaire) n'a rien à déclarer.

État des huit surfaces : six affirment et déclarent, deux n'affirment rien.
Vérifié par mutation — retirer la bannière du passeport fait échouer le test.

### Noté, non traité

`tr` et `zh` n'ont ni `passport.*` ni `ops.*` : décision close (ces deux
locales sont limitées au portail). À rouvrir si des fournisseurs turcs ou
chinois doivent lire leur propre passeport public.

## 5 · Cache des assets — RÉGLÉ

Vercel sert les fichiers statiques avec `public, max-age=0, must-revalidate`
par défaut. Le CDN garde le fichier, mais **le navigateur redemande à chaque
chargement** : « est-ce toujours à jour ? ». Même quand la réponse est un 304
sans corps, l'aller-retour a lieu. Soixante références réparties sur neuf
pages — soit, pour un visiteur qui a déjà tout en cache, soixante allers-retours
inutiles.

On ne pouvait pas simplement passer à `immutable` : les fichiers s'appellent
`brand-console.1.js` et gardent ce nom d'une version à l'autre. Un navigateur
ayant mis cette URL en cache pour un an n'aurait jamais reçu le correctif
suivant.

### Empreinte de contenu

`npm run assets:version` appose l'empreinte sha256 du fichier sur chaque
référence : `/assets/js/brand-console.1.js?v=9f2c41b8`. Le contenu change,
l'URL change, le cache se contourne de lui-même. `immutable` devient honnête.

| Chemin | Cache-Control | Pourquoi |
|---|---|---|
| `/assets/js/(.*)` | `max-age=31536000, immutable` | URL versionnée depuis le HTML |
| `/assets/design-system/(.*)` | `max-age=31536000, immutable` | idem |
| `/assets/i18n/(.*)` | `max-age=300, must-revalidate` | **récupérés à l'exécution** |

La troisième ligne est la plus importante. Les catalogues de langue sont
chargés par `tf-i18n.js` au moment où l'utilisateur change de langue, pas
écrits dans le HTML : aucune empreinte ne peut leur être apposée à la
construction. Les avoir inclus dans la règle `immutable` aurait figé les
traductions pour un an. Vérifié : avec `?lang=fr`, le navigateur demande
`i18n/en.js?v=fc02b6f5` (versionné) puis `i18n/fr.json` (nu).

### Le garde-fou, qui est la vraie livraison

Une empreinte ne vaut que si elle est à jour. Modifier un bundle sans relancer
le générateur laisserait l'ancienne empreinte dans le HTML : les visiteurs
continueraient à exécuter l'ancien code **pendant un an**. Un correctif de
sécurité déployé et jamais reçu.

`npm run test:assets` recalcule l'empreinte de chaque fichier et la compare à
celle écrite dans le HTML. Il est branché dans `npm run build` : une empreinte
périmée **bloque la construction**. Il refuse aussi qu'une ressource servie en
immuable soit liée sans empreinte, et que `/assets/i18n/` soit déclaré
immuable.

Vérifié par mutation dans les deux sens : ajouter un octet à `tf-landing.js`
sans régénérer fait échouer le test et bloque `npm run build` ; déclarer
`/assets/i18n/` immuable le fait échouer aussi.

### Effets de bord traités

`scripts/lib/page_source.mjs` résolvait le `src` littéral dans le manifeste.
Sans adaptation, les 57 tests auraient cessé d'inspecter le JavaScript des
pages **en restant verts** — bien pire qu'un échec. La requête est désormais
retirée avant la recherche dans le manifeste, et la réinsertion vérifiée par
sonde sur trois pages.

`test_landing_performance` cherchait `<script src="/assets/js/tf-landing.js"
defer>` au caractère près. Motif élargi à l'empreinte optionnelle, sans
affaiblir l'assertion : retirer le `defer` le fait toujours rougir.

Chargement réel des neuf pages après bascule : 60/60 requêtes `/assets/`
versionnées, 0 réponse ≥ 400, 0 erreur JavaScript.

## 6 · Engagements contractuels — TRANCHÉS

Les quatre lignes laissées à blanc dans `docs/commercial/dossier-securite.md`
sont renseignées. Trois relevaient d'une décision commerciale, prise par le
porteur du produit ; la quatrième était vérifiable dans le code.

| Ligne | Engagement retenu |
|---|---|
| Signalement de vulnérabilité | `security@tracefab.com` |
| Accusé de réception | 1 jour ouvré |
| Notification d'incident au client | 24 heures après prise de connaissance |
| Sous-traitants ultérieurs | liste complète, établie par audit |

Sur les 24 heures : l'article 33(2) du RGPD impose au sous-traitant d'informer
le responsable de traitement « dans les meilleurs délais », **sans fixer
d'heure**. 24 heures est la pratique contractuelle courante ; elle laisse au
client le temps de tenir ses propres 72 heures vis-à-vis de son autorité de
contrôle.

### La liste des sous-traitants était incomplète

Elle avait été écrite de mémoire : « Clerk, Neon, Vercel, Resend, et
l'analyseur antivirus retenu ». L'audit du code en révèle quatre de plus.

| Manquant | Appelé par | Reçoit |
|---|---|---|
| **Google Fonts** | le navigateur du visiteur | son adresse IP |
| **jsDelivr** | le navigateur du visiteur | son adresse IP |
| Apple Wallet | le serveur | identifiants produit |
| Google Wallet | le serveur | identifiants produit |

Les deux premiers comptent le plus : ils sont appelés **directement par le
navigateur**, sur toutes les pages pour les polices. C'est un point de friction
RGPD connu. Décision : les publier maintenant, internaliser plus tard —
l'internalisation des polices et du SDK Clerk supprimerait l'exposition à la
racine.

### Le dossier se trompait aussi en sa défaveur

Il déclarait la limitation de débit **absente**, et la présentait comme
l'exposition principale du produit. Elle est en place et appliquée dans le
routeur : réponse `429`, en-têtes `RateLimit-*`, budgets 120 / 20 / 10 / 600.
Un dossier périmé se trompe dans les deux sens, et les deux coûtent cher :
l'un fait promettre ce qui n'existe pas, l'autre fait perdre une vente pour un
défaut déjà réparé.

Deux autres lignes précisées plutôt que corrigées : `script-src` ne contient
**pas** `'unsafe-inline'` (seul `style-src` le garde), et l'absence de
pagination est bornée par un plafond de 5 000 lignes par requête.

### Le garde-fou

`npm run test:dossier` vérifie qu'aucun engagement n'est laissé à blanc, que
chaque origine autorisée par la CSP figure dans la liste des sous-traitants,
que chaque service appelé par l'API y figure aussi, et qu'aucun contrôle en
place n'y est déclaré absent. Vérifié par trois mutations : ajouter une origine
CSP non déclarée, remettre un engagement à blanc, redéclarer la limitation de
débit absente.

## 7 · Processus — phases 6 à 12 jamais validées — TRAITÉ

Le cahier des charges impose un arrêt et une validation après chaque phase.
La phase 4 a été validée, la 5 autorisée. Les sept suivantes ont été livrées
d'affilée, sans arrêt.

### Ce que le comptage a montré

Sur les neuf contrôles imposés après chaque phase, **l'accessibilité n'avait
aucun script** : jamais mesurée, sur aucune surface, en douze phases. Et
`audit_phases_9_12.mjs` ne couvrait que les phases 9 à 12 — **les phases 6, 7
et 8 n'avaient aucun audit**.

### Ce qui a été fait

| Livrable | Résultat |
|---|---|
| `scripts/test_accessibilite.mjs` → `test:accessibilite` | **19 surfaces**, vues profondes comprises, WCAG 2.1 AA |
| `scripts/audit_phases_6_8.mjs` → `test:phases:6-8` | **54 contrôles** |
| `docs/experience/VALIDATION-PHASES-6-12.md` | dossier de validation rétrospective, **94/94** |

Première mesure d'accessibilité : **8 surfaces sur 9 en échec, 12 infractions
sérieuses ou critiques**. Premier passage de l'audit 6–8 : **46/54**. Après
correction : **0 infraction** et **54/54**.

### Trois trouvailles de fond

1. **`tracefab-core.css` n'était chargé que par 3 pages sur 9.** La console de
   marque ne chargeait pas le système de jetons — d'où `--muted` dupliqué en
   dur dans cinq fichiers. **Traité intégralement depuis : voir §9.**
2. **Allégations de conformité réglementaire en six langues**
   (`ESPR CONFORMITY`, `ESPR / DPP compliant`…), posées sur le 88 % de
   readiness. Consigne explicite enfreinte. Le garde-fou les manquait : il
   était sensible à la casse et ne lisait que les fichiers HTML. Durci —
   **35 fichiers** scannés au lieu de 9.
3. **La 5ᵉ dimension du Quality Center était « ESPR Conformity »** au lieu de
   **Product Quality** exigé par le cahier des charges. Rétablie.

### Ce qui reste

Le **test de régression** existe désormais : `npm run test:regression`
(§10).

## 8 · Périmètre — VÉRIFIÉ, ET LE DOCUMENT AVAIT DÉRIVÉ

Cette section n'est pas un chantier : c'est la frontière du document. Les
chantiers **01 à 12** relèvent de l'autre agent ; celui-ci couvre **13 à 20**,
documentés dans `chantier-16-securite-performance.md`, `chantier-17-ci.md`,
`chantier-18-production.md`, `chantier-19-commercial.md` et
`chantier-20-coherence.md` — tous fusionnés (PR #29 à #32).

La frontière tient. En revanche, **les faits que ce document affirmait ne
tenaient plus**. Vérification faite contre le dépôt, l'API GitHub et Neon :

| Affirmation du document | Réalité mesurée |
|---|---|
| `main` = `5b78ac6` | `main` avait avancé de **sept commits** |
| Neon : 33/33 migrations | **34/34** — la 34 était appliquée en production |
| CI run #26 verte | dernière exécution : **#36** |
| 0 PR ouverte | exact |

### Le tableau « ne pas reprendre » surestimait deux soldes

| Ligne du tableau | Ce que la mesure a montré | Traité |
|---|---|---|
| « Plus Jakarta Sans ne survit que dans un artefact de comparaison » | **Faux.** Il survivait dans `tailwind.config.js`, déclaré comme **police par défaut** — une contradiction dormante avec la décision « une seule police d'affichage » | police alignée sur Inter Tight |
| « 27 cibles tactiles sous 40 px → plancher posé » | Le plancher existait, mais **une cible restait** : le lien de pied du DPP public, 14 px de haut | corrigé — **0 sur les 9 pages** |
| Branche `arena/e72cecf4` abandonnée | la décision est close, mais **la branche est toujours sur le dépôt distant** | signalé, suppression à votre main |

### Une découverte : la pile Tailwind est morte

`tailwindcss`, `@tailwindcss/postcss`, `autoprefixer` et `postcss` sont
déclarés, avec `tailwind.config.js` et `postcss.config.js`. Mais :

- **aucune directive `@tailwind` ni `@apply`** dans un seul fichier du dépôt ;
- **aucun script npm** ne les invoque ;
- le CSS livré vient entièrement de `assets/design-system/`.

**TRANCHÉ — supprimée.** Vérifications avant retrait : `content:` pointait
`./src/app/**` et `./src/components/**`, deux dossiers **supprimés** du dépôt ;
aucun fichier de `scripts/`, `api/` ou `assets/` n'importe `postcss` ou
`autoprefixer` ; les quatre paquets étaient déclarés en **`dependencies`**,
donc installés en production.

Le motif décisif n'est pas le poids : `tailwind.config.js` déclarait une
**palette concurrente** du système réel — `forest-500 #2d5a3c` contre
`--tf-forest-500 #1d5339`, `forest-900 #0c1b11` contre `#071410` — en plus de
la police écartée. Une config morte n'est pas du lest, c'est une contradiction
en sommeil qui attend qu'on la rebranche.

Retrait : deux fichiers, quatre dépendances, lockfile régénéré (161 paquets).

Le garde-fou est **général, pas nominatif** : `test:systeme-design` refuse
*toute* chaîne de build déclarée sans être invoquée. Éprouvé dans les deux
sens — il rejette un Tailwind qui revient en douce, et il accepte un Tailwind
assorti d'un script qui l'utilise réellement.

### Le garde-fou

`npm run test:chantiers` vérifie désormais ce document contre le dépôt :

1. le compte de migrations annoncé **égale** celui de `prisma/migrations` ;
2. l'en-tête ne présente **aucun SHA** comme état courant ;
3. « Plus Jakarta » n'apparaît dans **aucun fichier vivant** — la
   documentation garde le droit de raconter la décision, une config de build
   non, car elle l'appliquerait ;
4. toute section qui se déclare **RÉGLÉ / TRAITÉ / TRANCHÉ / VÉRIFIÉ** doit
   nommer une commande `test:*` **qui existe réellement** dans
   `package.json` ;
5. tout dossier `chantier-NN-*.md` cité existe.

Le point 4 a immédiatement épinglé cette section : elle se déclarait vérifiée
sans nommer de garde. Un registre qui s'auto-absout est exactement le défaut
que ce test attrape.

---

## 9 · Le système de design n'atteignait que la moitié du produit — RÉGLÉ

**L'intitulé du chantier sous-estimait le défaut.** « Cinq surfaces sur neuf ne
chargent pas `tracefab-core.css` » décrivait un symptôme. La mesure a montré
trois choses, dont deux n'étaient pas dans l'énoncé :

| Mesure | Résultat |
|---|---|
| Surfaces chargeant `tracefab-core.css` | **4 / 9** |
| Surfaces chargeant la fonte **Inter Tight** | **4 / 9** — dont `brand-console`, qui chargeait le socle mais déclarait `Inter` et n'embarquait **aucune** fonte |
| Jetons locaux dupliquant un jeton du socle | **30 sur 32**, écart de 1 à 15 points RVB |

Les cinq pages orphelines ne référençaient **aucun** token `--tf-*` ni aucune
classe `.tf-*` : elles étaient autonomes, avec un **vocabulaire parallèle
hérité** (`--green`, `--dark`, `--muted`, `--line`). Ajouter la feuille sans
toucher au vocabulaire n'aurait donc rien propagé — seulement injecté un reset
global et 128 jetons inutilisés. Le vrai défaut était la **duplication**, pas
l'absence de balise.

### Ce qui a été fait

Les jetons locaux pointent désormais sur le socle (`--green:
var(--tf-trust-verified-ink)`). Les exceptions sont **explicites et
commentées** : le socle modélise ses pastels en `rgba` quand ces surfaces
utilisent des aplats, et il n'offre pas de jeton de filet.

Le reset de `tracefab-core.css` (`p{margin:0}`, `body{line-height:1.58}`,
`button{padding:0}`) a été neutralisé là où il déplaçait la mise en page :
`p{margin:1em 0}` reproduit exactement la marge par défaut du navigateur, qui
suit la taille de police, et `.dpp-tab-btn{line-height:normal}` rend aux
onglets du passeport les 9 px qu'ils perdaient.

### La mesure qui a servi d'arbitre

Une sonde injecte `tracefab-core.css` dans la page **déjà corrigée** et compte
les propriétés calculées qui bougent. Tant que le compte n'est pas nul, la page
n'a pas absorbé le socle. Point de départ : **54** propriétés sur 5 pages.
Arrivée : **0**.

### Une correction de contraste révélée par l'alignement

L'alias a fait tomber trois surfaces à **4,50** sur la pastille `#e4f3ec` —
97 éléments en infraction. `--tf-trust-verified-ink` avait été calculé contre
`#f7f8f4` et `#eaf5ef`, **jamais contre ce fond-là**. Corrigé **dans le socle**
(`#0a7d54` → `#097b53`), pas sur les éléments : 4,62 au minimum sur les cinq
fonds réels. C'est le bénéfice attendu d'une source unique — la correction
porte partout d'un coup.

### Le garde-fou

`npm run test:systeme-design` — 4 règles, **4 mutations capturées** : socle
retiré d'une surface, fonte retirée, `Inter` redéclaré en dur, alias retombé en
valeur dupliquée. La liste des exceptions tolérées vit dans le script : toute
nouvelle exception doit y être ajoutée sciemment.

Un faux positif au premier essai : un commentaire HTML citant `<style>` pour
expliquer l'ordre de chargement était pris pour la vraie balise, et le contrôle
accusait une page correcte. **Un contrôle qui échoue peut être un contrôle
faux.**

### Vérifications

9/9 surfaces conformes · accessibilité **19 surfaces, 0 infraction** · **0**
cible tactile sous 40 px · **62** scripts `test:*` verts · build, `tsc`,
`api:typecheck` verts.

## 10 · Le test de régression — RÉGLÉ

Dernier des neuf contrôles exigés après chaque phase, et le seul resté à zéro
script. Il avait été laissé ouvert pour une raison juste : **une régression se
mesure contre une référence validée**, et les phases 6 à 12 n'étaient pas
validées. Elles le sont depuis le chantier 7.

### Ce que ce test attrape et que les autres ne voient pas

Les 62 autres gardes vérifient une règle **connue à l'avance** : des jetons,
du contraste, des routes, des clés i18n. Celui-ci répond à la seule question
qu'aucune règle ne couvre — *« quelque chose a-t-il bougé que personne n'a
voulu ? »* — en comparant le rendu de **19 surfaces × 2 écrans** à une
référence versionnée.

### Le travail n'était pas de comparer, il était de rendre reproductible

Une référence bâtie sur une page instable fige du bruit et sonne dans le vide à
chaque exécution. Avant d'écrire la moindre image, j'ai donc capturé chaque
surface **deux fois de suite** et comparé. Quatre sources de bruit sont
apparues et ont été neutralisées :

| Bruit | Pourquoi c'est fatal | Traitement |
|---|---|---|
| Fontes distantes | selon que le réseau répond, Inter Tight arrive ou non, et toute la métrique du texte change | requêtes `fonts.googleapis`/`gstatic` bloquées — rendu toujours en police de repli |
| Horloge, `Math.random` | une date ou un « il y a 3 min » diffère à chaque passage | `Date` et `Math.random` figés à l'injection |
| Animations | une transition à mi-course rend un pixel différent | `animation`/`transition` coupées avant capture |
| Compteurs animés | `requestAnimationFrame` ignore une horloge figée — **0,003 % d'écart résiduel mesuré sur l'accueil** | `[data-tf-count]` poussés à leur valeur finale |

Mesure de contrôle après traitement : **19 surfaces, écart 0,000 %**. C'est
cette mesure, et non une intuition, qui autorisait à écrire la référence.

### Éprouvé par mutation

| Mutation | Détectée |
|---|---|
| couleur du socle `#097b53` → `#0d8a5e` (écart imperceptible à l'œil) | 0,274 % à 0,690 % sur de nombreuses surfaces |
| `p { margin: 1em 0 }` retiré d'une seule page | 3,578 % bureau · 7,687 % mobile |

Seuil retenu : **0,10 %**. En dessous, c'est de l'anticrénelage ; au-dessus,
c'est un déplacement de bloc, une couleur ou une typographie.

### Une limite à connaître

La référence est **liée à son environnement de rendu**. Les fontes distantes
sont bloquées, mais le repli dépend des polices système : une autre machine
peut produire un écart de masse.

> **Correction.** La version précédente de ce paragraphe affirmait que le test
> « n'est pas branché sur la CI ». C'était **faux**, et je l'avais écrit sans
> ouvrir `ci.yml` : la boucle de la CI lançait *tous* les scripts `test:*` sauf
> `neon`, `staging` et `test:p2`. `test:regression` en faisait donc partie, et
> il a fait rougir la CI. L'exclusion est maintenant **réelle** : elle est
> écrite nommément dans `.github/workflows/ci.yml`, avec son motif.

Deux garde-fous posés depuis :

- la boucle de la CI exclut `test:regression` **par son nom**, à côté de `neon`
  et `staging`, motif documenté sur place ;
- le script enregistre une **empreinte de l'environnement de rendu** à côté de
  la référence (version de Chromium et largeur réellement rendue d'un texte
  témoin en `sans-serif`, `serif` et `monospace`). Sur une machine dont les
  polices système diffèrent, il affiche `TEST NON EXECUTE` et dit explicitement
  qu'aucune vérification n'a eu lieu, au lieu d'accuser le code.

Vérifié par mutation : largeur de repli modifiée dans l'empreinte → le test
refuse de comparer et le dit. Le jour où l'on voudra l'automatiser vraiment, il
faudra figer le rendu dans un conteneur, pas ajuster le seuil.

### Trouvé en chemin — corrigé depuis, voir §12

La vue `products` rendait **1 248 lignes d'un bloc, 86 543 px de haut**, soit
96 écrans, sans pagination ni virtualisation. La capture Chrome échouait
dessus. Plafonner la référence réglait le test mais **pas le défaut**. C'est
l'objet du §12, et le plafond est passé de 6 000 à 12 000 px.

### Le garde-fou

`npm run test:regression` · `-- --maj` réécrit la référence, qui est
versionnée : une évolution de rendu se relit en revue sous forme d'images
modifiées. Le test échoue aussi sur une **référence orpheline**, pour qu'une
surface retirée ne laisse pas croire à une couverture disparue.

## 11 · La CI était rouge depuis trois livraisons — RÉGLÉ

### Ce qui s'est passé

Les livraisons #38, #39 et #40 ont toutes échoué sur GitHub Actions. Je
validais la suite en local, je la déclarais verte, et je poussais sans jamais
ouvrir la CI. L'écart entre « vert chez moi » et « vert sur la CI » est
précisément ce que la CI existe pour révéler.

Sur la livraison #40 : `Socle` ✅ · `Parcours` ✅ · `Vérification` ❌ ·
`Base — isolation RLS exécutée` ❌.

### Cause 1 — la chaîne de migrations ne passait pas sur une base vierge

La migration 35 `20261009180000_public_read_context` se terminait par cinq
`GRANT EXECUTE ON FUNCTION … TO tracefab_app`. **Aucune migration antérieure ne
crée ce rôle** : en CI il est créé par `scripts/seed_rls_fixture.mjs`, qui
tourne *après* `db:deploy`. Sur Neon la migration passait parce que le rôle y
préexistait ; sur une base neuve, toute la chaîne s'arrêtait là.

Reproduit sur une base vierge avant de corriger :

```
Applying migration `20261009180000_public_read_context`
Error: P3018 — Database error code: 42704
role "tracefab_app" does not exist
```

Un rôle est une donnée d'**infrastructure**, pas de schéma. La migration ne
doit donc pas exiger son existence : les cinq `GRANT` sont désormais encadrés
par `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app')`. Là où
le rôle existe, les droits sont posés comme avant ; là où il n'existe pas
encore, `seed_rls_fixture.mjs` les pose ensuite via son
`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public`. Vérifié en rejouant les
**36 migrations depuis une base vide** : chaîne complète appliquée.

### Cause 1 bis — la fixture ne publiait aucun produit

Une fois les migrations passées, l'étage base échouait encore, et pour une
bonne raison : la section E de `test:neon:rls` vérifie la lecture publique, or
la fixture CI ne créait que des brouillons. Le test disait donc vrai en
échouant — *« aucun produit publié : la lecture publique ne peut pas être
prouvée »*.

Corrigé du bon côté : la fixture publie maintenant **un produit et garde un
brouillon par locataire**. La CI prouve désormais pour de bon que le produit
publié est lisible anonymement et que le brouillon reste invisible — ce qui
n'était jusqu'ici vérifié que sur Neon.

### Cause 2 — le test de régression tournait en CI

La boucle de la CI lance tous les scripts `test:*` sauf `neon`, `staging` et
`test:p2`. `test:regression` y entrait donc, avec une référence en pixels
capturée ici : les polices système du runner diffèrent, l'écart est massif,
l'échec est garanti. Voir §10 pour la correction et la documentation du motif.

### Le vrai manquement

Aucune de ces deux causes n'est grave. Ce qui l'est, c'est d'avoir annoncé
« vert » trois fois sans regarder. La règle, maintenant appliquée : **après
chaque poussée, lire la conclusion des jobs avant d'annoncer le résultat.**

### Outil posé au passage

Corriger une migration déjà appliquée désaligne le `checksum` que Prisma
stocke en base. J'ai donc ajouté `scripts/verifier_checksums_migrations.mjs` :
sans argument il compare et signale, avec `--appliquer` il réaligne dans une
transaction puis **relit depuis la base** pour confirmer.

Mesure faite plutôt que supposée : j'avais annoncé que ce désalignement
casserait les déploiements Neon. **C'est faux pour cette version de Prisma.**
Checksum volontairement corrompu, puis :

| commande | résultat observé |
|---|---|
| `prisma migrate deploy` | code 0 — « No pending migrations to apply. » |
| `prisma migrate status` | « Database schema is up to date! » |

Prisma 6 ne revérifie pas le checksum des migrations déjà appliquées. Le
réalignement sur Neon reste de l'hygiène recommandée, **pas une urgence**.

## 12 · Les tables déversaient tout leur contenu — RÉGLÉ

### Le constat, mesuré

En énumérant les 17 vues de la console dans le navigateur plutôt qu'en
lisant le code :

| vue | lignes rendues | hauteur de page |
|---|---|---|
| `products` | 1 248 | **86 543 px** — 96 écrans |
| `risk` | 1 248 | **88 789 px** — 99 écrans |
| `suppliers` | 86 | 6 365 px |
| les 14 autres | ≤ 5 | ≤ 1 700 px |

Je ne connaissais que `products`. **`risk` était pire**, et personne ne l'avait
vu : rien ne surveillait la hauteur des pages. Un budget que l'on ne mesure pas
dérive toujours dans le même sens.

### Ce qui a été fait

Un composant de pagination **partagé** — pas une rustine dans `products`. Trois
vues l'utilisent. 25 lignes par page.

- `state.pages` retient la page **par liste** : inspecter une référence puis
  revenir au tableau ne renvoie pas au début, et `risk` n'hérite pas de la page
  de `products` ;
- la page demandée est **bornée** à l'exécution, pour qu'une liste qui rétrécit
  (filtre, suppression, changement d'organisation) ne laisse pas l'utilisateur
  sur une page devenue vide ;
- fenêtre glissante `1 … 4 5 6 7 … 50`, neuf entrées au plus, pour que la barre
  tienne sur une ligne ;
- en dessous de 560 px, seuls « précédent », la page courante et « suivant »
  restent : le comptage au-dessus donne déjà la position ;
- libellés dans les **9 locales**, sans interpolation, conformément à la règle
  i18n du projet.

| vue | avant | après | facteur |
|---|---|---|---|
| `products` | 86 543 px | **2 235 px** | ÷ 39 |
| `risk` | 88 789 px | **4 481 px** | ÷ 20 |
| `suppliers` | 6 365 px | **2 235 px** | ÷ 3 |

### Un défaut de mon propre outillage, découvert au passage

En réécrivant la référence visuelle, les anciennes images sont apparues en
`1280x900` — exactement la taille du viewport. Cause : `screenshot({ clip })`
**sans** `fullPage: true` intersecte la zone demandée avec le viewport.

Conséquence : **toute surface de plus de 6 000 px n'était comparée que sur ses
900 premiers pixels**, sans que rien ne le signale. La page d'accueil
(6 071 px en bureau, 9 443 px en mobile) en faisait partie — la surface la plus
importante du projet était quasiment hors couverture pendant que j'annonçais
19 surfaces vérifiées.

Corrigé, et le plafond porté à **12 000 px**, aligné sur le budget de hauteur
de `test:pagination` : un seul seuil dans tout le projet. L'accueil est
désormais capturé en entier.

### Le garde-fou

`npm run test:pagination` — 6 sections, exécutées dans un vrai navigateur, sur
des noms de vues **énumérés à l'exécution** et non écrits en dur :

| section | ce qu'elle prouve |
|---|---|
| A | les 17 vues tiennent sous 12 000 px |
| B | les listes longues portent une barre de pagination |
| C | bornes : « précédent » inactif page 1, dernière page = reste exact (23), « suivant » inactif |
| D | pages `99999`, `-7` et `abc` ramenées dans le domaine, jamais de table vide |
| E | état de page indépendant par liste, conservé au retour |
| F | 390 px : 0 cible sous 40 px, 0 débordement |

Vérifié par mutation — trois régressions réintroduites une à une, toutes
attrapées :

| mutation | ce qui a échoué |
|---|---|
| bornage retiré | D — page 99999 → `undefined`, 0 ligne |
| `products` redéversé | A, B, C, D — 1 248 lignes, 86 622 px |
| « suivant » jamais désactivé | C |

`J08` du parcours e2e a été **renforcé**, pas affaibli : il exigeait « plus de
100 lignes », ce qui ne tenait que grâce au défaut. Il vérifie maintenant une
page bornée **et** le total annoncé par le compteur.

### Ce que la pagination ne réglait pas

Parcourir 50 pages pour trouver une référence restait pénible. La recherche et
le filtrage sont traités au **§13**.

## 13 · Le catalogue était lisible mais pas trouvable — RÉGLÉ

### Le besoin

La pagination a ramené le catalogue de 86 543 px à 2 235 px, mais atteindre
une référence précise supposait toujours de parcourir 50 pages. Lisible n'est
pas trouvable.

### Ce qui a été fait

Une barre de recherche et trois facettes, posées sur la classe `.filters` qui
existait déjà dans la vue `Data Requests` — pas une seconde convention
concurrente.

- **recherche texte** sur le nom et la référence, insensible à la casse **et
  aux accents** (`NFD` puis suppression des diacritiques) ;
- **trois facettes** — catégorie, statut, maturité — dont les options sont
  **construites à partir des données**, jamais écrites en dur : une liste figée
  se désynchronise en silence dès qu'une catégorie apparaît ;
- **cumul en ET** : les facettes et le texte se croisent, ils ne s'additionnent
  pas ;
- **état vide dédié** quand rien ne correspond, avec son propre bouton
  d'effacement — pas un tableau vide ;
- comptage `Matching 155 of 1,248`, affiché **seulement** si un filtre est
  actif, sinon il répéterait ce que la pagination annonce déjà ;
- libellés dans les **9 locales**.

### Deux pièges d'implémentation, traités

**Le focus volé.** `render()` remplace tout le DOM. Sans précaution, taper un
caractère vide le champ de son focus et de son curseur : la recherche au fil
de la frappe devient inutilisable dès le deuxième caractère. `render()`
mémorise désormais l'élément actif et sa sélection, puis les restaure. Vérifié
jusqu'au cas de l'édition **en milieu de chaîne**, où un curseur qui saute à la
fin est tout aussi gênant.

Le filtre existant de `Data Requests` masque des lignes dans le DOM sans
re-rendu — il ne rencontrait donc pas ce problème, mais cette approche est
incompatible avec une pagination, qui doit connaître le nombre filtré pour
découper. D'où un filtrage piloté par l'état.

**La page orpheline.** Filtrer depuis la page 3 sans revenir à la page 1
laisse l'utilisateur devant un sous-ensemble arbitraire. Les deux gestionnaires
— texte et facette — remettent la page à zéro.

### Le garde-fou

`npm run test:catalogue` — 8 sections dans un vrai navigateur.

| section | ce qu'elle prouve |
|---|---|
| A | recherche par nom et par référence |
| B | casse et accents indifférents |
| C | facettes issues des données, cumul en ET, et zéro sur un texte absent |
| D | filtrer depuis la page 3 ramène page 1, **par le texte comme par la facette** |
| E | état vide dédié et son bouton d'effacement |
| F | focus et curseur conservés pendant la frappe, y compris en milieu de chaîne |
| G | libellés traduits |
| H | 390 px : aucun champ sous 40 px, aucun débordement |

### Ce que la mutation a révélé sur mon propre test

Première version de la section D : « aller en dernière page, filtrer, vérifier
qu'on est page 1 ». Elle passait — **y compris après avoir supprimé la remise à
zéro**. Le filtre ne laissait qu'une seule page, donc le *bornage* de la
pagination ramenait déjà à la page 1 et masquait la régression.

Refaite sur un filtre qui laisse **7 pages**, où seule la remise à zéro peut
expliquer le retour en page 1. Puis la même omission est apparue sur le second
chemin : la section ne testait que la facette, pas la saisie texte. Les deux
sont désormais couverts séparément.

| mutation | ce qui échoue |
|---|---|
| facette sans remise à zéro | D — reste page 3 |
| recherche sans remise à zéro | D — reste page 3 |
| restauration du focus retirée | F — focus perdu, un seul caractère sur quatre |
| `toLowerCase()` retiré | B — 0 résultat en majuscules |
| filtre de catégorie retiré | C — 1 248 produits « tous conformes » |

Une suite qui ne tombe jamais ne prouve rien. Celle-ci est tombée cinq fois sur
commande — **et la première rédaction avait un trou que seule la mutation a
montré**.

### Reste à faire sur le catalogue

Le tri par colonne est traité au **§16**. Le jeu de démonstration au **§14**.

## 14 · La démonstration se contredisait elle-même — RÉGLÉ

### Le constat

Le tableau de bord annonçait **« 12 produits incomplets »** au-dessus d'un
catalogue qui en montrait **1 246 à 0 % de complétude**. Pour une plateforme
dont l'argument est « pouvez-vous faire confiance à vos données ? », c'est la
première chose qu'un responsable conformité remarque — et il a raison.

Trois causes distinctes, toutes dans le générateur de démonstration.

**1. `dataCompletion` n'était jamais généré.** Les 1 246 produits créés par
`demoEchelle()` ne portaient pas ce champ. `pct(undefined)` vaut 0, d'où une
colonne entière à 0 % et des barres de progression vides.

**2. `dataReadiness` valait `'verified'`, qui n'existe pas.** L'enum qui fait
foi est `product_data_readiness` dans `prisma/schema.prisma` :

```
not_started · in_progress · data_ready · needs_review
```

`'verified'` n'en fait pas partie, donc `STATUS_KEYS` ne le connaissait pas et
le libellé sortait **brut et non traduit** — un « verified » en minuscules au
milieu de « Needs review » et « In progress ». La démonstration fabriquait des
données que le backend ne peut pas produire.

**3. Le registre de risque comparait à `'ready'`,** valeur que rien ne produit
non plus. Chaque produit tombait donc dans la branche « données non
validées » : **les 1 248 produits étaient signalés**. Un registre qui liste
tout ne hiérarchise plus rien.

### Ce qui a été fait

La distribution n'est plus tirée au sort, elle est **construite**. Le registre
retenant au plus un signal par produit, deux nombres suffisent à le
déterminer, et ces deux nombres existaient déjà dans
`assets/js/tf-demo-figures.js` — **déclarés sans aucun consommateur** :

| source unique | valeur | ce qu'elle pilote désormais |
|---|---|---|
| `attention.produitsIncomplets` | 12 | produits sous le seuil de 70 % |
| `signauxOuverts` | 42 | total des signaux du registre |

Soit 12 produits incomplets + 30 complets mais non validés = 42 signaux. Les
défauts sont posés **à pas régulier** dans le catalogue : groupés en tête, ils
tomberaient tous sur la première page et donneraient une impression fausse.

| | avant | après |
|---|---|---|
| complétude affichée | `0 %` sur 1 246 lignes | 22 % … 100 %, 25 valeurs distinctes par page |
| libellés de maturité | `verified` brut, hors enum | traduits, conformes à l'enum |
| registre de risque | 1 248 signaux | **42** |
| pastille « produits incomplets » | `12` écrit en dur | **comptée sur l'état** |

### Deux corrections de fond, au-delà des chiffres

**La source unique n'était pas unique.** Le repli de `TF_DEMO_FIGURES` était
recopié à trois endroits du fichier. Une seule copie désormais,
`chiffresDemo()`. De même, le seuil de 70 % vivait en trois exemplaires —
génération, pastille, registre — qui pouvaient dériver séparément et faire
mentir l'un des trois : c'est maintenant `SEUIL_COMPLETUDE`.

**Un commentaire mentait.** La vue d'ensemble portait *« Tous les chiffres de
cet écran dérivent de l'état, aucun n'est écrit en dur »* juste au-dessus de
quatre pastilles codées `17`, `8`, `5`, `12` en clair dans le balisage. Le
nombre de produits incomplets est désormais réellement compté sur l'état ; les
trois autres viennent de la source unique, faute d'être dérivables de ce jeu
de données. Le commentaire dit maintenant la vérité, y compris sur ce qu'il
reste de non dérivé.

### De l'indicateur à son correctif

Cliquer « 12 produits incomplets » menait au catalogue **entier**. La pastille
ouvre maintenant le catalogue **filtré sur ces douze produits**, avec une puce
qui dit visiblement que la vue est filtrée. Un indicateur qui ne conduit pas à
son correctif oblige l'utilisateur à refaire à la main le tri que la machine a
déjà fait.

### Le garde-fou

`npm run test:donnees-demo` — 6 sections. La section B relit l'enum
**directement dans `prisma/schema.prisma`** : la règle n'est pas recopiée dans
le test, elle est lue à sa source.

| mutation | ce qui échoue |
|---|---|
| `dataCompletion` non généré | A — 23 lignes à 0 % · C · E |
| `dataReadiness = 'verified'` | B — libellé non traduit **et** valeur hors enum |
| risque comparé à `'ready'` | E — 1 248 signaux au lieu de 42 |
| nombre d'incomplets déconnecté de la source | C, D |
| pastille réécrite en dur | **F** |

La dernière mérite un mot. Les cinq premières ont été attrapées du premier
coup ; **la pastille écrite en dur, non** — remplacer le calcul par le littéral
`12` donnait exactement le même affichage, puisque la valeur attendue était 12.
Le test comparait à la constante, pas à la donnée.

D'où la section F : elle **sert une source modifiée** à la volée (7 incomplets,
23 signaux) en interceptant la requête, et vérifie que l'affichage suit. Un
nombre figé ne peut plus passer pour un nombre calculé.

### Reste à faire

Le tri par colonne du catalogue et l'onboarding Marque sont traités au **§16**.
Le slug partagé au **§15**.

## 15 · Publier n'était pas une décision — RÉGLÉ

### Ce qui était vrai

Rien, dans l'API, n'écrivait `public_slug`. La colonne était posée par la
migration 35 et renseignée par `seed_rls_fixture.mjs`, mais aucun code de
production ne la faisait varier. Autrement dit : l'acte de publier n'existait
pas comme opération.

Pire, publication et visibilité étaient découplées de deux façons.

**`status` et `public_slug` étaient indépendants.** Les quatre fonctions
publiques et la vue `products_select_public` ne testaient que
`public_slug IS NOT NULL`. Un brouillon portant un slug était donc
publiquement lisible. Ce n'était pas corrigé, seulement dormant : tant que
personne ne slugged un brouillon, rien ne se voit.

**Le slug n'est unique que par marque.** `tracefab_products` porte
`unique(brand_organization_id, public_slug)`, et `product_identifiers` n'est
unique que par produit — rien n'interdit le même GTIN chez deux marques. Quatre
marques partagent aujourd'hui `mb-shirt-001`. Une URL publique sans marque est
donc intrinsèquement ambiguë, et le résolveur tranchait par
`ORDER BY created_at, id` : déterministe, mais arbitraire. Un consommateur
pouvait recevoir le passeport d'une autre marque que celle qu'il a scannée.

### La décision

**Refuser plutôt que choisir.** Servir le mauvais passeport attribue des données
réelles au mauvais produit ; c'est pire qu'une page d'erreur. L'ambiguïté lève
`DppAmbiguousResolutionError`, et les cinq routes de passeport répondent **409
`identifier_ambiguous`** — pas 404 : l'identifiant existe, il est seulement
ambigu.

### Ce qui a été fait

Migration `20261009200000_explicit_publication_state` :

| Élément | Effet |
|---|---|
| `published_at`, `published_by` | l'acte de publier devient une donnée, datée et attribuable |
| garde `tracefab_products_publication_explicite` | refuse un `public_slug` sans `published_at`, à l'INSERT comme à l'UPDATE |
| reprise des données | les produits slugged existants reçoivent `published_at = '2026-10-09T18:00:00Z'` |
| 4 fonctions publiques + `products_select_public` | exigent désormais **les deux** conditions |

Le prédicat de publication est écrit **une seule fois, en SQL**, dans le
résolveur. Deux portes pour la même question doivent partager un seul lecteur :
si l'application et RLS divergent un jour, ce sera visible.

`published_by` reste `NULL` sur la reprise : l'auteur de la publication passée
n'est pas connu, et l'inventer serait exactement la fabrication que le §13
interdit. La colonne est nullable et le reste.

### Retour arrière

`DROP TRIGGER tracefab_products_publication_explicite ON tracefab_products;`
puis `ALTER TABLE tracefab_products DROP COLUMN published_at, DROP COLUMN published_by;`,
et rétablir les quatre fonctions dans leur version précédente (conservée en
commentaire dans le fichier de migration). Aucune donnée n'est perdue : la
reprise n'a fait qu'ajouter une colonne.

### Ce qui a été exécuté

- **36 migrations depuis une base vide : 0 échec.**
- Le garde dans cinq directions : slug sans date refusé, slug avec date accepté,
  retrait de la date refusé, retrait du slug accepté (dépublier reste possible),
  `published_by` inconnu refusé par la clé étrangère.
- `test:neon:rls` vert : 46 tables sous RLS, 2 produits publiés lisibles.
- `test:dpp:no-fabrication` : **36 contrôles** (32 avant ce chantier), dont le
  garde, la dépublication, et le refus d'un slug partagé par deux marques.
- Le compte de migrations annoncé en tête de ce document est passé à 36/36 —
  `test:chantiers` compare l'annonce au dépôt et a échoué jusqu'à la mise à jour.
- **Run `37993558935` sur `a50df34` : `success`**, les quatre jobs verts. Les
  douze étapes du job base ont tourné, dont « Appliquer les migrations sur la
  base jetable » (la 36ᵉ appliquée en CI) et « Aucune donnée de passeport n'est
  fabriquée » (36 contrôles). Seule « Scénarios croisés contre la base de
  production » reste sautée, faute du secret — comme prévu.

### Un faux rouge, à ne pas relire comme un échec du code

Les deux premiers runs de ce chantier (`37991876345`, `37992708449`) sont
**rouges sans avoir exécuté une seule vérification** : le job base mourait sur
« Initialize containers — Docker pull failed with exit code 1 ». Les pulls
anonymes depuis un runner GitHub partagent une limite de débit Docker Hub par
plage d'adresses, et elle était atteinte par d'autres projets. C'est exactement
le signal faux que le §11 décrit : un rouge qui ne dit rien du code poussé.

L'image du service passe donc au miroir ECR public
(`public.ecr.aws/docker/library/postgres:17`) — même image, registre sans
limite. Correctif identique à `a6f8404` sur `correctifs/chantier-1a`, dont le
run était passé vert.

### Ce qui reste ouvert

Le **409 n'est pas encore atteint en production** : aucun code n'écrit
`public_slug`, donc aucune ambiguïté ne peut s'y produire aujourd'hui. La
protection est posée avant l'ouverture, pas après un incident. L'acte de
publier lui-même — le bouton, la route d'écriture, l'audit — reste à construire.

## 16 · Ce qui restait ouvert après l'audit — RÉGLÉ

Trois points, mesurés un par un plutôt que repris du relevé. L'audit Market
Readiness §3 note les fonctionnalités de A à E ; « B » signifie *partiellement
fonctionnelle*. Huit items portaient cette note — **cinq étaient déjà fermés**
quand on les a mesurés, ce qui est la raison pour laquelle ce chantier commence
par un relevé et non par une liste recopiée.

### Déjà clos, vérifié et non repris

| Item noté B | Ce que la mesure a montré |
|---|---|
| Téléchargement des preuves Marque, « sans isolation tenant » | la route appelle `tracefab_can_access_document()` dans le contexte utilisateur et répond 404 sinon |
| Acquittement & dérogation, « aucun bouton » | présents dans `assets/js/brand-console.1.js` |
| Partage des matières | `api/_routes/supplier/shares.ts` |
| Data points produits et injection des réponses | `api/_lib/data-points.ts`, `product_id` sélectionné et sérialisé |
| Scan antivirus, « pas de service raccordé » | `scanWithAntivirus()` fait un vrai POST avec jeton et **échoue fermé** (non configuré ou réponse invalide), avec une sonde `probeAntivirus()`. Ce qui reste est du provisionnement, pas du code |

### 1 — le tri par colonne du catalogue

Le filtrage et la pagination rendaient le catalogue trouvable, pas parcourable :
savoir quels produits sont incomplets ne dit pas lesquels le sont le plus. Les
cinq colonnes affichées deviennent triables.

La logique vit dans `assets/js/tf-sort.js`, module partagé sans DOM qui
s'accroche à `globalThis` (`== window` dans le navigateur) : la même source sert
la console **et** le test, qui l'exécute au lieu de la relire. Deux règles y sont
explicites : les valeurs vides tombent toujours en dernier quel que soit le sens
(« pas de donnée » n'est pas une valeur haute), et un départage par référence
rend l'ordre déterministe au lieu de le laisser dépendre du cache. Le départage
ne suit pas le sens : c'est un tri stable, et le test le dit.

Les en-têtes sont de vrais `<button>` avec `aria-sort`, pas des `<th>`
cliquables. Le plancher tactile de 40 px s'applique, non exempté. L'anneau de
focus est sur `--ink` : `--green` pointe un jeton sémantique « vérifié » qui n'a
rien à dire sur un état de focus.

### 2 — les preuves inventées du passeport public

La section « Certificates and legal evidence » était entièrement statique :
numéros de certificat, dates de validité, organisme accrédité, verdicts
« Audited » et « Compliant ». L'API ne sert **aucune** certification — aucune
source possible. Quand un vrai passeport était hydraté, le bandeau de démo se
cachait et les champs réels remplaçaient la démo, mais ces preuves inventées
restaient à l'écran, attribuées au produit scanné.

Elles sont retirées à l'hydratation et une mention dit pourquoi. Au passage,
deux défauts de la même famille : « Non renseigné » était un littéral français
codé dans le composant (il vient désormais du catalogue), et `data-dpp-state`,
posé par le JS depuis toujours, n'avait **aucune règle CSS** — l'absence
s'affichait exactement comme une valeur sourcée.

### 3 — l'onboarding Marque

`api/_routes/organizations.ts` accepte GET et POST, et
`tracefab_create_organization()` crée l'organisation **et** son premier
membership owner atomiquement. Le front ne faisait qu'un GET au démarrage : un
utilisateur sans rattachement Marque ouvrait la console sur des tableaux vides,
sans issue. Un backend sans bouton est une fonctionnalité morte.

Une porte dans `render()` propose la création. Trois champs, pas plus — la
raison sociale est la seule donnée que la route exige. Le refus métier reste sur
le formulaire (`role="alert"`, code d'erreur affiché) plutôt que dans
`state.configError`, qui ferait croire à une panne. La sortie d'onboarding n'est
pas devinée : après le POST, `sync()` recharge les memberships et la porte se
referme d'elle-même.

### Ce qui a été exécuté

- `test:catalogue:tri` — **25 contrôles**, exécute `tf-sort.js` dans Node.
  Contre-vérifié : casser « vide en dernier » ⇒ 2 échecs ; retirer le câblage
  ⇒ 1 échec.
- `test:dpp:evidence` — **13 contrôles**, exécute l'hydratation dans jsdom.
  Contre-vérifié : retirer la neutralisation ⇒ 4 échecs. Un auto-contrôle
  vérifie que la mesure de visibilité voit le texte en mode démo, sans quoi les
  contrôles suivants passeraient à vide. Une garde compare `NODE_VERSION` dans
  `ci.yml` à la plage `engines.node` de jsdom : jsdom 30 exige Node ≥ 22 alors
  que la CI est sur Node 20, et le test passait en local en mourant en CI.
- `test:brand-onboarding` — **9 contrôles**, exécute la console dans jsdom avec
  Clerk et l'API stubbés. Contre-vérifié : porte désactivée ⇒ 5 échecs.
- Boucle locale : 48 OK / 30 échecs, **liste d'échecs identique** à la base
  `041598b` mesurée en worktree (+3 = les trois nouveaux tests). Les 30 :
  13 navigateur indisponible, 12 client Prisma non généré (`binaries.prisma.sh`
  injoignable), 3 variables d'environnement absentes, 2 staging absent.
- **Run `38001404152` : `success`**, les quatre jobs verts.
- i18n : 9 clés d'onboarding et 2 clés DPP ajoutées sur 7 locales, parité
  `console` à 881 clés et `dpp` à 125 clés vérifiée.

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
