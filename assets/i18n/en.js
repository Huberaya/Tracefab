/* ==========================================================================
   TRACEFAB — Reference locale (EN)
   Loaded synchronously so the default language never depends on a fetch.
   Every other locale is a JSON file in /assets/i18n/<lang>.json and is
   merged over this bundle.

   RULE: no business copy may live inside a component. It lives here.
   ========================================================================== */
window.TF_I18N_BUNDLES = window.TF_I18N_BUNDLES || {};
window.TF_I18N_BUNDLES.en = {
  meta: {
    title: 'TRACEFAB — The intelligence layer for the global textile supply chain',
    description:
      'TRACEFAB connects supplier data, evidence, quality, traceability and Digital Product Passport readiness in one intelligent infrastructure for textile and apparel brands.'
  },

  common: {
    demoData: 'Demonstration data',
    demoNote: 'All figures on this page are demonstration data.',
    skip: 'Skip to main content'
  },

  nav: {
    why: 'Why TRACEFAB',
    platform: 'Platform',
    supplyChain: 'Supply Chain',
    productIntel: 'Product Intelligence',
    dpp: 'DPP',
    resources: 'Resources',
    signIn: 'Sign in',
    demo: 'Request a demo',
    openMenu: 'Open menu',
    language: 'Language'
  },

  hero: {
    label: 'European textile data infrastructure',
    line1: 'Know your product.',
    line2: 'Know your supply chain.',
    line3: 'Prove it.',
    sub: 'TRACEFAB connects supplier data, evidence, quality, traceability and Digital Product Passport readiness in one intelligent infrastructure.',
    ctaPrimary: 'Explore TRACEFAB',
    ctaSecondary: 'Request a demo',
    scroll: 'Unfold the system'
  },

  core: {
    title: 'Living data core',
    hub: 'TRACEFAB',
    hubSub: 'DATA × TEXTILE × TRUST',
    stat1: '1,248',
    stat1Label: 'Connected products',
    stat2: '214',
    stat2Label: 'Facilities mapped',
    stat3: '92.4%',
    stat3Label: 'Data quality',
    footLeft: 'All seven layers synchronised',
    footRight: 'ESPR · AGEC Art. 13 · CSRD · GS1 Digital Link',
    inspectHint: 'Hover an entity',
    nodes: {
      suppliers:      { label: 'Suppliers',      meta: 'Tier 1 to Tier 4',      value: '86',     kind: 'Supply chain · Layer 01', r1k: 'Active suppliers', r1v: '86', r2k: 'Countries', r2v: '18', r3k: 'Avg. data quality', r3v: '87%' },
      products:       { label: 'Products',       meta: 'Styles & references',   value: '1,248',  kind: 'Product data · Layer 02', r1k: 'Active products', r1v: '1,248', r2k: 'With full BOM', r2v: '1,094', r3k: 'Revisions tracked', r3v: '4,310' },
      materials:      { label: 'Materials',      meta: 'Fibres, yarns, fabrics',value: '3,106',  kind: 'Product data · Layer 02', r1k: 'Material records', r1v: '3,106', r2k: 'Certified inputs', r2v: '71%', r3k: 'Composition resolved', r3v: '94%' },
      facilities:     { label: 'Facilities',     meta: 'Sites & processes',     value: '214',    kind: 'Supply chain · Layer 01', r1k: 'Mapped sites', r1v: '214', r2k: 'Geolocated', r2v: '188', r3k: 'Audited in 24 months', r3v: '132' },
      documents:      { label: 'Documents',      meta: 'Evidence vault',        value: '9,847',  kind: 'Evidence · Layer 03', r1k: 'Stored documents', r1v: '9,847', r2k: 'Machine-read', r2v: '6,220', r3k: 'Linked to a product', r3v: '84%' },
      certifications: { label: 'Certifications', meta: 'Standards & scopes',    value: '612',    kind: 'Evidence · Layer 03', r1k: 'Valid certificates', r1v: '612', r2k: 'Expiring in 90 days', r2v: '8', r3k: 'Standards covered', r3v: '21' },
      evidence:       { label: 'Evidence',       meta: 'Proof coverage',        value: '84%',    kind: 'Evidence · Layer 03', r1k: 'Evidence coverage', r1v: '84%', r2k: 'Verified items', r2v: '78%', r3k: 'Integrity sealed', r3v: 'SHA-256' },
      quality:        { label: 'Quality',        meta: 'Six-level trust scale', value: '92.4%',  kind: 'Data quality · Layer 04', r1k: 'Data completeness', r1v: '92.4%', r2k: 'Verification rate', r2v: '78%', r3k: 'Open issues', r3v: '42' },
      traceability:   { label: 'Traceability',   meta: 'Fibre to product',      value: '91%',    kind: 'Traceability · Layer 05', r1k: 'Products traceable', r1v: '91%', r2k: 'Chains to Tier 4', r2v: '63%', r3k: 'Avg. chain depth', r3v: '7 steps' },
      dpp:            { label: 'DPP',            meta: 'Passport readiness',    value: '88%',    kind: 'DPP · Layer 07', r1k: 'DPP readiness', r1v: '88%', r2k: 'Ready to publish', r2v: '1,098', r3k: 'Blocked by evidence', r3v: '150' }
    }
  },

  ticker: {
    i1: 'France', i2: 'Portugal', i3: 'Italy', i4: 'Germany', i5: 'Türkiye', i6: 'Morocco',
    i7: 'Tunisia', i8: 'India', i9: 'Bangladesh', i10: 'Vietnam', i11: 'China', i12: 'United States',
    i13: 'ESPR 2024/1781', i14: 'AGEC Article 13', i15: 'CSRD', i16: 'GS1 Digital Link',
    i17: 'GOTS', i18: 'GRS', i19: 'OEKO-TEX', i20: 'ZDHC MRSL', i21: 'CIRPASS'
  },

  eco: {
    label: 'The connected foundation',
    index: '01',
    line1: 'Your entire textile ecosystem.',
    line2: 'One connected data foundation.',
    lead: 'A textile chain is not a list of suppliers. It is a sequence of transformations, each with its own company, site, certificate, document and level of proof. TRACEFAB holds all of it in one continuous model — and lets you read it one dimension at a time, or all at once.',
    hint: 'Select a stage to open its dossier. Toggle dimensions to read the same chain through a different lens.'
  },

  chain: {
    dimensionsLabel: 'Dimensions',
    stageLabel: 'Stage',
    footLeft: 'Demonstration chain · Organic Cotton T-Shirt AW26-0248',
    footRight: '9 stages · 4 tiers · 3 countries',
    verticalHint: 'Tap a stage for details',
    dims: {
      supplier: 'Supplier',
      country: 'Country',
      facility: 'Facility',
      certificate: 'Certificate',
      document: 'Document',
      quality: 'Quality',
      status: 'Status'
    },
    status: {
      verified: 'Verified',
      certified: 'Certified',
      documented: 'Documented',
      review: 'Needs review',
      declared: 'Declared',
      missing: 'Missing'
    },
    metricLabels: {
      quality: 'Data quality',
      certificates: 'Certificates',
      products: 'Products',
      evidence: 'Evidence',
      sites: 'Sites',
      tier: 'Tier'
    },
    stages: {
      fiber: {
        name: 'Fibre', tier: 'Tier 4',
        supplier: 'Algodão Vivo Cooperative', country: 'Portugal', facility: 'Baixo Alentejo farm cluster',
        certificate: 'GOTS 6.0 scope', document: 'Transaction certificate',
        dossierName: 'Algodão Vivo Cooperative',
        desc: 'Organic cotton grower cooperative supplying raw fibre with lot-level transaction certificates reconciled against mass balance.'
      },
      material: {
        name: 'Material', tier: 'Tier 4',
        supplier: 'Fibrha Material Lab', country: 'Portugal', facility: 'Porto material laboratory',
        certificate: 'GRS 4.0', document: 'Material declaration',
        dossierName: 'Fibrha Material Lab',
        desc: 'Material characterisation and blend declaration. Composition is resolved to percentage level and bound to the product bill of materials.'
      },
      spinning: {
        name: 'Spinning', tier: 'Tier 3',
        supplier: 'Guimarães Ring Spinners', country: 'Portugal', facility: 'Guimarães spinning mill',
        certificate: 'OEKO-TEX Standard 100', document: 'Laboratory test report',
        dossierName: 'Guimarães Ring Spinners',
        desc: 'Ring spinning of combed organic yarn. Test reports are attached but third-party verification is still pending for two counts.'
      },
      weaving: {
        name: 'Weaving', tier: 'Tier 2',
        supplier: 'Portugal Textile Mill', country: 'Portugal', facility: 'Guimarães weaving house',
        certificate: 'GOTS 6.0', document: 'Production record',
        dossierName: 'Portugal Textile Mill',
        desc: 'Jersey knitting and weaving house with closed-loop water treatment. Full custody transfer evidence recorded for every garment lot.'
      },
      dyeing: {
        name: 'Dyeing', tier: 'Tier 2',
        supplier: 'Adriatic Dye House', country: 'Italy', facility: 'Prato finishing plant',
        certificate: 'ZDHC MRSL Level 3', document: 'Wastewater test report',
        dossierName: 'Adriatic Dye House',
        desc: 'Reactive dyeing and finishing. The latest wastewater report is older than the twelve-month window, so the stage is flagged for review.'
      },
      cutting: {
        name: 'Cutting', tier: 'Tier 1',
        supplier: 'Atelier Milano — Cutting', country: 'Italy', facility: 'Milano cutting room',
        certificate: 'ISO 9001', document: 'Production record',
        dossierName: 'Atelier Milano — Cutting',
        desc: 'Automated cutting with offcut recovery feeding the recycled content stream declared on the passport.'
      },
      assembly: {
        name: 'Assembly', tier: 'Tier 1',
        supplier: 'Atelier Milano', country: 'Italy', facility: 'Milano assembly site',
        certificate: 'SA8000', document: 'Social audit report',
        dossierName: 'Atelier Milano',
        desc: 'Tier 1 manufacturer. Social and quality audits are current, submission rate is high, and two open issues are in remediation.'
      },
      product: {
        name: 'Product', tier: 'Brand',
        supplier: 'Atelier Demo', country: 'France', facility: 'Paris design studio',
        certificate: 'Product data core 1.0', document: 'Product data sheet',
        dossierName: 'Organic Cotton T-Shirt · AW26-0248',
        desc: 'The finished reference. Composition, identifiers, supply chain and evidence are consolidated into a single auditable product record.'
      },
      dpp: {
        name: 'DPP', tier: 'Passport',
        supplier: 'TRACEFAB', country: 'European Union', facility: 'Public passport endpoint',
        certificate: 'GS1 Digital Link', document: 'Passport record',
        dossierName: 'Digital Product Passport',
        desc: 'Readiness indicator for publication. Identity, composition, materials, supplier and manufacturing data are complete; two evidence items remain.'
      }
    }
  },

  spine: {
    label: 'Platform architecture',
    index: '02',
    line1: 'Seven layers.',
    line2: 'One continuous chain of proof.',
    lead: 'Simple to understand. Deep to explore. Powerful to operate. Each layer answers one question, and hands its answer to the next.',
    openHint: 'Explore layer',
    layers: {
      l1: { num: 'Layer 01', name: 'Supply Chain', q: 'Who makes what?', desc: 'Suppliers, factories, sites, materials and processes mapped across every tier — not a vendor list, a production network.', chips: 'Suppliers · Factories · Sites · Materials · Processes', value: '214', valueLabel: 'Facilities mapped' },
      l2: { num: 'Layer 02', name: 'Product Data', q: 'What is the product?', desc: 'Composition, components, materials and identifiers resolved to the percentage, versioned on every revision.', chips: 'Products · Composition · Materials · Components · Identifiers', value: '1,248', valueLabel: 'Products connected' },
      l3: { num: 'Layer 03', name: 'Evidence', q: 'Can we prove it?', desc: 'Documents, certificates, declarations, audits and test reports stored with issuer, scope, validity and integrity seal.', chips: 'Documents · Certificates · Declarations · Audits · Tests', value: '9,847', valueLabel: 'Evidence items' },
      l4: { num: 'Layer 04', name: 'Data Quality', q: 'Can we trust it?', desc: 'Every value carries a level: declared, documented, verified, certified, needs review or missing. Trust becomes measurable.', chips: 'Declared · Documented · Verified · Certified · Review · Missing', value: '92.4%', valueLabel: 'Data quality' },
      l5: { num: 'Layer 05', name: 'Traceability', q: 'Where did it come from?', desc: 'Fibre to material to processing to manufacturing to product — a continuous custody chain, not disconnected claims.', chips: 'Fibre → Material → Processing → Manufacturing → Product', value: '91%', valueLabel: 'Products traceable' },
      l6: { num: 'Layer 06', name: 'Intelligence', q: 'What does the data tell us?', desc: 'Risk, gaps, supplier performance, product readiness and regulatory readiness computed from your own data — never invented.', chips: 'Risk · Gaps · Quality · Supplier performance · Readiness', value: '42', valueLabel: 'Open signals' },
      l7: { num: 'Layer 07', name: 'DPP', q: 'What can we publish?', desc: 'A readiness indicator, a product passport and a public consumer experience. A readiness score, never a legal certification.', chips: 'DPP readiness · Product passport · Public data · Consumer view', value: '88%', valueLabel: 'DPP readiness' }
    }
  },

  promise: {
    label: 'Why TRACEFAB',
    index: '03',
    line1: 'The intelligence layer',
    line2: 'for the global textile supply chain.',
    c1Verb: 'See it.',
    c1Txt: 'Every supplier, site, material and transformation in one connected model — including the tiers you have never been able to reach.',
    c2Verb: 'Structure it.',
    c2Txt: 'Spreadsheets and PDFs become structured data points, bound to products, versioned and comparable across your whole catalogue.',
    c3Verb: 'Verify it.',
    c3Txt: 'Every value carries a level of proof, from a simple declaration to a third-party certificate, with expiry and integrity tracked.',
    c4Verb: 'Prove it.',
    c4Txt: 'Regulatory readiness, audit packs and Digital Product Passport preparation generated from the data you already hold.',
    kicker: 'See it. Structure it. Verify it. Trace it. Prove it.'
  },

  footer: {
    statement: 'The intelligence layer for the global textile supply chain.',
    europe: 'European by design · Global by architecture',
    colPlatform: 'Platform',
    colDomains: 'Domains',
    colResources: 'Resources',
    platform1: 'Brand Console',
    platform2: 'Supplier Portal',
    platform3: 'Quality Center',
    platform4: 'Public DPP',
    domains1: 'Supply chain mapping',
    domains2: 'Evidence & certifications',
    domains3: 'Data quality',
    domains4: 'Traceability',
    domains5: 'DPP readiness',
    resources1: 'Platform architecture',
    resources2: 'Design system',
    resources3: 'API reference',
    resources4: 'Security & multi-tenancy',
    rights: '© 2026 TRACEFAB. All rights reserved.',
    legal: 'DPP readiness is a preparation indicator, not a legal certification.'
  },

  modal: {
    eyebrow: 'Request a demo',
    title: 'See TRACEFAB on your own supply chain.',
    lead: 'Tell us a little about your organisation and we will prepare a walkthrough using a chain that looks like yours.',
    name: 'Full name',
    email: 'Work email',
    company: 'Company',
    role: 'Role',
    roleBrand: 'Brand / Manufacturer',
    roleSupplier: 'Supplier',
    roleConsultant: 'Consultant / Auditor',
    roleOther: 'Other',
    submit: 'Request a demo',
    cancel: 'Cancel',
    close: 'Close',
    successTitle: 'Request recorded.',
    successTxt: 'This demonstration form is not connected to a mailbox yet. Nothing was transmitted.'
  },

  pi: {
    demoBanner: 'Demonstration record — every figure on this page is demonstration data.',
    console: 'product intelligence',
    demoUser: 'Demonstration workspace',
    nav: {
      main: 'Main console',
      overview: 'Overview',
      products: 'Products',
      suppliers: 'Suppliers',
      materials: 'Materials',
      supplyChain: 'Supply chain',
      collection: 'Collection & compliance',
      dataCollection: 'Data collection',
      evidence: 'Evidence',
      certifications: 'Certifications',
      quality: 'Quality',
      risk: 'Risk',
      dpp: 'DPP',
      governance: 'Governance',
      reports: 'Reports',
      settings: 'Settings'
    },
    product: {
      name: 'Organic Cotton T-Shirt',
      ref: 'AW26-0248',
      collection: 'Autumn / Winter 2026',
      lead: 'Every value below carries a level of proof. Nothing is asserted without a document behind it.'
    },
    actions: {
      viewPassport: 'View public passport',
      requestData: 'Request data'
    },
    sections: {
      signals: 'Product signals',
      identity: 'Identity',
      timeline: 'Recent activity',
      composition: 'Composition',
      materials: 'Materials',
      lineage: 'Product lineage',
      manufacturing: 'Manufacturing',
      suppliers: 'Suppliers',
      evidence: 'Evidence',
      certifications: 'Certifications',
      quality: 'Data quality',
      issues: 'Open issues',
      dpp: 'DPP readiness',
      history: 'Full history'
    },
    metrics: {
      quality: 'Data quality',
      evidence: 'Evidence coverage',
      traceability: 'Traceability',
      dpp: 'DPP readiness'
    },
    tabs: {
      overview: 'Overview',
      composition: 'Composition',
      materials: 'Materials',
      supplyChain: 'Supply chain',
      manufacturing: 'Manufacturing',
      suppliers: 'Suppliers',
      evidence: 'Evidence',
      certifications: 'Certifications',
      quality: 'Quality',
      dpp: 'DPP',
      history: 'History'
    },
    trust: {
      missing: 'Missing',
      review: 'Review',
      declared: 'Declared',
      documented: 'Documented',
      verified: 'Verified',
      certified: 'Certified'
    },
    labels: {
      reference: 'Reference',
      gtin: 'GTIN',
      sku: 'SKU',
      category: 'Category',
      collection: 'Collection',
      madeIn: 'Made in',
      status: 'Status',
      material: 'Material',
      share: 'Share',
      standard: 'Standard',
      proof: 'Proof',
      type: 'Type',
      supplier: 'Supplier',
      origin: 'Origin',
      step: 'Step',
      facility: 'Facility',
      country: 'Country',
      tier: 'Tier',
      dataQuality: 'Data quality',
      certificates: 'Certificates',
      document: 'Document',
      issuer: 'Issuer',
      issued: 'Issued',
      expires: 'Expires',
      verification: 'Verification',
      certificate: 'Certificate',
      scope: 'Scope',
      holder: 'Holder',
      fix: 'Fix'
    },
    values: {
      category: 'Jersey knitwear — short sleeve',
      collection: 'Autumn / Winter 2026',
      madeIn: 'Italy',
      status: 'Active — publication pending'
    },
    fibers: {
      organicCotton: 'Organic cotton',
      recycledElastane: 'Recycled elastane',
      sewingThread: 'Sewing thread'
    },
    types: {
      yarn: 'Yarn',
      fabric: 'Fabric',
      chemical: 'Chemical',
      trim: 'Trim'
    },
    steps: {
      spinning: 'Spinning',
      knitting: 'Knitting',
      dyeing: 'Dyeing',
      cutting: 'Cutting',
      assembly: 'Assembly',
      finishing: 'Finishing'
    },
    lineage: {
      nodes: {
        fiber: 'Fiber',
        spinner: 'Spinner',
        yarn: 'Yarn',
        fabric: 'Fabric',
        dyehouse: 'Dye house',
        manufacturer: 'Manufacturer',
        product: 'Finished product',
        dpp: 'DPP'
      },
      detail: {
        fiber: 'Raw organic cotton with per-lot transaction certificates, reconciled against mass balance.',
        spinner: 'Ring spinning of combed organic yarn. Third-party verification still pending on two counts.',
        yarn: 'Yarn lots linked to the product bill of materials with full chain-of-custody records.',
        fabric: 'Single jersey knitting with closed-loop water treatment at the Guimarães hall.',
        dyehouse: 'Reactive dyeing and finishing. Latest wastewater report is outside the twelve-month window.',
        manufacturer: 'Tier 1 assembly. Social and quality audits current, two findings in progress.',
        product: 'The finished article. Composition, identifiers, chain and evidence consolidated.',
        dpp: 'Publication readiness indicator. Two evidence items still outstanding.'
      }
    },
    docs: {
      transactionCert: 'Transaction certificate',
      labReport: 'Laboratory test report',
      socialAudit: 'Social audit report',
      wastewater: 'Wastewater analysis',
      productionRecord: 'Production record',
      materialDeclaration: 'Material declaration'
    },
    scopes: {
      scopeFiberFabric: 'Fiber to fabric',
      scopeRecycled: 'Recycled content',
      scopeChemical: 'Chemical safety',
      scopeSocial: 'Social compliance',
      scopeWastewater: 'Wastewater discharge'
    },
    quality: {
      completeness: 'Completeness',
      evidenceCoverage: 'Evidence coverage',
      verificationRate: 'Verification rate',
      supplyChainDepth: 'Supply chain depth'
    },
    issues: {
      issueWastewater: {
        t: 'Wastewater analysis out of date',
        d: 'Adriatic Dye House — last report exceeds the twelve-month window'
      },
      issueOekoTex: {
        t: 'OEKO-TEX certificate expiring',
        d: 'Guimarães Ring Spinners — valid for less than 90 days'
      },
      issueSpinnerVerify: {
        t: 'Spinner data awaiting verification',
        d: 'Two yarn counts declared but not third-party verified'
      }
    },
    dpp: {
      title: 'Digital Product Passport readiness',
      lead: 'What this product could publish today, and what is still missing before it can.',
      legal: 'A readiness indicator, never a legal certification.',
      score: 'Readiness',
      ready: 'Ready to publish',
      missing: 'What is missing?',
      items: {
        dppIdentity: 'Product identity and identifiers',
        dppComposition: 'Composition resolved to the percent',
        dppMaterials: 'Materials and their origin',
        dppSuppliers: 'Suppliers across four tiers',
        dppManufacturing: 'Manufacturing steps and facilities',
        dppCare: 'Care and maintenance instructions',
        dppCircularity: 'Circularity and recycled content',
        dppGapWastewater: 'Current wastewater analysis for the dye house',
        dppGapRepair: 'Repair and spare-part information'
      }
    },
    history: {
      hDppRecomputed: 'DPP readiness recomputed — 88%',
      hProductionRecord: 'Production record attached by Atelier Milano',
      hDyeFlagged: 'Dye house flagged for review — wastewater report expired',
      hLabReport: 'Laboratory test report verified by Intertek',
      hComposition: 'Composition declaration resolved to the percent',
      hGotsLinked: 'GOTS 6.0 transaction certificate linked',
      hSocialAudit: 'SA8000 social audit accepted',
      hCreated: 'Product created in the workspace'
    },
    notes: {
      composition: 'Percentages are resolved against the bill of materials and reconciled with the fiber transaction certificates.',
      lineage: 'Select a stage to inspect the organisation behind it. Each hop carries its own level of proof.',
      evidence: 'Every document is stored with its issuer, scope, validity window and a SHA-256 integrity seal.',
      issues: 'Each issue links to the screen that resolves it',
      otherRef: 'Requested reference {ref} — showing the demonstration record.'
    }
  },
  lang: {
    en: 'English',
    fr: 'Français',
    de: 'Deutsch',
    it: 'Italiano',
    es: 'Español',
    nl: 'Nederlands',
    pt: 'Português',
  },

  // --- portees applicatives (console, portail, DPP public) ---------------
  shared: {
    stDraft: "Draft",
    stSent: "Sent",
    stInProgress: "In progress",
    stSubmitted: "Submitted",
    stChangesRequested: "Changes requested",
    stApproved: "Approved",
    stCancelled: "Cancelled",
    stVerified: "Verified",
    stNeedsReview: "Needs review",
    stOpen: "Open",
    stAcknowledged: "Acknowledged",
    stWaived: "Waived",
    stResolved: "Resolved",
    stNotStarted: "Not started",
    stDataReady: "Ready for validation",
    stReadyToPublish: "Ready to publish",
    stReviewRequired: "Review required",
    stActive: "Active",
    stCompleted: "Completed",
    stInvited: "Invited",
    stDeclared: "Declared",
    stDocumented: "Documented",
    stUploaded: "Saved",
    stScanning: "Scanning",
    stAvailable: "Available",
    stRejected: "Rejected",
    stDeleted: "Deleted",
    stSuspended: "Suspended",
    stRevoked: "Revoked",
    demoUnavailable: "Not available in demonstration mode — connect the TRACEFAB APIs to run this action.",
    overview: "Overview",
    requests: "Data Requests",
    certifications: "Certifications",
    signOut: "Sign out"
  },

  console: {
    // --- Risk & exposure (vue Risk) ---
    risk: "Risk",
    riskViewLabel: "Risk & Exposure",
    riskEyebrow: "RISK & EXPOSURE",
    riskTitle: "Where are you exposed?",
    riskLead: "Exposure is derived from the supplier, country, product and data-collection signals already held in TRACEFAB. It is an operational indicator meant to prioritise work — not a certification, an audit result or a legal assessment.",
    riskNotCertification: "Indicator, not a certification",
    riskRecompute: "Recompute",
    riskIndex: "Exposure index",
    riskSuppliersAtRisk: "Suppliers flagged",
    riskProductsExposed: "Products exposed",
    riskCriticalSignals: "Critical signals",
    riskOutOf100: "out of 100",
    riskBandLow: "Low",
    riskBandModerate: "Moderate",
    riskBandElevated: "Elevated",
    riskBandHigh: "High",
    riskDimTitle: "Exposure by dimension",
    riskDimConcentration: "Supplier concentration",
    riskDimGeography: "Geographic exposure",
    riskDimData: "Data gaps",
    riskDimCollection: "Collection delays",
    riskDimTraceability: "Origin gaps",
    riskRegisterTitle: "Risk register",
    riskRegisterNote: "Every line links to the view where it is fixed.",
    riskColSeverity: "Severity",
    riskColCategory: "Category",
    riskColSubject: "Subject",
    riskColSignal: "Signal",
    riskColAction: "Action",
    riskSevCritical: "Critical",
    riskSevHigh: "High",
    riskSevMedium: "Medium",
    riskSevLow: "Low",
    riskCatSupplier: "Supplier",
    riskCatProduct: "Product",
    riskCatCollection: "Collection",
    riskCatMaterial: "Material",
    riskCatGeography: "Geography",
    riskSigConcentration: "Supplier base concentrated in a single country",
    riskSigInactive: "Supplier relationship is not active",
    riskSigNoCountry: "Supplier has no declared country",
    riskSigIncomplete: "Product data below the completion threshold",
    riskSigNotReady: "Product data not validated",
    riskSigOverdue: "Data request past its due date",
    riskSigStalled: "Data request below expected completion",
    riskSigNoOrigin: "Material without declared origin country",
    riskGeoTitle: "Country concentration",
    riskGeoNote: "Share of the supplier base per country.",
    riskGeoUnknown: "Not declared",
    riskEmpty: "No exposure detected in the data currently loaded.",
    riskEmptyNote: "This view reads the suppliers, products, materials and data requests already loaded in the console.",
    riskOpen: "Open",
    riskBasisTitle: "How this is computed",
    riskBasisBody: "Each dimension is scored from the records loaded in the console, then weighted into a single index. No external rating, no inferred data: a dimension with no records scores zero and says so.",
    riskNoRecords: "no records",
    // --- fin Risk & exposure ---
    // --- Veille des certificats ---
    certValid: "Valid",
    certExpiringSoon: "Expiring soon",
    certExpired: "Expired",
    certWatchCount: "certificate(s) expire within 90 days.",
    certWatchNone: "No certificate expires within the next 90 days.",
    certNextRenewal: "Next renewal",
    certEyebrow: "Standard compliance",
    certTitle: "Certifications & audit standards",
    certLead: "Operating certificates declared across your supplier base, with continuous expiry monitoring.",
    certDeclare: "Declare a certificate",
    certActiveTitle: "Certificates on file",
    certColStandard: "Standard",
    certColNumber: "Certificate number",
    certColIssuer: "Issuing body",
    certColExpiry: "Expiry",
    certColStatus: "Status",
    certWatchTitle: "Expiry watch",
    certRuleTitle: "Continuous compliance rule",
    certRuleBody: "TRACEFAB alerts suppliers automatically 90 days before an operating certificate expires.",
    certNone: "No certificate declared yet.",
    certDaysLeft: "days left",
    // --- fin veille des certificats ---
    navMain: "Main Console",
    products: "Products",
    suppliers: "Suppliers",
    materials: "Materials",
    supplyChain: "Traceability",
    navCollection: "Collection & Compliance",
    questionnaires: "Questionnaires",
    documents: "Documents",
    quality: "Quality & Compliance",
    dpp: "DPP Passport",
    navGov: "Governance",
    reports: "Reports & Audits",
    settings: "Settings",
    newRequest: "+ New request",
    openRequests: "Open requests",
    dueSoon: "Due soon (< 7d)",
    submitted: "Responses received",
    quickActions: "Quick Actions",
    createRequest: "Create data request",
    dppReadiness: "Digital Product Passport (DPP)",
    dppDesc: "Verify your collection readiness against European ESPR and CIRPASS 1.2 standards.",

  },

  portal: {
    // --- Premier ecran du portail (chantier 5) ---
    spDemoBanner: "Demonstration mode — the figures below are demonstration data. Open ?demo=0 to connect Clerk and the Tracefab APIs.",
    spHeroTag: "Shared supplier vault · EU trade secrets directive",
    spHeroTitle: "Your data. Your profile. Reusable across all your customers.",
    spHeroSub: "Upload your certificates and production sites once into your encrypted vault. Share proof of compliance instantly, without disclosing your prices, exclusive subcontractors or margins.",
    spProfileTitle: "Your compliance profile",
    spComplete: "complete",
    spWeakest: "Weakest area",
    spFixNow: "Fix this now",
    spAllOnTarget: "Every area is on target. Nothing needs your attention.",
    spDimCompleteness: "Profile completeness",
    spDimFreshness: "Data freshness",
    spDimDocumentation: "Evidence coverage",
    spDimConsistency: "Data consistency",
    spMissingField: "Missing",
    spFieldRslReport: "an RSL test report",
    spFieldActiveSite: "an active production site",
    spNoScore: "Your compliance score will appear once your first data has been submitted.",
    // --- fin premier ecran du portail ---
    sites: "Production Facilities",
    materials: "Materials & Yarns",
    documents: "Evidence Vault (One-to-Many)",
    dataPoints: "Structured Data",
    members: "Team & Permissions",
    quality: "Quality Score",
    profile: "Company Profile",
    requestDetail: "Respond to Request",
    vaultDesc: "Upload your audit certificates once and share them instantly across all your brand clients.",
    uploadEvidence: "Upload Evidence to Vault",
    ndaTitle: "Trade Secret & Confidentiality Protection",
    ndaDesc: "Proprietary formulas, pricing and margins remain strictly confidential. Only proof hashes and mass-balance reconciliation are shared.",
    hello: "Hello",
    pendingRequests: "Open Requests",
    sitesRegistered: "Registered Facilities",
    validCerts: "Active Certificates",
    qualityIndex: "Data Completion",
    submitToBrand: "Submit to Brand",
    saveDraft: "Save Draft",
    responseRecorded: "Response saved successfully.",
    requestSubmitted: "Request submitted to brand."
  },

  // --- Quality Center ----------------------------------------------------
  quality: {
    loading: "Loading the Quality Center…",
    eyebrowBrand: "Tracefab Quality Center",
    unavailable: "Quality unavailable",
    retry: "Try again",
    signInTitle: "Control your data quality.",
    signInLede: "Explainable scores, actionable issues and a history of review decisions.",
    navHome: "Home",
    navConsole: "Brand Console",
    demoMode: "Demo mode",
    eyebrow: "P1 · data quality",
    heroTitle: "Decide on explainable signals.",
    heroLede: "A cross-cutting review space for the products and suppliers your organisation can access. Declarative statuses are never turned into a certification.",
    refresh: "Refresh",
    metricTotal: "Visible issues",
    metricBlocking: "Open blocking",
    metricWarning: "Warnings",
    metricOpen: "To handle",
    metricAcknowledged: "Acknowledged",
    issuesTitle: "Priority issues",
    allSeverities: "All severities",
    sevBlocking: "Blocking",
    sevInfo: "Information",
    allStatuses: "All statuses",
    colSubject: "Subject",
    colIssue: "Issue",
    colSeverity: "Severity",
    colStatus: "Status",
    colAction: "Action",
    actionAck: "Acknowledge",
    actionWaive: "Waive",
    emptyIssues: "No issue for these filters.",
    scoresTitle: "Latest scores",
    emptyScores: "No score calculated.",
    computedOn: "calculated",
    barCompleteness: "Completeness",
    barFreshness: "Freshness",
    barEvidence: "Evidence",
    barConsistency: "Consistency",
    noticeAck: "Issue acknowledged in demonstration mode.",
    noticeWaive: "Waiver recorded in demonstration mode.",
    noticeSaved: "Action recorded.",
    promptWaive: "Waiver reason",
    demoIssueEvidence: "The main data point has no evidence available yet.",
    demoIssueSupplier: "The supplier profile must be renewed."
  },

  // --- DPP public --------------------------------------------------------
  dpp: {
    badgeEu: "EU ESPR / DPP Compliant",
    verifiedOrigin: "✓ Verified Provenance",
    composition: "Material Composition",
    traceability: "Supply Chain Traceability",
    operations: "Operations & Facilities",
    circularity: "Circularity & Care",
    repairScore: "Repairability Index",
    carbon: "Environmental Footprint",
    passcode: "SHA-256 Verified Seal",
    viewCert: "View Audit Certificate"
  }
};
