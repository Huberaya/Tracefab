    // Pont global stable : TF_I18N.setLanguage est l'implementation, mais
    // window.setLanguage reste l'API publique documentee de la landing
    // (utilisee par le menu #lang-menu-btn et par les tests de contrat).
    window.setLanguage = function (lang) {
      return window.TF_I18N && window.TF_I18N.setLanguage(lang);
    };
  
