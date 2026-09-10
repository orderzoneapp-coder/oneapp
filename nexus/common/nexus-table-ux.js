(function initNexusTableUx() {
  'use strict';

  const MIN_WIDTH = 52;
  const MAX_WIDTH = 640;
  const resizeExcludedApps = new Set(['smart-input', 'orderops', 'merchops', 'dataops']);
  const selectedRows = new Map();
  const tableStates = new WeakMap();
  const listenedTables = new WeakSet();
  let activeMenu = null;
  let popover = null;
  let frame = 0;

  const clamp = (value) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(value) || MIN_WIDTH)));
  const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalized = (value) => text(value).toLocaleLowerCase('ko-KR');

  function appId() {
    return document.documentElement.dataset.nexusUiApp || document.documentElement.dataset.nexusAppId || 'nexus';
  }

  function headerLabel(header) {
    const clone = header.cloneNode(true);
    clone.querySelectorAll('.nexus-common-column-resize, .nexus-table-column-tool').forEach((node) => node.remove());
    return text(clone.textContent);
  }

  function tableIdentity(table) {
    const headings = [...table.querySelectorAll('thead tr:last-child th')].map(headerLabel).join('|');
    const region = table.closest('[aria-label], [id]');
    const regionLabel = region && region !== table ? (region.getAttribute('aria-label') || region.id) : '';
    const label = table.id || table.getAttribute('aria-label') || `${regionLabel}|${headings}` || 'table';
    let hash = 2166136261;
    for (const character of `${location.pathname}|${appId()}|${label}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `nexus:table-widths:${appId()}:${(hash >>> 0).toString(36)}:v1`;
  }

  function stateFor(table) {
    if (!tableStates.has(table)) {
      tableStates.set(table, {
        query: '',
        filters: new Map(),
        sort: null,
        originalRanks: new WeakMap(),
        nextOriginalRank: 0,
      });
    }
    return tableStates.get(table);
  }

  function storedWidths(table, count) {
    try {
      const value = JSON.parse(localStorage.getItem(tableIdentity(table)) || 'null');
      if (value?.schemaVersion !== 1 || !Array.isArray(value.widths) || value.widths.length !== count) return null;
      return value.widths.map(clamp);
    } catch (_) {
      return null;
    }
  }

  function saveWidths(table, widths) {
    try { localStorage.setItem(tableIdentity(table), JSON.stringify({ schemaVersion: 1, widths: widths.map(clamp) })); } catch (_) {}
  }

  function applyWidths(table, widths) {
    const cols = [...table.querySelectorAll(':scope > colgroup > col')];
    if (cols.length !== widths.length) return;
    cols.forEach((col, index) => { col.style.width = `${clamp(widths[index])}px`; });
    table.style.width = `${widths.reduce((sum, width) => sum + clamp(width), 0)}px`;
  }

  function canResize(table, headers) {
    if (resizeExcludedApps.has(appId()) || table.dataset.nexusCommonResize === 'off' ||
      (hasReactOwner(table) && table.dataset.nexusCommonTools !== 'on')) return false;
    if (table.querySelector('.column-resize-handle, .nexus-common-column-resize')) return false;
    if (headers.length < 2 || table.querySelector('thead [colspan], thead [rowspan]')) return false;
    return true;
  }

  function installResize(table, headers) {
    if (!canResize(table, headers)) return;
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      headers.forEach(() => colgroup.appendChild(document.createElement('col')));
      table.insertBefore(colgroup, table.firstChild);
    }
    if (colgroup.children.length !== headers.length) return;
    table.classList.add('nexus-table-common-widths');
    const measured = headers.map((header) => clamp(header.getBoundingClientRect().width || header.offsetWidth || 120));
    const initial = storedWidths(table, headers.length) || measured;
    applyWidths(table, initial);
    headers.forEach((header, index) => {
      if (header.querySelector(':scope > .nexus-common-column-resize')) return;
      header.style.position = 'sticky';
      const handle = document.createElement('span');
      handle.className = 'nexus-common-column-resize';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', `${headerLabel(header) || `${index + 1}열`} 열 너비 조절`);
      handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
      handle.setAttribute('aria-valuemax', String(MAX_WIDTH));
      handle.setAttribute('aria-valuenow', String(initial[index]));
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const widths = [...table.querySelectorAll(':scope > colgroup > col')].map((col) => clamp(parseFloat(col.style.width)));
        const startWidth = widths[index];
        handle.setPointerCapture(event.pointerId);
        handle.dataset.resizing = 'true';
        const move = (moveEvent) => {
          widths[index] = clamp(startWidth + moveEvent.clientX - startX);
          applyWidths(table, widths);
          handle.setAttribute('aria-valuenow', String(widths[index]));
        };
        const finish = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          delete handle.dataset.resizing;
          saveWidths(table, widths);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      });
      handle.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const widths = [...table.querySelectorAll(':scope > colgroup > col')].map((col) => clamp(parseFloat(col.style.width)));
        widths[index] = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH
          : clamp(widths[index] + (event.key === 'ArrowRight' ? 12 : -12));
        applyWidths(table, widths);
        handle.setAttribute('aria-valuenow', String(widths[index]));
        saveWidths(table, widths);
      });
      header.appendChild(handle);
    });
  }

  function cellText(cell) {
    if (!cell) return '';
    const controls = [...cell.querySelectorAll('input, select, textarea')].map((control) => (
      control.tagName === 'SELECT' ? control.selectedOptions?.[0]?.textContent : control.value
    )).map(text).filter(Boolean);
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.nexus-common-column-resize, .nexus-table-column-tool, input, select, textarea').forEach((node) => node.remove());
    return text([text(clone.textContent), ...controls].filter(Boolean).join(' '));
  }

  function rowCopyText(row) {
    return [...row.cells].map(cellText).join('\t');
  }

  function rowIdentity(row) {
    return row.dataset.gridRowKey || row.dataset.rowId || row.dataset.productCode ||
      row.dataset.customerId || [...row.cells].slice(0, 3).map(cellText).join('|');
  }

  function isDataRow(row) {
    return row.cells.length > 0 && !row.querySelector('.empty-table-cell') &&
      !row.classList.contains('nexus-table-generated-status');
  }

  function dataRows(table) {
    return [...table.tBodies].flatMap((body) => [...body.rows].filter(isDataRow));
  }

  function compareValues(left, right, heading) {
    const a = text(left);
    const b = text(right);
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const compactA = a.replace(/[\s,]/g, '');
    const compactB = b.replace(/[\s,]/g, '');
    const numericPattern = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:%|원|개|건|ea|box)?$/i;
    const leadingCode = /^0\d/.test(compactA) || /^0\d/.test(compactB);
    if (!leadingCode && numericPattern.test(compactA) && numericPattern.test(compactB)) {
      return parseFloat(compactA) - parseFloat(compactB);
    }
    if (/(일자|날짜|일시|시각|date|time)/i.test(heading)) {
      const dateA = Date.parse(a);
      const dateB = Date.parse(b);
      if (Number.isFinite(dateA) && Number.isFinite(dateB)) return dateA - dateB;
    }
    return a.localeCompare(b, 'ko-KR', { numeric: true, sensitivity: 'base' });
  }

  function ensureOriginalRanks(state, rows) {
    rows.forEach((row) => {
      if (!state.originalRanks.has(row)) state.originalRanks.set(row, state.nextOriginalRank++);
    });
  }

  function reorderRows(table, state, headers) {
    [...table.tBodies].forEach((body) => {
      const rows = [...body.rows].filter(isDataRow);
      ensureOriginalRanks(state, rows);
      const desired = [...rows];
      if (state.sort) {
        const { index, direction } = state.sort;
        const heading = headerLabel(headers[index] || document.createElement('th'));
        desired.sort((a, b) => {
          const result = compareValues(cellText(a.cells[index]), cellText(b.cells[index]), heading);
          return result === 0
            ? state.originalRanks.get(a) - state.originalRanks.get(b)
            : result * (direction === 'desc' ? -1 : 1);
        });
      } else {
        desired.sort((a, b) => state.originalRanks.get(a) - state.originalRanks.get(b));
      }
      if (desired.some((row, index) => row !== rows[index])) desired.forEach((row) => body.appendChild(row));
    });
  }

  function applyNumericAlignment(table, headers) {
    const rows = dataRows(table).slice(0, 40);
    headers.forEach((header, index) => {
      const heading = headerLabel(header);
      const cells = rows.map((row) => row.cells[index]).filter(Boolean);
      const values = cells.map(cellText).filter(Boolean);
      const semantic = /(수량|금액|단가|가격|재고|잔량|합계|건수|비율|세액|공급가|입고가|출고가|number|amount|price|qty|quantity|stock)/i.test(heading);
      const numericCount = values.filter((value) => /^[-+]?\d[\d,.]*(?:%|원|개|건|ea|box)?$/i.test(value.replace(/\s/g, '')) && !/^0\d/.test(value)).length;
      const numeric = semantic || (values.length > 0 && numericCount / values.length >= 0.8);
      cells.forEach((cell) => cell.classList.toggle('nexus-table-numeric', numeric));
    });
  }

  function updateToolStates(table, state) {
    table.querySelectorAll('.nexus-table-column-tool').forEach((button) => {
      const index = Number(button.dataset.columnIndex);
      const active = Boolean(state.query || state.filters.has(index) || state.sort?.index === index);
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyView(table) {
    if (!table.isConnected) return;
    const state = stateFor(table);
    const headers = [...table.querySelectorAll('thead tr:last-child th')];
    reorderRows(table, state, headers);
    const rows = dataRows(table);
    let visibleCount = 0;
    rows.forEach((row) => {
      const queryMatch = !state.query || normalized([...row.cells].map(cellText).join(' ')).includes(normalized(state.query));
      const filterMatch = [...state.filters].every(([index, selected]) => selected.has(normalized(cellText(row.cells[index]))));
      const visible = queryMatch && filterMatch;
      row.classList.toggle('nexus-table-filtered-out', !visible);
      if (visible) visibleCount += 1;
    });
    const active = Boolean(state.query || state.filters.size);
    table.classList.toggle('nexus-table-no-results', active && rows.length > 0 && visibleCount === 0);
    table.dataset.nexusVisibleRows = String(visibleCount);
    table.dataset.nexusTotalRows = String(rows.length);
    table.dataset.nexusEmptyReason = rows.length === 0 ? 'source' : (visibleCount === 0 ? 'filter' : '');
    applyNumericAlignment(table, headers);
    updateToolStates(table, state);
    if (activeMenu?.table === table) updatePopoverStatus();
  }

  function tableHasNativeColumnTools(table) {
    return table.dataset.nexusCommonTools === 'off' || table.closest('.print-area') ||
      (hasReactOwner(table) && table.dataset.nexusCommonTools !== 'on') ||
      table.matches('.column-width-managed') || Boolean(table.querySelector('.column-sort-trigger'));
  }

  function hasReactOwner(table) {
    return Boolean(table.closest('#root')) && ['master-lookup', 'smart-parser', 'merchops', 'dataops'].includes(appId());
  }

  function installTools(table, headers) {
    if (tableHasNativeColumnTools(table) || !headers.length || table.querySelector('thead [colspan], thead [rowspan]')) return;
    headers.forEach((header, index) => {
      if (header.querySelector(':scope > .nexus-table-column-tool')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nexus-table-column-tool';
      button.dataset.columnIndex = String(index);
      button.textContent = '';
      button.title = '표 검색·열 필터·정렬';
      button.setAttribute('aria-label', `${headerLabel(header) || `${index + 1}열`} 검색·필터·정렬`);
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPopover(table, index, button);
      });
      header.appendChild(button);
    });
  }

  function selectRow(table, row) {
    table.querySelectorAll('tbody tr[aria-selected="true"]').forEach((candidate) => candidate.setAttribute('aria-selected', 'false'));
    if (!row) {
      selectedRows.delete(tableIdentity(table));
      delete table.dataset.nexusSelectedRow;
      return;
    }
    row.setAttribute('aria-selected', 'true');
    const identity = rowIdentity(row) || String(row.rowIndex);
    table.dataset.nexusSelectedRow = identity;
    selectedRows.set(tableIdentity(table), identity);
  }

  function visibleRows(table) {
    return dataRows(table).filter((row) => !row.classList.contains('nexus-table-filtered-out') && !row.hidden);
  }

  function installTableListeners(table) {
    if (listenedTables.has(table)) return;
    listenedTables.add(table);
    if (!table.hasAttribute('tabindex')) table.tabIndex = 0;
    table.addEventListener('click', (event) => {
      if (event.target.closest('.nexus-table-column-tool, .nexus-common-column-resize')) return;
      const row = event.target.closest('tbody tr');
      if (!row || !table.contains(row) || !isDataRow(row)) return;
      selectRow(table, row);
    });
    table.addEventListener('keydown', (event) => {
      const editing = event.target.closest('input, textarea, select, button, [contenteditable="true"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (editing || text(getSelection()?.toString())) return;
        const row = table.querySelector('tbody tr[aria-selected="true"]');
        if (!row || !navigator.clipboard?.writeText) return;
        event.preventDefault();
        navigator.clipboard.writeText(rowCopyText(row)).catch(() => {});
        return;
      }
      if (editing || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      const rows = visibleRows(table);
      const selected = table.querySelector('tbody tr[aria-selected="true"]');
      if (event.key === 'Escape') {
        if (!selected) return;
        event.preventDefault();
        selectRow(table, null);
        return;
      }
      if (event.key === 'Enter') {
        const control = selected?.querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [contenteditable="true"]');
        if (control) {
          event.preventDefault();
          control.focus();
        }
        return;
      }
      if (!rows.length) return;
      event.preventDefault();
      const current = rows.indexOf(selected);
      const next = event.key === 'ArrowDown'
        ? rows[Math.min(rows.length - 1, current < 0 ? 0 : current + 1)]
        : rows[Math.max(0, current < 0 ? rows.length - 1 : current - 1)];
      selectRow(table, next);
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    table.addEventListener('input', () => {
      const state = stateFor(table);
      if (state.query || state.filters.size || state.sort) requestAnimationFrame(() => applyView(table));
    });
    table.addEventListener('change', () => {
      const state = stateFor(table);
      if (state.query || state.filters.size || state.sort) requestAnimationFrame(() => applyView(table));
    });
  }

  function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement('section');
    popover.className = 'nexus-table-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-labelledby', 'nexusTablePopoverTitle');
    popover.innerHTML = `
      <h2 id="nexusTablePopoverTitle">표 검색·필터·정렬</h2>
      <p class="nexus-table-popover__scope"></p>
      <label for="nexusTableGlobalSearch">현재 표 검색</label>
      <input id="nexusTableGlobalSearch" type="search" autocomplete="off" placeholder="현재 표 전체 열 검색">
      <label>현재 열 정렬</label>
      <div class="nexus-table-popover__sort">
        <button type="button" data-sort="asc">오름차순</button>
        <button type="button" data-sort="desc">내림차순</button>
        <button type="button" data-sort="none">정렬 해제</button>
      </div>
      <label for="nexusTableValueSearch">현재 열 값 찾기</label>
      <input id="nexusTableValueSearch" type="search" autocomplete="off" placeholder="필터 값 검색">
      <div class="nexus-table-popover__values" role="group" aria-label="표시할 값"></div>
      <span class="nexus-table-popover__status" role="status" aria-live="polite"></span>
      <div class="nexus-table-popover__actions">
        <button type="button" data-clear-column>현재 열 해제</button>
        <button type="button" data-reset-all>전체 해제</button>
        <button type="button" data-apply-values>적용</button>
        <button type="button" data-close-popover>닫기</button>
      </div>`;
    document.body.appendChild(popover);
    popover.querySelector('#nexusTableGlobalSearch').addEventListener('input', (event) => {
      if (!activeMenu) return;
      stateFor(activeMenu.table).query = event.target.value;
      applyView(activeMenu.table);
    });
    popover.querySelector('#nexusTableValueSearch').addEventListener('input', (event) => renderValueOptions(event.target.value));
    popover.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
      if (!activeMenu) return;
      const state = stateFor(activeMenu.table);
      const direction = button.dataset.sort;
      state.sort = direction === 'none' ? null : { index: activeMenu.index, direction };
      applyView(activeMenu.table);
      renderPopoverControls();
    }));
    popover.querySelector('[data-apply-values]').addEventListener('click', () => {
      if (!activeMenu) return;
      const state = stateFor(activeMenu.table);
      const checks = [...popover.querySelectorAll('.nexus-table-popover__values input[type="checkbox"]')];
      const allValues = uniqueColumnValues(activeMenu.table, activeMenu.index).map((entry) => entry.key);
      const selected = new Set(checks.filter((input) => input.checked).map((input) => input.dataset.value));
      if (selected.size === allValues.length && allValues.every((value) => selected.has(value))) state.filters.delete(activeMenu.index);
      else state.filters.set(activeMenu.index, selected);
      applyView(activeMenu.table);
      renderPopoverControls();
    });
    popover.querySelector('[data-clear-column]').addEventListener('click', () => {
      if (!activeMenu) return;
      const state = stateFor(activeMenu.table);
      state.filters.delete(activeMenu.index);
      if (state.sort?.index === activeMenu.index) state.sort = null;
      applyView(activeMenu.table);
      renderPopoverControls();
      renderValueOptions(popover.querySelector('#nexusTableValueSearch').value);
    });
    popover.querySelector('[data-reset-all]').addEventListener('click', () => {
      if (!activeMenu) return;
      const state = stateFor(activeMenu.table);
      state.query = '';
      state.filters.clear();
      state.sort = null;
      applyView(activeMenu.table);
      popover.querySelector('#nexusTableGlobalSearch').value = '';
      popover.querySelector('#nexusTableValueSearch').value = '';
      renderValueOptions('');
      renderPopoverControls();
    });
    popover.querySelector('[data-close-popover]').addEventListener('click', closePopover);
    document.addEventListener('pointerdown', (event) => {
      if (!activeMenu || popover.contains(event.target) || activeMenu.button.contains(event.target)) return;
      closePopover();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && activeMenu) closePopover();
    });
    window.addEventListener('resize', () => activeMenu && positionPopover(activeMenu.button));
    window.addEventListener('scroll', () => activeMenu && positionPopover(activeMenu.button), true);
    return popover;
  }

  function uniqueColumnValues(table, index) {
    const values = new Map();
    dataRows(table).forEach((row) => {
      const label = cellText(row.cells[index]);
      const key = normalized(label);
      if (!values.has(key)) values.set(key, label);
    });
    return [...values].map(([key, label]) => ({ key, label })).sort((a, b) => compareValues(a.label, b.label, ''));
  }

  function renderValueOptions(valueSearch = '') {
    if (!activeMenu) return;
    const state = stateFor(activeMenu.table);
    const entries = uniqueColumnValues(activeMenu.table, activeMenu.index);
    const filter = normalized(valueSearch);
    const selected = state.filters.get(activeMenu.index);
    const box = popover.querySelector('.nexus-table-popover__values');
    box.replaceChildren();
    entries.filter((entry) => !filter || normalized(entry.label).includes(filter)).forEach((entry) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.value = entry.key;
      input.checked = !selected || selected.has(entry.key);
      const span = document.createElement('span');
      span.textContent = entry.label || '(빈값)';
      label.append(input, span);
      box.appendChild(label);
    });
    if (!box.children.length) {
      const empty = document.createElement('span');
      empty.textContent = entries.length ? '일치하는 필터 값이 없습니다.' : '표시할 값이 없습니다.';
      box.appendChild(empty);
    }
  }

  function updatePopoverStatus() {
    if (!activeMenu || !popover) return;
    const table = activeMenu.table;
    popover.querySelector('.nexus-table-popover__status').textContent =
      `표시 ${table.dataset.nexusVisibleRows || 0} / 전체 ${table.dataset.nexusTotalRows || 0}행`;
  }

  function renderPopoverControls() {
    if (!activeMenu) return;
    const state = stateFor(activeMenu.table);
    popover.querySelectorAll('[data-sort]').forEach((button) => {
      const pressed = button.dataset.sort === 'none' ? !state.sort :
        state.sort?.index === activeMenu.index && state.sort.direction === button.dataset.sort;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
    updatePopoverStatus();
  }

  function positionPopover(button) {
    if (!popover || popover.hidden || !button.isConnected) return;
    const rect = button.getBoundingClientRect();
    const width = popover.offsetWidth || 330;
    const height = popover.offsetHeight || 520;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 6);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function openPopover(table, index, button) {
    ensurePopover();
    if (activeMenu?.button) activeMenu.button.setAttribute('aria-expanded', 'false');
    activeMenu = { table, index, button };
    button.setAttribute('aria-expanded', 'true');
    const headers = [...table.querySelectorAll('thead tr:last-child th')];
    const name = table.getAttribute('aria-label') || table.id || '현재 표';
    popover.querySelector('.nexus-table-popover__scope').textContent = `${name} · ${headerLabel(headers[index]) || `${index + 1}열`}`;
    popover.querySelector('#nexusTableGlobalSearch').value = stateFor(table).query;
    popover.querySelector('#nexusTableValueSearch').value = '';
    popover.hidden = false;
    renderValueOptions('');
    renderPopoverControls();
    positionPopover(button);
    popover.querySelector('#nexusTableGlobalSearch').focus();
  }

  function closePopover() {
    if (!activeMenu || !popover) return;
    const button = activeMenu.button;
    button.setAttribute('aria-expanded', 'false');
    activeMenu = null;
    popover.hidden = true;
    if (button.isConnected) button.focus();
  }

  function decorate(table) {
    if (!(table instanceof HTMLTableElement) || table.dataset.nexusTableUx === 'off' || table.closest('.print-area')) return;
    if (hasReactOwner(table) && table.dataset.nexusCommonTools !== 'on') return;
    table.classList.add('nexus-table-ux');
    const restoredSelection = selectedRows.get(tableIdentity(table));
    if (restoredSelection && !table.querySelector('tbody tr[aria-selected="true"]')) {
      dataRows(table).find((row) => rowIdentity(row) === restoredSelection)?.setAttribute('aria-selected', 'true');
    }
    installTableListeners(table);
    const headers = [...table.querySelectorAll('thead tr:last-child th')];
    installResize(table, headers);
    installTools(table, headers);
    applyView(table);
  }

  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (activeMenu && (!activeMenu.table.isConnected || !activeMenu.button.isConnected)) closePopover();
      document.querySelectorAll('table').forEach(decorate);
    });
  }

  function start() {
    ensurePopover();
    refresh();
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
