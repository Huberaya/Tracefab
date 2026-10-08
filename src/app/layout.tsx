import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Passeport Numérique de Produit (DPP) — Tracefab',
  description: 'Démonstration de passeport numérique de produit textile, préparé pour les exigences du Digital Product Passport (règlement ESPR 2024/1781) et de la loi AGEC article 13. L’état de préparation affiché ne constitue pas une certification de conformité.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0d1610',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-[#0d1610] text-[#f3f5f3] antialiased selection:bg-emerald-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}
