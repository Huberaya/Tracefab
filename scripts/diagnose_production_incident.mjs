#!/usr/bin/env node
/**
 * Lecture seule des journaux d'un deploiement Vercel, pour retrouver la ligne
 * qui manque au diagnostic du chantier 5 :
 *
 *   correlationId  fd30b689-f50f-44f0-a0dd-43e5e1e51f0e
 *   deploiement    6968252029   (commit b0c976f, production)
 *
 * CE QUE CE SCRIPT FAIT
 *   1. il lit les metadonnees du deploiement : etat, cible, URL, commit ;
 *   2. il lit les journaux de BUILD et n'affiche que les lignes qui portent
 *      l'identifiant de correlation ou la marque du rapport d'erreur ;
 *   3. il dit, si rien ne correspond, ce que cela signifie et ou chercher
 *      ensuite — sans jamais presenter une absence de trace comme une preuve.
 *
 * CE QUE CE SCRIPT NE FAIT PAS
 *   - aucune requete autre que GET ; aucune ecriture, aucun redeploiement,
 *     aucun changement de variable, aucune suppression ;
 *   - le jeton est lu dans l'environnement et n'est JAMAIS imprime, ni en cas
 *     d'erreur, ni dans une URL, ni dans un message ;
 *   - tout ce qui est affiche passe par une fonction de caviardage qui masque
 *     le jeton, les entetes d'autorisation et les chaines de connexion.
 *
 * SORTIES
 *   0  au moins une ligne correspondante a ete trouvee et affichee ;
 *   1  le script a tourne mais n'a rien trouve (reponse honnete : pas de trace) ;
 *   2  le script n'a pas pu tourner (jeton absent, reseau injoignable, refus) —
 *      un controle qui n'a pas tourne n'est pas un controle qui passe.
 */

const TOKEN = process.env.VERCEL_TOKEN || process.env.VERCEL_ACCESS_TOKEN || '';
const DEPLOYMENT_ID = process.env.TF_DEPLOYMENT_ID || '6968252029';
const CORRELATION_ID = process.env.TF_CORRELATION_ID || 'fd30b689-f50f-44f0-a0dd-43e5e1e51f0e';
const TEAM_ID = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '';
const MARQUE_RAPPORT = 'tracefab-error-report-v1';

const FAMINE = (code, message) => {
  console.error(`\n  ARRET — ${message}\n`);
  process.exit(code);
};

const masquer = (texte) => {
  let sortie = String(texte ?? '');
  if (TOKEN) sortie = sortie.split(TOKEN).join('<jeton masque>');
  sortie = sortie.replace(/\b[Bb]earer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer <masque>');
  sortie = sortie.replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '<chaine-de-connexion-masquee>');
  sortie = sortie.replace(/(?<=[?&](?:token|key|secret|password)=)[^&\s"']+/gi, '<masque>');
  // Les identifiants longs et opaques (jetons d'acces, identifiants de projet)
  // n'ont aucun role dans ce diagnostic : ils sont masques, sans masquer les
  // messages utiles comme « Cannot find module '.prisma/client/default' ».
  sortie = sortie.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m) =>
    /^[0-9a-f-]{36}$/i.test(m) || m.includes('.') ? m : '<identifiant-masque>');
  return sortie;
};

const lire = async (chemin, { brut = false } = {}) => {
  const url = new URL(`https://api.vercel.com${chemin}`);
  if (TEAM_ID) url.searchParams.set('teamId', TEAM_ID);
  let reponse;
  try {
    reponse = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (erreur) {
    FAMINE(2, `reseau injoignable ou delai depasse sur api.vercel.com : ${masquer(erreur.message)}`);
  }
  if (reponse.status === 401 || reponse.status === 403) {
    FAMINE(2, `api.vercel.com a refuse la lecture (HTTP ${reponse.status}). ` +
      'Jeton absent, expire, revoque, ou rattache a une autre equipe.');
  }
  if (reponse.status === 404) {
    FAMINE(2, `api.vercel.com ne connait pas cette ressource (HTTP 404). ` +
      'Verifiez l identifiant du deploiement et, si le projet appartient a une equipe, VERCEL_TEAM_ID.');
  }
  if (!reponse.ok) {
    const corps = await reponse.text().catch(() => '');
    FAMINE(2, `api.vercel.com a repondu HTTP ${reponse.status} : ${masquer(corps.slice(0, 300))}`);
  }
  return brut ? reponse.text() : reponse.json();
};

if (!TOKEN) {
  FAMINE(2, 'aucun jeton dans l environnement. Utilisez scripts/diagnose_production_incident.sh ' +
    '(saisie masquee) ou exportez VERCEL_TOKEN. Le jeton ne doit jamais etre colle dans un chat, ' +
    'un ticket, un commit ou un rapport.');
}

console.log('\n  Diagnostic de l incident de production — lecture seule');
console.log('  ------------------------------------------------------');

// --- 1. Metadonnees du deploiement ------------------------------------------
console.log('\n  1. deploiement\n');

let deploiement = null;
try {
  deploiement = await lire(`/v6/deployments/${DEPLOYMENT_ID}`);
} catch (erreur) {
  FAMINE(2, `reponse illisible : ${masquer(erreur.message)}`);
}

const meta = deploiement?.meta || {};
console.log(`  identifiant : ${masquer(deploiement?.id ?? DEPLOYMENT_ID)}`);
console.log(`  etat        : ${masquer(deploiement?.readyState ?? deploiement?.state ?? 'inconnu')}`);
console.log(`  cible       : ${masquer(deploiement?.target ?? 'inconnue')}`);
console.log(`  cree        : ${masquer(deploiement?.createdAt ? new Date(deploiement.createdAt).toISOString() : 'inconnu')}`);
console.log(`  url         : ${masquer(deploiement?.url ?? 'inconnue')}`);
const sha = meta.githubCommitSha || meta.gitCommitSha || '';
console.log(`  commit      : ${masquer(sha || 'non expose par l API')}`);
if (sha && !sha.startsWith('b0c976f')) {
  console.log(`\n  ATTENTION — le commit de ce deploiement ne commence pas par b0c976f.`);
  console.log('  Le diagnostic du chantier 5 vise b0c976f / deploiement 6968252029 :');
  console.log('  toute conclusion tiree d un autre commit ne s appliquerait pas.');
}

// --- 2. Journaux de build ----------------------------------------------------
console.log('\n  2. journaux de build, filtres sur l identifiant de correlation\n');

let journal = '';
try {
  journal = await lire(
    `/v3/deployments/${DEPLOYMENT_ID}/events?builds=1&limit=2000&direction=backward`,
    { brut: true },
  );
} catch (erreur) {
  FAMINE(2, `journaux de build illisibles : ${masquer(erreur.message)}`);
}

const lignes = journal.split('\n').filter((l) => l.trim().length > 0);
const correspondances = lignes.filter((l) => l.includes(CORRELATION_ID) || l.includes(MARQUE_RAPPORT));

if (correspondances.length > 0) {
  console.log(`  ${correspondances.length} ligne(s) correspondante(s) :\n`);
  for (const ligne of correspondances.slice(0, 20)) console.log(`    ${masquer(ligne).slice(0, 2000)}`);

  const brut = correspondances.join('\n');
  console.log('\n  Lecture des messages rencontres :\n');
  const pistes = [
    ["export named 'PrismaClient'", 'le module importe Prisma a l execution sans client genere'],
    ["Cannot find module '.prisma/client/default'", 'le paquet @prisma/client est la, le client genere ne l est pas'],
    ['Query engine library', 'le client est genere mais son moteur de requetes manque'],
  ];
  let reconnu = false;
  for (const [motif, sens] of pistes) {
    if (brut.includes(motif)) { console.log(`    - « ${motif} » → ${sens}`); reconnu = true; }
  }
  if (!reconnu) {
    console.log('    - aucun des trois messages attendus n apparait : le §5.5 du rapport est a');
    console.log('      corriger, pas a confirmer. Transmettez la ligne telle quelle.');
  }
  console.log('');
  process.exit(0);
}

console.log('  aucune ligne ne porte cet identifiant dans les journaux de BUILD.');
console.log('\n  Ce que cela veut dire, sans le transformer en preuve :');
console.log("    un « internal_error » est un evenement d EXECUTION, pas de build.");
console.log('    L absence de trace ici est donc ATTENDUE et ne contredit rien.');
console.log('    La ligne cherchee est dans les journaux d execution (onglet Logs du');
console.log('    deploiement, ou « npx vercel logs <url> --json | fgrep fd30b689- »).');
console.log('\n  Rappel de ce qui est cherche : le JSON dont « schema » vaut');
console.log(`    "${MARQUE_RAPPORT}" et qui contient ${CORRELATION_ID},`);
console.log('    avec l une des trois valeurs de error.message listees au §10.5 du rapport.');
console.log('');
process.exit(1);
