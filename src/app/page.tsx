import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0d1610] text-[#f3f5f3] flex flex-col items-center justify-center p-6 text-center">
      <div className="max-w-xl mx-auto space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center mx-auto text-2xl font-bold text-emerald-400">
          tf
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
          Tracefab Digital Product Passport
        </h1>
        <p className="text-neutral-400 text-sm sm:text-base leading-relaxed">
          Démonstration de passeport numérique de produit textile, préparé pour
          les exigences du Digital Product Passport (règlement ESPR 2024/1781),
          avec intégration native Apple Wallet & Google Wallet. L'état de
          préparation affiché ne constitue pas une certification de conformité.
        </p>

        <div className="pt-4 flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/p/AT-ESS-001"
            className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-all shadow-lg shadow-emerald-950"
          >
            Voir le DPP Démo (Essentiel Coton)
          </Link>
          <Link
            href="/api/dpp/AT-ESS-001/apple-wallet"
            className="px-6 py-3 rounded-xl bg-neutral-900 border border-neutral-700 hover:bg-neutral-800 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
          >
            <span> Télécharger Apple Wallet (.pkpass)</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
