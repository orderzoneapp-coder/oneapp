(function (root) {
  'use strict';

  const api = root.NEXUS_FOUNDATION;
  if (!api) return;
  const text = value => String(value ?? '').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const changeId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function hasWritePermission() {
    return Boolean(root.ONEAPP_AUTH && root.ONEAPP_AUTH.hasPermission && root.ONEAPP_AUTH.hasPermission('foundation.write'));
  }

  function mount(container, options) {
    if (!container) throw new Error('FOUNDATION_METADATA_UI_CONTAINER_REQUIRED');
    const state = {
      entityType: text(options && options.entityType).toUpperCase() === 'CUSTOMER' ? 'CUSTOMER' : 'PRODUCT',
      metadata: null,
      phase: 'LOADING',
      tab: 'FIELDS',
      search: '',
      fieldChanges: new Map(),
      message: '',
      preview: null,
      legacyPreview: null,
      destroyed: false
    };

    const writeAllowed = () => hasWritePermission() && state.metadata && !state.metadata.readOnly;
    const currentSet = () => {
      const selected = text(container.querySelector('[data-foundation-set-select]')?.value);
      return (state.metadata?.mappingSets || []).find(set => set.mappingSetId === selected) || null;
    };
    const mappingsForSet = set => set ? (state.metadata?.mappings || []).filter(mapping => mapping.mappingSetId === set.mappingSetId) : [];

    function phaseLabel() {
      if (state.phase === 'LOADING') return '서버 메타데이터 조회 중';
      if (state.phase === 'READY') return `서버 revision ${Number(state.metadata?.metadataRevision || 0)}`;
      if (state.phase === 'DIRTY') return `로컬 변경 ${state.fieldChanges.size}건`;
      if (state.phase === 'SAVING') return '저장 중';
      if (state.phase === 'CONFLICT') return '동시 수정 충돌';
      if (state.phase === 'READ_ONLY_CACHE') return '마지막 정상본 · 읽기 전용';
      return '오류';
    }

    function fieldRows() {
      const query = state.search.toLocaleLowerCase('ko-KR');
      return (state.metadata?.fields || [])
        .filter(field => field.entityType === state.entityType)
        .filter(field => !query || [field.displayName, field.fieldId, field.storageKey, ...(field.legacyAliases || [])].join(' ').toLocaleLowerCase('ko-KR').includes(query))
        .sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder) || left.fieldId.localeCompare(right.fieldId));
    }

    function renderFields() {
      const disabled = writeAllowed() ? '' : 'disabled';
      const rows = fieldRows().map(field => {
        const pending = state.fieldChanges.get(field.fieldId) || {};
        const displayName = pending.displayName === undefined ? field.displayName : pending.displayName;
        const sortOrder = pending.sortOrder === undefined ? field.sortOrder : pending.sortOrder;
        const enabled = pending.enabled === undefined ? field.enabled : pending.enabled;
        const requirements = Object.entries(field.requirements || {}).filter(([, value]) => value).map(([key]) => ({
          createRequired: '등록 필수', batchIdentifier: '일괄 식별자', completenessRequired: '정보완료'
        })[key]).filter(Boolean).join(' · ') || '선택';
        return `<tr data-foundation-field-row="${escapeHtml(field.fieldId)}">
          <td><input data-field-display-name value="${escapeHtml(displayName)}" ${disabled}></td>
          <td><strong>${escapeHtml(field.fieldId)}</strong><small>${escapeHtml(field.storageKey)}${(field.writeMirrorKeys || []).length ? ` · mirror ${escapeHtml(field.writeMirrorKeys.join(', '))}` : ''}</small></td>
          <td><span>${escapeHtml(field.dataType)}</span><small>${escapeHtml(requirements)}</small></td>
          <td><input data-field-sort-order type="number" value="${Number(sortOrder)}" ${disabled}></td>
          <td><label class="foundation-switch"><input data-field-enabled type="checkbox" ${enabled ? 'checked' : ''} ${field.protectedFromDisable || disabled ? 'disabled' : ''}><span>${enabled ? '사용' : '중지'}</span></label></td>
          <td>${field.systemField
            ? `<small>${escapeHtml((field.legacyAliases || []).join(', ') || '별칭 없음')}</small>`
            : `<input data-field-aliases value="${escapeHtml((pending.legacyAliases || field.legacyAliases || []).join(', '))}" placeholder="쉼표로 헤더 별칭 구분" ${disabled}>`}</td>
        </tr>`;
      }).join('');
      return `<section class="foundation-panel">
        <div class="foundation-panel-head"><div><strong>항목 관리</strong><span>표시명·순서·매핑 사용 상태를 관리합니다.</span></div>
          <label>검색<input data-foundation-search value="${escapeHtml(state.search)}" placeholder="표시명, fieldId, 저장 키"></label></div>
        <div class="foundation-table-wrap"><table><thead><tr><th>표시명</th><th>영구 ID / 저장 키</th><th>형식 / 요건</th><th>순서</th><th>상태</th><th>시스템 별칭</th></tr></thead><tbody>${rows || '<tr><td colspan="6">검색 결과가 없습니다.</td></tr>'}</tbody></table></div>
      </section>`;
    }

    function mappingSetOptions() {
      return (state.metadata?.mappingSets || []).filter(set => set.entityType === state.entityType)
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name, 'ko'))
        .map(set => `<option value="${escapeHtml(set.mappingSetId)}">${set.isDefault ? '★ ' : ''}${escapeHtml(set.name)} · ${escapeHtml(set.sourceSystem)}${set.enabled ? '' : ' · 중지'}</option>`).join('');
    }

    function renderMappingPreview() {
      if (!state.preview) return '';
      if (state.preview.error) return `<div class="foundation-alert foundation-alert-error"><strong>${escapeHtml(state.preview.error)}</strong><span>원본 헤더 중복·대상 중복·별칭 충돌을 수정한 뒤 다시 확인하세요.</span></div>`;
      return `<section class="foundation-preview"><strong>헤더 미리보기</strong><div>${state.preview.columns.map(column => `<span data-status="${escapeHtml(column.status)}"><b>${column.index + 1}</b>${escapeHtml(column.originalHeader || '(빈 열)')} → ${escapeHtml(column.field?.displayName || column.status)}<small>${escapeHtml(column.reasonCode || column.source || '')}</small></span>`).join('')}</div></section>`;
    }

    function renderMappings() {
      const setOptions = mappingSetOptions();
      const firstSet = (state.metadata?.mappingSets || []).find(set => set.entityType === state.entityType) || null;
      const selectedId = text(container.querySelector('[data-foundation-set-select]')?.value) || firstSet?.mappingSetId || '';
      const set = (state.metadata?.mappingSets || []).find(row => row.mappingSetId === selectedId) || firstSet;
      const fields = (state.metadata?.fields || []).filter(field => field.entityType === state.entityType && field.enabled)
        .sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder));
      const fieldOptions = fields.map(field => `<option value="${escapeHtml(field.fieldId)}">${escapeHtml(field.displayName || field.storageKey)} · ${escapeHtml(field.fieldId)}</option>`).join('');
      const disabled = writeAllowed() ? '' : 'disabled';
      const rows = mappingsForSet(set).sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder)).map(mapping => `<tr data-foundation-mapping-row="${escapeHtml(mapping.mappingId)}">
        <td><strong>${escapeHtml(mapping.originalHeader)}</strong><small>${escapeHtml(mapping.normalizedHeader)}</small></td>
        <td>${escapeHtml(mapping.action)}</td>
        <td>${escapeHtml(mapping.targetFieldId || '의도적 제외')}</td>
        <td>${mapping.enabled ? '사용' : '중지'}</td>
        <td><button type="button" data-edit-mapping ${disabled}>수정</button> <button type="button" data-toggle-mapping ${disabled}>${mapping.enabled ? '중지' : '사용'}</button> <button type="button" data-delete-mapping ${disabled}>삭제</button></td>
      </tr>`).join('');
      const legacy = state.entityType === 'CUSTOMER' && state.metadata?.migrationState?.customerLegacy?.status === 'NOT_STARTED' && hasWritePermission()
        ? `<button type="button" data-preview-legacy ${disabled}>기존 거래처 매핑 이관 확인</button>` : '';
      return `<section class="foundation-panel">
        <div class="foundation-panel-head"><div><strong>Excel 필드 매핑</strong><span>명시 연결·의도적 제외·중지를 양식별로 관리합니다.</span></div><div class="foundation-actions">
          <select data-foundation-set-select>${setOptions || '<option value="">양식 없음</option>'}</select>
          <button type="button" data-create-set ${disabled}>양식 생성</button>
          <button type="button" data-delete-set ${!set || disabled ? 'disabled' : ''}>양식 삭제</button>${legacy}
        </div></div>
        ${set ? `<div class="foundation-set-summary"><strong>${escapeHtml(set.name)}</strong><span>${escapeHtml(set.description || '설명 없음')} · ${escapeHtml(set.sourceSystem)} · ${set.isDefault ? '기본 양식' : '일반 양식'} · revision ${Number(set.recordRevision || 0)}</span><button type="button" data-edit-set ${disabled}>양식 수정</button><button type="button" data-toggle-set ${disabled}>${set.enabled ? '양식 중지' : '양식 사용'}</button><button type="button" data-default-set ${disabled}>${set.isDefault ? '기본 해제' : '기본 지정'}</button></div>` : '<div class="foundation-empty">먼저 매핑 양식을 만드세요.</div>'}
        ${set ? `<form class="foundation-mapping-form" data-add-mapping>
          <label>원본 헤더<input name="originalHeader" required ${disabled}></label>
          <label>처리<select name="action" ${disabled}><option value="MAP">필드 연결</option><option value="IGNORE">의도적 제외</option></select></label>
          <label>대상 필드<select name="targetFieldId" ${disabled}>${fieldOptions}</select></label>
          <label>순서<input name="sortOrder" type="number" value="${(mappingsForSet(set).length + 1) * 10}" ${disabled}></label>
          <button type="submit" ${disabled}>매핑 추가</button>
        </form>` : ''}
        <div class="foundation-table-wrap"><table><thead><tr><th>원본 / 정규화</th><th>처리</th><th>대상 fieldId</th><th>상태</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">저장된 매핑이 없습니다.</td></tr>'}</tbody></table></div>
        <label class="foundation-file">헤더만 불러오기<input type="file" data-foundation-header-file accept=".xlsx,.xls" ${state.metadata?.readOnly ? 'disabled' : ''}></label>
        ${renderMappingPreview()}
      </section>`;
    }

    function renderLegacyPreview() {
      if (!state.legacyPreview) return '';
      const preview = state.legacyPreview;
      return `<div class="foundation-modal-backdrop"><section class="foundation-modal" role="dialog" aria-modal="true" aria-label="거래처 legacy 이관 확인">
        <h3>기존 거래처 매핑 이관 확인</h3>
        <p>IndexedDB 원본 ${preview.sourceCount.toLocaleString()}건 중 ${preview.successCount.toLocaleString()}건을 변환할 수 있고 ${preview.unmigrated.length.toLocaleString()}건은 미이관으로 기록됩니다. 기존 데이터는 삭제하지 않습니다.</p>
        <ul>${preview.groups.map(group => `<li>${escapeHtml(group.sourceSystem)} · 매핑 ${group.mappings.length}건</li>`).join('') || '<li>기존 헤더 매핑 없음</li>'}</ul>
        <div class="foundation-actions"><button type="button" data-cancel-legacy>취소</button><button type="button" data-apply-legacy>관리자 승인 후 이관</button></div>
      </section></div>`;
    }

    function render() {
      if (state.destroyed) return;
      const canSave = state.phase === 'DIRTY' && writeAllowed();
      const statusClass = state.phase === 'ERROR' || state.phase === 'CONFLICT' ? 'error' : state.phase === 'READ_ONLY_CACHE' ? 'warning' : 'normal';
      container.innerHTML = `<div class="foundation-metadata" data-phase="${escapeHtml(state.phase)}">
        <header><div><span>FOUNDATION_METADATA_V1</span><h2>${state.entityType === 'CUSTOMER' ? '거래처' : '상품'} 기준정보 필드·매핑</h2></div>
          <div class="foundation-status" data-status="${statusClass}"><strong>${escapeHtml(phaseLabel())}</strong><span>${escapeHtml(state.message || (state.metadata?.source === 'READ_ONLY_CACHE' ? '서버 실패로 회사 범위 마지막 정상본을 표시합니다.' : '회사 범위 메타데이터'))}</span></div>
          <div class="foundation-actions"><button type="button" data-foundation-reload>재조회</button><button type="button" data-foundation-discard ${state.fieldChanges.size ? '' : 'disabled'}>변경 취소</button><button type="button" data-foundation-save ${canSave ? '' : 'disabled'}>저장 ${state.fieldChanges.size ? state.fieldChanges.size : ''}</button></div>
        </header>
        <nav><button type="button" data-foundation-tab="FIELDS" aria-current="${state.tab === 'FIELDS' ? 'page' : 'false'}">항목 관리</button><button type="button" data-foundation-tab="MAPPINGS" aria-current="${state.tab === 'MAPPINGS' ? 'page' : 'false'}">Excel 필드 매핑</button></nav>
        ${state.phase === 'LOADING' ? '<div class="foundation-empty">서버 메타데이터를 불러오고 있습니다.</div>' : state.phase === 'ERROR' && !state.metadata ? '<div class="foundation-alert foundation-alert-error">메타데이터를 불러오지 못했습니다. 인증·Gateway·네트워크 상태를 확인하세요.</div>' : state.tab === 'FIELDS' ? renderFields() : renderMappings()}
        ${renderLegacyPreview()}
      </div>`;
      bind();
    }

    function markFieldChange(fieldId, patch) {
      const previous = state.fieldChanges.get(fieldId) || {};
      state.fieldChanges.set(fieldId, Object.assign({}, previous, patch));
      state.phase = 'DIRTY';
      render();
    }

    async function loadMetadata(options) {
      const preserved = options && options.preserveChanges ? new Map(state.fieldChanges) : null;
      state.phase = 'LOADING';
      state.message = '';
      render();
      try {
        state.metadata = await api.load(state.entityType, { includeDisabled: true });
        state.phase = state.metadata.readOnly ? 'READ_ONLY_CACHE' : 'READY';
        if (preserved) {
          state.fieldChanges = preserved;
          if (preserved.size) state.phase = 'DIRTY';
        } else {
          state.fieldChanges.clear();
        }
      } catch (error) {
        state.phase = 'ERROR';
        state.message = text(error && error.message || error);
      }
      render();
    }

    async function submitChanges(changes, successMessage) {
      if (!writeAllowed()) return;
      state.phase = 'SAVING';
      state.message = '';
      render();
      try {
        const response = await api.save(state.metadata.metadataRevision, changes);
        const proofMessage = `${successMessage || '저장 완료'} · request ${response.requestId}`;
        state.fieldChanges.clear();
        await loadMetadata();
        state.message = proofMessage;
        render();
      } catch (error) {
        const code = text(error && error.message || error);
        state.phase = code.includes('METADATA_VERSION_CONFLICT') ? 'CONFLICT' : 'ERROR';
        state.message = code;
        render();
      }
    }

    async function parseHeaderFile(file) {
      if (!file || !root.XLSX) return;
      try {
        const workbook = root.XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false, cellDates: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = root.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
        const headers = (matrix.find(row => row.some(value => text(value))) || []).map(value => String(value ?? ''));
        const set = currentSet();
        const resolved = api.resolveHeaders(state.metadata, { entityType: state.entityType, sourceSystem: set?.sourceSystem || 'GENERIC', mappingSetId: set?.mappingSetId || '', headers });
        state.preview = { columns: resolved.resolved };
      } catch (error) {
        state.preview = { error: text(error && error.code || error && error.message || error) };
      }
      render();
    }

    function bind() {
      container.querySelectorAll('[data-foundation-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.foundationTab; state.preview = null; render(); }));
      container.querySelector('[data-foundation-reload]')?.addEventListener('click', () => loadMetadata({ preserveChanges: state.phase === 'CONFLICT' }));
      container.querySelector('[data-foundation-discard]')?.addEventListener('click', () => { state.fieldChanges.clear(); state.phase = state.metadata?.readOnly ? 'READ_ONLY_CACHE' : 'READY'; render(); });
      container.querySelector('[data-foundation-save]')?.addEventListener('click', () => {
        const changes = Array.from(state.fieldChanges.entries()).map(([fieldId, patch]) => ({ changeId: changeId('FIELD'), op: 'PATCH_FIELD', entityType: state.entityType, fieldId, patch }));
        submitChanges(changes, '필드 저장 완료');
      });
      container.querySelector('[data-foundation-search]')?.addEventListener('input', event => { state.search = event.target.value; render(); });
      container.querySelectorAll('[data-foundation-field-row]').forEach(row => {
        const fieldId = row.dataset.foundationFieldRow;
        row.querySelector('[data-field-display-name]')?.addEventListener('change', event => markFieldChange(fieldId, { displayName: event.target.value }));
        row.querySelector('[data-field-sort-order]')?.addEventListener('change', event => markFieldChange(fieldId, { sortOrder: Number(event.target.value) }));
        row.querySelector('[data-field-enabled]')?.addEventListener('change', event => markFieldChange(fieldId, { enabled: event.target.checked }));
        row.querySelector('[data-field-aliases]')?.addEventListener('change', event => markFieldChange(fieldId, { legacyAliases: event.target.value.split(',').map(text).filter(Boolean) }));
      });
      container.querySelector('[data-foundation-set-select]')?.addEventListener('change', event => {
        api.rememberMappingSet(state.metadata, state.entityType, event.target.value);
        state.preview = null;
        render();
      });
      container.querySelector('[data-create-set]')?.addEventListener('click', async () => {
        const name = text(root.prompt('새 매핑 양식명을 입력하세요.', `${state.entityType === 'CUSTOMER' ? '거래처' : '상품'} ERP 기본`));
        if (!name) return;
        const sourceSystem = text(root.prompt('sourceSystem 코드를 입력하세요.', 'ERP')).toUpperCase();
        if (!sourceSystem) return;
        const makeDefault = root.confirm('이 양식을 해당 sourceSystem의 기본 양식으로 지정하시겠습니까?');
        const changes = [];
        if (makeDefault) {
          const currentDefault = (state.metadata.mappingSets || []).find(set => set.entityType === state.entityType && set.sourceSystem === sourceSystem && set.enabled && set.isDefault);
          if (currentDefault) changes.push({ changeId: changeId('SET-DEMOTE'), op: 'UPSERT_MAPPING_SET', mappingSetId: currentDefault.mappingSetId, record: {
            entityType: currentDefault.entityType, name: currentDefault.name, description: currentDefault.description,
            sourceSystem: currentDefault.sourceSystem, enabled: currentDefault.enabled, isDefault: false
          } });
        }
        changes.push({ changeId: changeId('SET'), op: 'UPSERT_MAPPING_SET', mappingSetId: null, record: { entityType: state.entityType, name, description: '', sourceSystem, enabled: true, isDefault: makeDefault } });
        await submitChanges(changes, '양식 생성 완료');
      });
      container.querySelector('[data-delete-set]')?.addEventListener('click', async () => {
        const set = currentSet();
        if (!set || !root.confirm(`'${set.name}' 양식과 연결된 매핑을 함께 삭제하시겠습니까?`)) return;
        await submitChanges([{ changeId: changeId('SET-DELETE'), op: 'DELETE_MAPPING_SET', mappingSetId: set.mappingSetId }], '양식 삭제 완료');
      });
      container.querySelector('[data-edit-set]')?.addEventListener('click', async () => {
        const set = currentSet();
        if (!set) return;
        const name = text(root.prompt('매핑 양식명을 입력하세요.', set.name));
        if (!name) return;
        const description = text(root.prompt('설명을 입력하세요.', set.description || ''));
        const sourceSystem = text(root.prompt('sourceSystem 코드를 입력하세요.', set.sourceSystem)).toUpperCase();
        if (!sourceSystem) return;
        await submitChanges([{ changeId: changeId('SET-EDIT'), op: 'UPSERT_MAPPING_SET', mappingSetId: set.mappingSetId, record: {
          entityType: set.entityType, name, description, sourceSystem, enabled: set.enabled, isDefault: set.isDefault
        } }], '양식 수정 완료');
      });
      container.querySelector('[data-toggle-set]')?.addEventListener('click', async () => {
        const set = currentSet();
        if (!set) return;
        await submitChanges([{ changeId: changeId('SET-TOGGLE'), op: 'UPSERT_MAPPING_SET', mappingSetId: set.mappingSetId, record: {
          entityType: set.entityType, name: set.name, description: set.description, sourceSystem: set.sourceSystem,
          enabled: !set.enabled, isDefault: set.isDefault
        } }], '양식 상태 저장 완료');
      });
      container.querySelector('[data-default-set]')?.addEventListener('click', async () => {
        const set = currentSet();
        if (!set) return;
        const changes = [];
        if (!set.isDefault) {
          (state.metadata.mappingSets || []).filter(row => row.entityType === set.entityType && row.sourceSystem === set.sourceSystem && row.enabled && row.isDefault && row.mappingSetId !== set.mappingSetId).forEach(row => {
            changes.push({ changeId: changeId('SET-DEMOTE'), op: 'UPSERT_MAPPING_SET', mappingSetId: row.mappingSetId, record: {
              entityType: row.entityType, name: row.name, description: row.description, sourceSystem: row.sourceSystem,
              enabled: row.enabled, isDefault: false
            } });
          });
        }
        changes.push({ changeId: changeId('SET-DEFAULT'), op: 'UPSERT_MAPPING_SET', mappingSetId: set.mappingSetId, record: {
          entityType: set.entityType, name: set.name, description: set.description, sourceSystem: set.sourceSystem,
          enabled: set.isDefault ? set.enabled : true, isDefault: !set.isDefault
        } });
        await submitChanges(changes, '기본 양식 저장 완료');
      });
      container.querySelector('[data-add-mapping]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const set = currentSet();
        if (!set) return;
        const values = Object.fromEntries(new FormData(event.currentTarget).entries());
        await submitChanges([{ changeId: changeId('MAP'), op: 'UPSERT_MAPPING', mappingId: null, record: {
          mappingSetId: set.mappingSetId, entityType: state.entityType, originalHeader: values.originalHeader,
          action: values.action, targetFieldId: values.action === 'MAP' ? values.targetFieldId : null,
          enabled: true, sortOrder: Number(values.sortOrder || 0)
        } }], '매핑 저장 완료');
      });
      container.querySelectorAll('[data-foundation-mapping-row]').forEach(row => row.querySelector('[data-delete-mapping]')?.addEventListener('click', async () => {
        if (!root.confirm('이 헤더 매핑을 삭제하시겠습니까? 시스템 별칭 추천이 다시 적용될 수 있습니다.')) return;
        await submitChanges([{ changeId: changeId('MAP-DELETE'), op: 'DELETE_MAPPING', mappingId: row.dataset.foundationMappingRow }], '매핑 삭제 완료');
      }));
      container.querySelectorAll('[data-foundation-mapping-row]').forEach(row => row.querySelector('[data-edit-mapping]')?.addEventListener('click', async () => {
        const mapping = (state.metadata.mappings || []).find(item => item.mappingId === row.dataset.foundationMappingRow);
        if (!mapping) return;
        const originalHeader = text(root.prompt('원본 헤더를 입력하세요.', mapping.originalHeader));
        if (!originalHeader) return;
        const action = text(root.prompt('처리를 MAP 또는 IGNORE로 입력하세요.', mapping.action)).toUpperCase();
        if (!['MAP', 'IGNORE'].includes(action)) return;
        const targetFieldId = action === 'MAP' ? text(root.prompt('대상 fieldId를 입력하세요.', mapping.targetFieldId || '')) : null;
        if (action === 'MAP' && !targetFieldId) return;
        const sortOrder = Number(root.prompt('순서를 입력하세요.', String(mapping.sortOrder || 0)));
        if (!Number.isFinite(sortOrder)) return;
        await submitChanges([{ changeId: changeId('MAP-EDIT'), op: 'UPSERT_MAPPING', mappingId: mapping.mappingId, record: {
          mappingSetId: mapping.mappingSetId, entityType: mapping.entityType, originalHeader,
          action, targetFieldId, enabled: mapping.enabled, sortOrder
        } }], '매핑 수정 완료');
      }));
      container.querySelectorAll('[data-foundation-mapping-row]').forEach(row => row.querySelector('[data-toggle-mapping]')?.addEventListener('click', async () => {
        const mapping = (state.metadata.mappings || []).find(item => item.mappingId === row.dataset.foundationMappingRow);
        if (!mapping) return;
        await submitChanges([{ changeId: changeId('MAP-TOGGLE'), op: 'UPSERT_MAPPING', mappingId: mapping.mappingId, record: {
          mappingSetId: mapping.mappingSetId, entityType: mapping.entityType, originalHeader: mapping.originalHeader,
          action: mapping.action, targetFieldId: mapping.targetFieldId, enabled: !mapping.enabled, sortOrder: mapping.sortOrder
        } }], '매핑 상태 저장 완료');
      }));
      container.querySelector('[data-foundation-header-file]')?.addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; parseHeaderFile(file); });
      container.querySelector('[data-preview-legacy]')?.addEventListener('click', async () => {
        try { state.legacyPreview = await api.previewCustomerLegacyMigration(state.metadata); }
        catch (error) { state.message = text(error && error.message || error); }
        render();
      });
      container.querySelector('[data-cancel-legacy]')?.addEventListener('click', () => { state.legacyPreview = null; render(); });
      container.querySelector('[data-apply-legacy]')?.addEventListener('click', async () => {
        const preview = state.legacyPreview;
        if (!preview || !root.confirm('표시한 변환 결과를 하나의 원자 요청으로 이관하시겠습니까?')) return;
        state.legacyPreview = null;
        await submitChanges(preview.fieldChanges.concat(preview.migrationChange), '기존 거래처 매핑 이관 완료');
      });
    }

    container.classList.add('foundation-metadata-host');
    render();
    loadMetadata();
    return function unmount() {
      state.destroyed = true;
      container.innerHTML = '';
      container.classList.remove('foundation-metadata-host');
    };
  }

  root.NEXUS_FOUNDATION_UI = Object.freeze({ mount });
})(window);
