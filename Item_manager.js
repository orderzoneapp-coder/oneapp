(function () {
  "use strict";

  var STORAGE_KEYS = {
    MASTER_DB: "merchMaster_v870",
    MASTER_STORE: "master_products",
    CLOUD_URL: "oneapp_cloud_sync_url_v1",
    LEGACY_CLOUD_URL: "merchCloudUrl_v870",
    OLD_CLOUD_URL: "skuSyncCloudUrl_v6",
    SYNC_TRIGGER: "merchMaster_sync_trigger",
    FILTERS: "oneapp_master_item_manager_filters_v2"
  };

  var DEFAULT_CLOUD_URL = "NEXUS_GATEWAY";

  var FIELD_DEFS = [
    { key: "코드", label: "상품코드", type: "text", width: 132, required: true, css: "grid-code" },
    { key: "품목명", label: "상품명", type: "text", width: 228, required: true, css: "grid-name", name: true },
    { key: "규격", label: "규격", type: "text", width: 150, required: true },
    { key: "단위", label: "단위", type: "unit", width: 92, required: true },
    { key: "1그룹명", label: "카테고리", type: "category", width: 138 },
    { key: "3그룹명", label: "그룹", type: "group", width: 142 },
    { key: "안전재고", label: "안전재고", type: "number", width: 98, numeric: true },
    { key: "입고가", label: "기준단가", type: "number", width: 108, numeric: true },
    { key: "외주비", label: "외주비", type: "number", width: 98, numeric: true },
    { key: "경비", label: "경비", type: "number", width: 98, numeric: true },
    { key: "비과세", label: "부가세 여부", type: "tax", width: 104 },
    { key: "판매여부", label: "사용 상태", type: "status", width: 105 }
  ];

  var BATCH_FIELDS = ["1그룹명", "3그룹명", "안전재고", "외주비", "경비", "비과세", "판매여부"];
  var FIELD_MAP = Object.create(null);
  FIELD_DEFS.forEach(function (def) { FIELD_MAP[def.key] = def; });

  async function loadFoundationFieldDefinitions() {
    if (!window.NEXUS_FOUNDATION) return;
    var metadata = await window.NEXUS_FOUNDATION.load("PRODUCT", { includeDisabled: true });
    if (metadata.readOnly) throw new Error("FOUNDATION_METADATA_READ_ONLY");
    var legacy = Object.create(null);
    FIELD_DEFS.forEach(function (def) { legacy[def.key] = def; });
    var fields = (metadata.fields || []).filter(function (field) {
      return field.entityType === "PRODUCT" && field.systemField !== false;
    }).sort(function (a, b) {
      return Number(a.sortOrder) - Number(b.sortOrder) || compareText(a.fieldId, b.fieldId);
    });
    if (!fields.length) return;
    FIELD_DEFS = fields.map(function (field) {
      var previous = legacy[field.storageKey] || {};
      var type = previous.type || (field.dataType === "NUMBER" || field.dataType === "INTEGER" ? "number" : "text");
      if (field.fieldId === "product.tax_type") type = "tax";
      if (field.fieldId === "product.status") type = "status";
      return {
        key: field.storageKey,
        fieldId: field.fieldId,
        label: field.displayName || field.storageKey,
        type: type,
        dataType: field.dataType,
        width: previous.width || (field.dataType === "TEXT" ? 150 : 108),
        required: Boolean(field.requirements && field.requirements.createRequired),
        numeric: field.dataType === "NUMBER" || field.dataType === "INTEGER",
        css: previous.css || "",
        name: field.fieldId === "product.name"
      };
    });
    FIELD_MAP = Object.create(null);
    FIELD_DEFS.forEach(function (def) { FIELD_MAP[def.key] = def; });
  }

  var state = {
    revision: undefined,
    masterOriginal: {},
    working: {},
    loadedIds: [],
    loaded: false,
    selected: new Set(),
    newIds: new Set(),
    dirtyCells: new Set(),
    errors: new Map(),
    active: null,
    range: null,
    edit: null,
    dragging: false,
    undoStack: [],
    redoStack: [],
    processing: false,
    filters: loadSavedFilters(),
    sync: {
      state: "pending",
      message: "상품 DB를 확인하고 있습니다."
    },
    pendingAfterSave: null
  };

  var els = {};
  var toastTimer = null;
  var dialogActions = [];
  var eventsBound = false;

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "app", "excel-menu-button", "excel-menu", "sync-menu-button", "sync-menu",
      "sync-dot", "sync-message", "cloud-pull-button", "cloud-push-button",
      "header-save-button", "category-filter", "group-filter", "status-filter",
      "search-filter", "load-button", "summary-counts", "delete-selected-button", "add-product-button",
      "grid-empty", "grid-region", "table-scroll", "product-grid",
      "batch-toolbar", "batch-selection-count", "batch-field", "batch-value-wrap",
      "batch-mode", "batch-apply-button", "save-bar", "save-state-copy",
      "discard-button", "footer-save-button", "dialog-backdrop", "dialog-title",
      "dialog-copy", "dialog-actions", "toast"
    ].forEach(function (id) {
      els[id] = $(id);
    });
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value == null ? {} : value));
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function trimmed(value) {
    return text(value).trim();
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  function compareText(a, b) {
    return text(a).localeCompare(text(b), "ko", { numeric: true, sensitivity: "base" });
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.map(trimmed).filter(Boolean))).sort(compareText);
  }

  function loadSavedFilters() {
    var defaults = { category: "", group: "", status: "all", search: "", loaded: false };
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.FILTERS) || "null");
      if (!parsed || typeof parsed !== "object") return defaults;
      return {
        category: text(parsed.category),
        group: text(parsed.group),
        status: ["all", "active", "stopped"].indexOf(parsed.status) >= 0 ? parsed.status : "all",
        search: text(parsed.search),
        loaded: Boolean(parsed.loaded)
      };
    } catch (error) {
      return defaults;
    }
  }

  function saveFilters() {
    try {
      localStorage.setItem(STORAGE_KEYS.FILTERS, JSON.stringify(state.filters));
    } catch (error) {
      return;
    }
  }

  function normalizeCloudUrl(value) {
    var raw = trimmed(value);
    if (!raw) return "";
    return raw
      .replace(/\?action=[^&#]*/g, "")
      .replace(/&action=[^&#]*/g, "")
      .replace(/\?sheet=[^&#]*/g, "")
      .replace(/&sheet=[^&#]*/g, "");
  }

  function getCloudUrl() {
    return DEFAULT_CLOUD_URL;
  }

  function setCloudUrl(value) {
    return DEFAULT_CLOUD_URL;
  }

  function buildCloudUrl(url, params) {
    var query = Object.keys(params || {}).filter(function (key) {
      return params[key] !== undefined && params[key] !== null && params[key] !== "";
    }).map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
    }).join("&");
    if (!query) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + query;
  }

  function initIDB() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open("MerchOpsDB", 2);
      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains("store")) db.createObjectStore("store");
        if (!db.objectStoreNames.contains(STORAGE_KEYS.MASTER_STORE)) {
          db.createObjectStore(STORAGE_KEYS.MASTER_STORE, { keyPath: "코드" });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function getLegacyMaster() {
    return initIDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("store", "readonly");
        var request = tx.objectStore("store").get(STORAGE_KEYS.MASTER_DB);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || tx.error); };
      });
    });
  }

  function normalizeMasterMap(input) {
    var result = {};
    var entries = Array.isArray(input)
      ? input.map(function (item, index) { return [String(index + 1), item, ""]; })
      : Object.keys(input || {}).map(function (key, index) { return [String(index + 1), input[key], key]; });

    entries.forEach(function (entry) {
      var item = entry[1] || {};
      var code = trimmed(item["코드"] || item["품목코드"] || entry[2]);
      if (!code) throw new Error("상품 DB " + entry[0] + "행에 상품코드가 없습니다.");
      if (result[code]) throw new Error("상품코드가 중복되어 있습니다: " + code);
      result[code] = Object.assign({}, item, {
        "코드": code,
        "품목코드": trimmed(item["품목코드"] || code)
      });
    });
    return result;
  }

  async function readLocalMaster() {
    if (!window.ONEAPP || !window.ONEAPP.STORAGE || !window.ONEAPP.STORAGE.readMasterSnapshotState) {
      throw new Error("공통 상품 저장 모듈을 불러오지 못했습니다.");
    }
    var snapshot = await window.ONEAPP.STORAGE.readMasterSnapshotState();
    state.revision = snapshot.revision;
    if (Array.isArray(snapshot.items) && snapshot.items.length) {
      return normalizeMasterMap(snapshot.items);
    }
    if (snapshot.masterMap && Object.keys(snapshot.masterMap).length) {
      return normalizeMasterMap(snapshot.masterMap);
    }
    var legacy = await getLegacyMaster().catch(function () { return null; });
    if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
      var normalized = normalizeMasterMap(legacy);
      var committed = await commitMaster(normalized);
      state.revision = committed.revision;
      return normalized;
    }
    return {};
  }

  function commitMaster(masterMap) {
    if (!window.ONEAPP || !window.ONEAPP.STORAGE || !window.ONEAPP.STORAGE.commitMasterStateOrThrow) {
      return Promise.reject(new Error("공통 상품 저장 모듈을 불러오지 못했습니다."));
    }
    return window.ONEAPP.STORAGE.commitMasterStateOrThrow(masterMap, {
      expectedRevision: state.revision
    });
  }

  function isStopped(value) {
    var normalized = trimmed(value).toLowerCase().replace(/\s+/g, "");
    return ["0", "false", "n", "no", "중지", "사용중지", "판매중지", "미사용", "품절"].indexOf(normalized) >= 0;
  }

  function isTaxFree(value) {
    var normalized = trimmed(value).toLowerCase().replace(/\s+/g, "");
    return ["1", "true", "y", "yes", "면세", "비과세"].indexOf(normalized) >= 0;
  }

  function getOriginalValues(field) {
    return Object.keys(state.masterOriginal).map(function (id) {
      return state.masterOriginal[id] && state.masterOriginal[id][field];
    });
  }

  function categoryRecords() {
    var map = new Map();
    Object.keys(state.masterOriginal).forEach(function (id) {
      var row = state.masterOriginal[id] || {};
      var label = trimmed(row["1그룹명"]);
      if (!label || map.has(label)) return;
      map.set(label, trimmed(row["1코드"]));
    });
    return Array.from(map.entries()).map(function (entry) {
      return { value: entry[0], label: entry[0], linked: entry[1] };
    }).sort(function (a, b) { return compareText(a.label, b.label); });
  }

  function groupRecords() {
    var map = new Map();
    Object.keys(state.masterOriginal).forEach(function (id) {
      var row = state.masterOriginal[id] || {};
      var label = trimmed(row["3그룹명"]);
      if (!label || map.has(label)) return;
      map.set(label, trimmed(row["3코드"] || row["오더즈"]));
    });
    return Array.from(map.entries()).map(function (entry) {
      return { value: entry[0], label: entry[0], linked: entry[1] };
    }).sort(function (a, b) { return compareText(a.label, b.label); });
  }

  function optionsFor(def, rowId) {
    var row = state.working[rowId] || {};
    var original = state.masterOriginal[rowId] || {};
    var options;
    if (def.type === "unit") {
      options = uniqueSorted(getOriginalValues("단위").concat(["EA", "BOX", "KG", "G", "L", "ML", "PACK", "SET"])).map(function (value) {
        return { value: value, label: value };
      });
    } else if (def.type === "category") {
      options = categoryRecords();
    } else if (def.type === "group") {
      options = groupRecords();
    } else if (def.type === "tax") {
      options = [
        { value: "0", label: "과세" },
        { value: "1", label: "면세" }
      ];
    } else if (def.type === "status") {
      options = [
        { value: "1", label: "사용" },
        { value: "0", label: "사용 중지" }
      ];
    } else {
      options = [];
    }

    var current = trimmed(row[def.key]);
    var originalValue = trimmed(original[def.key]);
    var allowedCurrent = originalValue || current;
    if (allowedCurrent && ["unit", "category", "group"].indexOf(def.type) >= 0 &&
        !options.some(function (item) { return item.value === allowedCurrent; })) {
      options.push({ value: allowedCurrent, label: allowedCurrent });
    }
    return options;
  }

  function displayValue(def, value) {
    if (def.type === "tax") return isTaxFree(value) ? "면세" : "과세";
    if (def.type === "status") return isStopped(value) ? "사용 중지" : "사용";
    if (def.numeric) {
      var raw = trimmed(value);
      if (!raw) return "";
      var number = Number(raw.replace(/,/g, ""));
      return Number.isFinite(number) ? number.toLocaleString("ko-KR") : raw;
    }
    return text(value);
  }

  function normalizeInput(def, raw, rowId) {
    var value = raw;
    if (def.dataType === "TIME") {
      if (!trimmed(raw)) return { ok: true, value: "" };
      var time = trimmed(raw).match(/^(\d{1,2}):(\d{2})$/);
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) {
        return { ok: false, value: text(raw), error: "마감시간은 HH:mm 형식으로 입력하세요." };
      }
      return { ok: true, value: String(Number(time[1])).padStart(2, "0") + ":" + time[2] };
    }
    if (def.type === "text") {
      value = def.key === "코드" ? trimmed(raw) : text(raw).trim();
      return { ok: true, value: value };
    }
    if (def.type === "number") {
      var clean = trimmed(raw).replace(/,/g, "");
      if (!clean) return { ok: true, value: "" };
      var number = Number(clean);
      if (!Number.isFinite(number) || number < 0) {
        return { ok: false, value: text(raw), error: "0 이상의 숫자로 입력하세요." };
      }
      if (def.dataType === "INTEGER" && !Number.isInteger(number)) {
        return { ok: false, value: text(raw), error: "0 이상의 정수로 입력하세요." };
      }
      return { ok: true, value: number };
    }
    if (def.type === "tax") {
      var tax = trimmed(raw).toLowerCase().replace(/\s+/g, "");
      if (["0", "과세", "tax", "taxable"].indexOf(tax) >= 0) return { ok: true, value: 0 };
      if (["1", "면세", "비과세", "taxfree", "tax-free"].indexOf(tax) >= 0) return { ok: true, value: 1 };
      return { ok: false, value: text(raw), error: "과세 또는 면세를 선택하세요." };
    }
    if (def.type === "status") {
      var status = trimmed(raw).toLowerCase().replace(/\s+/g, "");
      if (["1", "사용", "판매", "정상", "active", "true"].indexOf(status) >= 0) return { ok: true, value: 1 };
      if (["0", "중지", "사용중지", "판매중지", "미사용", "stopped", "false"].indexOf(status) >= 0) return { ok: true, value: 0 };
      return { ok: false, value: text(raw), error: "사용 또는 사용 중지를 선택하세요." };
    }

    value = trimmed(raw);
    if (!value) return { ok: true, value: "" };
    var options = optionsFor(def, rowId);
    var match = options.find(function (item) {
      return trimmed(item.value).toLowerCase() === value.toLowerCase() ||
        trimmed(item.label).toLowerCase() === value.toLowerCase();
    });
    if (!match) {
      var noun = def.type === "unit" ? "단위" : def.type === "category" ? "카테고리" : "그룹";
      return { ok: false, value: text(raw), error: "등록된 " + noun + "에서 선택하세요." };
    }
    return { ok: true, value: match.value, linked: match.linked };
  }

  function cellKey(rowId, field) {
    return rowId + "\u0001" + field;
  }

  function splitCellKey(key) {
    var index = key.indexOf("\u0001");
    return [key.slice(0, index), key.slice(index + 1)];
  }

  function valuesEqual(a, b) {
    if ((a === "" || a == null) && (b === "" || b == null)) return true;
    return text(a) === text(b);
  }

  function refreshDirtyCells() {
    state.dirtyCells.clear();
    Object.keys(state.working).forEach(function (rowId) {
      var row = state.working[rowId] || {};
      var original = state.masterOriginal[rowId] || {};
      FIELD_DEFS.forEach(function (def) {
        if (state.newIds.has(rowId)) {
          if (trimmed(row[def.key]) !== "") state.dirtyCells.add(cellKey(rowId, def.key));
        } else if (!valuesEqual(row[def.key], original[def.key])) {
          state.dirtyCells.add(cellKey(rowId, def.key));
        }
      });
    });
  }

  function dirtyRowIds() {
    var ids = new Set(state.newIds);
    state.dirtyCells.forEach(function (key) {
      ids.add(splitCellKey(key)[0]);
    });
    return Array.from(ids);
  }

  function validateDirtyRows() {
    state.errors.clear();
    var dirtyIds = dirtyRowIds();
    var codeOwners = new Map();

    Object.keys(state.masterOriginal).forEach(function (id) {
      codeOwners.set(trimmed(state.masterOriginal[id]["코드"] || id), id);
    });

    state.newIds.forEach(function (id) {
      var code = trimmed(state.working[id] && state.working[id]["코드"]);
      if (!code) return;
      if (codeOwners.has(code) && codeOwners.get(code) !== id) {
        state.errors.set(cellKey(id, "코드"), "이미 등록된 상품코드입니다.");
      } else {
        codeOwners.set(code, id);
      }
    });

    dirtyIds.forEach(function (rowId) {
      var row = state.working[rowId] || {};
      FIELD_DEFS.forEach(function (def) {
        var normalized = normalizeInput(def, row[def.key], rowId);
        if (!normalized.ok) {
          state.errors.set(cellKey(rowId, def.key), normalized.error);
        }
        if (def.required && !trimmed(row[def.key])) {
          state.errors.set(cellKey(rowId, def.key), def.label + "은(는) 필수정보입니다.");
        }
      });
    });
  }

  function rowHasError(rowId) {
    var prefix = rowId + "\u0001";
    return Array.from(state.errors.keys()).some(function (key) {
      return key.indexOf(prefix) === 0;
    });
  }

  function rowErrorCount(rowId) {
    var prefix = rowId + "\u0001";
    return Array.from(state.errors.keys()).filter(function (key) {
      return key.indexOf(prefix) === 0;
    }).length;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    toastTimer = window.setTimeout(function () {
      els.toast.hidden = true;
    }, 3200);
  }

  function openDialog(title, copy, actions) {
    els["dialog-title"].textContent = title;
    els["dialog-copy"].textContent = copy;
    els["dialog-actions"].innerHTML = "";
    dialogActions = actions || [];
    dialogActions.forEach(function (action, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "oneapp-button" + (action.primary ? " oneapp-button-primary" : "") +
        (action.danger ? " oneapp-button-danger" : "");
      button.textContent = action.label;
      button.dataset.dialogAction = String(index);
      els["dialog-actions"].appendChild(button);
    });
    els["dialog-backdrop"].hidden = false;
    var firstPrimary = els["dialog-actions"].querySelector(".oneapp-button-primary") ||
      els["dialog-actions"].querySelector("button");
    if (firstPrimary) firstPrimary.focus();
  }

  function closeDialog() {
    els["dialog-backdrop"].hidden = true;
    dialogActions = [];
  }

  function toggleMenu(button, menu) {
    var willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function closeMenus() {
    [
      [els["excel-menu-button"], els["excel-menu"]],
      [els["sync-menu-button"], els["sync-menu"]]
    ].forEach(function (pair) {
      pair[1].hidden = true;
      pair[0].setAttribute("aria-expanded", "false");
    });
  }

  function setSync(status, message) {
    state.sync.state = status;
    state.sync.message = message;
    var level = status === "synced" ? "normal" : status === "error" ? "error" : status === "working" ? "progress" : "warning";
    window.NEXUS_TOP?.reportStatus({
      appId: "item-manager",
      taskId: "item-manager-sync",
      level: level,
      active: status !== "synced",
      message: message
    });
    renderSync();
  }

  function renderSync() {
    els["sync-message"].textContent = state.sync.message;
    els["sync-dot"].dataset.state =
      state.sync.state === "synced" ? "synced" :
      state.sync.state === "error" ? "error" :
      state.sync.state === "working" ? "working" : "pending";
    els["cloud-pull-button"].disabled = state.processing;
    els["cloud-push-button"].disabled = state.processing;
  }

  function populateQueryOptions() {
    var categoryValue = state.filters.category;
    var groupValue = state.filters.group;
    var categories = categoryRecords();
    var groups = groupRecords();

    els["category-filter"].innerHTML =
      '<option value="">카테고리 선택</option><option value="__all__">전체 카테고리</option>' +
      categories.map(function (item) {
        return '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + "</option>";
      }).join("");

    els["group-filter"].innerHTML =
      '<option value="">그룹 선택</option><option value="__all__">전체 그룹</option>' +
      groups.map(function (item) {
        return '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + "</option>";
      }).join("");

    if (Array.from(els["category-filter"].options).some(function (option) { return option.value === categoryValue; })) {
      els["category-filter"].value = categoryValue;
    } else {
      state.filters.category = "";
    }
    if (Array.from(els["group-filter"].options).some(function (option) { return option.value === groupValue; })) {
      els["group-filter"].value = groupValue;
    } else {
      state.filters.group = "";
    }
    els["status-filter"].value = state.filters.status;
    els["search-filter"].value = state.filters.search;
    els["load-button"].disabled = !state.filters.category && !state.filters.group;
  }

  function matchesLoadFilters(row) {
    var category = state.filters.category;
    var group = state.filters.group;
    var status = state.filters.status;
    if (category && category !== "__all__" && trimmed(row["1그룹명"]) !== category) return false;
    if (group && group !== "__all__" && trimmed(row["3그룹명"]) !== group) return false;
    if (status === "active" && isStopped(row["판매여부"])) return false;
    if (status === "stopped" && !isStopped(row["판매여부"])) return false;
    return true;
  }

  function searchMatches(row) {
    var keyword = trimmed(state.filters.search).toLowerCase().replace(/\s+/g, "");
    if (!keyword) return true;
    var target = [
      row["코드"], row["품목코드"], row["품목명"], row["규격"]
    ].map(text).join("").toLowerCase().replace(/\s+/g, "");
    return target.indexOf(keyword) >= 0;
  }

  function visibleRowIds() {
    var newRows = Array.from(state.newIds).reverse().filter(function (id) {
      return state.working[id] && searchMatches(state.working[id]);
    });
    if (!state.loaded) return newRows;
    var existing = state.loadedIds.filter(function (id) {
      return state.working[id] && searchMatches(state.working[id]);
    });
    return newRows.concat(existing);
  }

  function loadProductsNow() {
    if (!state.filters.category && !state.filters.group) {
      showToast("카테고리 또는 그룹을 선택해 주세요.");
      return;
    }
    state.loaded = true;
    state.filters.loaded = true;
    state.loadedIds = Object.keys(state.masterOriginal).filter(function (id) {
      return matchesLoadFilters(state.working[id] || {});
    }).sort(function (a, b) {
      var rowA = state.working[a] || {};
      var rowB = state.working[b] || {};
      return compareText(rowA["품목명"] || a, rowB["품목명"] || b);
    });
    state.selected.clear();
    state.active = null;
    state.range = null;
    state.edit = null;
    saveFilters();
    renderAll();
  }

  function requestLoadProducts() {
    if (dirtyRowIds().length) {
      guardUnsaved(loadProductsNow);
      return;
    }
    loadProductsNow();
  }

  function renderSummary() {
    var visible = visibleRowIds();
    var dirtyCells = state.dirtyCells.size;
    var errors = state.errors.size;
    var summary = "전체 <strong>" + visible.length.toLocaleString("ko-KR") + "</strong>건 · 선택 <strong>" +
      state.selected.size.toLocaleString("ko-KR") + "</strong>건 · 수정 <strong>" +
      dirtyCells.toLocaleString("ko-KR") + "</strong>건";
    if (errors) summary += " · 오류 <strong class=\"summary-error\">" + errors.toLocaleString("ko-KR") + "</strong>건";
    els["summary-counts"].innerHTML = summary;
  }

  function selectedExistingIds() {
    return Array.from(state.selected).filter(function (id) {
      return Boolean(state.masterOriginal[id]);
    });
  }

  function renderDeleteState() {
    var count = selectedExistingIds().length;
    var hasUnsavedChanges = dirtyRowIds().length > 0;
    var disabled = state.processing || count === 0 || hasUnsavedChanges;
    els["delete-selected-button"].disabled = disabled;
    els["delete-selected-button"].textContent = count ? "선택 삭제 (" + count + ")" : "선택 삭제";
    els["delete-selected-button"].title = state.processing
      ? "현재 작업이 끝난 뒤 삭제할 수 있습니다."
      : hasUnsavedChanges
        ? "저장하지 않은 변경사항을 저장하거나 취소한 뒤 삭제할 수 있습니다."
        : count
          ? "선택한 상품을 Master에서 삭제합니다."
          : "삭제할 상품을 선택하세요.";
  }

  function isEditable(rowId, field) {
    if (field === "코드" && !state.newIds.has(rowId)) return false;
    return Boolean(FIELD_MAP[field]);
  }

  function rangeBounds() {
    if (!state.range || !state.range.start || !state.range.end) return null;
    var rows = visibleRowIds();
    var startRow = rows.indexOf(state.range.start.rowId);
    var endRow = rows.indexOf(state.range.end.rowId);
    var startCol = FIELD_DEFS.findIndex(function (def) { return def.key === state.range.start.field; });
    var endCol = FIELD_DEFS.findIndex(function (def) { return def.key === state.range.end.field; });
    if (startRow < 0 || endRow < 0 || startCol < 0 || endCol < 0) return null;
    return {
      rowMin: Math.min(startRow, endRow),
      rowMax: Math.max(startRow, endRow),
      colMin: Math.min(startCol, endCol),
      colMax: Math.max(startCol, endCol),
      rows: rows
    };
  }

  function inRange(rowId, field) {
    var bounds = rangeBounds();
    if (!bounds) return false;
    var rowIndex = bounds.rows.indexOf(rowId);
    var colIndex = FIELD_DEFS.findIndex(function (def) { return def.key === field; });
    return rowIndex >= bounds.rowMin && rowIndex <= bounds.rowMax &&
      colIndex >= bounds.colMin && colIndex <= bounds.colMax;
  }

  function renderChoiceOptions(def, rowId, value) {
    var current = def.type === "tax" ? (isTaxFree(value) ? "1" : "0") :
      def.type === "status" ? (isStopped(value) ? "0" : "1") : trimmed(value);
    var options = optionsFor(def, rowId);
    var html = '<option value=""></option>';
    options.forEach(function (option) {
      html += '<option value="' + escapeHtml(option.value) + '"' +
        (text(option.value) === current ? " selected" : "") + ">" +
        escapeHtml(option.label) + "</option>";
    });
    return html;
  }

  function renderCell(rowId, def) {
    var row = state.working[rowId] || {};
    var value = row[def.key];
    var key = cellKey(rowId, def.key);
    var classes = ["grid-cell"];
    if (def.name) classes.push("cell-name");
    if (def.numeric) classes.push("cell-number");
    if (!isEditable(rowId, def.key)) classes.push("cell-readonly");
    if (state.dirtyCells.has(key)) classes.push("cell-modified");
    if (state.errors.has(key)) classes.push("cell-error");
    if (state.active && state.active.rowId === rowId && state.active.field === def.key) classes.push("cell-active");
    if (inRange(rowId, def.key)) classes.push("cell-range");

    var inner;
    if (state.edit && state.edit.rowId === rowId && state.edit.field === def.key) {
      var editValue = state.edit.seed !== null && state.edit.seed !== undefined
        ? state.edit.seed
        : text(value);
      if (["unit", "category", "group", "tax", "status"].indexOf(def.type) >= 0) {
        inner = '<select class="cell-select" data-editor="1" data-row-id="' + escapeHtml(rowId) +
          '" data-field="' + escapeHtml(def.key) + '">' + renderChoiceOptions(def, rowId, value) + "</select>";
      } else {
        inner = '<input class="cell-input' + (def.numeric ? " cell-number" : "") +
          '" data-editor="1" data-row-id="' + escapeHtml(rowId) + '" data-field="' +
          escapeHtml(def.key) + '" value="' + escapeHtml(editValue) + '" autocomplete="off">';
      }
    } else {
      var shown = displayValue(def, value);
      inner = '<span class="cell-text">' + escapeHtml(shown || (def.key === "코드" && state.newIds.has(rowId) ? "입력 필요" : "—")) + "</span>";
      if (def.key === "코드" && state.newIds.has(rowId)) {
        inner += '<span class="oneapp-badge oneapp-badge-indigo new-row-badge">신규</span>';
      }
    }

    return '<div class="' + classes.join(" ") + '" tabindex="0" role="gridcell" data-row-id="' +
      escapeHtml(rowId) + '" data-field="' + escapeHtml(def.key) + '" data-error="' +
      escapeHtml(state.errors.get(key) || "") + '" aria-label="' + escapeHtml(def.label + " " + displayValue(def, value)) +
      '">' + inner + "</div>";
  }

  function renderTable() {
    var rows = visibleRowIds();
    var hasRows = rows.length > 0;

    if (!hasRows) {
      els["grid-region"].hidden = true;
      els["grid-empty"].hidden = false;
      els["grid-empty"].innerHTML = state.loaded
        ? "<strong>조건에 맞는 상품이 없습니다.</strong><span>조회 조건을 변경하거나 새 상품을 추가하세요.</span>"
        : "<strong>카테고리 또는 그룹을 선택해 상품을 불러오세요.</strong><span>조회 조건은 다음 방문에도 그대로 유지됩니다.</span>";
      return;
    }

    els["grid-empty"].hidden = true;
    els["grid-region"].hidden = false;
    var allSelected = rows.length > 0 && rows.every(function (id) { return state.selected.has(id); });
    var head = '<tr><th class="grid-select"><input id="select-all-rows" type="checkbox" aria-label="현재 상품 전체 선택"' +
      (allSelected ? " checked" : "") + "></th>";
    FIELD_DEFS.forEach(function (def) {
      head += '<th class="' + escapeHtml(def.css || "") + '" style="width:' + def.width +
        'px;min-width:' + def.width + 'px">' + escapeHtml(def.label) + "</th>";
    });
    head += "</tr>";
    els["product-grid"].querySelector("thead").innerHTML = head;

    var body = rows.map(function (rowId) {
      var selected = state.selected.has(rowId);
      var rowClass = selected ? "row-selected" : "";
      if (rowHasError(rowId) && dirtyRowIds().indexOf(rowId) >= 0) rowClass += " row-save-failed";
      var html = '<tr class="' + rowClass.trim() + '" data-row-id="' + escapeHtml(rowId) + '">';
      html += '<td class="grid-select"><input class="row-checkbox" type="checkbox" aria-label="' +
        escapeHtml(displayValue(FIELD_MAP["품목명"], state.working[rowId]["품목명"]) || rowId) +
        ' 선택" data-row-id="' + escapeHtml(rowId) + '"' + (selected ? " checked" : "") + "></td>";
      FIELD_DEFS.forEach(function (def) {
        html += '<td class="' + escapeHtml(def.css || "") + '" style="width:' + def.width +
          'px;min-width:' + def.width + 'px">' + renderCell(rowId, def) + "</td>";
      });
      return html + "</tr>";
    }).join("");
    els["product-grid"].querySelector("tbody").innerHTML = body;
    focusCurrentEditor();
  }

  function renderBatchValue() {
    var def = FIELD_MAP[els["batch-field"].value] || FIELD_MAP[BATCH_FIELDS[0]];
    var rowId = Array.from(state.selected)[0] || Object.keys(state.masterOriginal)[0] || "";
    if (["category", "group", "tax", "status"].indexOf(def.type) >= 0) {
      els["batch-value-wrap"].innerHTML = '<select id="batch-value" class="oneapp-field" aria-label="일괄 적용 값">' +
        renderChoiceOptions(def, rowId, "") + "</select>";
    } else {
      els["batch-value-wrap"].innerHTML = '<input id="batch-value" class="oneapp-field" aria-label="일괄 적용 값" ' +
        (def.numeric ? 'inputmode="decimal"' : "") + ' placeholder="적용할 값">';
    }
  }

  function renderBatchToolbar() {
    var count = state.selected.size;
    els["batch-toolbar"].hidden = count < 2;
    els["batch-selection-count"].textContent = count + "개 상품 선택";
    if (!els["batch-field"].options.length) {
      els["batch-field"].innerHTML = BATCH_FIELDS.map(function (field) {
        return '<option value="' + escapeHtml(field) + '">' + escapeHtml(FIELD_MAP[field].label) + "</option>";
      }).join("");
      renderBatchValue();
    }
  }

  function renderSaveState() {
    var rows = dirtyRowIds();
    var errorCount = state.errors.size;
    var copy = rows.length
      ? rows.length + "개 상품 · " + state.dirtyCells.size + "개 항목 변경" +
        (errorCount ? " · 확인 필요 " + errorCount + "건" : "")
      : "변경된 내용이 없습니다.";
    els["save-state-copy"].textContent = copy;
    var enabled = rows.length > 0 && !state.processing;
    els["header-save-button"].disabled = !enabled;
    els["footer-save-button"].disabled = !enabled;
    els["discard-button"].disabled = !enabled;
    var saveReason = enabled ? "변경사항을 저장합니다." : "변경사항이 있을 때 저장할 수 있습니다.";
    els["header-save-button"].title = saveReason;
    els["footer-save-button"].title = saveReason;
    window.NEXUS_TOP?.reportStatus({
      appId: "item-manager",
      taskId: "item-manager-unsaved",
      level: rows.length ? "warning" : "normal",
      active: rows.length > 0,
      message: rows.length ? rows.length + "개 상품에 저장하지 않은 변경사항이 있습니다." : "저장하지 않은 변경사항이 없습니다."
    });
  }

  function renderAll() {
    refreshDirtyCells();
    validateDirtyRows();
    renderSummary();
    renderTable();
    renderBatchToolbar();
    renderDeleteState();
    renderSaveState();
    renderSync();
  }

  function focusCurrentEditor() {
    if (!state.edit) return;
    window.requestAnimationFrame(function () {
      var editors = els["product-grid"].querySelectorAll("[data-editor='1']");
      var target = Array.from(editors).find(function (editor) {
        return editor.dataset.rowId === state.edit.rowId && editor.dataset.field === state.edit.field;
      });
      if (!target) return;
      target.focus();
      if (target.tagName === "INPUT") {
        if (state.edit.seed !== null && state.edit.seed !== undefined) {
          target.value = state.edit.seed;
        }
        target.select();
      }
    });
  }

  function findCell(rowId, field) {
    return Array.from(els["product-grid"].querySelectorAll(".grid-cell")).find(function (cell) {
      return cell.dataset.rowId === rowId && cell.dataset.field === field;
    }) || null;
  }

  function refreshCellSelectionClasses() {
    els["product-grid"].querySelectorAll(".grid-cell").forEach(function (cell) {
      var isActive = Boolean(state.active &&
        state.active.rowId === cell.dataset.rowId &&
        state.active.field === cell.dataset.field);
      cell.classList.toggle("cell-active", isActive);
      cell.classList.toggle("cell-range", inRange(cell.dataset.rowId, cell.dataset.field));
    });
  }

  function activateCell(rowId, field, extend) {
    state.active = { rowId: rowId, field: field };
    if (extend && state.range && state.range.start) {
      state.range.end = { rowId: rowId, field: field };
    } else {
      state.range = {
        start: { rowId: rowId, field: field },
        end: { rowId: rowId, field: field }
      };
    }
    refreshCellSelectionClasses();
    var cell = findCell(rowId, field);
    if (cell) cell.focus({ preventScroll: true });
  }

  function beginEdit(rowId, field, seed) {
    if (!isEditable(rowId, field)) return;
    state.active = { rowId: rowId, field: field };
    state.range = {
      start: { rowId: rowId, field: field },
      end: { rowId: rowId, field: field }
    };
    state.edit = { rowId: rowId, field: field, seed: seed === undefined ? null : seed };
    renderTable();
  }

  function linkedChangeFor(def, normalized, rowId) {
    if (!normalized.ok || !normalized.linked) return null;
    if (def.type === "category") return { rowId: rowId, field: "1코드", value: normalized.linked };
    if (def.type === "group") return { rowId: rowId, field: "3코드", value: normalized.linked };
    return null;
  }

  function applyChanges(changes, recordHistory) {
    var history = [];
    changes.forEach(function (change) {
      var row = state.working[change.rowId];
      var def = FIELD_MAP[change.field];
      if (!row || !def || !isEditable(change.rowId, change.field)) return;
      var normalized = normalizeInput(def, change.value, change.rowId);
      var before = row[change.field];
      var after = normalized.value;
      if (valuesEqual(before, after)) return;
      row[change.field] = after;
      history.push({ rowId: change.rowId, field: change.field, before: before, after: after });
      var linked = linkedChangeFor(def, normalized, change.rowId);
      if (linked && !valuesEqual(row[linked.field], linked.value)) {
        var linkedBefore = row[linked.field];
        row[linked.field] = linked.value;
        history.push({ rowId: change.rowId, field: linked.field, before: linkedBefore, after: linked.value });
      }
    });
    if (recordHistory && history.length) {
      state.undoStack.push({ changes: history });
      if (state.undoStack.length > 100) state.undoStack.shift();
      state.redoStack = [];
    }
    refreshDirtyCells();
    validateDirtyRows();
    return history.length;
  }

  function commitEditor(editor) {
    if (!state.edit || !editor) return null;
    var current = { rowId: state.edit.rowId, field: state.edit.field };
    state.edit = null;
    applyChanges([{ rowId: current.rowId, field: current.field, value: editor.value }], true);
    return current;
  }

  function moveActive(deltaRow, deltaCol, startEdit) {
    if (!state.active) return;
    var rows = visibleRowIds();
    var rowIndex = rows.indexOf(state.active.rowId);
    var colIndex = FIELD_DEFS.findIndex(function (def) { return def.key === state.active.field; });
    if (rowIndex < 0 || colIndex < 0) return;

    var nextRow = rowIndex;
    var nextCol = colIndex;
    var attempts = 0;
    do {
      nextRow += deltaRow;
      nextCol += deltaCol;
      if (nextCol >= FIELD_DEFS.length) {
        nextCol = 0;
        nextRow += 1;
      }
      if (nextCol < 0) {
        nextCol = FIELD_DEFS.length - 1;
        nextRow -= 1;
      }
      if (nextRow < 0 || nextRow >= rows.length) return;
      attempts += 1;
    } while (startEdit && !isEditable(rows[nextRow], FIELD_DEFS[nextCol].key) && attempts < FIELD_DEFS.length + rows.length);

    var next = { rowId: rows[nextRow], field: FIELD_DEFS[nextCol].key };
    state.active = next;
    state.range = { start: next, end: next };
    if (startEdit && isEditable(next.rowId, next.field)) {
      state.edit = { rowId: next.rowId, field: next.field, seed: null };
    }
    renderTable();
    if (!startEdit) {
      var cell = findCell(next.rowId, next.field);
      if (cell) {
        cell.focus({ preventScroll: true });
        cell.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  }

  function undo() {
    var entry = state.undoStack.pop();
    if (!entry) return;
    entry.changes.slice().reverse().forEach(function (change) {
      if (state.working[change.rowId]) state.working[change.rowId][change.field] = change.before;
    });
    state.redoStack.push(entry);
    renderAll();
  }

  function redo() {
    var entry = state.redoStack.pop();
    if (!entry) return;
    entry.changes.forEach(function (change) {
      if (state.working[change.rowId]) state.working[change.rowId][change.field] = change.after;
    });
    state.undoStack.push(entry);
    renderAll();
  }

  function selectedRangeCells() {
    var bounds = rangeBounds();
    if (!bounds) return [];
    var result = [];
    for (var r = bounds.rowMin; r <= bounds.rowMax; r += 1) {
      for (var c = bounds.colMin; c <= bounds.colMax; c += 1) {
        result.push({ rowId: bounds.rows[r], field: FIELD_DEFS[c].key, rowIndex: r, colIndex: c });
      }
    }
    return result;
  }

  function copySelection() {
    if (!state.active) return;
    var bounds = rangeBounds();
    if (!bounds) return;
    var lines = [];
    for (var r = bounds.rowMin; r <= bounds.rowMax; r += 1) {
      var values = [];
      for (var c = bounds.colMin; c <= bounds.colMax; c += 1) {
        var def = FIELD_DEFS[c];
        var row = state.working[bounds.rows[r]] || {};
        values.push(displayValue(def, row[def.key]));
      }
      lines.push(values.join("\t"));
    }
    var output = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(output).then(function () {
        showToast("선택한 값을 복사했습니다.");
      }).catch(function () {
        fallbackCopy(output);
      });
    } else {
      fallbackCopy(output);
    }
  }

  function fallbackCopy(output) {
    var textarea = document.createElement("textarea");
    textarea.value = output;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("선택한 값을 복사했습니다.");
  }

  function applyPaste(textValue) {
    if (!state.active) return;
    var matrix = text(textValue).replace(/\r/g, "").split("\n");
    if (matrix.length && matrix[matrix.length - 1] === "") matrix.pop();
    matrix = matrix.map(function (line) { return line.split("\t"); });
    if (!matrix.length) return;

    var rows = visibleRowIds();
    var startRow = rows.indexOf(state.active.rowId);
    var startCol = FIELD_DEFS.findIndex(function (def) { return def.key === state.active.field; });
    if (startRow < 0 || startCol < 0) return;
    var changes = [];
    var bounds = rangeBounds();

    if (matrix.length === 1 && matrix[0].length === 1 && bounds &&
        (bounds.rowMax > bounds.rowMin || bounds.colMax > bounds.colMin)) {
      selectedRangeCells().forEach(function (cell) {
        if (isEditable(cell.rowId, cell.field)) {
          changes.push({ rowId: cell.rowId, field: cell.field, value: matrix[0][0] });
        }
      });
    } else {
      matrix.forEach(function (line, rowOffset) {
        line.forEach(function (value, colOffset) {
          var rowIndex = startRow + rowOffset;
          var colIndex = startCol + colOffset;
          if (rowIndex >= rows.length || colIndex >= FIELD_DEFS.length) return;
          var rowId = rows[rowIndex];
          var field = FIELD_DEFS[colIndex].key;
          if (isEditable(rowId, field)) changes.push({ rowId: rowId, field: field, value: value });
        });
      });
    }

    if (!changes.length) {
      showToast("붙여넣을 수 있는 편집 셀이 없습니다.");
      return;
    }
    applyChanges(changes, true);
    renderAll();
    showToast(changes.length + "개 셀에 값을 붙여넣었습니다.");
  }

  function addNewProduct() {
    var id = "__new__" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    state.working[id] = {
      "코드": "",
      "품목코드": "",
      "품목명": "",
      "규격": "",
      "단위": "",
      "1그룹명": state.filters.category && state.filters.category !== "__all__" ? state.filters.category : "",
      "3그룹명": state.filters.group && state.filters.group !== "__all__" ? state.filters.group : "",
      "안전재고": "",
      "입고가": "",
      "외주비": "",
      "경비": "",
      "비과세": 0,
      "판매여부": 1
    };
    var category = categoryRecords().find(function (item) {
      return item.value === state.working[id]["1그룹명"];
    });
    var group = groupRecords().find(function (item) {
      return item.value === state.working[id]["3그룹명"];
    });
    if (category) state.working[id]["1코드"] = category.linked;
    if (group) state.working[id]["3코드"] = group.linked;
    state.newIds.add(id);
    state.loaded = state.loaded || false;
    state.active = { rowId: id, field: "코드" };
    state.range = { start: state.active, end: state.active };
    state.edit = { rowId: id, field: "코드", seed: null };
    renderAll();
  }

  function discardAllChanges() {
    state.working = deepClone(state.masterOriginal);
    state.newIds.clear();
    state.selected.clear();
    state.dirtyCells.clear();
    state.errors.clear();
    state.undoStack = [];
    state.redoStack = [];
    state.active = null;
    state.range = null;
    state.edit = null;
    renderAll();
  }

  function confirmDiscard() {
    if (!dirtyRowIds().length) return;
    openDialog(
      "변경사항을 취소할까요?",
      "저장하지 않은 상품 기초정보 변경이 모두 원래 값으로 돌아갑니다.",
      [
        { label: "현재 화면 유지", onClick: closeDialog },
        {
          label: "변경 취소",
          danger: true,
          onClick: function () {
            closeDialog();
            discardAllChanges();
            showToast("저장하지 않은 변경사항을 취소했습니다.");
          }
        }
      ]
    );
  }

  function requestDeleteSelected() {
    if (state.processing) return;
    var ids = selectedExistingIds();
    if (!ids.length) {
      showToast("삭제할 상품을 선택해 주세요.");
      return;
    }
    if (dirtyRowIds().length) {
      showToast("변경사항을 저장하거나 취소한 뒤 선택 상품을 삭제해 주세요.");
      return;
    }
    if (ids.length >= Object.keys(state.masterOriginal).length) {
      openDialog(
        "전체 상품은 삭제할 수 없습니다.",
        "Master에는 최소 1개 상품을 유지해야 합니다. 전체교체 또는 초기화는 별도 승인 절차를 사용하세요.",
        [{ label: "확인", primary: true, onClick: closeDialog }]
      );
      return;
    }
    var preview = ids.slice(0, 5).map(function (id) {
      var row = state.masterOriginal[id] || {};
      return "· " + (row["품목명"] || row["상품명"] || id) + " (" + id + ")";
    });
    if (ids.length > preview.length) preview.push("· 외 " + (ids.length - preview.length) + "개 상품");
    openDialog(
      "선택 상품 " + ids.length + "건을 삭제할까요?",
      preview.join("\n") + "\n\n삭제 즉시 기기 Master와 정지·쇼핑몰 반영 대기 상태에서 제거하고 공식 이력을 남깁니다. 클라우드는 상단 동기화 메뉴에서 별도로 반영합니다.",
      [
        { label: "취소", onClick: closeDialog },
        {
          label: ids.length + "건 삭제",
          danger: true,
          onClick: function () {
            closeDialog();
            performSelectedDeletion(ids);
          }
        }
      ]
    );
  }

  async function performSelectedDeletion(ids) {
    var api = window.ONEAPP_MASTER_ADD_UPDATE;
    if (!api || typeof api.commitSelectedProductDeletion !== "function") {
      showToast("상품 삭제 모듈을 불러오지 못했습니다.");
      return;
    }
    state.processing = true;
    setSync("working", "선택 상품을 삭제하고 Master와 이력을 검증하고 있습니다.");
    renderAll();
    window.NEXUS_TOP?.reportStatus({
      appId: "item-manager",
      taskId: "item-manager-delete",
      level: "progress",
      message: "선택 상품 " + ids.length + "건을 삭제하고 검증하고 있습니다."
    });
    try {
      var result = await api.commitSelectedProductDeletion({
        codes: ids,
        expectedRevision: state.revision,
        storage: window.ONEAPP && window.ONEAPP.STORAGE,
        historyApi: window.ONEAPP && window.ONEAPP.HISTORY,
        localStorageRef: window.localStorage,
        actor: null
      });
      state.revision = result.revision;
      state.masterOriginal = result.masterMap;
      state.working = deepClone(result.masterMap);
      state.selected.clear();
      state.newIds.clear();
      state.loadedIds = state.loadedIds.filter(function (id) { return Boolean(state.working[id]); });
      state.dirtyCells.clear();
      state.errors.clear();
      state.undoStack = [];
      state.redoStack = [];
      state.active = null;
      state.range = null;
      state.edit = null;
      populateQueryOptions();
      if (!state.filters.category && !state.filters.group) {
        state.loaded = false;
        state.filters.loaded = false;
        state.loadedIds = [];
      } else if (state.loaded) {
        state.loadedIds = Object.keys(state.masterOriginal).filter(function (id) {
          return matchesLoadFilters(state.working[id] || {});
        }).sort(function (a, b) {
          return compareText((state.working[a] || {})["품목명"] || a, (state.working[b] || {})["품목명"] || b);
        });
      }
      saveFilters();
      state.processing = false;
      setSync("pending", "기기 삭제 완료 · 클라우드 동기화 대기");
      renderAll();
      window.NEXUS_TOP?.reportStatus({
        appId: "item-manager",
        taskId: "item-manager-delete",
        level: "normal",
        active: false,
        message: "선택 상품 삭제와 검증이 완료되었습니다."
      });
      openDialog(
        "상품 삭제 완료",
        result.deletedCount + "개 상품을 Master에서 삭제하고 공식 이력과 연결 상태를 확인했습니다.\n클라우드 공용 DB에는 아직 반영하지 않았습니다.",
        [{ label: "확인", primary: true, onClick: closeDialog }]
      );
    } catch (error) {
      state.processing = false;
      var message = "상품을 삭제하지 못했습니다. 기존 Master와 이력은 유지했습니다.";
      if (error && error.code === "MERCH_MASTER_REVISION_CONFLICT") {
        message = "다른 화면에서 상품 DB가 먼저 변경되었습니다. 최신 기기 DB를 다시 불러왔으니 삭제 대상을 다시 선택해 주세요.";
        try {
          state.masterOriginal = await readLocalMaster();
          state.working = deepClone(state.masterOriginal);
          state.selected.clear();
          state.loadedIds = state.loadedIds.filter(function (id) { return Boolean(state.working[id]); });
          populateQueryOptions();
        } catch (reloadError) {
          message += " 최신 DB 재조회에도 실패했습니다.";
        }
      }
      setSync("error", message);
      renderAll();
      window.NEXUS_TOP?.reportStatus({
        appId: "item-manager",
        taskId: "item-manager-delete",
        level: "error",
        message: error && error.message ? error.message : message
      });
      openDialog("상품 삭제 확인 필요", message, [{ label: "확인", primary: true, onClick: closeDialog }]);
    }
  }

  function buildSavePlan() {
    refreshDirtyCells();
    validateDirtyRows();
    var ids = dirtyRowIds();
    var valid = ids.filter(function (id) { return !rowHasError(id); });
    var invalid = ids.filter(function (id) { return rowHasError(id); });
    var cellCount = 0;
    valid.forEach(function (id) {
      if (state.newIds.has(id)) {
        cellCount += FIELD_DEFS.filter(function (def) {
          return trimmed(state.working[id][def.key]) !== "";
        }).length;
      } else {
        var prefix = id + "\u0001";
        cellCount += Array.from(state.dirtyCells).filter(function (key) {
          return key.indexOf(prefix) === 0;
        }).length;
      }
    });
    return { all: ids, valid: valid, invalid: invalid, cellCount: cellCount };
  }

  function requestSave(afterSave) {
    if (state.processing) return;
    var plan = buildSavePlan();
    renderAll();
    if (!plan.all.length) {
      showToast("저장할 변경사항이 없습니다.");
      return;
    }
    if (!plan.valid.length) {
      showToast("오류 셀을 확인해 주세요. 다른 셀은 계속 수정할 수 있습니다.");
      return;
    }
    var copy = plan.valid.length + "개 상품의 " + plan.cellCount + "개 항목을 변경합니다.";
    if (plan.invalid.length) {
      copy += "\n확인 필요 " + plan.invalid.length + "개 상품은 저장하지 않고 수정 상태로 유지합니다.";
    }
    openDialog(
      "변경사항을 저장할까요?",
      copy,
      [
        { label: "계속 수정", onClick: closeDialog },
        {
          label: "변경사항 저장",
          primary: true,
          onClick: function () {
            closeDialog();
            performSave(plan, afterSave);
          }
        }
      ]
    );
  }

  async function performSave(plan, afterSave) {
    state.processing = true;
    renderSaveState();
    setSync("working", "상품 기초정보를 저장하고 있습니다.");
    var invalidRows = {};
    plan.invalid.forEach(function (id) {
      invalidRows[id] = deepClone(state.working[id]);
    });
    var nextMaster = deepClone(state.masterOriginal);
    var savedNewCodes = [];

    try {
      plan.valid.forEach(function (id) {
        var row = deepClone(state.working[id]);
        var code = trimmed(row["코드"] || row["품목코드"] || id);
        row["코드"] = code;
        row["품목코드"] = trimmed(row["품목코드"] || code);
        if (state.newIds.has(id)) savedNewCodes.push(code);
        nextMaster[code] = row;
      });
      var result = await commitMaster(nextMaster);
      state.revision = result.revision;
      state.masterOriginal = nextMaster;
      state.working = deepClone(nextMaster);
      Object.keys(invalidRows).forEach(function (id) {
        state.working[id] = invalidRows[id];
      });

      var nextNewIds = new Set();
      state.newIds.forEach(function (id) {
        if (plan.invalid.indexOf(id) >= 0) nextNewIds.add(id);
      });
      state.newIds = nextNewIds;
      if (savedNewCodes.length) {
        state.loaded = true;
        state.filters.loaded = true;
        saveFilters();
      }
      state.loadedIds = savedNewCodes.concat(state.loadedIds).filter(function (id, index, all) {
        return state.working[id] && all.indexOf(id) === index;
      });
      state.selected = new Set(Array.from(state.selected).filter(function (id) {
        return plan.invalid.indexOf(id) >= 0;
      }));
      state.undoStack = [];
      state.redoStack = [];
      state.active = null;
      state.range = null;
      state.edit = null;
      try {
        localStorage.setItem(STORAGE_KEYS.SYNC_TRIGGER, Date.now().toString());
      } catch (error) {}
      setSync("pending", "기기 저장 완료 · 클라우드 동기화 대기");
      state.processing = false;
      renderAll();
      var resultCopy = "저장 완료 " + plan.valid.length + "건";
      if (plan.invalid.length) resultCopy += " · 확인 필요 " + plan.invalid.length + "건";
      openDialog(
        "저장 결과",
        resultCopy + "\n정상 상품은 저장했고, 오류 상품은 현재 표에 유지했습니다.",
        [{ label: "확인", primary: true, onClick: closeDialog }]
      );
      if (typeof afterSave === "function" && !dirtyRowIds().length) {
        window.setTimeout(afterSave, 0);
      }
    } catch (error) {
      state.processing = false;
      setSync("error", "저장하지 못했습니다. 변경사항은 현재 표에 그대로 보존했습니다.");
      renderAll();
      var message = error && error.code === "MERCH_MASTER_REVISION_CONFLICT"
        ? "다른 화면에서 상품 DB가 먼저 변경되었습니다. 클라우드 또는 최신 기기 DB를 새로고침한 뒤 다시 확인해 주세요."
        : "상품 DB에 저장하지 못했습니다. 변경사항은 현재 표에 남아 있습니다.";
      openDialog("저장 확인 필요", message, [{ label: "확인", primary: true, onClick: closeDialog }]);
    }
  }

  function guardUnsaved(action) {
    if (!dirtyRowIds().length) {
      action();
      return;
    }
    openDialog(
      "저장하지 않은 변경사항이 있습니다.",
      "변경사항을 취소하거나 저장한 뒤 이동할 수 있습니다.",
      [
        {
          label: "변경 취소",
          danger: true,
          onClick: function () {
            closeDialog();
            discardAllChanges();
            action();
          }
        },
        { label: "현재 화면 유지", onClick: closeDialog },
        {
          label: "저장 후 이동",
          primary: true,
          onClick: function () {
            closeDialog();
            requestSave(action);
          }
        }
      ]
    );
  }

  function applyBatch() {
    var field = els["batch-field"].value;
    var valueControl = $("batch-value");
    if (!field || !valueControl) return;
    var raw = valueControl.value;
    if (trimmed(raw) === "") {
      showToast("선택 상품에 적용할 값을 입력해 주세요.");
      return;
    }
    var blankOnly = els["batch-mode"].value === "blank";
    var changes = [];
    state.selected.forEach(function (rowId) {
      var row = state.working[rowId];
      if (!row) return;
      if (blankOnly && trimmed(row[field]) !== "") return;
      changes.push({ rowId: rowId, field: field, value: raw });
    });
    if (!changes.length) {
      showToast("적용 조건에 맞는 선택 상품이 없습니다.");
      return;
    }
    applyChanges(changes, true);
    renderAll();
    showToast(changes.length + "개 상품에 " + FIELD_MAP[field].label + " 값을 적용했습니다.");
  }

  function exportRows(rows, fileName) {
    if (!window.XLSX) {
      showToast("Excel 모듈을 불러오지 못했습니다.");
      return;
    }
    var output = rows.map(function (row) {
      return {
        "상품코드": row["코드"] || row["품목코드"] || "",
        "상품명": row["품목명"] || "",
        "규격": row["규격"] || "",
        "단위": row["단위"] || "",
        "카테고리": row["1그룹명"] || "",
        "그룹": row["3그룹명"] || "",
        "안전재고": row["안전재고"] === undefined ? "" : row["안전재고"],
        "기준단가": row["입고가"] === undefined ? "" : row["입고가"],
        "외주비": row["외주비"] === undefined ? "" : row["외주비"],
        "경비": row["경비"] === undefined ? "" : row["경비"],
        "부가세 여부": isTaxFree(row["비과세"]) ? "면세" : "과세",
        "사용 상태": isStopped(row["판매여부"]) ? "사용 중지" : "사용"
      };
    });
    var sheet = window.XLSX.utils.json_to_sheet(output, {
      header: ["상품코드", "상품명", "규격", "단위", "카테고리", "그룹", "안전재고", "기준단가", "외주비", "경비", "부가세 여부", "사용 상태"]
    });
    var book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, "상품기초정보");
    window.XLSX.writeFile(book, fileName);
  }

  function downloadCurrentRows() {
    var rows = visibleRowIds().map(function (id) { return state.working[id]; }).filter(Boolean);
    if (!rows.length) {
      showToast("내려받을 조회 상품이 없습니다.");
      return;
    }
    var date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    exportRows(rows, "상품_기초정보_" + date + ".xlsx");
    showToast("현재 조회 상품 " + rows.length + "건을 내려받았습니다.");
  }

  function downloadTemplate() {
    if (!window.XLSX) {
      showToast("Excel 모듈을 불러오지 못했습니다.");
      return;
    }
    var headers = ["상품코드", "상품명", "규격", "단위", "카테고리", "그룹", "안전재고", "기준단가", "외주비", "경비", "부가세 여부", "사용 상태"];
    var sheet = window.XLSX.utils.aoa_to_sheet([headers]);
    var book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, "기초정보양식");
    window.XLSX.writeFile(book, "상품_기초정보_양식.xlsx");
    showToast("상품 기초정보 양식을 내려받았습니다.");
  }

  function safeJson(raw, fallback) {
    try {
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  async function postCloud(url, payload) {
    throw new Error("NEXUS_GATEWAY_DIRECT_ACTION_DENIED");
  }

  async function uploadChunks(url, action, items, progressLabel) {
    var chunkSize = 500;
    for (var i = 0; i < items.length; i += chunkSize) {
      var chunk = items.slice(i, i + chunkSize);
      setSync("working", progressLabel + " " + Math.min(i + chunkSize, items.length) + " / " + items.length + "건");
      await postCloud(url, { action: action, data: chunk });
    }
  }

  async function pushCloudNow() {
    if (dirtyRowIds().length) {
      showToast("기기 변경사항을 먼저 저장해 주세요.");
      return;
    }
    state.processing = true;
    setSync("working", "클라우드에 반영할 상품 DB를 준비하고 있습니다.");
    renderSaveState();
    try {
      var url = setCloudUrl(getCloudUrl());
      await window.ONEAPP_AUTH.ready;
      var previous = {status:"success",data:await window.ONEAPP_AUTH.gateway("foundation.full_read",{})};
      var previousData = previous && previous.data ? previous.data : {};
      var localHistory = safeJson(localStorage.getItem("merchHistory_v870"), []);
      var history = Array.isArray(localHistory) && localHistory.length
        ? localHistory
        : (Array.isArray(previousData.history) ? previousData.history : []);
      await window.ONEAPP_AUTH.gateway("foundation.replace_all", {
        master:Object.values(state.masterOriginal), history:history, config:{
          dict: safeJson(localStorage.getItem("parserDict_v870"), previousData.dict || {}),
          rules: previousData.rules || [],
          appConfig: Object.assign({}, previousData.appConfig || {})
        }
      });
      try {
        localStorage.setItem(STORAGE_KEYS.SYNC_TRIGGER, Date.now().toString());
      } catch (error) {
        return;
      } finally {
        state.processing = false;
      }
      setSync("synced", "클라우드 동기화 완료 · " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
      renderAll();
      showToast("상품 DB " + Object.keys(state.masterOriginal).length + "건을 클라우드에 반영했습니다.");
    } catch (error) {
      state.processing = false;
      setSync("error", "클라우드 반영에 실패했습니다. 기기에 저장된 상품 DB는 유지됩니다.");
      renderAll();
      showToast("클라우드 반영을 완료하지 못했습니다.");
    }
  }

  function extractCloudMaster(payload) {
    if (!payload) return {};
    if (payload.status === "success" && payload.data) {
      if (payload.data.master) return normalizeMasterMap(payload.data.master);
      if (Array.isArray(payload.data)) return normalizeMasterMap(payload.data);
    }
    if (Array.isArray(payload.data)) return normalizeMasterMap(payload.data);
    if (Array.isArray(payload)) return normalizeMasterMap(payload);
    return {};
  }

  async function pullCloudNow() {
    state.processing = true;
    setSync("working", "클라우드 상품 DB를 불러오고 있습니다.");
    renderSaveState();
    try {
      var url = setCloudUrl(getCloudUrl());
      await window.ONEAPP_AUTH.ready;
      var master = extractCloudMaster({status:"success",data:await window.ONEAPP_AUTH.gateway("foundation.master_read",{})});
      if (!Object.keys(master).length) throw new Error("클라우드에 상품 DB가 없습니다.");
      var result = await commitMaster(master);
      state.revision = result.revision;
      state.masterOriginal = master;
      state.working = deepClone(master);
      state.newIds.clear();
      state.selected.clear();
      state.undoStack = [];
      state.redoStack = [];
      populateQueryOptions();
      if (state.loaded) loadProductsNow();
      state.processing = false;
      setSync("synced", "클라우드 새로고침 완료 · 상품 " + Object.keys(master).length + "건");
      renderAll();
      showToast("클라우드 상품 DB " + Object.keys(master).length + "건을 불러왔습니다.");
    } catch (error) {
      state.processing = false;
      setSync("error", "클라우드 새로고침에 실패했습니다. 현재 기기 DB는 유지됩니다.");
      renderAll();
      showToast("클라우드 상품 DB를 불러오지 못했습니다.");
    }
  }

  function requestCloudPush() {
    closeMenus();
    if (dirtyRowIds().length) {
      showToast("기기 변경사항을 먼저 저장해 주세요.");
      return;
    }
    openDialog(
      "클라우드에 반영할까요?",
      "현재 기기에 저장된 상품 DB " + Object.keys(state.masterOriginal).length + "건을 공용 클라우드에 반영합니다.",
      [
        { label: "취소", onClick: closeDialog },
        {
          label: "클라우드에 반영",
          primary: true,
          onClick: function () {
            closeDialog();
            pushCloudNow();
          }
        }
      ]
    );
  }

  function requestCloudPull() {
    closeMenus();
    guardUnsaved(function () {
      openDialog(
        "클라우드 상품 DB를 불러올까요?",
        "현재 기기 상품 DB를 클라우드의 최신 상품 DB로 갱신합니다.",
        [
          { label: "취소", onClick: closeDialog },
          {
            label: "새로고침",
            primary: true,
            onClick: function () {
              closeDialog();
              pullCloudNow();
            }
          }
        ]
      );
    });
  }

  function handleGridKeydown(event) {
    var editor = event.target.closest("[data-editor='1']");
    if (editor) {
      if (event.key === "Escape") {
        event.preventDefault();
        state.edit = null;
        renderTable();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        var key = event.key;
        var current = commitEditor(editor);
        renderAll();
        if (!current) return;
        state.active = current;
        if (key === "Enter") moveActive(event.shiftKey ? -1 : 1, 0, true);
        else moveActive(0, event.shiftKey ? -1 : 1, true);
      }
      return;
    }

    var cell = event.target.closest(".grid-cell");
    if (!cell) return;
    state.active = { rowId: cell.dataset.rowId, field: cell.dataset.field };
    if (event.key === "F2" || event.key === "Enter") {
      event.preventDefault();
      beginEdit(cell.dataset.rowId, cell.dataset.field);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      moveActive(0, event.shiftKey ? -1 : 1, false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1, 0, false);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1, 0, false);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveActive(0, 1, false);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveActive(0, -1, false);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      beginEdit(cell.dataset.rowId, cell.dataset.field, event.key);
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    els["excel-menu-button"].addEventListener("click", function (event) {
      event.stopPropagation();
      toggleMenu(els["excel-menu-button"], els["excel-menu"]);
    });
    els["sync-menu-button"].addEventListener("click", function (event) {
      event.stopPropagation();
      toggleMenu(els["sync-menu-button"], els["sync-menu"]);
    });
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".menu-anchor")) closeMenus();
    });

    els["excel-menu"].addEventListener("click", function (event) {
      var button = event.target.closest("[data-excel-action]");
      if (!button) return;
      closeMenus();
      if (button.dataset.excelAction === "download") downloadCurrentRows();
      if (button.dataset.excelAction === "template") downloadTemplate();
      if (button.dataset.excelAction === "batch") {
        guardUnsaved(function () {
          window.location.href = "Master.html?view=products&mode=edit";
        });
      }
    });

    els["category-filter"].addEventListener("change", function () {
      state.filters.category = els["category-filter"].value;
      els["load-button"].disabled = !state.filters.category && !state.filters.group;
      saveFilters();
    });
    els["group-filter"].addEventListener("change", function () {
      state.filters.group = els["group-filter"].value;
      els["load-button"].disabled = !state.filters.category && !state.filters.group;
      saveFilters();
    });
    els["status-filter"].addEventListener("change", function () {
      state.filters.status = els["status-filter"].value;
      saveFilters();
    });
    els["search-filter"].addEventListener("input", function () {
      state.filters.search = els["search-filter"].value;
      saveFilters();
      renderAll();
    });
    els["load-button"].addEventListener("click", requestLoadProducts);
    els["delete-selected-button"].addEventListener("click", requestDeleteSelected);
    els["add-product-button"].addEventListener("click", addNewProduct);
    els["header-save-button"].addEventListener("click", function () { requestSave(); });
    els["footer-save-button"].addEventListener("click", function () { requestSave(); });
    els["discard-button"].addEventListener("click", confirmDiscard);
    els["cloud-push-button"].addEventListener("click", requestCloudPush);
    els["cloud-pull-button"].addEventListener("click", requestCloudPull);

    els["dialog-actions"].addEventListener("click", function (event) {
      var button = event.target.closest("[data-dialog-action]");
      if (!button) return;
      var action = dialogActions[Number(button.dataset.dialogAction)];
      if (action && typeof action.onClick === "function") action.onClick();
    });
    els["dialog-backdrop"].addEventListener("click", function (event) {
      if (event.target === els["dialog-backdrop"]) closeDialog();
    });

    els["product-grid"].addEventListener("click", function (event) {
      var selectAll = event.target.closest("#select-all-rows");
      if (selectAll) {
        visibleRowIds().forEach(function (id) {
          if (selectAll.checked) state.selected.add(id);
          else state.selected.delete(id);
        });
        renderAll();
        return;
      }
      var checkbox = event.target.closest(".row-checkbox");
      if (checkbox) {
        if (checkbox.checked) state.selected.add(checkbox.dataset.rowId);
        else state.selected.delete(checkbox.dataset.rowId);
        renderAll();
        return;
      }
      var cell = event.target.closest(".grid-cell");
      if (cell && !event.target.closest("[data-editor='1']")) {
        activateCell(cell.dataset.rowId, cell.dataset.field, event.shiftKey);
      }
    });

    els["product-grid"].addEventListener("dblclick", function (event) {
      var cell = event.target.closest(".grid-cell");
      if (!cell) return;
      beginEdit(cell.dataset.rowId, cell.dataset.field);
    });
    els["product-grid"].addEventListener("keydown", handleGridKeydown);
    els["product-grid"].addEventListener("change", function (event) {
      var editor = event.target.closest("select[data-editor='1']");
      if (!editor) return;
      var current = commitEditor(editor);
      renderAll();
      if (current) {
        state.active = current;
        moveActive(0, 1, false);
      }
    });
    els["product-grid"].addEventListener("focusout", function (event) {
      var editor = event.target.closest("input[data-editor='1']");
      if (!editor || !state.edit) return;
      window.setTimeout(function () {
        if (!state.edit || document.activeElement === editor) return;
        commitEditor(editor);
        renderAll();
      }, 0);
    });
    els["product-grid"].addEventListener("mousedown", function (event) {
      var cell = event.target.closest(".grid-cell");
      if (!cell || event.button !== 0 || event.target.closest("[data-editor='1']")) return;
      state.dragging = true;
      state.active = { rowId: cell.dataset.rowId, field: cell.dataset.field };
      state.range = { start: state.active, end: state.active };
    });
    els["product-grid"].addEventListener("mouseover", function (event) {
      if (!state.dragging) return;
      var cell = event.target.closest(".grid-cell");
      if (!cell) return;
      state.range.end = { rowId: cell.dataset.rowId, field: cell.dataset.field };
      refreshCellSelectionClasses();
    });
    window.addEventListener("mouseup", function () { state.dragging = false; });

    els["batch-field"].addEventListener("change", renderBatchValue);
    els["batch-apply-button"].addEventListener("click", applyBatch);

    document.addEventListener("keydown", function (event) {
      var modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        requestSave();
      } else if (modifier && event.key.toLowerCase() === "z" && !event.shiftKey) {
        if (event.target.matches("input,textarea,select")) return;
        event.preventDefault();
        undo();
      } else if ((modifier && event.key.toLowerCase() === "y") ||
                 (modifier && event.shiftKey && event.key.toLowerCase() === "z")) {
        if (event.target.matches("input,textarea,select")) return;
        event.preventDefault();
        redo();
      } else if (modifier && event.key.toLowerCase() === "c") {
        if (event.target.matches("input,textarea,select")) return;
        event.preventDefault();
        copySelection();
      } else if (event.key === "Escape") {
        closeMenus();
        if (!els["dialog-backdrop"].hidden) closeDialog();
      }
    });

    document.addEventListener("paste", function (event) {
      if (!state.active || event.target.matches("input,textarea,select")) return;
      event.preventDefault();
      applyPaste(event.clipboardData.getData("text/plain"));
    });

    document.addEventListener("click", function (event) {
      var path = typeof event.composedPath === "function" ? event.composedPath() : [];
      var anchor = path.find(function (node) {
        return node && node.tagName === "A" && node.href;
      }) || event.target.closest("a[href]");
      if (!anchor || !anchor.href || anchor.target === "_blank") return;
      var destination = new URL(anchor.href, window.location.href);
      if (destination.href === window.location.href) return;
      if (destination.origin !== window.location.origin) return;
      if (!dirtyRowIds().length) return;
      event.preventDefault();
      event.stopPropagation();
      guardUnsaved(function () {
        window.location.href = destination.href;
      });
    }, true);

    window.addEventListener("beforeunload", function (event) {
      if (!dirtyRowIds().length) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function initialize() {
    cacheElements();
    try {
      await loadFoundationFieldDefinitions();
    } catch (metadataError) {
      console.warn("[FoundationMetadata] 서버 필드 레지스트리를 불러오지 못해 기존 화면 필드로 계속합니다.", metadataError);
    }
    bindEvents();
    try {
      state.masterOriginal = await readLocalMaster();
      state.working = deepClone(state.masterOriginal);
      populateQueryOptions();
      if (state.filters.loaded && (state.filters.category || state.filters.group)) {
        loadProductsNow();
      } else {
        renderAll();
      }
      setSync("pending", "기기 상품 DB " + Object.keys(state.masterOriginal).length + "건 · 클라우드 동기화 상태 미확인");
      renderAll();
      els.app.setAttribute("aria-busy", "false");
    } catch (error) {
      els.app.setAttribute("aria-busy", "false");
      setSync("error", "상품 DB를 불러오지 못했습니다.");
      els["grid-empty"].innerHTML = "<strong>상품 DB를 불러오지 못했습니다.</strong><span>잠시 후 새로고침하거나 공통 설정을 확인하세요.</span>";
      els["grid-empty"].hidden = false;
      els["grid-region"].hidden = true;
      showToast("상품 DB를 불러오지 못했습니다.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
