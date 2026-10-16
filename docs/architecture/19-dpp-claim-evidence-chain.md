# Chaîne d’affirmations et de preuves DPP

## Principe

Une affirmation, un document et une vérification sont trois objets distincts.

- `dpp_claims` décrit ce qui est affirmé, sur quel périmètre, pendant quelle période et avec quel niveau de confiance.
- `dpp_claim_evidence` indique comment un document soutient, contredit ou contextualise l’affirmation.
- `documents` conserve le fichier privé et son empreinte éventuelle.

L’existence d’un document ou d’un hash ne prouve ni son authenticité ni la véracité de l’affirmation. L’acceptation d’un lien documentaire ne transforme jamais automatiquement une affirmation en « vérifiée par un tiers ».

## Historique

Les affirmations et liens sont append-only. Une nouvelle affirmation peut référencer `supersedes_claim_id`; l’ancienne reste consultable. Les corrections silencieuses par `UPDATE` ou `DELETE` sont refusées par trigger.

## Validité

Chaque affirmation peut porter `valid_from` et `valid_until`. La projection publique calcule `expired`; une affirmation expirée reste historique mais est explicitement signalée. Une expiration n’efface pas le fait qu’elle a existé.

## Confidentialité

La projection `tracefab_public_dpp_claims` retourne uniquement :

- identifiant d’affirmation ;
- clé et texte explicitement publics ;
- niveau de confiance ;
- période de validité et expiration ;
- nombre de preuves acceptées ;
- libellés de preuve explicitement publiés.

Elle ne retourne jamais UUID document, nom de fichier, bucket, chemin de stockage, note privée, motif privé, acteur ou organisation. Aucun téléchargement public de document n’est créé.

## API privée

- `GET /api/products/:productId/dpp/claims` : affirmations et preuves du tenant autorisé.
- `POST /api/products/:productId/dpp/claims` : nouvelle affirmation ou nouvelle version.
- `POST /api/products/:productId/dpp/claims/:claimId/evidence` : relation structurée vers un document du même tenant.

Les résultats `accepted` et `rejected` exigent owner/admin/manager/auditor et un motif. Les contributeurs peuvent proposer un lien `pending`, sans falsifier un statut de contrôle.

## Limites

- Pas de signature numérique de l’émetteur dans ce lot.
- Pas d’authentification automatique d’un certificat.
- Pas d’antivirus ajouté au stockage documentaire existant.
- Pas de téléchargement public ; une future ouverture devra utiliser une autorisation distincte et temporaire.
