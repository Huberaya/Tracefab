import React from 'react';
import type { DppPassData } from '../../../api/_lib/wallet/types';

interface DppSupplyChainSectionProps {
  data: DppPassData;
}

export const DppSupplyChainSection: React.FC<DppSupplyChainSectionProps> = ({ data }) => {
  const steps = [
    {
      step: '1. Culture & Égrenage',
      desc: 'Coton biologique certifié GOTS',
      country: 'Turquie (TR)',
      badge: 'Tier-4 Certifié',
    },
    {
      step: '2. Filature & Peignage',
      desc: 'Fil compact 30/1 ring-spun',
      country: 'Portugal (PT)',
      badge: 'Tier-3 Auditée',
    },
    {
      step: '3. Tricotage & Ennoblissement',
      desc: 'Maille jersey 185g sans métaux lourds (OEKO-TEX)',
      country: 'Portugal (PT)',
      badge: 'Tier-2 Vérifié',
    },
    {
      step: '4. Confection & Finitions',
      desc: 'Coupe et couture en atelier partenaire audité SMETA',
      country: `${data.countryOfManufacture || 'Portugal'} (${data.countryOfManufacture || 'PT'})`,
      badge: 'Tier-1 Partenaire',
    },
  ];

  return (
    <section className="py-6 px-4 sm:px-6 border-b border-emerald-950/40">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-lime-400" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-lime-300">
              Traçabilité & Chaîne d'Approvisionnement
            </h2>
          </div>
          <span className="text-xs font-mono text-neutral-400">
            Loi AGEC Art. 13
          </span>
        </div>

        {/* Step-by-step Timeline */}
        <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-emerald-900/60">
          {steps.map((st, i) => (
            <div key={i} className="relative">
              {/* Dot */}
              <div className="absolute -left-6 top-1.5 w-3.5 h-3.5 rounded-full border-2 border-[#0d1610] bg-emerald-400" />
              
              <div className="glass-panel p-3.5 rounded-xl">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-neutral-100">{st.step}</div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-emerald-950 border border-emerald-800/40 text-emerald-400">
                    {st.badge}
                  </span>
                </div>
                <div className="text-xs text-neutral-300 mt-1">{st.desc}</div>
                <div className="text-[11px] text-neutral-400 font-mono mt-1.5 flex items-center gap-1.5">
                  <span>📍 {st.country}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Mass-Balance Guarantee Notice */}
        {data.transactionCertificateNumber && (
          <div className="mt-4 p-3 rounded-xl bg-violet-950/30 border border-violet-800/40 text-xs text-neutral-300 flex items-start gap-2.5">
            <span className="text-base text-violet-400">⚖️</span>
            <div>
              <strong className="text-violet-300">Garantie Anti-Fraude Mass-Balance :</strong>{' '}
              Les volumes de matière certifiée ont été audités et réconciliés mathématiquement avec le registre des Transaction Certificates (TC).
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
