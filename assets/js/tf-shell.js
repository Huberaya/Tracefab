/* ==========================================================================
   TRACEFAB SHELL — v1.0 (Chantier 04)

   Command palette (Ctrl/Cmd+K), recherche globale et centre de
   notifications, partages entre la Brand Console et le Supplier Portal.

   Contrat d'integration (l'hote ne fournit que des donnees deja chargees :
   le shell n'invente jamais rien et n'appelle aucune API lui-meme) :

     window.TFShell.init({
       t: (key, fallback) => string,          // i18n de l'hote
       providers: () => ({
         nav:          [{ id, label, icon?, run }],
         actions:      [{ id, label, icon?, run }],
         entities:     [{ id, label, hint?, run }],
         notifications:[{ id, severity, title, detail?, actionLabel?, run? }]
       })
     });

   L'hote place des declencheurs ou il le souhaite :
     <button data-shell-open="palette">…</button>
     <button data-shell-open="notifications">…</button>
     <span data-shell-badge></span>            // compteur de notifications
   ========================================================================== */
(function () {
  'use strict';

  if (window.TFShell) return; // deja charge : une seule instance par page

  var config = null;
  var paletteOverlay = null;
  var paletteInput = null;
  var paletteList = null;
  var notifOverlay = null;
  var notifList = null;
  var activeIndex = 0;
  var flatItems = [];
  var lastFocus = null;
  var isOpen = false;

  function t(key, fallback) {
    if (config && typeof config.t === 'function') {
      var value = config.t(key, null);
      if (typeof value === 'string' && value) return value;
    }
    return fallback || key;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normalize(list) {
    return Array.isArray(list) ? list.filter(function (x) { return x && x.label; }) : [];
  }

  function providers() {
    var p = { nav: [], actions: [], entities: [], notifications: [] };
    if (config && typeof config.providers === 'function') {
      try { p = config.providers() || p; } catch (e) { p = { nav: [], actions: [], entities: [], notifications: [] }; }
    }
    p.nav = normalize(p.nav);
    p.actions = normalize(p.actions);
    p.entities = normalize(p.entities);
    p.notifications = normalize(p.notifications);
    return p;
  }

  /* -- Badge ---------------------------------------------------------------- */

  function updateBadge() {
    var count = providers().notifications.length;
    var els = document.querySelectorAll('[data-shell-badge]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = count > 0 ? String(count) : '';
      els[i].hidden = count === 0;
      els[i].classList.add('tfsh-badge');
    }
  }

  /* -- Palette --------------------------------------------------------------- */

  function buildOverlays() {
    if (paletteOverlay) return;

    paletteOverlay = document.createElement('div');
    paletteOverlay.className = 'tfsh-overlay';
    paletteOverlay.setAttribute('data-shell-role', 'palette');
    paletteOverlay.innerHTML =
      '<div class="tfsh-panel" role="dialog" aria-modal="true" aria-label="' + esc(t('shell.palette.title', 'Command palette')) + '">' +
        '<div class="tfsh-input-row">' +
          '<span class="tfsh-glyph" aria-hidden="true">⌕</span>' +
          '<input class="tfsh-input" type="text" role="combobox" aria-expanded="true" ' +
            'aria-controls="tfsh-palette-list" aria-autocomplete="list">' +
        '</div>' +
        '<ul class="tfsh-list" id="tfsh-palette-list" role="listbox"></ul>' +
        '<div class="tfsh-foot">' +
          '<span><kbd>↑</kbd><kbd>↓</kbd> ' + esc(t('shell.palette.move', 'navigate')) + '</span>' +
          '<span><kbd>↵</kbd> ' + esc(t('shell.palette.open', 'open')) + '</span>' +
          '<span><kbd>Esc</kbd> ' + esc(t('shell.palette.close', 'close')) + '</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(paletteOverlay);
    paletteInput = paletteOverlay.querySelector('.tfsh-input');
    paletteList = paletteOverlay.querySelector('.tfsh-list');

    paletteOverlay.addEventListener('mousedown', function (e) {
      if (e.target === paletteOverlay) closeOverlays();
    });
    paletteInput.addEventListener('input', function () { renderPalette(); });
    paletteInput.addEventListener('keydown', onPaletteKey);

    notifOverlay = document.createElement('div');
    notifOverlay.className = 'tfsh-overlay';
    notifOverlay.setAttribute('data-shell-role', 'notifications');
    notifOverlay.innerHTML =
      '<div class="tfsh-panel tfsh-panel--side" role="dialog" aria-modal="true" aria-label="' + esc(t('shell.notifications.title', 'Notifications')) + '">' +
        '<div class="tfsh-head">' +
          '<h2>' + esc(t('shell.notifications.title', 'Notifications')) + '</h2>' +
          '<button type="button" class="tfsh-close" data-shell-close aria-label="' + esc(t('shell.common.close', 'Close')) + '">✕</button>' +
        '</div>' +
        '<div class="tfsh-list" data-shell-notif-list></div>' +
      '</div>';
    document.body.appendChild(notifOverlay);
    notifList = notifOverlay.querySelector('[data-shell-notif-list]');
    notifOverlay.addEventListener('mousedown', function (e) {
      if (e.target === notifOverlay) closeOverlays();
    });
    notifOverlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-shell-close]')) closeOverlays();
    });
  }

  function matches(item, q) {
    if (!q) return true;
    var hay = ((item.label || '') + ' ' + (item.hint || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderPalette() {
    if (!paletteList) return;
    var q = (paletteInput.value || '').trim().toLowerCase();
    var p = providers();
    var groups = [
      { name: t('shell.palette.navigation', 'Navigation'), items: p.nav.filter(function (x) { return matches(x, q); }) },
      { name: t('shell.palette.actions', 'Actions'), items: p.actions.filter(function (x) { return matches(x, q); }) },
      { name: t('shell.palette.entities', 'Search'), items: p.entities.filter(function (x) { return matches(x, q); }).slice(0, 30) }
    ];

    flatItems = [];
    var html = '';
    groups.forEach(function (g) {
      if (!g.items.length) return;
      html += '<li class="tfsh-group" aria-hidden="true">' + esc(g.name) + '</li>';
      g.items.forEach(function (item) {
        var idx = flatItems.length;
        flatItems.push(item);
        html += '<li role="option" id="tfsh-opt-' + idx + '" aria-selected="false">' +
          '<button type="button" class="tfsh-item" data-shell-index="' + idx + '">' +
            '<span class="tfsh-item__icon" aria-hidden="true">' + esc(item.icon || '·') + '</span>' +
            '<span class="tfsh-item__label">' + esc(item.label) + '</span>' +
            (item.hint ? '<span class="tfsh-item__hint">' + esc(item.hint) + '</span>' : '') +
          '</button></li>';
      });
    });
    if (!flatItems.length) {
      html = '<li class="tfsh-empty">' + esc(t('shell.palette.noResults', 'No result. Try another word.')) + '</li>';
    }
    paletteList.innerHTML = html;
    activeIndex = flatItems.length ? 0 : -1;
    paintActive();
  }

  function paintActive() {
    var options = paletteList.querySelectorAll('li[role="option"]');
    for (var i = 0; i < options.length; i++) {
      var btn = options[i].querySelector('.tfsh-item');
      var selected = i === activeIndex;
      options[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      if (btn) btn.classList.toggle('is-active', selected);
    }
    if (activeIndex >= 0) {
      paletteInput.setAttribute('aria-activedescendant', 'tfsh-opt-' + activeIndex);
      var el = paletteList.querySelector('#tfsh-opt-' + activeIndex);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } else {
      paletteInput.removeAttribute('aria-activedescendant');
    }
  }

  function runItem(item) {
    closeOverlays();
    if (item && typeof item.run === 'function') {
      try { item.run(); } catch (e) { /* l'action de l'hote reste maitresse */ }
    }
  }

  function onPaletteKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatItems.length) { activeIndex = (activeIndex + 1) % flatItems.length; paintActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatItems.length) { activeIndex = (activeIndex - 1 + flatItems.length) % flatItems.length; paintActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && flatItems[activeIndex]) runItem(flatItems[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeOverlays();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // le focus reste dans la palette
    }
  }

  /* -- Notifications ---------------------------------------------------------- */

  function renderNotifications() {
    if (!notifList) return;
    var items = providers().notifications;
    if (!items.length) {
      notifList.innerHTML = '<div class="tfsh-empty">' + esc(t('shell.notifications.empty', 'Nothing needs your attention right now.')) + '</div>';
      return;
    }
    notifList.innerHTML = items.map(function (n, i) {
      var severity = n.severity === 'critical' || n.severity === 'warning' || n.severity === 'info' ? n.severity : 'info';
      return '<div class="tfsh-notif tfsh-notif--' + severity + '" data-shell-notif="' + i + '">' +
        '<span class="tfsh-notif__dot" aria-hidden="true"></span>' +
        '<div>' +
          '<p class="tfsh-notif__title">' + esc(n.title) + '</p>' +
          (n.detail ? '<p class="tfsh-notif__detail">' + esc(n.detail) + '</p>' : '') +
        '</div>' +
        (n.actionLabel && n.run
          ? '<button type="button" class="tfsh-notif__action" data-shell-notif-run="' + i + '">' + esc(n.actionLabel) + ' →</button>'
          : '<span></span>') +
      '</div>';
    }).join('');
  }

  notifClickHandler();
  function notifClickHandler() {
    document.addEventListener('click', function (e) {
      var runBtn = e.target.closest('[data-shell-notif-run]');
      if (runBtn && notifOverlay && notifOverlay.classList.contains('is-open')) {
        var idx = Number(runBtn.getAttribute('data-shell-notif-run'));
        var item = providers().notifications[idx];
        if (item) runItem(item);
      }
    });
  }

  /* -- Ouverture / fermeture --------------------------------------------------- */

  function open(which) {
    buildOverlays();
    lastFocus = document.activeElement;
    closeOverlays(true);
    isOpen = true;
    if (which === 'notifications') {
      renderNotifications();
      notifOverlay.classList.add('is-open');
      var close = notifOverlay.querySelector('.tfsh-close');
      if (close) close.focus();
    } else {
      paletteOverlay.classList.add('is-open');
      paletteInput.value = '';
      paletteInput.placeholder = t('shell.palette.placeholder', 'Search or jump to…');
      renderPalette();
      paletteInput.focus();
    }
  }

  function closeOverlays(silent) {
    if (paletteOverlay) paletteOverlay.classList.remove('is-open');
    if (notifOverlay) notifOverlay.classList.remove('is-open');
    isOpen = false;
    if (!silent && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* -- Ecoutes globales --------------------------------------------------------- */

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (isOpen && paletteOverlay && paletteOverlay.classList.contains('is-open')) closeOverlays();
      else open('palette');
    } else if (e.key === 'Escape' && isOpen) {
      closeOverlays();
    }
  });

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-shell-open]');
    if (trigger) {
      e.preventDefault();
      open(trigger.getAttribute('data-shell-open') === 'notifications' ? 'notifications' : 'palette');
      return;
    }
    var itemBtn = e.target.closest('[data-shell-index]');
    if (itemBtn && paletteOverlay && paletteOverlay.classList.contains('is-open')) {
      var idx = Number(itemBtn.getAttribute('data-shell-index'));
      if (flatItems[idx]) runItem(flatItems[idx]);
    }
  });

  /* Rafraichissement periodique du badge : l'hote recharge ses donnees sans
     prevenir le shell ; un battement leger suffit, aucun polling agressif. */
  setInterval(function () {
    if (!isOpen) updateBadge();
  }, 4000);

  window.TFShell = {
    init: function (cfg) {
      config = cfg || {};
      buildOverlays();
      updateBadge();
    },
    refresh: function () { updateBadge(); },
    openPalette: function () { open('palette'); },
    openNotifications: function () { open('notifications'); },
    close: function () { closeOverlays(); }
  };
})();
