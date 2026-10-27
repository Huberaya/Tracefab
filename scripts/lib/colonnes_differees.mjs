/**
 * COLONNES QU'UNE MIGRATION PAS ENCORE APPLIQUEE AJOUTERA.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le 27/10/2026, `npm run verifier:identite-cible` a echoue sur la branche de
 * validation avec `column "reviewed_basis_fingerprint" does not exist`. Ce
 * n'etait pas une base abimee : c'est un defaut du verificateur, qui
 * interrogeait des colonnes que seules les migrations EN ATTENTE creent. Le
 * script censé autoriser la migration refusait donc de tourner avant elle.
 *
 * Trois facons de traiter le symptome ont ete ecartees :
 *   - lancer la migration pour faire taire l'erreur (on perd la preuve
 *     d'avant-migration, qui est justement ce qu'on veut) ;
 *   - supprimer la mesure (on perd un controle) ;
 *   - envelopper la requete dans un try/catch (l'erreur deviendrait silence).
 *
 * Le module classe donc les colonnes en trois :
 *   - MESURABLES  : presentes maintenant, mesurees maintenant ;
 *   - DIFFEREES   : absentes, mais ajoutees par une migration en attente —
 *                   mesure impossible AVANT, prevue APRES ; declarees comme
 *                   telles, jamais tues ;
 *   - INATTENDUES : absentes et qu'aucune migration en attente n'ajoute —
 *                   c'est une vraie incoherence, elle doit echouer.
 *
 * LIMITE ASSUMEE : seules les formes `ADD COLUMN [IF NOT EXISTS] <nom>` sont
 * reconnues. Une colonne creee autrement (CREATE TABLE, ALTER TABLE ... ADD
 * COLUMN ecrit sur plusieurs mots) n'est pas detectee : elle tombera dans
 * INATTENDUES, c'est-a-dire du cote qui fait echouer — jamais du cote qui
 * excuse. Le sens de l'erreur est volontairement prudent.
 */

const AJOUT_COLONNE = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;

/** Noms de colonnes ajoutees par un ensemble de fichiers SQL de migration. */
export function colonnesAjouteesPar(textesSql) {
  const noms = new Set();
  for (const sql of textesSql) {
    if (typeof sql !== 'string') continue;
    // On retire les commentaires de ligne : une migration commente abondamment
    // ses intentions, et citer `ADD COLUMN` dans un commentaire ne doit pas
    // creer de fausse colonne differee.
    const nettoye = sql.replace(/--[^\n]*/g, '');
    AJOUT_COLONNE.lastIndex = 0;
    let m;
    while ((m = AJOUT_COLONNE.exec(nettoye)) !== null) noms.add(m[1].toLowerCase());
  }
  return noms;
}

/**
 * @param {object} p
 * @param {Iterable<string>} p.presentes          colonnes reellement presentes
 * @param {Iterable<string>} p.ajouteesEnAttente  colonnes ajoutees par les migrations en attente
 * @param {Iterable<string>} p.attendues          colonnes dont la mesure est souhaitee
 * @returns {{mesurables: string[], differees: string[], inattendues: string[]}}
 */
export function classerColonnes({ presentes, ajouteesEnAttente, attendues }) {
  const dispo = new Set([...presentes].map((c) => String(c).toLowerCase()));
  const aVenir = new Set([...ajouteesEnAttente].map((c) => String(c).toLowerCase()));
  const mesurables = [];
  const differees = [];
  const inattendues = [];
  for (const brut of attendues) {
    const col = String(brut).toLowerCase();
    if (dispo.has(col)) mesurables.push(col);
    else if (aVenir.has(col)) differees.push(col);
    else inattendues.push(col);
  }
  return { mesurables, differees, inattendues };
}
