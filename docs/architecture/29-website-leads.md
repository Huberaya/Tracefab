# 29. Site public — pages de contenu et capture de leads (Chantier 03)

## Périmètre

1. Cinq pages publiques de contenu : `/platform/`, `/security/`,
   `/resources/`, `/about/`, `/contact/`.
2. La capture réelle des leads : modal « Request a demo » de la landing et
   formulaire de la page contact.

## Pages

Chaque page est statique, sertie par `vercel.json` via le handle filesystem
(aucune route explicite nécessaire). Elles réutilisent le design system
(`tracefab-core.css`, `tracefab-site.css`, `tracefab-components.css`,
`tracefab-touch.css`), le sélecteur de langue `tf-i18n` et un namespace i18n
dédié `site.*` (EN + six locales complètes). Les locales partielles tr/zh ont été retirées au Chantier 15 ; elles ne sont ni exposées ni promises.
Chaque page porte canonical, hreflang, Open Graph et JSON-LD.

## Capture de leads

`POST /api/leads` — endpoint **public** (aucune session Clerk), protégé par :

- validation stricte : `kind ∈ {demo, contact, pilot}`, nom ≤ 120, email
  regex ≤ 254, entreprise ≤ 160, rôle ≤ 80, message ≤ 2000, `sourceUrl`
  validée comme URL http(s) ;
- limitation de débit best-effort par IP (3 soumissions / 10 minutes,
  état en mémoire d'instance ; le rate limiting distribué relève du
  Chantier 16) ;
- insertion transactionnelle sous `tracefab.public_ingest = 'true'`,
  seule condition d'ouverture de la politique RLS d'insertion.

### Table `tracefab_leads`

Migration `20261008100000_website_leads`. Pré-tenant (les leads précèdent
toute organisation) :

- RLS activée **et forcée** ;
- insertion uniquement sous contexte `tracefab.public_ingest` ;
- lecture/mise à jour uniquement sous contexte `tracefab.worker_context`
  (operations) : la table est **write-only** depuis l'API ;
- aucune donnée d'en-tête ni IP persistée : champs du formulaire + page
  d'origine seulement.

### Notification

`sendLeadNotificationEmail` (`api/_lib/email.ts`) envoie le lead à
`TRACEFAB_LEADS_NOTIFICATION_EMAIL` via Resend si la variable est configurée.
L'envoi est une commodité : le lead est déjà persisté, un échec d'email ne
fait jamais échouer la soumission.

## Ce que ce contrat ne fait pas

- pas de liste de leads exposée par API (lecture réservée au contexte
  worker) ;
- pas de qualification automatique ni de scoring ;
- pas de webhook sortant pour les leads (à étudier avec les intégrations).
