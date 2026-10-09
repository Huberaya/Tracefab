# Dossier sécurité — questionnaire acheteur

Destiné aux équipes sécurité de vos prospects. Chaque affirmation est
vérifiable dans le code ; les références sont données.

**Ce document dit aussi ce qui manque.** Un dossier qui ne mentionne aucune
limite n'est pas lu comme rassurant, il est lu comme incomplet — et la limite
se découvre pendant l'audit, au pire moment.

---

## 1. Cloisonnement entre clients

**Question posée :** *un client peut-il voir les données d'un autre ?*

L'isolation ne repose pas sur du code applicatif qu'un développeur pourrait
oublier d'écrire. Elle est appliquée **par PostgreSQL**, sous chaque requête.

| Mécanisme | Mise en œuvre |
|---|---|
| Row Level Security | **45 tables** en `ENABLE`, **49** directives `FORCE`, réparties sur 32 migrations |
| Contexte de session | Chaque transaction arme `tracefab.user_id` ; les politiques filtrent dessus |
| Périmètre applicatif | Chaque route borne en plus par organisation |

`FORCE ROW LEVEL SECURITY` est l'élément à souligner : il applique les
politiques **même au propriétaire de la table**. Une requête lancée à la main
en production reste cloisonnée.

**Contrôle automatisé.** Les **125 routes** de l'API doivent déclarer leur
modèle d'accès — locataire, publique, worker, webhook ou référentiel. Une route
ajoutée sans déclaration **fait échouer l'intégration continue**.

> Répartition actuelle : 102 routes locataire, 10 publiques assumées,
> 7 référentiel, 5 worker, 1 webhook.

Référence : `scripts/test_cross_tenant.mjs`, exécuté à chaque poussée.

## 2. Identité et accès

| Sujet | Réponse |
|---|---|
| Fournisseur d'identité | Clerk |
| Mots de passe | Jamais stockés par TRACEFAB |
| Sessions | Jetons vérifiés côté serveur à chaque requête |
| Origines autorisées | Liste explicite (`TRACEFAB_AUTHORIZED_PARTIES`) |
| Rôles | Marque, fournisseur, vérificateur, plateforme |

Les tâches de fond sont protégées par un secret partagé distinct, jamais par
une session utilisateur.

## 3. Documents et pièces jointes

C'est le point le plus examiné, parce que c'est là que vivent les certificats
et les rapports d'essai.

- **Stockage privé**, jamais public. Visibilité par défaut : `private`.
- **Accès par URL signée** à durée de vie bornée (60 à 3 600 secondes,
  configurable). Aucun objet n'est servi par une URL permanente.
- **Analyse antivirus obligatoire avant acceptation.** Un fichier non analysé
  n'entre pas. Si l'analyseur ne répond pas, le dépôt échoue — il n'est jamais
  accepté par défaut.
- **Trois niveaux de visibilité** : `private`, `shared`, `public_projection`.
  Seule la projection publique alimente le passeport consommateur, et elle est
  explicite.

Références : `api/_lib/storage.ts`, `api/_lib/documents.ts`.

## 4. Secrets d'affaires des fournisseurs

Sujet sensible dans le textile : un fournisseur ne veut pas que sa marque
cliente découvre ses propres sous-traitants.

TRACEFAB applique un filtrage dédié avant partage
(`api/_lib/trade-secret-vault.ts`), aligné sur la **directive UE 2016/943**.
Le partage d'un profil fournisseur est un acte explicite du fournisseur, pas
un effet de bord de la relation commerciale.

## 5. Traçabilité des actions

Un journal d'audit (`audit_logs`) enregistre les actions sensibles. Les flux
de collecte sont conçus pour l'audit : chaque donnée porte son état — déclarée,
documentée, vérifiée, certifiée, à revoir, manquante — et sa source.

## 6. Journalisation et incidents

- Toute exception non rattrapée est **capturée par une barrière centrale** :
  journal JSON structuré, identifiant de corrélation rendu au client.
- **Les secrets sont caviardés avant toute sortie** : chaînes de connexion,
  clés Clerk, Resend, AWS, en-têtes `Bearer`, JWT, paramètres signés. Une clé
  dans un collecteur de logs est une fuite permanente.
- Le détail de l'exception n'est **jamais** renvoyé au client : il reçoit
  `internal_error` et l'identifiant de corrélation, rien d'autre.

Référence : `api/_lib/error-reporting.ts`.

## 7. Données et conservation

| Sujet | Réponse |
|---|---|
| Hébergement | PostgreSQL managé (Neon), région configurable |
| Chiffrement | Au repos et en transit, assuré par les fournisseurs d'infrastructure |
| Restauration | Point dans le temps, jusqu'à 30 jours selon la formule souscrite |
| Procédure | `docs/operations/runbook-sauvegarde-restauration.md`, répétée trimestriellement |

**Point d'honnêteté technique :** les fichiers vivent dans un stockage objet,
hors de la ligne de temps de la base. Une restauration de base n'annule pas les
mouvements de fichiers. Le runbook impose une réconciliation ; nous ne
prétendons pas que la restauration est atomique sur les deux systèmes.

## 8. Vérification continue

Quatre étages d'intégration continue à chaque modification :

| Étage | Contenu |
|---|---|
| Socle | Types, compilation, isolation multi-locataires, garde-fous de production |
| Vérification | 64 suites de tests automatisés |
| Parcours | 20 parcours navigateur de bout en bout, trois personas |
| Base | Scénarios d'isolation exécutés contre PostgreSQL |

Aucune modification n'atteint la production sans ces quatre étages.

---

## Ce que nous n'avons pas encore

Cette section existe parce qu'elle est la plus utile des huit précédentes.

| Sujet | État | Échéance |
|---|---|---|
| Pagination systématique des listes | Partielle | Prochain lot |
| `style-src` sans `'unsafe-inline'` | En place avec `'unsafe-inline'` | Prochain lot |
| Test d'intrusion externe | Non réalisé | À planifier |
| Certification SOC 2 / ISO 27001 | Non engagée | Sur demande client |

**Précision sur la CSP.** `script-src` ne contient **pas** `'unsafe-inline'` :
tout le JavaScript des pages a été sorti du balisage vers `/assets/js/`
précisément pour cela. La tolérance subsiste uniquement sur `style-src`, du
fait d'attributs `style=` encore présents dans le balisage. La distinction
compte : c'est l'injection de script qui exécute du code, pas l'injection de
style.

**Précision sur la pagination.** Les listes ne sont pas toutes paginées. Un
plafond de lignes par requête (`TRACEFAB_QUERY_ROW_CEILING`, 5 000 par défaut)
borne l'exposition en attendant, mais ce n'est pas de la pagination : c'est un
garde-fou.

**Corrigé depuis la version précédente de ce dossier.** La limitation de débit
y était déclarée absente, et présentée comme notre exposition principale. Elle
est en place et appliquée dans le routeur d'API (réponse `429` et en-têtes
`RateLimit-*`) :

| Classe d'appel | Budget | Fenêtre |
|---|---:|---|
| Lecture publique (dont passeport et DPP) | 120 | par minute |
| Cartes wallet | 20 | par minute |
| Écriture publique | 10 | par 5 minutes |
| Appel authentifié | 600 | par minute |

Exemptés : `health`, `internal/*`, `webhooks/*`. Le limiteur est *fail-open* :
s'il ne peut pas statuer, il laisse passer plutôt que de bloquer le service, et
se met en quarantaine 30 secondes. C'est un choix de disponibilité, assumé et
écrit ici.

---

## Contacts et escalade

| Sujet | Engagement |
|---|---|
| Signalement de vulnérabilité | `security@tracefab.com` |
| Accusé de réception | 1 jour ouvré |
| Notification d'incident au client | 24 heures après prise de connaissance |
| Sous-traitants ultérieurs | liste complète ci-dessous |

**Sur le délai de 24 heures.** L'article 33(2) du RGPD impose au sous-traitant
d'informer le responsable de traitement « dans les meilleurs délais », sans
fixer d'heure. Nous nous engageons sur 24 heures parce que c'est ce qui vous
laisse le temps de tenir vos propres 72 heures vis-à-vis de votre autorité de
contrôle. Nous ne notifions pas la CNIL à votre place : cette obligation reste
la vôtre, et la documenter est le sens de cette ligne.

### Sous-traitants ultérieurs

Liste établie par audit du code, pas de mémoire. Chaque entrée correspond à une
dépendance effectivement présente dans l'application.

| Sous-traitant | Rôle | Données concernées |
|---|---|---|
| **Neon** | PostgreSQL managé | Toutes les données métier |
| **Vercel** | Hébergement, fonctions, journaux | Trafic, journaux applicatifs |
| **Clerk** | Authentification et identités | Identités et sessions utilisateur |
| **Resend** | Courriel transactionnel | Adresses des destinataires |
| Stockage objet | Documents et preuves | Fichiers téléversés |
| Service antivirus | Analyse des téléversements | Fichiers téléversés |
| **jsDelivr** | Diffusion du SDK Clerk au navigateur | Adresse IP du visiteur |
| **Google Fonts** | Polices de caractères | Adresse IP du visiteur |
| Apple Wallet | Cartes de passeport produit | Identifiants produit |
| Google Wallet | Cartes de passeport produit | Identifiants produit |

Le stockage objet et le service antivirus sont configurables par déploiement
(`PRIVATE_STORAGE_*`) : le fournisseur retenu pour votre contrat est précisé à
la signature plutôt que fixé ici.

**Point d'honnêteté sur Google Fonts et jsDelivr.** Ces deux services sont
appelés directement par le navigateur du visiteur, qui leur transmet donc son
adresse IP. Les polices sont chargées depuis `fonts.googleapis.com` et
`fonts.gstatic.com` sur l'ensemble des pages ; `cdn.jsdelivr.net` sert le SDK
Clerk sur la page d'acceptation d'invitation. C'est un point de friction RGPD
connu, et nous préférons l'écrire que le laisser découvrir. Héberger ces deux
ressources depuis notre propre domaine supprimerait l'exposition ; c'est au
programme, ce n'est pas fait.
