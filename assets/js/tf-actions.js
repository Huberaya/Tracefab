/* Delegation d'evenements TRACEFAB.
 *
 * Remplace les attributs onclick / onchange / onsubmit, que la CSP interdit
 * des lors que script-src n'autorise plus 'unsafe-inline'.
 *
 * Un seul ecouteur par type d'evenement, pose sur document. closest()
 * retrouve l'element porteur, ce qui reproduit exactement le comportement
 * d'un attribut inline : un clic sur un enfant declenche le gestionnaire du
 * parent, comme le faisait la remontee naturelle de l'evenement.
 *
 * Le gestionnaire est appele avec this = l'element porteur, et l'evenement
 * en premier argument. Les corps repris tels quels continuent donc de
 * fonctionner sans modification.
 */
(function () {
  'use strict';
  var REG = Object.create(null);

  REG.nav = function () { location.href = this.getAttribute('data-tf-arg'); };
  REG.open = function () { window.open(this.getAttribute('data-tf-arg'), '_blank'); };
  REG.reload = function () { location.reload(); };

  window.TFActions = {
    register: function (map) {
      for (var key in map) if (Object.prototype.hasOwnProperty.call(map, key)) REG[key] = map[key];
    },
  };

  // 'input' sert la recherche au fil de la frappe. Il bulle comme les autres,
  // et le filtre data-tf-on empeche tout gestionnaire existant de le recevoir :
  // sans data-tf-on="input" explicite, un element reste sur 'click'.
  ['click', 'change', 'submit', 'input'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var el = target.closest('[data-tf-act]');
      if (!el) return;
      if ((el.getAttribute('data-tf-on') || 'click') !== type) return;
      var fn = REG[el.getAttribute('data-tf-act')];
      if (typeof fn === 'function') fn.call(el, event);
    }, false);
  });
})();
