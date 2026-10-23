#!/usr/bin/env node
/**
 * Eprouve la selection du deploiement Preview et le diagnostic de surface.
 *
 * POURQUOI CE TEST EXISTE
 *   Le chantier P1 a echoue quatre fois sur le meme point : la cible des tests.
 *   Une correction de selection de cible qui n'est pas eprouvee dans les deux
 *   sens (elle retient le bon deploiement ET elle refuse les autres) n'est pas
 *   une correction, c'est une esperance. Ce test eprouve les deux sens, hors
 *   ligne, sans reseau et sans secret :
 *
 *     1. le deploiement retenu est celui dont le SHA EGALE le SHA teste ;
 *     2. un deploiement d'un AUTRE commit n'est jamais utilise ;
 *     3. un deploiement qui n'est pas `success` echoue en le nommant ;
 *     4. une URL de production est refusee, jamais testee ;
 *     5. une URL imposee qui n'appartient pas au deploiement du SHA est refusee ;
 *     6. un 302 vers /sso-api, un 307 vers un AUTRE deploiement, un 401 et une
 *        absence de reponse produisent quatre DIAGNOSTICS differents ;
 *     7. le secret de contournement n'est jamais envoye a un autre hote.
 *
 * Les codes de sortie sont lus sur le VRAI script (`resolve_preview_deployment.mjs`),
 * lance en sous-processus contre un faux api.github.com en boucle locale.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODES_SONDE, sonderCible } from '../scripts/lib/preview_surface.mjs';

const SHA_OK = 'a'.repeat(40);
const SHA_AUTRE = 'b'.repeat(40);

let scenario = null;
let appels = [];

const serveur = createServer((req, res) => {
  appels.push(req.url);
  const url = new URL(req.url, 'http://127.0.0.1');
  const repondre = (statut, corps) => {
    res.writeHead(statut, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corps));
  };
  if (!scenario) return repondre(500, { message: 'aucun scenario' });
  if (scenario.statutApi && scenario.statutApi !== 200) return repondre(scenario.statutApi, { message: 'refus' });
  if (url.pathname.endsWith('/deployments')) return repondre(200, scenario.deploiements || []);
  const m = url.pathname.match(/\/deployments\/(\d+)\/statuses$/);
  if (m) {
    const statuts = (scenario.statuts || {})[m[1]];
    if (!statuts) return repondre(404, { message: 'inconnu' });
    return repondre(200, statuts);
  }
  return repondre(404, { message: 'route inconnue' });
});

await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
const port = serveur.address().port;

/**
 * Lance le VRAI script en sous-processus. `spawn` asynchrone et non
 * `spawnSync` : le faux api.github.com tourne dans CE processus, donc bloquer
 * la boucle d'evenements du test bloquerait aussi le serveur et produirait un
 * interblocage, pas une mesure.
 */
function lancerResolver(envSupplementaire = {}) {
  const dossier = mkdtempSync(join(tmpdir(), 'p1-resolver-'));
  const sortie = join(dossier, 'output.txt');
  return new Promise((resolve) => {
    const enfant = spawn(process.execPath, ['scripts/resolve_preview_deployment.mjs'], {
      cwd: process.cwd(),
      env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'Huberaya/Tracefab',
      GH_TOKEN: 'jeton-de-test-jamais-reel',
      TF_TARGET_SHA: SHA_OK,
      TF_PREVIEW_WAIT_SECONDS: '0',
      TF_PREVIEW_POLL_SECONDS: '0',
      GITHUB_OUTPUT: sortie,
      TRACEFAB_GITHUB_API: `http://127.0.0.1:${port}`,
        ...envSupplementaire,
      },
    });
    let stdout = '';
    let stderr = '';
    enfant.stdout.on('data', (d) => { stdout += d.toString(); });
    enfant.stderr.on('data', (d) => { stderr += d.toString(); });
    enfant.on('close', (code) => {
      const contenu = existsSync(sortie) ? readFileSync(sortie, 'utf8') : '';
      resolve({ code, stdout, stderr, sortie: contenu });
    });
  });
}

const deploiement = (id, sha, cree) => ({ id, sha, ref: sha, environment: 'Preview', created_at: cree });
const statutPret = (url) => ([{ state: 'success', environment_url: url }]);

/**
 * Lit une sortie de step GitHub ($GITHUB_OUTPUT). Le format est celui que
 * produit `ecrireSortie` : `nom<<DELIMITEUR` … `DELIMITEUR`. On le PARSE au
 * lieu de le comparer a l'oeil : c'est le contrat que lit le workflow.
 */
function valeurSortie(sortie, nom) {
  const lignes = String(sortie).split('\n');
  for (let i = 0; i < lignes.length; i += 1) {
    const m = lignes[i].match(new RegExp(`^${nom}<<(.+)$`));
    if (!m) continue;
    const fin = m[1];
    const valeurs = [];
    for (let j = i + 1; j < lignes.length; j += 1) {
      if (lignes[j] === fin) break;
      valeurs.push(lignes[j]);
    }
    return valeurs.join('\n');
  }
  return null;
}

const resultats = [];
const eprouver = async (nom, fn) => {
  try {
    await fn();
    resultats.push(['PASS', nom]);
    console.log(`  PASS  ${nom}`);
  } catch (error) {
    resultats.push(['FAIL', nom]);
    console.log(`  FAIL  ${nom} — ${String(error.message).split('\n')[0]}`);
  }
};

console.log('\n  --- selection du deploiement Preview (sous-processus reel)');

await eprouver('un deploiement du bon SHA est retenu, un deploiement d un autre commit est ignore', async () => {
  scenario = {
    deploiements: [deploiement(100, SHA_AUTRE, '2026-10-23T22:00:00Z'), deploiement(200, SHA_OK, '2026-10-23T22:44:45Z')],
    statuts: {
      100: statutPret('https://tracefab-autrecommit-baya.vercel.app'),
      200: statutPret('https://tracefab-7xgup5zjo-baya.vercel.app'),
    },
  };
  const r = await lancerResolver();
  assert.equal(r.code, 0, `code attendu 0, recu ${r.code}\n${r.stdout}`);
  assert.equal(valeurSortie(r.sortie, 'preview_url'), 'https://tracefab-7xgup5zjo-baya.vercel.app');
  assert.equal(valeurSortie(r.sortie, 'deployment_sha'), SHA_OK);
  assert.equal(valeurSortie(r.sortie, 'deployment_state'), 'success');
  assert.doesNotMatch(r.sortie, /autrecommit/);
});

await eprouver('aucun deploiement pour le SHA teste : code 11, cause nommee', async () => {
  scenario = {
    deploiements: [deploiement(100, SHA_AUTRE, '2026-10-23T22:00:00Z')],
    statuts: { 100: statutPret('https://tracefab-autrecommit-baya.vercel.app') },
  };
  const r = await lancerResolver();
  assert.equal(r.code, 11, `code attendu 11, recu ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /cause=aucun_deploiement_preview_pour_ce_sha/);
});

await eprouver('deploiement present mais jamais pret : code 12, etat nomme', async () => {
  scenario = {
    deploiements: [deploiement(300, SHA_OK, '2026-10-23T22:44:45Z')],
    statuts: { 300: [{ state: 'in_progress' }] },
  };
  const r = await lancerResolver();
  assert.equal(r.code, 12, `code attendu 12, recu ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /cause=deploiement_present_mais_jamais_pret/);
  assert.match(r.stdout, /deploiement_etats=300:in_progress/);
});

await eprouver('deploiement pret mais URL de production : code 13, jamais teste', async () => {
  scenario = {
    deploiements: [deploiement(400, SHA_OK, '2026-10-23T22:44:45Z')],
    statuts: { 400: statutPret('https://tracefab.vercel.app') },
  };
  const r = await lancerResolver();
  assert.equal(r.code, 13, `code attendu 13, recu ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /cause=hote_de_production_interdit/);
});

await eprouver('API GitHub refusee : code 3, pas une boucle infinie', async () => {
  scenario = { statutApi: 403 };
  const r = await lancerResolver();
  assert.equal(r.code, 3, `code attendu 3, recu ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /cause=api_deployments_http_403/);
});

await eprouver('URL imposee hors du deploiement du SHA : code 14', async () => {
  scenario = {
    deploiements: [deploiement(500, SHA_OK, '2026-10-23T22:44:45Z')],
    statuts: { 500: statutPret('https://tracefab-7xgup5zjo-baya.vercel.app') },
  };
  const r = await lancerResolver({ TF_PREVIEW_URL_OVERRIDE: 'https://tracefab-git-arena-e13749-baya.vercel.app' });
  assert.equal(r.code, 14, `code attendu 14, recu ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /cause=url_imposee_hors_du_deploiement_du_sha/);
});

await eprouver('URL imposee identique au deploiement du SHA : acceptee et annotee', async () => {
  scenario = {
    deploiements: [deploiement(600, SHA_OK, '2026-10-23T22:44:45Z')],
    statuts: { 600: statutPret('https://tracefab-7xgup5zjo-baya.vercel.app') },
  };
  const r = await lancerResolver({ TF_PREVIEW_URL_OVERRIDE: 'https://tracefab-7xgup5zjo-baya.vercel.app' });
  assert.equal(r.code, 0, `code attendu 0, recu ${r.code}\n${r.stdout}`);
  assert.equal(valeurSortie(r.sortie, 'url_source'), 'entree_manuelle_verifiee');
  assert.equal(valeurSortie(r.sortie, 'deployment_id'), '600');
});

console.log('\n  --- diagnostic de surface (reponses simulees)');

const origine = new URL('https://tracefab-7xgup5zjo-baya.vercel.app');
const reponse = ({ status, headers = {}, body = '' }) => ({
  status,
  headers: { get: (nom) => headers[nom.toLowerCase()] || null },
  text: async () => body,
});

const jsonSain = JSON.stringify({ ok: true, service: 'tracefab-api' });

async function sonder(reponses, options = {}) {
  const appelsFetch = [];
  const fetchImpl = async (url, init) => {
    appelsFetch.push({ url: String(url), entetes: init?.headers || {}, redirect: init?.redirect });
    const suivant = reponses.shift();
    if (suivant instanceof Error) throw suivant;
    return suivant;
  };
  const resultat = await sonderCible(origine, { fetchImpl, chemins: ['/api/health'], ...options });
  return { ...resultat, appelsFetch };
}

{
  const { verdict } = await sonder([reponse({ status: 200, headers: { 'content-type': 'application/json' }, body: jsonSain })]);
  await eprouver('200 JSON sain : application atteinte, code 0', async () => {
    assert.equal(verdict.code, CODES_SONDE.ok);
    assert.equal(verdict.cause, 'application_atteinte');
  });
}

{
  const { verdict, mesures } = await sonder([
    reponse({ status: 302, headers: { location: 'https://tracefab-7xgup5zjo-baya.vercel.app/sso-api?nonce=x&url=y' }, body: 'Redirecting' }),
  ], { bypass: 'secret-de-test' });
  await eprouver('302 vers /sso-api avec secret present : contournement INVALIDE (code 5)', async () => {
    assert.equal(verdict.code, CODES_SONDE.protection);
    assert.equal(verdict.cause, 'contournement_invalide');
    const classe = mesures.find(([cle]) => cle === '/api/health_redirection_classe');
    assert.equal(classe?.[1], 'sso_vercel');
  });
}

{
  const { verdict } = await sonder([
    reponse({ status: 302, headers: { location: 'https://tracefab-7xgup5zjo-baya.vercel.app/sso-api?nonce=x&url=y' }, body: 'Redirecting' }),
  ]);
  await eprouver('302 vers /sso-api sans secret : contournement ABSENT (code 5, autre cause)', async () => {
    assert.equal(verdict.code, CODES_SONDE.protection);
    assert.equal(verdict.cause, 'contournement_absent');
  });
}

{
  const { verdict, mesures } = await sonder([
    reponse({ status: 307, headers: { location: 'https://tracefab-3oerakg28-baya.vercel.app/api/health' }, body: '' }),
    reponse({ status: 302, headers: { location: 'https://tracefab-3oerakg28-baya.vercel.app/sso-api?nonce=x' }, body: '' }),
  ], { bypass: 'secret-de-test' });
  await eprouver('307 vers un AUTRE deploiement, meme chemin : cible obsolete (code 7), pas une protection', async () => {
    assert.equal(verdict.code, CODES_SONDE.url_obsolete);
    assert.equal(verdict.cause, 'cible_obsolete');
    const hote = mesures.find(([cle]) => cle === '/api/health_redirection_hote');
    assert.equal(hote?.[1], 'tracefab-3oerakg28-baya.vercel.app');
    const chemin = mesures.find(([cle]) => cle === '/api/health_redirection_chemin');
    assert.equal(chemin?.[1], '/api/health', 'le chemin seul identique ne doit pas masquer le changement d hote');
  });
}

{
  const { appelsFetch } = await sonder([
    reponse({ status: 307, headers: { location: 'https://tracefab-3oerakg28-baya.vercel.app/api/health' }, body: '' }),
    reponse({ status: 302, headers: { location: 'https://tracefab-3oerakg28-baya.vercel.app/sso-api?nonce=x' }, body: '' }),
  ], { bypass: 'secret-de-test' });
  await eprouver('le secret de contournement ne suit PAS la redirection vers un autre hote', async () => {
    assert.equal(appelsFetch.length, 2);
    assert.equal(appelsFetch[0].entetes['x-vercel-protection-bypass'], 'secret-de-test');
    assert.equal(appelsFetch[1].entetes['x-vercel-protection-bypass'], undefined);
    assert.equal(appelsFetch[1].redirect, 'manual');
  });
}

{
  const { verdict } = await sonder([reponse({ status: 401, body: 'Authentication required' })]);
  await eprouver('401 : protection (code 5), jamais confondu avec une application', async () => {
    assert.equal(verdict.code, CODES_SONDE.protection);
  });
}

{
  const { verdict } = await sonder([new TypeError('fetch failed')]);
  await eprouver('aucune reponse : injoignable (code 6)', async () => {
    assert.equal(verdict.code, CODES_SONDE.injoignable);
  });
}

{
  const { verdict } = await sonder([reponse({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, error: 'database_unavailable' }),
  })]);
  await eprouver('application joignable mais base indisponible : code 8', async () => {
    assert.equal(verdict.code, CODES_SONDE.application_degradee);
  });
}

{
  const { verdict, mesures } = await sonder([
    reponse({ status: 307, headers: { location: 'https://tracefab-3oerakg28-baya.vercel.app/api/health' }, body: '' }),
    reponse({ status: 200, headers: { 'content-type': 'application/json' }, body: jsonSain }),
  ], { hoteDeploiementAttendu: 'tracefab-3oerakg28-baya.vercel.app' });
  await eprouver('la redirection vers le deploiement ATTENDU est identifiee comme telle', async () => {
    assert.equal(verdict.code, CODES_SONDE.url_obsolete);
    const marqueur = mesures.find(([cle]) => cle === '/api/health_redirection_vers_le_deploiement_attendu');
    assert.equal(marqueur?.[1], true);
  });
}

serveur.close();

const echecs = resultats.filter(([etat]) => etat === 'FAIL');
console.log(`\n  ${resultats.length} controle(s) — ${resultats.length - echecs.length} PASS, ${echecs.length} FAIL\n`);
if (echecs.length) process.exit(1);
console.log('  Selection du deploiement Preview et diagnostic de surface : OK.\n');
