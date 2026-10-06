import React from 'react';
import type { DppPassData } from '../../../api/_lib/wallet/types';

interface DppCompositionSectionProps {
  data: DppPassData;
}

export const DppCompositionSection: React.FC<DppCompositionSectionProps> = ({ data }) => {
  const materials = data.materials.length
    ? data.materials
    : [{ name: 'Coton biologique certifié GOTS', percentage: 100, role: 'main' }];

  return (
    <section className="py-6 px-4 sm:px-6 border-b border-emerald-950/40">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-300">
              Composition 100% & Matières
            </h2>
          </div>
          <span className="text-xs font-mono text-neutral-400">
            {data.weightGrams}g · Poids net
          </span>
        </div>

        {/* Visual Progress Bar Breakdown */}
        <div className="h-3 w-full bg-neutral-800 rounded-full overflow-hidden flex mb-4">
          {materials.map((m, idx) => {
            const colors = ['bg-emerald-500', 'bg-teal-400', 'bg-lime-400', 'bg-emerald-700'];
            const colorClass = colors[idx % colors.length];
            return (
              <div
                key={idx}
                style={{ width: `${m.percentage}%` }}
                className={`${colorClass} transition-all duration-500`}
                title={`${m.name}: ${m.percentage}%`}
              />
            );
          })}
        </div>

        {/* Detailed Material List */}
        <div className="space-y-2.5">
          {materials.map((mat, i) => (
            <div
              key={i}
              className="glass-panel p-3.5 rounded-xl flex items-center justify-between"
            >
              <div>
                <div className="font-semibold text-sm text-neutral-100">{mat.name}</div>
                <div className="text-xs text-neutral-400 font-mono mt-0.5">
                  Rôle: {mat.role || 'Principal'} {mat.originCountry ? `· Origine: ${mat.originCountry}` : ''}
                </div>
              </div>
              <div className="text-right">
                <span className="text-base font-bold text-emerald-400 font-mono">
                  {mat.percentage}%
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Certification Stamps */}
        <div className="mt-4 pt-3 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-950/60 border border-emerald-800/40 rounded-lg text-xs font-medium text-emerald-300">
            <span>✓</span>
            <span>GOTS 7.0 (Control Union Certified)</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-950/60 border border-emerald-800/40 rounded-lg text-xs font-medium text-emerald-300">
            <span>✓</span>
            <span>OEKO-TEX Standard 100 Class I</span>
          </span>
        </div>
      </div>
    </section>
  );
};
