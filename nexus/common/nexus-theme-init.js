(function (global) {
  "use strict";

  var STORAGE_KEY = "oneapp.nexus.v1.colorMode";
  var LEGACY_STORAGE_KEY = "oneapp.nexus.theme";
  var VALID_MODES = ["light", "dark"];

  function parseStoredValue(raw) {
    if (raw == null) return "";
    try {
      var parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : "";
    } catch (error) {
      return String(raw);
    }
  }

  function normalize(mode) {
    return mode === "dark" ? "dark" : "light";
  }

  function persist(mode) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(mode));
    } catch (error) {
      // The selected visual state can still be applied for the current page.
    }
  }

  function readMode() {
    try {
      var saved = parseStoredValue(global.localStorage.getItem(STORAGE_KEY));
      var legacy = parseStoredValue(global.localStorage.getItem(LEGACY_STORAGE_KEY));
      var requested = saved || legacy;
      var next = normalize(requested);
      if (saved !== next) persist(next);
      return next;
    } catch (error) {
      return "light";
    }
  }

  function apply(mode, options) {
    var settings = options && typeof options === "object" ? options : {};
    var next = VALID_MODES.indexOf(mode) >= 0 ? mode : normalize(mode);
    var root = global.document.documentElement;
    root.dataset.nexusTheme = next;
    // Compatibility alias for existing NEXUS header styles. Applications must
    // consume data-nexus-theme as the authoritative visual state.
    root.dataset.nexusColorMode = next;
    root.style.colorScheme = next;
    if (settings.emit === true && typeof global.dispatchEvent === "function" && typeof global.CustomEvent === "function") {
      var detail = { theme: next, colorMode: next };
      if (settings.source) detail.source = String(settings.source);
      global.dispatchEvent(new global.CustomEvent("nexus-theme-change", { detail: detail }));
    }
    return next;
  }

  global.ONEAPP_NEXUS_THEME_INIT = Object.freeze({
    storageKey: STORAGE_KEY,
    legacyStorageKey: LEGACY_STORAGE_KEY,
    validModes: Object.freeze(VALID_MODES.slice()),
    normalize: normalize,
    readMode: readMode,
    apply: apply
  });
  apply(readMode());
})(window);
