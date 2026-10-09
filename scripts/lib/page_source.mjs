import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source complete d'une page.
 *
 * Le JavaScript des pages a quitte le HTML pour /assets/js/, afin que la CSP
 * puisse interdire 'unsafe-inline'. Les tests qui lisaient
 * `brand-console/index.html` pour y verifier du comportement cherchaient
 * donc dans un fichier qui ne contient plus ce comportement.
 *
 * Cette fonction leur rend exactement les octets qu'ils lisaient avant : le
 * HTML, avec ses propres blocs de script remis a leur place. Aucune
 * assertion n'est affaiblie, aucune n'est contournee — seule change la
 * question de savoir ou le code se trouve sur le disque.
 *
 * La liste des fichiers a reinserer vient d'un manifeste ecrit par le
 * codemod, pas d'une deduction sur les noms. Deduire aurait fini par
 * reinserer un script tiers que la page n'a jamais contenu, et un test
 * verdit alors pour une mauvaise raison.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, 'assets/js/.page-bundles.json');

const bundles = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};

export function pageSource(relativePath) {
  const key = relativePath.replace(/^\.\//, '').replace(/^\//, '');
  const html = readFileSync(join(ROOT, key), 'utf8');
  const own = bundles[key];
  if (!own || !own.length) return html;
  const owned = new Set(own);
  return html.replace(
    /<script src="(\/assets\/js\/[^"]+)"([^>]*)><\/script>/g,
    (whole, href, attrs) => {
      // Les references portent une empreinte de contenu (?v=9f2c41b8) pour que
      // /assets/js/ puisse etre servi en immuable. Le manifeste, lui, indexe
      // les chemins nus. Sans retirer la requete ici, aucune page ne serait
      // plus reconnue : les tests cesseraient d'inspecter le JS des pages tout
      // en restant verts, ce qui est pire que de les voir echouer.
      const nu = href.split('?')[0];
      if (!owned.has(nu)) return whole;
      const file = join(ROOT, nu.slice(1));
      if (!existsSync(file)) return whole;
      return `<script${attrs}>\n${readFileSync(file, 'utf8')}\n</script>`;
    },
  );
}

export default pageSource;
