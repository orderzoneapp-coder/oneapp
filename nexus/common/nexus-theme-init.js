(function (global) {
  "use strict";

  var STORAGE_KEY = "oneapp.nexus.v1.colorMode";
  var LEGACY_STORAGE_KEY = "oneapp.nexus.theme";
  var VALID_MODES = ["system", "light", "dark"];

  function readMode() {
    try {
      var saved = global.localStorage.getItem(STORAGE_KEY);
      if (VALID_MODES.indexOf(saved) >= 0) return saved;
      var legacy = global.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (VALID_MODES.indexOf(legacy) >= 0) return legacy;
    } catch (error) {
      return "system";
    }
    return "system";
  }

  function apply(mode) {
    var next = VALID_MODES.indexOf(mode) >= 0 ? mode : "system";
    var root = global.document.documentElement;
    root.dataset.nexusColorMode = next;
    root.dataset.nexusTheme = next;
    root.style.colorScheme = next === "system" ? "light dark" : next;
    return next;
  }

  global.ONEAPP_NEXUS_THEME_INIT = Object.freeze({
    readMode: readMode,
    apply: apply
  });
  apply(readMode());
})(window);
