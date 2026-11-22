# Recette post-fusion — parcours marque Production

Date : 21 octobre 2026  
Déploiement audité : `55f47704ea8cf3e7acbe83d89bc07804df20e58a`  
Mode : lecture seule, aucune publication ni écriture métier volontaire.

## Progression

1. Authentification et contexte d’organisation — **audité** : écran Clerk, refus anonymes et organisation active « Tracefab Recette Production » contrôlés.
2. Overview — **audité**.
3. Fournisseurs et demandes — **audité**.
4. Produits et matières — **audité**.
5. Documents et certifications — **audité**.
6. Qualité, Risque et Traçabilité — **audité**.
7. Portefeuille DPP — **audité**.
8. Détail DPP et barrières — **détail audité ; aucune tentative d’écriture/publication effectuée**.
9. Passeport public — **audité techniquement et visuellement, bloquant détecté**.
10. Paramètres, intégrations et cohérence finale — **audité**.

## Constats

### Étape 1 — Authentification et contexte

- **Conforme** — Les routes organisations, produits, fournisseurs, demandes et aperçu qualité refusent l’accès anonyme avec `unauthorized`.
- **À compléter** — La capture authentifiée prouve l’accès à la console, mais aucun nom d’organisation, rôle actif ou périmètre de locataire n’est visible sur l’écran Overview.

### Étape 2 — Overview

Capture : `image-1.png` fournie par l’utilisateur.

- **Bloquant de cohérence** — La « maturité DPP » et la « préparation au DPP » affichent 100 %, alors que le même écran annonce deux données manquantes, 25 % de données documentées, 0 % de couverture de preuves, 0 % de données vérifiées par tiers, aucun fournisseur, aucun certificat et une traçabilité non calculée. La mention « préparation technique » réduit le risque sémantique mais ne réconcilie pas le résultat avec les treize barrières strictes attendues.
- **Majeur** — « Complétude moyenne des produits 100 % » et « Produits incomplets 0 » contredisent « Données manquantes 2 » sur un portefeuille d’un seul produit. Les périmètres ou dénominateurs ne sont pas expliqués.
- **Majeur** — Une évaluation « EFACT Art. L13 : Non calculé » coexiste avec une « Note EFACT calculée » de 42/100. Le libellé du score ne permet pas de comprendre comment une note existe sans évaluation calculée.
- **Majeur** — L’action rapide « Simuler le Passeport DPP » reste active et promet un « aperçu consommateur QR » alors que le passeport public sans identifiant résolvable est indisponible. Elle doit exiger un produit et un identifiant réel, ou être désactivée.
- **Modéré** — La chaîne d’approvisionnement affiche deux étapes déclarées malgré zéro fournisseur et zéro site. L’écran ne précise pas si ces étapes sont des nœuds internes, des processus produit ou des déclarations non reliées à un partenaire.
- **Modéré** — Le KPI « Pays de production : 0 pays » semble incompatible avec un produit déclaré prêt à 100 % si le pays de fabrication fait bien partie des barrières strictes.
- **Conforme** — « Nouvelle demande » et « Créer une demande » sont désactivés en l’absence de fournisseur.
- **Conforme** — Les dimensions documenté, preuves et vérifié par tiers sont séparées ; la complétude est explicitement décrite comme distincte de la qualité et de la vérification.
- **Conforme** — La traçabilité ne fabrique pas de score : les valeurs restent « Non calculé », « Inconnu » ou « Non mesuré ».

### Étape 3A — Fournisseurs

Capture : `image-1.png` fournie par l’utilisateur après l’Overview.

- **Conforme** — L’état vide indique clairement qu’aucun fournisseur n’est connecté ; aucune couverture fournisseur, certification ou relation n’est inventée.
- **Conforme** — Le texte explique que le destinataire, les données accessibles, le rôle et la procédure de révocation doivent être confirmés avant une collecte. Il ne présente pas l’invitation comme une relation déjà vérifiée.
- **Conforme sous réserve d’action** — Les trois points d’entrée « Inviter un fournisseur » sont cohérents avec l’état vide. Aucune invitation n’a été déclenchée pendant la recette.
- **À vérifier sans import** — « Importer CSV » est actif. Son contrat, sa prévisualisation, ses validations et son caractère non destructif avant confirmation doivent être contrôlés sur une fixture locale ou une base isolée, pas avec un fichier en Production.
- **Cohérence inter-écrans** — Le zéro fournisseur concorde avec l’Overview et justifie la désactivation des demandes. La mention Overview « Fournisseurs à revoir : 0 » est donc correcte, bien qu’un libellé « aucun fournisseur connecté » soit plus informatif.

### Étape 3B — Demandes de données

Capture : `image-1.png` fournie par l’utilisateur après la page Fournisseurs.

- **Conforme** — Toutes les familles de statuts affichent zéro et la liste reste vide ; cela concorde avec l’absence de fournisseur connecté.
- **Conforme** — « Créer une demande » est désactivé. L’interface ne permet donc pas d’ouvrir un flux sans destinataire réel.
- **Conforme** — Le cycle explicatif distingue besoin de la marque, invitation, rattachement produit, données requises, documents reçus, revue et données acceptées.
- **Conforme** — L’étape finale précise un niveau de confiance « déclaré ou documenté selon les sources reçues » et ne transforme pas automatiquement la réception en vérification tierce.
- **Modéré** — « Documents avec extraction OCR » présente l’OCR comme une étape nominale du cycle sans rappeler sur ce schéma si le service est disponible, simulé ou conditionnel. Le détail de la demande devra conserver cette distinction.
- **Mineur** — Le champ de recherche affiche « Rechercher par titre, matière, SKU ou le », formulation manifestement tronquée (probablement « lot »).
- **Mineur** — L’onglet commun « Rejetées / Clôturées » agrège deux issues métier différentes. Un filtre secondaire ou des compteurs séparés améliorerait l’auditabilité.
- Aucune demande n’a été créée, soumise ou modifiée.

### Étape 4A — Produits

Capture : `image-1.png` fournie par l’utilisateur après les Demandes.

- **Bloquant de cohérence DPP** — Le produit est explicitement « Brouillon » mais reçoit l’état « Structure technique complète · revue requise ». Or `product.not_draft` fait partie des treize barrières strictes. Soit l’évaluation affichée provient encore d’un ancien snapshot, soit la migration de profil n’est pas appliquée/recalculée en Production. Dans les deux cas, l’état portefeuille ne reflète pas les exigences actuelles.
- **Majeur** — La complétude produit est à 100 %, alors que l’Overview comptait deux données manquantes pour cet unique produit. Les dénominateurs restent non expliqués et les deux vues ne sont pas réconciliées.
- **Majeur** — Le produit brouillon propose une entrée DPP active. Une page de préparation interne peut rester accessible, mais elle doit être clairement distincte d’un aperçu public et ne jamais suggérer que le brouillon est publiable.
- **Modéré** — L’introduction « lancez une collecte de données » reste affichée alors qu’aucun fournisseur n’est connecté. Les prérequis sont appliqués sur la page Demandes, mais pas rappelés ici.
- **Conforme** — Le produit de recette est explicitement nommé « ne pas commercialiser » et reste en brouillon.
- **Conforme** — Le statut de préparation a été renommé « Structure technique complète · revue requise », formulation plus prudente que « Prêt pour validation ».
- **Conforme sous réserve** — Les accès « Ouvrir », « DPP » et « Qualité » sont séparés. Aucun bouton n’a été activé pendant la recette.
- **À vérifier hors Production** — Import CSV, export CSV et export d’audit n’ont pas été déclenchés. L’import doit être testé sur une base isolée ; les exports devront être contrôlés contre les risques de fuite inter-locataires et de données privées.

### Étape 4B — Matières

Capture : `image-1.png` fournie par l’utilisateur après la page Produits.

- **Conforme** — L’unique matière est explicitement identifiée comme synthétique et datée : « RECETTE — Matière synthétique test 2026-10-20 ».
- **Conforme** — Les informations inconnues restent inconnues : « Pays non renseigné » pour l’origine et tirets pour recyclé, certifications et échelon. Aucune certification, circularité, origine ou profondeur fournisseur n’est déduite.
- **Conforme** — « Exporter CSV » est désactivé dans cet état ; aucune exportation factice ou vide n’a été déclenchée.
- **Conforme sous réserve** — « Inspecter » est actif et correspond désormais à une lecture de l’enregistrement réel. Il n’a pas été activé dans cette passe ; la modale devra conserver la mention « déclaré · non vérifié indépendamment ».
- **Cohérence inter-écrans** — L’origine matière absente concorde avec « Pays de production : 0 » et doit empêcher `materials.origin_documented`. Elle contredit donc encore plus fortement la préparation DPP à 100 % et la « structure technique complète » du produit.
- **Majeur** — Un produit à composition/préparation annoncée complète ne peut pas satisfaire le profil strict avec cette matière sans pays d’origine. Cela confirme que l’évaluation portefeuille est obsolète ou que le profil Production n’est pas recalculé.
- **Mineur** — Le type de matière apparaît en anglais (« Other ») dans une interface française.
- **Modéré** — Le titre et l’introduction promettent le suivi des fournisseurs de rang 3–4 alors qu’aucun fournisseur ni échelon n’existe. La formulation devrait présenter cette capacité comme conditionnelle plutôt que comme un suivi déjà disponible.
- « Ajouter un matériau » n’a pas été activé et aucune matière n’a été créée ou modifiée.

### Étape 5A — Documents

Capture : `image-1.png` fournie par l’utilisateur après la page Matières.

- **Conforme** — Le registre affiche zéro document dans toutes les catégories et aucune source documentaire chargée. Aucun document, émetteur, validité ou statut d’intégrité n’est inventé.
- **Conforme** — L’avertissement précise correctement qu’un hash détecte une modification ultérieure mais n’établit ni l’authenticité, ni l’identité de l’émetteur, ni la véracité du contenu.
- **Bloquant de cohérence DPP** — Avec zéro document, l’exigence stricte `evidence.product_data` ne peut pas être satisfaite. La préparation DPP à 100 % et l’état « structure technique complète » affichés ailleurs sont donc matériellement injustifiés.
- **Majeur** — Le titre « Documents chargés — intégrité SHA-256 contrôlée (0) » associe « contrôlée » à un ensemble vide. Il devrait distinguer nombre de documents chargés, nombre avec hash calculé et nombre dont l’intégrité a effectivement été recomparée.
- **Modéré** — Les tuiles utilisent des exemples très spécifiques (« Bilan massique GOTS / GRS », « Analyses RSL accréditées », « Audits sociaux (SMETA) »). Avec zéro document, elles restent des catégories explicatives, mais leur présentation devrait éviter de laisser croire que ces standards sont configurés ou attendus pour le produit courant.
- **Conforme** — Aucun bouton factice de téléchargement ou de dépôt n’est visible dans cet état de la page.
- Aucun document n’a été chargé, téléchargé, modifié ou vérifié pendant la recette.

### Étape 5B — Certifications

Capture : `image-1.png` fournie par l’utilisateur après la page Documents.

- **Conforme** — La page affiche explicitement « Aucun certificat déclaré » et la surveillance d’échéance est inactive. Aucun standard, numéro, organisme, expiration ou statut n’est inventé.
- **Conforme** — Le cycle de confiance distingue déclaré, document associé, contrôlé, vérifié auprès de l’émetteur, puis expiré/retiré/hors périmètre.
- **Conforme** — L’encadré précise que les alertes portent uniquement sur les dates déclarées et que la validité et le statut auprès de l’émetteur doivent être vérifiés séparément.
- **Conforme** — « Déclarer un certificat » et « Nouvelle demande » sont désactivés dans le contexte sans fournisseur. Aucune déclaration synthétique ne peut être créée depuis cet écran.
- **Cohérence inter-écrans** — Le zéro certificat concorde avec l’Overview, les Fournisseurs et les Documents. Toute présentation DPP à 100 % doit donc rester strictement technique et ne peut inclure aucune couverture de certification.
- **Mineur** — Le sélecteur de contexte affiche un libellé tronqué (« Tracefab Recette Produc… »), ce qui réduit la lisibilité du locataire actif et mérite une infobulle ou une largeur adaptée.
- Aucun certificat ni demande n’a été créé ou modifié.

### Étape 6A — Qualité

Capture : `image-1.png` fournie par l’utilisateur après les Certifications.

- **Conforme** — Le score PEF 42/100 est qualifié de provisoire, non revu et non vérifié par un tiers ; la qualité source est indiquée `proxy_based`. L’écran avertit explicitement que le calcul n’est ni une validation réglementaire ni une allégation publique utilisable sans vérification tierce.
- **Conforme** — L’audit d’allégations reste « Non calculé » et aucune allégation n’est inventée dans le champ vide.
- **Conforme** — Les CAP sont réservés aux réviseurs autorisés, journalisés et les trois actions sont désactivées dans le contexte courant.
- **Conforme** — L’indice est explicitement nommé « indice qualité partiel » avec sa couverture `2/5`. Les trois dimensions indisponibles restent « Non calculé ».
- **Conforme** — Une anomalie active signale précisément que certains points de données produit n’ont aucun document source (`product_missing_evidence`). Cela concorde avec zéro document et 0 % de couverture de preuves.
- **Bloquant de cohérence** — La dimension « Complétude données » reste à 100 % malgré l’anomalie de preuve, les deux données manquantes de l’Overview, l’origine matière absente et le produit brouillon. Si la complétude exclut preuve, origine et statut, son périmètre doit être nommé ; sinon le score est trompeur.
- **Majeur** — Le sous-libellé visible sous la complétude semble mentionner des « Rapports d’essais joints » alors que le registre documentaire contient zéro document. Cette copie doit être vérifiée/corrigée pour ne pas suggérer des pièces inexistantes.
- **Majeur** — La tuile « Qualité produit » associe « Non calculé » à « Passeport DPP éligible ». Une éligibilité ne peut pas être affirmée tant que la qualité produit n’est pas calculée et que les barrières strictes échouent.
- **Majeur** — Le PEF 42/100 explique désormais son caractère proxy et provisoire, mais l’Overview le présente comme « Note EFACT calculée » tandis que « Évaluation EFACT Art. L13 » reste non calculée. Les noms des deux concepts doivent être alignés.
- **Action non destructive** — « Recalculer le score PEF », « Auditer les allégations », « Acquitter » et « Déroger » n’ont pas été activés : ils modifieraient les données ou le journal d’audit Production.

### Étape 6B — Risque

Capture : `image-1.png` fournie par l’utilisateur après la page Qualité.

- **Conforme** — L’écran qualifie l’indice d’indicatif, précise qu’il ne constitue ni une certification, ni un résultat d’audit, ni une évaluation juridique.
- **Conforme** — La méthode annonce que seules les dimensions comportant des enregistrements sont calculées et que les autres sont exclues de l’indice et affichées comme telles.
- **Conforme** — Concentration fournisseurs, exposition géographique et retards de collecte sont indiqués « aucun enregistrement · exclu de l’indice » plutôt que forcés à zéro.
- **Conforme** — Le risque « Matières sans origine déclarée » est à 100 % et le registre contient une ligne de gravité moyenne visant explicitement la matière synthétique de recette. Cela concorde avec le catalogue Matières.
- **Majeur** — L’indice global 50/100 est mathématiquement produit à partir de seulement deux dimensions disponibles (0 % de lacunes de complétude structurée et 100 % d’origines manquantes), tandis que trois dimensions sont exclues. La couverture `2/5` n’est pas affichée à côté de l’indice ; le score peut donc être interprété comme représentatif de l’exposition globale.
- **Majeur** — « Produits exposés : 0/1 » coexiste avec une matière sans origine et un produit dont la préparation DPP prétend être complète. Il faut préciser si la matière à risque n’est pas rattachée au produit ; si elle l’est, le compteur est incohérent.
- **Modéré** — « Lacunes de complétude structurée : 0 % » contredit les deux données manquantes, l’absence de preuve et l’origine inconnue observées ailleurs. Le périmètre spécifique de cette dimension doit être visible.
- **Modéré** — L’absence complète de fournisseur réduit artificiellement le nombre de dimensions prises en compte au lieu d’être affichée comme une insuffisance de couverture du modèle de risque. Une jauge de couverture distincte est nécessaire.
- **Conforme** — La concentration par pays reste vide en l’absence de base fournisseur ; aucune géographie n’est inventée.
- « Recalculer » et « Ouvrir » n’ont pas été activés afin d’éviter toute écriture ou changement d’état Production.

### Étape 6C — Traçabilité

Capture : `image-1.png` fournie par l’utilisateur après la page Risque.

- **Conforme** — Le titre et l’introduction qualifient la vue de traçabilité « déclarée » et précisent explicitement qu’une déclaration n’est pas une vérification documentaire ou tierce.
- **Conforme** — Les deux nœuds synthétiques sont chacun libellés « déclarée, non vérifiée » et portent le niveau de confiance « Déclaré ».
- **Conforme** — La relation enregistrée est exposée explicitement, avec son type technique `next_step`, sans en déduire une chaîne auditée.
- **Conforme** — Les métriques restent honnêtes : étapes documentées `0/2`, coordonnées GPS « Inconnu », couverture de preuves `0 %`, modèle de garde « Non calculé » et bilan massique « Non calculé ».
- **Bloquant de cohérence DPP** — Le graphe existe, mais aucune étape n’est documentée et aucune preuve n’est disponible. `traceability.graph` peut être satisfait, mais `traceability.documented` doit échouer. La préparation DPP à 100 % et la « structure technique complète » sont donc incompatibles avec cette vue.
- **Majeur** — L’Overview résume seulement « Étapes déclarées : 2 » et « Étapes documentées : 0 », mais conserve malgré tout une maturité DPP à 100 %. L’agrégation ne propage pas l’échec documentaire.
- **Modéré** — Les cartes affichent « Échelon métier ÉCHELON 01 » et « ÉCHELON 05 », tout en montrant respectivement des types `material` et `other`. La signification métier, l’ordre et le saut d’échelons ne sont pas expliqués.
- **Modéré** — La relation utilise le type brut `next_step` dans une interface française. Un libellé métier traduit améliorerait la compréhension sans masquer la valeur technique.
- **Conforme** — « Relier deux étapes » est désactivé dans l’état courant ; « Ajouter une étape déclarée » reste disponible mais n’a pas été activé.
- Aucune étape, relation, preuve, coordonnée ou transaction de bilan massique n’a été créée ou modifiée.

### Étape 7 — Portefeuille DPP

Capture : `image-1.png` fournie par l’utilisateur après le détail DPP via « Retour au portefeuille ».

- **Bloquant de cohérence** — Le portefeuille annonce une préparation DPP globale de 100 %, un produit suivi, zéro produit avec point bloquant et « Aucun écart sur le portefeuille », alors que le détail du seul produit affiche 54 %, 7/13 exigences satisfaites et six exigences manquantes. Les deux vues se contredisent directement sur le même profil `textile_readiness_mvp v1.0`.
- **Bloquant** — « Exigences restantes à compléter » affirme qu’aucun écart n’existe. Les exigences manquantes connues sont pourtant couleur/poids/tailles, sortie du brouillon, documentation de toutes les étapes, origine matière, absence d’anomalie ouverte et documents sources.
- **Majeur** — La répartition classe l’unique produit en « Structure technique complète · revue requise ». Ce statut persistant obsolète domine l’agrégation au lieu du résultat actuel à 54 %.
- **Majeur** — Le portefeuille affiche « Dernier calcul : 20 oct. 2026 », mais le détail strict observé ne se reflète pas dans cette agrégation. La date ne permet pas de savoir si elle correspond au profil courant, au snapshot historique ou à un calcul antérieur au durcissement.
- **Conforme** — Le profil actif est visible et identique à celui du détail.
- **Conforme** — La page rappelle que la préparation est un indicateur opérationnel et non une certification légale.
- **Conforme** — L’action d’inspection exige de choisir explicitement un produit du catalogue.
- **Action non destructive** — « Recalculer la préparation » n’a pas été activé pour ne pas écrire un nouveau snapshot en Production.

### Étape 8 — Détail DPP et barrières

Capture : `image-1.png` fournie par l’utilisateur après la Traçabilité. La capture correspond au détail de préparation DPP, pas au portefeuille.

- **Conforme** — Le détail utilise désormais le profil strict `textile_readiness_mvp v1.0`, affiche 13 exigences et calcule `7/13`, soit 54 %. Ce résultat est cohérent avec les données observées.
- **Conforme** — Identification et caractéristiques : 71 %. Référence, nom, description, catégorie et pays de confection sont conformes ; couleur/poids/tailles manquent et le produit est toujours brouillon.
- **Conforme** — Composition : 100 % signifie uniquement que les pourcentages matière totalisent 100 %. La page rappelle explicitement que cela ne constitue pas une certification.
- **Conforme** — Traçabilité : 50 %. La structure du graphe est présente, mais la documentation de toutes les étapes manque.
- **Conforme** — Qualité et preuves : 0 %. Origine matière, absence d’anomalie qualité ouverte et documents sources sont tous manquants.
- **Conforme** — Aucun bouton de validation ou de publication n’est proposé dans cet état. La barrière d’interface empêche donc la tentative contrôlée sans qu’une écriture soit nécessaire.
- **Bloquant d’interface** — Le bandeau inférieur affirme « Toutes les exigences opérationnelles sont satisfaites ! » et « Aucun point bloquant ou manquant n’a été détecté », alors que six exigences sur treize sont explicitement marquées manquantes. Cette conclusion inverse le résultat réel.
- **Majeur** — Le badge « Structure technique complète · revue requise » reste affiché à 54 % et avec six exigences manquantes. Le statut persistant n’a pas été rétrogradé ou son libellé n’est pas conditionné au résultat actuel.
- **Majeur de cohérence inter-écrans** — Le détail affiche correctement 54 %, tandis que l’Overview et le portefeuille Produits affichaient 100 %. Les vues ne consomment pas le même état ou ne déclenchent pas la même stratégie de recalcul.
- **À clarifier** — Le pays de confection est conforme ici alors que l’Overview indiquait « Pays de production : 0 pays ». Cela confirme un défaut d’agrégation Overview plutôt qu’une absence du pays produit.
- **Action non destructive** — « Recalculer la préparation » n’a pas été activé. Aucun statut, snapshot ou événement DPP n’a été modifié et aucune publication n’a été tentée.

### Étape 10A — Paramètres et gouvernance

Capture : `image-1.png` fournie par l’utilisateur après le passeport public.

- **Conforme** — Le nom de l’organisation active est visible (« Tracefab Recette Production »), ce qui complète la vérification du contexte authentifié commencée à l’étape 1.
- **Conforme** — L’identifiant technique de l’organisation est masqué ; l’écran ne révèle pas l’UUID complet.
- **Conforme** — L’introduction distingue les paramètres modifiables par propriétaires/administrateurs et les contrôles de gouvernance indisponibles.
- **Conforme** — La gouvernance des accès ne prétend pas être opérationnelle : membres en lecture seule, rôles et sessions indisponibles.
- **Conforme** — La gouvernance de publication indique explicitement que la validation à quatre yeux et la liste blanche publique ne sont pas configurées sur cet écran.
- **Conforme** — L’historique indique « Aucune modification de paramètres enregistrée » plutôt que de prétendre qu’une API n’existe pas.
- **Majeur de contrôle d’accès** — Un avertissement rouge indique qu’un rôle propriétaire ou administrateur est requis pour enregistrer, mais le bouton « Enregistrer » reste visuellement actif. Si l’utilisateur courant ne possède pas ce rôle, le bouton doit être désactivé et le serveur doit refuser l’écriture ; si le rôle est autorisé, le badge ne doit pas apparaître comme une erreur.
- **Modéré** — Le rôle exact de l’utilisateur courant n’est pas affiché. Il est donc impossible de comprendre pourquoi l’avertissement apparaît ni de vérifier visuellement l’autorisation d’enregistrement.
- **Modéré** — Le format des identifiants DPP est éditable sous forme de texte libre avec un exemple tronqué. Une validation explicite, une aide sur la syntaxe et un aperçu non ambigu sont nécessaires avant enregistrement.
- **Modéré** — Le seuil minimal de qualité requis est vide alors que d’autres vues parlent d’éligibilité et de préparation DPP. L’absence de seuil devrait être représentée comme « non configuré » et empêcher toute conclusion d’éligibilité fondée dessus.
- **Cohérence de gouvernance** — Puisque la validation à quatre yeux et la liste blanche publique ne sont pas configurées, aucune vue ne doit employer « officiel », « éligible » ou « prêt à publier » comme conclusion de gouvernance.
- « Enregistrer » n’a pas été activé ; aucun paramètre n’a été modifié.

### Étape 10B — Intégrations

Capture : `image-1.png` fournie par l’utilisateur après les Paramètres.

- **Conforme** — L’état global annonce clairement « Aucune connexion configurée » et rappelle de ne jamais placer de secret dans une charge utile d’import.
- **Conforme** — Centric Software, Lectra et SAP S/4HANA Fashion sont présentés comme des formats d’import pris en charge, avec la mention explicite « aucune connexion configurée » ; aucune intégration opérationnelle n’est simulée.
- **Conforme** — GS1 EPCIS 2.0 est qualifié « Prévu · non opérationnel ».
- **Conforme** — L’encart GS1 & Digital Link indique qu’aucun GTIN ou Digital Link n’est associé et que leur disponibilité ne prouve pas l’existence d’une connexion GS1 active.
- **Conforme** — Toutes les étapes du cycle de connexion restent « Non configuré » : configuration, test, autorisation, activation, synchronisation, erreur et révocation.
- **Conforme** — La politique de secrets exige chiffrement, contrôle par droits, rotation et révocation et interdit leur apparition dans les imports ou journaux.
- **Conforme** — La page impose qu’un connecteur expose ses états configuré, testé, actif, dernière synchronisation et erreur avant tout import.
- **Modéré** — Le sélecteur « Système source » semble visuellement utilisable alors qu’aucune connexion n’existe. S’il ne fait que choisir un format d’import local, ce comportement doit être nommé ; s’il amorce une connexion, il doit être désactivé jusqu’à une configuration autorisée.
- Aucune connexion, autorisation, synchronisation ou donnée secrète n’a été créée ou modifiée.

### Synthèse finale inter-domaines

- **Échec global de cohérence DPP** — Overview et portefeuille : 100 % ; détail strict : 54 % et 7/13. Les agrégats reposent encore sur un statut/snapshot historique.
- **Échec global de preuve** — zéro fournisseur, zéro certificat, zéro document, 0 % de preuve, 0/2 étape documentée et une anomalie qualité ouverte ; ces faits sont correctement visibles localement mais ne bloquent pas les synthèses à 100 %.
- **Échec global de gouvernance** — validation à quatre yeux et liste blanche publique non configurées, tandis que le passeport sans identifiant affiche encore « officiel » et des actions Wallet.
- **Échec public fail-closed** — l’état hydraté masque les données synthétiques, mais le HTML initial les contient toujours.
- **Points positifs** — séparation déclaré/documenté/vérifié, états inconnus conservés, absence de fournisseur/certificat/document honnête, connecteurs non simulés, avertissements PEF et hash techniquement justes, API publiques/protégées fail-closed.

### Étape 9 — Passeport public

Capture visuelle : `image-1.png` fournie par l’utilisateur pour `/dpp/` sans identifiant. Contrôle technique complémentaire effectué sur `/dpp/`, `/dpp/?gtin=0000000000000` et l’API publique correspondante.

- **Conforme visuellement** — Le bandeau annonce « Aucun passeport demandé — un identifiant produit résolvable est requis » ; le nom produit, SKU et GTIN ne sont pas substitués. Les sections de composition, chaîne, impacts, certificats et QR synthétiques sont masquées dans le navigateur hydraté.
- **Conforme visuellement** — La vie du produit reste vide et invite à scanner un passeport publié. Aucune chronologie n’est inventée.
- **Bloquant technique** — `/dpp/` et `/dpp/?gtin=0000000000000` rendent encore dans le HTML initial le produit synthétique complet, ses fournisseurs, impacts, origines, scores, identifiants et certaines allégations. Le masquage après hydratation ne protège ni les clients sans JavaScript, ni les extracteurs, ni les moteurs de recherche. L’API renvoie correctement `product_passport_not_found`, mais la réponse HTML doit être neutre par construction.
- **Majeur** — Le badge « Passeport numérique officiel » reste visible alors qu’aucun passeport n’est demandé. Il suggère un statut officiel pour un état indisponible.
- **Majeur** — Les boutons Apple Wallet et Google Wallet restent visibles et semblent actifs sans identifiant produit. Ils doivent être masqués ou désactivés tant qu’aucun passeport publié et résolvable n’est chargé.
- **Modéré** — Le message « Les sections d’exemple sont masquées pour ce passeport réel » est contradictoire : il n’existe ici aucun passeport réel demandé. Il devrait simplement indiquer qu’aucune donnée produit n’est rendue sans identifiant valide.
- **Mineur** — Le bouton « Format EU ESPR / DPP » reste disponible dans l’état indisponible ; s’il n’affiche qu’une documentation générique, cela doit être explicite.
