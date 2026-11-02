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
    apres: 'GRANT tracefab_worker TO %ROLE% WITH ADMIN OPTION, INHERIT TRUE, SET TRUE',
    prerequisMesures: 'PostgreSQL 17.10, cluster jetable, 30/10/2026',
    effet: 'cree tracefab_worker (NOLOGIN, NOINHERIT, NOBYPASSRLS) et lui transfere la propriete de six fonctions SECURITY DEFINER',
  }),
});

/** Vrai si ce nom de migration exige l'exécutant administratif. */
export function exigeAssistance(nom) {
  return Object.prototype.hasOwnProperty.call(MIGRATIONS_ASSISTEES, nom);
}
