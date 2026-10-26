/* ==========================================================================
   Prechargement conditionnel du SDK Clerk.

   Le SDK n'est utile qu'aux ecrans connectes. En mode ?demo=1, la console
   n'appelle jamais Clerk : le prechargement inconditionnel declenche pourtant
   une requete vers un CDN tiers sur chaque visite. Dans un reseau qui bloque
   ce CDN, elle produit une erreur console (et pollue les suites E2E qui
   verifient l'absence d'erreurs JavaScript), pour aucun benefice.

   Le lien est donc cree ici, uniquement hors demonstration. Le script est
   charge de facon synchrone dans le <head> : le prechargement demarre
   toujours avant la reponse de /api/config, comme avec la balise statique.
   ========================================================================== */
(function () {
  'use strict';
  if (new URLSearchParams(window.location.search).get('demo') === '1') return;
  var link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'script';
  link.crossOrigin = 'anonymous';
  link.href = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
  document.head.appendChild(link);
})();
