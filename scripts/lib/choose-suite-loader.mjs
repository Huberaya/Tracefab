/**
 * Quel chargeur pour quel fichier de suite ?
 *
 * POURQUOI CETTE FONCTION EXISTE
 *
 * Le lanceur commun des suites destructives (`scripts/run-db-suite.mjs`) doit
 * choisir entre node nu et tsx. Une suite peut etre un fichier .ts, mais elle
 * peut aussi etre un .mjs qui IMPORTE des modules TypeScript du depot
 * (routeurs, adaptateurs, moteurs metier). node nu ne resout alors pas les
 * specifiers en `.js` qui pointent vers un `.ts` : la suite meurt sur un
 * ERR_MODULE_NOT_FOUND qui ne parle ni de la base, ni de la garde de cible.
 *
 * La decision suit donc le CONTENU de la suite, pas seulement son extension.
 * C'est la meme regle que celle appliquee aux fichiers .ts : confier le
 * fichier a un chargeur capable de le lire.
 *
 * LIMITE ASSUMEE : la detection est statique, donc un fichier qui ne fait que
 * CITER un chemin TypeScript dans un commentaire sera confie a tsx. Le faux
 * positif est benin — tsx execute aussi du JavaScript — alors qu'un faux
 * negatif rendrait la suite inexecutable. Le sens de l'erreur est choisi en
 * consequence. Les formes couvertes sont `import ... from '.../x.ts'`,
 * `import('.../x.ts')` et `from '.../x.ts'`.
 */
const IMPORTE_TYPESCRIPT = /(?:^|[^\w$])(?:import|from)\s*\(?\s*['"][^'"]+\.tsx?['"]/;

export function chooseSuiteLoader(chemin, source = '') {
  const fichier = String(chemin || '');
  if (fichier.endsWith('.ts')) return 'tsx';
  if (IMPORTE_TYPESCRIPT.test(String(source || ''))) return 'tsx';
  return 'node';
}
