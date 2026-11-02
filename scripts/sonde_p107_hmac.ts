#!/usr/bin/env -S node --import tsx
/**
 * P10.7 — chantier C : sonde de configuration HMAC, EXPURGÉE.
 *
 * Ce qu'elle mesure : la présence, le format et l'état de la clé qui signe le
 * jeton d'identité, dans l'environnement où elle est exécutée. Ce qu'elle
 * publie : des BOOLÉENS et des libellés d'état. Jamais un caractère de la clé,
 * jamais sa longueur exacte, jamais un fragment de message d'erreur.
 *
 * POURQUOI PAS UN `echo $TRACEFAB_IDENTITY_KEY | wc -c`
 *
 * Une valeur de secret recopiée dans un journal de CI est une fuite
 * définitive : on ne révoque pas un journal. La sonde lit donc la clé en
 * mémoire, la passe à la MÊME fonction de validation que le runtime
 * (`etatCleIdentite`, importée — jamais recopiée, pour qu'un changement de
 * règle de format ne laisse pas derrière elle un diagnostic périmé), et ne
 * rend que le verdict.
 *
 * CE QU'ELLE NE PROUVE PAS, ET QU'ELLE LE DIT
 *
 *   - la cohérence Preview ↔ Production : il faudrait interroger le fournisseur,
 *     pas le processus. Deux exécutions séparées donnent deux mesures, pas une
 *     preuve de cohérence ;
 *   - les clés ACTIVES côté base : le rôle du runtime ne peut pas lire
 *     `tracefab_identity_cles` (mesuré en P10.5 : `42501 permission denied`),
 *     et c'est exactement ce qui rend la falsification impossible. La rotation
 *     à deux clés actives se démontre donc en base (chantier D, D6/D7), pas ici ;
 *   - que la base applique `strict` : c'est `tracefab_identity_politique`, lu
 *     par la sonde de catalogue (chantier B).
 *
 * Usage : node --import tsx scripts/sonde_p107_hmac.ts [étiquette]
 * Sorties : 0 mesuré (clé absente ou valide) · 1 clé PRÉSENTE mais inutilisable
 *           · 2 argument invalide.
 */
import { etatCleIdentite } from '../api/_lib/identite-jeton.js';

const etiquette = process.argv[2] ?? 'local';
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(etiquette)) {
  console.error('REFUS : étiquette attendue = [a-z0-9_-]{1,32}');
  process.exit(2);
}

const etat = etatCleIdentite();

const rapport = {
  schema: 'tracefab-p107-config-hmac-v1',
  environnement: etiquette,
  hmac: {
    // `presente` distingue « rien n'est posé » (transition documentée) de
    // « quelque chose est posé » — c'est la question de l'opérateur : le
    // secret a-t-il été posé sur CET environnement ?
    presente: etat !== 'absente',
    // `valide` est le seul chemin où l'application signe réellement.
    valide: etat === 'valide',
    // Mêmes deux champs que `GET /api/internal/p2-readiness` (`identityTokens`),
    // pour que le diagnostic hors ligne et la readiness disent la même chose.
    configured: etat === 'valide',
    mode: etat === 'valide' ? 'signe' : etat === 'invalide' ? 'cle_invalide' : 'non_configure',
    // Le format est une propriété publique du code, pas un secret : l'annoncer
    // permet de vérifier qu'un opérateur n'a pas posé une clé d'une autre
    // génération sans avoir à lire la valeur.
    format_attendu: 'hex, longueur paire, >= 64 caracteres (>= 32 octets)',
  },
  // Rotation : ce que l'application exige pour qu'un chevauchement soit sain.
  rotation: {
    version_format_jeton: 'v1',
    // La base doit accepter DEUX clés actives pendant le chevauchement : c'est
    // une propriété du schéma, démontrée en D6/D7 sur cluster jetable.
    chevauchement_deux_cles: 'demonstre_en_base_D6_D7',
    revocation_ancienne_cle: 'demonstree_en_base_D7',
    etat_cle_courante: 'mesure_ici_par_presence_et_format',
  },
  perimetre: {
    // Nommés exprès : un rapport qui ne dit pas ce qu'il n'a pas mesuré se lit
    // comme s'il avait tout mesuré.
    preview_production: 'non_mesuree_sans_acces_au_fournisseur',
    cles_base: 'non_lue_par_conception_role_runtime_42501',
    politique_stricte_base: 'non_lue_ici_voir_sonde_catalogue',
    valeur_cle: 'jamais_lue_vers_la_sortie',
  },
};

console.log(JSON.stringify(rapport, null, 2));

// Une clé présente mais inutilisable n'est pas un état de fonctionnement :
// c'est une faute de configuration qui casse la signature (P10.6). Elle sort
// en erreur, pour qu'un pipeline la voie au lieu de lire « non configurée ».
process.exit(etat === 'invalide' ? 1 : 0);
