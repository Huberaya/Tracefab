import React from 'react';

export const DppCareInstructionsSection: React.FC = () => {
  const careSymbols = [
    { icon: '30°', label: 'Lavage 30°C', sub: 'Action réduite' },
    { icon: '⨂', label: 'Pas de javel', sub: 'Chlore interdit' },
    { icon: '◻', label: 'Séchage naturel', sub: 'À plat' },
    { icon: '•', label: 'Fer doux', sub: 'Max 110°C' },
  ];

  return (
    <section className="py-6 px-4 sm:px-6 border-b border-emerald-950/40">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-300">
            Entretien, Réparation & Fin de Vie
          </h2>
        </div>

        {/* Care symbols row */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {careSymbols.map((item, i) => (
            <div key={i} className="glass-panel p-2.5 rounded-xl text-center">
              <div className="text-base font-bold text-neutral-100 font-mono">{item.icon}</div>
              <div className="text-[11px] font-semibold text-neutral-200 mt-1">{item.label}</div>
              <div className="text-[9px] text-neutral-400 mt-0.5">{item.sub}</div>
            </div>
          ))}
        </div>

        {/* Circularity and repair cards */}
        <div className="space-y-2.5">
          <div className="glass-panel p-3.5 rounded-xl flex items-start gap-3">
            <span className="text-lg">🪡</span>
            <div>
              <div className="text-xs font-bold text-neutral-100 uppercase tracking-wide">
                Indice de Réparabilité & Pièces Détachées
              </div>
              <p className="text-xs text-neutral-300 mt-0.5 leading-relaxed">
                Boutons supplémentaires et fil de rechange inclus dans l'étiquette intérieure. Patron de coupe et tutoriel de réparation disponibles sur demande.
              </p>
            </div>
          </div>

          <div className="glass-panel p-3.5 rounded-xl flex items-start gap-3">
            <span className="text-lg">♻️</span>
            <div>
              <div className="text-xs font-bold text-neutral-100 uppercase tracking-wide">
                Filière de Recyclage Re-fashion
              </div>
              <p className="text-xs text-neutral-300 mt-0.5 leading-relaxed">
                Ce produit mono-matière est 100% recyclable. En fin d’usage, déposez-le dans l'une des 45 000 bornes textiles ou renvoyez-le pour réincorporation des fibres.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
