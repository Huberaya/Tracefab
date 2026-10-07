import os

new_hero_section_html = '''
  <!-- ==========================================================================
       PHASE 3: MONUMENTAL ARCHITECTURAL HEADER & WORLD-CLASS HERO STAGE
       ========================================================================== -->
  <header class="tf-world-header">
    <div class="tf-header-shell">
      <a href="/" class="tf-brand-anchor">
        <div class="tf-brand-symbol">tf</div>
        <div class="tf-brand-title">TRACEFAB</div>
      </a>

      <nav class="tf-nav-strip" aria-label="Navigation Principale">
        <a href="#why">Why TRACEFAB</a>
        <a href="#layers">Platform</a>
        <a href="#wow-ecosystem">Supply Chain</a>
        <a href="#product-intelligence">Product Intelligence</a>
        <a href="/dpp/" target="_blank">DPP</a>
        <a href="#resources">Resources</a>
      </nav>

      <div class="tf-header-right">
        <!-- Language Switcher Pill -->
        <div class="tf-lang-wrap">
          <button id="lang-menu-btn" class="tf-lang-btn" onclick="toggleLangMenu()" aria-label="Choisir la langue">
            <span id="current-lang-code">FR</span>
            <span style="font-size:9px;opacity:0.7;">▼</span>
          </button>
          <div id="lang-dropdown-menu" class="tf-lang-dropdown">
            <div class="tf-lang-item" onclick="setLanguage('fr')">🇫🇷 Français (FR)</div>
            <div class="tf-lang-item" onclick="setLanguage('en')">🇬🇧 English (EN)</div>
            <div class="tf-lang-item" onclick="setLanguage('de')">🇩🇪 Deutsch (DE)</div>
            <div class="tf-lang-item" onclick="setLanguage('it')">🇮🇹 Italiano (IT)</div>
            <div class="tf-lang-item" onclick="setLanguage('es')">🇪🇸 Español (ES)</div>
            <div class="tf-lang-item" onclick="setLanguage('nl')">🇳🇱 Nederlands (NL)</div>
          </div>
        </div>

        <a href="/brand-console/" class="tf-nav-signin">Sign in</a>
        <button onclick="openDemoModal()" class="tf-nav-cta">Request a demo</button>
      </div>
    </div>
  </header>

  <!-- ==========================================================================
       MONUMENTAL IMMERSIVE HERO
       Know your product. Know your supply chain. Prove it.
       ========================================================================== -->
  <section class="tf-hero-stage">
    <!-- Subtle Textile Mesh Ambient Glow -->
    <div class="tf-ambient-mesh"></div>

    <div class="tf-hero-lead-shell">
      <div class="tf-eyebrow-capsule">
        <span class="tf-capsule-beacon"></span>
        <span class="tf-capsule-text">EUROPEAN TEXTILE DATA INFRASTRUCTURE</span>
      </div>

      <h1 class="tf-hero-monumental-h1">
        <span>Know your product.</span>
        <span>Know your supply chain.</span>
        <span class="tf-h1-accent">Prove it.</span>
      </h1>

      <p class="tf-hero-sub-statement">
        TRACEFAB connects supplier data, evidence, quality, traceability and Digital Product Passport readiness in one intelligent infrastructure.
      </p>

      <div class="tf-hero-cta-group">
        <a href="/brand-console/" class="tf-btn-hero-primary">Explore TRACEFAB</a>
        <button onclick="openDemoModal()" class="tf-btn-hero-secondary">Request a demo</button>
      </div>
    </div>

    <!-- HERO VISUAL: TRACEFAB DATA CORE INTERACTIVE GRAPH -->
    <div class="tf-hero-core-canvas">
      <div class="tf-canvas-control-header">
        <div class="tf-canvas-title-box">
          <span class="tf-live-indicator"></span>
          <strong>TRACEFAB LIVING DATA CORE</strong>
          <span class="tf-version-pill">CIRPASS 1.2 · ESPR 2027</span>
        </div>
        <div class="tf-canvas-metrics-summary">
          <div class="tf-metric-cell">
            <span class="tf-metric-label">CONNECTED PRODUCTS</span>
            <span class="tf-metric-val">1,248</span>
          </div>
          <div class="tf-metric-cell">
            <span class="tf-metric-label">TIER 1–4 PROVENANCE</span>
            <span class="tf-metric-val">100%</span>
          </div>
          <div class="tf-metric-cell">
            <span class="tf-metric-label">EVIDENCE INTEGRITY</span>
            <span class="tf-metric-val" style="color:#10b981;">SHA-256 SEALED</span>
          </div>
        </div>
      </div>

      <!-- Core Interactive Radial Flow Container -->
      <div class="tf-radial-core-grid">
        <!-- 7 Layered Interactive Nodes -->
        <div class="tf-core-node" onclick="inspectCoreNode(0)">
          <div class="tf-node-badge">LAYER 01</div>
          <div class="tf-node-title">SUPPLIERS</div>
          <div class="tf-node-meta">Tier 1–4 Verified Vault</div>
          <div class="tf-node-pulse-line"></div>
        </div>

        <div class="tf-core-node" onclick="inspectCoreNode(1)">
          <div class="tf-node-badge">LAYER 02</div>
          <div class="tf-node-title">MATERIALS</div>
          <div class="tf-node-meta">100% Reconciled BOM</div>
          <div class="tf-node-pulse-line"></div>
        </div>

        <div class="tf-core-node" onclick="inspectCoreNode(2)">
          <div class="tf-node-badge">LAYER 03</div>
          <div class="tf-node-title">EVIDENCE</div>
          <div class="tf-node-meta">GOTS · ZDHC · OEKO-TEX</div>
          <div class="tf-node-pulse-line"></div>
        </div>

        <div class="tf-core-node tf-core-centerpiece">
          <div class="tf-center-logo">tf</div>
          <div class="tf-center-title">TRACEFAB</div>
          <div class="tf-center-caption">Mission Control Engine</div>
        </div>

        <div class="tf-core-node" onclick="inspectCoreNode(3)">
          <div class="tf-node-badge">LAYER 04</div>
          <div class="tf-node-title">DATA QUALITY</div>
          <div class="tf-node-meta">6-Tier Explanable Score</div>
          <div class="tf-node-pulse-line"></div>
        </div>

        <div class="tf-core-node" onclick="inspectCoreNode(4)">
          <div class="tf-node-badge">LAYER 05</div>
          <div class="tf-node-title">TRACEABILITY</div>
          <div class="tf-node-meta">Fiber to Finished Garment</div>
          <div class="tf-node-pulse-line"></div>
        </div>

        <div class="tf-core-node" onclick="inspectCoreNode(5)">
          <div class="tf-node-badge">LAYER 07</div>
          <div class="tf-node-title">DPP READY</div>
          <div class="tf-node-meta">GS1 Digital Link · AGEC</div>
          <div class="tf-node-pulse-line"></div>
        </div>
      </div>

      <!-- Real-time transmission status bar -->
      <div class="tf-canvas-footer-strip">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981;"></span>
          <span style="font-family:var(--font-mono);font-size:11.5px;color:rgba(255,255,255,0.8);">LIVE TRANSMISSION : ALL 7 LAYERS SYNCHRONIZED</span>
        </div>
        <div style="font-family:var(--font-mono);font-size:11px;color:rgba(255,255,255,0.5);">
          ISO 17025 LAB CHECKS · FRENCH AGEC ART. 13 · CSRD READY
        </div>
      </div>
    </div>
  </section>

  <!-- ==========================================================================
       SECTION WOW: YOUR ENTIRE TEXTILE ECOSYSTEM. ONE CONNECTED DATA FOUNDATION.
       Interactive Deep Node Inspector (FIBER ➔ DPP)
       ========================================================================== -->
  <section class="tf-wow-section" id="wow-ecosystem">
    <div class="tf-section-shell">
      <div class="tf-wow-header">
        <div class="tf-wow-eyebrow">THE LIVING SUPPLY CHAIN GRAPH</div>
        <h2 class="tf-wow-h2">
          Your entire textile ecosystem.<br>One connected data foundation.
        </h2>
        <p class="tf-wow-lead">
          Hover or click on any custody echelon below to inspect verified factory GPS coordinates, active compliance certificates, and real-time data completeness.
        </p>
      </div>

      <!-- Horizontal Multi-Echelon Pipeline Bar -->
      <div class="tf-chain-pipeline-scroll">
        <div class="tf-chain-node active" onmouseenter="showChainNode(0)">
          <div class="tf-step-order">01</div>
          <div class="tf-step-name">FIBER</div>
          <div class="tf-step-type">Organic Cotton Farm</div>
          <div class="tf-step-status verified">✓ GOTS Certified</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(1)">
          <div class="tf-step-order">02</div>
          <div class="tf-step-name">SPINNING</div>
          <div class="tf-step-type">Ring Spun Yarn Mill</div>
          <div class="tf-step-status verified">✓ Mass-Balance</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(2)">
          <div class="tf-step-order">03</div>
          <div class="tf-step-name">WEAVING</div>
          <div class="tf-step-type">Twill Loom Atelier</div>
          <div class="tf-step-status verified">✓ 100% Polygon GPS</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(3)">
          <div class="tf-step-order">04</div>
          <div class="tf-step-name">DYEING</div>
          <div class="tf-step-type">Wet Processing House</div>
          <div class="tf-step-status verified">✓ ZDHC Level 3</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(4)">
          <div class="tf-step-order">05</div>
          <div class="tf-step-name">CUT & SEW</div>
          <div class="tf-step-type">Garment Manufacturing</div>
          <div class="tf-step-status verified">✓ SMETA 4-Pillar</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(5)">
          <div class="tf-step-order">06</div>
          <div class="tf-step-name">PRODUCT</div>
          <div class="tf-step-type">Finished Overshirt</div>
          <div class="tf-step-status verified">✓ 98.4 Quality</div>
        </div>

        <div class="tf-chain-node" onmouseenter="showChainNode(6)">
          <div class="tf-step-order">07</div>
          <div class="tf-step-name">DPP</div>
          <div class="tf-step-type">GS1 Consumer Passport</div>
          <div class="tf-step-status verified" style="color:#10b981;font-weight:800;">✓ Public QR Ready</div>
        </div>
      </div>

      <!-- WOW Deep Inspector Card Display -->
      <div class="tf-inspector-card-shell" id="inspector-display-card">
        <div class="tf-inspector-left">
          <div class="tf-inspector-badge" id="insp-tier">TIER 2 SUPPLIER FACILITY</div>
          <h3 class="tf-inspector-title" id="insp-name">Portugal Textile Mill & Weaving House</h3>
          <div class="tf-inspector-location" id="insp-loc">📍 Guimarães, Northern Portugal · Polygon GPS Verified</div>
          <p class="tf-inspector-desc" id="insp-desc">
            Equipped with modern high-speed looms and closed-loop water effluent recycling. Full custody transfer certificates audited and validated for Tier 1 garment assembly.
          </p>
          <div class="tf-inspector-tags" id="insp-tags">
            <span class="tf-insp-tag">GOTS 6.0</span>
            <span class="tf-insp-tag">OEKO-TEX Standard 100</span>
            <span class="tf-insp-tag">ZDHC Roadmap to Zero</span>
          </div>
        </div>

        <div class="tf-inspector-right">
          <div class="tf-stat-box">
            <div class="tf-stat-title">DATA QUALITY INDEX</div>
            <div class="tf-stat-num" id="insp-quality">87%</div>
            <div class="tf-stat-sub">Grade A · Zero Incomplete Declarations</div>
          </div>
          <div class="tf-stat-box">
            <div class="tf-stat-title">ASSOCIATED STYLES</div>
            <div class="tf-stat-num" id="insp-styles">12 Products</div>
            <div class="tf-stat-sub">Active in AW26 & SS27 Collections</div>
          </div>
          <div class="tf-stat-box">
            <div class="tf-stat-title">EVIDENCE STATUS</div>
            <div class="tf-stat-num" style="color:#10b981;" id="insp-proof">Verified Evidence</div>
            <div class="tf-stat-sub">Cryptographic Hash Validated on Neon</div>
          </div>
        </div>
      </div>
    </div>
  </section>
'''

# New dedicated CSS for Phase 3
phase3_css = '''
    /* ==========================================================================
       PHASE 3 CSS: ARCHITECTURAL DEEP FOREST DESIGN SYSTEM
       Data × Textile × Trust (Linear, Stripe & TrusTrace Quality Reference)
       ========================================================================== */
    :root {
      --tf-void-bg: #050f0b;
      --tf-forest-dark: #081a13;
      --tf-forest-surface: #0e271d;
      --tf-forest-hover: #143528;
      --tf-accent-emerald: #10b981;
      --tf-emerald-glow: rgba(16, 185, 129, 0.2);
      --tf-bone-text: #f5f8f5;
      --tf-text-secondary: #90a498;
      --tf-border-glass: rgba(255, 255, 255, 0.08);
      --tf-border-accent: rgba(16, 185, 129, 0.3);
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', Menlo, Consolas, monospace;
    }

    body {
      background-color: var(--tf-void-bg);
      color: var(--tf-bone-text);
      font-family: var(--font-sans);
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    /* Architectural Header */
    .tf-world-header {
      position: sticky;
      top: 0;
      z-index: 150;
      background: rgba(5, 15, 11, 0.85);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-bottom: 1px solid var(--tf-border-glass);
      height: 74px;
      display: flex;
      align-items: center;
    }

    .tf-header-shell {
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 0 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .tf-brand-anchor {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: #ffffff;
    }

    .tf-brand-symbol {
      width: 32px;
      height: 32px;
      background: var(--tf-accent-emerald);
      color: #050f0b;
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-weight: 900;
      font-size: 14px;
      letter-spacing: -0.04em;
    }

    .tf-brand-title {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: 0.08em;
    }

    .tf-nav-strip {
      display: flex;
      align-items: center;
      gap: 32px;
    }

    .tf-nav-strip a {
      color: var(--tf-text-secondary);
      font-size: 13.5px;
      font-weight: 500;
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .tf-nav-strip a:hover {
      color: #ffffff;
    }

    .tf-header-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .tf-lang-wrap {
      position: relative;
    }

    .tf-lang-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--tf-border-glass);
      color: #ffffff;
      padding: 6px 12px;
      border-radius: 9999px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tf-lang-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 6px;
      background: var(--tf-forest-dark);
      border: 1px solid var(--tf-border-glass);
      border-radius: 12px;
      padding: 6px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
      min-width: 150px;
      z-index: 200;
    }

    .tf-lang-item {
      padding: 8px 12px;
      font-size: 12.5px;
      color: var(--tf-text-secondary);
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.15s;
    }

    .tf-lang-item:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }

    .tf-nav-signin {
      color: var(--tf-text-secondary);
      font-size: 13.5px;
      font-weight: 600;
      text-decoration: none;
      transition: color 0.2s;
    }

    .tf-nav-signin:hover {
      color: #ffffff;
    }

    .tf-nav-cta {
      background: var(--tf-accent-emerald);
      color: #050f0b;
      border: none;
      padding: 9px 20px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 750;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.25);
    }

    .tf-nav-cta:hover {
      background: #34d399;
      transform: translateY(-1px);
      box-shadow: 0 0 30px rgba(16, 185, 129, 0.45);
    }

    /* Monumental Hero */
    .tf-hero-stage {
      position: relative;
      padding: 100px 40px 80px;
      max-width: 1400px;
      margin: 0 auto;
      text-align: center;
    }

    .tf-ambient-mesh {
      position: absolute;
      inset: 0;
      background: radial-gradient(1100px 480px at 50% 10%, rgba(16, 185, 129, 0.12), transparent 70%),
                  radial-gradient(800px 400px at 80% 30%, rgba(33, 92, 66, 0.15), transparent 60%);
      pointer-events: none;
      z-index: 0;
    }

    .tf-hero-lead-shell {
      position: relative;
      z-index: 1;
      max-width: 1080px;
      margin: 0 auto 64px;
    }

    .tf-eyebrow-capsule {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 16px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--tf-border-glass);
      margin-bottom: 28px;
    }

    .tf-capsule-beacon {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--tf-accent-emerald);
      box-shadow: 0 0 8px var(--tf-accent-emerald);
    }

    .tf-capsule-text {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--tf-accent-emerald);
      letter-spacing: 0.14em;
    }

    .tf-hero-monumental-h1 {
      font-size: clamp(48px, 6vw, 84px);
      font-weight: 850;
      letter-spacing: -0.045em;
      line-height: 1.05;
      color: #ffffff;
      margin: 0 auto 24px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .tf-h1-accent {
      color: var(--tf-accent-emerald);
      background: linear-gradient(180deg, #34d399 0%, #10b981 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .tf-hero-sub-statement {
      font-size: clamp(17px, 2vw, 21px);
      line-height: 1.6;
      color: var(--tf-text-secondary);
      max-width: 740px;
      margin: 0 auto 36px;
    }

    .tf-hero-cta-group {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }

    .tf-btn-hero-primary {
      background: var(--tf-accent-emerald);
      color: #050f0b;
      padding: 15px 36px;
      border-radius: 9999px;
      font-size: 14.5px;
      font-weight: 750;
      text-decoration: none;
      transition: all 0.25s ease;
      box-shadow: 0 0 32px rgba(16, 185, 129, 0.35);
    }

    .tf-btn-hero-primary:hover {
      background: #34d399;
      transform: translateY(-2px);
      box-shadow: 0 0 45px rgba(16, 185, 129, 0.55);
    }

    .tf-btn-hero-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--tf-border-glass);
      color: #ffffff;
      padding: 15px 34px;
      border-radius: 9999px;
      font-size: 14.5px;
      font-weight: 650;
      cursor: pointer;
      backdrop-filter: blur(8px);
      transition: all 0.25s ease;
    }

    .tf-btn-hero-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Core Interactive Living Fabric */
    .tf-hero-core-canvas {
      position: relative;
      z-index: 1;
      background: #081a13;
      border: 1px solid var(--tf-border-accent);
      border-radius: 28px;
      padding: 36px;
      box-shadow: 0 32px 100px -20px rgba(0, 0, 0, 0.9), 0 0 50px rgba(16, 185, 129, 0.08);
      max-width: 1240px;
      margin: 0 auto;
    }

    .tf-canvas-control-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--tf-border-glass);
      margin-bottom: 32px;
    }

    .tf-canvas-title-box {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13.5px;
      font-weight: 750;
      color: #ffffff;
    }

    .tf-live-indicator {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .tf-version-pill {
      background: rgba(16, 185, 129, 0.12);
      color: #10b981;
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid rgba(16, 185, 129, 0.25);
    }

    .tf-canvas-metrics-summary {
      display: flex;
      gap: 28px;
    }

    .tf-metric-cell {
      text-align: right;
    }

    .tf-metric-label {
      display: block;
      font-family: var(--font-mono);
      font-size: 9.5px;
      color: var(--tf-text-secondary);
      letter-spacing: 0.1em;
      margin-bottom: 2px;
    }

    .tf-metric-val {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 800;
      color: #ffffff;
    }

    .tf-radial-core-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 12px;
      align-items: center;
      margin: 16px 0 28px;
    }

    .tf-core-node {
      background: var(--tf-forest-surface);
      border: 1px solid var(--tf-border-glass);
      border-radius: 16px;
      padding: 20px 14px;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      text-align: left;
      position: relative;
    }

    .tf-core-node:hover {
      background: var(--tf-forest-hover);
      border-color: var(--tf-accent-emerald);
      transform: translateY(-4px);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5), 0 0 20px rgba(16, 185, 129, 0.15);
    }

    .tf-core-centerpiece {
      background: linear-gradient(135deg, #0e2f23, #154534);
      border-color: rgba(16, 185, 129, 0.45);
      text-align: center;
      padding: 24px 14px;
      box-shadow: 0 0 30px rgba(16, 185, 129, 0.15);
    }

    .tf-center-logo {
      width: 36px;
      height: 36px;
      margin: 0 auto 8px;
      background: var(--tf-accent-emerald);
      color: #050f0b;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-weight: 900;
      font-size: 16px;
    }

    .tf-center-title {
      font-size: 15px;
      font-weight: 850;
      letter-spacing: 0.04em;
      color: #ffffff;
    }

    .tf-center-caption {
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--tf-text-secondary);
      margin-top: 4px;
    }

    .tf-node-badge {
      font-family: var(--font-mono);
      font-size: 9.5px;
      color: var(--tf-accent-emerald);
      font-weight: 700;
      letter-spacing: 0.1em;
      margin-bottom: 8px;
    }

    .tf-node-title {
      font-size: 14px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 6px;
      letter-spacing: -0.01em;
    }

    .tf-node-meta {
      font-size: 11px;
      color: var(--tf-text-secondary);
      line-height: 1.4;
    }

    .tf-canvas-footer-strip {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid var(--tf-border-glass);
      padding-top: 18px;
    }

    /* WOW SECTION: THE LIVING SUPPLY CHAIN GRAPH */
    .tf-wow-section {
      padding: 120px 40px;
      background: linear-gradient(180deg, #050f0b 0%, #071711 50%, #050f0b 100%);
      border-top: 1px solid var(--tf-border-glass);
      border-bottom: 1px solid var(--tf-border-glass);
    }

    .tf-section-shell {
      max-width: 1400px;
      margin: 0 auto;
    }

    .tf-wow-header {
      max-width: 860px;
      margin-bottom: 64px;
    }

    .tf-wow-eyebrow {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 750;
      color: var(--tf-accent-emerald);
      letter-spacing: 0.16em;
      margin-bottom: 16px;
    }

    .tf-wow-h2 {
      font-size: clamp(38px, 4.6vw, 64px);
      font-weight: 850;
      letter-spacing: -0.04em;
      line-height: 1.08;
      color: #ffffff;
      margin-bottom: 20px;
    }

    .tf-wow-lead {
      font-size: 18.5px;
      line-height: 1.6;
      color: var(--tf-text-secondary);
    }

    /* Pipeline Step Strip */
    .tf-chain-pipeline-scroll {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 12px;
      margin-bottom: 32px;
    }

    .tf-chain-node {
      background: var(--tf-forest-dark);
      border: 1px solid var(--tf-border-glass);
      border-radius: 16px;
      padding: 18px 14px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tf-chain-node.active, .tf-chain-node:hover {
      background: var(--tf-forest-surface);
      border-color: var(--tf-accent-emerald);
      transform: translateY(-2px);
    }

    .tf-step-order {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--tf-text-secondary);
      font-weight: 700;
      margin-bottom: 6px;
    }

    .tf-step-name {
      font-size: 15px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 4px;
    }

    .tf-step-type {
      font-size: 11.5px;
      color: var(--tf-text-secondary);
      margin-bottom: 8px;
    }

    .tf-step-status {
      font-size: 10.5px;
      font-family: var(--font-mono);
      color: #34d399;
    }

    /* Deep Inspector Card */
    .tf-inspector-card-shell {
      background: var(--tf-forest-dark);
      border: 1px solid var(--tf-border-accent);
      border-radius: 24px;
      padding: 36px;
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 36px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
      transition: all 0.3s ease;
    }

    .tf-inspector-badge {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--tf-accent-emerald);
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 4px 10px;
      border-radius: 6px;
      margin-bottom: 14px;
    }

    .tf-inspector-title {
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 8px;
    }

    .tf-inspector-location {
      font-size: 13px;
      color: #34d399;
      font-family: var(--font-mono);
      margin-bottom: 16px;
    }

    .tf-inspector-desc {
      font-size: 14.5px;
      line-height: 1.6;
      color: var(--tf-text-secondary);
      margin-bottom: 24px;
    }

    .tf-inspector-tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tf-insp-tag {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--tf-border-glass);
      color: #ffffff;
      padding: 5px 12px;
      border-radius: 9999px;
      font-size: 11px;
      font-family: var(--font-mono);
    }

    .tf-inspector-right {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .tf-stat-box {
      background: var(--tf-forest-surface);
      border: 1px solid var(--tf-border-glass);
      border-radius: 14px;
      padding: 16px 20px;
    }

    .tf-stat-title {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--tf-text-secondary);
      letter-spacing: 0.1em;
      margin-bottom: 4px;
    }

    .tf-stat-num {
      font-size: 22px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 2px;
    }

    .tf-stat-sub {
      font-size: 11px;
      color: var(--tf-text-secondary);
    }

    @media (max-width: 1024px) {
      .tf-radial-core-grid {
        grid-template-columns: repeat(2, 1fr);
      }
      .tf-chain-pipeline-scroll {
        grid-template-columns: repeat(2, 1fr);
      }
      .tf-inspector-card-shell {
        grid-template-columns: 1fr;
      }
      .tf-nav-strip {
        display: none;
      }
    }

    @media (max-width: 640px) {
      .tf-radial-core-grid, .tf-chain-pipeline-scroll {
        grid-template-columns: 1fr;
      }
      .tf-hero-stage, .tf-wow-section {
        padding: 60px 20px;
      }
    }
'''

# JavaScript data driver for WOW deep inspection
wow_js = '''
  <script>
    const chainNodesData = [
      {
        tier: "TIER 4 AGRICULTURAL PROVENANCE",
        name: "Elysian Organic Cotton Collective",
        loc: "📍 Izmir Agricultural Basin, Turkey · Field Polygon #482",
        desc: "Strictly non-GMO organic cotton harvest certified under GOTS Scope Certificate CU-881294. Verified water stewardship and zero synthetic pesticides.",
        tags: ["GOTS Organic", "Regenerative Cotton", "Water Footprint -45%"],
        quality: "96.2%",
        styles: "14 Collections",
        proof: "GOTS Transaction Cert #889"
      },
      {
        tier: "TIER 3 RING SPINNING MILL",
        name: "Filature de Haute-Vienne",
        loc: "📍 Guimarães / Porto Industrial Valley · Polygon Verified",
        desc: "Ring spinning facility producing combed compact yarns (Count Ne 30/1). Continuous mass-balance records with digital custody transfers.",
        tags: ["OEKO-TEX Step", "Zero Slub Index", "Mass-Balance Conserved"],
        quality: "94.8%",
        styles: "28 Styles",
        proof: "Batch Ledger Hash 0x9b1f"
      },
      {
        tier: "TIER 2 WEAVING & KNITTING HOUSE",
        name: "Portugal Textile Mill & Loom House",
        loc: "📍 Santo Tirso, Northern Portugal · Polygon GPS Mapped",
        desc: "Specialized in 185g/m² single jersey and 3/1 cotton twills. ISO 17025 accredited laboratory test reports on burst strength and shrinkage.",
        tags: ["GOTS 6.0", "ISO 17025 Certified", "Zero Flame Retardants"],
        quality: "98.4%",
        styles: "42 Styles",
        proof: "Lab Audit Dossier #302"
      },
      {
        tier: "TIER 2 WET PROCESSING & DYEING",
        name: "EcoDye Ennoblissement Aquitaine",
        loc: "📍 Castres Textile Hub, France · Facility #8891",
        desc: "Closed-loop water recycling with zero discharge of hazardous chemicals. Full conformance with ZDHC MRSL Level 3 standards.",
        tags: ["ZDHC MRSL Level 3", "Bluesign System", "Effluent Recycled 92%"],
        quality: "99.1%",
        styles: "18 Styles",
        proof: "Effluent Lab Report Valid"
      },
      {
        tier: "TIER 1 GARMENT MANUFACTURING",
        name: "Atelier Confection & Tailoring SAS",
        loc: "📍 Barcelos, Portugal · Facility GPS Polygon",
        desc: "Automated precision cutting and ethical garment assembly. Audited under SMETA 4-Pillar with verified living wage benchmarks (Anker formula).",
        tags: ["SMETA 4-Pillar", "SA8000 Ethical", "Living Wage Verified"],
        quality: "100%",
        styles: "42 Styles",
        proof: "Social Audit Grade A"
      },
      {
        tier: "PRODUCT RECONCILIATION LAYER",
        name: "Essentiel Cotton Overshirt #4289",
        loc: "📍 Paris Design HQ & Central European Logistics",
        desc: "Finished textile piece reconciling 100% mass-balance composition. Complete Tier 1 to 4 traceability chain verified and locked for regulatory audit.",
        tags: ["ESPR Ready", "French AGEC Art. 13", "100% Reconciled"],
        quality: "98.4%",
        styles: "Stock SKU AT-ESS-001",
        proof: "Immutable SHA-256 Seal"
      },
      {
        tier: "LAYER 07 PUBLIC PASSPORT",
        name: "Digital Product Passport Gateway",
        loc: "📍 GS1 Resolver Node · CIRPASS 1.2 Compliant",
        desc: "Public consumer QR passport delivering transparent origin, repair instructions, and recycling take-back data without disclosing upstream trade secrets.",
        tags: ["GS1 Digital Link", "JSON-LD Semantic", "Take-Back Active"],
        quality: "100%",
        styles: "Live Public QR",
        proof: "Cryptographic Seal Active"
      }
    ];

    function showChainNode(idx) {
      document.querySelectorAll('.tf-chain-node').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
      });
      const d = chainNodesData[idx];
      if (!d) return;

      document.getElementById('insp-tier').textContent = d.tier;
      document.getElementById('insp-name').textContent = d.name;
      document.getElementById('insp-loc').textContent = d.loc;
      document.getElementById('insp-desc').textContent = d.desc;
      document.getElementById('insp-quality').textContent = d.quality;
      document.getElementById('insp-styles').textContent = d.styles;
      document.getElementById('insp-proof').textContent = d.proof;

      const tagsContainer = document.getElementById('insp-tags');
      if (tagsContainer) {
        tagsContainer.innerHTML = d.tags.map(t => `<span class="tf-insp-tag">${t}</span>`).join('');
      }
    }

    function inspectCoreNode(layerIdx) {
      const wowElem = document.getElementById('wow-ecosystem');
      if (wowElem) {
        wowElem.scrollIntoView({ behavior: 'smooth' });
        showChainNode(layerIdx);
      }
    }
  </script>
'''

# Read index.html
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Insert phase3_css before </style>
html = html.replace('</style>', phase3_css + '\n  </style>', 1)

# Find replacement range: from header to section 2
header_start = html.find('<!-- ==========================================================================\n       TOP HERO STAGE')
if header_start == -1:
    header_start = html.find('<div class="hero-wrapper">')

section2_start = html.find('<!-- ==========================================================================\n       SECTION 2: PLAN SMARTER TRIPS IN SECONDS')
if section2_start == -1:
    section2_start = html.find('<section class="section-editorial-row"')

print('Replacing hero range from', header_start, 'to', section2_start)
html = html[:header_start] + new_hero_section_html + '\n  ' + html[section2_start:]

# Add wow_js before </body>
html = html.replace('</body>', wow_js + '\n</body>', 1)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("Phase 3 successfully integrated into index.html.")
