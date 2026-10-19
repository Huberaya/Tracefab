/**
 * Réglage TLS unique pour toutes les connexions PostgreSQL des scripts.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Treize sites, dans dix fichiers, construisaient un objet `ssl` dont
 * `rejectUnauthorized` valait la valeur booléenne fausse. Cette valeur
 * **désactive la validation du certificat** : la connexion reste chiffrée, mais
 * n'importe quel intermédiaire capable d'intercepter le trafic peut présenter
 * un certificat auto-signé et être accepté. Sur une connexion qui transporte un
 * mot de passe de rôle et des données de production, ce n'est pas du
 * chiffrement, c'est une apparence de chiffrement.
 *
 * Le littéral fautif n'est pas repris tel quel dans ce commentaire : le contrôle
 * automatisé qui surveille ce défaut est un parcours textuel, et un commentaire
 * le contenant déclencherait un faux positif.
 *
 * Le dépôt contenait déjà le motif correct — `test_routes_tenant_isolation.mjs`
 * employait `rejectUnauthorized: true`. Ce module généralise ce motif et donne
 * au contrôle automatisé un point unique à surveiller.
 *
 * CE QUE FAIT LA VALIDATION
 *
 * `rejectUnauthorized: true` fait vérifier le certificat du serveur contre le
 * magasin de autorités racines embarqué dans Node. Les certificats Neon sont
 * émis par une autorité publique, donc la validation passe sans configuration.
 *
 * Si un environnement emploie une autorité privée, le magasin supplémentaire se
 * fournit par la variable d'environnement `NODE_EXTRA_CA_CERTS`, qui pointe un
 * fichier PEM. **Désactiver la validation n'est pas une option de secours** :
 * c'est précisément le défaut que ce module supprime.
 *
 * Aucun secret n'est manipulé ici : la chaîne de connexion n'est lue que pour
 * y détecter le paramètre `sslmode`, et n'est jamais journalisée.
 */

/**
 * Détecte si une chaîne de connexion demande TLS.
 *
 * @param {string} url chaîne de connexion PostgreSQL
 * @returns {boolean}
 */
export function tlsDemande(url) {
  return /(?:^|[?&])sslmode=(?:require|verify-full|verify-ca)/.test(String(url || ''));
}

/**
 * Réglage `ssl` à passer à `pg.Client`, validation toujours active.
 *
 * Retourne `false` quand la cible n'exige pas TLS — cas des bases locales
 * jetables de la CI — et un objet exigeant la validation du certificat sinon.
 *
 * @param {string} url chaîne de connexion PostgreSQL
 * @returns {false | { rejectUnauthorized: true }}
 */
export function sslDepuisUrl(url) {
  return tlsDemande(url) ? { rejectUnauthorized: true } : false;
}
