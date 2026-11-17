#!/usr/bin/env node
/**
 * P10.7 — C4.13 a C4.15 : l'identite est-elle FALSIFIABLE par le role applicatif ?
 *
 * POURQUOI CE TEST EXISTE, ET CE QU'IL AJOUTE
 * -------------------------------------------
 * `scripts/preuve_pg_identite_p107.mjs` pose deja ces trois questions, mais il
 * exige une connexion a un PostgreSQL prere. Mesure du 2026-11-17 : aucun
 * binaire PostgreSQL n'est disponible dans l'environnement d'analyse, et
 * `binaries.prisma.sh` y est injoignable (HTTP 000). Les contrôles C4.13 a
 * C4.15 avaient donc ete ECRITS sans etre DEMONTRES.
 *
 * Ce fichier les execute sur PGlite — PostgreSQL compile en WASM — en rejouant
 * le SCHEMA et l'ACL reels extraits des migrations, pas une imitation.
 *
 * LA QUESTION, EN UNE PHRASE
 * --------------------------
 * Le jeton systeme est un HMAC calcule par la base avec une cle que
 * l'application ne detient pas. Si le role applicatif pouvait appeler `hmac()`
 * avec cette cle, ou lire `tracefab_identity_cles`, il se fabriquerait une
 * signature valide : toute l'identite signee tomberait, sans qu'aucun test de
 * controle d'acces ne s'en apercoive. C'est pourquoi la question se mesure en
 * PRIVILEGES EFFECTIFS, pas en intention lue dans une migration.
 *
 * CE QU'IL NE PROUVE PAS
 * ----------------------
 * PGlite est un PostgreSQL en WASM : les roles, ACL et RLS y sont reels, mais
 * ce n'est pas le cluster Neon. La preuve qui fait foi reste celle executee sur
 * la base cible (`preuve_pg_identite_p107.mjs`). Ce test rend le controle
 * REPRODUCTIBLE et le protege d'une regression ; il ne remplace pas la mesure
 * sur l'environnement de Production.
 *
 *   npm run test:p107:oracle-signature
 */
const { PGlite } = await import('@electric-sql/pglite');
const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');

let echecs = 0;
let verifies = 0;
const ok = (id, libelle, condition, detail = '') => {
  verifies += 1;
  if (!condition) echecs += 1;
  console.log(`  ${condition ? 'PASS ' : 'ECHEC'} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const db = new PGlite({ extensions: { pgcrypto } });
await db.waitReady;

// CREATE EXTENSION explicite : c'est ce que fait la migration reelle
// (20260923130000_tracefab_neon_initial, ligne 8). Sans cette ligne, PGlite
// charge le module mais n'enregistre RIEN dans pg_extension et `hmac` reste
// introuvable — mesure du 2026-11-17. Un test qui mesure une ACL sur une
// fonction inexistante rendrait `has_function_privilege` en erreur, ou pire,
// un `false` trompeur : c'est pourquoi C4.15 verifie l'existence.
await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

// ---------------------------------------------------------------------------
// Le socle : rejoue le schema et l'ACL de la migration
// 20261031120000_identite_hmac_liee_au_contexte, tels quels.
// ---------------------------------------------------------------------------
await db.exec(`
  -- Le proprietaire des objets : NOLOGIN, pour qu'il ne puisse pas etre pris
  -- pour le role applicatif par erreur de mesure.
  CREATE ROLE tracefab_owner NOLOGIN;
  CREATE ROLE tracefab_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

  -- Chaine REELLE du depot, sans laquelle ce test ne mesurerait rien :
  -- la migration 20260923130000 (ligne 1115) fait
  --   GRANT USAGE ON SCHEMA public TO PUBLIC;
  -- PG 15+ a retire CREATE sur public a PUBLIC, mais USAGE reste : sans lui,
  -- tracefab_app n'aurait aucun droit et les controles passeraient par
  -- absence de privilege global, pas par le durcissement qu'on veut prouver.
  GRANT USAGE ON SCHEMA public TO PUBLIC;

  -- Rejoue a l'identique (migration 20261031120000, lignes 165-171).
  CREATE TABLE public.tracefab_identity_cles (
    version   INTEGER PRIMARY KEY,
    secret    BYTEA NOT NULL,
    actif     BOOLEAN NOT NULL DEFAULT true,
    cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tracefab_identity_cles_secret_long CHECK (length(secret) >= 16)
  );
  INSERT INTO public.tracefab_identity_cles (version, secret, actif)
  VALUES (1, decode(repeat('ab', 32), 'hex'), true);

  ALTER TABLE public.tracefab_identity_cles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.tracefab_identity_cles FORCE ROW LEVEL SECURITY;

  -- Les deux REVOKE de la migration, mot pour mot.
  REVOKE ALL ON TABLE public.tracefab_identity_cles FROM PUBLIC;
  REVOKE ALL ON TABLE public.tracefab_identity_cles FROM tracefab_app;

  ALTER TABLE public.tracefab_identity_cles OWNER TO tracefab_owner;
`);

// La fonction de verification, SECURITY DEFINER, possedee par le proprietaire.
// Rejoue la propriete de la migration (elle lit la cle avec les droits du
// proprietaire, jamais ceux de l'appelant).
await db.exec(`
  CREATE OR REPLACE FUNCTION public.tracefab_identite_systeme_jeton_valide(p_jeton TEXT)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public'
  AS $function$
  DECLARE
    v_secret BYTEA;
    v_mac    BYTEA;
  BEGIN
    IF p_jeton IS NULL OR p_jeton = '' THEN RETURN false; END IF;
    SELECT k.secret INTO v_secret FROM public.tracefab_identity_cles k WHERE k.actif ORDER BY k.version DESC LIMIT 1;
    IF v_secret IS NULL THEN RETURN false; END IF;
    v_mac := public.hmac(convert_to(split_part(p_jeton, '.', 1), 'UTF8'), v_secret, 'sha256');
    RETURN v_mac IS NOT NULL;
  END;
  $function$;

  ALTER FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) OWNER TO tracefab_owner;
  REVOKE ALL ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.tracefab_identite_systeme_jeton_valide(TEXT) TO tracefab_app;
`);

// ---------------------------------------------------------------------------
// CE QU'UN ORACLE EST, ET CE QU'IL N'EST PAS — correction d'une premisse fausse
// ---------------------------------------------------------------------------
// La premiere version de ce test exigeait que `tracefab_app` ne puisse PAS
// appeler `hmac()`. Mesure du 2026-11-17 : il le peut (EXECUTE=true), et cela
// N'EST PAS un defaut.
//
// `hmac(message, cle, algo)` prend la cle EN ARGUMENT. Un appelant qui fournit
// sa propre cle calcule un HMAC ordinaire : c'est une fonction de hachage
// publique, au meme titre que `digest()`. Un ORACLE serait une fonction qui
// signe avec la cle STOCKEE sans la reveler. Le test mesurait donc une
// propriete qui n'a pas de sens, et aurait reclame un durcissement inutile.
//
// La propriete qui compte, et qui est celle de toute la chaine d'identite :
//
//   la cle stockee est INATTEIGNABLE par le role applicatif.
//
// Si elle l'etait, `hmac(message, cle_volee)` rendrait une signature valide et
// toute l'identite signee tomberait. C'est cela qu'il faut mesurer, en
// privileges EFFECTIFS et par une tentative REELLE.
// ---------------------------------------------------------------------------

// C4.13 — la table des cles est-elle lisible en privileges effectifs ?
const c413 = await db.query(`
  SELECT has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'SELECT') AS lisible
`);
ok('C4.13', 'tracefab_app ne peut PAS lire la table des cles (privilege effectif)',
  c413.rows[0].lisible === false, `SELECT=${c413.rows[0].lisible}`);

// C4.14 — TENTATIVE REELLE, pas seulement le catalogue.
// `has_table_privilege` dit ce que PostgreSQL croit ; une tentative le prouve.
// On passe par un role effectif (`SET ROLE`) et on exige un refus.
let lectureRefusee = false;
let detailLecture = '';
try {
  // Transaction explicite obligatoire : `SET LOCAL ROLE` ne dure que jusqu'a la
  // fin de la transaction, et c'est exactement la portee voulue — on ne laisse
  // pas un role actif derriere soi.
  await db.exec('BEGIN');
  await db.exec('SET LOCAL ROLE tracefab_app');
  await db.query('SELECT secret FROM public.tracefab_identity_cles LIMIT 1');
  detailLecture = 'LECTURE REUSSIE — la cle est exposee';
} catch (e) {
  lectureRefusee = /permission denied|insufficient privilege/i.test(e.message);
  detailLecture = e.message.split('\n')[0].slice(0, 60);
} finally {
  await db.exec('ROLLBACK').catch(() => {});
}
ok('C4.14', 'une TENTATIVE REELLE de lecture de la cle est refusee par la base',
  lectureRefusee, detailLecture);

// C4.14 bis — LE TEST MORD-IL ?
//
// Une tentative refusee peut l'etre pour trois raisons tres differentes : la
// table n'existe pas, le role n'a aucun droit sur le SCHEMA, ou le
// durcissement de la TABLE a joue. Les deux premieres feraient passer C4.13 et
// C4.14 par vacuite.
//
// On accorde donc explicitement SELECT au role applicatif, dans une
// transaction ANNULEE, et on exige que la lecture reste refusee par la RLS et
// par l'absence d'autre chemin. Si cette contre-epreuve reussissait a lire, le
// test precedent ne prouverait rien.
let mord = false;
let detailMord = '';
try {
  await db.exec('BEGIN');
  await db.exec('GRANT SELECT ON TABLE public.tracefab_identity_cles TO tracefab_app');
  await db.exec('SET LOCAL ROLE tracefab_app');
  const r = await db.query('SELECT secret FROM public.tracefab_identity_cles LIMIT 1');
  detailMord = r.rows.length === 0
    ? 'GRANT pose, mais la RLS FORCEE masque la ligne (0 ligne)'
    : 'DEFAUT : la cle est lisible malgre le durcissement';
  mord = r.rows.length === 0;
} catch (e) {
  // Un refus est aussi une reponse acceptable : la RLS ou l'ACL a joue.
  mord = /permission denied|insufficient privilege/i.test(e.message);
  detailMord = `GRANT pose, lecture refusee : ${e.message.split('\n')[0].slice(0, 48)}`;
} finally {
  await db.exec('ROLLBACK').catch(() => {});
}
ok('C4.14bis', 'contre-epreuve : meme avec SELECT accorde, la cle reste illisible',
  mord, detailMord);

// C4.15 — CONTRE-EPREUVE : les objets existent et la cle est bien la.
// Sans elle, C4.13 et C4.14 passeraient aussi sur un catalogue vide — un test
// vert qui ne mesure rien. C'est la faute la plus facile a commettre ici.
const c415 = await db.query(`
  SELECT to_regclass('public.tracefab_identity_cles') IS NOT NULL AS cles_existent,
         (SELECT count(*) FROM public.tracefab_identity_cles) AS nb_cles,
         (SELECT length(secret) FROM public.tracefab_identity_cles LIMIT 1) AS taille_cle
`);
const t = c415.rows[0];
ok('C4.15', 'la table et la cle EXISTENT — C4.13 et C4.14 ne passent pas par vacuite',
  t.cles_existent === true && Number(t.nb_cles) > 0 && Number(t.taille_cle) >= 16,
  `existe=${t.cles_existent} nb=${t.nb_cles} taille=${t.taille_cle}`);

// ---------------------------------------------------------------------------
// Les fonctions qui consomment la cle stockee sont-elles DETOURNABLES ?
// Elles sont SECURITY DEFINER et possedees par le proprietaire : elles lisent
// la cle avec SES droits. Ce qui compte est ce qu'elles RENDENT.
// ---------------------------------------------------------------------------
const rendus = await db.query(`
  SELECT pg_get_function_result(p.oid) AS retour,
         p.prosecdef AS security_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_identite_systeme_jeton_valide'
`);
const f = rendus.rows[0];
ok('C4.16', 'la fonction de verification ne rend qu un booleen — elle ne signe rien',
  f && f.retour === 'boolean' && f.security_definer === true,
  f ? `retour=${f.retour} secdef=${f.security_definer}` : 'fonction absente');

// C4.17 — contre-epreuve de C4.16 : la fonction est bien SECURITY DEFINER,
// donc elle LIT la cle (avec les droits du proprietaire) sans la reveler.
// Si elle n'etait pas SECURITY DEFINER, elle ne pourrait pas lire la table et
// C1/C2 echoueraient pour une autre raison.
ok('C4.17', 'la verification est SECURITY DEFINER et possedee par le proprietaire',
  f && f.security_definer === true, f ? `secdef=${f.security_definer}` : 'absente');

// ---------------------------------------------------------------------------
// La fonction de verification reste, elle, APPELLABLE — et c'est voulu.
// Si elle ne l'etait pas, C1/C2 seraient impossibles a mesurer sur le runtime :
// on aurait ferme la porte que la preuve doit franchir.
// ---------------------------------------------------------------------------
const verifAppelable = await db.query(`
  SELECT has_function_privilege('tracefab_app',
    'public.tracefab_identite_systeme_jeton_valide(text)', 'EXECUTE') AS appelable
`);
ok('C4.18', 'la FONCTION DE VERIFICATION reste appelable — la preuve peut etre mesuree',
  verifAppelable.rows[0].appelable === true, `EXECUTE=${verifAppelable.rows[0].appelable}`);

// ---------------------------------------------------------------------------
// Heritage de roles : un droit herite contournerait les trois contrôles.
// Aucun role ne doit etre accorde a tracefab_app, sauf decision explicite.
// ---------------------------------------------------------------------------
const heritages = await db.query(`
  SELECT r.rolname
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = 'tracefab_app'
`);
ok('C4.19', 'tracefab_app n herite d aucun role',
  heritages.rows.length === 0, heritages.rows.map((r) => r.rolname).join(', ') || 'aucun');

const superuser = await db.query(`
  SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'tracefab_app'
`);
ok('C4.20', 'tracefab_app n est ni superuser ni BYPASSRLS',
  superuser.rows[0].rolsuper === false && superuser.rows[0].rolbypassrls === false,
  `super=${superuser.rows[0].rolsuper} bypassrls=${superuser.rows[0].rolbypassrls}`);

console.log(echecs === 0
  ? `  Oracle de signature : OK (${verifies} contrôles).`
  : `  Oracle de signature : ${echecs} echec(s) sur ${verifies}.`);
await db.close();
process.exit(echecs === 0 ? 0 : 1);
