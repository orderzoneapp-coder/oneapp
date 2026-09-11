(function initNexusWorkbenchLayoutV2() {
  'use strict';

  const CONFIG = Object.freeze({
    'master-lookup': { left: 260, right: 260, leftMin: 220, leftMax: 430, rightMin: 220, rightMax: 420, centerMin: 640 },
    'customer-master': { left: 240, right: 270, leftMin: 210, leftMax: 390, rightMin: 220, rightMax: 420, centerMin: 620 },
    'smart-parser': { left: 250, right: 270, leftMin: 220, leftMax: 420, rightMin: 220, rightMax: 430, centerMin: 700 },
    merchops: { left: 250, right: 270, leftMin: 220, leftMax: 420, rightMin: 220, rightMax: 430, centerMin: 720 },
    dataops: { left: 250, right: 270, leftMin: 220, leftMax: 420, rightMin: 220, rightMax: 430, centerMin: 720 },
    orderops: { left: 380, right: 280, leftMin: 320, leftMax: 520, rightMin: 250, rightMax: 420, centerMin: 620 }
  });
  const layouts = new WeakMap();
  const safeNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const storageKey = (appId) => `nexus:workbench-layout:${appId}:v2`;

  function readPreference(appId, config) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(appId)) || 'null');
      return {
        left: clamp(safeNumber(saved?.left, config.left), config.leftMin, config.leftMax),
        right: clamp(safeNumber(saved?.right, config.right), config.rightMin, config.rightMax)
      };
    } catch (_) {
      return { left: config.left, right: config.right };
    }
  }

  function savePreference(layout) {
    try {
      localStorage.setItem(storageKey(layout.appId), JSON.stringify({ schemaVersion: 2, left: layout.preference.left, right: layout.preference.right }));
    } catch (_) {}
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.matches('.related-panel')) return element.classList.contains('is-open');
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function isPaneRequestedOpen(element) {
    if (!element || !element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.matches('.related-panel')) return element.classList.contains('is-open');
    return true;
  }

  function currentLimits(layout, side) {
    const { workspace, config, preference } = layout;
    const width = workspace.getBoundingClientRect().width;
    const gap = 24;
    const rightOpen = isPaneRequestedOpen(layout.rightPane);
    const other = side === 'left' ? (rightOpen ? preference.right : 0) : preference.left;
    const minimum = side === 'left' ? config.leftMin : config.rightMin;
    const configuredMax = side === 'left' ? config.leftMax : config.rightMax;
    const availableMax = Math.max(minimum, width - config.centerMin - other - gap);
    return { minimum, maximum: Math.min(configuredMax, availableMax) };
  }

  function applyPreference(layout) {
    const leftLimit = currentLimits(layout, 'left');
    const rightLimit = currentLimits(layout, 'right');
    const renderedLeft = clamp(layout.preference.left, leftLimit.minimum, leftLimit.maximum);
    const renderedRight = clamp(layout.preference.right, rightLimit.minimum, rightLimit.maximum);
    layout.workspace.style.setProperty('--nexus-left-pane-width', `${renderedLeft}px`);
    layout.workspace.style.setProperty('--nexus-right-pane-width', `${renderedRight}px`);
    layout.workspace.style.setProperty('--nexus-center-pane-min', `${layout.config.centerMin}px`);
    if (layout.leftHandle) {
      layout.leftHandle.setAttribute('aria-valuemin', String(leftLimit.minimum));
      layout.leftHandle.setAttribute('aria-valuemax', String(leftLimit.maximum));
      layout.leftHandle.setAttribute('aria-valuenow', String(Math.round(renderedLeft)));
    }
    if (layout.rightHandle) {
      layout.rightHandle.setAttribute('aria-valuemin', String(rightLimit.minimum));
      layout.rightHandle.setAttribute('aria-valuemax', String(rightLimit.maximum));
      layout.rightHandle.setAttribute('aria-valuenow', String(Math.round(renderedRight)));
    }
  }

  function positionHandles(layout) {
    const { workspace, leftPane, rightPane, leftHandle, rightHandle } = layout;
    if (!workspace.isConnected || !isVisible(workspace) || matchMedia('(max-width: 960px)').matches) {
      leftHandle.hidden = true;
      rightHandle.hidden = true;
      return;
    }
    applyPreference(layout);
    const workspaceRect = workspace.getBoundingClientRect();
    const leftRect = leftPane.getBoundingClientRect();
    const rightOpen = isPaneRequestedOpen(rightPane);
    workspace.dataset.nexusRightOpen = String(rightOpen);
    const top = Math.max(workspaceRect.top, 0);
    const bottom = Math.min(workspaceRect.bottom, innerHeight);
    const height = Math.max(bottom - top, 0);
    leftHandle.hidden = height < 80;
    leftHandle.style.left = `${leftRect.right + 6 - 9}px`;
    leftHandle.style.top = `${top}px`;
    leftHandle.style.height = `${height}px`;
    rightHandle.hidden = !rightOpen || height < 80;
    if (rightOpen) {
      const rightRect = rightPane.getBoundingClientRect();
      rightHandle.style.left = `${rightRect.left - 6 - 9}px`;
      rightHandle.style.top = `${top}px`;
      rightHandle.style.height = `${height}px`;
    }
  }

  function setWidth(layout, side, value, persist) {
    const limits = currentLimits(layout, side);
    layout.preference[side] = clamp(Math.round(value), limits.minimum, limits.maximum);
    applyPreference(layout);
    positionHandles(layout);
    if (persist) savePreference(layout);
  }

  function bindHandle(layout, handle, side) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = layout.preference[side];
      handle.setPointerCapture(event.pointerId);
      handle.dataset.resizing = 'true';
      document.body.classList.add('nexus-pane-resizing-v2');
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        setWidth(layout, side, startWidth + (side === 'left' ? delta : -delta), false);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        delete handle.dataset.resizing;
        document.body.classList.remove('nexus-pane-resizing-v2');
        savePreference(layout);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const limits = currentLimits(layout, side);
      if (event.key === 'Home') return setWidth(layout, side, limits.minimum, true);
      if (event.key === 'End') return setWidth(layout, side, limits.maximum, true);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const change = side === 'left' ? direction * 12 : direction * -12;
      setWidth(layout, side, layout.preference[side] + change, true);
    });
  }

  function createHandle(layout, side, pane) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'nexus-pane-resizer-v2';
    handle.dataset.nexusPaneResize = side;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `${side === 'left' ? '좌측 보조' : '우측 다음 단계'} 패널 폭 조절`);
    handle.title = '끌어서 폭 조절 · 방향키 12px · Home 최소 · End 최대';
    if (!pane.id) pane.id = `nexus-${layout.appId}-${side}-pane`;
    handle.setAttribute('aria-controls', pane.id);
    document.body.appendChild(handle);
    bindHandle(layout, handle, side);
    return handle;
  }

  function cellValue(cell) {
    const controls = [...cell.querySelectorAll('input, select, textarea')]
      .map((control) => control.tagName === 'SELECT' ? control.selectedOptions?.[0]?.textContent : control.value)
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const text = String(cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
    return [...new Set([...controls, text].filter(Boolean))].join(' · ');
  }

  function renderSelectionReference(workspace, row) {
    const host = workspace.querySelector('[data-nexus-selection-reference]');
    if (!host || !row) return;
    const table = row.closest('table');
    const headings = [...(table?.querySelectorAll('thead tr:last-child th') || [])]
      .map((heading) => String(heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim());
    const values = [...row.children].map((cell, index) => ({ label: headings[index] || `열 ${index + 1}`, value: cellValue(cell) }))
      .filter((entry) => entry.value)
      .slice(0, 8);
    host.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('p');
      empty.className = 'nexus-selection-reference__empty';
      empty.textContent = '선택한 행에서 표시할 참고값이 없습니다.';
      host.appendChild(empty);
      return;
    }
    values.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'nexus-selection-reference__item';
      const term = document.createElement('dt');
      term.textContent = entry.label;
      const description = document.createElement('dd');
      description.textContent = entry.value;
      item.append(term, description);
      host.appendChild(item);
    });
  }

  function ensureWorkspace(workspace) {
    const existing = layouts.get(workspace);
    if (existing) {
      const nextLeftPane = workspace.querySelector(':scope > [data-nexus-pane="reference"]');
      const nextWorkPane = workspace.querySelector(':scope > [data-nexus-pane="work"]');
      const nextRightPane = workspace.querySelector(':scope > [data-nexus-pane="result"]');
      if (nextLeftPane) existing.leftPane = nextLeftPane;
      if (nextWorkPane) existing.workPane = nextWorkPane;
      if (nextRightPane && nextRightPane !== existing.rightPane) {
        existing.rightPane = nextRightPane;
        if (!nextRightPane.id) nextRightPane.id = `nexus-${existing.appId}-right-pane`;
        existing.rightHandle.setAttribute('aria-controls', nextRightPane.id);
      }
      return existing;
    }
    const appId = String(workspace.dataset.nexusWorkspace || '').trim();
    const config = CONFIG[appId];
    if (!config) return null;
    const leftPane = workspace.querySelector(':scope > [data-nexus-pane="reference"]');
    const workPane = workspace.querySelector(':scope > [data-nexus-pane="work"]');
    const rightPane = workspace.querySelector(':scope > [data-nexus-pane="result"]');
    if (!leftPane || !workPane) return null;
    const layout = { appId, config, workspace, leftPane, workPane, rightPane, preference: readPreference(appId, config) };
    workspace.dataset.nexusResizableWorkspace = 'true';
    layout.leftHandle = createHandle(layout, 'left', leftPane);
    layout.rightHandle = createHandle(layout, 'right', rightPane || workPane);
    layouts.set(workspace, layout);
    workspace.addEventListener('click', (event) => {
      const row = event.target.closest('[data-nexus-pane="work"] table tbody tr');
      if (row && workspace.contains(row)) renderSelectionReference(workspace, row);
    });
    workspace.addEventListener('focusin', (event) => {
      const row = event.target.closest('[data-nexus-pane="work"] table tbody tr');
      if (row && workspace.contains(row)) renderSelectionReference(workspace, row);
    });
    new ResizeObserver(() => positionHandles(layout)).observe(workspace);
    positionHandles(layout);
    return layout;
  }

  function refresh() {
    document.querySelectorAll('[data-nexus-workspace]').forEach(ensureWorkspace);
    document.querySelectorAll('[data-nexus-workspace]').forEach((workspace) => {
      const layout = layouts.get(workspace);
      if (layout) positionHandles(layout);
    });
  }

  const scheduleRefresh = (() => {
    let frame = 0;
    return () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
  })();
  const start = () => {
    refresh();
    new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class'] });
    addEventListener('resize', scheduleRefresh, { passive: true });
    addEventListener('scroll', scheduleRefresh, { passive: true, capture: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
