import React from 'react';
import type { DppPassData } from '../../../api/_lib/wallet/types';

interface DppPefEcoScoreSectionProps {
  data: DppPassData;
}

export const DppPefEcoScoreSection: React.FC<DppPefEcoScoreSectionProps> = ({ data }) => {
  const gradeColors: Record<string, { bg: string; text: string; border: string }> = {
    A: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/50' },
    B: { bg: 'bg-teal-500/20', text: 'text-teal-300', border: 'border-teal-500/50' },
    C: { bg: 'bg-amber-500/20', text: 'text-amber-300', border: 'border-amber-500/50' },
    D: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/50' },
    E: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/50' },
  };

  const currentGrade = data.pefGrade || 'B';
  const gradeStyle = gradeColors[currentGrade] || gradeColors.B;

  return (
    <section className="py-6 px-4 sm:px-6 border-b border-emerald-950/40">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-teal-400" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-teal-300">
              Impact Environnemental (PEF / ACV)
            </h2>
          </div>
          <span className="text-xs font-mono text-neutral-400">
            Méthodologie UE PEFCR v2024.1
          </span>
        </div>

        {/* Big Eco-Score Card */}
        <div className={`p-4 rounded-2xl ${gradeStyle.bg} border ${gradeStyle.border} mb-4 flex items-center justify-between`}>
          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-neutral-300">Éco-Score Européen</div>
            <div className="text-sm text-neutral-300 mt-0.5">Performance environnementale globale</div>
          </div>
          <div className="flex items-center gap-2">
            {['A', 'B', 'C', 'D', 'E'].map((letter) => {
              const isActive = letter === currentGrade;
              return (
                <div
                  key={letter}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm transition-all ${
                    isActive
                      ? 'bg-white text-neutral-900 shadow-lg scale-110 ring-2 ring-emerald-400'
                      : 'bg-neutral-800/60 text-neutral-500 text-xs'
                  }`}
                >
                  {letter}
                </div>
              );
            })}
          </div>
        </div>

        {/* 3 Metrics Grid */}
        <div className="grid grid-cols-3 gap-2.5">
          <div className="glass-panel p-3 rounded-xl text-center">
            <div className="text-[10px] uppercase font-semibold text-neutral-400 tracking-wider">Carbone</div>
            <div className="text-lg font-bold text-neutral-100 font-mono mt-1">
              {data.carbonFootprintKgCo2e}
            </div>
            <div className="text-[10px] text-emerald-400 font-mono">kg CO₂e</div>
          </div>

          <div className="glass-panel p-3 rounded-xl text-center">
            <div className="text-[10px] uppercase font-semibold text-neutral-400 tracking-wider">Eau</div>
            <div className="text-lg font-bold text-neutral-100 font-mono mt-1">
              {data.waterScarcityM3}
            </div>
            <div className="text-[10px] text-teal-400 font-mono">m³ équiv.</div>
          </div>

          <div className="glass-panel p-3 rounded-xl text-center">
            <div className="text-[10px] uppercase font-semibold text-neutral-400 tracking-wider">Circularité</div>
            <div className="text-lg font-bold text-neutral-100 font-mono mt-1">
              {data.circularityScore}%
            </div>
            <div className="text-[10px] text-lime-400 font-mono">Score ESPR</div>
          </div>
        </div>
      </div>
    </section>
  );
};
