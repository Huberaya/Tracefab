/**
 * Liste FERMÉE des migrations qui exigent un exécutant administratif.
 *
 * POURQUOI UNE LISTE, ET POURQUOI ELLE EST FERMÉE
 *
 * Une exception non nommée devient une habitude. Chaque entrée ci-dessous
 * documente une opération que PostgreSQL refuse à un rôle non superutilisateur,
 * mesure à l'appui. Un nom absent de cette liste est exécuté par le rôle de
 * migration, et s'il échoue, il échoue : rien ne bascule silencieusement sur la
 * connexion administrative.
 *
 * La procédure est dans docs/security/2026-10-31-p105-provisionnement.md.
 */

export const MIGRATIONS_ASSISTEES = Object.freeze({
  '20261028120100_worker_identity_not_forgeable': Object.freeze({
    raison: 'CREATE ROLE tracefab_worker + transfert de propriete ; PostgreSQL 16+ exige SUPERUSER ou SET ROLE, impossible a un role de migration non superutilisateur',
    // Les deux branches de cette migration sont mesurément impossibles sans
    // SUPERUSER sur PostgreSQL 16+ :
    //   - role absent  -> ALTER FUNCTION ... OWNER TO tracefab_worker échoue en
    //                     42501 « must be able to SET ROLE "tracefab_worker" »
    //                     (le CREATE ROLE par un CREATEROLE ne donne que
    //                     ADMIN, set_option = false) ;
    //   - role présent -> ALTER ROLE ... NOSUPERUSER échoue en 42501
    //                     « Only roles with the SUPERUSER attribute may change
    //                     the SUPERUSER attribute ».
    // Le fichier n'est pas modifié : il est déjà appliqué en production, et
    // changer son contenu changerait son empreinte dans _prisma_migrations.
    // Deux effets de bord MESURES, qui doivent etre rattrapes juste apres :
    //   - la migration 20261028120200 appelle `tracefab_clerk_organization_uuid`,
    //     desormais possedee par `tracefab_worker` : sans appartenance, le role
    //     de migration recoit 42501 « permission denied for function » ;
    //   - les migrations ULTERIEURES doivent pouvoir modifier ces six fonctions,
    //     ce qui exige de pouvoir endosser leur proprietaire.
    // L'appartenance est accordée par le runner après le bootstrap, avec
    // INHERIT/SET et sans ADMIN, puis révoquée avant la migration terminale.
    // `tracefab_app` n'en hérite jamais.
    // Le runner accorde l'appartenance temporairement après ce bootstrap,
    // puis la révoque avant la migration terminale 20261108120700.
    // Aucun GRANT permanent n'est porté par cette configuration.
    appartenanceTemporaire: true,
    // `avant` : rendre la migration REJOUABLE dans le même cluster.
    //
    // Le corps de 20261028120100 fait, en § 6, `GRANT tracefab_worker TO
    // current_user`, puis transfère six fonctions, puis § 6 bis fait
    // `REVOKE tracefab_worker FROM current_user`. PostgreSQL refuse cette
    // révocation si le même grantor a accordé `tracefab_worker` à un AUTRE
    // rôle : 2BP01 « dependent privileges exist ». Or c'est exactement ce que
    // faisait le crochet post-migration permanent. Conséquence mesurée le 02/11 :
    // la chaîne s'appliquait une fois par cluster, puis toute nouvelle base
    // jetable échouait sur cette migration — les suites qui créent leur propre
    // base tombaient en cascade.
    //
    // On ramène donc l'état d'appartenance à celui d'avant la migration :
    // l'exécutant est le seul membre possible de `tracefab_worker`. La
    // migration ré-accorde elle-même ce dont elle a besoin ; le runner
    // n'accorde le droit temporaire qu'après son COMMIT.
    avant: {
      appartenance: 'tracefab_worker',
      conserver: '%ROLE%',
      // Bornage : on ne révoque que des rôles `tracefab_*`, plus les rôles
      // SUPERUSER (dont l'appartenance n'est pas une frontière de privilège).
      // Tout autre membre fait ÉCHOUER la préparation au lieu d'être retiré en
      // silence — voir `preparerAppartenance`.
      motifAutorise: '^tracefab_[a-z_]+$',
    },
    prerequisMesures: 'PostgreSQL 17.10, cluster jetable, 30/10/2026',
    effet: 'cree tracefab_worker (NOLOGIN, NOINHERIT, NOBYPASSRLS) et lui transfere la propriete de six fonctions SECURITY DEFINER',
  }),
});

/** Vrai si ce nom de migration exige l'exécutant administratif. */
export function exigeAssistance(nom) {
  return Object.prototype.hasOwnProperty.call(MIGRATIONS_ASSISTEES, nom);
}

/**
 * Prépare l'état d'appartenance attendu AVANT une migration assistée.
 *
 * POURQUOI CE N'EST PAS DANS LA MIGRATION
 *
 * Le corps de `20261028120100` est figé (déjà appliqué en production, et son
 * empreinte est enregistrée). Son § 6 accorde `tracefab_worker` à l'exécutant,
 * puis § 6 bis le révoque. PostgreSQL refuse cette révocation si le MÊME
 * grantor a accordé `tracefab_worker` à un autre rôle : `2BP01 dependent
 * privileges exist`. Or c'est exactement ce que produit le rattrapage `apres`
 * de l'exécution précédente — mesuré le 02/11 : la chaîne s'appliquait une
 * fois par cluster, puis toute nouvelle base jetable échouait là, et les
 * suites qui créent leur propre base tombaient en cascade.
 *
 * La correction est donc dans l'OUTIL qui applique la chaîne : il ramène
 * l'état à « aucun grantor résiduel vers un autre membre ». La migration
 * accorde/révoque sa propre appartenance dans sa transaction ; après son
 * COMMIT, le runner pose une appartenance temporaire sans ADMIN pour les
 * migrations suivantes, puis la retire avant la garde terminale.
 *
 * @param {import('pg').Client} db connexion qui applique la migration
 * @param {string} nomMigration nom du dossier de migration
 * @param {string} roleExecutant rôle qui exécute la chaîne
 * @returns {Promise<{revoques: string[]}>}
 * @throws si un membre hors périmètre (`tracefab_*`) est trouvé — on ne retire
 *         pas en silence une appartenance qu'on n'a pas accordée.
 */
export async function preparerAppartenance(db, nomMigration, roleExecutant) {
  const entree = MIGRATIONS_ASSISTEES[nomMigration];
  if (!entree || !entree.avant) return { revoques: [] };
  const { appartenance, conserver, motifAutorise } = entree.avant;
  const conserverNom = String(conserver).replace(/%ROLE%/g, roleExecutant);
  const motif = new RegExp(motifAutorise);
  const { rows } = await db.query(
    `SELECT r.rolname, r.rolsuper
       FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member
       JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
      WHERE c.rolname = $1 AND r.rolname <> $2
      ORDER BY 1`,
    [appartenance, conserverNom],
  );
  /*
   * QUI PEUT ÊTRE RETIRÉ SANS DÉCISION HUMAINE
   *
   *   - les rôles `tracefab_*` : c'est notre espace de noms ;
   *   - les rôles SUPERUSER : leur appartenance n'est pas une frontière de
   *     privilège — ils peuvent accorder et révoquer eux-mêmes tout ce que la
   *     base contient. Les retirer ne leur ôte aucune capacité ; les garder
   *     rendait la chaîne non rejouable dès qu'un cluster partagé avait reçu
   *     `apres` d'un exécutant DIFFÉRENT (mesuré le 02/11 : `postgres` membre
   *     de `tracefab_worker`, refus de préparation, chaîne arrêtée au rang 61).
   *
   * Tout autre rôle est ÉTRANGER : on s'arrête, on nomme, on ne révoque rien.
   * Un rôle ordinaire hérite, lui, de privilèges réels par cette appartenance :
   * le retirer sans décision serait une modification de sécurité silencieuse.
   */
  const membres = rows.map((r) => r.rolname);
  const etrangers = rows.filter((r) => !motif.test(r.rolname) && r.rolsuper !== true).map((r) => r.rolname);
  if (etrangers.length > 0) {
    throw new Error(`appartenance hors périmètre : ${etrangers.join(', ')} est membre de ${appartenance} `
      + `(attendu : tracefab_* ou un rôle SUPERUSER). Un administrateur doit trancher ; rien n'a été révoqué.`);
  }
  for (const membre of membres) {
    await db.query(`REVOKE ${appartenance} FROM ${membre}`);
  }
  return { revoques: membres };
}
