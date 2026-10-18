#!/usr/bin/env node
/**
 * Validation hors ligne de scripts/sonde_preview.mjs.
 *
 * Le sondeur ne peut pas etre verifie contre une vraie Preview depuis un
 * environnement sans acces a *.vercel.app. Ce test leve trois serveurs locaux
 * qui reproduisent chacun une situation reelle observee, lance le sondeur en
 * processus fils et exige son code de sortie et ses verdicts. Il suit le modele
 * de test_diagnose_incident_offline.mjs deja present dans le depot.
 *
 * Les trois situations viennent de mesures, pas d'hypotheses :
 *   - conforme        : contrat lu dans le code des routes ;
 *   - en panne        : DPP en 500 internal_error et scan en 200, c'est-a-dire
 *                       exactement ce que la bascule du role runtime pourrait
 *                       provoquer si une route perdait son contexte ;
 *   - Vercel protege  : corps reel releve sur la Preview de b387ea0, avec
 *                       `vercel_auth_enabled` place au-dela de 220 caracteres
 *                       pour eprouver la detection sur le corps complet.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sondeur = path.join(racine, 'scripts', 'sonde_preview.mjs');

let reussites = 0;
let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) {
    reussites += 1;
    console.log(`  ok    ${nom}${detail ? ` — ${detail}` : ''}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`);
  }
};

const json = (res, code, corps) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof corps === 'string' ? corps : JSON.stringify(corps));
};

/** Contrat de l'application, lu dans le code des routes. */
const repondContrat = (req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/') return json(res, 200, '<html>tracefab</html>');
  if (p === '/api/health') return json(res, 200, { ok: true, service: 'tracefab-api' });
  if (p === '/api/dpp/0000000000000') return json(res, 404, { error: 'product_passport_not_found' });
  if (p.startsWith('/api/documents/') && p.endsWith('/scan') && req.method === 'POST') {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (p === '/api/green-claims/rules') return json(res, 200, { rules: [1, 2, 3, 4, 5] });
  if (p === '/api/pef/factors') return json(res, 200, { factors: new Array(23).fill(0) });
  return json(res, 404, { error: 'not_found' });
};

/** Ce que produirait une route ayant perdu son contexte apres la bascule. */
const repondPanne = (req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/') return json(res, 200, '<html>tracefab</html>');
  if (p === '/api/health') return json(res, 200, { ok: true });
  if (p === '/api/dpp/0000000000000') return json(res, 500, { error: 'internal_error' });
  if (p.startsWith('/api/documents/')) return json(res, 200, { ok: true });
  if (p === '/api/green-claims/rules') return json(res, 200, { rules: [] });
  if (p === '/api/pef/factors') return json(res, 200, { factors: [] });
  return json(res, 404, {});
};

/** Corps reel de Vercel Authentication, marque placee tardivement. */
const CORPS_VERCEL = JSON.stringify({
  access: 'vercel curl <deployment-url>',
  mcp: 'With an authorized Vercel MCP connection (https://mcp.vercel.com), call web_fetch_vercel_deployment_insights to fetch deployment details, logs, and runtime information for this protected deployment.',
  message: 'Protected by Vercel Authentication',
  error: { message: 'Protected deployment', code: '401' },
  protection: {
    auto_vercel_auth_redirect: true,
    password_enabled: false,
    vercel_auth_enabled: true,
    vercel_auth_callback: 'https://vercel.com/sso-api?url=https%3A%2F%2Fexemple.vercel.app',
  },
});
const repondProtege = (_req, res) => json(res, 401, CORPS_VERCEL);

const lever = (gestionnaire) =>
  new Promise((resoudre) => {
    const serveur = http.createServer(gestionnaire);
    serveur.listen(0, '127.0.0.1', () => {
      const { port } = serveur.address();
      resoudre({ serveur, url: `http://127.0.0.1:${port}` });
    });
  });

const lancer = (url, env = {}) =>
  new Promise((resoudre) => {
    const fils = spawn(process.execPath, [sondeur, '--hors-ligne', '--base', url, '--commit', 'test'], {
      env: { ...process.env, ...env },
    });
    let sortie = '';
    fils.stdout.on('data', (d) => (sortie += d));
    fils.stderr.on('data', (d) => (sortie += d));
    fils.on('close', (code) => resoudre({ code, sortie }));
  });

const compte = (sortie, verdict) => {
  const m = sortie.match(new RegExp(`${verdict} (\\d+)`));
  return m ? Number(m[1]) : -1;
};

console.log('');
console.log('  Sondage de la Preview — validation hors ligne');
console.log('');

verifier(
  CORPS_VERCEL.indexOf('vercel_auth_enabled') > 220,
  'le corps de protection place bien sa marque au-dela de 220 caracteres',
  `position ${CORPS_VERCEL.indexOf('vercel_auth_enabled')}`,
);

const conforme = await lever(repondContrat);
const panne = await lever(repondPanne);
const protege = await lever(repondProtege);

const r1 = await lancer(conforme.url);
verifier(r1.code === 0, 'serveur conforme : sortie 0', `sortie ${r1.code}`);
verifier(compte(r1.sortie, 'HONORE') === 6, 'serveur conforme : six routes honorees');
verifier(compte(r1.sortie, 'INDETERMINE') === 0, 'serveur conforme : aucun indetermine');

const r2 = await lancer(panne.url);
verifier(r2.code === 1, 'serveur en panne : sortie 1', `sortie ${r2.code}`);
verifier(compte(r2.sortie, 'ECHEC') === 2, 'serveur en panne : DPP et scan en echec');
verifier(
  /internal_error/.test(r2.sortie),
  'serveur en panne : le 500 internal_error est nomme dans la sortie',
);

const r3 = await lancer(protege.url);
verifier(r3.code === 3, 'Preview protegee : sortie 3', `sortie ${r3.code}`);
verifier(compte(r3.sortie, 'INDETERMINE') === 6, 'Preview protegee : six indetermine, aucun honore');
verifier(compte(r3.sortie, 'HONORE') === 0, 'Preview protegee : rien n est compte comme vert');
verifier(
  /test non execute/.test(r3.sortie),
  'Preview protegee : la sortie dit explicitement que le test n a pas ete execute',
);
verifier(
  !r3.sortie.includes('valeur-tres-secrete'),
  'aucune valeur de contournement ne fuit dans la sortie',
);

// La ligne temoin doit etre classee, pas brute : derriere un proxy a
// interception TLS, une erreur de certificat prouve que le reseau fonctionne.
// La lire comme « injoignable » ferait diagnostiquer une panne inexistante.
verifier(
  /hote temoin\s+:/.test(r3.sortie),
  'la sortie comporte une ligne d hote temoin',
);
verifier(
  !/hote temoin\s+:.*\binjoignable\b/.test(r3.sortie),
  'le temoin n est jamais rendu par le mot « injoignable » seul, qui masquerait un reseau fonctionnel',
);

// La validation TLS ne doit jamais etre desactivee : la sortie nomme le magasin
// employe et le dit explicitement. Un sondeur qui accepterait tout certificat
// rendrait ses propres verdicts sans valeur.
verifier(
  /magasin CA\s+:/.test(r3.sortie),
  'la sortie nomme le magasin de certificats employe',
);
verifier(
  /validation TLS active/.test(r3.sortie),
  'la sortie affirme que la validation TLS reste active',
);

const r4 = await lancer(protege.url, { TF_VERCEL_BYPASS: 'valeur-tres-secrete-12345' });
verifier(
  !r4.sortie.includes('valeur-tres-secrete-12345'),
  'la valeur de contournement exportee n apparait jamais dans la sortie',
);
verifier(
  /present, non affiche/.test(r4.sortie),
  'la sortie indique que le contournement est present sans le reveler',
);

for (const s of [conforme, panne, protege]) s.serveur.close();

console.log('');
console.log('  --------------------------------------------');
if (echecs > 0) {
  console.log(`  ${echecs} ECHEC sur ${reussites + echecs} assertions.`);
  console.log('  --------------------------------------------');
  process.exit(1);
}
console.log(`  Sondeur valide hors ligne : ${reussites} assertions.`);
console.log('  --------------------------------------------');
process.exit(0);
