import React from 'react';
import type { DppPassData } from '../../../api/_lib/wallet/types';

interface DppAuditFooterProps {
  data: DppPassData;
}

export const DppAuditFooter: React.FC<DppAuditFooterProps> = ({ data }) => {
  return (
    <footer className="py-8 px-4 sm:px-6 bg-[#080d0a] text-neutral-400 text-xs">
      <div className="max-w-xl mx-auto space-y-4">
        {/* GS1 Digital Link Badge */}
        <div className="p-3.5 rounded-xl bg-neutral-900/80 border border-neutral-800 text-neutral-300 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-base font-bold text-emerald-400">GS1</span>
            <div>
              <div className="text-[11px] font-bold text-white uppercase tracking-wider">Identité Numérique Standard</div>
              <div className="text-[10px] font-mono text-neutral-400 truncate max-w-[260px] sm:max-w-xs">
                {data.digitalLinkUri}
              </div>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-1 rounded bg-neutral-800 text-neutral-300">
            QR Resolvable
          </span>
        </div>

        {/* Regulatory notes */}
        <div className="space-y-1.5 text-[11px] leading-relaxed text-neutral-400">
          <p>
            <strong className="text-neutral-300">Cadre Juridique :</strong> Conforme au Règlement Européen sur l’Écoconception des Produits Durables (ESPR UE 2024/1781), à la Directive Green Claims et à l’Article 13 de la Loi AGEC (France).
          </p>
          <p>
            <strong className="text-neutral-300">Intégrité des Données :</strong> Données auditées par Tracefab, garanties par signature numérique et historisées dans un registre immuable anti-fraude.
          </p>
        </div>

        <div className="pt-4 border-t border-neutral-800 flex items-center justify-between text-[11px] text-neutral-500">
          <span>Plateforme Tracefab © 2026</span>
          <span className="font-mono text-[10px]">ID: {data.productId.slice(0, 8)}...</span>
        </div>
      </div>
    </footer>
  );
};
