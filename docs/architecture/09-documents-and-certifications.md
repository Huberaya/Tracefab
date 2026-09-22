# 9. Documents and Certifications — Chantier 5

## Objectif

Mettre en place une chaîne d'évidence privée et explicable :

```text
métadonnée document enregistrée
  → upload vers Storage privé
  → scan de confiance
  → document disponible
  → certificat déclaré/documenté
  → revue interne ou vérification tierce
```

La présence d'un PDF ne vaut jamais validation de son contenu.

## Documents

La migration `20260922040000_tracefab_documents_certifications.sql` :

- crée ou force le bucket privé `tracefab-private` ;
- impose des chemins préfixés par l'identifiant de l'organisation ;
- refuse les chemins contenant `..` ;
- exige l'enregistrement SQL avant l'upload objet ;
- limite la taille à 50 MiB ;
- interdit les objets publics ;
- contrôle les lectures inter-organisations par `data_shares` et scope document ;
- supprime l'accès aux documents soft-deleted.

### Cycle document

`uploaded` → `scanning` → `available`

Un scan négatif passe à `rejected`. Une suppression fonctionnelle passe à `deleted` et ne donne pas immédiatement une suppression objet : le nettoyage Storage doit être exécuté par un job de confiance.

Le client appelle `tracefab_register_document(...)` avant l'upload. La finalisation est réservée au rôle `service_role` via `tracefab_finalize_document_upload(...)`, après vérification de l'objet, du hash et du scan dans une Edge Function ou un worker de confiance.

Aucune URL publique n'est stockée ni générée par la migration.

## Certifications

Une certification contient :

- standard et code ;
- émetteur et numéro ;
- périmètre fournisseur, site ou produit ;
- dates d'émission et d'expiration ;
- document d'évidence ;
- état de qualité (`declared`, `documented`, `verified_by_reviewer`, `certified_by_third_party`, etc.).

`tracefab_register_certification(...)` crée une certification `declared` ou `documented`. `tracefab_update_certification(...)` remet une certification modifiée à un état non vérifié. Les écritures directes de certification et de vérification sont retirées des policies client.

## Vérification

`tracefab_review_certification(...)` crée un `verification_record` immuable côté client et dérive l'état de la certification :

- revue marque réussie → `verified_by_reviewer` ;
- revue marque négative → `needs_review` ;
- vérificateur d'une organisation `verifier` réussi → `certified_by_third_party` ;
- certificat expiré → `expired`.

`certified_by_third_party` n'est possible que si l'organisation vérificatrice est explicitement de type `verifier` et que l'utilisateur possède un rôle de revue.

## Sécurité

- Le bucket est privé et son `public` est forcé à `false`.
- Le client ne peut uploader que dans un chemin pré-enregistré pour son organisation.
- Le client ne peut pas supprimer directement un objet Storage.
- Les champs de statut, hash, taille et scan sont gérés par les fonctions de workflow.
- Les documents partagés ne sont lisibles qu'après un partage objet actif ; les objets non disponibles ne sont pas exposés au bénéficiaire.
- Les certifications vérifiées et les vérifications ne sont pas modifiables par un simple `UPDATE` client.

## Reste à faire

- Edge Function d'upload signé ou upload contrôlé ;
- antivirus et validation MIME réelle ;
- extraction OCR en chantier IA documentaire ;
- rotation/rétention et nettoyage Storage ;
- alertes d'expiration ;
- registre externe des certificateurs ;
- interface de revue et piste d'audit détaillée ;
- tests RLS/Storage sur un projet Supabase réel.
