# Recette du parcours client marque — 21 octobre 2026

## Cadre

- Révision examinée : `b37fedef8bd4858912253ff39e94f60a981afa8d` (`main` au démarrage de la recette).
- Environnement visuel : Production, organisation de recette, lecture seule.
- Interdits : aucune création, modification, invitation, publication, certification, dérogation, allocation ou calcul déclenché.
- Une capture ne prouve ni le contenu de la base ni le comportement d'une action non exécutée.

## Méthode

Chaque écran est contrôlé selon six axes : sincérité métier, cohérence inter-écrans, états vides, prérequis, lisibilité, sécurité/confidentialité. Les constats sont classés : bloquant, majeur, modéré ou mineur.

## Écran 1 — Vue d'ensemble

Source : capture utilisateur de Production, organisation « Tracefab Recette Produ… », interface française.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| OV-01 | Majeur | La maturité DPP et la préparation article affichent toutes deux 100 %, alors que l'indice qualité vaut 50 %, la couverture de preuves 0 %, les données tierces 0 % et un avertissement de preuve est actif. | Une préparation parfaite paraît compatible avec des preuves absentes et une qualité faible. | Rendre la préparation dépendante d'un profil explicite et afficher les dimensions manquantes ; ne jamais présenter 100 % comme un état global lorsque les preuves sont absentes. |
| OV-02 | Majeur | Le panneau d'attention affiche quatre compteurs à 0 alors qu'un avertissement de preuve actif est affiché juste au-dessus. | Contradiction directe entre synthèse qualité et actions prioritaires. | Ajouter une catégorie « preuves manquantes » alimentée par le même agrégat, ou inclure ces avertissements dans « données manquantes ». |
| OV-03 | Modéré | La tuile « Données manquantes » affiche 0 tout en indiquant « origine matière et preuves non chargées ». | Le nombre et son explication se contredisent. | Afficher un nombre de lacunes, ou remplacer le compteur par « Non chargé » lorsque la mesure porte sur des sources absentes. |
| OV-04 | Modéré | « Score PEF calculé D4.2/100 » fusionne la classe et la valeur sans séparateur et sans unité/méthode visible. | Lecture ambiguë : « D4.2 » peut être interprété comme une notation unique. | Afficher « Classe D · score 4,2/100 », avec statut provisoire et accès aux sources/méthode. |
| OV-05 | Modéré | Deux étapes sont déclarées, mais toute la carte Traçabilité reste « Non calculé » sans expliciter la différence entre déclaration et traçabilité corroborée. | L'utilisateur ne comprend pas pourquoi les étapes déclarées ne produisent aucun indicateur. | Ajouter une phrase : « 2 étapes déclarées ; couverture et liaisons non calculées/non documentées ». |
| OV-06 | Mineur | « MISSION CONTROL CENTER · LAYER 01–07 » reste en anglais dans l'interface française. | Rupture linguistique et vocabulaire interne exposé. | Localiser ou supprimer ce surtitre interne. |
| OV-07 | Mineur | Le nom de l'organisation est tronqué dans le sélecteur sans infobulle visible. | Risque de confusion entre organisations aux noms proches. | Élargir le sélecteur ou fournir le nom complet au survol et à l'accessibilité. |
| OV-08 | Mineur | Plusieurs libellés et valeurs sont très petits et peu contrastés. | Lisibilité réduite, notamment sur écrans denses ou pour utilisateurs malvoyants. | Augmenter la taille minimale et vérifier les contrastes WCAG. |

### Cohérence observée

- La complétude est correctement distinguée de la qualité et de la vérification dans le libellé.
- Les valeurs inconnues et non calculées ne sont pas remplacées par zéro.
- Le score PEF n'est pas présenté comme une conformité réglementaire.
- Le bouton « Lancer une collecte » visible en bas paraît désactivé ; son prérequis devra être vérifié sur la suite du parcours.

### Verdict écran

**À corriger — 2 défauts majeurs, 3 modérés, 3 mineurs.** La principale régression d'expérience est l'affichage d'une maturité DPP à 100 % en présence de preuves nulles et d'un avertissement actif.

## Écran 2 — Catalogue Produits

Source : capture utilisateur de Production, catalogue filtré par défaut, un produit de recette visible.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| PR-01 | Majeur | Le produit affiche « Complétude 100 % » et « Prêt pour validation » alors que la vue d'ensemble signale un indice qualité de 50 %, aucune preuve, aucune donnée tierce et un avertissement actif. | « Prêt pour validation » peut être compris comme une validation métier possible malgré des preuves absentes. | Remplacer par « Structure technique complète » ou conditionner « Prêt pour validation » aux exigences de preuve et de qualité du profil applicable. |
| PR-02 | Modéré | La liste n'affiche que la complétude et la préparation ; aucun indicateur de qualité, preuve ou avertissement ne tempère le 100 %. | L'utilisateur doit ouvrir Qualité pour découvrir une situation sensiblement moins favorable. | Ajouter qualité, couverture de preuve et nombre d'avertissements, ou une synthèse de confiance accessible. |
| PR-03 | Modéré | Le filtre s'appelle « Toutes les maturités » alors que la colonne correspondante s'appelle « Préparation ». | Deux termes paraissent désigner le même état sans définition. | Choisir un terme unique ou expliquer la relation entre maturité et préparation. |
| PR-04 | Modéré | « Exporter audit » est disponible sans indication visible du périmètre, de la date de coupe, du statut d'approbation ou du caractère non probant de l'export. | Un téléchargement peut être pris pour un dossier audité ou approuvé. | Renommer « Préparer un dossier d'audit » et afficher aperçu, périmètre, lacunes et approbateur avant génération. |
| PR-05 | Mineur | L'import CSV est proposé sans accès visible à un modèle, à ses colonnes attendues ou à un contrôle préalable. | Risque d'échecs tardifs et de mauvaises données importées. | Ajouter modèle téléchargeable, prévisualisation et rapport de validation avant écriture. |
| PR-06 | Mineur | Les métadonnées secondaires, en-têtes et actions sont très petites. | Lisibilité et accessibilité réduites. | Augmenter taille, contraste et surface des actions secondaires. |

### Points conformes

- Le produit de recette est explicitement marqué « ne pas commercialiser ».
- Son statut « Brouillon » est visible et distinct de la préparation technique.
- La référence et la version sont affichées sans inventer de certification.
- Les accès DPP et Qualité sont séparés.

### Verdict écran

**À corriger — 1 défaut majeur, 3 modérés, 2 mineurs.** La priorité reste la dissociation visible entre structure complète, qualité des données, preuves disponibles et aptitude réelle à une revue.

## Écran 3 — Fiche produit

Source : capture utilisateur de Production, produit synthétique de recette, sans action d'écriture.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| PD-01 | Bloquant | La fiche indique « Indice Qualité : Non calculé » alors que la Vue d'ensemble affichait 50 % pour l'unique produit. | Deux écrans donnent des états incompatibles pour le même produit ; toute décision fondée sur l'un des deux devient fragile. | Utiliser la même source/version de calcul et afficher date, périmètre et statut de calcul sur les deux écrans. |
| PD-02 | Majeur | La « Lignée Complète de Transformation » est présentée comme complète alors que seules « Fibre » et « DPP créé » sont renseignées ; filature, tricotage, teinture, confection, produit et fin de vie restent à « — ». | Une chaîne lacunaire paraît complète. | Renommer « Étapes de transformation déclarées » et afficher explicitement `2/8 déclarées`, `0/8 documentées` selon les données réelles. |
| PD-03 | Majeur | Le produit était déclaré complet à 100 %, mais couleur, poids unitaire et tailles valent « Inconnu ». | La complétude affichée ne correspond pas aux champs visibles ou son périmètre est incompréhensible. | Afficher le profil de complétude, ses champs obligatoires et le détail du calcul ; intégrer ces inconnues ou expliquer pourquoi elles sont hors périmètre. |
| PD-04 | Majeur | Le pays de fabrication vaut FR sur la fiche, tandis que la Vue d'ensemble affichait « 0 pays » et « Polygones GPS documentés : Inconnu ». | Incohérence d'agrégation ; un pays déclaré est perdu dans la synthèse. | Agréger séparément pays déclarés et sites/polygones documentés, sans assimiler le code pays à une géolocalisation contrôlée. |
| PD-05 | Majeur | « Demande de preuve » est active alors que la Vue d'ensemble indique zéro fournisseur connecté. | L'action risque d'ouvrir un parcours sans destinataire ni source responsable. | Exiger un fournisseur/site/détenteur sélectionné ; sinon désactiver avec un prérequis explicite. |
| PD-06 | Modéré | « 100 % Réconcilié » qualifie une nomenclature mono-matière totalisant 100 %, sous un titre qui mentionne aussi le bilan massique. | Une somme de composition peut être confondue avec une réconciliation de certificats de transaction. | Afficher « Composition totalisée à 100 % » ; réserver « bilan massique réconcilié » aux allocations TC contrôlées. |
| PD-07 | Modéré | « Préparer le DPP » est disponible malgré plusieurs valeurs inconnues et aucune preuve. | L'utilisateur peut croire que la préparation est une validation ou une publication imminente. | Autoriser l'aperçu, mais annoncer avant calcul les lacunes, le caractère brouillon et les exigences non satisfaites. |
| PD-08 | Modéré | Des identifiants techniques et valeurs anglaises sont exposés (`country_of_manufacture`, `country`, `secondary`). | Rupture linguistique et modèle technique présenté comme vocabulaire métier. | Afficher un libellé métier localisé, conserver l'identifiant technique dans un détail secondaire. |
| PD-09 | Mineur | La hiérarchie est dense et les textes d'aide sont très petits. | Les nuances « déclaré uniquement » et « sans preuve » sont faciles à manquer. | Renforcer taille, contraste et placement des métadonnées de confiance. |

### Points conformes

- Le produit et sa matière sont explicitement identifiés comme synthétiques et réservés à la recette.
- Les valeurs inconnues restent affichées comme inconnues.
- La donnée structurée visible est qualifiée « Déclaré uniquement » et l'interface précise qu'une déclaration n'est ni une preuve ni une vérification tierce.
- La prévisualisation mentionne explicitement un DPP brouillon.

### Verdict écran

**À corriger — 1 bloquant, 4 majeurs, 3 modérés, 1 mineur.** La fiche révèle que les scores à 100 % de la liste et de la Vue d'ensemble ne décrivent pas fidèlement les lacunes visibles du produit.

## Écran 4 — Prévisualisation DPP

Source : capture utilisateur après ouverture du DPP depuis le produit synthétique de recette. Capture mobile/étroite. Aucun élément interactif n'a été déclenché dans le passeport.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| DPP-01 | Bloquant | La prévisualisation du produit « Produit recette DPP — ne pas commercialiser » ouvre un autre produit : « Organic Cotton Essential », marque « Atelier Demo », SKU `AT-ESS-001`. | Rupture d'identité et de contexte : l'utilisateur ne prévisualise pas le produit sélectionné. Un passeport sans relation avec la donnée source peut être présenté ou exporté par erreur. | Résoudre exclusivement le DPP par l'identifiant du produit sélectionné ; refuser l'aperçu si aucun DPP correspondant n'existe. Aucun repli vers une démonstration générique. |
| DPP-02 | Bloquant | Le passeport fictif affiche des certifications et allégations détaillées : « GOTS Certified », « OEKO-TEX Class 1 », « CSR Certified », `GOTS v6.0`, « 100% matières documentées » et « 100% Tracé ». | Des certifications et validations tierces inventées sont visibles, même dans une démonstration. Le bandeau fictif ne rend pas ces preuves réelles et ne satisfait pas l'interdiction d'inventer une certification. | Supprimer toute certification tierce fictive. Utiliser uniquement des exemples abstraits explicitement non attestés, sans logo/statut de certification ni organisme attribué. |
| DPP-03 | Majeur | Le titre « PASSEPORT NUMÉRIQUE OFFICIEL » apparaît dans une démonstration fictive. | Contradiction frontale entre statut fictif et caractère officiel. | Remplacer par « Aperçu fictif — non publiable » et conserver ce statut de manière persistante. |
| DPP-04 | Majeur | Le bloc « Scellé par le registre immuable TRACEFAB » accompagne un hash et une mention horodatée. | Le vocabulaire laisse entendre qu'un hash établit l'authenticité, l'immutabilité ou la véracité des données. | Afficher « Empreinte d'intégrité technique » et préciser qu'elle ne prouve ni authenticité, ni véracité, ni validation tierce. |
| DPP-05 | Majeur | L'aperçu du produit réel, dont les champs et preuves sont lacunaires, ne montre aucune de ces lacunes ; il les remplace par un scénario parfait. | La prévisualisation masque précisément les données inconnues que l'utilisateur doit corriger. | Rendre les valeurs inconnues, données déclarées, preuves absentes et sections non publiables à partir du produit sélectionné. |
| DPP-06 | Modéré | « Fabrication au P… » et la rangée de badges sont tronqués avec défilement horizontal. | Une partie des allégations et statuts est invisible sur mobile. | Utiliser un retour à la ligne ou une liste verticale accessible ; aucun texte métier ne doit dépendre d'un défilement horizontal discret. |
| DPP-07 | Modéré | Les onglets sont très serrés et plusieurs libellés ont une taille minuscule. | Navigation difficile et faible accessibilité mobile. | Revoir les cibles tactiles, la taille minimale et le contraste. |
| DPP-08 | Modéré | Les actions Apple Wallet et Google Wallet sont présentées dans un passeport fictif sans état explicite « simulation ». | L'utilisateur peut croire à une capacité de distribution opérationnelle de ce passeport. | Désactiver les actions dans la démonstration ou les marquer explicitement comme simulation sans émission. |

### Point protecteur insuffisant

Le bandeau « Passeport de démonstration — données d'exemple, produit fictif » est visible. Il évite de faire passer le produit pour réel, mais ne corrige ni le mauvais rattachement au produit demandé ni l'invention de certifications tierces.

### Verdict écran

**Blocage de publication — 2 défauts bloquants, 3 majeurs et 3 modérés.** Aucun parcours DPP ne doit pouvoir substituer ce passeport générique au produit sélectionné ni afficher des certifications tierces fictives.

## Écran 5 — Qualité & Conformité

Source : capture utilisateur de Production, produit synthétique de recette, lecture seule. Les actions recalculer, auditer, acquitter et déroger n'ont pas été déclenchées.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| QC-01 | Majeur | L'indice qualité de 50 % semble être la moyenne de seulement deux dimensions calculées — complétude 100 % et preuves 0 % — alors que vérification, qualité fournisseur et qualité produit restent « Non calculé ». | Un score précis paraît global alors que quatre dimensions sur six sont inconnues. | Afficher « Indice partiel : 50 % · 2/6 dimensions calculées », publier la formule et ne pas qualifier ce résultat d'indice global. |
| QC-02 | Majeur | La complétude reste à 100 % malgré couleur, poids et tailles inconnus sur la fiche. | La même incohérence de périmètre se propage dans le Centre qualité. | Montrer le profil de complétude et les champs obligatoires ; recalculer ou expliquer les exclusions. |
| QC-03 | Modéré | « Recalculer l'intégrité du produit » ne décrit ni les données relues, ni les effets persistants, ni la date de coupe avant déclenchement. | Une action d'écriture ressemble à une simple actualisation visuelle. | Ajouter une confirmation indiquant entrées, effets, horodatage et absence de validation tierce. |
| QC-04 | Modéré | « Recalculer le score PEF » est actif sans aperçu des données sources qui seront utilisées, alors que leur qualité est `proxy_based`. | Le recalcul peut être interprété comme une amélioration ou une validation du résultat. | Présenter les sources, proxys et impacts attendus avant confirmation ; conserver le statut provisoire. |
| QC-05 | Modéré | Le bloc CAP affiche des détails techniques internes (« contrôles tenant », « fonctions SQL Neon dédiées »). | Le vocabulaire d'implémentation détourne de la règle métier et expose inutilement l'architecture. | Remplacer par les rôles autorisés, prérequis métier et règle de journalisation, sans nommer le fournisseur technique. |
| QC-06 | Modéré | Les boutons CAP sont désactivés, mais la raison immédiate n'est pas visible à proximité des boutons. | L'utilisateur ne sait pas s'il manque une sélection, une permission ou un état du dossier. | Afficher un motif précis dans le composant désactivé. |
| QC-07 | Mineur | Le surtitre « LAYER 04 » reste en anglais et relève du vocabulaire interne. | Rupture linguistique. | Localiser ou supprimer. |
| QC-08 | Mineur | Les métadonnées PEF, badges et détails de l'anomalie sont très petits. | Les informations essentielles de confiance sont difficiles à lire. | Augmenter la taille et le contraste des métadonnées critiques. |

### Cohérences confirmées

- L'indice qualité 50 % correspond à la Vue d'ensemble, contrairement à la fiche produit qui indiquait « Non calculé ».
- Une anomalie active et un avertissement actif sont bien présents ; cela confirme que les quatre compteurs à zéro du panneau d'attention de la Vue d'ensemble sont incohérents.
- L'anomalie porte explicitement sur l'absence de document source.
- Le PEF est présenté comme provisoire, fondé sur des proxys et non vérifié par un tiers.
- L'interface précise qu'un score PEF calculé n'est ni validation réglementaire ni attestation tierce.
- Les CAP restent désactivés dans l'état observé.
- Acquittement et dérogation sont des actions séparées ; elles n'ont pas été exécutées pendant la recette.

### Verdict écran

**À corriger — 2 défauts majeurs, 4 modérés, 2 mineurs.** Le Centre qualité est plus sincère que la Vue d'ensemble et la fiche, mais son indice à 50 % doit être qualifié de partiel tant que quatre dimensions sur six ne sont pas calculées.

## Écran 6 — Risque & Exposition

Source : capture utilisateur de Production, organisation de recette, sans recalcul ni ouverture d'un risque.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| RK-01 | Majeur | Le registre mesure « Matières sans pays d'origine déclaré : 100 % », tandis que la Vue d'ensemble affiche « Données manquantes : 0 » avec la mention « origine matière et preuves non chargées ». | Le risque réel est détecté mais supprimé du compteur d'actions prioritaires. | Alimenter le panneau d'attention depuis le registre et compter cette lacune ; distinguer nombre de matières et part affectée. |
| RK-02 | Majeur | Le registre contient un risque moyen sur la matière utilisée par l'unique produit, mais le KPI « Produits exposés » reste à `0 / 1`. | Une exposition liée à un composant n'est pas propagée au produit qui l'utilise. | Définir et afficher la règle de propagation matière → produit, ou renommer le KPI pour indiquer qu'il ne compte que les signaux directement attachés aux produits. |
| RK-03 | Modéré | L'indice d'exposition 50 est calculé alors que trois dimensions sur cinq sont exclues faute d'enregistrement. | Un indice précis paraît couvrir toute l'exposition alors qu'il repose sur deux dimensions seulement : 0 % et 100 %. | Afficher « Indice partiel : 50/100 · 2/5 dimensions alimentées » sur la carte principale. |
| RK-04 | Modéré | « Lacunes de complétude structurée : 0 % » hérite du score de complétude contesté, malgré plusieurs attributs produit inconnus. | Le registre reproduit une définition trop étroite de la complétude. | Lier cette dimension au profil de complétude explicite et exposer les champs exclus/inconnus. |
| RK-05 | Modéré | Le bouton « Recalculer » ne précise pas le périmètre, la date de coupe ni les effets persistants. | Une opération de calcul et d'écriture paraît être un simple rafraîchissement. | Ajouter un dialogue de confirmation et le détail des sources/dimensions recalculées. |
| RK-06 | Mineur | Les mentions expliquant les dimensions exclues sont très petites et éloignées de l'indice principal. | La nature partielle du score est facile à manquer. | Remonter la couverture du calcul dans la carte de score et augmenter la lisibilité. |

### Cohérences confirmées

- Le registre ne présente pas l'indice comme une certification ou une conclusion juridique.
- Les dimensions sans enregistrement sont explicitement exclues au lieu d'être transformées en zéro.
- L'absence de pays d'origine de la matière produit un signal identifiable et un risque de gravité moyenne.
- Le pays de fabrication FR du produit n'est pas confondu avec le pays d'origine inconnu de la matière.
- Aucun fournisseur n'est artificiellement signalé alors qu'aucun fournisseur n'est chargé.

### Verdict écran

**À corriger — 2 défauts majeurs, 3 modérés, 1 mineur.** Le registre détecte correctement la lacune d'origine matière, mais cette information ne remonte ni dans les actions prioritaires ni dans le compteur de produits exposés.

## Écran 7 — Traçabilité

Source : capture utilisateur de Production, produit synthétique de recette, lecture seule. Aucun nœud ni relation n'a été ajouté.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| TR-01 | Majeur | Cet écran montre correctement `0/2` étapes documentées et `0 %` de preuves, alors que la fiche produit qualifiait la même chaîne de « Lignée Complète de Transformation ». | La fiche produit surévalue directement le graphe affiché ici. | Alimenter les deux vues depuis le même résumé et remplacer « complète » par « 2 étapes déclarées · 0 documentée ». |
| TR-02 | Modéré | Les nœuds ne présentent ni déclarant, ni date de déclaration, ni source, ni date d'observation. | Impossible d'évaluer fraîcheur, responsabilité et provenance de chaque étape. | Ajouter ces métadonnées et conserver explicitement le niveau de confiance « déclaré ». |
| TR-03 | Modéré | La relation expose la valeur technique `(next_step)` dans l'interface française. | Fuite du modèle interne et rupture linguistique. | Afficher un libellé métier localisé, avec la valeur technique seulement dans un détail développeur. |
| TR-04 | Modéré | Le bouton désactivé « Relier deux étapes » ne donne pas son prérequis à proximité. | L'utilisateur ignore si les étapes sont déjà liées, incompatibles ou insuffisantes. | Afficher le motif exact dans le bouton, une infobulle et le texte accessible. |
| TR-05 | Modéré | « Traçabilité Multi-Rangs » et « Modèle de Garde » sont des formulations peu naturelles ou ambiguës en français. | Compréhension métier réduite. | Employer « Traçabilité multi-niveaux » et « Modèle de chaîne de contrôle ». |
| TR-06 | Mineur | Les libellés des nœuds et leurs métadonnées sont très petits. | Lecture difficile du graphe et des niveaux de confiance. | Augmenter taille, contraste et surface des cartes. |

### Cohérences confirmées

- Les deux étapes déclarées de la Vue d'ensemble sont présentes.
- La page précise qu'une déclaration n'est ni une vérification documentaire ni une validation tierce.
- La relation et les deux nœuds sont qualifiés « déclaré » et « non vérifié ».
- Les coordonnées GPS restent inconnues ; le pays FR de la fiche n'est pas transformé en preuve GPS.
- La couverture de preuves à 0 % correspond au Centre qualité.
- La chaîne de contrôle et le bilan massique restent « Non calculé ».
- Le prérequis du bilan massique mentionne certificats de transaction, quantités et consommations théoriques sans prétendre à une réconciliation existante.

### Verdict écran

**À corriger — 1 défaut majeur, 4 modérés, 1 mineur.** Cette vue est globalement sincère et confirme que l'erreur principale se situe dans la qualification « lignée complète » de la fiche produit.

## Écran 8 — Bilan massique (TC)

Source : capture utilisateur de Production, organisation de recette, sans ouverture du formulaire d'enregistrement et sans allocation.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| MB-01 | Modéré | « Enregistrer un certificat de transaction » reste actif alors qu'aucun fournisseur, document générique ni certificat n'est chargé ; les prérequis du formulaire ne sont pas visibles avant son ouverture. | L'utilisateur peut engager un parcours sans émetteur ou justificatif disponible. | Afficher avant ouverture les prérequis, le rôle requis et le fait qu'il s'agit d'un enregistrement déclaré soumis à contrôle. Désactiver si le workflow exige un émetteur connecté. |
| MB-02 | Modéré | Les champs d'allocation désactivés montrent leur ordre logique, mais aucun message compact n'explique pourquoi chaque champ est bloqué. | L'état désactivé peut être interprété comme une panne. | Afficher « Enregistrez d'abord un TC contrôlé » puis « Sélectionnez un TC source » selon l'étape. |
| MB-03 | Modéré | La phrase « un document dont l'émetteur et l'authenticité ont été contrôlés […] sont requis » décrit correctement un prérequis, mais ne précise pas qui réalise le contrôle ni selon quelle procédure. | Le niveau « contrôlé » peut être pris pour une vérification tierce. | Nommer le responsable et le type de contrôle, et rappeler qu'un contrôle interne ne vaut pas certification tierce. |
| MB-04 | Mineur | Les textes d'aide et états vides sont très petits. | Les garde-fous métier peuvent être manqués. | Augmenter taille et contraste des prérequis. |

### Cohérences confirmées

- La page avertit explicitement qu'un écart est un signal de risque et non une preuve de fraude.
- Elle précise explicitement qu'une BOM à 100 % ne constitue pas un bilan massique réconcilié, ce qui corrige l'ambiguïté de la fiche produit.
- Aucun certificat ni volume n'est inventé.
- L'allocation est désactivée faute de certificat source.
- Le rapprochement produit reste « Non calculé » et ses prérequis sont indiqués.
- Aucun hash n'est assimilé ici à une preuve d'authenticité.

### Verdict écran

**Globalement conforme — 3 défauts modérés et 1 mineur.** Cette page est la plus rigoureuse du parcours observé ; les améliorations portent surtout sur l'explication des prérequis et du niveau de contrôle.

## Écran 9 — Rapports & Audits

Source : capture utilisateur de Production. Aucun aperçu ni export n'a été généré.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| RP-01 | Modéré | Le statut global indique « En attente d'un réviseur autorisé » alors que les générateurs sont non opérationnels et qu'aucun aperçu ne peut encore être produit. | Le workflow paraît arrivé à l'étape de revue alors qu'il est bloqué avant la génération. | Afficher d'abord « Bloqué — générateur indisponible » ; ne passer à l'attente de revue qu'après création effective d'un aperçu. |
| RP-02 | Modéré | Les boutons indiquent « Aperçu requis » mais aucun chemin pour créer cet aperçu n'est disponible. | Le prérequis est explicite, mais le parcours n'offre aucune issue. | Ajouter une action de génération lorsqu'elle existe, ou afficher clairement la dépendance externe et l'état de disponibilité. |
| RP-03 | Mineur | « Couverture actuelle : 1 Produits » comporte une erreur d'accord et de capitalisation. | Dégradation éditoriale. | Afficher « 1 produit ». |
| RP-04 | Mineur | Les explications de provenance et de piste technique sont petites. | Les limites essentielles de l'export peuvent être manquées. | Augmenter taille et contraste des avertissements structurants. |

### Cohérences confirmées

- Tous les exports sont explicitement qualifiés de brouillons.
- La page précise qu'un export n'atteste pas la conformité réglementaire.
- Les exigences de provenance, niveau de confiance, date de calcul, données manquantes et statut brouillon/publication sont annoncées.
- L'export CSRD indique une couverture de 0 % et aucune preuve chargée.
- La fiche AGEC précise qu'elle n'est ni un certificat ni une attestation de conformité.
- Aucun générateur non opérationnel n'est présenté comme disponible.
- L'approbation humaine autorisée et la journalisation sont intégrées au workflow annoncé.
- La piste technique distingue correctement intégrité, authenticité et véracité : le hash peut aider à détecter une modification, mais n'établit ni authenticité ni vérité.
- La page précise qu'une piste technique ne constitue pas un audit réglementaire.

### Verdict écran

**Globalement conforme — 2 défauts modérés et 2 mineurs.** C'est l'écran le plus abouti sur la sincérité des exports et la portée limitée du hash ; il faut surtout corriger l'ordre des états du workflow.

## Écran 10 — Intégrations PLM, ERP & GS1

Source : capture utilisateur de Production, organisation de recette sans connexion configurée. Aucun connecteur n'a été sélectionné ni configuré.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| IN-01 | Majeur | Centric, Lectra et SAP sont qualifiés « Connecteur opérationnel · configuration requise » alors qu'aucune connexion n'est configurée, testée, autorisée ou activée. | La présence d'un parseur/importeur logiciel peut être interprétée comme une intégration opérationnelle de bout en bout. | Afficher « Format d'import pris en charge · aucune connexion configurée ». Réserver « opérationnel » à une connexion testée et active. |
| IN-02 | Modéré | Aucun chemin de configuration ou lien vers une procédure n'est visible. | Le catalogue décrit les prérequis mais ne permet pas de progresser. | Ajouter une action « Configurer » réservée aux rôles autorisés, ou indiquer explicitement que la configuration est administrée hors de cette interface. |
| IN-03 | Modéré | Le sélecteur « Système source » est vide/désactivé sans raison directement attachée au contrôle. | L'utilisateur peut interpréter cet état comme une panne de chargement. | Afficher « Configurez et testez d'abord une connexion » dans le contrôle et son aide accessible. |
| IN-04 | Mineur | Les statuts utilisent une taille très réduite. | La nuance entre format pris en charge, planifié, configuré et actif peut être manquée. | Renforcer taille et contraste des états. |

### Cohérences confirmées

- La page annonce clairement qu'aucune connexion n'est configurée.
- Les sept étapes du cycle restent toutes « Non configuré » : configuration, test, autorisation, activation, synchronisation, erreur et révocation.
- GS1 EPCIS 2.0 est correctement marqué « Prévu · non opérationnel ».
- Aucun GTIN ou Digital Link n'est inventé ; la page précise que la disponibilité ne signifie pas une connexion GS1 active.
- La consigne de ne jamais inclure de secret dans une charge utile d'import est visible.
- Aucune date de synchronisation ni erreur fictive n'est affichée.

### Verdict écran

**À corriger — 1 défaut majeur, 2 modérés et 1 mineur.** Les états de connexion sont sincères, mais le terme « connecteur opérationnel » doit être remplacé par une capacité technique plus précisément bornée.

## Écran 11 — Paramètres et gouvernance

Source : capture utilisateur de Production. Aucun champ n'a été modifié et le bouton Enregistrer n'a pas été utilisé.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| ST-01 | Majeur | Le sous-titre annonce un « contexte d'organisation en lecture seule », mais deux champs éditables et un bouton Enregistrer actif sont affichés. | Contradiction sur la capacité d'écriture et risque de modification involontaire. | Remplacer le sous-titre par le mode réel, ou rendre les champs et le bouton réellement inactifs en lecture seule. |
| ST-02 | Majeur | Le badge indique qu'un rôle propriétaire ou administrateur est requis, mais l'interface ne montre pas le rôle courant ni si l'autorisation a effectivement été accordée ; le bouton paraît actif. | Un utilisateur ne peut pas distinguer une autorisation réelle d'un simple rappel de règle. | Afficher « Votre rôle : … » et désactiver côté interface sans préjuger du contrôle serveur ; conserver impérativement l'autorisation serveur. |
| ST-03 | Modéré | Le format d'identifiant DPP et le seuil qualité paraissent non configurés, sans distinguer valeur enregistrée, valeur par défaut et exemple (`urn:epc:id:sgtin:…`). | Un exemple peut être pris pour une configuration persistée ; une sauvegarde partielle peut être mal comprise. | Étiqueter explicitement « Non configuré » et « Exemple », afficher les valeurs effectives et valider le formulaire avant toute écriture. |
| ST-04 | Modéré | L'état vide de l'historique dit qu'aucune modification « n'est exposée par l'API actuelle ». Or la route actuelle prévoit un historique ; l'absence peut simplement signifier qu'aucune modification n'est enregistrée. | Confusion entre absence de données et incapacité technique. | Afficher « Aucune modification enregistrée » ou une erreur explicite si la lecture a réellement échoué. |
| ST-05 | Modéré | Membres est « lecture seule », tandis que rôles, sessions et gouvernance de publication sont indisponibles, sans lien vers le système qui les administre. | Les responsabilités de gouvernance restent sans parcours opérationnel. | Indiquer où ces contrôles sont administrés et qui peut agir ; ne pas simuler une capacité locale. |
| ST-06 | Mineur | L'identifiant d'organisation est masqué, mais aucun bouton de copie contrôlé ni libellé d'usage n'est proposé. | Support et diagnostic plus difficiles ; risque de recopier une valeur tronquée. | Fournir une copie explicite réservée aux rôles appropriés, ou préciser que l'identifiant tronqué est uniquement informatif. |

### Cohérences confirmées

- Le nom de l'organisation de recette est affiché sans la confondre avec une marque certifiée.
- L'identifiant technique est masqué dans l'interface.
- Les fonctions non disponibles sont présentées comme indisponibles plutôt que simulées.
- La gouvernance de publication est annoncée comme non configurée.
- Aucun historique fictif n'est généré.

### Verdict écran

**À corriger — 2 défauts majeurs, 3 modérés et 1 mineur.** La priorité est d'aligner le mode lecture seule, les autorisations visibles et l'état réel du bouton Enregistrer.

## Écran 12 — Fournisseurs

Source : capture utilisateur de Production, organisation de recette sans fournisseur connecté. Aucune invitation ni import n'a été déclenché.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| SU-01 | Majeur | Le bouton global « Nouvelle demande » reste actif alors que la page confirme qu'aucun fournisseur n'est connecté et qu'une collecte ne peut commencer qu'après invitation. | Le parcours global contredit le prérequis correctement annoncé dans l'état vide. | Désactiver la création de demande ou ouvrir un parcours guidé qui commence par sélectionner/inviter un destinataire, sans créer de demande incomplète. |
| SU-02 | Modéré | « Importer CSV » est actif sans modèle, aperçu, contrôle préalable ni mention distinguant un fournisseur importé d'un fournisseur connecté ou vérifié. | Des lignes importées peuvent être prises pour des organisations onboardées ou validées. | Ajouter modèle, prévisualisation, validation, rapport d'erreurs et statut initial explicite « importé/non connecté/non vérifié ». |
| SU-03 | Modéré | Le rôle requis pour inviter ou importer n'est pas visible. | L'utilisateur découvre tardivement un éventuel refus d'autorisation. | Afficher le rôle courant et le prérequis d'autorisation avant l'action, avec contrôle serveur obligatoire. |
| SU-04 | Mineur | L'action « Inviter un fournisseur » est répétée en en-tête et dans l'état vide. | Redondance visuelle. | Conserver une action principale ou donner à la seconde une fonction d'aide distincte. |

### Cohérences confirmées

- L'état vide est clair : aucun fournisseur connecté.
- La page indique qu'un fournisseur doit être invité avant de commencer une collecte.
- Avant invitation, elle demande de confirmer destinataire, données accessibles, rôle et procédure de révocation.
- Elle précise explicitement qu'une invitation ne vérifie pas le fournisseur.
- Aucun fournisseur, site, pays ou score fictif n'est affiché.

### Verdict écran

**Globalement sincère — 1 défaut majeur, 2 modérés et 1 mineur.** L'état vide est excellent ; la principale incohérence est l'action globale « Nouvelle demande » encore active sans destinataire.

## Écran 13 — Demandes de données

Source : capture utilisateur de Production, organisation sans fournisseur et sans demande. Aucune action n'a été déclenchée.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| DR-01 | Majeur | Les deux actions propres à la page (« Nouvelle demande de données » et « Créer une demande ») sont correctement désactivées, mais le bouton global « Nouvelle demande » reste actif. | Deux règles de prérequis différentes coexistent pour la même opération. | Faire appliquer au bouton global la même condition que les actions locales et afficher le même motif. |
| DR-02 | Modéré | Les boutons désactivés n'indiquent pas explicitement « Aucun fournisseur connecté ». | Le blocage paraît arbitraire malgré le bon état vide de la page Fournisseurs. | Ajouter une aide visible et accessible indiquant le prérequis et un lien vers Fournisseurs. |
| DR-03 | Modéré | Le schéma explicatif est correctement non interactif, mais les étapes 4 à 7 décrivent des capacités (OCR, annotations, évaluation DPP) sans distinguer ici ce qui est opérationnel, conditionnel ou planifié. | Un schéma pédagogique peut être pris pour la preuve que chaque étape est automatisée. | Ajouter une légende « cycle cible » et indiquer les capacités réellement disponibles ou dépendantes d'un service. |
| DR-04 | Mineur | Anglais résiduel : `LAYER 01–04` et `Missing`. | Rupture linguistique. | Localiser ou supprimer le vocabulaire interne. |

### Cohérences confirmées

- Aucun fournisseur et aucune demande ne sont inventés.
- Les actions locales de création sont bloquées faute de prérequis.
- Le cycle explicatif est grisé et ne se présente pas comme un état d'avancement réel.
- L'étape « Données acceptées » précise un niveau de confiance déclaré ou documenté selon les sources ; l'acceptation n'est pas assimilée à une vérification.
- Les états demandée, soumise, en revue, acceptée, rejetée et clôturée restent distincts.

### Verdict écran

**À corriger — 1 défaut majeur, 2 modérés et 1 mineur.** La règle locale est correcte ; le bouton global doit impérativement employer le même prérequis fournisseur.

## Écran 14 — Constructeur de questionnaires

Source : capture utilisateur de Production, un modèle visible, aucun fournisseur connecté. Aucun modèle n'a été modifié, créé, exporté ou lancé.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| QU-01 | Majeur | « Lancer une collecte avec ce modèle » est correctement désactivé, mais le bouton global « Nouvelle demande » reste actif. | Le contournement du prérequis fournisseur persiste sur un troisième écran. | Centraliser le contrôle de prérequis et l'appliquer à toutes les entrées de création de demande. |
| QU-02 | Modéré | Le lancement désactivé n'indique pas directement qu'aucun fournisseur n'est connecté. | L'utilisateur peut attribuer le blocage au statut non validé du protocole plutôt qu'à l'absence de destinataire. | Afficher les prérequis séparément : destinataire manquant et validation du protocole non établie. |
| QU-03 | Modéré | « Modifier le protocole » ne précise pas si la modification crée une nouvelle version immuable ou altère la version `v1.0`. | Risque de croire qu'un protocole déjà référencé peut être réécrit sans historique. | Renommer « Créer une nouvelle version » lorsque le modèle est versionné et afficher l'historique. |
| QU-04 | Modéré | « Exporter Gabarits (JSON) » ne précise pas si le statut de validation, la version et la provenance sont inclus dans l'export. | Un gabarit non validé peut circuler sans son contexte de confiance. | Inclure ces métadonnées et annoncer le périmètre avant téléchargement. |
| QU-05 | Mineur | Anglais résiduel : « Product data core ». | Rupture linguistique. | Localiser le nom ou le qualifier comme identifiant technique. |

### Cohérences confirmées

- Le modèle est distinct d'une collecte réellement lancée.
- Le protocole est déclaré disponible mais sa validation est explicitement « non établie ».
- L'action de collecte est désactivée sans fournisseur.
- Le hash OCR est explicitement limité : il ne prouve ni authenticité du document ni exactitude du contenu.
- Le contrôle BOM annoncé porte seulement sur la somme mathématique à 100 %.
- La correspondance réglementaire est qualifiée d'indicative et non assimilée à une conformité légale.
- Les changements de mapping réglementaire exigent une validation humaine.

### Verdict écran

**Globalement sincère — 1 défaut majeur, 3 modérés et 1 mineur.** Les limites de confiance sont bien formulées ; il faut expliciter les prérequis du lancement et l'immuabilité des versions.

## Écran 15 — Preuves & Documents

Source : capture utilisateur de Production, registre vide. Aucun dépôt ni téléchargement de registre n'a été déclenché.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| DC-01 | Modéré | « Télécharger le registre d'intégrité » est actif alors que le registre contient zéro document. | Un export vide peut être pris pour un registre attestant l'absence de problème ou la complétude documentaire. | Désactiver l'export vide ou annoncer clairement « Registre vide — ne prouve pas la complétude ». |
| DC-02 | Modéré | « Déposer un nouveau document » ne montre pas avant ouverture le rôle requis, le propriétaire du document ni le sujet auquel il devra être rattaché. | Un document peut être chargé sans que son périmètre de visibilité et sa responsabilité soient compris. | Afficher les prérequis d'autorisation, de rattachement et de confidentialité avant le dépôt. |
| DC-03 | Modéré | Le titre « Documents chargés — intégrité SHA-256 contrôlée » ne distingue pas dans son intitulé les documents seulement empreintés de ceux dont l'empreinte a effectivement été recontrôlée. | « Contrôlée » peut être interprété comme un contrôle documentaire plus large. | Utiliser des statuts ligne par ligne : empreinte calculée, empreinte recontrôlée, altération détectée ; ne pas étendre ce statut au contenu. |
| DC-04 | Mineur | Anglais résiduel : `LAYER 03`. | Rupture linguistique. | Localiser ou supprimer. |
| DC-05 | Mineur | Les descriptions de catégories et les en-têtes du tableau sont très petits. | Les distinctions de type, tiers, validité et intégrité sont difficiles à lire. | Augmenter taille et contraste. |

### Cohérences confirmées

- Le registre affiche zéro document et aucune source documentaire chargée.
- Aucun certificat, rapport de laboratoire, audit social ou relevé de production fictif n'est créé.
- La page précise explicitement que l'intégrité technique ne constitue ni authentification ni vérification de fond.
- Le texte SHA-256 précise que le hash ne prouve ni authenticité, ni identité de l'émetteur, ni véracité du contenu.
- Le futur tableau distingue titre, type/standard, émetteur/tiers, fournisseur, date, validité et statut d'intégrité.
- L'absence de document correspond à la couverture de preuves de 0 % observée ailleurs.

### Verdict écran

**Globalement conforme — 3 défauts modérés et 2 mineurs.** Les limites du hash sont très bien formulées ; il reste à préciser le sens exact de « contrôlé » et les prérequis du dépôt/export.

## Écran 16 — Certifications

Source : capture utilisateur de Production, registre vide. Aucun certificat n'a été déclaré.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| CE-01 | Modéré | « Déclarer un certificat » ne présente pas avant ouverture le rôle requis, le sujet certifié, les documents nécessaires ni le fait que l'enregistrement initial restera seulement déclaré. | L'utilisateur peut commencer une déclaration sans comprendre son périmètre ni son niveau de confiance. | Afficher les prérequis et rappeler dans la confirmation qu'une déclaration ne vaut ni contrôle ni vérification de l'émetteur. |
| CE-02 | Modéré | Le tableau prévoit organisme et statut, mais l'état vide ne montre pas les futures métadonnées nécessaires à une vérification auprès de l'émetteur : méthode, date, vérificateur et résultat. | La différence entre « contrôlé » et « vérifié auprès de l'émetteur » pourrait manquer de traçabilité lors du premier enregistrement. | Exposer ces métadonnées dans le détail et l'historique du certificat. |
| CE-03 | Mineur | Le cycle de confiance est présenté dans une ligne de texte petite et dense. | Une distinction pourtant essentielle peut être manquée. | Transformer le cycle en étapes lisibles avec définitions accessibles. |

### Cohérences confirmées

- Aucun certificat déclaré ou fictif n'est affiché.
- L'absence de certificat correspond aux vues d'ensemble, Documents et Bilan massique.
- Le cycle distingue déclaré, document associé, contrôlé et vérifié auprès de l'émetteur.
- La surveillance porte uniquement sur les échéances déclarées.
- La page précise que validité et statut doivent être confirmés auprès de l'émetteur.
- Aucun certificat expirant n'est inventé lorsqu'il n'existe aucun certificat.

### Verdict écran

**Conforme avec améliorations — 2 défauts modérés et 1 mineur.** La distinction des niveaux de confiance et la prudence sur les échéances sont correctes ; les prérequis et métadonnées de vérification doivent être plus visibles.

## Écran 17 — Catalogue des matières premières

Source : capture utilisateur de Production, une matière synthétique de recette. Aucun ajout, export ou changement n'a été effectué.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| MT-01 | Majeur | La liste ne montre pas le niveau de confiance de la matière alors que la traçabilité la qualifie « déclarée, non vérifiée ». | Une ligne de catalogue peut être interprétée comme une donnée établie plutôt que comme une déclaration. | Ajouter statut de confiance, source, déclarant et date de déclaration dans la liste ou son résumé accessible. |
| MT-02 | Modéré | Le rattachement à l'unique produit n'est pas visible, alors que cette matière représente 100 % de sa BOM et porte le risque d'origine. | L'utilisateur ne peut pas relier depuis la liste la matière au produit exposé. | Afficher le nombre de produits liés et permettre de consulter les rattachements sans modifier les données. |
| MT-03 | Modéré | Les tirets des colonnes Recyclé, Certifications et Échelon ne distinguent pas « inconnu », « non applicable » et « absent ». | Des états sémantiquement différents paraissent identiques. | Utiliser des libellés explicites et accessibles. |
| MT-04 | Modéré | « Exporter CSV » n'annonce ni le périmètre, ni les niveaux de confiance, ni les lacunes incluses. | L'export peut perdre le caractère déclaré/non vérifié de la matière. | Prévisualiser les colonnes et inclure provenance, confiance, date de coupe et valeurs inconnues. |
| MT-05 | Modéré | « Ajouter un matériau » ne montre pas le rôle requis ni les champs minimaux avant ouverture. | Une nouvelle matière peut être engagée sans comprendre son statut initial et ses obligations de provenance. | Afficher rôle, statut initial déclaré et champs requis. |
| MT-06 | Mineur | Le type `Other` reste en anglais. | Rupture linguistique et valeur technique exposée. | Afficher « Autre » tout en conservant la valeur technique dans les données. |

### Cohérences confirmées

- La matière de recette est explicitement identifiable comme synthétique.
- Le pays d'origine est « non renseigné », cohérent avec le risque d'origine matière à 100 %.
- Aucune certification, part recyclée ou classification d'échelon n'est inventée.
- Le produit et la matière restent distincts : le pays de fabrication FR du produit ne remplit pas artificiellement l'origine de la matière.

### Incident fonctionnel lors de l'inspection

L'action « Inspecter » a été déclenchée en lecture seule. Elle n'a ouvert aucune fiche et a affiché :

> Indisponible en mode démonstration — connectez les API TRACEFAB pour exécuter cette action.

Le code confirme que le bouton réel est encore câblé sur `data-demo-action="1"`, tout comme « Exporter CSV ».

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| MT-07 | Majeur | Une matière réelle chargée depuis l'API expose une action « Inspecter » factice, réservée au mode démonstration. | La provenance, le rattachement et l'historique de la matière ne sont pas consultables ; l'interface de Production prétend offrir une capacité inexistante. | Implémenter une fiche matière en lecture réelle, ou retirer/désactiver le bouton avec un statut « non disponible ». |
| MT-08 | Majeur | Le message affirme que l'utilisateur est « en mode démonstration » alors que la recette est effectuée dans l'organisation Production. | Confusion entre environnement, données synthétiques et fonctionnalité non implémentée. | Ne jamais employer « mode démonstration » hors `?demo=1` ; afficher précisément « Fiche matière non implémentée » si nécessaire. |
| MT-09 | Modéré | « Exporter CSV » utilise le même mécanisme factice `data-demo-action`. | Une action présentée comme disponible échoue en Production. | Implémenter un export réel avec aperçu ou désactiver explicitement l'action. |

### Verdict écran

**À corriger — 3 défauts majeurs, 5 modérés et 1 mineur.** La donnée manquante est sincère, mais les actions Inspecter et Exporter CSV sont des façades de démonstration exposées en Production.

## Écran 18 — Portefeuille Passeport DPP

Source : capture utilisateur de Production, profil `textile_readiness_mvp v1.0`, un produit calculé. Aucun recalcul n'a été déclenché.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| DP-01 | Bloquant | Le portefeuille affiche `100,0 %`, « Prêt pour validation », zéro point bloquant et aucune exigence restante, alors que le même produit a 0 % de preuves, une origine matière inconnue, 0/2 étape documentée, plusieurs attributs inconnus et un avertissement actif. | Le profil de préparation ignore des lacunes essentielles et présente un produit incomplet comme entièrement prêt. | Revoir le profil : distinguer structure technique, données requises, preuves, traçabilité et gouvernance ; empêcher l'état « prêt pour validation » lorsque des exigences applicables restent inconnues ou non documentées. |
| DP-02 | Majeur | « Aucun écart sur le portefeuille » contredit les lacunes visibles dans Qualité, Risque et Traçabilité. | La synthèse DPP efface les écarts des autres domaines. | Agréger les écarts inter-domaines ou indiquer explicitement « aucun écart selon ce profil technique limité » avec la liste des exclusions. |
| DP-03 | Majeur | Le profil actif est nommé, mais ses exigences, champs obligatoires, exclusions et formule ne sont pas consultables depuis cet écran. | Impossible d'expliquer pourquoi des attributs inconnus et preuves absentes donnent 100 %. | Ajouter un détail versionné du profil et une ventilation du calcul par exigence. |
| DP-04 | Modéré | « Recalculer la préparation » ne présente ni données relues, ni impacts persistants, ni date de coupe avant exécution. | Une action de calcul/écriture ressemble à un rafraîchissement sans conséquence. | Ajouter une confirmation et lister les sources recalculées. |
| DP-05 | Modéré | La clé technique `textile_readiness_mvp v1.0` est exposée sans libellé métier. | Le profil est difficile à comprendre pour un utilisateur métier. | Afficher un nom localisé et garder la clé technique dans les détails. |
| DP-06 | Mineur | Les mentions précisant que la préparation n'est pas une certification sont petites par rapport au score 100 %. | Le garde-fou est visuellement dominé par le score parfait. | Renforcer le statut et afficher « préparation technique » dans le libellé principal du score. |

### Point conforme mais insuffisant

La page indique explicitement que l'indicateur de préparation n'est pas une certification légale. Cette précision est correcte, mais elle ne compense pas un profil qui ignore les lacunes affichées ailleurs.

### Verdict écran

**Blocage de validation — 1 défaut bloquant, 2 majeurs, 2 modérés et 1 mineur.** Le score parfait ne peut pas servir de signal de préparation tant que son profil ne couvre ni les preuves ni les lacunes de traçabilité et d'origine observées.

## Écran 19 — Détail de préparation DPP

Source : capture utilisateur de Production après sélection de l'unique produit. Aucun recalcul ni validation pour publication n'a été déclenché.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| DD-01 | Bloquant | « Valider pour publication DPP » est actif pour un produit Brouillon nommé « ne pas commercialiser », avec 0 % de preuves, une anomalie active, aucune certification, une origine matière inconnue et 0/2 étape documentée. | Publication ou passage d'état injustifié d'un passeport non étayé. | Bloquer côté interface et serveur tant que toutes les exigences applicables, preuves, autorisations et revues humaines ne sont pas satisfaites. Le nom du produit ne doit pas être le seul garde-fou. |
| DD-02 | Bloquant | Le bloc « Qualité & Preuves » affiche 100 % et « Conforme » sur le seul critère d'absence d'anomalie bloquante, alors qu'une anomalie warning existe et que la couverture de preuves vaut 0 %. | L'absence de blocage critique est assimilée à une validation documentaire et à une qualité parfaite. | Séparer absence de blocage, couverture documentaire, vérification et qualité ; une dimension sans preuve ne peut pas valoir 100 %. |
| DD-03 | Bloquant | « Composition certifiée » est annoncée comme pilier normatif et la composition vaut 100 %, alors qu'aucun certificat n'existe et que la matière est seulement déclarée. | Une somme de BOM à 100 % est assimilée à une composition certifiée. | Renommer « composition totalisée » et exiger une certification réelle, applicable et vérifiée uniquement si le profil en demande une. |
| DD-04 | Majeur | « Traçabilité Supply Chain » vaut 100 % parce qu'un graphe multi-niveaux est actif, malgré `0/2` étape documentée et `0 %` de preuves. | L'existence structurelle d'un graphe est assimilée à une traçabilité étayée. | Ventiler structure du graphe, étapes documentées, preuves, couverture et niveau de confiance. |
| DD-05 | Majeur | Le résumé indique `9/9 exigences satisfaites`, mais les neuf exigences ignorent ou neutralisent les lacunes observées dans les autres domaines. | Le compteur donne une fausse impression d'exhaustivité normative. | Afficher toutes les exigences applicables, les exclusions justifiées, les inconnues et les sources ; aucune exigence inconnue ne doit être automatiquement satisfaite. |
| DD-06 | Majeur | Le texte parle d'« évaluation projetée sur 4 piliers normatifs » alors que le profil est un MVP interne et que plusieurs critères ne correspondent pas à une exigence normative démontrée. | Un profil interne peut être pris pour une évaluation réglementaire officielle. | Remplacer par « profil interne de préparation technique » et référencer précisément chaque exigence externe réellement applicable. |
| DD-07 | Modéré | « Préparation générale des données produit » est comptée comme exigence conforme dans le bloc Identification sans critère transparent. | Critère circulaire susceptible de gonfler le score. | Supprimer le critère agrégé ou publier sa formule et ses dépendances sans double comptage. |
| DD-08 | Modéré | Les attributs inconnus visibles sur la fiche — couleur, poids et tailles — sont absents des exigences et exclusions affichées. | Le 100 % paraît exhaustif alors que le profil choisit un sous-ensemble de champs sans l'annoncer. | Afficher le périmètre, les exclusions et leur justification ; utiliser « complet selon le profil X » plutôt que « conforme ». |

### Verdict écran

**Blocage immédiat de publication — 3 défauts bloquants, 3 majeurs et 2 modérés.** Le bouton de validation ne doit pas être utilisé. Le moteur DPP confond actuellement existence structurelle, somme à 100 %, absence d'anomalie critique, certification, preuve et préparation à la publication.

## Écran 9 — Intégrations

Source : capture utilisateur de Production, organisation de recette, sans sélection ni configuration d'un connecteur.

### Constats

| ID | Sévérité | Constat | Risque | Correction attendue |
|---|---|---|---|---|
| IG-01 | Modéré | Centric, Lectra et SAP sont qualifiés « Connecteur opérationnel · configuration requise » alors qu'aucune connexion n'est configurée et qu'aucune exécution réelle n'est observable. | « Opérationnel » peut être compris comme une intégration live éprouvée, alors que seule une capacité logicielle ou un parseur peut être disponible. | Employer « Adaptateur disponible — non configuré » et réserver « opérationnel » à une connexion testée et activée. |
| IG-02 | Modéré | Le cycle décrit configuration, test, autorisation, activation et révocation, mais aucun rôle requis ou responsable n'est visible. | Gouvernance des secrets et activation difficiles à comprendre. | Afficher les rôles autorisés et le propriétaire de la connexion avant toute configuration. |
| IG-03 | Modéré | La politique affirme que les secrets sont chiffrés, contraints par rôles, rotatifs et révocables sans lien vers la procédure, l'état de rotation ou le périmètre technique. | Une propriété de sécurité générale peut être prise comme une preuve que chaque connecteur satisfait déjà ces contrôles. | Présenter ces éléments comme exigences et afficher leur état seulement pour une connexion configurée et contrôlée. |
| IG-04 | Mineur | Les statuts et textes de gouvernance sont très petits. | Les distinctions « disponible », « configuré » et « opérationnel » sont faciles à manquer. | Renforcer la hiérarchie et la lisibilité des états. |

### Cohérences confirmées

- La page annonce clairement qu'aucune connexion n'est configurée.
- Aucun état de synchronisation ou de succès n'est inventé.
- Le connecteur GS1 EPCIS 2.0 est correctement marqué « Prévu — non opérationnel ».
- Aucun GTIN ou Digital Link n'est prétendu pour le produit.
- Toutes les étapes du cycle restent « Non configuré ».
- L'interface avertit de ne jamais placer de secret dans une charge utile d'import.
- La validation avant import prévoit aperçu du mapping et rapport de validation plutôt qu'une écriture aveugle.

### Verdict écran

**Globalement conforme — 3 défauts modérés et 1 mineur.** La page évite les faux états de connexion ; il reste à remplacer « opérationnel » par une qualification strictement liée à la capacité réellement disponible.
