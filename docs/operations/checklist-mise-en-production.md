# Checklist de mise en production

Chaque ligne est **vérifiable par une commande ou une observation**, jamais par
une opinion. Une case cochée sans preuve ne compte pas.

---

## A. Configuration

- [ ] Les 37 variables du [contrat](variables-environnement.md) sont définies
      dans l'environnement de production Vercel.

```bash
npm run test:production-readiness   # échoue si une variable du code n'est pas documentée
```

- [ ] Sondes de configuration vertes :

```bash
curl -s -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness" | jq '.ready'
```

- [ ] **Sondes réelles vertes** — c'est celle qui compte :

```bash
curl -s -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness?probe=live" | jq
```

> Une clé présente n'est pas une clé valide. Le premier appel constate que les
> variables existent ; seul le second prouve que la base, le stockage,
> l'antivirus, Resend et le collecteur d'alertes répondent.

- [ ] `EMAIL_FROM` utilise un domaine **vérifié chez Resend**. Un domaine non
      vérifié fait rejeter tous les envois, silencieusement pour l'utilisateur.
- [ ] `TRACEFAB_APP_URL` est l'URL publique canonique. Elle est inscrite dans
      les liens de passeport et les invitations : une erreur ici se propage
      dans des e-mails déjà partis.

## B. Base de données

- [ ] `npx prisma migrate status` : aucune migration en attente.
- [ ] Fenêtre d'historique Neon configurée et **couvrant un week-end** — une
      corruption du vendredi soir se découvre le lundi.
- [ ] Un instantané récent existe.
- [ ] La restauration a été **répétée au moins une fois** (runbook, section 6).
      Un runbook jamais exécuté est une fiction.

```bash
npm run test:cross-tenant   # RLS armée, aucune route hors modèle déclaré
```

## C. Sécurité

- [ ] `TRACEFAB_AUTHORIZED_PARTIES` limite les origines des jetons Clerk.
- [ ] Le webhook Clerk pointe sur la production et sa signature est vérifiée.
- [ ] Les secrets `TRACEFAB_NOTIFICATION_WORKER_SECRET` et `CRON_SECRET` sont
      distincts l'un de l'autre et de tout secret hors production.
- [ ] Aucun secret n'a transité par un canal de discussion ou un ticket. En cas
      de doute : rotation, procédure dans `production-hardening.md`.
- [ ] Les en-têtes de sécurité répondent :

```bash
curl -sI "$TRACEFAB_APP_URL/" | grep -iE 'content-security-policy|x-content-type|referrer-policy'
```

> **Dette connue, assumée.** La CSP contient encore `'unsafe-inline'`. C'est le
> chantier 16. À arbitrer explicitement avant d'ouvrir à des clients soumis à
> une revue de sécurité : ils le verront.

## D. Observabilité

- [ ] `TRACEFAB_ERROR_WEBHOOK_URL` pointe sur un collecteur réel, et une erreur
      de test y est arrivée.
- [ ] Quelqu'un est **nommément responsable** de regarder ce collecteur. Un
      collecteur que personne ne lit est un coût sans bénéfice.
- [ ] `TRACEFAB_NOTIFICATION_ALERT_URL` configurée : sans elle, un échec
      d'envoi d'invitation est invisible.
- [ ] Les déclenchements planifiés Vercel sont actifs pour
      `internal/notification-outbox/schedule` et `.../reminders`.
- [ ] La page d'état des erreurs a été vérifiée **après** le premier
      déploiement, pas avant.

## E. Application

- [ ] La CI est verte sur la référence déployée — les quatre étages.
- [ ] Les 20 parcours passent contre l'URL de production :

```bash
npm run test:journeys -- --base "$TRACEFAB_APP_URL"
```

- [ ] Les trois personas passent. C'est un critère d'acceptation du cahier des
      charges, pas un indicateur de confort.
- [ ] Un passeport public réel s'affiche : `"$TRACEFAB_APP_URL/p/<gtin>"`,
      bannière de démonstration **absente**.
- [ ] Un dépôt de document aboutit de bout en bout : dépôt, analyse antivirus,
      téléchargement. C'est le chemin qui traverse le plus de services.

## F. Données

- [ ] **Aucune donnée de démonstration n'est présentée comme réelle.** Tout
      chiffre illustratif porte son marquage.
- [ ] Le score de maturité DPP n'est présenté nulle part comme une
      certification réglementaire.

```bash
npm run test:pef   # rejette « DPP Conforme », « certifié ESPR » et équivalents
```

- [ ] Les six langues s'affichent sans clé brute ni copie codée en dur.

> **Dette connue.** La lignée produit contient encore du français codé en dur
> (`02. FILATURE`). `test:copy` ne la voit pas : la garde ne descend pas dans
> les vues de détail.

## G. Juste après l'ouverture

- [ ] Première erreur réelle observée dans le collecteur, avec son identifiant
      de corrélation lisible.
- [ ] Un utilisateur réel s'est connecté et a atteint sa console.
- [ ] Un fournisseur réel a reçu une invitation et a ouvert son portail.
- [ ] `?probe=live` repassé **après** l'ouverture du trafic : la charge révèle
      ce que le calme cache.

---

## Ce qui n'est pas prêt, et qu'il faut dire

Trois points relèvent de chantiers non livrés. Les ignorer ne les fait pas
disparaître ; les écrire permet de décider.

| Sujet | État | Chantier |
|---|---|---|
| CSP sans `'unsafe-inline'` | non fait | 16 |
| Limitation de débit sur l'API | **aucune** | 16 |
| Pagination des listes | **aucune** | 16 |

L'absence de limitation de débit est la plus exposée des trois : une API
publique sans plafond est une facture et une indisponibilité qui attendent leur
déclencheur.
