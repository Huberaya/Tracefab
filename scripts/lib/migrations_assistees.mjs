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
    // L'appartenance ci-dessous est la plus petite qui reponde aux deux, et
    // elle est verifiee par un test d'escalade : `tracefab_app` n'en herite
    // jamais (elle n'est membre de rien).
    // `apres` sans ADMIN OPTION (P10.6). Mesure du 02/11 : `INHERIT TRUE,
    // SET TRUE` suffit à `SET ROLE tracefab_worker` ET à
    // `ALTER ... OWNER TO tracefab_worker` ; ADMIN n'était pas nécessaire et
    // élargissait le rôle de migration au-delà du besoin (il pouvait
    // re-accorder `tracefab_worker` à n'importe qui).
    apres: 'GRANT tracefab_worker TO %ROLE% WITH INHERIT TRUE, SET TRUE',
    // `avant` : rendre la migration REJOUABLE dans le même cluster.
    //
    // Le corps de 20261028120100 fait, en § 6, `GRANT tracefab_worker TO
    // current_user`, puis transfère six fonctions, puis § 6 bis fait
    // `REVOKE tracefab_worker FROM current_user`. PostgreSQL refuse cette
    // révocation si le même grantor a accordé `tracefab_worker` à un AUTRE
    // rôle : 2BP01 « dependent privileges exist ». Or c'est exactement ce que
    // fait `apres` à l'exécution précédente. Conséquence mesurée le 02/11 :
    // la chaîne s'appliquait une fois par cluster, puis toute nouvelle base
    // jetable échouait sur cette migration — les suites qui créent leur propre
    // base tombaient en cascade.
    //
    // On ramène donc l'état d'appartenance à celui d'avant la migration :
    // l'exécutant est le seul membre possible de `tracefab_worker`. La
    // migration ré-accorde elle-même ce dont elle a besoin, et `apres` le
    // rétablit ensuite.
    avant: {
      appartenance: 'tracefab_worker',
      conserver: '%ROLE%',
      // Bornage : on ne révoque que des rôles `tracefab_*`. Un membre étranger
      // fait ÉCHOUER la préparation au lieu d'être retiré en silence.
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
 * l'état à « seul l'exécutant peut être membre », la migration ré-accorde ce
 * dont elle a besoin, puis `apres` rétablit le droit final.
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
    `SELECT r.rolname
       FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member
       JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
      WHERE c.rolname = $1 AND r.rolname <> $2
      ORDER BY 1`,
    [appartenance, conserverNom],
  );
  const membres = rows.map((r) => r.rolname);
  const etrangers = membres.filter((n) => !motif.test(n));
  if (etrangers.length > 0) {
    throw new Error(`appartenance hors périmètre : ${etrangers.join(', ')} est membre de ${appartenance} `
      + `(attendu : uniquement tracefab_*). Un administrateur doit trancher ; rien n'a été révoqué.`);
  }
  for (const membre of membres) {
    await db.query(`REVOKE ${appartenance} FROM ${membre}`);
  }
  return { revoques: membres };
}
