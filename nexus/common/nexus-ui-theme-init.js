(() => {
  'use strict';

  const VERSION = '1.0.0';
  const STORAGE_KEY = 'oneapp.nexus.ui.theme.v1';
  const LEGACY_KEYS = Object.freeze([
    'oneapp.nexus.v1.colorMode',
    'oneapp.nexus.theme',
  ]);
  const root = document.documentElement;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

  const parseStored = (raw) => {
    if (raw == null) return '';
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return String(raw);
    }
  };

  const normalize = (value) => value === 'dark' ? 'dark' : 'light';

  const persist = (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
      return true;
    } catch {
      return false;
    }
  };

  const read = () => {
    try {
      const current = parseStored(localStorage.getItem(STORAGE_KEY));
      if (current === 'light' || current === 'dark') return current;
      for (const key of LEGACY_KEYS) {
        const legacy = parseStored(localStorage.getItem(key));
        if (legacy === 'light' || legacy === 'dark') {
          persist(legacy);
          return legacy;
        }
      }
    } catch {
      return 'light';
    }
    persist('light');
    return 'light';
  };

  const apply = (value, options = {}) => {
    const theme = normalize(value);
    root.dataset.nexusUiTheme = theme;
    root.dataset.nexusTheme = theme;
    root.style.colorScheme = theme;
    if (options.persist !== false) persist(theme);
    if (options.emit === true) {
      window.dispatchEvent(new CustomEvent('nexus-ui:theme-change', {
        detail: Object.freeze({ theme, source: String(options.source || 'theme-controller') }),
      }));
    }
    return theme;
  };

  const script = document.currentScript;
  const appId = String(script?.dataset?.nexusAppId || root.dataset.nexusUiApp || '').trim();
  if (appId) {
    root.dataset.nexusUiApp = appId;
    root.dataset.nexusApp = appId;
  }

  root.dataset.nexusUiInitStartedAt = String(startedAt);
  const initialTheme = apply(read(), { persist: false });

  window.ONEAPP_NEXUS_UI_THEME = Object.freeze({
    VERSION,
    STORAGE_KEY,
    normalize,
    read,
    apply,
    get theme() {
      return root.dataset.nexusUiTheme === 'dark' ? 'dark' : 'light';
    },
    initialTheme,
  });
})();
