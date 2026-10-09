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

**TRAITÉ — voir `CHANTIER-1-RLS-PREUVE.md`.** Le rôle `tracefab_app`
(`rolbypassrls=false`, non propriétaire) existe sur Neon. La première requête
jamais évaluée sous ce rôle a révélé que `materials` était **inexécutable** —
récursion infinie entre `materials_select_authorized` et
`product_materials_select_authorized` ; corrigée par la migration
`20261009120000_fix_materials_policy_recursion`. `npm run test:neon:rls`
prouve désormais l'étanchéité par exécution, contrôles négatifs inclus.

**Reste à faire :** `DATABASE_URL` pointe toujours `neondb_owner`. Six routes
publiques lisent des tables de locataire sans contexte — webhook Clerk,
résolveur GS1, DPP public, cartes wallet, passeport fournisseur. La bascule
exige d'abord un contexte public explicite. Mesure et procédure dans le
document dédié.

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
les 34 migrations, crée le rôle et deux locataires, puis exécute l'épreuve —
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
   dur dans cinq fichiers. Corrigé pour la console ; cinq surfaces restent à
   converger.
2. **Allégations de conformité réglementaire en six langues**
   (`ESPR CONFORMITY`, `ESPR / DPP compliant`…), posées sur le 88 % de
   readiness. Consigne explicite enfreinte. Le garde-fou les manquait : il
   était sensible à la casse et ne lisait que les fichiers HTML. Durci —
   **35 fichiers** scannés au lieu de 9.
3. **La 5ᵉ dimension du Quality Center était « ESPR Conformity »** au lieu de
   **Product Quality** exigé par le cahier des charges. Rétablie.

### Ce qui reste

Le **test de régression** reste à 0 script, volontairement : il se mesure
contre une référence validée, qui n'existera qu'après votre arbitrage sur le
dossier de validation. Voir `VALIDATION-PHASES-6-12.md` §5.

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
