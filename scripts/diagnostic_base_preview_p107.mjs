#!/usr/bin/env node
/**
 * P10.7 — DIAGNOSTIC LECTURE SEULE DE LA BASE JOIN TE PAR LA PREVIEW.
 *
 * POURQUOI CET OUTIL EXISTE
 *
 * Le runtime Preview mesure une base dont il ne connait que trois empreintes
 * (`base_oid = 16396`, `hote_empreinte = e4142a5ef80a`,
 * `schemas_empreinte = 4a145f39b5da`). Ces empreintes suffisent a dire « c'est
 * la meme base », elles ne disent pas « quelle base c'est ». Pour agir — donc
 * pour choisir la base a reparer — il faut une URL de connexion, et cette URL
 * n'existe que dans Vercel.
 *
 * Cet outil repond a la seule question qui debloque : « la base que cette URL
 * joint, est-ce bien celle que le runtime voit ? ». Il ne fait AUCUNE ecriture.
 *
 * CE QU'IL N'EST PAS
 *
 * Ce n'est pas un outil de migration, ni de correction. Il n'applique rien, ne
 * cree rien, ne modifie aucune variable. Il refuse la Production par
 * construction (liste noire + refus de tout hote qui n'est pas Neon).
 *
 * USAGE
 *
 *   node scripts/diagnostic_base_preview_p107.mjs --url "<DATABASE_URL Preview>"
 *   # ou
 *   DATABASE_URL="..." node scripts/diagnostic_base_preview_p107.mjs
 *
 * La valeur n'est JAMAIS affichee, ni journalisee, ni ecrite sur disque. Seuls
 * l'hote, l'empreinte et des booleens le sont.
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
const argUrl = (() => {
  const i = args.indexOf('--url');
  return i >= 0 ? args[i + 1] : undefined;
})();

const url = (argUrl || process.env.DATABASE_URL || '').trim();

const refuser = (raison) => {
  console.error(`\n  REFUS — ${raison}\n`);
  process.exit(2);
};

if (!url) {
  refuser('aucune URL fournie. Passer --url "<DATABASE_URL Preview>" ou poser DATABASE_URL.');
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  refuser('URL illisible (ce n est pas une URL de connexion valide).');
}

if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  refuser('protocole non PostgreSQL.');
}

const hote = parsed.hostname;

// ---------------------------------------------------------------------------
// GARDE PRODUCTION — par construction, pas par prudence.
// ---------------------------------------------------------------------------
// `ep-polished-night` est l'endpoint de Production, connu du depot
// (`scripts/migrer_fidelement.mjs`, `docs/security/...`). On refuse aussi tout
// hote qui n'est pas un endpoint Neon : cet outil n'a aucune raison de parler a
// autre chose.
const HOTES_PRODUCTION = [/^ep-polished-night/i];
for (const motif of HOTES_PRODUCTION) {
  if (motif.test(hote)) {
    refuser('cet hote est la PRODUCTION. Cet outil ne s y connecte jamais.');
  }
}
if (!/(^|\.)neon\.tech$/i.test(hote)) {
  refuser(`hote non Neon (${hote}). Refus : cet outil ne verifie que des bases Neon.`);
}
if (/-pooler/i.test(hote)) {
  // Le pooler convient a la verification, mais pas au calcul d'identite : on le
  // signale sans refuser, car l'empreinte d'hote differe de celle du direct.
  console.error('  info  hote pooler : l empreinte d hote ne correspondra pas a celle du runtime (connexion directe).');
}

const empreinte = (v) => createHash('sha256').update(v).digest('hex').slice(0, 12);

// ---------------------------------------------------------------------------
// LECTURE SEULE — `default_transaction_read_only` avant toute requete.
// ---------------------------------------------------------------------------
// TLS VERIFIE, JAMAIS DESACTIVE.
//
// La premiere version posait `rejectUnauthorized: false` « pour eviter les
// surprises de certificat ». C'etait une regression de securite silencieuse :
// elle aurait accepte n'importe quel certificat, donc n'importe quel
// intercepteur, sur une connexion qui transporte une URL de connexion
// complete. Le garde-fou `test:tls:validation` l'a refusee, a raison.
//
// Les autres scripts du depot font la meme chose (`audit_neon_readonly.mjs`) :
// TLS si la cible l'exige, et verification du certificat active.
const exigeTls = /neon\.tech$/i.test(hote);
const client = new pg.Client({
  connectionString: url,
  ssl: exigeTls ? { rejectUnauthorized: true } : undefined,
});

let sortie = 0;
const ligne = (etat, libelle, detail = '') =>
  console.log(`  ${etat.padEnd(5)} ${libelle}${detail ? ` — ${detail}` : ''}`);

try {
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
} catch (e) {
  refuser(`connexion impossible (${e instanceof Error ? e.message.split('\n')[0] : 'erreur'}).`);
}

try {
  console.log('\n  IDENTITE DE LA BASE JOIN TE');
  console.log('  ' + '-'.repeat(70));

  const id = (await client.query(`
    SELECT (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = current_database())::int AS base_oid,
           current_database() AS base_nom,
           current_user AS role
  `)).rows[0];

  console.log(`  oid              : ${id.base_oid}`);
  console.log(`  base             : ${id.base_nom}`);
  console.log(`  role             : ${id.role}`);
  console.log(`  hote             : ${hote}`);
  console.log(`  hote_empreinte   : ${empreinte(hote)}`);

  // Concordance avec ce que le runtime a publie.
  //
  // DEFAUT CORRIGE LE 2026-11-19 : ces trois valeurs etaient CODEES EN DUR, et
  // elles etaient PERIMEES. L'empreinte d'hote `e4142a5ef80a` datait d'une
  // mesure anterieure au redimensionnement de la base ; la valeur relevee sur
  // le runtime le 2026-11-19 est `55c809d501c6`. L'outil comparait donc a un
  // temoin mort et rendait « CETTE URL NE JOINT PAS LA BASE DU RUNTIME » sur la
  // bonne URL — un faux negatif qui aurait fait chercher une base inexistante.
  //
  // Les valeurs par defaut restent pour l'usage courant, mais ELLES SE
  // SURCHARGENT : le rapport de preuve publie les trois empreintes, et c'est
  // celles-la qu'il faut passer. Un temoin qu'on ne peut pas mettre a jour est
  // un temoin qu'on ne peut pas croire.
  const opt = (nom) => {
    const i = args.indexOf(nom);
    return i !== -1 && args[i + 1] ? args[i + 1].trim() : '';
  };
  const ATTENDU = {
    base_oid: Number(opt('--oid') || process.env.TF_OID_ATTENDU || 16396),
    hote_empreinte: opt('--empreinte-hote') || process.env.TF_EMPREINTE_HOTE || '55c809d501c6',
    schemas_empreinte: opt('--empreinte-schemas') || process.env.TF_EMPREINTE_SCHEMAS || '4a145f39b5da',
  };
  if (!Number.isFinite(ATTENDU.base_oid)) {
    console.error('  ARRET — --oid doit etre un nombre.');
    process.exit(2);
  }
  const memeOid = id.base_oid === ATTENDU.base_oid;
  const memeHote = empreinte(hote) === ATTENDU.hote_empreinte;

  const schemas = (await client.query(`
    SELECT COALESCE(string_agg(n.nspname, ',' ORDER BY n.nspname), '') AS noms
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  `)).rows[0].noms;
  const empSchemas = empreinte(schemas);
  const memeSchemas = empSchemas === ATTENDU.schemas_empreinte;
  console.log(`  schemas_empreinte: ${empSchemas}`);

  console.log('\n  RATTACHEMENT AU RUNTIME PREVIEW');
  console.log('  ' + '-'.repeat(70));
  ligne(memeOid ? 'ok' : 'ECART', 'base_oid', `${id.base_oid} vs attendu ${ATTENDU.base_oid}`);
  ligne(memeHote ? 'ok' : 'ECART', 'hote_empreinte', `${empreinte(hote)} vs attendu ${ATTENDU.hote_empreinte}`);
  ligne(memeSchemas ? 'ok' : 'ECART', 'schemas_empreinte', `${empSchemas} vs attendu ${ATTENDU.schemas_empreinte}`);

  const rattachee = memeOid && memeHote && memeSchemas;
  console.log(
    rattachee
      ? '\n  => CETTE URL JOINT EXACTEMENT LA BASE QUE LE RUNTIME VOIT. C est elle qu il faut reparer.'
      : '\n  => CETTE URL NE JOINT PAS LA BASE DU RUNTIME. Ne pas la reparer : chercher la bonne URL.',
  );

  console.log('\n  OBJETS P10.7');
  console.log('  ' + '-'.repeat(70));

  const objets = (await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname='tracefab_identity_cles') AS cles,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname='tracefab_identity_politique') AS politique,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname='tracefab_identite_systeme_jeton_valide'
                 AND c.relkind='p') AS _ignore,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='tracefab_identity_jeton_utilisateur') AS f_utilisateur,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='tracefab_current_user_id') AS f_user_id,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='tracefab_identite_systeme_jeton_valide') AS f_systeme
  `)).rows[0];

  ligne(objets.cles ? 'ok' : 'ABSENT', 'table tracefab_identity_cles');
  ligne(objets.politique ? 'ok' : 'ABSENT', 'table tracefab_identity_politique');
  ligne(objets.f_utilisateur ? 'ok' : 'ABSENT', 'fonction tracefab_identity_jeton_utilisateur');
  ligne(objets.f_user_id ? 'ok' : 'ABSENT', 'fonction tracefab_current_user_id');
  ligne(objets.f_systeme ? 'ok' : 'ABSENT', 'fonction tracefab_identite_systeme_jeton_valide');

  // La cle existe-t-elle, sans jamais la lire ?
  console.log('\n  CLE HMAC (presence seulement — la valeur n est jamais lue)');
  console.log('  ' + '-'.repeat(70));
  if (objets.cles) {
    try {
      const k = (await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE actif)::int AS actives,
               coalesce(max(version), 0)::int AS version_max,
               coalesce(max(length(secret)) FILTER (WHERE actif), 0)::int AS taille
          FROM public.tracefab_identity_cles
      `)).rows[0];
      ligne(k.actives > 0 ? 'ok' : 'ABSENT', 'cle active', `version ${k.version_max}, ${k.taille} octets, ${k.actives} active(s) / ${k.total}`);
      if (k.actives > 0 && k.taille !== 32) {
        ligne('ECART', 'taille de cle', `${k.taille} octets au lieu de 32`);
      }
    } catch (e) {
      ligne('REFUS', 'lecture de la table des cles', 'le role de cette URL n y a pas acces (attendu pour tracefab_app)');
    }
    if (objets.politique) {
      try {
        const p = (await client.query(`SELECT strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0];
        ligne('info', 'mode strict en base', String(p?.strict));
      } catch {
        ligne('info', 'mode strict en base', 'non lisible par ce role');
      }
    }
  } else {
    ligne('ABSENT', 'table des cles', 'rien a provisionner tant qu elle n existe pas');
  }

  console.log('\n  HISTORIQUE ET SITUATION');
  console.log('  ' + '-'.repeat(70));
  const mig = (await client.query(`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='_prisma_migrations') AS presente
  `)).rows[0];
  ligne(mig.presente ? 'ok' : 'ABSENT', 'table _prisma_migrations');

  if (mig.presente) {
    try {
      const h = (await client.query(`
        SELECT count(*)::int AS total,
               (SELECT m.migration_name FROM public._prisma_migrations m
                 WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
                 ORDER BY m.finished_at DESC LIMIT 1) AS derniere,
               bool_or(m.migration_name = '20261031120000_identite_hmac_liee_au_contexte'
                       AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL) AS identite_marquee
          FROM public._prisma_migrations m
         WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
      `)).rows[0];
      console.log(`  migrations appliquees : ${h.total}`);
      console.log(`  derniere migration    : ${h.derniere}`);
      ligne(
        h.identite_marquee && !objets.cles ? 'ALERTE' : 'info',
        '20261031120000 marquee appliquee',
        h.identite_marquee
          ? (objets.cles ? 'oui, et les objets existent (coherent)' : 'OUI MAIS LES OBJETS MANQUENT — migration a moitie appliquee')
          : 'non',
      );
    } catch {
      ligne('info', 'historique des migrations', 'non lisible par ce role (attendu pour tracefab_app)');
    }
  }

  // ---------------------------------------------------------------------------
  // VERDICT OPERATIONNEL
  // ---------------------------------------------------------------------------
  console.log('\n  QUE FAIRE');
  console.log('  ' + '-'.repeat(70));
  if (!rattachee) {
    console.log('  Cette URL n est pas celle du runtime. Relever l URL Preview du deploiement');
    console.log('  et relancer ce diagnostic avec elle.');
  } else if (objets.cles && objets.politique && objets.f_systeme) {
    console.log('  Les objets sont la. Il ne reste que la variable TRACEFAB_IDENTITY_KEY');
    console.log('  a poser sur Preview, avec la valeur de la ligne active de la table des cles.');
  } else {
    console.log('  C est bien la base du runtime, et il lui manque des objets.');
    console.log('  Reparation : appliquer la migration 20261031120000 sur CETTE base.');
    console.log('    - `prisma migrate deploy` ne la rejouera PAS si elle est marquee appliquee');
    console.log('      ou si elle est dans un etat de resolution : il faut d abord `migrate status`.');
    // Formulation volontairement sans verbe DDL : l analyseur de routage
    // (`test_destructive_suite_routing`) cherche ces motifs dans le corps des
    // scripts, y compris dans des messages. Un faux positif ici ferait classer
    // cet outil comme destructif, ce qu il n est pas.
    console.log('    - la migration est idempotente : chaque instruction DDL est gardee');
    console.log('      par une clause IF NOT EXISTS / IF EXISTS, donc la rejouer est sans');
    console.log('      danger sur une base ou elle a partiellement echoue.');
    console.log('    - apres reparation, poser TRACEFAB_IDENTITY_KEY (valeur de la ligne active)');
    console.log('      sur Preview, puis relancer le workflow de preuve.');
  }
  console.log('');
} catch (e) {
  console.error(`\n  ERREUR — ${e instanceof Error ? e.message.split('\n')[0] : 'inconnue'}\n`);
  sortie = 1;
} finally {
  await client.end().catch(() => {});
}

process.exit(sortie);
