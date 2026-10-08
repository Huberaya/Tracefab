/* ==========================================================================
   TRACEFAB — TFTables : moteur de tables modernes (Chantier 05).

   Purement DOM, aucun appel reseau : il n'opere que sur les tables deja
   rendues par l'application hote. Ajoute, pour chaque
   `table[data-tftable]` :
     - tri par colonne (th[data-tfsort], numerique-aware, aria-sort) ;
     - filtre de lignes (insensible aux accents) ;
     - visibilite des colonnes (menu a cases a cocher) ;
     - export CSV des lignes visibles ;
     - vues sauvegardees (localStorage, par id de table) ;
     - selection massive + actions de groupe fournies par l'hote
       (TFTables.register) — l'hote decide des actions reelles, le moteur
       n'invente rien.

   L'hote monte le moteur apres chaque rendu :
     TFTables.setT((key, fallback) => ...);
     TFTables.register('products', { bulk: [...] });
     TFTables.mount(app);

   L'etat courant (tri/filtre/colonnes) est memorise en memoire par id de
   table pour survivre aux re-rendus de l'hote ; les vues sauvegardees sont
   persistees sous `tracefab.tableViews.<id>`.
   ========================================================================== */
(function () {
  'use strict';
  if (window.TFTables) return; // une seule instance par page

  var registry = {};          // id -> { exportName, bulk: [{id,label,run}] }
  var mem = {};               // id -> { sortCol, sortDir, filter, hidden: [] }
  var tr = function (key, fallback) { return fallback; };

  function setT(fn) { if (typeof fn === 'function') tr = fn; }
  function register(id, config) { registry[id] = config || {}; }

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function num(v) {
    var m = String(v).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function cellText(row, idx) {
    var cell = row.cells[idx];
    if (!cell) return '';
    if (cell.hasAttribute('data-export')) return cell.getAttribute('data-export');
    return (cell.textContent || '').trim();
  }

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(filename, rows) {
    var text = rows.map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  function storageKey(id) { return 'tracefab.tableViews.' + id; }

  function loadViews(id) {
    try { return JSON.parse(localStorage.getItem(storageKey(id))) || []; }
    catch (e) { return []; }
  }
  function saveViews(id, views) {
    try { localStorage.setItem(storageKey(id), JSON.stringify(views)); } catch (e) { /* stockage indisponible */ }
  }

  /* -- colonne "actions" et colonne bulk exclues de la gestion colonnes ---- */
  function dataColumns(table) {
    var heads = Array.prototype.slice.call(table.tHead ? table.tHead.rows[0].cells : []);
    return heads.map(function (th, i) { return { th: th, index: i }; })
      .filter(function (c) {
        if (c.th.hasAttribute('data-tf-bulk')) return false;
        if (!(c.th.textContent || '').trim()) return false; // colonne actions
        return true;
      });
  }

  function applyHidden(table, hidden) {
    dataColumns(table).forEach(function (c) {
      var hide = hidden.indexOf((c.th.textContent || '').trim()) !== -1;
      c.th.style.display = hide ? 'none' : '';
      Array.prototype.forEach.call(table.tBodies[0] ? table.tBodies[0].rows : [], function (row) {
        var cell = row.cells[c.index];
        if (cell) cell.style.display = hide ? 'none' : '';
      });
    });
  }

  function sortTable(table, colIndex, dir) {
    var body = table.tBodies[0];
    if (!body) return;
    var rows = Array.prototype.slice.call(body.rows).filter(function (r) { return !r.hasAttribute('data-tf-empty'); });
    rows.sort(function (a, b) {
      var va = cellText(a, colIndex), vb = cellText(b, colIndex);
      var na = num(va), nb = num(vb);
      var cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : norm(va).localeCompare(norm(vb));
      return dir === 'desc' ? -cmp : cmp;
    });
    rows.forEach(function (r) { body.appendChild(r); });
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, i) {
      if (!th.hasAttribute('data-tfsort')) { th.removeAttribute('aria-sort'); return; }
      if (i === colIndex) th.setAttribute('aria-sort', dir === 'desc' ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    });
  }

  function applyFilter(table, query) {
    var body = table.tBodies[0];
    if (!body) return;
    var q = norm(query);
    var visible = 0;
    Array.prototype.forEach.call(body.rows, function (row) {
      if (row.hasAttribute('data-tf-empty')) return;
      var match = !q || norm(row.textContent).indexOf(q) !== -1;
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    var notice = table.parentElement.querySelector('.tft-empty');
    if (notice) notice.hidden = visible !== 0;
    updateBulk(table);
  }

  function visibleRows(table) {
    var body = table.tBodies[0];
    if (!body) return [];
    return Array.prototype.slice.call(body.rows).filter(function (r) {
      return !r.hasAttribute('data-tf-empty') && r.style.display !== 'none';
    });
  }

  function exportTable(table, id, onlySelected) {
    var cfg = registry[id] || {};
    var cols = dataColumns(table).filter(function (c) { return c.th.style.display !== 'none'; });
    var header = cols.map(function (c) { return (c.th.getAttribute('data-export') || c.th.textContent || '').trim(); });
    var rows = visibleRows(table);
    if (onlySelected) rows = rows.filter(function (r) { var cb = r.querySelector('[data-tf-row-check]'); return cb && cb.checked; });
    var out = [header].concat(rows.map(function (r) {
      return cols.map(function (c) { return cellText(r, c.index); });
    }));
    var stamp = new Date().toISOString().slice(0, 10);
    downloadCsv((cfg.exportName || ('tracefab-' + id)) + '-' + stamp + '.csv', out);
  }

  function updateBulk(table) {
    var bar = table.parentElement.querySelector('.tft-bulkbar');
    if (!bar) return;
    var checked = table.querySelectorAll('[data-tf-row-check]:checked');
    var count = checked.length;
    bar.hidden = count === 0;
    var label = bar.querySelector('.tft-bulkcount');
    if (label) label.textContent = count + ' ' + tr('command.table.selected', 'selected');
    var selectAll = table.querySelector('[data-tf-check-all]');
    if (selectAll) {
      var boxes = Array.prototype.filter.call(table.querySelectorAll('[data-tf-row-check]'), function (cb) {
        return cb.closest('tr').style.display !== 'none';
      });
      selectAll.checked = boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });
    }
  }

  function bulkIds(table) {
    return Array.prototype.map.call(table.querySelectorAll('[data-tf-row-check]:checked'), function (cb) {
      var row = cb.closest('tr');
      return row ? row.getAttribute('data-tf-id') : null;
    }).filter(Boolean);
  }

  /* -- construction de la barre d'outils ---------------------------------- */
  function buildToolbar(table, id) {
    var state = mem[id] || (mem[id] = { sortCol: -1, sortDir: 'asc', filter: '', hidden: [] });
    var cfg = registry[id] || {};

    var bar = document.createElement('div');
    bar.className = 'tft-toolbar';

    var filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'tft-filter input';
    filter.placeholder = tr('command.table.filterPlaceholder', 'Filter rows…');
    filter.setAttribute('aria-label', tr('command.table.filterPlaceholder', 'Filter rows…'));
    filter.value = state.filter;
    filter.addEventListener('input', function () {
      state.filter = filter.value;
      applyFilter(table, filter.value);
    });

    var colsMenu = document.createElement('details');
    colsMenu.className = 'tft-cols';
    var colsBtn = document.createElement('summary');
    colsBtn.textContent = tr('command.table.columns', 'Columns');
    colsMenu.appendChild(colsBtn);
    var colsBox = document.createElement('div');
    colsBox.className = 'tft-cols-menu';
    dataColumns(table).forEach(function (c) {
      var name = (c.th.textContent || '').trim();
      var row = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.hidden.indexOf(name) === -1;
      cb.addEventListener('change', function () {
        var at = state.hidden.indexOf(name);
        if (cb.checked && at !== -1) state.hidden.splice(at, 1);
        if (!cb.checked && at === -1) state.hidden.push(name);
        applyHidden(table, state.hidden);
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + name));
      colsBox.appendChild(row);
    });
    colsMenu.appendChild(colsBox);

    var views = document.createElement('details');
    views.className = 'tft-views';
    var viewsBtn = document.createElement('summary');
    viewsBtn.textContent = tr('command.table.savedViews', 'Saved views');
    views.appendChild(viewsBtn);
    var viewsBox = document.createElement('div');
    viewsBox.className = 'tft-cols-menu';
    function renderViews() {
      viewsBox.innerHTML = '';
      var list = loadViews(id);
      if (!list.length) {
        var p = document.createElement('div');
        p.className = 'tft-views-none';
        p.textContent = tr('command.table.noSavedViews', 'No saved views');
        viewsBox.appendChild(p);
      }
      list.forEach(function (view, i) {
        var row = document.createElement('div');
        row.className = 'tft-view-row';
        var applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'tft-view-apply';
        applyBtn.textContent = view.name;
        applyBtn.addEventListener('click', function () {
          state.sortCol = view.sortCol; state.sortDir = view.sortDir;
          state.filter = view.filter || ''; state.hidden = (view.hidden || []).slice();
          filter.value = state.filter;
          if (state.sortCol >= 0) sortTable(table, state.sortCol, state.sortDir);
          applyHidden(table, state.hidden);
          applyFilter(table, state.filter);
          Array.prototype.forEach.call(colsBox.querySelectorAll('input'), function (cb, j) {
            var colName = dataColumns(table)[j] ? (dataColumns(table)[j].th.textContent || '').trim() : '';
            cb.checked = state.hidden.indexOf(colName) === -1;
          });
          views.removeAttribute('open');
        });
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'tft-view-del';
        delBtn.setAttribute('aria-label', tr('command.table.deleteView', 'Delete') + ' — ' + view.name);
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', function () {
          var next = loadViews(id).filter(function (v, j) { return j !== i; });
          saveViews(id, next);
          renderViews();
        });
        row.appendChild(applyBtn);
        row.appendChild(delBtn);
        viewsBox.appendChild(row);
      });
      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tft-view-save';
      saveBtn.textContent = '+ ' + tr('command.table.saveView', 'Save current view');
      saveBtn.addEventListener('click', function () {
        var name = window.prompt(tr('command.table.saveViewPrompt', 'Name this view'));
        if (!name || !name.trim()) return;
        var list = loadViews(id);
        list = list.filter(function (v) { return v.name !== name.trim(); });
        list.push({ name: name.trim(), sortCol: state.sortCol, sortDir: state.sortDir, filter: state.filter, hidden: state.hidden.slice() });
        saveViews(id, list);
        renderViews();
      });
      viewsBox.appendChild(saveBtn);
    }
    renderViews();
    views.appendChild(viewsBox);

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'tft-export btn btn-secondary btn-small';
    exportBtn.textContent = tr('command.table.exportCsv', 'Export CSV');
    exportBtn.addEventListener('click', function () { exportTable(table, id, false); });

    bar.appendChild(filter);
    bar.appendChild(colsMenu);
    bar.appendChild(views);
    bar.appendChild(exportBtn);

    /* -- actions de groupe ------------------------------------------------
       cfg.bulk present (tableau, meme vide) => selection massive activee,
       avec export de selection automatique + actions fournies par l'hote. */
    if (Array.isArray(cfg.bulk)) {
      var bulkBar = document.createElement('div');
      bulkBar.className = 'tft-bulkbar';
      bulkBar.hidden = true;
      var count = document.createElement('span');
      count.className = 'tft-bulkcount';
      bulkBar.appendChild(count);
      var expSel = document.createElement('button');
      expSel.type = 'button';
      expSel.className = 'btn btn-secondary btn-small';
      expSel.textContent = tr('command.table.bulkExport', 'Export selection');
      expSel.addEventListener('click', function () { exportTable(table, id, true); });
      bulkBar.appendChild(expSel);
      cfg.bulk.forEach(function (action) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-primary btn-small';
        b.textContent = typeof action.label === 'function' ? action.label() : String(action.label || action.id);
        b.addEventListener('click', function () {
          var ids = bulkIds(table);
          if (!ids.length) return;
          try { action.run(ids); } catch (e) { /* l'hote gere ses erreurs */ }
        });
        bulkBar.appendChild(b);
      });
      bar.appendChild(bulkBar);

      /* colonne de selection */
      var headRow = table.tHead ? table.tHead.rows[0] : null;
      if (headRow) {
        var th = document.createElement('th');
        th.setAttribute('data-tf-bulk', '');
        var all = document.createElement('input');
        all.type = 'checkbox';
        all.setAttribute('data-tf-check-all', '');
        all.setAttribute('aria-label', tr('command.table.selected', 'selected'));
        all.addEventListener('change', function () {
          Array.prototype.forEach.call(table.querySelectorAll('[data-tf-row-check]'), function (cb) {
            var row = cb.closest('tr');
            if (row && row.style.display !== 'none') cb.checked = all.checked;
          });
          updateBulk(table);
        });
        th.appendChild(all);
        headRow.insertBefore(th, headRow.firstChild);
      }
      Array.prototype.forEach.call(table.tBodies[0] ? table.tBodies[0].rows : [], function (row) {
        if (row.hasAttribute('data-tf-empty')) return;
        var td = document.createElement('td');
        td.setAttribute('data-tf-bulk', '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-tf-row-check', '');
        cb.setAttribute('aria-label', tr('command.table.selected', 'selected'));
        cb.addEventListener('change', function () { updateBulk(table); });
        td.appendChild(cb);
        row.insertBefore(td, row.firstChild);
      });
    }

    /* -- tri ---------------------------------------------------------------- */
    Array.prototype.forEach.call(table.tHead ? table.tHead.rows[0].cells : [], function (th, i) {
      if (!th.hasAttribute('data-tfsort')) return;
      th.classList.add('tft-sortable');
      th.setAttribute('role', 'button');
      th.tabIndex = 0;
      var act = function () {
        if (state.sortCol === i) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortCol = i; state.sortDir = 'asc'; }
        sortTable(table, i, state.sortDir);
      };
      th.addEventListener('click', act);
      th.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(); }
      });
    });

    /* -- insertion et etat memorise ---------------------------------------- */
    var target = table.closest('.table-wrap') || table;
    target.parentElement.insertBefore(bar, target);

    var empty = document.createElement('div');
    empty.className = 'tft-empty';
    empty.hidden = true;
    empty.textContent = tr('command.table.filteredEmpty', 'No rows match the current filter.');
    target.parentElement.insertBefore(empty, target.nextSibling);

    if (state.hidden.length) applyHidden(table, state.hidden);
    if (state.sortCol >= 0) sortTable(table, state.sortCol, state.sortDir);
    if (state.filter) applyFilter(table, state.filter);
    updateBulk(table);
  }

  function mount(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('table[data-tftable]'), function (table) {
      if (table.hasAttribute('data-tft-mounted')) return;
      table.setAttribute('data-tft-mounted', '');
      buildToolbar(table, table.getAttribute('data-tftable'));
    });
  }

  window.TFTables = { setT: setT, register: register, mount: mount };
})();
