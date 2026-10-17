#!/usr/bin/env node
/**
 * Cycle de vie documentaire — preuve par exécution sur PostgreSQL jetable.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * Deux défauts confirmés sur la chaîne appliquée (2026-10-17, PG17 jetable) :
 *
 *  1. `documents_select_authorized` exigeait `tracefab_can_access_document`,
 *     qui n'ouvre que le statut `available`. Un document `uploaded`,
 *     `scanning` ou `rejected` était donc invisible pour TOUT LE MONDE, y
 *     compris son propriétaire : le scan était impossible et les documents
 *     restaient bloqués indéfiniment.
 *  2. `tracefab_finalize_document_upload` n'autorisait personne : toute
 *     session pouvant l'exécuter basculait n'importe quel document en
 *     `available` avec un sha256 de son choix.
 *
 * CE QU'IL VÉRIFIE
 *   1. le propriétaire lit ses documents dans les états uploaded/scanning ;
 *   2. un autre locataire ne les lit pas ;
 *   3. la finalisation par un utilisateur sans rôle sur l'organisation est
 *      refusée (document_scan_role_required) ;
 *   4. la finalisation par un autre locataire est refusée ;
 *   5. sans contexte utilisateur, un rôle applicatif ne peut pas finaliser
 *      (document_scan_actor_required) ;
 *   6. scan_passed=false bascule en rejected, scan_passed=true en available
 *      avec sha256 et available_at ;
 *   7. un document rejected n'est pas re-finalisable.
 *
 * Il ne passe pas quand il ne peut pas s'exécuter : sans DATABASE_URL et
 * TF_RLS_APP_URL, sortie 2.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: false } : false,
});

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const expectError = async (fn, expected, message) => {
  try {
    await fn();
    ko(`${message} — aucune erreur levée`);
  } catch (e) {
    if (String(e.message).includes(expected)) ok(message);
    else ko(`${message} — erreur inattendue : ${e.message}`);
  }
};

const suffixe = randomUUID().slice(0, 8);
const userA = randomUUID(); const userB = randomUUID();
const orgA = randomUUID(); const orgB = randomUUID();

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

try {
  /* --- fixture : deux locataires, un document en attente chez A --- */
  await proprio.query(
    `INSERT INTO users (id, clerk_user_id, email, full_name) VALUES
       ($1, $3, $4, 'Doc Life A'), ($2, $5, $6, 'Doc Life B')`,
    [userA, userB, `dl_a_${suffixe}`, `dl-a-${suffixe}@example.test`,
     `dl_b_${suffixe}`, `dl-b-${suffixe}@example.test`]);
  await proprio.query(
    `INSERT INTO organizations (id, type, legal_name, display_name, status, created_by) VALUES
       ($1, 'brand', 'DocLife A', 'DL A', 'active', $3),
       ($2, 'brand', 'DocLife B', 'DL B', 'active', $4)`,
    [orgA, orgB, userA, userB]);
  await proprio.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES
       ($1, $3, 'owner', 'active'), ($2, $4, 'owner', 'active')`,
    [orgA, orgB, userA, userB]);

  const docA = randomUUID();
  const pathA = `${orgA}/uploads/doc-${suffixe}.pdf`;
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'attestation.pdf', 'application/pdf',
       2048, 'certificate', 'uploaded', 'private', $4)`,
    [docA, orgA, pathA, userA]);

  const docClean = randomUUID();
  const docDirty = randomUUID();
  const docScanning = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'clean.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4),
     ($5, $2, 'tracefab-private', $6, 'dirty.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4),
     ($7, $2, 'tracefab-private', $8, 'scanning.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docClean, orgA, `${orgA}/uploads/clean-${suffixe}.pdf`, userA,
     docDirty, `${orgA}/uploads/dirty-${suffixe}.pdf`,
     docScanning, `${orgA}/uploads/scanning-${suffixe}.pdf`]);
  // docScanning passe en `scanning` via le canal interne (comme le scan le fait).
  // is_local=false : chaque query de node-pg est une transaction autocommit,
  // un flag transactionnel ne survivrait pas a la requete qui le pose.
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'true', false)`);
  await proprio.query(`UPDATE documents SET status = 'scanning' WHERE id = $1`, [docScanning]);
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'false', false)`);

  /* --- 1-2. visibilite des metadonnees selon l'etat --- */
  await app.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userA]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, false)`, [`dl-a-${suffixe}@example.test`]);
  const vuA = await app.query('SELECT id, status FROM documents WHERE id = $1', [docA]);
  if (vuA.rowCount === 1 && vuA.rows[0].status === 'uploaded') {
    ok('le propriétaire lit son document en état uploaded');
  } else {
    ko(`propriétaire : document uploaded invisible (rowCount=${vuA.rowCount}) — RLS trop restrictive`);
  }
  const vuScan = await app.query('SELECT id FROM documents WHERE id = $1', [docScanning]);
  if (vuScan.rowCount === 1) ok('le propriétaire lit son document en état scanning');
  else ko('propriétaire : document scanning invisible — reprise de scan impossible');

  await app.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userB]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, false)`, [`dl-b-${suffixe}@example.test`]);
  const vuB = await app.query('SELECT id FROM documents WHERE id = $1', [docA]);
  if (vuB.rowCount === 0) ok("un autre locataire ne lit pas le document de A");
  else ko('un autre locataire lit le document de A — fuite inter-locataires');

  /* --- 3-5. autorisation de finalisation --- */
  // Le contexte applicatif est encore celui de B (sans role sur orgA).
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('a', 64), true, 2048::bigint)`,
      [docA]),
    'document_scan_role_required',
    'finalisation cross-locataire / sans rôle refusée');

  await app.query(`SELECT set_config('tracefab.user_id', '', false)`);
  await app.query(`SELECT set_config('tracefab.user_email', '', false)`);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('a', 64), true, 2048::bigint)`,
      [docA]),
    'document_scan_actor_required',
    'finalisation sans contexte utilisateur par le rôle applicatif refusée');

  /* --- 6. verdicts fail-closed --- */
  await app.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userA]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, false)`, [`dl-a-${suffixe}@example.test`]);

  const rej = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, '', false, 2048::bigint)`, [docA]);
  if (rej.rows[0].status === 'rejected') ok('scan_passed=false bascule en rejected (fail-closed)');
  else ko(`scan_passed=false donne ${rej.rows[0].status}`);

  const clean = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('b', 64), true, 1024::bigint)`, [docClean]);
  if (clean.rows[0].status === 'available' && clean.rows[0].sha256 === 'b'.repeat(64) && clean.rows[0].available_at) {
    ok('scan_passed=true bascule en available avec sha256 et available_at');
  } else {
    ko(`finalisation saine inattendue : ${clean.rows[0].status}`);
  }

  const dirty = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, '', false, 1024::bigint)`, [docDirty]);
  if (dirty.rows[0].status === 'rejected') ok('un verdict infecté bascule en rejected');
  else ko(`verdict infecté donne ${dirty.rows[0].status}`);

  /* --- 7. pas de re-finalisation --- */
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('c', 64), true, 2048::bigint)`,
      [docA]),
    'document_not_in_scannable_state',
    'un document rejected n est pas re-finalisable');

  /* --- 8. sha256 : format hexadecimal strict (non-regression 2C.38) --- */
  await app.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userA]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, false)`, [`dl-a-${suffixe}@example.test`]);
  const docHash = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'hash.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docHash, orgA, `${orgA}/uploads/hash-${suffixe}.pdf`, userA]);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('z', 64), true, 1024::bigint)`,
      [docHash]),
    'sha256_required_for_available_document',
    'une empreinte 64 caracteres non hexadecimale ne donne jamais available');
  const docHex = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'hex.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docHex, orgA, `${orgA}/uploads/hex-${suffixe}.pdf`, userA]);
  const maj = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('A', 64), true, 1024::bigint)`,
    [docHex]);
  if (maj.rows[0].status === 'available' && maj.rows[0].sha256 === 'a'.repeat(64)) {
    ok('une empreinte hexadecimale valide passe, stockee en minuscules canoniques');
  } else {
    ko(`empreinte hex valide : statut=${maj.rows[0].status} sha256=${maj.rows[0].sha256}`);
  }

  /* --- 8b. taille reelle du document : borne de 50 Mio (52428800 octets) ---
   *
   * La limite etait posee dans la fonction (p_actual_byte_size > 52428800) mais
   * aucune assertion ne la tenait : un glissement d'un octet, un passage de
   * 50 Mio a 50 Mo decimaux, ou la suppression pure et simple du controle
   * seraient passes inapercus. Trois points sont epingles : juste au-dessus de
   * la borne (refus), taille negative (refus — un BIGINT signe accepte -1), et
   * la borne elle-meme (acceptee : la limite est INCLUSIVE, ce que le texte de
   * l'exception ne dit pas et qu'un futur refactor pourrait inverser).
   */
  const LIMITE = 52428800; // 50 * 1024 * 1024
  const docTaille = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'taille.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docTaille, orgA, `${orgA}/uploads/taille-${suffixe}.pdf`, userA]);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('e', 64), true, $2::bigint)`,
      [docTaille, LIMITE + 1]),
    'document_size_limit_exceeded',
    `une taille au-dessus de 50 Mio (${LIMITE + 1} o) est refusee`);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('e', 64), true, (-1)::bigint)`,
      [docTaille]),
    'document_size_limit_exceeded',
    'une taille negative est refusee (BIGINT signe, pas de controle implicite)');
  // Le refus precedent a interrompu sa transaction : le document doit etre
  // intact, sinon la borne serait testee sur un etat deja corrompu.
  const intact = await app.query(`SELECT status FROM documents WHERE id = $1`, [docTaille]);
  if (intact.rows[0]?.status === 'uploaded') ok('apres un refus de taille, le document reste uploaded');
  else ko(`apres un refus de taille : statut=${intact.rows[0]?.status}, attendu uploaded`);
  const aBorne = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('e', 64), true, $2::bigint)`,
    [docTaille, LIMITE]);
  if (aBorne.rows[0].status === 'available' && String(aBorne.rows[0].byte_size) === String(LIMITE)) {
    ok(`la borne de 50 Mio est INCLUSIVE : ${LIMITE} o passent et sont stockes`);
  } else {
    ko(`borne 50 Mio : statut=${aBorne.rows[0].status} byte_size=${aBorne.rows[0].byte_size}`);
  }

  /* --- 8c. transaction interrompue : aucun effet partiel, aucun GUC residuel ---
   *
   * La fonction pose set_config('tracefab.internal_document_update', 'true',
   * true) pour franchir la barriere d'ecriture interne, puis le remet a
   * 'false'. Si l'appelant annule sa transaction, ni le changement de statut ni
   * le drapeau interne ne doivent survivre : un pool de connexions reutilise
   * heriterait sinon d'un canal d'ecriture interne ouvert.
   */
  const docAnnule = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'annule.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docAnnule, orgA, `${orgA}/uploads/annule-${suffixe}.pdf`, userA]);
  await app.query('BEGIN');
  const avantAnnulation = await app.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('f', 64), true, 1024::bigint)`,
    [docAnnule]);
  if (avantAnnulation.rows[0].status !== 'available') {
    ko(`avant ROLLBACK : statut=${avantAnnulation.rows[0].status}, attendu available`);
  }
  await app.query('ROLLBACK');
  const apresAnnulation = await app.query(`SELECT status, sha256 FROM documents WHERE id = $1`, [docAnnule]);
  if (apresAnnulation.rows[0]?.status === 'uploaded' && apresAnnulation.rows[0]?.sha256 === null) {
    ok('une transaction annulee ne laisse ni statut ni empreinte : le document reste uploaded');
  } else {
    ko(`apres ROLLBACK : statut=${apresAnnulation.rows[0]?.status} sha256=${apresAnnulation.rows[0]?.sha256}`);
  }
  const gucResiduel = (await app.query(
    `SELECT current_setting('tracefab.internal_document_update', true) AS v`)).rows[0].v;
  if (gucResiduel !== 'true') ok("le drapeau d'ecriture interne ne survit pas a la transaction annulee");
  else ko("le drapeau d'ecriture interne a survecu au ROLLBACK — canal d'ecriture interne ouvert");

  /* --- 8d. fonction appelee deux fois sur un document deja disponible --- */
  // Le cas `rejected` etait couvert (7). Le cas `available` ne l'etait pas :
  // une seconde finalisation pourrait reposer available_at et ecraser une
  // empreinte deja publiee, ce qui falsifierait le releve d'integrite.
  const premiere = await app.query(`SELECT sha256, available_at FROM documents WHERE id = $1`, [docTaille]);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('0', 64), true, 1024::bigint)`,
      [docTaille]),
    'document_not_in_scannable_state',
    'un document deja available n est pas re-finalisable');
  const inchange = await app.query(`SELECT sha256, available_at FROM documents WHERE id = $1`, [docTaille]);
  if (inchange.rows[0].sha256 === premiere.rows[0].sha256
      && String(inchange.rows[0].available_at) === String(premiere.rows[0].available_at)) {
    ok('un appel refuse ne modifie ni empreinte ni available_at');
  } else {
    ko(`empreinte/date modifiees par un appel refuse : ${inchange.rows[0].sha256} vs ${premiere.rows[0].sha256}`);
  }

  /* --- 9. controle acteur : privilege reel, pas session_user <> current_user --- */
  // Reproduction du defaut (2C.38) : rendre le role applicatif proprietaire
  // de la fonction ne doit JAMAIS lui ouvrir le chemin d'exploitation.
  // Avant le correctif, l'appel sans contexte franchissait le controle acteur
  // (il n'etait arrete que par la RLS, document_not_found).
  const proprietaire = (await proprio.query(
    `SELECT pg_get_userbyid(proowner) AS o FROM pg_proc
     WHERE proname = 'tracefab_finalize_document_upload'`)).rows[0].o;
  await proprio.query(
    `ALTER FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) OWNER TO tracefab_app`);
  await app.query(`SELECT set_config('tracefab.user_id', '', false)`);
  await app.query(`SELECT set_config('tracefab.user_email', '', false)`);
  await expectError(
    () => app.query(
      `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('d', 64), true, 1024::bigint)`,
      [docHash]),
    'document_scan_actor_required',
    'proprietaire de fonction = role applicatif : le chemin exploitation reste ferme');
  // Restauration complete : proprietaire ET privilege EXECUTE du role applicatif
  // (ALTER OWNER reecrit l'ACL et perd les grants).
  const cible = proprietaire === 'postgres' ? 'postgres' : `"${proprietaire}"`;
  await proprio.query(
    `ALTER FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) OWNER TO ${cible}`);
  await proprio.query(
    `GRANT EXECUTE ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) TO tracefab_app`);

  // Le chemin exploitation lui-meme reste utilisable par le proprietaire
  // (classe DBA), sans contexte utilisateur.
  const docOps = randomUUID();
  await proprio.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, kind, status, visibility, uploaded_by)
     VALUES ($1, $2, 'tracefab-private', $3, 'ops.pdf', 'application/pdf',
       1024, 'other', 'uploaded', 'private', $4)`,
    [docOps, orgA, `${orgA}/uploads/ops-${suffixe}.pdf`, userA]);
  await proprio.query(`SELECT set_config('tracefab.user_id', '', false)`);
  const ops = await proprio.query(
    `SELECT * FROM tracefab_finalize_document_upload($1::uuid, repeat('e', 64), true, 1024::bigint)`,
    [docOps]);
  if (ops.rows[0].status === 'available') ok('le proprietaire finalise sans contexte (chemin exploitation preserve)');
  else ko(`chemin exploitation : statut inattendu ${ops.rows[0].status}`);

  /* --- 10. ACL de la finalisation (non-regression 2C.38) --- */
  const acl = (await proprio.query(
    `SELECT has_function_privilege('public', 'tracefab_finalize_document_upload(uuid,text,boolean,bigint)', 'EXECUTE') AS pub,
            has_function_privilege('tracefab_app', 'tracefab_finalize_document_upload(uuid,text,boolean,bigint)', 'EXECUTE') AS app,
            has_table_privilege('tracefab_app', 'documents', 'TRUNCATE') AS app_truncate,
            has_table_privilege(current_user, 'documents', 'TRUNCATE') AS proprio_truncate`)).rows[0];
  if (acl.pub === false) ok('EXECUTE de la finalisation non accorde a PUBLIC');
  else ko('PUBLIC peut executer la finalisation');
  if (acl.app === true) ok('EXECUTE accorde au role applicatif (parcours de scan)');
  else ko('le role applicatif ne peut plus executer la finalisation — parcours de scan casse');
  if (acl.app_truncate === false) ok('le role applicatif ne detient pas TRUNCATE sur documents (voie exploitation fermee)');
  else ko('le role applicatif detient TRUNCATE sur documents — preuve de privilege trafiquee');
  if (acl.proprio_truncate === true) ok('le proprietaire detient TRUNCATE (chemin exploitation utilisable en exploitation)');
  else ko('le proprietaire ne detient pas TRUNCATE — le chemin exploitation serait inutilisable');

  /* --- les documents de A restent invisibles pour B après finalisation --- */
  await app.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userB]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, false)`, [`dl-b-${suffixe}@example.test`]);
  const cache = await app.query('SELECT id FROM documents WHERE owner_organization_id = $1', [orgA]);
  if (cache.rowCount === 0) ok('aucun document de A visible pour B, tout état confondu');
  else ko(`B voit ${cache.rowCount} document(s) de A`);

  /* --- nettoyage de la fixture --- */
  try {
    await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'true', false)`);
    await proprio.query('DELETE FROM documents WHERE owner_organization_id = ANY($1::uuid[])', [`{${orgA},${orgB}}`]);
    await proprio.query('DELETE FROM organization_memberships WHERE organization_id = ANY($1::uuid[])', [`{${orgA},${orgB}}`]);
    await proprio.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [`{${orgA},${orgB}}`]);
    await proprio.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [`{${userA},${userB}}`]);
  } catch (e) {
    console.log(`  note  nettoyage fixture incomplet : ${e.message}`);
  }
} finally {
  await app.end();
  await proprio.end();
}

if (echecs) {
  console.log(`\n  Cycle documentaire : ${echecs} échec(s).`);
  process.exit(1);
}
console.log('\n  Cycle documentaire : visibilité propriétaire, rôles de finalisation et fail-closed prouvés par exécution.');
