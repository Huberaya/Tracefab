'use client';

import React, { useState } from 'react';

interface DppWalletActionsProps {
  productId: string;
  gtin: string;
  reference: string;
}

export const DppWalletActions: React.FC<DppWalletActionsProps> = ({
  productId,
  gtin,
  reference,
}) => {
  const [loadingApple, setLoadingApple] = useState(false);
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [copied, setCopied] = useState(false);

  const identifier = gtin || reference || productId;

  const handleAppleWallet = () => {
    setLoadingApple(true);
    // Direct link to the .pkpass endpoint which triggers Apple Wallet on iOS Safari or downloads on desktop
    const url = `/api/dpp/${encodeURIComponent(identifier)}/apple-wallet`;
    window.location.href = url;
    setTimeout(() => setLoadingApple(false), 2000);
  };

  const handleGoogleWallet = async () => {
    setLoadingGoogle(true);
    try {
      const res = await fetch(`/api/dpp/${encodeURIComponent(identifier)}/google-wallet`);
      const data = await res.json();
      if (data.saveUrl) {
        window.open(data.saveUrl, '_blank', 'noopener,noreferrer');
      } else {
        alert('Pass Google Wallet généré avec succès en mode démonstration.');
      }
    } catch (e) {
      console.error(e);
      alert('Erreur lors de la génération du pass Google Wallet.');
    } finally {
      setLoadingGoogle(false);
    }
  };

  const handleShare = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: `Passeport Numérique — ${reference}`,
          text: `Découvrez le Passeport Numérique de Produit (DPP), préparé pour les exigences ESPR.`,
          url: window.location.href,
        });
      } catch {
        // User cancelled share
      }
    } else {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="py-5 px-4 sm:px-6 bg-[#111e15]/90 border-b border-emerald-950/60 backdrop-blur-md">
      <div className="max-w-xl mx-auto">
        <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400/90 mb-3 text-center sm:text-left flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <span>Passeport Numérique Hors-Ligne & Portefeuille Mobile</span>
        </div>

        {/* Action Buttons Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {/* Official Apple Wallet Badge */}
          <button
            onClick={handleAppleWallet}
            disabled={loadingApple}
            className="apple-wallet-btn w-full h-[48px] rounded-xl px-4 flex items-center justify-center gap-2.5 font-medium text-sm active:scale-[0.98] transition-all cursor-pointer"
            aria-label="Ajouter à Apple Wallet"
          >
            {/* Apple Logo SVG */}
            <svg className="w-5 h-5 fill-current text-white mb-0.5" viewBox="0 0 170 170">
              <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.69-7.85-11.96-14.42-5.46-8.47-9.87-18.06-13.23-28.77-3.37-10.7-5.06-21.05-5.06-31.05 0-14.7 3.59-26.96 10.77-36.78 7.18-9.82 16.43-14.85 27.75-15.08 4.35 0 9.4 1.25 15.17 3.76 5.76 2.5 9.47 3.82 11.12 3.94 1.88-.24 5.76-1.63 11.64-4.17 5.88-2.54 10.7-3.7 14.47-3.48 10.83.61 19.59 4.79 26.28 12.54-9.36 5.69-13.92 13.71-13.68 24.08.24 8.01 3.23 14.77 8.98 20.28 5.74 5.51 12.63 8.84 20.67 10 1.05 4.58 1.94 8.78 2.68 12.61.74 3.82 1.15 7.42 1.23 10.82zm-35.03-107.57c.12 3.82-.7 7.73-2.45 11.73-1.76 4-4.32 7.54-7.69 10.63-3.05 2.82-6.57 4.96-10.55 6.42-3.98 1.46-7.85 2.19-11.61 2.19-.24-3.59.62-7.39 2.58-11.4 1.96-4 4.67-7.61 8.14-10.83 3.18-2.95 6.83-5.2 10.96-6.75 4.12-1.54 7.65-2.21 10.62-1.99z" />
            </svg>
            <div className="flex flex-col items-start leading-tight">
              <span className="text-[10px] uppercase tracking-wider text-neutral-400 font-normal">Ajouter à</span>
              <span className="text-sm font-semibold tracking-tight text-white -mt-0.5">
                {loadingApple ? 'Génération...' : 'Apple Wallet'}
              </span>
            </div>
          </button>

          {/* Official Google Wallet Badge */}
          <button
            onClick={handleGoogleWallet}
            disabled={loadingGoogle}
            className="google-wallet-btn w-full h-[48px] rounded-xl px-4 flex items-center justify-center gap-2.5 font-medium text-sm active:scale-[0.98] transition-all cursor-pointer"
            aria-label="Enregistrer dans Google Wallet"
          >
            {/* Google Wallet Icon SVG */}
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <div className="flex flex-col items-start leading-tight">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-normal">Enregistrer dans</span>
              <span className="text-sm font-semibold tracking-tight text-neutral-900 -mt-0.5">
                {loadingGoogle ? 'Génération...' : 'Google Wallet'}
              </span>
            </div>
          </button>
        </div>

        {/* Secondary share button */}
        <button
          onClick={handleShare}
          className="w-full py-2 px-3 text-xs text-neutral-400 hover:text-white flex items-center justify-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          <span>{copied ? '✓ Lien copié dans le presse-papiers' : 'Partager ce Passeport Numérique'}</span>
        </button>
      </div>
    </div>
  );
};
