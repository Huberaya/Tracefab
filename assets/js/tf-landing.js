/* ==========================================================================
   TRACEFAB — landing behaviour (v3.0)

     01  Utilities
     02  Header, nav, drawer, language menu
     03  Scroll reveal + number transitions
     04  Hero visual — the Data Core graph
     05  Ecosystem chain matrix
     06  Layer spine
     07  Demo modal

   No animation is decorative: each one explains a relationship
   (a connection, a sequence, a quantity or a state change).
   ========================================================================== */
(function () {
  'use strict';

  /* ── 01 · UTILITIES ──────────────────────────────────────────────────── */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SVGNS = 'http://www.w3.org/2000/svg';

  function t(key, fallback) {
    return window.TF_I18N ? window.TF_I18N.t(key, fallback) : (fallback || '');
  }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var a in attrs) if (attrs[a] != null) node.setAttribute(a, attrs[a]);
    if (text != null) node.textContent = text;
    return node;
  }
  function svg(tag, attrs, text) {
    var node = document.createElementNS(SVGNS, tag);
    if (attrs) for (var a in attrs) if (attrs[a] != null) node.setAttribute(a, attrs[a]);
    if (text != null) node.textContent = text;
    return node;
  }
  function onLang(fn) { document.addEventListener('tf:languagechange', fn); }

  /* ── 02 · HEADER / NAV / DRAWER / LANGUAGE ───────────────────────────── */

  function initHeader() {
    var header = $('.tf-header');
    if (!header) return;

    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 24);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    // Active section highlighting
    var links = $$('.tf-nav a[href^="#"]');
    var targets = links
      .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean);

    if (targets.length && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) {
            a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id);
          });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      targets.forEach(function (s) { io.observe(s); });
    }
  }

  function initDrawer() {
    var burger = $('.tf-burger');
    var drawer = $('.tf-drawer');
    if (!burger || !drawer) return;

    var toggle = function (force) {
      var open = force != null ? force : !drawer.classList.contains('is-open');
      drawer.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    };

    burger.addEventListener('click', function () { toggle(); });
    $$('a, button', drawer).forEach(function (node) {
      node.addEventListener('click', function () { toggle(false); });
    });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 1080) toggle(false); });
  }

  function initLanguage() {
    var wraps = $$('.tf-lang');
    if (!window.TF_I18N) return;

    wraps.forEach(function (wrap) {
      var btn = $('.tf-lang__btn', wrap);
      var menu = $('.tf-lang__menu', wrap);
      var code = $('[data-tf-lang-code]', wrap);
      if (!btn || !menu) return;

      // build items from the supported list — never hard-coded in markup
      menu.innerHTML = '';
      window.TF_I18N.supported.forEach(function (lang) {
        var item = el('button', { type: 'button', class: 'tf-lang__item', 'data-lang': lang });
        item.appendChild(el('span', { 'data-i18n': 'lang.' + lang }, t('lang.' + lang, lang)));
        item.appendChild(el('code', null, lang.toUpperCase()));
        item.addEventListener('click', function () {
          window.TF_I18N.setLanguage(lang);
          menu.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
        });
        menu.appendChild(item);
      });

      var sync = function () {
        var active = window.TF_I18N.lang;
        if (code) code.textContent = active.toUpperCase();
        $$('.tf-lang__item', menu).forEach(function (i) {
          i.setAttribute('aria-current', String(i.getAttribute('data-lang') === active));
        });
      };
      sync();
      onLang(sync);

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !menu.classList.contains('is-open');
        menu.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', function () {
        menu.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    // Mobile inline language row
    var row = $('[data-tf-lang-row]');
    if (row) {
      row.innerHTML = '';
      window.TF_I18N.supported.forEach(function (lang) {
        var b = el('button', { type: 'button', class: 'tf-btn tf-btn--ghost-dark tf-btn--sm', 'data-lang': lang }, lang.toUpperCase());
        b.addEventListener('click', function () { window.TF_I18N.setLanguage(lang); });
        row.appendChild(b);
      });
    }
  }

  /* ── 03 · REVEAL + NUMBER TRANSITIONS ────────────────────────────────── */

  function initReveal() {
    var nodes = $$('[data-tf-reveal]');
    if (!nodes.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('is-revealed'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var delay = entry.target.getAttribute('data-tf-delay');
        if (delay) entry.target.style.setProperty('--tf-reveal-delay', delay + 'ms');
        entry.target.classList.add('is-revealed');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    nodes.forEach(function (n) { io.observe(n); });
  }

  /* Locale-aware number animation.
     The displayed figure comes from the i18n catalogue, so the separators vary:
     "1,248" / "1.248" / "1 248" (grouping) and "92.4%" / "92,4 %" (decimal).
     A separator followed by exactly three digits is grouping; anything else is
     the decimal mark. Spaces (incl. NBSP / narrow NBSP) are always grouping. */
  var countGeneration = 0;

  function parseLocaleNumber(raw) {
    var cleaned = raw.replace(/[\s\u00a0\u202f\u2009]/g, '');
    var lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    var decimalChar = '';
    var groupChar = '';
    if (lastSep !== -1) {
      if (/^\d{3}$/.test(cleaned.slice(lastSep + 1))) groupChar = cleaned[lastSep];
      else decimalChar = cleaned[lastSep];
    }
    var normalised = cleaned.replace(/[.,]/g, function (ch, idx) {
      return (decimalChar && idx === lastSep) ? '.' : '';
    });
    return {
      value: parseFloat(normalised),
      decimals: decimalChar ? (normalised.split('.')[1] || '').length : 0,
      decimalChar: decimalChar,
      groupChar: groupChar,
      groupSpace: groupChar === '' && /[\s\u00a0\u202f\u2009]/.test(raw) ? raw.match(/[\s\u00a0\u202f\u2009]/)[0] : ''
    };
  }

  function animateNumber(node) {
    if (reduceMotion) return;
    var target = node.textContent;
    var match = target.match(/^(\D*?)([\d][\d\s\u00a0\u202f\u2009.,]*\d|\d)(.*)$/);
    if (!match) return;
    var prefix = match[1];
    var suffix = match[3];
    var parsed = parseLocaleNumber(match[2]);
    if (!isFinite(parsed.value)) return;

    var sep = parsed.groupChar || parsed.groupSpace;
    var generation = countGeneration;

    var fmt = function (v) {
      var s = parsed.decimals ? v.toFixed(parsed.decimals) : String(Math.round(v));
      var parts = s.split('.');
      if (sep) parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep);
      return prefix + parts.join(parsed.decimalChar || '.') + suffix;
    };

    var start = performance.now();
    var dur = 1100;
    var step = function (now) {
      if (generation !== countGeneration) return;   /* language switched mid-flight */
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(parsed.value * eased);
      if (p < 1) requestAnimationFrame(step);
      else node.textContent = target;
    };
    node.textContent = fmt(0);
    requestAnimationFrame(step);
  }

  function initCounters() {
    var nodes = $$('[data-tf-count]');
    if (!nodes.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animateNumber(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    nodes.forEach(function (n) { io.observe(n); });
  }

  function initBars() {
    var bars = $$('[data-tf-bar]');
    if (!bars.length) return;
    var apply = function (bar) {
      var span = bar.firstElementChild;
      if (span) span.style.width = bar.getAttribute('data-tf-bar') + '%';
    };
    if (!('IntersectionObserver' in window)) { bars.forEach(apply); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        apply(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.4 });
    bars.forEach(function (b) { io.observe(b); });
  }

  /* ── 04 · HERO VISUAL — THE DATA CORE ────────────────────────────────── */

  var CORE_NODES = [
    'suppliers', 'products', 'materials', 'facilities', 'documents',
    'certifications', 'evidence', 'quality', 'traceability', 'dpp'
  ];

  function initDataCore() {
    var root = $('#tf-core');
    if (!root) return;
    var stage = $('.tf-core__stage', root);
    var inspect = $('.tf-core__inspect', root);
    var list = $('.tf-core__list', root);
    if (!stage) return;

    var W = 1240, H = 624, CX = 620, CY = 312, RX = 468, RY = 214;
    var PW = 154, PH = 54;

    function geometry(i) {
      var angle = (-90 + i * 36) * Math.PI / 180;
      return { x: CX + RX * Math.cos(angle), y: CY + RY * Math.sin(angle), angle: angle };
    }

    function render() {
      stage.innerHTML = '';
      if (list) list.innerHTML = '';

      var root$ = svg('svg', {
        class: 'tf-core__svg',
        viewBox: '0 0 ' + W + ' ' + H,
        role: 'img',
        'aria-label': t('core.title', 'Living data core')
      });

      var defs = svg('defs');
      var grad = svg('radialGradient', { id: 'tf-hub-glow' });
      grad.appendChild(svg('stop', { offset: '0%', 'stop-color': '#0fb97c', 'stop-opacity': '0.30' }));
      grad.appendChild(svg('stop', { offset: '100%', 'stop-color': '#0fb97c', 'stop-opacity': '0' }));
      defs.appendChild(grad);
      root$.appendChild(defs);

      // ambient hub glow + concentric rings = the infrastructure field
      root$.appendChild(svg('circle', { cx: CX, cy: CY, r: 290, fill: 'url(#tf-hub-glow)' }));
      [0.42, 0.62, 0.82].forEach(function (k) {
        root$.appendChild(svg('ellipse', { class: 'tf-ring', cx: CX, cy: CY, rx: (RX * k).toFixed(1), ry: (RY * k).toFixed(1) }));
      });
      root$.appendChild(svg('ellipse', { class: 'tf-ring tf-ring--dashed', cx: CX, cy: CY, rx: RX, ry: RY }));

      var edgeLayer = svg('g');
      var packetLayer = svg('g');
      var nodeLayer = svg('g');
      root$.appendChild(edgeLayer);
      root$.appendChild(packetLayer);
      root$.appendChild(nodeLayer);

      CORE_NODES.forEach(function (key, i) {
        var g = geometry(i);
        var base = 'core.nodes.' + key + '.';

        // --- edge from hub to node
        var hubR = 128;
        var sx = CX + Math.cos(g.angle) * hubR * 1.25;
        var sy = CY + Math.sin(g.angle) * hubR * 0.72;
        var mx = CX + (g.x - CX) * 0.56 + Math.sin(g.angle) * 26;
        var my = CY + (g.y - CY) * 0.56 - Math.cos(g.angle) * 26;
        var d = 'M' + sx.toFixed(1) + ',' + sy.toFixed(1) +
                ' Q' + mx.toFixed(1) + ',' + my.toFixed(1) +
                ' ' + g.x.toFixed(1) + ',' + g.y.toFixed(1);

        var path = svg('path', { class: 'tf-edge', d: d, id: 'tf-edge-' + i });
        path.style.setProperty('--tf-edge-delay', (160 + i * 55) + 'ms');
        edgeLayer.appendChild(path);

        var flow = svg('path', { class: 'tf-edge-flow tf-flow-line', d: d });
        flow.style.setProperty('--tf-edge-delay', (220 + i * 55) + 'ms');
        flow.style.animationDuration = (9 + (i % 4) * 2.5) + 's';
        flow.style.animationDirection = i % 2 ? 'reverse' : 'normal';
        edgeLayer.appendChild(flow);

        if (!reduceMotion) {
          var packet = svg('circle', { r: '2.6', fill: '#2ee39b', opacity: '0.9' });
          var motion = svg('animateMotion', {
            dur: (5.5 + (i % 5) * 1.3) + 's',
            begin: (i * 0.42) + 's',
            repeatCount: 'indefinite',
            rotate: 'auto',
            keyPoints: i % 2 ? '1;0' : '0;1',
            keyTimes: '0;1',
            calcMode: 'linear'
          });
          var mpath = svg('mpath');
          mpath.setAttribute('href', '#tf-edge-' + i);
          mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#tf-edge-' + i);
          motion.appendChild(mpath);
          packet.appendChild(motion);
          packetLayer.appendChild(packet);
        }

        // --- node plate
        var ng = svg('g', { class: 'tf-node-g', tabindex: '0', role: 'button',
          'aria-label': t(base + 'label', key) + ' — ' + t(base + 'value', '') });
        ng.style.setProperty('--tf-node-delay', (260 + i * 62) + 'ms');

        ng.appendChild(svg('rect', {
          class: 'tf-node-plate',
          x: (g.x - PW / 2).toFixed(1), y: (g.y - PH / 2).toFixed(1),
          width: PW, height: PH, rx: 5
        }));
        ng.appendChild(svg('rect', {
          class: 'tf-node-dot',
          x: (g.x - PW / 2 + 11).toFixed(1), y: (g.y - 9).toFixed(1),
          width: 3, height: 3, rx: 0.5
        }));
        ng.appendChild(svg('text', {
          class: 'tf-node-label',
          x: (g.x - PW / 2 + 21).toFixed(1), y: (g.y - 4).toFixed(1)
        }, t(base + 'label', key)));
        ng.appendChild(svg('text', {
          class: 'tf-node-meta',
          x: (g.x - PW / 2 + 21).toFixed(1), y: (g.y + 12).toFixed(1)
        }, t(base + 'meta', '')));
        ng.appendChild(svg('text', {
          class: 'tf-node-label',
          x: (g.x + PW / 2 - 12).toFixed(1), y: (g.y + 5).toFixed(1),
          'text-anchor': 'end',
          style: 'fill:#2ee39b;font-size:11px;'
        }, t(base + 'value', '')));

        var show = function () { openInspector(key, g); };
        var hide = function () { if (inspect) inspect.classList.remove('is-visible'); };
        ng.addEventListener('mouseenter', show);
        ng.addEventListener('mouseleave', hide);
        ng.addEventListener('focus', show);
        ng.addEventListener('blur', hide);
        nodeLayer.appendChild(ng);

        // --- mobile list row
        if (list) {
          var row = el('div', { class: 'tf-core__list-item' });
          row.appendChild(el('span', { class: 'tf-core__list-idx' }, String(i + 1).padStart(2, '0')));
          var mid = el('div');
          mid.appendChild(el('span', { class: 'tf-core__list-name' }, t(base + 'label', key)));
          mid.appendChild(el('span', { class: 'tf-core__list-meta' }, t(base + 'meta', '')));
          row.appendChild(mid);
          row.appendChild(el('span', { class: 'tf-core__list-val' }, t(base + 'value', '')));
          list.appendChild(row);
        }
      });

      // --- central hub
      var hub = svg('g');
      hub.appendChild(svg('rect', { class: 'tf-hub-plate', x: CX - 130, y: CY - 52, width: 260, height: 104, rx: 8 }));
      hub.appendChild(svg('text', { class: 'tf-hub-word', x: CX, y: CY + 3, 'text-anchor': 'middle' }, t('core.hub', 'TRACEFAB')));
      hub.appendChild(svg('text', { class: 'tf-hub-sub', x: CX, y: CY + 28, 'text-anchor': 'middle' }, t('core.hubSub', '')));
      hub.appendChild(svg('line', { x1: CX - 92, y1: CY - 22, x2: CX + 92, y2: CY - 22, stroke: 'rgba(15,185,124,0.3)', 'stroke-width': 1 }));
      root$.appendChild(hub);

      stage.appendChild(root$);
      if (inspect) stage.appendChild(inspect);
    }

    function openInspector(key, g) {
      if (!inspect) return;
      var base = 'core.nodes.' + key + '.';
      inspect.innerHTML = '';
      inspect.appendChild(el('h4', null, t(base + 'label', key)));
      inspect.appendChild(el('p', null, t(base + 'kind', '')));
      var dl = el('dl');
      [1, 2, 3].forEach(function (n) {
        var k = t(base + 'r' + n + 'k', '');
        if (!k) return;
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, t(base + 'r' + n + 'v', '')));
      });
      inspect.appendChild(dl);

      var box = stage.getBoundingClientRect();
      var scale = box.width / 1240;
      var left = g.x * scale;
      var top = g.y * scale;
      // keep the card inside the stage
      var cardW = 248, cardH = 150;
      left = Math.min(Math.max(left - cardW / 2, 8), Math.max(8, box.width - cardW - 8));
      top = (g.y > 312) ? top - cardH - 40 * scale : top + 40 * scale;
      top = Math.min(Math.max(top, 8), Math.max(8, box.height - cardH - 8));
      inspect.style.left = left + 'px';
      inspect.style.top = top + 'px';
      inspect.classList.add('is-visible');
    }

    render();
    onLang(render);

    if (reduceMotion || !('IntersectionObserver' in window)) {
      root.classList.add('is-live');
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { root.classList.add('is-live'); io.disconnect(); }
        });
      }, { threshold: 0.12 });
      io.observe(root);
    }
  }

  /* ── 05 · ECOSYSTEM CHAIN MATRIX ─────────────────────────────────────── */

  var STAGES = [
    { key: 'fiber',    q: 96, status: 'certified',  certs: 3, products: 28, sites: 4 },
    { key: 'material', q: 92, status: 'verified',   certs: 2, products: 46, sites: 1 },
    { key: 'spinning', q: 89, status: 'documented', certs: 4, products: 61, sites: 2 },
    { key: 'weaving',  q: 87, status: 'verified',   certs: 3, products: 12, sites: 2 },
    { key: 'dyeing',   q: 78, status: 'review',     certs: 2, products: 34, sites: 1 },
    { key: 'cutting',  q: 91, status: 'documented', certs: 3, products: 58, sites: 1 },
    { key: 'assembly', q: 94, status: 'certified',  certs: 8, products: 12, sites: 4 },
    { key: 'product',  q: 92, status: 'verified',   certs: 5, products: 1,  sites: 3 },
    { key: 'dpp',      q: 88, status: 'review',     certs: 6, products: 1,  sites: 2 }
  ];

  var DIMENSIONS = [
    { key: 'supplier',    on: true,  mono: false },
    { key: 'country',     on: true,  mono: true },
    { key: 'facility',    on: false, mono: false },
    { key: 'certificate', on: true,  mono: true },
    { key: 'document',    on: false, mono: false },
    { key: 'quality',     on: true,  mono: true },
    { key: 'status',      on: true,  mono: true }
  ];

  function initChain() {
    var root = $('#tf-chain');
    if (!root) return;
    var lensBar = $('[data-tf-lenses]', root);
    var grid = $('[data-tf-grid]', root);
    var vertical = $('[data-tf-vertical]', root);
    var dossier = $('[data-tf-dossier]', root);
    if (!grid) return;

    var active = 6; // Atelier Milano — the brief's reference supplier card

    function cellContent(stage, dim) {
      var base = 'chain.stages.' + stage.key + '.';
      if (dim.key === 'quality') {
        var wrap = el('span', { class: 'tf-cell__q' });
        wrap.appendChild(el('b', null, stage.q + '%'));
        var bar = el('span', { class: 'tf-bar', 'data-tf-bar': stage.q });
        bar.appendChild(el('span'));
        wrap.appendChild(bar);
        return wrap;
      }
      if (dim.key === 'status') return document.createTextNode(t('chain.status.' + stage.status, stage.status));
      return document.createTextNode(t(base + dim.key, ''));
    }

    function renderLenses() {
      if (!lensBar) return;
      lensBar.innerHTML = '';
      lensBar.appendChild(el('span', { class: 'tf-label tf-label--xs', 'data-i18n': 'chain.dimensionsLabel' }, t('chain.dimensionsLabel', 'Dimensions')));
      DIMENSIONS.forEach(function (dim) {
        var b = el('button', { type: 'button', class: 'tf-lens', 'aria-pressed': String(dim.on) }, t('chain.dims.' + dim.key, dim.key));
        b.addEventListener('click', function () {
          var onCount = DIMENSIONS.filter(function (d) { return d.on; }).length;
          if (dim.on && onCount <= 1) return; // always keep one dimension visible
          dim.on = !dim.on;
          b.setAttribute('aria-pressed', String(dim.on));
          renderGrid();
        });
        lensBar.appendChild(b);
      });
    }

    function setActive(i) {
      active = i;
      $$('.tf-stage', grid).forEach(function (s, idx) { s.classList.toggle('is-active', idx === i); });
      $$('.tf-cell', grid).forEach(function (c) {
        c.classList.toggle('is-col-active', c.getAttribute('data-stage') === String(i));
      });
      $$('.tf-vstage', vertical || document.createElement('div')).forEach(function (s, idx) {
        s.classList.toggle('is-active', idx === i);
      });
      renderDossier();
    }

    function renderGrid() {
      grid.innerHTML = '';
      grid.style.setProperty('--tf-stage-count', STAGES.length);

      // header row
      var corner = el('div', { class: 'tf-chain__rowhead tf-chain__rowhead--corner' });
      corner.appendChild(el('span', null, t('chain.stageLabel', 'Stage')));
      grid.appendChild(corner);

      STAGES.forEach(function (stage, i) {
        var base = 'chain.stages.' + stage.key + '.';
        var cell = el('button', { type: 'button', class: 'tf-stage' + (i === active ? ' is-active' : ''), 'data-stage': i });
        cell.appendChild(el('span', { class: 'tf-stage__idx' }, String(i + 1).padStart(2, '0')));
        var node = el('span', { class: 'tf-stage__node' + (i === STAGES.length - 1 ? ' is-terminal' : '') }, t(base + 'name', stage.key));
        if (i < STAGES.length - 1) {
          var link = el('i', { class: 'tf-stage__link' });
          link.style.setProperty('--tf-link-delay', (i * 260) + 'ms');
          node.appendChild(link);
        }
        cell.appendChild(node);
        cell.appendChild(el('span', { class: 'tf-stage__tier' }, t(base + 'tier', '')));
        cell.addEventListener('mouseenter', function () { setActive(i); });
        cell.addEventListener('focus', function () { setActive(i); });
        cell.addEventListener('click', function () { setActive(i); });
        grid.appendChild(cell);
      });

      // dimension rows
      DIMENSIONS.filter(function (d) { return d.on; }).forEach(function (dim) {
        var head = el('div', { class: 'tf-chain__rowhead' });
        head.appendChild(el('span', null, t('chain.dims.' + dim.key, dim.key)));
        grid.appendChild(head);

        STAGES.forEach(function (stage, i) {
          var classes = 'tf-cell' + (dim.mono ? ' tf-cell--mono' : '') + (i === active ? ' is-col-active' : '');
          var c = el('div', { class: classes, 'data-stage': i });
          if (dim.key === 'status') c.setAttribute('data-tone', stage.status);
          c.appendChild(cellContent(stage, dim));
          grid.appendChild(c);
        });
      });

      initBars();
    }

    function renderVertical() {
      if (!vertical) return;
      vertical.innerHTML = '';
      STAGES.forEach(function (stage, i) {
        var base = 'chain.stages.' + stage.key + '.';
        var card = el('button', { type: 'button', class: 'tf-vstage' + (i === active ? ' is-active' : '') });
        var top = el('div', { class: 'tf-vstage__top' });
        top.appendChild(el('span', { class: 'tf-vstage__idx' }, String(i + 1).padStart(2, '0')));
        top.appendChild(el('span', { class: 'tf-vstage__name' }, t(base + 'name', stage.key)));
        var badge = el('span', { class: 'tf-trust', 'data-level': stage.status }, t('chain.status.' + stage.status, stage.status));
        top.appendChild(badge);
        card.appendChild(top);

        var dl = el('dl', { class: 'tf-vstage__rows' });
        ['supplier', 'country', 'certificate'].forEach(function (k) {
          dl.appendChild(el('dt', null, t('chain.dims.' + k, k)));
          dl.appendChild(el('dd', null, t(base + k, '')));
        });
        dl.appendChild(el('dt', null, t('chain.dims.quality', 'Quality')));
        dl.appendChild(el('dd', null, stage.q + '%'));
        card.appendChild(dl);

        card.addEventListener('click', function () { setActive(i); });
        vertical.appendChild(card);
      });
    }

    function renderDossier() {
      if (!dossier) return;
      var stage = STAGES[active];
      var base = 'chain.stages.' + stage.key + '.';
      dossier.innerHTML = '';

      var idCol = el('div', { class: 'tf-dossier__id' });
      idCol.appendChild(el('span', { class: 'tf-label tf-label--accent' }, t(base + 'name', '') + ' · ' + t(base + 'tier', '')));
      idCol.appendChild(el('h3', { class: 'tf-dossier__name' }, t(base + 'dossierName', '')));

      var facts = el('div', { class: 'tf-dossier__facts' });
      [t(base + 'country', ''), t(base + 'facility', ''), t(base + 'certificate', ''), t(base + 'document', '')]
        .filter(Boolean)
        .forEach(function (f) { facts.appendChild(el('span', { class: 'tf-dossier__fact' }, f)); });
      idCol.appendChild(facts);
      idCol.appendChild(el('p', { class: 'tf-dossier__desc' }, t(base + 'desc', '')));
      dossier.appendChild(idCol);

      var metrics = el('div', { class: 'tf-dossier__metrics' });
      var items = [
        { v: stage.q + '%', l: t('chain.metricLabels.quality', 'Data quality'), accent: true },
        { v: String(stage.certs), l: t('chain.metricLabels.certificates', 'Certificates') },
        { v: String(stage.products), l: t('chain.metricLabels.products', 'Products') },
        { v: String(stage.sites), l: t('chain.metricLabels.sites', 'Sites') }
      ];
      items.forEach(function (m) {
        var box = el('div', { class: 'tf-dossier__metric' });
        box.appendChild(el('b', { class: m.accent ? 'is-accent' : null }, m.v));
        box.appendChild(el('em', null, m.l));
        metrics.appendChild(box);
      });
      var trust = el('div', { class: 'tf-dossier__metric' });
      trust.appendChild(el('span', { class: 'tf-trust', 'data-level': stage.status }, t('chain.status.' + stage.status, stage.status)));
      trust.appendChild(el('em', null, t('chain.metricLabels.evidence', 'Evidence')));
      metrics.appendChild(trust);
      dossier.appendChild(metrics);
    }

    function renderAll() {
      renderLenses();
      renderGrid();
      renderVertical();
      renderDossier();
    }

    renderAll();
    onLang(renderAll);
  }

  /* ── 06 · LAYER SPINE ────────────────────────────────────────────────── */

  function initSpine() {
    var layers = $$('.tf-layer');
    if (!layers.length) return;
    layers.forEach(function (layer) {
      layer.addEventListener('mouseenter', function () {
        layers.forEach(function (l) { l.classList.remove('is-open'); });
        layer.classList.add('is-open');
      });
      layer.addEventListener('focus', function () {
        layers.forEach(function (l) { l.classList.remove('is-open'); });
        layer.classList.add('is-open');
      });
    });
  }

  /* ── 07 · DEMO MODAL ─────────────────────────────────────────────────── */

  function initModal() {
    var modal = $('#tf-demo-modal');
    if (!modal) return;
    var panel = $('.tf-modal__panel', modal);
    var lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      modal.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      var first = $('input, select, button', panel);
      if (first) first.focus();
    }
    function close() {
      modal.classList.remove('is-open');
      document.body.style.overflow = '';
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    $$('[data-tf-open-demo]').forEach(function (b) { b.addEventListener('click', open); });
    $$('[data-tf-close-demo]').forEach(function (b) { b.addEventListener('click', close); });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('is-open')) close(); });

    var form = $('form', modal);
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var done = $('[data-tf-demo-success]', modal);
        if (done) { done.hidden = false; }
        form.hidden = true;
      });
    }
  }

  /* ── BOOT ────────────────────────────────────────────────────────────── */

  function boot() {
    initHeader();
    initDrawer();
    initReveal();
    initBars();
    initSpine();
    initModal();

    var start = function () {
      initLanguage();
      initDataCore();
      initChain();
      /* after the catalogue is applied, so the counter animates the localised
         figure ("1 248" / "1.248") instead of the English markup literal */
      initCounters();
    };
    onLang(function () { countGeneration += 1; });
    if (window.TF_I18N && window.TF_I18N.ready) window.TF_I18N.ready.then(start);
    else start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
