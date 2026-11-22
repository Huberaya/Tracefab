# TraceFab — clôture du P0 Isolation A/B (2026-11-09)

## Verdict

**PASS en préproduction sur P11 et Repair.** Les lectures positives du tenant courant et les refus de lecture du tenant voisin ont été exécutés avec le rôle PostgreSQL réel `tracefab_app`, sans `BYPASSRLS`, sous politique HMAC stricte.

Cette preuve ne vaut ni bascule Production, ni GO de commercialisation.

## P11 — preuve via le runtime Vercel Preview

- Déploiement Vercel Preview : `dpl_Fsbaa6YeMXVNQfzLuo8UBT1qysRn`, état **READY**.
- SHA testé : `574b1e7e50eef14594d079295ccaf87798276510`.
- Journal de build : `P11_ISOLATION_AB=9/9`.
- Connexion PostgreSQL réellement établie comme `tracefab_app` ; `NOBYPASSRLS` ; politique HMAC `strict=true`.
- Deux identités de deux organisations préexistantes, avec jetons signés en mémoire par la clé Preview. Aucun jeton ni secret n'est journalisé.

Résultats mesurés dans les deux sens :

| Surface | Tenant A | Tenant B |
|---|---:|---:|
| Organisations | A visible, B invisible | B visible, A invisible |
| Produits | A visible, B invisible | B visible, A invisible |
| Matières | A visible, B invisible | B visible, A invisible |
| Nœuds de traçabilité | A visible, B invisible | B visible, A invisible |
| Liens de traçabilité | A visible, B invisible | B visible, A invisible |
| Points de données | B invisible sous A | B visible sous B |

Contrôles complémentaires :
- La fonction `tracefab_can_access_org` retourne vrai pour l'organisation active et faux pour l'organisation voisine.
- Un GUC `tracefab.user_id` volontairement falsifié ne remplace pas l'identité HMAC.
- Un jeton A présenté avec le contexte B est refusé ; aucune ligne B n'est visible.
- Sans jeton, un GUC utilisateur forgé ne produit aucune identité en mode strict.
- `tracefab_app` possède SELECT sur les produits, mais aucun droit DML direct ; il ne peut pas lire la table des clés HMAC.

## Repair — preuve PostgreSQL sous le vrai rôle applicatif

La même matrice A/B a été exécutée dans une transaction Neon sur Repair :
- les jetons A et B ont été signés en mémoire dans la transaction avec la clé active de cette branche ; leur durée de vie était de 60 secondes. La réponse du contrôle SQL a affiché ces deux jetons éphémères, désormais expirés ; aucune valeur de clé HMAC n'a été exposée ;
- après `SET LOCAL ROLE tracefab_app`, les lectures positives et négatives ont été vérifiées sur organisations, produits, matières, nœuds, liens et points de données ;
- `tracefab_current_user_id()` reconnaît chaque jeton sous son organisation ;
- le jeton A sous le contexte B retourne NULL ; un GUC forgé sans jeton retourne NULL ;
- `tracefab_app` est `NOBYPASSRLS`, `strict=true`, ne lit pas la table des clés et ne possède pas de DML direct sur les produits ;
- les 53 tables applicatives de Repair ont RLS activée et `FORCE ROW LEVEL SECURITY`.

**Limite explicite :** sur Repair, cette preuve valide le moteur HMAC PostgreSQL et l'isolation sous le rôle applicatif ; elle ne constitue pas une nouvelle preuve d'interopérabilité entre le signataire de l'application Vercel et la clé Repair. Cette interopérabilité a été prouvée sur P11.

## Intégrité et périmètre

- Les essais sont en lecture seule ; les contextes sont transactionnels et la transaction de Repair est terminée sans écriture métier.
- Aucun enregistrement métier, rôle, ACL, secret, politique RLS ou migration n'a été modifié.
- Aucun accès à Production, aucune migration Production, aucun déploiement Production.
- Le script et le hook `postinstall` temporaires utilisés pour la sonde P11 ont été retirés ; `postinstall` est revenu à `node scripts/prisma-generate.mjs`.
- Aucun merge ni modification de `main`.

## Décision

**P0 Isolation A/B : PASS en préproduction P11 + Repair.** Le contrôle est démontré avec le véritable rôle `tracefab_app`, les identités HMAC strictes et des témoins positifs et négatifs sur les principales surfaces métier testées.

La Production reste hors périmètre de cette mission et demeure soumise à sa propre validation contrôlée.
