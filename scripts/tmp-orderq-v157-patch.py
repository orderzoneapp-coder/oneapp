from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
HTML_FILES = [ROOT / "orderops_list.html", ROOT / "orderops" / "list.html"]
ENGINE_FILE = ROOT / "orderFulfillmentEngine.js"
TEST_FILE = ROOT / "scripts" / "test-shipping-management.mjs"


def exact(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 exact match, got {count}")
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 regex match, got {count}")
    return updated


def patch_html(path):
    text = path.read_text(encoding="utf-8")
    if "ORDER Q v1.57" in text and "function applyAllocationSegmentAggregates" in text:
        print(f"already patched: {path.relative_to(ROOT)}")
        return

    text = text.replace("v1.56", "v1.57")

    css = r'''
    /* ORDER Q v1.57: 거래처 담당자 변경 */
    .manager-assignment-trigger {
      width: 100%;
      min-height: 24px;
      padding: 2px 5px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: inherit;
      background: transparent;
      font: inherit;
      text-align: left;
    }
    .manager-assignment-trigger:hover,
    .manager-assignment-trigger:focus-visible {
      border-color: #0d9488;
      color: #0f766e;
      background: #f0fdfa;
      outline: none;
    }
    .manager-assignment-guide {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 3px 4px 6px;
      color: #334155;
      font-size: 11px;
    }
    .manager-assignment-guide strong { color: #0f766e; }
    .manager-assignment-guide button { margin-left: auto; }
    .manager-assignment-option {
      width: 100%;
      min-height: 29px;
      padding: 4px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      color: #334155;
      background: #fff;
      font: inherit;
      font-weight: 800;
      text-align: left;
    }
    .manager-assignment-option:hover,
    .manager-assignment-option.active {
      border-color: #0d9488;
      color: #0f766e;
      background: #f0fdfa;
    }
'''
    text = exact(text, "  </style>", css + "\n  </style>", "manager assignment CSS")

    text = exact(
        text,
        '      const PURCHASE_HISTORY_KEY = "oneapp.orderops.purchase-history.v1";\n      const ORDER_VIEW_PRESETS_KEY = "oneapp.orderops.order-view-presets.v1";',
        '      const PURCHASE_HISTORY_KEY = "oneapp.orderops.purchase-history.v1";\n      const SORT_SETTINGS_KEY = "oneapp.orderops.sort-settings.v1";\n      const SORT_SETTINGS_SCHEMA = "orderops-sort-settings/v1";\n      const ORDER_VIEW_PRESETS_KEY = "oneapp.orderops.order-view-presets.v1";',
        "sort storage constants",
    )
    text = exact(
        text,
        '      const ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v4";\n      const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v3";\n      const LEGACY_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v2";\n      const ORIGINAL_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v1";',
        '      const ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v5";\n      const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v4";\n      const LEGACY_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v3";\n      const ORIGINAL_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v2";\n      const FIRST_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v1";',
        "view preset schema",
    )

    sort_storage = r'''      function loadSortSettings() {
        const result = Object.create(null);
        try {
          const parsed = JSON.parse(localStorage.getItem(SORT_SETTINGS_KEY) || "null");
          if (!isPlainRecord(parsed) || parsed.schemaVersion !== SORT_SETTINGS_SCHEMA || !isPlainRecord(parsed.tabs)) {
            return result;
          }
          Object.entries(parsed.tabs).forEach(([previewId, settings]) => {
            const normalized = (Array.isArray(settings) ? settings : [settings])
              .filter((setting) => isPlainRecord(setting) && isSafeColumnKey(setting.columnKey) &&
                ["asc", "desc"].includes(setting.direction))
              .map((setting) => ({ columnKey: setting.columnKey, direction: setting.direction }));
            if (normalized.length > 0) result[previewId] = normalized;
          });
        } catch (error) {}
        return result;
      }

      function saveSortSettings() {
        const tabs = Object.create(null);
        Object.entries(state.sortSettings || {}).forEach(([previewId, settings]) => {
          const normalized = (Array.isArray(settings) ? settings : [settings])
            .filter((setting) => isPlainRecord(setting) && isSafeColumnKey(setting.columnKey) &&
              ["asc", "desc"].includes(setting.direction))
            .map((setting) => ({ columnKey: setting.columnKey, direction: setting.direction }));
          if (normalized.length > 0) tabs[previewId] = normalized;
        });
        localStorage.setItem(SORT_SETTINGS_KEY, JSON.stringify({ schemaVersion: SORT_SETTINGS_SCHEMA, tabs }));
      }

'''
    text = exact(text, "      const state = {", sort_storage + "      const state = {", "sort storage functions")
    text = exact(text, "        managerFilters: new Set(),\n        sortSettings: Object.create(null),", "        managerFilters: new Set(),\n        managerAssignmentCustomer: \"\",\n        sortSettings: loadSortSettings(),", "state sort/manager")

    normalize_preset = r'''      function normalizeOrderViewPreset(value) {
        if (!isPlainRecord(value) || !isPlainRecord(value.view)) return null;
        const id = String(value.id || "").trim();
        const name = String(value.name || "").trim().slice(0, 40);
        if (!/^[a-z0-9._:-]{1,80}$/i.test(id) || !name) return null;
        const previewId = VIEW_PRESET_TABS.has(value.previewId) ? value.previewId : "allocations";
        const rawSortSettings = Array.isArray(value.view.sortSettings)
          ? value.view.sortSettings
          : isPlainRecord(value.view.sortSetting) ? [value.view.sortSetting] : [];
        const sortSettings = [];
        const seenSortColumns = new Set();
        rawSortSettings.forEach((setting) => {
          if (!isPlainRecord(setting) || !isSafeColumnKey(setting.columnKey) ||
              !["asc", "desc"].includes(setting.direction) || seenSortColumns.has(setting.columnKey)) return;
          seenSortColumns.add(setting.columnKey);
          sortSettings.push({ columnKey: setting.columnKey, direction: setting.direction });
        });
        const sortSetting = sortSettings[0] || null;
        return {
          id,
          name,
          previewId,
          isDefault: value.isDefault === true,
          updatedAt: String(value.updatedAt || ""),
          view: {
            searchQuery: String(value.view.searchQuery || "").slice(0, 300),
            shortageFocus: value.view.shortageFocus === true,
            specificationFilters: normalizeStringList(value.view.specificationFilters, 20),
            warehouseFilters: normalizeStringList(value.view.warehouseFilters, 100),
            managerFilters: normalizeStringList(value.view.managerFilters, 100),
            sortSetting,
            sortSettings,
            columnFilters: normalizeStoredColumnFilters(value.view.columnFilters),
            layoutCaptured: value.view.layoutCaptured === true ||
              isPlainRecord(value.view.columnWidths) || Array.isArray(value.view.columnOrder),
            columnWidths: normalizeStoredColumnWidths(value.view.columnWidths),
            columnOrder: normalizeStoredColumnOrder(value.view.columnOrder),
            hiddenColumns: normalizeStoredColumnOrder(value.view.hiddenColumns),
            colorSettingsCaptured: value.view.colorSettingsCaptured === true ||
              isPlainRecord(value.view.warehouseColors) || isPlainRecord(value.view.managerColors),
            warehouseColors: normalizeStoredColorMap(value.view.warehouseColors, isSafeColumnKey),
            managerColors: normalizeStoredColorMap(value.view.managerColors, isSafeManagerName),
          },
        };
      }

'''
    text = regex_once(
        text,
        r"      function normalizeOrderViewPreset\(value\) \{.*?\n      \}\n\n(?=      function loadOrderViewPresets\()",
        normalize_preset,
        "normalizeOrderViewPreset",
    )
    text = exact(
        text,
        '            parsed?.schemaVersion === LEGACY_ORDER_VIEW_PRESETS_SCHEMA ||\n            parsed?.schemaVersion === ORIGINAL_ORDER_VIEW_PRESETS_SCHEMA;',
        '            parsed?.schemaVersion === LEGACY_ORDER_VIEW_PRESETS_SCHEMA ||\n            parsed?.schemaVersion === ORIGINAL_ORDER_VIEW_PRESETS_SCHEMA ||\n            parsed?.schemaVersion === FIRST_ORDER_VIEW_PRESETS_SCHEMA;',
        "view preset legacy load",
    )

    capture = r'''      function captureOrderViewPreset() {
        const previewId = state.activePreview;
        const preview = getPreviewDefinitions(state.workspace)[previewId];
        const sortSettings = columnSortSettings(previewId, preview);
        const columnWidths = Object.create(null);
        preview.columns.forEach((column) => {
          columnWidths[column.key] = currentColumnWidth(previewId, column);
        });
        return {
          searchQuery: state.searchQuery,
          shortageFocus: state.shortageFocus,
          specificationFilters: [...state.specificationFilters],
          warehouseFilters: [...state.warehouseFilters],
          managerFilters: [...state.managerFilters],
          sortSetting: sortSettings[0] ? { ...sortSettings[0] } : null,
          sortSettings: sortSettings.map((setting) => ({ ...setting })),
          columnFilters: normalizeStoredColumnFilters(state.columnFilters[previewId]),
          layoutCaptured: true,
          columnWidths,
          columnOrder: orderedColumns(preview, previewId).map((column) => column.key),
          hiddenColumns: [...hiddenColumnSet(previewId)],
          colorSettingsCaptured: true,
          warehouseColors: normalizeStoredColorMap(state.warehouseColorSettings.colors, isSafeColumnKey),
          managerColors: normalizeStoredColorMap(state.managerColorSettings.colors, isSafeManagerName),
        };
      }

'''
    text = regex_once(
        text,
        r"      function captureOrderViewPreset\(\) \{.*?\n      \}\n\n(?=      function persistSelectedOrderViewPresetColors\()",
        capture,
        "captureOrderViewPreset",
    )
    text = exact(
        text,
        '''        if (preset.view.sortSetting && previewKeys.has(preset.view.sortSetting.columnKey)) {
          state.sortSettings[previewId] = { ...preset.view.sortSetting };
        } else {
          delete state.sortSettings[previewId];
        }''',
        '''        const presetSortSettings = (Array.isArray(preset.view.sortSettings)
          ? preset.view.sortSettings
          : preset.view.sortSetting ? [preset.view.sortSetting] : [])
          .filter((setting) => previewKeys.has(setting.columnKey) && ["asc", "desc"].includes(setting.direction))
          .map((setting) => ({ columnKey: setting.columnKey, direction: setting.direction }));
        if (presetSortSettings.length > 0) {
          state.sortSettings[previewId] = previewId === "allocations" ? presetSortSettings : [presetSortSettings[0]];
        } else {
          delete state.sortSettings[previewId];
        }
        saveSortSettings();''',
        "apply preset sorts",
    )

    sort_helpers = r'''      function columnSortSettings(previewId, preview) {
        const stored = state.sortSettings[previewId];
        const rawSettings = Array.isArray(stored) ? stored : stored ? [stored] : [];
        const validColumns = new Set((preview?.columns || []).map((column) => column.key));
        const result = [];
        const seen = new Set();
        rawSettings.forEach((setting) => {
          if (!setting || !["asc", "desc"].includes(setting.direction) ||
              !validColumns.has(setting.columnKey) || seen.has(setting.columnKey)) return;
          seen.add(setting.columnKey);
          result.push({ columnKey: setting.columnKey, direction: setting.direction });
        });
        return result;
      }

      function columnSortSetting(previewId, preview, columnKey = "") {
        const settings = columnSortSettings(previewId, preview);
        return columnKey
          ? settings.find((setting) => setting.columnKey === columnKey) || null
          : settings[0] || null;
      }

      function setColumnSortSetting(previewId, preview, columnKey, direction) {
        let settings = previewId === "allocations" ? columnSortSettings(previewId, preview) : [];
        settings = settings.filter((setting) => setting.columnKey !== columnKey);
        if (["asc", "desc"].includes(direction)) settings.push({ columnKey, direction });
        if (settings.length > 0) state.sortSettings[previewId] = settings;
        else delete state.sortSettings[previewId];
        saveSortSettings();
      }

      function removeColumnSortSetting(previewId, preview, columnKey) {
        const settings = columnSortSettings(previewId, preview)
          .filter((setting) => setting.columnKey !== columnKey);
        if (settings.length > 0) state.sortSettings[previewId] = settings;
        else delete state.sortSettings[previewId];
        saveSortSettings();
      }

      function layeredColumnSortSettings(previewId, preview) {
        const selected = columnSortSettings(previewId, preview);
        if (previewId !== "allocations") return selected.slice(0, 1);
        const columnsByRole = new Map((preview?.columns || [])
          .filter((column) => column?.role).map((column) => [column.role, column]));
        const selectedByRole = new Map();
        selected.forEach((setting) => {
          const column = preview.columns.find((candidate) => candidate.key === setting.columnKey);
          if (column?.role) selectedByRole.set(column.role, setting);
        });
        const criteria = [];
        const appendSetting = (setting) => {
          if (!setting || criteria.some((candidate) => candidate.columnKey === setting.columnKey)) return;
          criteria.push({ columnKey: setting.columnKey, direction: setting.direction });
        };
        ["manager", "group", "customer"].forEach((role) => appendSetting(selectedByRole.get(role)));
        selected.forEach((setting) => {
          const column = preview.columns.find((candidate) => candidate.key === setting.columnKey);
          if (!["manager", "group", "customer", "productCode"].includes(column?.role)) appendSetting(setting);
        });
        const selectedProductCode = selectedByRole.get("productCode");
        if (selectedProductCode) appendSetting(selectedProductCode);
        else {
          const productCodeColumn = columnsByRole.get("productCode");
          if (productCodeColumn) appendSetting({ columnKey: productCodeColumn.key, direction: "asc" });
        }
        return criteria;
      }

'''
    text = regex_once(
        text,
        r"      function columnSortSetting\(previewId, preview\) \{.*?\n      \}\n\n      function layeredColumnSortSettings\(previewId, preview\) \{.*?\n      \}\n\n(?=      function columnFilterSetting\()",
        sort_helpers,
        "multi sort helpers",
    )

    aggregate_and_filter = r'''      function applyAllocationSegmentAggregates(previewId, preview, pairs) {
        if (previewId !== "allocations" || !Array.isArray(pairs) || pairs.length === 0) return pairs;
        const informationIndex = preview.columns.findIndex((column) => column.role === "productAggregateQuantity");
        if (informationIndex < 0) return pairs;
        const hierarchyRoles = layeredColumnSortSettings(previewId, preview)
          .map((setting) => preview.columns.find((column) => column.key === setting.columnKey)?.role)
          .filter((role) => ["manager", "group", "customer"].includes(role));
        const segmentKey = (pair) => JSON.stringify([
          ...hierarchyRoles.map((role) => String(pair.sourceRow?.[role] || "")),
          engine.normalizeProductCode(pair.sourceRow?.productCode),
        ]);
        const result = [];
        let start = 0;
        while (start < pairs.length) {
          const key = segmentKey(pairs[start]);
          let end = start + 1;
          while (end < pairs.length && segmentKey(pairs[end]) === key) end += 1;
          const total = Math.round(pairs.slice(start, end).reduce((sum, pair) => {
            const parsed = engine.parseNumericCell(pair.sourceRow?.quantity);
            return sum + (parsed.ok ? parsed.value : 0);
          }, 0) * 1000000) / 1000000;
          for (let index = start; index < end; index += 1) {
            const pair = pairs[index];
            const row = [...pair.row];
            row[informationIndex] = index === start ? total : "";
            result.push({ ...pair, row });
          }
          start = end;
        }
        return result;
      }

      function filteredSortedPreviewPairs(previewId, preview) {
        const pairs = preview.rows.map((row, index) => ({
          row,
          sourceRow: preview.sourceRows[index],
          index,
        }));

        if (preview.keepReferenceBlocks) {
          const blocks = [];
          let activeBlock = null;
          pairs.forEach((pair) => {
            const isReference = pair.sourceRow?.rowType === "reference";
            if (!isReference || !activeBlock) {
              activeBlock = { main: pair, pairs: [pair] };
              blocks.push(activeBlock);
            } else {
              activeBlock.pairs.push(pair);
            }
          });
          blocks.sort((left, right) => comparePreviewPairs(previewId, preview, left.main, right.main));

          return blocks.flatMap((block) => {
            if (!state.searchQuery.trim() && state.specificationFilters.size === 0 && !hasColumnFilters(previewId)) return block.pairs;
            const matching = block.pairs.filter((pair) => rowMatchesView(previewId, pair, preview));
            if (matching.length === 0) return [];
            if (matching.includes(block.main)) return block.pairs;
            return [block.main, ...matching.filter((pair) => pair !== block.main)];
          });
        }

        const filtered = pairs.filter((pair) => rowMatchesView(previewId, pair, preview));
        if (columnSortSettings(previewId, preview).length > 0 || preview.sortByProductCode) {
          filtered.sort((left, right) => comparePreviewPairs(previewId, preview, left, right));
        }
        return applyAllocationSegmentAggregates(previewId, preview, filtered);
      }

'''
    text = regex_once(
        text,
        r"      function filteredSortedPreviewPairs\(previewId, preview\) \{.*?\n      \}\n\n(?=      function previewDefinitionById\()",
        aggregate_and_filter,
        "sorted segment aggregate",
    )

    text = text.replace(
        "const sort = columnSortSetting(context.previewId, preview);",
        "const sort = columnSortSetting(context.previewId, preview, context.columnKey);",
    )
    text = exact(
        text,
        "          const sort = columnSortSetting(previewId, preview);\n          const filter = columnFilterSetting(previewId, column.key);\n          const isSorted = sort?.columnKey === column.key;",
        "          const sort = columnSortSetting(previewId, preview, column.key);\n          const filter = columnFilterSetting(previewId, column.key);\n          const isSorted = Boolean(sort);",
        "header multi sort indicator",
    )

    text = exact(
        text,
        '''        const sortButton = event.target.closest("[data-sort-direction]");
        if (sortButton) {
          const direction = sortButton.dataset.sortDirection;
          if (direction === "default") delete state.sortSettings[context.previewId];
          else state.sortSettings[context.previewId] = { columnKey: context.columnKey, direction };
          if (VIEW_PRESET_TABS.has(context.previewId)) markOrderViewPresetCustom();
          closeColumnSortMenu();
          renderPreview();
          return;
        }
        if (event.target.closest("[data-clear-column-filter]")) {
          if (state.sortSettings[context.previewId]?.columnKey === context.columnKey) {
            delete state.sortSettings[context.previewId];
          }''',
        '''        const sortButton = event.target.closest("[data-sort-direction]");
        if (sortButton) {
          const direction = sortButton.dataset.sortDirection;
          setColumnSortSetting(context.previewId, previewDefinitionById(context.previewId), context.columnKey, direction);
          if (VIEW_PRESET_TABS.has(context.previewId)) markOrderViewPresetCustom();
          closeColumnSortMenu();
          renderPreview();
          return;
        }
        if (event.target.closest("[data-clear-column-filter]")) {
          removeColumnSortSetting(context.previewId, previewDefinitionById(context.previewId), context.columnKey);''',
        "sort menu multi state",
    )

    manager_options_old = '''        elements.managerColorOptions.innerHTML = managerNames(allocationsPreview).map((manager) => {
          const checked = state.managerFilters.has(manager);
          return `
            <div class="warehouse-color-option">
              <label>
                <input type="checkbox" data-manager-filter="${escapeHtml(manager)}" ${checked ? "checked" : ""}>
                <span>${escapeHtml(manager)}</span>
              </label>
            </div>`;
        }).join("");'''
    manager_options_new = '''        const assignmentCustomer = String(state.managerAssignmentCustomer || "").trim();
        const availableManagers = managerNames(allocationsPreview);
        const assignmentRows = assignmentCustomer
          ? (allocationsPreview?.sourceRows || []).filter((row) => String(row?.customer || "").trim() === assignmentCustomer)
          : [];
        const currentAssignmentManager = assignmentRows.map((row) => String(row?.manager || "").trim()).find(Boolean) || "";
        const managerTitle = elements.managerFilterPanel.querySelector(".warehouse-color-title");
        if (managerTitle) managerTitle.textContent = assignmentCustomer ? `담당자 변경 · ${assignmentCustomer}` : "담당자 보기";
        elements.managerColorOptions.innerHTML = assignmentCustomer
          ? `<div class="manager-assignment-guide"><span>거래처 <strong>${escapeHtml(assignmentCustomer)}</strong> · 담당자 선택</span><button type="button" data-manager-assignment-cancel>취소</button></div>` +
            availableManagers.map((manager) => `
              <div class="warehouse-color-option">
                <button class="manager-assignment-option ${manager === currentAssignmentManager ? "active" : ""}" type="button"
                  data-manager-assignment="${escapeHtml(manager)}" aria-pressed="${manager === currentAssignmentManager}">${escapeHtml(manager)}</button>
              </div>`).join("")
          : availableManagers.map((manager) => {
              const checked = state.managerFilters.has(manager);
              return `
                <div class="warehouse-color-option">
                  <label>
                    <input type="checkbox" data-manager-filter="${escapeHtml(manager)}" ${checked ? "checked" : ""}>
                    <span>${escapeHtml(manager)}</span>
                  </label>
                </div>`;
            }).join("");'''
    text = exact(text, manager_options_old, manager_options_new, "manager accordion assignment options")
    text = exact(
        text,
        '        elements.colorAssignmentPanel.classList.toggle("hidden", !targetType);',
        '        elements.colorAssignmentPanel.classList.toggle("hidden", !targetType || Boolean(state.managerAssignmentCustomer));',
        "hide color assignment during manager reassignment",
    )

    text = exact(
        text,
        '''      elements.managerFilterToggle.addEventListener("click", () => {
        setActiveFilterPanel(state.activeFilterPanel === "manager" ? "" : "manager");
      });''',
        '''      elements.managerFilterToggle.addEventListener("click", () => {
        if (state.managerAssignmentCustomer) {
          state.managerAssignmentCustomer = "";
          setActiveFilterPanel("manager");
          return;
        }
        setActiveFilterPanel(state.activeFilterPanel === "manager" ? "" : "manager");
      });''',
        "manager filter toggle assignment mode",
    )

    manager_click = r'''      elements.managerColorOptions.addEventListener("click", (event) => {
        if (event.target.closest("[data-manager-assignment-cancel]")) {
          state.managerAssignmentCustomer = "";
          if (state.workspace) renderWarehouseColorBar(getPreviewDefinitions(state.workspace));
          return;
        }
        const option = event.target.closest("[data-manager-assignment]");
        const customer = String(state.managerAssignmentCustomer || "").trim();
        if (!option || !customer || !state.workspace) return;
        const manager = String(option.dataset.managerAssignment || "").trim();
        try {
          engine.setCustomerManager(state.workspace, customer, manager);
          state.managerAssignmentCustomer = "";
          setActiveFilterPanel("manager");
          renderResults();
          scheduleLocalSave();
          showToast(`${customer} 담당자를 ${manager}로 변경했습니다.`);
        } catch (error) {
          showToast(error.message || "담당자를 변경하지 못했습니다.", true);
        }
      });
'''
    text = exact(
        text,
        '''      [elements.warehouseColorOptions, elements.managerColorOptions].forEach((container) => {
        container.addEventListener("change", handleFixedFilterChange);
      });
''',
        '''      [elements.warehouseColorOptions, elements.managerColorOptions].forEach((container) => {
        container.addEventListener("change", handleFixedFilterChange);
      });
''' + manager_click,
        "manager assignment click handler",
    )

    text = exact(
        text,
        '''                    const editableOrder = editable && previewId === "allocations" && column.orderField && sourceRow?.sourceRowNumber;
                    const content = editablePurchase''',
        '''                    const editableOrder = editable && previewId === "allocations" && column.orderField && sourceRow?.sourceRowNumber;
                    const managerAssignment = editable && previewId === "allocations" && column.role === "manager" && sourceRow?.customer;
                    const content = editablePurchase''',
        "manager assignment render flag",
    )
    text = exact(
        text,
        '''                      : noticeLink
                        ? `<button class="notice-link" type="button" data-open-notice-id="${escapeHtml(sourceRow.noticeId)}">${escapeHtml(value)}</button>`''',
        '''                      : managerAssignment
                        ? `<button class="manager-assignment-trigger" type="button"
                            data-manager-assignment-customer="${escapeHtml(sourceRow.customer)}"
                            title="${escapeHtml(sourceRow.customer)} 거래처 담당자 변경">${escapeHtml(displayValue || "미지정")}</button>`
                      : noticeLink
                        ? `<button class="notice-link" type="button" data-open-notice-id="${escapeHtml(sourceRow.noticeId)}">${escapeHtml(value)}</button>`''',
        "manager assignment render content",
    )

    manager_open_listener = r'''      elements.previewTable.addEventListener("click", (event) => {
        const managerButton = event.target.closest("[data-manager-assignment-customer]");
        if (!managerButton || !state.workspace || state.activePreview !== "allocations") return;
        const customer = String(managerButton.dataset.managerAssignmentCustomer || "").trim();
        if (!customer) return;
        state.managerAssignmentCustomer = customer;
        setActiveFilterPanel("manager");
        showToast(`${customer} 거래처의 담당자를 선택하세요.`);
      });
'''
    text = exact(
        text,
        '''      elements.previewTable.addEventListener("click", (event) => {
        const trigger = event.target.closest(".column-sort-trigger[data-sort-preview-id][data-sort-column-key]");''',
        manager_open_listener + '''      elements.previewTable.addEventListener("click", (event) => {
        const trigger = event.target.closest(".column-sort-trigger[data-sort-preview-id][data-sort-column-key]");''',
        "manager assignment open listener",
    )

    # Reset/cancel any active assignment whenever a full result filter reset clears manager filters.
    text = text.replace(
        "        state.managerFilters.clear();\n",
        "        state.managerFilters.clear();\n        state.managerAssignmentCustomer = \"\";\n",
    )
    # Persist explicit full-sort resets (restore/new analysis/reset filters).
    text = text.replace(
        "        state.sortSettings = Object.create(null);\n",
        "        state.sortSettings = Object.create(null);\n        saveSortSettings();\n",
    )

    path.write_text(text, encoding="utf-8")
    print(f"patched: {path.relative_to(ROOT)}")


def patch_engine():
    text = ENGINE_FILE.read_text(encoding="utf-8")
    if 'function setCustomerManager(' in text:
        print("already patched: orderFulfillmentEngine.js")
        return
    text = exact(text, '  const ENGINE_VERSION = "3.19.0";', '  const ENGINE_VERSION = "3.20.0";', "engine version")
    function_source = r'''  function setCustomerManager(workspace, customer, manager) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    const targetCustomer = cleanText(customer);
    const nextManager = cleanText(manager);
    if (!targetCustomer) throw new Error("담당자를 변경할 거래처가 없습니다.");
    if (!nextManager) throw new Error("변경할 담당자를 선택하세요.");
    const acknowledgedIds = new Set(ensureNoticeState(workspace).acknowledgedIds);
    const acknowledgedSourceRows = new Set(
      (workspace.notices || [])
        .filter((notice) => acknowledgedIds.has(notice.noticeId))
        .map((notice) => Number(notice.sourceRowNumber))
        .filter(Number.isFinite),
    );
    const targets = (workspace.orders || []).filter((row) => cleanText(row?.customer) === targetCustomer);
    if (targets.length === 0) throw new Error("담당자를 변경할 거래처 주문을 찾지 못했습니다.");
    targets.forEach((order) => { order.manager = nextManager; });
    rebuildWorkspaceFromOrders(workspace);
    if (acknowledgedSourceRows.size > 0) {
      const noticeState = ensureNoticeState(workspace);
      const restored = new Set(noticeState.acknowledgedIds);
      (workspace.notices || []).forEach((notice) => {
        if (acknowledgedSourceRows.has(Number(notice.sourceRowNumber))) restored.add(notice.noticeId);
      });
      noticeState.acknowledgedIds = [...restored];
    }
    return workspace;
  }

'''
    text = exact(text, "  function setOrderValue(workspace, sourceRowNumber, field, value) {", function_source + "  function setOrderValue(workspace, sourceRowNumber, field, value) {", "setCustomerManager insert")
    text = exact(text, "    setOrderValue,\n    setInventoryOverride,", "    setOrderValue,\n    setCustomerManager,\n    setInventoryOverride,", "setCustomerManager export")
    ENGINE_FILE.write_text(text, encoding="utf-8")
    print("patched: orderFulfillmentEngine.js")


def patch_test():
    text = TEST_FILE.read_text(encoding="utf-8")
    if "customer manager assignment must update every order row" in text:
        print("already patched: scripts/test-shipping-management.mjs")
        return
    text = text.replace('brand-badge">v1\\.56', 'brand-badge">v1\\.57')
    text = text.replace('version must be v1.56', 'version must be v1.57')
    text = text.replace('ORDER Q v1\\.56 · 출고관리', 'ORDER Q v1\\.57 · 출고관리')
    text = text.replace('orderops-order-view-presets/v4', 'orderops-order-view-presets/v5')
    text = text.replace('const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v3"',
                        'const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v4"')

    anchor = '''  'function layeredColumnSortSettings',
  'allocations.columns[1].role = "customer"','''
    replacement = '''  'function layeredColumnSortSettings',
  'function setColumnSortSetting',
  'function applyAllocationSegmentAggregates',
  'oneapp.orderops.sort-settings.v1',
  'data-manager-assignment-customer',
  'data-manager-assignment',
  'allocations.columns[1].role = "customer"','''
    text = exact(text, anchor, replacement, "public sort/manager interaction test contracts")

    manager_test = r'''
const managerAssignmentWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const managerAssignmentCustomer = managerAssignmentWorkspace.orders[0].customer;
const managerAssignmentRows = managerAssignmentWorkspace.orders.filter(
  (row) => row.customer === managerAssignmentCustomer,
);
assert.ok(managerAssignmentRows.length >= 2, "manager assignment fixture must contain repeated customer rows");
engine.setCustomerManager(managerAssignmentWorkspace, managerAssignmentCustomer, "담당변경");
assert.ok(
  managerAssignmentWorkspace.orders
    .filter((row) => row.customer === managerAssignmentCustomer)
    .every((row) => row.manager === "담당변경"),
  "customer manager assignment must update every order row for the selected customer",
);
assert.ok(
  managerAssignmentWorkspace.allocations
    .filter((row) => row.customer === managerAssignmentCustomer)
    .every((row) => row.manager === "담당변경"),
  "customer manager assignment must rebuild allocation rows with the selected manager",
);
'''
    marker = 'const linkedPurchaseWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);'
    text = exact(text, marker, manager_test + "\n" + marker, "manager assignment engine test")
    TEST_FILE.write_text(text, encoding="utf-8")
    print("patched: scripts/test-shipping-management.mjs")


for html_file in HTML_FILES:
    patch_html(html_file)
patch_engine()
patch_test()
