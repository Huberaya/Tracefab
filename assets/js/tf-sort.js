/* Tri de tableau TRACEFAB.
 *
 * Module partage, sans DOM. `globalThis` vaut `window` dans un navigateur et
 * existe aussi dans Node : la meme source sert donc la console ET les tests,
 * qui l'executent au lieu de se contenter de la relire.
 *
 * Deux regles, toutes deux visibles par l'utilisateur :
 *
 * 1. Les valeurs vides tombent TOUJOURS en dernier, quel que soit le sens.
 *    Un tri descendant sur la categorie ne doit pas faire remonter en tete les
 *    produits qui n'en ont pas : « pas de donnee » n'est pas une valeur haute,
 *    c'est une absence. Inverser le sens inverse l'ordre des valeurs, pas la
 *    place des manquants.
 *
 * 2. A valeur egale, un critere de departage explicite tranche. Sans lui,
 *    l'ordre de deux produits homonymes dependrait de l'ordre renvoye par
 *    l'API, donc du cache et de la pagination : le meme clic donnerait deux
 *    resultats differents, et l'utilisateur croirait avoir perdu une ligne.
 */
(function () {
  'use strict';

  /* Sans depliage des accents, « Trousers » se trie mais « Dérogation » tombe
   * apres tous les « D » sans accent. NFD + suppression des diacritiques rend
   * l'ordre indifferent aux accents comme a la casse. */
  function sansAccents(valeur) {
    return String(valeur === null || valeur === undefined ? '' : valeur)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function estVide(valeur) {
    return valeur === '' || valeur === null || valeur === undefined;
  }

  /* `a` et `b` portent { valeur, repli }. Retourne un nombre, jamais un
   * booleen : Array.prototype.sort attend une difference signee. */
  function comparer(a, b, sens) {
    const ea = estVide(a.valeur);
    const eb = estVide(b.valeur);
    if (ea || eb) {
      if (ea && eb) return String(a.repli).localeCompare(String(b.repli));
      return ea ? 1 : -1;
    }
    const va = a.valeur;
    const vb = b.valeur;
    let delta;
    if (typeof va === 'number' && typeof vb === 'number') {
      delta = va - vb;
    } else {
      delta = String(va).localeCompare(String(vb));
    }
    if (delta !== 0) return sens === 'desc' ? -delta : delta;
    return String(a.repli).localeCompare(String(b.repli));
  }

  /**
   * Trie SANS muter la liste recue : l'appelant la conserve pour compter le
   * total avant filtrage, et une mutation silencieuse fausserait ce compte.
   *
   * @param {Array}    lignes   les lignes a trier
   * @param {Object}   colonnes { cle: (ligne) => valeur }
   * @param {Object}   tri      { champ, sens } — champ inconnu : ordre d'origine
   * @param {Function} [repli]  departage, (ligne) => chaine
   * @returns {Array} nouvelle liste
   */
  function trier(lignes, colonnes, tri, repli) {
    const liste = Array.isArray(lignes) ? lignes : [];
    if (!tri || !tri.champ || !Object.prototype.hasOwnProperty.call(colonnes || {}, tri.champ)) {
      return liste.slice();
    }
    const acces = colonnes[tri.champ];
    const sens = tri.sens === 'desc' ? 'desc' : 'asc';
    return liste
      .map(function (ligne, index) {
        return {
          ligne: ligne,
          index: index,
          valeur: acces(ligne),
          repli: repli ? repli(ligne) : '',
        };
      })
      .sort(function (a, b) { return comparer(a, b, sens) || a.index - b.index; })
      .map(function (entree) { return entree.ligne; });
  }

  /* Bascule d'etat d'un en-tete : un second clic sur la meme colonne inverse le
   * sens, un clic sur une autre colonne la reprend en ascendant. C'est le
   * comportement attendu d'un tableau trie, et le seul qui se devine sans
   * notice. */
  function basculer(tri, champ) {
    if (tri && tri.champ === champ) {
      return { champ: champ, sens: tri.sens === 'desc' ? 'asc' : 'desc' };
    }
    return { champ: champ, sens: 'asc' };
  }

  /* Valeur d'aria-sort pour un en-tete. Les trois valeurs sont celles de la
   * specification WAI-ARIA ; « none » est explicite plutot que tu, pour qu'un
   * lecteur d'ecran annonce l'absence de tri courant. */
  function ariaSort(tri, champ) {
    if (!tri || tri.champ !== champ) return 'none';
    return tri.sens === 'desc' ? 'descending' : 'ascending';
  }

  globalThis.TFSort = {
    sansAccents: sansAccents,
    estVide: estVide,
    comparer: comparer,
    trier: trier,
    basculer: basculer,
    ariaSort: ariaSort,
  };
})();
