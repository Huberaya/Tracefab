#!/usr/bin/env node
/**
 * Sondage fonctionnel d'une Preview TraceFab.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Les Preview sont protegees par Vercel Authentication : sans acces autorise,
 *   chaque route repond 401 avec un corps de protection, et ce 401 ne vient pas
 *   de l'application. Un sondeur qui se contenterait de comparer des codes
 *   prendrait ce 401 pour le 401 attendu d'une route protegee. Ce script
 *   distingue les deux origines et classe alors le resultat INDETERMINE.
 *
 * ACCES AUTORISE — deux voies, aucune ne passe par ce script pour le secret
 *   1. Protection Bypass for Automation. Dans Vercel : Settings > Deployment
 *      Protection > Protection Bypass > Generate. La valeur est exportee dans
 *      VOTRE terminal, puis ce script l'envoie dans l'en-tete
 *      `x-vercel-protection-bypass`. Elle n'est jamais affichee, jamais
 *      journalisee, jamais transmise ailleurs qu'a l'hote sonde.
 *   2. `vercel curl` depuis un poste deja authentifie, si vous preferez ne rien
 *      exporter. Ce script ne l'appelle pas : il se contente de curl.
 *
 * CE QUI EST INTERDIT ICI
 *   Aucune tentative de contournement. Si l'acces autorise manque, le script le
 *   dit et sort en 3. Il ne devine pas, n'insiste pas, ne presente rien comme
 *   vert.
 */

const args = process.argv.slice(2);
const valeur = (nom) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const base = (valeur('base') || process.env.TF_PREVIEW_URL || '').replace(/\/$/, '');
const commit = valeur('commit') || 'non precise';

// `--hors-ligne` n'accepte qu'une adresse de boucle locale en http. Il sert a
// valider la logique de classification contre des serveurs locaux, sur le
// modele de test_diagnose_incident_offline.mjs deja present dans le depot. Il
// n'elargit en rien ce qui peut etre sonde en conditions reelles : toute autre
// URL reste refusee.
const horsLigne = args.includes('--hors-ligne');
const urlValide = horsLigne
  ? /^http:\/\/127\.0\.0\.1:\d+$/.test(base)
  : /^https:\/\/[a-z0-9.-]+\.vercel\.app$/i.test(base);

if (!urlValide) {
  console.error('URL refusee : seule une Preview Vercel en https peut etre sondee.');
  console.error('Usage : node scripts/sonde_preview.mjs --base https://<preview>.vercel.app --commit <sha>');
  process.exit(2);
}

// Lu une fois, jamais affiche. `masque` sert uniquement a prouver dans la
// sortie que la valeur n'y figure pas.
const bypass = process.env.TF_VERCEL_BYPASS || '';
const masque = bypass ? 'present, non affiche' : 'absent';

/** Contrat lu dans le code des routes, pas devine. */
const sondes = [
  {
    nom: 'page d accueil',
    methode: 'GET',
    chemin: '/',
    attendu: 200,
    pourquoi: 'vercel.json route `/` -> /index.html',
  },
  {
    nom: 'sante — acces base',
    methode: 'GET',
    chemin: '/api/health',
    attendu: 200,
    corps: '"ok":true',
    pourquoi: 'api/_routes/health.ts renvoie {ok:true} apres SELECT 1',
  },
  {
    nom: 'DPP — GTIN inconnu',
    methode: 'GET',
    chemin: '/api/dpp/0000000000000',
    attendu: 404,
    corps: 'product_passport_not_found',
    pourquoi: "dpp/[gtin].ts renvoie 404 product_passport_not_found si rien n'est resolu",
  },
  {
    nom: 'scan — sans authentification',
    methode: 'POST',
    chemin: '/api/documents/00000000-0000-0000-0000-000000000000/scan',
    attendu: 401,
    pourquoi: 'documents/[documentId]/scan.ts appelle requireClerkUser avant tout acces',
  },
  {
    nom: 'reference — green claims',
    methode: 'GET',
    chemin: '/api/green-claims/rules',
    attendu: 200,
    pourquoi: 'table de reference anonyme, aucun requireClerkUser',
  },
  {
    nom: 'reference — facteurs PEF',
    methode: 'GET',
    chemin: '/api/pef/factors',
    attendu: 200,
    pourquoi: 'table de reference anonyme, aucun requireClerkUser',
  },
];

/**
 * Une reponse de Vercel Authentication n'est pas une reponse de l'application.
 * La detection porte sur le corps COMPLET : l'ordre des cles JSON varie d'une
 * route a l'autre et la marque peut tomber au-dela d'un extrait tronque.
 */
const estProtectionVercel = (corps, entetes) =>
  /vercel_auth_enabled|Protected by Vercel Authentication/i.test(corps) ||
  /vercel\.com\/sso-api/i.test(entetes.get('location') || '');

const sonder = async (s) => {
  const entetes = { accept: 'application/json' };
  if (bypass) entetes['x-vercel-protection-bypass'] = bypass;

  let reponse;
  try {
    reponse = await fetch(`${base}${s.chemin}`, {
      method: s.methode,
      headers: entetes,
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    return { ...s, obtenu: '000', corps: `requete impossible : ${e.name}`, verdict: 'INDETERMINE' };
  }

  const brut = await reponse.text();
  const obtenu = String(reponse.status);
  const corps = brut.replace(/\s+/g, ' ').slice(0, 220);

  if (estProtectionVercel(brut, reponse.headers)) {
    return { ...s, obtenu, corps, verdict: 'INDETERMINE', raison: 'Vercel Authentication' };
  }
  if (obtenu !== String(s.attendu)) {
    return { ...s, obtenu, corps, verdict: 'ECHEC' };
  }
  if (s.corps && !brut.includes(s.corps)) {
    return { ...s, obtenu, corps, verdict: 'ECHEC', raison: `corps attendu absent : ${s.corps}` };
  }
  return { ...s, obtenu, corps, verdict: 'HONORE' };
};

const resultats = [];
for (const s of sondes) resultats.push(await sonder(s));

console.log(`commit        : ${commit}`);
console.log(`base          : ${base}`);
console.log(`contournement : ${masque}`);
console.log('');
console.log('route                            attendu  obtenu   verdict       detail');
console.log('-'.repeat(104));

for (const r of resultats) {
  const detail = r.raison || (r.verdict === 'HONORE' ? 'contrat respecte' : r.corps);
  console.log(
    `${r.nom.padEnd(32)} ${String(r.attendu).padEnd(8)} ${r.obtenu.padEnd(8)} ${r.verdict.padEnd(13)} ${detail.slice(0, 60)}`,
  );
}

const honores = resultats.filter((r) => r.verdict === 'HONORE').length;
const echecs = resultats.filter((r) => r.verdict === 'ECHEC').length;
const indetermines = resultats.filter((r) => r.verdict === 'INDETERMINE').length;

console.log('');
console.log(`HONORE ${honores} | ECHEC ${echecs} | INDETERMINE ${indetermines}`);

if (indetermines > 0) {
  console.log('');
  console.log('Resultat non concluant : au moins une route n a pas atteint l application.');
  console.log('Ce n est ni une reussite ni un echec du code, c est un test non execute.');
  console.log('Pour le rendre concluant : Settings > Deployment Protection > Protection');
  console.log('Bypass > Generate, puis exporter la valeur dans TF_VERCEL_BYPASS et relancer.');
  process.exit(3);
}
if (echecs > 0) {
  console.log('');
  console.log(`${echecs} route(s) hors contrat.`);
  process.exit(1);
}
console.log('');
console.log('Toutes les routes repondent conformement au contrat lu dans le code.');
process.exit(0);
