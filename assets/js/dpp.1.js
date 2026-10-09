    (() => {
      // Tab switching logic
      const tabs = document.querySelectorAll('.dpp-tab-btn');
      const panels = {
        materials: document.getElementById('panel-materials'),
        traceability: document.getElementById('panel-traceability'),
        impact: document.getElementById('panel-impact'),
        circularity: document.getElementById('panel-circularity'),
        evidence: document.getElementById('panel-evidence'),
        gs1: document.getElementById('panel-gs1')
      };

      tabs.forEach(btn => {
        btn.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          btn.classList.add('active');
          const target = btn.dataset.tab;
          Object.keys(panels).forEach(k => {
            if (panels[k]) panels[k].style.display = (k === target) ? 'block' : 'none';
          });
        });
      });

      // JSON-LD Export and Modal
      const jsonContent = document.getElementById('dpp-jsonld').textContent.trim();
      const modal = document.getElementById('modal-jsonld');
      const codeContainer = document.getElementById('json-code-container');
      const btnViewRaw = document.getElementById('btn-view-raw');
      const btnClose = document.getElementById('modal-close');
      const btnExport = document.getElementById('btn-export-jsonld');

      btnViewRaw.addEventListener('click', () => {
        try {
          const formatted = JSON.stringify(JSON.parse(jsonContent), null, 2);
          codeContainer.textContent = formatted;
        } catch (e) {
          codeContainer.textContent = jsonContent;
        }
        modal.classList.add('open');
      });

      btnClose.addEventListener('click', () => modal.classList.remove('open'));
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });

      btnExport.addEventListener('click', () => {
        const blob = new Blob([jsonContent], { type: 'application/ld+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dpp-at-ess-001-cirpass.jsonld';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    })();
  
