/**
 * TRACEFAB Native i18n Micro-Engine
 * European by design. Global by nature.
 */

export type SupportedLanguage = 'en' | 'fr' | 'de' | 'it' | 'es' | 'nl' | 'pt';

export interface LanguageDefinition {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  flag: string;
  numberFormat: { decimal: string; thousand: string };
  dateFormat: string;
}

export const SUPPORTED_LANGUAGES: Record<SupportedLanguage, LanguageDefinition> = {
  en: {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    flag: '🇬🇧',
    numberFormat: { decimal: '.', thousand: ',' },
    dateFormat: 'YYYY-MM-DD',
  },
  fr: {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    flag: '🇫🇷',
    numberFormat: { decimal: ',', thousand: ' ' },
    dateFormat: 'DD/MM/YYYY',
  },
  de: {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    flag: '🇩🇪',
    numberFormat: { decimal: ',', thousand: '.' },
    dateFormat: 'DD.MM.YYYY',
  },
  it: {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    flag: '🇮🇹',
    numberFormat: { decimal: ',', thousand: '.' },
    dateFormat: 'DD/MM/YYYY',
  },
  es: {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    flag: '🇪🇸',
    numberFormat: { decimal: ',', thousand: '.' },
    dateFormat: 'DD/MM/YYYY',
  },
  nl: {
    code: 'nl',
    name: 'Dutch',
    nativeName: 'Nederlands',
    flag: '🇳🇱',
    numberFormat: { decimal: ',', thousand: '.' },
    dateFormat: 'DD-MM-YYYY',
  },
  pt: {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    flag: '🇵🇹',
    numberFormat: { decimal: ',', thousand: ' ' },
    dateFormat: 'DD/MM/YYYY',
  },
};

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/**
 * Detects the user's preferred language using browser settings, URL parameter, or saved preferences.
 */
export function detectUserLanguage(options?: {
  urlLang?: string | null;
  savedLang?: string | null;
  navigatorLangs?: readonly string[];
}): SupportedLanguage {
  // 1. Explicit URL parameter (highest priority: /?lang=fr or /fr/)
  if (options?.urlLang && options.urlLang.toLowerCase() in SUPPORTED_LANGUAGES) {
    return options.urlLang.toLowerCase() as SupportedLanguage;
  }

  // 2. Saved user preference in localStorage
  if (options?.savedLang && options.savedLang.toLowerCase() in SUPPORTED_LANGUAGES) {
    return options.savedLang.toLowerCase() as SupportedLanguage;
  }

  // 3. Browser navigator language detection
  const navLangs = options?.navigatorLangs || (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []);
  for (const raw of navLangs) {
    const code = raw.slice(0, 2).toLowerCase();
    if (code in SUPPORTED_LANGUAGES) {
      return code as SupportedLanguage;
    }
  }

  return DEFAULT_LANGUAGE;
}

/**
 * Formats numbers according to local conventions (e.g. 92,4 % in FR/DE vs 92.4% in EN).
 */
export function formatLocalizedNumber(
  value: number,
  lang: SupportedLanguage = DEFAULT_LANGUAGE,
  options?: Intl.NumberFormatOptions
): string {
  try {
    return new Intl.NumberFormat(lang, options).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Formats percentages according to local conventions.
 */
export function formatLocalizedPercent(
  value: number,
  lang: SupportedLanguage = DEFAULT_LANGUAGE
): string {
  return `${formatLocalizedNumber(value, lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}
