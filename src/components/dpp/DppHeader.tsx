import React from 'react';
import type { DppPassData } from '../../../api/_lib/wallet/types';

interface DppHeaderProps {
  data: DppPassData;
}

export const DppHeader: React.FC<DppHeaderProps> = ({ data }) => {
  return (
    <header className="relative overflow-hidden pt-8 pb-6 px-4 sm:px-6 border-b border-emerald-950/60 bg-gradient-to-b from-[#132218] to-[#0d1610]">
      {/* Background glow decoration */}
      <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-96 h-96 bg-emerald-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-xl mx-auto relative z-10">
        {/* Top Badges */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <span className="h-6 px-2.5 inline-flex items-center text-xs font-semibold tracking-wider text-emerald-400 bg-emerald-950/80 border border-emerald-800/50 rounded-full">
              {data.brandName.toUpperCase()}
            </span>
            <span className="text-xs text-neutral-400 font-mono">
              v1.0 · {data.category}
            </span>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded-full text-xs font-medium text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>ESPR Certifié</span>
          </div>
        </div>

        {/* Product Title & Ref */}
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white mb-2">
          {data.productName}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-neutral-400 font-mono">
          <span>Réf: {data.productReference}</span>
          <span>•</span>
          <span>GTIN: {data.gtin || '3760345833592'}</span>
          <span>•</span>
          <span>Fabriqué en {data.countryOfManufacture}</span>
        </div>
      </div>
    </header>
  );
};
