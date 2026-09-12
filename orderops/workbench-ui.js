(function (root) {
  'use strict';
  root.createOrderOpsWorkbench = function (api) {
    const { state: s, engine: e, elements: el, escapeHtml: esc } = api;
    const $ = id => document.getElementById(id);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const kinds = ['orders', 'inventory', 'purchases', 'sales'];
    const labels = { orders: '주문현황', inventory: '창고재고', purchases: '구매 참고자료', sales: '판매 참고자료' };
    const pane = $('orderOpsFilePreparePane');
    const workspaceElement = pane.parentElement;
    const fitHeight = () => { workspaceElement.style.setProperty('--orderops-workbench-height', `${Math.max(220, innerHeight - workspaceElement.getBoundingClientRect().top - 8)}px`); };
    addEventListener('resize', fitHeight);
    new ResizeObserver(fitHeight).observe(document.querySelector('[data-nexus-app-header="orderops"]'));
    requestAnimationFrame(fitHeight);
    const procurementScope = document.createElement('select');
    procurementScope.id = 'procurementScope'; procurementScope.hidden = true;
    procurementScope.setAttribute('aria-label', '발주현황 표시 범위');
    procurementScope.innerHTML = '<option value="shortage">부족 상품</option><option value="all">전체 상품 · 제외 사유</option>';
    document.querySelector('.view-controls-scroll').prepend(procurementScope);
    procurementScope.onchange = () => { if (s.workspace) api.renderResults(); };
    let operation = null;
    let inventoryPreparationOperation = null;
    let commitLocked = false;
    let preparedVersion = 0;
    const status = message => { $('prepareStatus').textContent = message; };
    const selected = () => s.preparedFiles.find(item => item.id === s.selectedPreparedId);
    const dirty = () => s.preparedFiles.some(item => item.dirty) || Object.values(s.inspectorEdits).some(edit => Object.keys(edit.values).length);
    const fieldNames = kind => kind === 'orders' ? [...e.ORDER_REQUIRED_COLUMNS, ...e.ORDER_OPTIONAL_COLUMNS]
      : kind === 'inventory' ? [...e.INVENTORY_REQUIRED_COLUMNS, ...e.INVENTORY_OPTIONAL_COLUMNS, '단위']
        : ['품목코드', '품목명', '수량', kind === 'purchases' ? '구매처' : '거래처'];

    function setLeft(open, persist = true) {
      if (open && innerWidth <= 639) api.setRight(false, { persist: false });
      pane.hidden = !open;
      pane.setAttribute('aria-hidden', String(!open));
      workspaceElement.dataset.nexusLeftOpen = String(open);
      $('preparePaneReopen').setAttribute('aria-expanded', String(open));
      if (persist) { try { localStorage.setItem('oneapp.orderops.file-prepare-open.v1', open ? '1' : '0'); } catch (_) {} }
      dispatchEvent(new Event('resize'));
      (open ? pane : $('preparePaneReopen')).focus({ preventScroll: true });
    }

    function automatic(item) {
      const results = kinds.map(kind => {
        try {
          const options = { workbook: item.workbook, fileName: item.fileName, fileHash: item.fileHash, sheetName: item.sheetName, kind };
          const parsed = ['orders', 'inventory'].includes(kind) ? api.parsePrimary(options) : api.parseGeneric(options);
          return { kind, parsed, score: api.score(kind, parsed) };
        } catch (_) { return { kind, score: 0 }; }
      });
      const candidates = results.filter(result => result.score > 0).sort((a, b) => b.score - a.score);
      const best = results.find(result => result.kind === item.kind) || candidates[0];
      if (!item.kind) item.kind = candidates.length && (candidates.length === 1 || candidates[0].score !== candidates[1].score) ? candidates[0].kind : '';
      const choice = results.find(result => result.kind === item.kind) || best;
      item.headerRowIndex = Math.max(0, choice?.parsed?.headerRowIndex || 0);
      item.dataStartRowIndex = item.headerRowIndex + 1;
      item.mapping = null;
      validate(item);
    }

    function suggestMapping(item) {
      const headers = item.display[item.headerRowIndex] || [];
      const fields = [...new Set(fieldNames(item.kind))];
      const normalized = value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
      let mapped = [];
      try {
        const result = e.parseOrderWorkbook({ rawMatrix: item.raw, displayMatrix: item.display, headerAliases: api.headerAliases(item.kind) });
        mapped = result.headerMapping.columns;
      } catch (_) {}
      return headers.map((header, index) => {
        const canonical = fields.find(field => normalized(field) === normalized(header)) || mapped.find(entry => entry.columnIndex === index)?.canonical;
        if (canonical && fields.includes(canonical)) return canonical;
        if (item.kind === 'inventory' && /창고|서울|전송/.test(String(header))) return `warehouse:${header}`;
        const aliases = api.headerAliases(item.kind);
        return fields.find(field => (aliases[field] || []).some(alias => normalized(alias) === normalized(header))) || '';
      });
    }

    function validate(item) {
      item.error = '';
      try {
        if (!item.kind) throw new Error('자료 유형을 선택하세요.');
        item.mapping ||= suggestMapping(item);
        const explicitMapping = { headerRowIndex: item.headerRowIndex, dataStartRowIndex: item.dataStartRowIndex, columns: item.mapping };
        if (['orders', 'inventory'].includes(item.kind)) {
          const input = { fileName: item.fileName, fileHash: item.fileHash, sheetName: item.sheetName, rawMatrix: item.raw, displayMatrix: item.kind === 'orders' ? api.normalizeOrderDates(item.display) : item.display, headerAliases: api.headerAliases(item.kind), explicitMapping };
          item.parsed = item.kind === 'orders' ? e.parseOrderWorkbook(input) : e.parseInventoryWorkbook(input);
        } else {
          if (item.dataStartRowIndex <= item.headerRowIndex || item.dataStartRowIndex >= item.display.length) throw new Error('데이터 시작행 범위를 확인하세요.');
          const required = fieldNames(item.kind);
          if (required.some(field => item.mapping.filter(value => value === field).length !== 1)) throw new Error('필수 항목의 원본 열을 하나씩 지정하세요.');
          const get = (row, field) => row[item.mapping.indexOf(field)];
          const errors = [];
          const rows = item.display.slice(item.dataStartRowIndex).flatMap((cells, offset) => {
            if (!cells.some(value => String(value ?? '').trim())) return [];
            const quantity = e.parseNumericCell(get(cells, '수량'));
            const code = e.normalizeProductCode(get(cells, '품목코드'));
            if (!code || !quantity.ok || quantity.blank) { errors.push({ message: `${item.dataStartRowIndex + offset + 1}행 상품코드·수량 확인 필요` }); return []; }
            return [{ productCode: code, productName: String(get(cells, '품목명') ?? ''), quantity: quantity.value, partner: String(get(cells, item.kind === 'purchases' ? '구매처' : '거래처') ?? ''), sourceRowNumber: item.dataStartRowIndex + offset + 1 }];
          });
          item.parsed = { kind: item.kind, fileName: item.fileName, fileHash: item.fileHash, sheetName: item.sheetName, headerRowIndex: item.headerRowIndex, headers: item.display[item.headerRowIndex], explicitMapping, sourceMatrix: clone(item.raw), rows, rowCount: rows.length, errors, warnings: [], missingColumns: [] };
        }
        item.parsed.sourceEvidence = { rawMatrix: clone(item.raw), displayMatrix: clone(item.display), cells: clone(item.cells) };
        if (item.parsed.errors?.length) throw new Error(item.parsed.errors.map(error => error.message).join(' · '));
        item.status = item.applied && !item.dirty ? 'APPLIED' : 'READY';
      } catch (error) { item.status = 'INVALID'; item.error = error.message; }
    }

    function renderPreparation() {
      $('prepareFileList').innerHTML = s.preparedFiles.map(item => `<button type="button" data-prepared-id="${esc(item.id)}" aria-pressed="${item.id === s.selectedPreparedId}">${esc(item.fileName)} · ${esc(item.sheetName)}<br>${esc(item.remove ? '사용해제 예정' : item.status)}${item.include ? ' · 적용 대상' : ''}</button>`).join('');
      const item = selected();
      $('prepareRemoveButton').disabled = !item || Boolean(operation || inventoryPreparationOperation);
      $('prepareApplyButton').disabled = Boolean(operation || inventoryPreparationOperation) || !dirty();
      if (!item) { $('prepareFileEditor').innerHTML = '<p>파일을 선택하고 자료 유형·시트·열을 확인한 뒤 적용하세요.</p>'; return; }
      const fields = [...new Set(fieldNames(item.kind))];
      $('prepareFileEditor').innerHTML = `<label><span>이번 적용에 포함</span><input id="preparedInclude" type="checkbox" ${item.include ? 'checked' : ''}></label>
        <label>자료 유형<select id="preparedKind"><option value="">유형 선택</option>${kinds.map(kind => `<option value="${kind}" ${item.kind === kind ? 'selected' : ''}>${labels[kind]}</option>`).join('')}</select></label>
        <label>시트<select id="preparedSheet">${item.workbook.SheetNames.map(name => `<option ${name === item.sheetName ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
        <label>헤더행<input id="preparedHeader" type="number" min="1" max="${item.display.length}" value="${item.headerRowIndex + 1}"></label>
        <label>데이터 시작행<input id="preparedStart" type="number" min="${item.headerRowIndex + 2}" max="${item.display.length}" value="${item.dataStartRowIndex + 1}"></label>
        <div class="orderops-raw-preview"><table>${[...new Set([0,1,2,3,4,5,6,7,item.headerRowIndex,item.dataStartRowIndex,item.dataStartRowIndex+1,item.dataStartRowIndex+2])].filter(index=>index<item.display.length).sort((a,b)=>a-b).map(index => `<tr><th>${index + 1}</th>${item.display[index].map(value => `<td>${esc(value ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
        <strong>원본 열 → 사용할 항목</strong>${(item.display[item.headerRowIndex] || []).map((header, index) => `<label class="orderops-mapping-row"><span>${index + 1}. ${esc(header || '(공란)')}</span><select data-map-index="${index}"><option value="">비매핑</option>${[...new Set([...fields, ...(item.kind === 'inventory' && header ? [`warehouse:${header}`] : [])])].map(field => `<option value="${esc(field)}" ${item.mapping?.[index] === field ? 'selected' : ''}>${esc(field.startsWith('warehouse:') ? '창고수량 · ' + field.slice(10) : field)}</option>`).join('')}</select></label>`).join('')}
        <p role="status">${esc(item.error || `${item.parsed?.rowCount || 0}행 검증됨 · 적용 전에는 현재 작업이 바뀌지 않습니다.`)}</p>`;
    }

    async function prepare(files, kind = '') {
      if (operation || s.inventoryApplyBusy) throw new Error('진행 중인 적용 결과를 확인하세요.');
      setLeft(true);
      status('파일 구조를 읽고 있습니다. 현재 작업은 유지됩니다.');
      for (const file of Array.from(files || [])) {
        try {
          if (!/\.(xlsx|xls)$/i.test(file.name) || file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: Excel 형식·25MiB 제한을 확인하세요.`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const fileHash = await api.sha256Hex(bytes);
          const workbook = root.XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, cellText: true });
          for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const item = { id: crypto.randomUUID(), fileName: file.name, fileHash, workbook, sheetName, kind, dirty: true, include: true, applied: false,
              raw: root.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true }), display: root.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true }),
              cells: Object.fromEntries(Object.entries(sheet).filter(([key]) => !key.startsWith('!')).map(([key, cell]) => [key, { t: cell.t, v: cell.v, w: cell.w, z: cell.z, f: cell.f }])) };
            automatic(item); s.preparedFiles.push(item); s.selectedPreparedId ||= item.id;
          }
          preparedVersion += 1;
        } catch (error) { status(error.message); api.showToast(error.message, true); }
      }
      renderPreparation();
    }

    function hydratePrepared() {
      if (operation || s.preparedFiles.some(item=>item.dirty)) return;
      s.preparedFiles = kinds.flatMap(kind => {
        const parsed=s[kind]; if(!parsed || parsed.sourceKind==='ORDERQ_READ_MODEL')return [];
        const raw=clone(parsed.sourceEvidence?.rawMatrix || parsed.sourceMatrix || []);
        const display=clone(parsed.sourceEvidence?.displayMatrix || raw);
        if(!display.length)return [];
        const sheetName=parsed.sheetName || labels[kind];
        const item={id:crypto.randomUUID(),fileName:parsed.fileName,fileHash:parsed.fileHash,sheetName,kind,dirty:false,applied:true,include:true,status:'APPLIED',parsed:clone(parsed),raw,display,cells:clone(parsed.sourceEvidence?.cells || {}),workbook:{SheetNames:[sheetName],Sheets:{[sheetName]:root.XLSX.utils.aoa_to_sheet(raw)}},headerRowIndex:parsed.explicitMapping?.headerRowIndex ?? parsed.headerRowIndex ?? 0,dataStartRowIndex:parsed.explicitMapping?.dataStartRowIndex ?? (parsed.headerRowIndex ?? 0)+1,mapping:clone(parsed.explicitMapping?.columns)};
        item.mapping ||= suggestMapping(item); return [item];
      });
      s.selectedPreparedId=s.preparedFiles[0]?.id || ''; renderPreparation();
    }

    async function waitBoundary() {
      await api.waitBoundary();
      api.captureInputs();
      if (Object.values(s.inspectorEdits).some(edit => Object.keys(edit.values).length)) throw new Error('우측 수정 대기 값을 먼저 적용하거나 취소하세요. 입력은 보존되었습니다.');
    }

    async function runReplacement(build, activate, check = async () => true) {
      if (operation) return operation;
      operation = (async () => {
        s.workbenchApplyBusy = true;
        try {
          await waitBoundary();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            api.captureInputs();
            const base = s.workspace, version = s.workspaceChangeVersion;
            const candidate = await build(base);
            const record = await api.buildRecord(candidate, { publicationState: 'STAGED' });
            await api.putRecord(record);
            const staged = await api.readRecord(record.recordId);
            const verified = await api.verifyRecord(staged);
            if (!verified.valid) throw new Error(verified.reason);
            api.captureInputs();
            if (s.workspace !== base || s.workspaceChangeVersion !== version) continue;
            if (!await check()) throw new Error('원본 또는 준비 입력이 변경되었습니다. 현재 작업을 유지하고 다시 적용하세요.');
            api.captureInputs();
            if (s.workspace !== base || s.workspaceChangeVersion !== version) continue;
            commitLocked = true;
            workspaceElement.inert = true;
            $('shipmentWorkbenchDialog').inert = true;
            try {
              const published = { ...staged, publicationState: 'PUBLISHED', publishedAt: new Date().toISOString() };
              // The verified payload and its publication flag commit in one IDB
              // transaction. No unaccepted candidate is a normal recovery row.
              await api.commitRecord(published, () => s.workspace === base && s.workspaceChangeVersion === version);
              activate(candidate, published);
              api.setRecoveryPointer(published);
              s.selectedRecoveryId = published.recordId;
            } finally { commitLocked = false; workspaceElement.inert = false; $('shipmentWorkbenchDialog').inert = false; }
            await api.refreshRecovery();
            return { ok: true, recordId: record.recordId };
          }
          throw new Error('입력이 계속 변경되어 적용하지 않았습니다. 최신 입력을 확인한 뒤 다시 적용하세요.');
        } finally { s.workbenchApplyBusy = false; }
      })();
      try { return await operation; } catch (error) { status(error.message); api.showToast(error.message, true); return { ok: false, message: error.message }; }
      finally { operation = null; if (s.workspace) api.scheduleSave(); renderPreparation(); }
    }

    async function resolveConflicts(conflicts) {
      const dialog = document.createElement('dialog'); dialog.className = 'orderops-workbench-dialog';
      dialog.innerHTML = `<form><h2>최신 주문과 작업값 조정</h2><p>이전 원본(B) · 현재 작업(W) · 최신 원본(N). 적용을 취소하면 현재 입력을 유지합니다.</p>${conflicts.map((c, index) => `<fieldset><legend>${esc(c.orderItemId)} · ${esc(c.field)}</legend><p>${esc(c.reason)}</p><pre>B: ${esc(JSON.stringify(c.base))}\nW: ${esc(JSON.stringify(c.work))}\nN: ${esc(JSON.stringify(c.latest))}</pre><select name="choice-${index}" required><option value="">선택</option>${c.latestOnly ? '' : '<option value="work">현재 작업값 유지</option>'}<option value="latest">최신 원본값 적용${c.latestOnly ? ' · 대체는 다시 선택' : ''}</option></select></fieldset>`).join('')}<button type="submit">선택한 값으로 조정</button><button type="button" data-cancel>현재 작업 유지</button></form>`;
      document.body.append(dialog);
      return new Promise(resolve => {
        let value = null;
        dialog.querySelector('form').onsubmit = event => { event.preventDefault(); value = Object.fromEntries(conflicts.map((c, i) => [c.id, dialog.querySelector(`[name="choice-${i}"]`).value])); dialog.close(); };
        dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
        dialog.onclose = () => { dialog.remove(); resolve(value); };
        dialog.showModal();
      });
    }

    async function applyLatest() {
      const id = s.orderQSource?.snapshot?.orderId;
      if (!id || s.shipmentCommandBusy || operation) return;
      const { reconcileOrderWork } = await import('./workbench-contract.js?v=20260912-v12');
      let source;
      const result = await runReplacement(async base => {
        source = await api.loadOrder(id);
        if (!['READY', 'EMPTY'].includes(source.status) || !source.snapshot) throw new Error(source.error?.message || '최신 주문 조회 실패 · 현재 작업 유지');
        const args = { previousSnapshot: s.orderQSource.snapshot, nextSnapshot: source.snapshot, workspace: base, parsedOrders: source.parsedOrders, draft: s.shipmentDraft };
        let reconciliation = reconcileOrderWork(args);
        let decisions = [];
        if (reconciliation.conflicts.length) {
          const choices = await resolveConflicts(reconciliation.conflicts);
          if (!choices) throw new Error('조정을 취소했습니다. 현재 작업과 입력을 유지합니다.');
          decisions = reconciliation.conflicts.map(conflict => ({ ...clone(conflict), choice: choices[conflict.id] }));
          reconciliation = reconcileOrderWork({ ...args, choices });
        }
        if (reconciliation.conflicts.length) throw new Error('미해결 충돌이 있어 적용하지 않았습니다.');
        let candidate = e.createPreviewWorkspace(reconciliation.parsedOrders, clone(s.inventory), { purchases: clone(s.purchases), sales: clone(s.sales), systemHistory: reconciliation.systemHistory });
        if (base.workspaceMode !== e.PREVIEW_WORKSPACE_MODE && base.inventoryApplicationMode !== 'TOTAL_ONLY' && candidate.orders.length) {
          candidate = await api.analyze({ orders: reconciliation.parsedOrders, inventory: clone(s.inventory), purchases: clone(s.purchases), sales: clone(s.sales) });
        }
        candidate.substitutionHistory = reconciliation.substitutionHistory;
        candidate.systemHistory = reconciliation.systemHistory;
        candidate.inventoryOverrides = reconciliation.inventoryOverrides;
        candidate.workbenchUnapplied = reconciliation.unapplied;
        candidate.workbenchReconciliation = { schemaVersion: 'orderops-workbench-reconciliation/v1', fromRevision: s.orderQSource.snapshot.orderRevision, fromHash: s.orderQSource.snapshot.snapshotHash, toRevision: source.snapshot.orderRevision, toHash: source.snapshot.snapshotHash, retained: reconciliation.retained, added: reconciliation.added, removed: reconciliation.removed, excludedOverrides: reconciliation.excludedOverrides, excludedPurchaseInputs: reconciliation.excludedPurchaseInputs, decisions };
        candidate.systemHistory ||= { schemaVersion: e.SYSTEM_HISTORY_SCHEMA_VERSION, events: [] };
        candidate.systemHistory.events.push({ eventId: crypto.randomUUID(), kind: 'ORDER_SOURCE_RECONCILED', occurredAt: new Date().toISOString(), actor: api.actor(), orderId: id, detail: clone(candidate.workbenchReconciliation) });
        candidate.workbenchConflicts = [];
        candidate.orderQSourceRecovery = { schemaVersion: 'orderops-orderq-source-recovery/v1', snapshot: clone(source.snapshot) };
        candidate.shipmentExecutionDraft = { schemaVersion: 'orderops-shipment-execution-draft/v1', orderId: id, orderRevision: source.snapshot.orderRevision, values: reconciliation.draft };
        e.applyPurchaseInputs(candidate, reconciliation.purchaseInputs);
        if (base.inventorySourceReference) candidate.inventorySourceReference = clone(base.inventorySourceReference);
        if (base.inventoryApplicationMode) candidate.inventoryApplicationMode = base.inventoryApplicationMode;
        if (base.inventoryApplicationMode === 'TOTAL_ONLY') candidate = e.replaceWorkspaceInventory(candidate, clone(s.inventory), { sourceFingerprint: candidate.sourceFingerprint, sourceReference: base.inventorySourceReference, applicationMode: 'TOTAL_ONLY', inventoryOverridePolicy: 'DISCARD' });
        return candidate;
      }, candidate => {
        s.workspace = candidate; api.activateOrder(source); api.restoreInputs(candidate); api.renderResults();
      }, async () => { const latest = await api.loadOrder(id); return latest.snapshot?.snapshotHash === source.snapshot.snapshotHash && latest.snapshot?.orderRevision === source.snapshot.orderRevision; });
      if (result.ok) { status('최신 주문 적용 완료 · 작업값/미적용 기록 보존 · 공식 출고 조건 재검증'); await api.refreshShipment(); }
      return result;
    }

    async function applyFiles() {
      if (operation || inventoryPreparationOperation) return operation || inventoryPreparationOperation;
      const batch = s.preparedFiles.filter(item => item.include && item.dirty);
      if (!batch.length) return;
      const byKind = new Map();
      for (const item of batch) {
        validate(item);
        if (!item.remove && item.status !== 'READY') return status(item.error || '검증 오류가 있는 파일을 적용 대상에서 제외하거나 수정하세요.');
        if (byKind.has(item.kind)) return status(`${labels[item.kind]} 후보가 여러 개입니다. 적용할 항목 하나만 포함하세요.`);
        byKind.set(item.kind, item);
      }
      if (s.workspace && !confirm(`${[...byKind.keys()].map(kind => labels[kind]).join('·')} 자료를 교체/사용해제합니다. 주문을 교체하면 현재 주문 작업값은 이전 복구본에 보관합니다. 적용할까요?`)) return;
      const batchVersion = preparedVersion;
      // Inventory-only uses the existing inventory apply transaction.
      if (byKind.size === 1 && byKind.has('inventory') && !byKind.get('inventory').remove && s.workspace) {
        const item = byKind.get('inventory');
        // The transaction owns this parsed snapshot, not later edits to the
        // preparation item. Keep new mappings/include choices dirty on return.
        const parsed = clone(item.parsed);
        inventoryPreparationOperation = (async () => {
          try {
            const result = await api.applyInventory({ parsed, applicationMode: 'ERP_WAREHOUSE', reference: { schemaVersion: e.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION, sourceType: 'ORDEROPS_ERP', sourceId: item.fileHash, revision: '', hash: item.fileHash, basisDate: '', savedAt: '', applicationMode: 'ERP_WAREHOUSE' } });
            if (result?.ok) {
              item.applied = true;
              if (preparedVersion === batchVersion && s.preparedFiles.includes(item)) {
                item.dirty = false; item.status = 'APPLIED';
                status('재고 적용 완료 · 주문 작업값 보존');
              } else {
                item.dirty = true; validate(item);
                status('이전 준비 버전의 재고 적용 완료 · 대기 중 변경한 매핑/선택은 미적용입니다. 확인 후 다시 적용하세요.');
              }
            } else status(result?.message || '재고 적용 실패 · 준비 입력과 기존 작업을 유지합니다.');
            return result;
          } catch (error) { status(error.message); api.showToast(error.message, true); return { ok: false, message: error.message }; }
        })();
        renderPreparation();
        try { return await inventoryPreparationOperation; }
        finally { inventoryPreparationOperation = null; renderPreparation(); }
      }
      let inputs;
      const result = await runReplacement(async base => {
        inputs = Object.fromEntries(kinds.map(kind => [kind, byKind.has(kind) ? (byKind.get(kind).remove ? null : clone(byKind.get(kind).parsed)) : clone(s[kind])]));
        if (!byKind.has('orders') && inputs.orders && base) inputs.orders.rows = clone(base.orders);
        const candidate = e.createPreviewWorkspace(inputs.orders, inputs.inventory, { purchases: inputs.purchases, sales: inputs.sales, systemHistory: base?.systemHistory });
        if (!candidate.sourceFingerprint) candidate.sourceFingerprint = await api.sha256Hex('orderops-empty-application:' + crypto.randomUUID());
        if (!byKind.has('orders') && base) {
          for (const key of ['substitutionHistory', 'orderQSourceRecovery', 'shipmentExecutionDraft', 'workbenchUnapplied', 'workbenchReconciliation', 'workbenchConflicts']) if (base[key]) candidate[key] = clone(base[key]);
          if (!byKind.has('inventory')) for (const key of ['inventoryOverrides', 'inventorySourceReference', 'inventoryApplicationMode']) if (base[key]) candidate[key] = clone(base[key]);
          e.applyPurchaseInputs(candidate, e.getPurchaseInputs(clone(base)));
        }
        return candidate;
      }, candidate => {
        Object.assign(s, inputs); s.workspace = candidate;
        if (byKind.has('orders')) api.disconnectSource();
        s.pendingSystemHistory = candidate.systemHistory;
        s.activePreview = 'allocations';
        api.restoreInputs(candidate); api.renderResults();
      }, async () => preparedVersion === batchVersion);
      if (result.ok) { batch.forEach(item => { item.dirty = false; item.applied = !item.remove; item.status = item.remove ? 'REMOVED' : 'APPLIED'; }); status('파일 적용 완료 · 원본과 매핑을 복구본에 보존했습니다.'); renderPreparation(); }
      return result;
    }

    function rowKey(row) { return String(row?.orderItemId || `${row?.orderId || ''}:${row?.sourceRowNumber || ''}`); }
    function activeRow() { return (s.workspace?.orders || []).find(row => rowKey(row) === s.selectedOrderRow); }
    function renderInspector() {
      const row = activeRow();
      el.inventoryInspectorIdentity.innerHTML = row ? `<strong>${esc(row.customer)} · ${esc(row.productName)}</strong><span>${esc(row.orderNumber || '')} · ${esc(row.productCode)} · ${esc(row.sourceUnit || '단위 확인')}</span>` : '<strong>조회·수정</strong><span>중앙 주문행을 선택하세요. 집계 행에서는 주문 필드를 수정하지 않습니다.</span>';
      const inventory = row && e.getInventoryViewRows(clone(s.workspace)).rows.find(item => item.productCode === row.productCode);
      el.inventoryInspectorMetrics.textContent = row ? `재고 ${inventory?.inventoryMissing ? '미확인' : inventory?.stockTotal ?? '미확인'} · 잔량 ${inventory?.quantityComparable ? inventory?.remainingQuantity : '비교 불가'} · 공식 창고/담당은 원본과 별도 검증` : '';
      const unapplied = (s.workspace?.workbenchUnapplied || []).length ? `<details><summary>미적용 행 ${(s.workspace.workbenchUnapplied).length}건</summary><pre>${esc(JSON.stringify(s.workspace.workbenchUnapplied, null, 2))}</pre></details>` : '';
      if (!row) { el.inventoryInspectorBody.innerHTML = unapplied; return; }
      const key = rowKey(row);
      const edit = s.inspectorEdits[key] ||= { values: {}, base: {} };
      const specs = [['warehouse', '창고'], ['manager', '담당자'], ['noteOriginal', '일반 적요'], ['note1Original', '직원 전달사항']];
      el.inventoryInspectorBody.innerHTML = `<div class="orderops-inspector-edit">${specs.map(([field, label]) => `<label>${label}<input data-inspector-field="${field}" value="${esc(Object.prototype.hasOwnProperty.call(edit.values, field) ? edit.values[field] : row[field] ?? '')}"></label>`).join('')}<p class="pending">${Object.keys(edit.values).length ? '수정 대기 · 대상별 입력 보존' : '작업본 조회'}</p><p>${esc(row.customer)} · 담당 변경은 같은 거래처/배송 단위 전체에 적용</p><button type="button" data-inspector-apply>작업본에 적용</button><button type="button" data-inspector-cancel>입력 취소</button></div>`;
      if (row.orderItemId && s.orderQSource?.snapshot) {
        const draft = s.shipmentDraft[row.orderItemId] || {};
        const remaining = Math.max(0, Number(s.orderQSource.snapshot.candidateLines.find(line=>line.orderItemId===row.orderItemId)?.shippableQuantity || 0)-Number(s.shipmentResults?.netByOrderItem?.[row.orderItemId] || 0));
        el.inventoryInspectorBody.insertAdjacentHTML('beforeend', `<div class="orderops-inspector-edit"><label>실제출고 초안<input data-inspector-draft="shippedQuantity" value="${esc(Object.prototype.hasOwnProperty.call(draft,'shippedQuantity') ? draft.shippedQuantity : remaining)}"></label><label>출고 사유<input data-inspector-draft="reason" value="${esc(draft.reason || '')}"></label><small>0/공란을 보존하며 확정 시 수량을 검사합니다.</small></div>`);
      }
      el.inventoryInspectorBody.insertAdjacentHTML('beforeend', unapplied);
    }

    function applyInspector() {
      const row = activeRow(); if (!row || operation) return;
      const key = rowKey(row), edit = s.inspectorEdits[key];
      for (const field of Object.keys(edit.values)) if (!Object.is(row[field], edit.base[field])) {
        status(`${field} 값이 중앙에서 변경됐습니다. 우측 입력은 유지됩니다. 현재값 ${row[field] ?? ''} / 수정값 ${edit.values[field]}`); return;
      }
      try {
        for (const [field, value] of Object.entries(edit.values)) {
          if (field === 'manager') e.setCustomerManager(s.workspace, e.customerWorkKey(row), value, { recordHistory: true, actor: api.actor() });
          else e.setOrderValue(s.workspace, row.sourceRowNumber, field === 'noteOriginal' ? 'note' : field === 'note1Original' ? 'deliveryNotice' : field, value, { recordHistory: true, actor: api.actor() });
        }
        delete s.inspectorEdits[key]; api.scheduleSave(); api.renderResults();
      } catch (error) { status(error.message); }
    }

    $('prepareFilesButton').onclick = () => $('prepareFilesInput').click();
    $('prepareFilesInput').onchange = event => { void prepare(event.target.files); event.target.value = ''; };
    $('preparePaneClose').onclick = () => setLeft(false);
    $('preparePaneReopen').onclick = () => setLeft(pane.hidden);
    $('prepareApplyButton').onclick = () => { void applyFiles(); };
    $('prepareRemoveButton').onclick = () => { const item = selected(); if (!item || operation || inventoryPreparationOperation) return; if (item.applied) { item.remove = !item.remove; item.dirty = true; item.include = true; } else { s.preparedFiles = s.preparedFiles.filter(value => value !== item); s.selectedPreparedId = s.preparedFiles[0]?.id || ''; } preparedVersion++; renderPreparation(); };
    $('prepareFileList').onclick = event => { const target = event.target.closest('[data-prepared-id]'); if (target) { s.selectedPreparedId = target.dataset.preparedId; renderPreparation(); } };
    $('prepareFileEditor').onchange = event => {
      const item = selected(); if (!item || operation) return;
      const target = event.target;
      if (target.id === 'preparedInclude') item.include = target.checked;
      else if (target.id === 'preparedKind') { item.kind = target.value; item.mapping = null; }
      else if (target.id === 'preparedHeader') { item.headerRowIndex = Number(target.value) - 1; item.dataStartRowIndex = item.headerRowIndex + 1; item.mapping = null; }
      else if (target.id === 'preparedStart') item.dataStartRowIndex = Number(target.value) - 1;
      else if (target.id === 'preparedSheet') { const match = s.preparedFiles.find(value => value.fileHash === item.fileHash && value.sheetName === target.value); if (match) { s.selectedPreparedId = match.id; renderPreparation(); return; } }
      else if (target.dataset.mapIndex !== undefined) item.mapping[Number(target.dataset.mapIndex)] = target.value;
      item.dirty = true; preparedVersion++; validate(item); renderPreparation();
    };
    el.inventoryInspectorBody.addEventListener('input', event => { const field = event.target.dataset.inspectorField, row = activeRow(); if (!field || !row || commitLocked) return; const edit = s.inspectorEdits[rowKey(row)] ||= { values: {}, base: {} }; if (!(field in edit.base)) edit.base[field] = row[field]; edit.values[field] = event.target.value; s.workspaceChangeVersion++; });
    el.inventoryInspectorBody.addEventListener('input', event => { const field=event.target.dataset.inspectorDraft,row=activeRow(); if(!field||!row?.orderItemId||commitLocked)return;s.shipmentDraft[row.orderItemId]||={};s.shipmentDraft[row.orderItemId][field]=event.target.value;api.captureInputs();api.scheduleSave(); });
    el.inventoryInspectorBody.addEventListener('change', event => { if(event.target.dataset.inspectorDraft) api.renderResults(); });
    el.inventoryInspectorBody.addEventListener('click', event => { if (event.target.closest('[data-inspector-apply]')) applyInspector(); if (event.target.closest('[data-inspector-cancel]')) { delete s.inspectorEdits[s.selectedOrderRow]; renderInspector(); } });
    el.previewTable.addEventListener('click', event => { const tr = event.target.closest('tr[data-source-row-number]'); const input = event.target.closest('[data-order-row]') || tr?.querySelector('[data-order-row]'); const number = input?.dataset.orderRow || tr?.dataset.sourceRowNumber; const row = (s.workspace?.orders || []).find(item => String(item.sourceRowNumber) === String(number)); s.selectedOrderRow = row ? rowKey(row) : ''; renderInspector(); });
    $('shipmentOpenButton').onclick = async () => { await api.refreshShipment(); $('shipmentWorkbenchDialog').showModal(); };
    $('shipmentWorkbenchDialog').addEventListener('close', () => { api.captureInputs(); $('shipmentOpenButton').focus({ preventScroll: true }); });
    $('workbenchResetButton').onclick = async () => { if (!confirm('현재 작업과 준비 파일을 초기화할까요? 기존 복구본·Cloud·주문·출고 이력은 삭제하지 않습니다.')) return; try { await waitBoundary(); s.preparedFiles = []; s.selectedPreparedId = ''; kinds.forEach(kind => { s[kind] = null; }); api.disconnectSource(); api.reset(); s.activePreview = 'allocations'; api.refreshInputs(); renderPreparation(); api.renderTabs(); } catch (error) { status(error.message); } };
    window.addEventListener('beforeunload', event => { if (dirty() || operation || Object.values(s.inspectorEdits).some(edit => Object.keys(edit.values).length)) { event.preventDefault(); event.returnValue = ''; } });
    try { setLeft(localStorage.getItem('oneapp.orderops.file-prepare-open.v1') !== '0', false); } catch (_) { setLeft(true, false); }
    renderPreparation();
    return { prepare, dirty, hydratePrepared, renderInspector, applyLatest, runReplacement, get operation() { return operation || inventoryPreparationOperation; }, get commitLocked() { return commitLocked; }, setLeft };
  };
})(window);
