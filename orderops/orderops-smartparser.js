(function () {
  'use strict';

  const Core = window.OrderOpsSmartParserCore;
  if (!Core) {
    console.error('OrderOpsSmartParserCore를 불러오지 못했습니다.');
    return;
  }

  const STORAGE_KEYS = Object.freeze({
    sourceMappings: 'oneapp.orderops.smartparser.source-mappings.v1',
    history: 'oneapp.orderops.smartparser.history.v1',
    session: 'oneapp.orderops.smartparser.session.v1',
    savedClients: 'oneapp_saved_clients',
    savedWarehouses: 'oneapp_saved_warehouses'
  });

  const MAX_HISTORY = 200;
  const FIELD_LABELS = Object.freeze({
    documentDate: '일자',
    warehouse: '출하창고',
    client: '거래처',
    transactionType: '거래유형',
    message: '전하실말씀'
  });

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseJson(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn('OrderOps SmartParser JSON 파싱 실패', error);
      return fallback;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isNonEmpty(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  function formatNumber(value) {
    const parsed = Core.parseNumber(value);
    return parsed === null ? '' : parsed.toLocaleString('ko-KR');
  }

  function formatConfidence(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? `${Math.round(number * 100)}%` : '-';
  }

  function normalizeMasterCollection(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
  }

  class OrderOpsSmartParserDataService {
    readLocalJson(key, fallback) {
      return parseJson(localStorage.getItem(key), fallback);
    }

    writeLocalJson(key, value) {
      const serialized = JSON.stringify(value);
      localStorage.setItem(key, serialized);
      if (localStorage.getItem(key) !== serialized) {
        throw new Error(`${key} 저장 검증에 실패했습니다.`);
      }
    }

    getKnownSources() {
      return this.readLocalJson(STORAGE_KEYS.savedClients, []).filter(Boolean);
    }

    getKnownWarehouses() {
      return this.readLocalJson(STORAGE_KEYS.savedWarehouses, []).filter(Boolean);
    }

    loadSourceMappings() {
      const value = this.readLocalJson(STORAGE_KEYS.sourceMappings, {});
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    saveSourceMappings(value) {
      this.writeLocalJson(STORAGE_KEYS.sourceMappings, value || {});
    }

    appendHistory(entry) {
      const previous = this.readLocalJson(STORAGE_KEYS.history, []);
      const next = [entry, ...(Array.isArray(previous) ? previous : [])].slice(0, MAX_HISTORY);
      this.writeLocalJson(STORAGE_KEYS.history, next);
      return next;
    }

    saveSession(value) {
      try {
        sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(value));
      } catch (error) {
        console.warn('OrderOps SmartParser 세션 저장 실패', error);
      }
    }

    clearSession() {
      try {
        sessionStorage.removeItem(STORAGE_KEYS.session);
      } catch (error) {
        console.warn('OrderOps SmartParser 세션 삭제 실패', error);
      }
    }

    async readMasterViaCommonService() {
      const storage = window.ONEAPP && window.ONEAPP.STORAGE;
      if (!storage || typeof storage.readMasterState !== 'function') return [];
      const state = await storage.readMasterState();
      return normalizeMasterCollection(state && (state.items || state.masterItems || state.master));
    }

    async readMasterViaIndexedDB() {
      if (!window.indexedDB) return [];
      return new Promise((resolve, reject) => {
        let createdDuringOpen = false;
        const request = indexedDB.open('MerchOpsDB');
        request.onupgradeneeded = event => {
          createdDuringOpen = true;
          try {
            event.target.transaction.abort();
          } catch (error) {
            console.warn('빈 DB 생성 중단 실패', error);
          }
        };
        request.onerror = () => {
          if (createdDuringOpen || request.error && request.error.name === 'AbortError') resolve([]);
          else reject(request.error || new Error('마스터 IndexedDB 열기 실패'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('master_products')) {
            db.close();
            resolve([]);
            return;
          }
          const transaction = db.transaction('master_products', 'readonly');
          const readRequest = transaction.objectStore('master_products').getAll();
          readRequest.onsuccess = () => {
            db.close();
            resolve(Array.isArray(readRequest.result) ? readRequest.result : []);
          };
          readRequest.onerror = () => {
            db.close();
            reject(readRequest.error || transaction.error || new Error('마스터 조회 실패'));
          };
        };
      });
    }

    readMasterViaLocalStorage() {
      const candidates = ['merchMaster_v870', 'master_products'];
      for (const key of candidates) {
        const parsed = this.readLocalJson(key, null);
        const items = normalizeMasterCollection(parsed);
        if (items.length) return items;
      }
      return [];
    }

    async loadMasterItems() {
      const errors = [];
      try {
        const common = await this.readMasterViaCommonService();
        if (common.length) return { items: common, source: 'common-service', errors };
      } catch (error) {
        errors.push(`공통 데이터 서비스: ${error.message || error}`);
      }

      try {
        const indexed = await this.readMasterViaIndexedDB();
        if (indexed.length) return { items: indexed, source: 'indexeddb-adapter', errors };
      } catch (error) {
        errors.push(`IndexedDB 어댑터: ${error.message || error}`);
      }

      try {
        const local = this.readMasterViaLocalStorage();
        if (local.length) return { items: local, source: 'local-storage-adapter', errors };
      } catch (error) {
        errors.push(`로컬 어댑터: ${error.message || error}`);
      }

      return { items: [], source: 'none', errors };
    }
  }

  class OrderOpsInputBridge {
    constructor() {
      this.tbody = document.getElementById('orderTbody');
    }

    getHeaderElements() {
      return {
        year: document.getElementById('orderYearInput'),
        month: document.getElementById('orderMonthInput'),
        day: document.getElementById('orderDayInput'),
        warehouse: document.getElementById('warehouseInput'),
        client: document.getElementById('clientInput'),
        transactionType: document.getElementById('transactionTypeInput'),
        message: document.getElementById('orderMessageInput')
      };
    }

    readDate() {
      const elements = this.getHeaderElements();
      const year = elements.year ? elements.year.value : '';
      const month = elements.month ? elements.month.value : '';
      const day = elements.day ? elements.day.value : '';
      if (!isNonEmpty(year) && !isNonEmpty(month) && !isNonEmpty(day)) return '';
      return [year, month, day].map((value, index) => {
        if (!isNonEmpty(value)) return '';
        return index === 0 ? String(value) : String(value).padStart(2, '0');
      }).join('-');
    }

    readHeader() {
      const elements = this.getHeaderElements();
      return {
        documentDate: this.readDate(),
        warehouse: elements.warehouse ? elements.warehouse.value : '',
        client: elements.client ? elements.client.value : '',
        transactionType: elements.transactionType ? elements.transactionType.value : '',
        message: elements.message ? elements.message.value : ''
      };
    }

    readRow(row) {
      const find = field => row.querySelector(`[data-field="${field}"]`);
      return {
        itemCode: find('itemCode') ? find('itemCode').value : '',
        itemName: find('itemName') ? find('itemName').value : '',
        specification: find('specification') ? find('specification').value : '',
        quantity: find('quantity') ? find('quantity').value : '',
        price: find('price') ? find('price').value : '',
        supplyAmount: find('supplyAmount') ? find('supplyAmount').value : '',
        memo: find('memo') ? find('memo').value : '',
        description: find('description') ? find('description').value : '',
        noticePrice: find('noticePrice') ? find('noticePrice').value : ''
      };
    }

    rowHasValue(rowData) {
      return Object.entries(rowData)
        .filter(([key]) => key !== 'supplyAmount')
        .some(([, value]) => isNonEmpty(value));
    }

    readRows(options = {}) {
      if (!this.tbody) return [];
      const rows = [...this.tbody.querySelectorAll('tr')].map(row => this.readRow(row));
      return options.includeBlank ? rows : rows.filter(row => this.rowHasValue(row));
    }

    hasExistingData() {
      const header = this.readHeader();
      const headerHasValue = Object.values(header).some(isNonEmpty);
      return headerHasValue || this.readRows().length > 0;
    }

    capture() {
      const headerElements = this.getHeaderElements();
      return {
        header: Object.fromEntries(Object.entries(headerElements).map(([key, element]) => [key, element ? element.value : ''])),
        tbodyHtml: this.tbody ? this.tbody.innerHTML : '',
        totals: {
          qty: document.getElementById('totalQty') ? document.getElementById('totalQty').textContent : '',
          supply: document.getElementById('totalSupply') ? document.getElementById('totalSupply').textContent : '',
          notice: document.getElementById('totalNotice') ? document.getElementById('totalNotice').textContent : ''
        }
      };
    }

    restore(snapshot) {
      if (!snapshot) return;
      const headerElements = this.getHeaderElements();
      Object.entries(snapshot.header || {}).forEach(([key, value]) => {
        if (headerElements[key]) headerElements[key].value = value;
      });
      if (this.tbody) this.tbody.innerHTML = snapshot.tbodyHtml || '';
      if (typeof window.calculateTotals === 'function') window.calculateTotals();
    }

    ensureSelectValue(select, value) {
      if (!select) return;
      const normalized = String(value || '');
      if (![...select.options].some(option => option.value === normalized)) {
        const option = document.createElement('option');
        option.value = normalized;
        option.textContent = normalized;
        select.appendChild(option);
      }
      select.value = normalized;
    }

    setDate(value) {
      if (!isNonEmpty(value)) return;
      const match = String(value).match(/(\d{4})\D*(\d{1,2})?\D*(\d{1,2})?/);
      if (!match) return;
      const elements = this.getHeaderElements();
      if (match[1]) this.ensureSelectValue(elements.year, match[1]);
      if (match[2]) this.ensureSelectValue(elements.month, String(match[2]).padStart(2, '0'));
      if (match[3] && elements.day) elements.day.value = String(match[3]).padStart(2, '0');
    }

    applyHeader(resolvedHeader) {
      const elements = this.getHeaderElements();
      if (isNonEmpty(resolvedHeader.documentDate)) this.setDate(resolvedHeader.documentDate);
      if (Object.prototype.hasOwnProperty.call(resolvedHeader, 'warehouse') && elements.warehouse) elements.warehouse.value = resolvedHeader.warehouse || '';
      if (Object.prototype.hasOwnProperty.call(resolvedHeader, 'client') && elements.client) elements.client.value = resolvedHeader.client || '';
      if (Object.prototype.hasOwnProperty.call(resolvedHeader, 'transactionType') && elements.transactionType) this.ensureSelectValue(elements.transactionType, resolvedHeader.transactionType || '');
      if (Object.prototype.hasOwnProperty.call(resolvedHeader, 'message') && elements.message) elements.message.value = resolvedHeader.message || '';
    }

    createRow(rowData, index) {
      const row = document.createElement('tr');
      const fields = [
        ['itemCode', 'text', '코드', ''],
        ['itemName', 'text', '품목명 검색', ''],
        ['specification', 'text', '', ''],
        ['quantity', 'number', '', 'qty-input number'],
        ['price', 'number', '', 'price-input number'],
        ['supplyAmount', 'text', '', 'supply-price number'],
        ['memo', 'text', '', ''],
        ['description', 'text', '', ''],
        ['noticePrice', 'number', '', 'number']
      ];

      const selectorCell = document.createElement('td');
      const label = document.createElement('label');
      label.className = 'row-check-wrap';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const number = document.createElement('span');
      number.className = 'row-num-display';
      number.textContent = String(index + 1);
      label.append(checkbox, number);
      selectorCell.appendChild(label);
      row.appendChild(selectorCell);

      fields.forEach(([field, type, placeholder, extraClass]) => {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = type;
        input.className = `grid-input ${extraClass}`.trim();
        input.dataset.field = field;
        input.placeholder = placeholder;
        const rawValue = rowData && rowData[field];
        input.value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
        if (field === 'supplyAmount') {
          input.readOnly = true;
          input.tabIndex = -1;
        }
        cell.appendChild(input);
        row.appendChild(cell);
      });
      return row;
    }

    replaceRows(rows) {
      if (!this.tbody) throw new Error('OrderOps 입력 그리드를 찾지 못했습니다.');
      this.tbody.innerHTML = '';
      const normalized = Array.isArray(rows) ? rows : [];
      const minimumRows = Math.max(3, normalized.length);
      for (let index = 0; index < minimumRows; index += 1) {
        this.tbody.appendChild(this.createRow(normalized[index] || {}, index));
      }
    }

    applyPayload(payload, options) {
      const mode = options && options.mode === 'replace' ? 'replace' : 'add';
      const existingRows = this.readRows();
      const incomingRows = payload.items.map(item => ({
        itemCode: item.itemCode,
        itemName: item.itemName,
        specification: item.specification,
        quantity: item.quantity,
        price: item.price === null ? '' : item.price,
        supplyAmount: '',
        memo: item.memo,
        description: item.description,
        noticePrice: item.noticePrice === null ? '' : item.noticePrice
      }));
      this.replaceRows(mode === 'replace' ? incomingRows : [...existingRows, ...incomingRows]);
      this.applyHeader(options.resolvedHeader || {});
      if (typeof window.calculateTotals === 'function') window.calculateTotals();
    }
  }

  class OrderOpsSmartParserController {
    constructor(rootElement) {
      this.root = rootElement;
      this.dataService = new OrderOpsSmartParserDataService();
      this.bridge = new OrderOpsInputBridge();
      this.masterItems = [];
      this.masterIndex = Core.buildMasterIndex([]);
      this.sourceMappings = {};
      this.openSnapshot = null;
      this.imageObjectUrl = '';
      this.state = this.createInitialState();
      this.bindRootEvents();
    }

    createInitialState() {
      const currentHeader = this.bridge.readHeader();
      return {
        isOpen: false,
        step: 'input',
        inputMode: 'text',
        rawText: '',
        imageFile: null,
        imageName: '',
        documentType: '주문',
        sourceName: '',
        sourceRole: '주문처',
        client: currentHeader.client || '',
        warehouse: currentHeader.warehouse || '',
        transactionType: currentHeader.transactionType || '',
        documentDate: '',
        orderMessage: '',
        document: null,
        showIssuesOnly: true,
        applyMode: 'add',
        headerChoices: {},
        manualCandidates: {},
        initialMatchSnapshot: [],
        busy: false,
        busyMessage: '',
        feedback: '',
        feedbackTone: 'info',
        masterSource: '',
        masterErrors: []
      };
    }

    bindRootEvents() {
      this.root.addEventListener('click', event => this.handleClick(event));
      this.root.addEventListener('change', event => this.handleChange(event));
      this.root.addEventListener('input', event => this.handleInput(event));
      this.root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.state.isOpen && !this.state.busy) this.cancel();
      });
    }

    async open() {
      this.state = this.createInitialState();
      this.state.isOpen = true;
      this.openSnapshot = this.bridge.capture();
      this.sourceMappings = this.dataService.loadSourceMappings();
      this.render();
      document.body.classList.add('osp-modal-open');

      this.setBusy(true, '마스터 품목을 불러오는 중입니다.');
      try {
        const result = await this.dataService.loadMasterItems();
        this.masterItems = result.items;
        this.masterIndex = Core.buildMasterIndex(result.items);
        this.state.masterSource = result.source;
        this.state.masterErrors = result.errors;
        if (!result.items.length) {
          this.setMessage('마스터 품목을 불러오지 못했습니다. 파싱은 가능하지만 완료하려면 마스터 연결이 필요합니다.', 'warning');
        } else {
          this.setMessage(`마스터 ${result.items.length.toLocaleString()}개를 읽었습니다.`, 'success');
        }
      } catch (error) {
        this.masterItems = [];
        this.masterIndex = Core.buildMasterIndex([]);
        this.setMessage(`마스터 조회 실패: ${error.message || error}`, 'error');
      } finally {
        this.setBusy(false);
      }
    }

    close(options = {}) {
      if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
      this.imageObjectUrl = '';
      this.state.isOpen = false;
      this.dataService.clearSession();
      document.body.classList.remove('osp-modal-open');
      this.render();
      if (options.message && typeof window.updateSystemMessage === 'function') {
        window.updateSystemMessage(options.message);
      }
    }

    cancel() {
      if (this.state.busy) return;
      this.close({ message: 'SmartParser 작업을 취소했습니다. 기존 입력값은 유지됩니다.' });
    }

    setBusy(value, message = '') {
      this.state.busy = !!value;
      this.state.busyMessage = message;
      this.render();
    }

    setMessage(message, tone = 'info') {
      this.state.feedback = message || '';
      this.state.feedbackTone = tone;
      this.render();
    }

    syncInputForm() {
      const read = name => {
        const element = this.root.querySelector(`[data-state-field="${name}"]`);
        return element ? element.value : this.state[name];
      };
      ['rawText', 'documentType', 'sourceName', 'sourceRole', 'client', 'warehouse', 'transactionType', 'documentDate', 'orderMessage'].forEach(name => {
        this.state[name] = read(name) || '';
      });
    }

    async parseCurrentInput() {
      this.syncInputForm();
      if (!this.state.rawText.trim()) {
        this.setMessage('분석할 텍스트를 입력하거나 이미지 OCR을 실행해 주세요.', 'warning');
        return;
      }

      this.setBusy(true, '텍스트를 구조화하고 마스터와 매칭하는 중입니다.');
      try {
        const knownSources = this.dataService.getKnownSources();
        const parsed = Core.parseText(this.state.rawText, {
          inputType: this.state.inputMode === 'image' ? 'image' : 'text',
          documentType: this.state.documentType,
          sourceName: this.state.sourceName,
          sourceRole: this.state.sourceRole,
          client: this.state.client,
          warehouse: this.state.warehouse,
          transactionType: this.state.transactionType,
          documentDate: this.state.documentDate,
          message: this.state.orderMessage,
          knownSources
        });
        this.state.document = Core.matchDocument(parsed, this.masterItems, this.sourceMappings);
        this.state.initialMatchSnapshot = this.state.document.items.map(item => ({
          rowId: item.rowId,
          sourceText: item.sourceText,
          sourceItemText: item.sourceItemText,
          status: item.mappingStatus,
          confidence: item.mappingConfidence,
          reason: item.mappingReason,
          masterItemCode: item.master && item.master.code || ''
        }));
        this.state.step = 'review';
        this.state.showIssuesOnly = true;
        this.state.applyMode = 'add';
        this.initializeHeaderChoices();
        this.dataService.saveSession({
          savedAt: new Date().toISOString(),
          document: this.state.document
        });
        const summary = Core.summarize(this.state.document);
        this.state.feedback = summary.blocking
          ? `${summary.total}개 품목 중 ${summary.blocking}개 확인이 필요합니다.`
          : `${summary.total}개 품목이 모두 검증되었습니다.`;
        this.state.feedbackTone = summary.blocking ? 'warning' : 'success';
      } catch (error) {
        console.error(error);
        this.state.feedback = `파싱 실패: ${error.message || error}`;
        this.state.feedbackTone = 'error';
      } finally {
        this.state.busy = false;
        this.state.busyMessage = '';
        this.render();
      }
    }

    initializeHeaderChoices() {
      const conflicts = this.getHeaderConflicts();
      this.state.headerChoices = Object.fromEntries(conflicts.map(conflict => [conflict.field, 'existing']));
    }

    getParserHeader() {
      const document = this.state.document || {};
      const header = document.header || {};
      return {
        documentDate: document.documentDate || '',
        warehouse: header.warehouse || '',
        client: header.client || '',
        transactionType: header.transactionType || '',
        message: header.message || ''
      };
    }

    getHeaderConflicts() {
      const existing = this.bridge.readHeader();
      const parser = this.getParserHeader();
      return Object.keys(FIELD_LABELS).filter(field =>
        isNonEmpty(existing[field]) && isNonEmpty(parser[field]) && String(existing[field]) !== String(parser[field])
      ).map(field => ({
        field,
        label: FIELD_LABELS[field],
        existing: existing[field],
        parser: parser[field]
      }));
    }

    resolveHeader() {
      const existing = this.bridge.readHeader();
      const parser = this.getParserHeader();
      const resolved = {};
      Object.keys(FIELD_LABELS).forEach(field => {
        const parserValue = parser[field];
        const existingValue = existing[field];
        if (!isNonEmpty(parserValue)) return;
        const hasConflict = isNonEmpty(existingValue) && String(existingValue) !== String(parserValue);
        if (hasConflict && this.state.headerChoices[field] !== 'parser') {
          resolved[field] = existingValue;
        } else {
          resolved[field] = parserValue;
        }
      });
      return resolved;
    }

    searchMaster(keyword) {
      const compact = Core.normalizeText(keyword);
      if (!compact) return [];
      return this.masterIndex.records
        .map(record => {
          const code = Core.normalizeText(record.code);
          const name = Core.normalizeText(record.itemName);
          const spec = Core.normalizeText(record.specification);
          let score = 0;
          if (code === compact) score += 100;
          else if (code.includes(compact)) score += 60;
          if (name === compact) score += 90;
          else if (name.includes(compact) || compact.includes(name)) score += 50;
          if (spec && spec.includes(compact)) score += 20;
          return { ...record, score };
        })
        .filter(record => record.score > 0)
        .sort((a, b) => b.score - a.score || a.itemName.localeCompare(b.itemName, 'ko'))
        .slice(0, 12);
    }

    updateWorkFromElement(element) {
      if (!this.state.document) return;
      const rowId = element.dataset.rowId;
      const field = element.dataset.workField;
      if (!rowId || !field) return;
      this.state.document = Core.updateItemWork(this.state.document, rowId, { [field]: element.value });
      this.dataService.saveSession({ savedAt: new Date().toISOString(), document: this.state.document });
      this.renderReviewOnly();
    }

    chooseMaster(rowId, code) {
      if (!code) return;
      try {
        this.state.document = Core.chooseMaster(this.state.document, rowId, code, this.masterItems, 'user');
        this.state.manualCandidates[rowId] = [];
        this.state.feedback = '선택한 마스터 품목을 작업값에 반영했습니다. 아직 OrderOps에는 적용되지 않았습니다.';
        this.state.feedbackTone = 'success';
        this.dataService.saveSession({ savedAt: new Date().toISOString(), document: this.state.document });
        this.render();
      } catch (error) {
        this.setMessage(error.message || String(error), 'error');
      }
    }

    async runImageOcr() {
      const input = this.root.querySelector('[data-role="image-file"]');
      const file = input && input.files && input.files[0] ? input.files[0] : this.state.imageFile;
      if (!file) {
        this.setMessage('OCR을 실행할 이미지를 선택해 주세요.', 'warning');
        return;
      }

      this.state.imageFile = file;
      this.state.imageName = file.name;
      this.setBusy(true, '이미지 OCR 모듈을 준비하는 중입니다.');
      try {
        let text = '';
        const customAdapter = window.OrderOpsSmartParserAdapters && window.OrderOpsSmartParserAdapters.ocrImage;
        if (typeof customAdapter === 'function') {
          text = await customAdapter(file, progress => {
            this.state.busyMessage = progress || '이미지를 분석하는 중입니다.';
            this.render();
          });
        } else {
          await this.ensureTesseract();
          if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
            throw new Error('이미지 OCR 모듈을 불러오지 못했습니다.');
          }
          let worker = null;
          try {
            worker = await window.Tesseract.createWorker(['kor', 'eng'], 1, {
              logger: message => {
                if (message && message.status) {
                  const percent = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : '';
                  this.state.busyMessage = `이미지 OCR: ${message.status}${percent}`;
                  this.render();
                }
              }
            });
            const result = await worker.recognize(file);
            text = result && result.data ? result.data.text : '';
          } finally {
            if (worker && typeof worker.terminate === 'function') await worker.terminate();
          }
        }
        if (!String(text || '').trim()) throw new Error('이미지에서 텍스트를 찾지 못했습니다.');
        this.state.rawText = String(text).trim();
        this.state.inputMode = 'image';
        this.state.feedback = 'OCR 원문을 추출했습니다. 내용을 확인한 뒤 분석을 시작하세요.';
        this.state.feedbackTone = 'success';
      } catch (error) {
        console.error(error);
        this.state.feedback = `이미지 OCR 실패: ${error.message || error}`;
        this.state.feedbackTone = 'error';
      } finally {
        this.state.busy = false;
        this.state.busyMessage = '';
        this.render();
      }
    }

    ensureTesseract() {
      if (window.Tesseract) return Promise.resolve();
      if (this.tesseractPromise) return this.tesseractPromise;
      this.tesseractPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Tesseract.js CDN 연결에 실패했습니다.'));
        document.head.appendChild(script);
      });
      return this.tesseractPromise;
    }

    async applyToOrderOps() {
      if (!this.state.document || this.state.busy) return;
      let payload;
      try {
        payload = Core.buildOrderOpsPayload(this.state.document);
      } catch (error) {
        const issues = error.issues || [];
        const detail = issues.slice(0, 3).map(issue => `${issue.rowNumber ? `${issue.rowNumber}행: ` : ''}${issue.message}`).join(' / ');
        this.setMessage(detail || error.message || '확인 필요한 항목을 해결해 주세요.', 'error');
        return;
      }

      this.setBusy(true, '검증된 작업값을 OrderOps 입력 화면에 반영하는 중입니다.');
      const domSnapshot = this.bridge.capture();
      const previousMappings = cloneJson(this.sourceMappings);
      let mappingSaved = false;
      try {
        const nextMappings = Core.collectSourceMappings(this.state.document, this.sourceMappings, 'OrderOps 사용자');
        this.dataService.saveSourceMappings(nextMappings);
        mappingSaved = true;
        this.bridge.applyPayload(payload, {
          mode: this.state.applyMode,
          resolvedHeader: this.resolveHeader()
        });
        this.dataService.appendHistory({
          historyId: Core.uid('history'),
          documentId: payload.documentId,
          inputType: payload.inputType,
          source: payload.source,
          parsedAt: this.state.document.parsedAt,
          appliedAt: new Date().toISOString(),
          initialParsedValues: this.state.document.items.map(item => ({ sourceText: item.sourceText, parsed: item.parsed })),
          automaticMappingResults: cloneJson(this.state.initialMatchSnapshot || []),
          userMappingChanges: this.state.document.items
            .filter(item => item.userConfirmedMapping)
            .map(item => {
              const initial = (this.state.initialMatchSnapshot || []).find(snapshot => snapshot.rowId === item.rowId) || {};
              return {
                rowId: item.rowId,
                sourceItemText: item.sourceItemText,
                beforeMasterItemCode: initial.masterItemCode || '',
                afterMasterItemCode: item.master && item.master.code || '',
                changedAt: new Date().toISOString()
              };
            }),
          finalWorkValues: payload,
          applyMode: this.state.applyMode,
          orderOpsApplied: true
        });
        this.sourceMappings = nextMappings;
        this.close({ message: `SmartParser ${payload.items.length}개 품목을 ${this.state.applyMode === 'replace' ? '교체' : '추가'}했습니다. 저장 전 최종 확인이 필요합니다.` });
      } catch (error) {
        console.error(error);
        this.bridge.restore(domSnapshot);
        if (mappingSaved) {
          try {
            this.dataService.saveSourceMappings(previousMappings);
          } catch (restoreError) {
            console.error('출처별 매핑 복구 실패', restoreError);
          }
        }
        this.state.busy = false;
        this.state.busyMessage = '';
        this.state.feedback = `OrderOps 반영 실패: ${error.message || error}. 기존 입력 상태로 복구했습니다.`;
        this.state.feedbackTone = 'error';
        this.render();
      }
    }

    handleClick(event) {
      const actionElement = event.target.closest('[data-action]');
      if (!actionElement || !this.state.isOpen) return;
      const action = actionElement.dataset.action;
      if (this.state.busy && !['noop'].includes(action)) return;

      if (action === 'cancel' || action === 'close') this.cancel();
      else if (action === 'set-input-mode') {
        this.syncInputForm();
        this.state.inputMode = actionElement.dataset.mode || 'text';
        this.render();
      } else if (action === 'parse') this.parseCurrentInput();
      else if (action === 'back-input') {
        this.state.step = 'input';
        this.render();
      } else if (action === 'toggle-issues') {
        this.state.showIssuesOnly = !this.state.showIssuesOnly;
        this.render();
      } else if (action === 'select-master-button') {
        this.chooseMaster(actionElement.dataset.rowId, actionElement.dataset.code);
      } else if (action === 'search-master') {
        const rowId = actionElement.dataset.rowId;
        const input = this.root.querySelector(`[data-role="master-search"][data-row-id="${CSS.escape(rowId)}"]`);
        const keyword = input ? input.value : '';
        this.state.manualCandidates[rowId] = this.searchMaster(keyword);
        this.render();
      } else if (action === 'mark-new') {
        this.state.document = Core.markAsNew(this.state.document, actionElement.dataset.rowId);
        this.state.feedback = '신규품목으로 표시했습니다. 1차 개발에서는 신규등록 연결 전까지 완료할 수 없습니다.';
        this.state.feedbackTone = 'warning';
        this.render();
      } else if (action === 'run-ocr') this.runImageOcr();
      else if (action === 'apply') this.applyToOrderOps();
    }

    handleChange(event) {
      const target = event.target;
      if (!this.state.isOpen) return;
      if (target.matches('[data-state-field]')) {
        this.state[target.dataset.stateField] = target.value;
      }
      if (target.matches('[data-action="choose-master"]')) {
        this.chooseMaster(target.dataset.rowId, target.value);
      }
      if (target.matches('[data-action="apply-mode"]')) {
        this.state.applyMode = target.value;
        this.render();
      }
      if (target.matches('[data-action="header-choice"]')) {
        this.state.headerChoices[target.dataset.field] = target.value;
      }
      if (target.matches('[data-role="image-file"]')) {
        const file = target.files && target.files[0];
        if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
        this.imageObjectUrl = file ? URL.createObjectURL(file) : '';
        this.state.imageFile = file || null;
        this.state.imageName = file ? file.name : '';
        this.render();
      }
      if (target.matches('[data-work-field]')) this.updateWorkFromElement(target);
    }

    handleInput(event) {
      const target = event.target;
      if (!this.state.isOpen) return;
      if (target.matches('[data-state-field]')) this.state[target.dataset.stateField] = target.value;
      if (target.matches('[data-work-field]')) {
        clearTimeout(this.workInputTimer);
        this.workInputTimer = setTimeout(() => this.updateWorkFromElement(target), 180);
      }
    }

    renderReviewOnly() {
      this.render();
    }

    renderMessage() {
      if (!this.state.feedback) return '';
      return `<div class="osp-message osp-message-${escapeHtml(this.state.feedbackTone)}">${escapeHtml(this.state.feedback)}</div>`;
    }

    renderBusy() {
      if (!this.state.busy) return '';
      return `<div class="osp-busy" role="status" aria-live="polite"><div class="osp-spinner"></div><strong>${escapeHtml(this.state.busyMessage || '처리 중입니다.')}</strong></div>`;
    }

    renderStepIndicator() {
      const inputActive = this.state.step === 'input';
      return `<div class="osp-steps" aria-label="SmartParser 작업 단계">
        <div class="osp-step ${inputActive ? 'is-active' : 'is-done'}"><span>1</span><b>자료 입력</b></div>
        <div class="osp-step-line"></div>
        <div class="osp-step ${inputActive ? '' : 'is-active'}"><span>2</span><b>매핑·검증</b></div>
        <div class="osp-step-line"></div>
        <div class="osp-step"><span>3</span><b>OrderOps 반영</b></div>
      </div>`;
    }

    renderInputStep() {
      const mode = this.state.inputMode;
      const imagePreview = this.imageObjectUrl
        ? `<img src="${escapeHtml(this.imageObjectUrl)}" alt="선택한 원본 이미지 미리보기">`
        : '<div class="osp-image-empty">이미지 파일을 선택하면 여기에 표시됩니다.</div>';
      return `<div class="osp-body osp-input-body">
        ${this.renderMessage()}
        <section class="osp-context-panel">
          <div class="osp-section-title"><span>1</span><div><b>문서 기준</b><small>문서 출처와 OrderOps 전표 정보를 구분합니다.</small></div></div>
          <div class="osp-form-grid">
            <label><span>문서 종류</span><select data-state-field="documentType">
              ${['주문', '구매', '품목정보', '기타'].map(value => `<option value="${value}" ${this.state.documentType === value ? 'selected' : ''}>${value}</option>`).join('')}
            </select></label>
            <label><span>문서 출처</span><input data-state-field="sourceName" value="${escapeHtml(this.state.sourceName)}" placeholder="예: 중앙167, A농산, 내부직원"></label>
            <label><span>출처 역할</span><select data-state-field="sourceRole">
              ${['주문처', '공급처', '납품처', '내부직원', '기타'].map(value => `<option value="${value}" ${this.state.sourceRole === value ? 'selected' : ''}>${value}</option>`).join('')}
            </select></label>
            <label><span>전표 거래처</span><input data-state-field="client" value="${escapeHtml(this.state.client)}" placeholder="문서 출처와 다를 수 있습니다."></label>
            <label><span>출하창고</span><input data-state-field="warehouse" value="${escapeHtml(this.state.warehouse)}" placeholder="인식값이 없으면 공란 유지"></label>
            <label><span>문서 일자</span><input type="date" data-state-field="documentDate" value="${escapeHtml(this.state.documentDate)}"></label>
            <label><span>거래유형</span><input data-state-field="transactionType" value="${escapeHtml(this.state.transactionType)}" placeholder="예: 기타, 현금"></label>
            <label class="osp-grid-wide"><span>전하실말씀</span><input data-state-field="orderMessage" value="${escapeHtml(this.state.orderMessage)}" placeholder="원문에 있는 경우만 입력"></label>
          </div>
        </section>

        <section class="osp-source-panel">
          <div class="osp-section-title"><span>2</span><div><b>자료 입력</b><small>입력 경로가 달라도 동일한 Parser Core로 처리합니다.</small></div></div>
          <div class="osp-input-tabs">
            <button type="button" data-action="set-input-mode" data-mode="text" class="${mode === 'text' ? 'is-active' : ''}"><strong>텍스트</strong><small>직접 입력·붙여넣기</small></button>
            <button type="button" data-action="set-input-mode" data-mode="image" class="${mode === 'image' ? 'is-active' : ''}"><strong>사진</strong><small>이미지 OCR</small></button>
            <button type="button" disabled><strong>파일</strong><small>PDF·Excel 후속 업데이트</small></button>
            <button type="button" disabled><strong>음성</strong><small>음성→텍스트 후속 업데이트</small></button>
          </div>
          ${mode === 'image' ? `<div class="osp-image-workspace">
            <div class="osp-image-preview">${imagePreview}</div>
            <div class="osp-image-actions">
              <label class="osp-file-button"><input type="file" accept="image/*" capture="environment" data-role="image-file"><span>사진 촬영·이미지 선택</span></label>
              <div class="osp-file-name">${escapeHtml(this.state.imageName || '선택된 이미지 없음')}</div>
              <button type="button" class="osp-button osp-button-secondary" data-action="run-ocr">OCR 원문 추출</button>
              <small>기본 OCR은 브라우저에서 실행합니다. 네트워크가 차단된 환경에서는 별도 OCR 어댑터가 필요합니다.</small>
            </div>
          </div>` : ''}
          <div class="osp-text-workspace">
            <div class="osp-text-head"><b>${mode === 'image' ? 'OCR 원문 확인·수정' : '주문·구매 원문'}</b><small>헤더는 ‘거래처: 중앙167’처럼 입력할 수 있습니다.</small></div>
            <textarea data-state-field="rawText" placeholder="예시&#10;거래처: 중앙167&#10;케일 2키로 10박스 9천원&#10;고수 한단 2개 만오천원">${escapeHtml(this.state.rawText)}</textarea>
          </div>
        </section>
      </div>
      <footer class="osp-footer">
        <button type="button" class="osp-button osp-button-ghost" data-action="cancel">취소</button>
        <div class="osp-footer-spacer"></div>
        <span class="osp-master-status">마스터 ${this.masterItems.length.toLocaleString()}개 · ${escapeHtml(this.state.masterSource || '조회 전')}</span>
        <button type="button" class="osp-button osp-button-primary" data-action="parse">파싱 및 마스터 매칭</button>
      </footer>`;
    }

    renderStatusBadge(item) {
      const label = Core.STATUS_LABELS[item.mappingStatus] || item.mappingStatus;
      return `<span class="osp-status osp-status-${escapeHtml(item.mappingStatus)}">${escapeHtml(label)}</span>`;
    }

    renderCandidateOptions(item) {
      const manual = this.state.manualCandidates[item.rowId] || [];
      const candidates = [...(item.candidates || []), ...manual];
      const unique = [];
      const seen = new Set();
      if (item.master && item.master.code) {
        unique.push({
          code: item.master.code,
          itemName: item.master.itemName,
          specification: item.master.specification,
          unit: item.master.unit,
          score: item.mappingConfidence
        });
        seen.add(item.master.code);
      }
      candidates.forEach(candidate => {
        if (!candidate || !candidate.code || seen.has(candidate.code)) return;
        seen.add(candidate.code);
        unique.push(candidate);
      });
      return unique.map(candidate => `<option value="${escapeHtml(candidate.code)}" ${item.master && item.master.code === candidate.code ? 'selected' : ''}>${escapeHtml(candidate.code)} · ${escapeHtml(candidate.itemName)} ${candidate.specification ? `(${escapeHtml(candidate.specification)})` : ''}</option>`).join('');
    }

    renderReviewItem(item, index) {
      const issues = [...new Set(item.validationMessages || [])];
      const candidateOptions = this.renderCandidateOptions(item);
      const selectedMaster = item.master
        ? `<div class="osp-master-selected"><code>${escapeHtml(item.master.code)}</code><div><b>${escapeHtml(item.master.itemName)}</b><small>${escapeHtml([item.master.specification, item.master.unit].filter(Boolean).join(' · '))}</small></div></div>`
        : '<div class="osp-master-empty">연결된 마스터 품목이 없습니다.</div>';
      return `<article class="osp-review-card ${issues.length || Core.BLOCKING_STATUSES.has(item.mappingStatus) ? 'has-issue' : 'is-normal'}" data-review-row="${escapeHtml(item.rowId)}">
        <header class="osp-review-card-head">
          <div><span class="osp-row-number">${index + 1}</span>${this.renderStatusBadge(item)}<b>${escapeHtml(item.mappingReason || '')}</b></div>
          <span class="osp-confidence">신뢰도 ${formatConfidence(item.mappingConfidence)}</span>
        </header>
        <div class="osp-compare-grid">
          <section class="osp-compare-column osp-original-column">
            <h4>원본</h4>
            <p>${escapeHtml(item.sourceText)}</p>
            <small>출처별 매핑키: ${escapeHtml(item.sourceItemText || '-')}</small>
          </section>
          <section class="osp-compare-column">
            <h4>파싱값</h4>
            <dl>
              <div><dt>품목</dt><dd>${escapeHtml(item.parsed.itemName || '-')}</dd></div>
              <div><dt>규격/단위</dt><dd>${escapeHtml([item.parsed.specification, item.parsed.unit].filter(Boolean).join(' · ') || '-')}</dd></div>
              <div><dt>수량</dt><dd>${escapeHtml(item.parsed.quantity === null ? '-' : item.parsed.quantity)} ${escapeHtml(item.parsed.quantityUnit || '')}</dd></div>
              <div><dt>단가</dt><dd>${item.parsed.price === null ? '-' : formatNumber(item.parsed.price)}</dd></div>
              <div><dt>원본 금액</dt><dd>${item.parsed.sourceAmount === null ? '-' : formatNumber(item.parsed.sourceAmount)}</dd></div>
              <div><dt>계산 금액</dt><dd>${item.parsed.calculatedAmount === null ? '-' : formatNumber(item.parsed.calculatedAmount)}</dd></div>
            </dl>
          </section>
          <section class="osp-compare-column osp-master-column">
            <h4>마스터</h4>
            ${selectedMaster}
            <select data-action="choose-master" data-row-id="${escapeHtml(item.rowId)}">
              <option value="">마스터 후보 선택</option>
              ${candidateOptions}
            </select>
            <div class="osp-master-search"><input data-role="master-search" data-row-id="${escapeHtml(item.rowId)}" placeholder="코드·품목명 검색"><button type="button" data-action="search-master" data-row-id="${escapeHtml(item.rowId)}">검색</button></div>
            <div class="osp-search-results">${(this.state.manualCandidates[item.rowId] || []).map(candidate => `<button type="button" data-action="select-master-button" data-row-id="${escapeHtml(item.rowId)}" data-code="${escapeHtml(candidate.code)}"><code>${escapeHtml(candidate.code)}</code><span>${escapeHtml(candidate.itemName)} ${candidate.specification ? `(${escapeHtml(candidate.specification)})` : ''}</span></button>`).join('')}</div>
            ${!item.master ? `<button type="button" class="osp-link-button" data-action="mark-new" data-row-id="${escapeHtml(item.rowId)}">신규품목으로 구분</button>` : ''}
          </section>
          <section class="osp-compare-column osp-work-column">
            <h4>OrderOps 작업값</h4>
            <div class="osp-work-grid">
              <label><span>품목코드</span><input value="${escapeHtml(item.work.itemCode || '')}" readonly></label>
              <label><span>품목명</span><input data-work-field="itemName" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.itemName || '')}"></label>
              <label><span>규격</span><input data-work-field="specification" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.specification || '')}"></label>
              <label><span>단위</span><input data-work-field="unit" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.unit || '')}"></label>
              <label><span>수량</span><input type="number" data-work-field="quantity" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.quantity === null ? '' : item.work.quantity)}"></label>
              <label><span>단가</span><input type="number" data-work-field="price" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.price === null ? '' : item.work.price)}"></label>
              <label class="osp-grid-wide"><span>메모</span><input data-work-field="memo" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.memo || '')}"></label>
              <label><span>적요</span><input data-work-field="description" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.description || '')}"></label>
              <label><span>공지단가</span><input type="number" data-work-field="noticePrice" data-row-id="${escapeHtml(item.rowId)}" value="${escapeHtml(item.work.noticePrice === null ? '' : item.work.noticePrice)}"></label>
            </div>
          </section>
        </div>
        ${issues.length ? `<div class="osp-issue-list">${issues.map(issue => `<span>${escapeHtml(issue)}</span>`).join('')}</div>` : ''}
      </article>`;
    }

    renderHeaderConflicts() {
      const conflicts = this.getHeaderConflicts();
      if (!conflicts.length) return '<div class="osp-no-conflict">상단 전표정보 충돌이 없습니다. 인식된 값이 있는 필드만 반영합니다.</div>';
      return `<div class="osp-conflicts"><b>상단 전표정보 충돌 ${conflicts.length}건</b>${conflicts.map(conflict => `<div class="osp-conflict-row">
        <span>${escapeHtml(conflict.label)}</span>
        <label><input type="radio" name="header-${escapeHtml(conflict.field)}" data-action="header-choice" data-field="${escapeHtml(conflict.field)}" value="existing" ${this.state.headerChoices[conflict.field] !== 'parser' ? 'checked' : ''}><em>기존 유지</em><strong>${escapeHtml(conflict.existing)}</strong></label>
        <label><input type="radio" name="header-${escapeHtml(conflict.field)}" data-action="header-choice" data-field="${escapeHtml(conflict.field)}" value="parser" ${this.state.headerChoices[conflict.field] === 'parser' ? 'checked' : ''}><em>Parser 적용</em><strong>${escapeHtml(conflict.parser)}</strong></label>
      </div>`).join('')}</div>`;
    }

    renderReviewStep() {
      const summary = Core.summarize(this.state.document);
      const allItems = this.state.document ? this.state.document.items : [];
      const visibleItems = this.state.showIssuesOnly
        ? allItems.filter(item => Core.BLOCKING_STATUSES.has(item.mappingStatus) || (item.validationMessages || []).length)
        : allItems;
      const existingRows = this.bridge.readRows().length;
      return `<div class="osp-body osp-review-body">
        ${this.renderMessage()}
        <section class="osp-summary-bar">
          <div><span>전체</span><strong>${summary.total}</strong></div>
          <div class="is-good"><span>확정</span><strong>${summary.confirmed}</strong></div>
          <div class="is-warning"><span>후보</span><strong>${summary.candidate}</strong></div>
          <div class="is-danger"><span>미매핑</span><strong>${summary.unmapped}</strong></div>
          <div class="is-muted"><span>신규</span><strong>${summary.new}</strong></div>
          <div class="is-danger"><span>오류</span><strong>${summary.error}</strong></div>
          <button type="button" data-action="toggle-issues">${this.state.showIssuesOnly ? '정상행 포함 전체 보기' : '확인 필요행만 보기'}</button>
        </section>
        <section class="osp-review-list">
          ${visibleItems.length ? visibleItems.map((item, index) => this.renderReviewItem(item, allItems.indexOf(item))).join('') : `<div class="osp-all-clear"><strong>확인 필요한 품목이 없습니다.</strong><span>전체 ${summary.total}개 품목이 자동 검증을 통과했습니다.</span><button type="button" data-action="toggle-issues">전체 작업값 확인</button></div>`}
        </section>
        <section class="osp-apply-panel">
          <div class="osp-section-title"><span>3</span><div><b>OrderOps 반영 방식</b><small>SmartParser 완료는 전표 저장이 아니라 입력 화면 전달입니다.</small></div></div>
          <div class="osp-apply-options">
            <label><input type="radio" name="applyMode" data-action="apply-mode" value="add" ${this.state.applyMode === 'add' ? 'checked' : ''}><div><b>기존 내용 유지 후 추가</b><small>기존 ${existingRows}개 품목을 유지하고 새 품목을 뒤에 추가합니다. 동일 품목도 자동 합산하지 않습니다.</small></div></label>
            <label><input type="radio" name="applyMode" data-action="apply-mode" value="replace" ${this.state.applyMode === 'replace' ? 'checked' : ''}><div><b>기존 품목 교체</b><small>사용자가 명시적으로 선택한 경우에만 기존 품목행을 교체합니다. 실패하면 원상복구합니다.</small></div></label>
          </div>
          ${this.renderHeaderConflicts()}
        </section>
      </div>
      <footer class="osp-footer">
        <button type="button" class="osp-button osp-button-ghost" data-action="cancel">취소</button>
        <button type="button" class="osp-button osp-button-secondary" data-action="back-input">자료 입력으로</button>
        <div class="osp-footer-spacer"></div>
        <span class="osp-blocking-count ${summary.blocking ? 'has-blocking' : ''}">${summary.blocking ? `완료 차단 ${summary.blocking}건` : '완료 가능'}</span>
        <button type="button" class="osp-button osp-button-primary" data-action="apply" ${summary.blocking ? 'disabled' : ''}>완료 · OrderOps에 반영</button>
      </footer>`;
    }

    render() {
      if (!this.state.isOpen) {
        this.root.innerHTML = '';
        return;
      }
      const content = this.state.step === 'review' ? this.renderReviewStep() : this.renderInputStep();
      this.root.innerHTML = `<div class="osp-overlay" role="dialog" aria-modal="true" aria-label="OrderOps SmartParser">
        <div class="osp-dialog">
          <header class="osp-header">
            <div class="osp-brand"><span>ONEAPP</span><div><strong>OrderOps SmartParser</strong><small>비정형 자료 → 검증된 OrderOps 작업값</small></div><em>v2.2</em></div>
            ${this.renderStepIndicator()}
            <button type="button" class="osp-close" data-action="close" aria-label="닫기">×</button>
          </header>
          ${content}
          ${this.renderBusy()}
        </div>
      </div>`;
    }
  }

  function initialize() {
    const root = document.getElementById('orderOpsSmartParserRoot');
    const button = document.getElementById('btnSmartParser');
    if (!root || !button) return;
    const controller = new OrderOpsSmartParserController(root);
    button.addEventListener('click', () => controller.open());
    window.OrderOpsSmartParser = Object.freeze({
      open: () => controller.open(),
      close: () => controller.cancel(),
      getState: () => cloneJson(controller.state)
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
