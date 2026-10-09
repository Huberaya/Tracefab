    (function () {
      var sel = document.getElementById('pi-lang');
      if (!sel) return;
      var sync = function () { if (window.TF_I18N) sel.value = window.TF_I18N.lang; };
      sel.addEventListener('change', function () {
        if (window.TF_I18N) window.TF_I18N.setLanguage(sel.value);
      });
      document.addEventListener('tf:languagechange', sync);
      if (window.TF_I18N && window.TF_I18N.ready) window.TF_I18N.ready.then(sync);
    })();
  
