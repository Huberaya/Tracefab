/**
 * Interception locale de `fetch` pour les tests HORS LIGNE du diagnostic.
 *
 * Deux regles, dans cet ordre :
 *
 *   1. SANS `TF_FAKE_VERCEL`, ce module ne fait RIEN. Il n'est charge que par
 *      `node --import`, et sans la variable il laisse `fetch` intact : aucun
 *      test ne peut modifier le comportement reseau du script en production.
 *   2. AVEC `TF_FAKE_VERCEL`, il devient fail-closed : toute requete qui ne
 *      vise pas `api.vercel.com` est REFUSEE, et seules les routes presentes
 *      dans la fixture repondent. Une route absente est un 404, jamais un appel
 *      reel. Une methode autre que GET est refusee avant tout traitement.
 *
 * Le journal des requetes ne retient que la methode et le chemin : ni le jeton,
 * ni les entetes, ni les parametres.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const cheminFixture = process.env.TF_FAKE_VERCEL;
if (cheminFixture) {
  const fixture = JSON.parse(readFileSync(cheminFixture, 'utf8'));
  const journal = [];

  globalThis.fetch = async (entree, options = {}) => {
    // `fetch` accepte une chaine, un objet URL ou un objet Request : les trois
    // formes existent dans le depot, une seule etait traitee et la deuxieme
    // faisait echouer la fixture sur « Invalid URL ».
    const url =
      entree instanceof URL
        ? entree
        : new URL(typeof entree === 'string' ? entree : String(entree?.url ?? ''));
    const methode = (options.method || 'GET').toUpperCase();
    journal.push({ methode, chemin: url.pathname });
    if (process.env.TF_FAKE_JOURNAL) {
      writeFileSync(process.env.TF_FAKE_JOURNAL, JSON.stringify(journal, null, 2));
    }

    if (url.hostname !== 'api.vercel.com') {
      throw new Error(`hors-ligne : requete refusee vers ${url.hostname}`);
    }
    if (methode !== 'GET') {
      throw new Error(`hors-ligne : methode ${methode} refusee (lecture seule)`);
    }

    const route = fixture[url.pathname];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });

    const entetes = { 'content-type': route.texte ? 'text/plain' : 'application/json' };
    return new Response(route.texte ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: entetes,
    });
  };
}
