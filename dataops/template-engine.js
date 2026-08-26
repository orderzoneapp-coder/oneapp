(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DATAOPS_TEMPLATE_ENGINE = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const CONTRACT_VERSION = 'DATAOPS_TEMPLATE_V1';
    const DEFAULT_TEMPLATE_ID = 'DATAOPS_DEFAULT_V1';
    const STORAGE_KEY = 'oneapp.dataops.templates.v1';
    const ACTIVE_KEY = 'oneapp.dataops.activeTemplate.v1';
    const PURPOSES = Object.freeze({
        STOCK_LEDGER: 'STOCK_LEDGER',
        UNSHIPPED_STATUS: 'UNSHIPPED_STATUS',
        GENERIC_DATAOPS: 'GENERIC_DATAOPS'
    });
    const ROLE_LABELS = Object.freeze({
        prev: '기초·전일재고',
        order: '주문·출고예정',
        in: '입고·구매',
        out: '출고·판매',
        end: '잔량·실사'
    });
    const FIELD_DEFINITIONS = Object.freeze([
        { key: 'code', label: '코드', writable: true, aliases: ['품목코드', '상품코드', '코드', '품번', '바코드', 'sku'] },
        { key: 'name', label: '품명', writable: true, aliases: ['품명', '품목명', '품목명(규격)', '품목명[규격]', '상품명', '제품명', '이름', '품목', '상품'] },
        { key: 'spec', label: '규격', writable: true, aliases: ['규격', '옵션', '사이즈'] },
        { key: 'unit', label: '단위', writable: true, aliases: ['단위', '규격단위', '포장단위', '단위명', '판매단위'] },
        { key: 'quantity', label: '수량', writable: true, aliases: ['수량', '재고', '기초수량', '전일재고', '주문수량', '출고예정수량', '입고수량', '구매수량', '매입수량', '출고수량', '출고량', '판매수량', '판매량', '잔량', '남은재고', '실사', '기말실사', '기말실사(이월수량)'] },
        { key: 'price', label: '단가', writable: true, aliases: ['단가', '구매가', '입고가', '입고단가', '구매단가', '판매단가', '매입단가', '매입단가(원가)', '매입가', '판매가', '원가', '가격', '최종(창고)'] },
        { key: 'vendor', label: '거래처', writable: true, aliases: ['거래처명', '거래처', '구매처명', '구매처', '매입처', '판매처', '매출처명', '매장명', '고객', '공급사'] },
        { key: 'matchVendor', label: '매입처 매칭', writable: true, aliases: ['구매처', '구매처명', '매입처', '원구매처', '매입처(Lot)', '매입처(거래처)'] },
        { key: 'date', label: '일자', writable: true, aliases: ['일자', '날짜', '기록', '결산일자', '구매일자', '매입일자', '입고일자', '판매일자', '출고일자', '등록일', '기준일'] },
        { key: 'basic', label: '기본구분', writable: true, aliases: ['구분(기본)', '구분기본', '기본여부', '기본', '관리기본', '기본구분'] }
    ]);
    const COMPUTED_FIELDS = Object.freeze([
        { key: 'systemBalance', label: '전산잔량', aliases: ['전산잔량', '계산잔량', '시스템잔량'] },
        { key: 'discrepancy', label: '오차·차이', aliases: ['오차', '차이', '재고오차', '수량오차', '전산상오차', '조정오차', '로스', '로스/조정수량'] },
        { key: 'systemResult', label: '시스템 결과', aliases: ['이슈/결과', '검증결과', '판정결과'] }
    ]);
    const DEFAULT_COLUMN_ORDER = Object.freeze(['code', 'name', 'spec', 'unit', 'quantity', 'price', 'vendor', 'matchVendor', 'date', 'basic']);

    const clone = value => JSON.parse(JSON.stringify(value));
    const normalizeHeader = value => String(value == null ? '' : value)
        .normalize('NFKC')
        .trim()
        .toLowerCase()
        .replace(/[\s_\-./\\()[\]{}:：]+/g, '');
    const uniqueText = values => Array.from(new Set((values || []).map(value => String(value == null ? '' : value).trim()).filter(Boolean)));
    const fieldByKey = key => FIELD_DEFINITIONS.find(field => field.key === key) || null;
    const computedByHeader = header => {
        const normalized = normalizeHeader(header);
        return COMPUTED_FIELDS.find(field => field.aliases.some(alias => {
            const target = normalizeHeader(alias);
            return target && (target === normalized || (target.length >= 2 && normalized.includes(target)));
        })) || null;
    };
    const makeDefaultRoleMappings = () => Object.fromEntries(Object.keys(ROLE_LABELS).map(role => [role, {}]));

    const makeDefaultTemplate = () => ({
        contractVersion: CONTRACT_VERSION,
        id: DEFAULT_TEMPLATE_ID,
        name: 'DataOps 기본 양식',
        description: '기존 DataOps의 기초·매입·매출·실사 흐름을 그대로 유지하는 자동 매핑 양식',
        version: 1,
        revision: 1,
        builtIn: true,
        purpose: PURPOSES.STOCK_LEDGER,
        includeOrderInBalance: false,
        requiredFields: [],
        requiredFieldsByRole: Object.fromEntries(Object.keys(ROLE_LABELS).map(role => [role, []])),
        columnOrder: [...DEFAULT_COLUMN_ORDER],
        roleMappings: makeDefaultRoleMappings(),
        rules: {
            rejectUnknownProvidedCode: true,
            fillCodeFromExactName: true,
            allowUnmatchedNameForPostMatch: true
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z'
    });

    const sanitizeTemplate = input => {
        const source = input && typeof input === 'object' ? input : {};
        const isDefault = String(source.id || '') === DEFAULT_TEMPLATE_ID;
        const purpose = Object.values(PURPOSES).includes(source.purpose) ? source.purpose : PURPOSES.STOCK_LEDGER;
        const allowedKeys = new Set(FIELD_DEFINITIONS.map(field => field.key));
        const order = uniqueText(source.columnOrder).filter(key => allowedKeys.has(key));
        DEFAULT_COLUMN_ORDER.forEach(key => { if (!order.includes(key)) order.push(key); });
        const roleMappings = makeDefaultRoleMappings();
        const requiredFieldsByRole = Object.fromEntries(Object.keys(ROLE_LABELS).map(role => [role, []]));
        Object.keys(roleMappings).forEach(role => {
            const incoming = source.roleMappings && source.roleMappings[role];
            const roleRequired = source.requiredFieldsByRole && source.requiredFieldsByRole[role];
            if (Array.isArray(roleRequired)) requiredFieldsByRole[role] = uniqueText(roleRequired).filter(key => allowedKeys.has(key));
            if (incoming && typeof incoming === 'object') {
                Object.entries(incoming).forEach(([key, header]) => {
                    if (allowedKeys.has(key) && String(header || '').trim()) roleMappings[role][key] = String(header).trim();
                });
            }
        });
        return {
            contractVersion: CONTRACT_VERSION,
            id: isDefault ? DEFAULT_TEMPLATE_ID : String(source.id || '').trim(),
            name: String(source.name || (isDefault ? 'DataOps 기본 양식' : '새 양식')).trim(),
            description: String(source.description || '').trim(),
            version: Math.max(1, Number(source.version) || 1),
            revision: Math.max(1, Number(source.revision) || 1),
            builtIn: isDefault,
            purpose,
            includeOrderInBalance: purpose === PURPOSES.UNSHIPPED_STATUS ? source.includeOrderInBalance !== false : source.includeOrderInBalance === true,
            requiredFields: uniqueText(source.requiredFields).filter(key => allowedKeys.has(key)),
            requiredFieldsByRole,
            columnOrder: order,
            roleMappings,
            rules: {
                rejectUnknownProvidedCode: source.rules?.rejectUnknownProvidedCode !== false,
                fillCodeFromExactName: source.rules?.fillCodeFromExactName !== false,
                allowUnmatchedNameForPostMatch: source.rules?.allowUnmatchedNameForPostMatch !== false
            },
            createdAt: String(source.createdAt || new Date().toISOString()),
            updatedAt: String(source.updatedAt || new Date().toISOString())
        };
    };

    const getStorage = storage => storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const readCatalog = storage => {
        const store = getStorage(storage);
        let custom = [];
        if (store) {
            try {
                const parsed = JSON.parse(store.getItem(STORAGE_KEY) || '[]');
                if (Array.isArray(parsed)) custom = parsed;
            } catch (error) {
                console.warn('DataOps 양식 목록을 읽지 못했습니다.', error);
            }
        }
        const templates = [makeDefaultTemplate()];
        custom.map(sanitizeTemplate).filter(template => template.id && template.id !== DEFAULT_TEMPLATE_ID).forEach(template => templates.push(template));
        return templates;
    };
    const writeCatalog = (templates, storage) => {
        const store = getStorage(storage);
        if (!store) return false;
        const custom = (templates || []).map(sanitizeTemplate).filter(template => template.id !== DEFAULT_TEMPLATE_ID);
        store.setItem(STORAGE_KEY, JSON.stringify(custom));
        return true;
    };
    const getActiveTemplate = storage => {
        const store = getStorage(storage);
        const id = store ? String(store.getItem(ACTIVE_KEY) || DEFAULT_TEMPLATE_ID) : DEFAULT_TEMPLATE_ID;
        return readCatalog(store).find(template => template.id === id) || makeDefaultTemplate();
    };
    const setActiveTemplate = (id, storage) => {
        const store = getStorage(storage);
        const found = readCatalog(store).find(template => template.id === String(id || '')) || makeDefaultTemplate();
        if (store) store.setItem(ACTIVE_KEY, found.id);
        return found;
    };
    const makeId = name => {
        const slug = String(name || 'template').normalize('NFKC').replace(/[^0-9A-Za-z가-힣]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'TEMPLATE';
        return `DATAOPS_${slug}_${Date.now().toString(36).toUpperCase()}`;
    };
    const saveTemplate = (input, options) => {
        const opts = options || {};
        const templates = readCatalog(opts.storage);
        let next = sanitizeTemplate(input);
        if (!next.id || next.id === DEFAULT_TEMPLATE_ID || opts.saveAs === true) {
            next.id = makeId(next.name);
            next.builtIn = false;
            next.revision = 1;
            next.createdAt = new Date().toISOString();
        } else {
            const current = templates.find(template => template.id === next.id);
            if (!current) {
                const error = new Error('TEMPLATE_NOT_FOUND');
                error.code = 'TEMPLATE_NOT_FOUND';
                throw error;
            }
            if (Number(opts.expectedRevision) !== Number(current.revision)) {
                const error = new Error('TEMPLATE_VERSION_CONFLICT');
                error.code = 'TEMPLATE_VERSION_CONFLICT';
                throw error;
            }
            next.revision = current.revision + 1;
            next.createdAt = current.createdAt;
        }
        next.updatedAt = new Date().toISOString();
        const withoutOld = templates.filter(template => template.id !== next.id);
        writeCatalog([...withoutOld, next], opts.storage);
        if (opts.activate !== false) setActiveTemplate(next.id, opts.storage);
        return clone(next);
    };
    const deleteTemplate = (id, storage) => {
        const target = String(id || '');
        if (!target || target === DEFAULT_TEMPLATE_ID) return false;
        const templates = readCatalog(storage);
        const exists = templates.some(template => template.id === target);
        if (!exists) return false;
        writeCatalog(templates.filter(template => template.id !== target), storage);
        if (getActiveTemplate(storage).id === target) setActiveTemplate(DEFAULT_TEMPLATE_ID, storage);
        return true;
    };

    const aliasesForField = (field, legacyMappings) => {
        const legacyKey = field.key === 'quantity' ? 'qty' : field.key;
        const legacy = String((legacyMappings || {})[legacyKey] || '').split(',');
        return uniqueText([...(field.aliases || []), ...legacy]);
    };
    const scoreHeader = (header, aliases) => {
        const normalized = normalizeHeader(header);
        if (!normalized) return { score: 0, matchType: 'NONE' };
        for (const alias of aliases) {
            const target = normalizeHeader(alias);
            if (target && target === normalized) return { score: 100, matchType: 'EXACT' };
        }
        for (const alias of aliases) {
            const target = normalizeHeader(alias);
            if (target && target.length >= 2 && (normalized.includes(target) || target.includes(normalized))) return { score: 72, matchType: 'ALIAS' };
        }
        return { score: 0, matchType: 'NONE' };
    };
    const mapHeaders = (headers, templateInput, role, legacyMappings) => {
        const template = sanitizeTemplate(templateInput || makeDefaultTemplate());
        const roleKey = String(role || '');
        const explicit = template.roleMappings[roleKey] || {};
        const roleRequiredFields = template.requiredFieldsByRole?.[roleKey] || template.requiredFields || [];
        const used = new Set();
        const mappings = [];
        for (const key of template.columnOrder) {
            const field = fieldByKey(key);
            if (!field) continue;
            let best = { index: -1, sourceHeader: '', confidence: 0, matchType: 'NONE' };
            const explicitHeader = String(explicit[key] || '').trim();
            headers.forEach((header, index) => {
                if (used.has(index) || computedByHeader(header)) return;
                const result = explicitHeader && normalizeHeader(header) === normalizeHeader(explicitHeader)
                    ? { score: 120, matchType: 'SAVED' }
                    : scoreHeader(header, aliasesForField(field, legacyMappings));
                if (result.score > best.confidence) best = { index, sourceHeader: String(header || ''), confidence: result.score, matchType: result.matchType };
            });
            if (best.index >= 0 && best.confidence > 0) used.add(best.index);
            mappings.push({
                fieldKey: key,
                label: field.label,
                sourceHeader: best.sourceHeader,
                sourceIndex: best.index,
                confidence: best.confidence,
                matchType: best.matchType,
                required: roleRequiredFields.includes(key),
                writable: true
            });
        }
        const ignoredSystemFields = headers.map((header, index) => ({ header: String(header || ''), index, field: computedByHeader(header) })).filter(item => item.field).map(item => ({ sourceHeader: item.header, sourceIndex: item.index, fieldKey: item.field.key, label: item.field.label, reason: 'SERVER_COMPUTED' }));
        return { mappings, ignoredSystemFields };
    };
    const analyzeRows = (rows, templateInput, role, legacyMappings) => {
        const template = sanitizeTemplate(templateInput || makeDefaultTemplate());
        const inputRows = Array.isArray(rows) ? rows : [];
        let best = null;
        for (let rowIndex = 0; rowIndex < Math.min(30, inputRows.length); rowIndex++) {
            const headers = (inputRows[rowIndex] || []).map(value => String(value == null ? '' : value).trim());
            const mapped = mapHeaders(headers, template, role, legacyMappings);
            const score = mapped.mappings.reduce((sum, mapping) => sum + (mapping.confidence >= 100 ? 3 : mapping.confidence > 0 ? 1 : 0), 0);
            if (!best || score > best.score) best = { headerRowIndex: rowIndex, headers, score, ...mapped };
        }
        best = best || { headerRowIndex: -1, headers: [], score: 0, mappings: [], ignoredSystemFields: [] };
        const missingRequired = best.mappings.filter(mapping => mapping.required && !mapping.sourceHeader).map(mapping => ({ fieldKey: mapping.fieldKey, label: mapping.label }));
        return {
            contractVersion: CONTRACT_VERSION,
            templateId: template.id,
            templateVersion: template.version,
            templateRevision: template.revision,
            role: String(role || ''),
            roleLabel: ROLE_LABELS[String(role || '')] || String(role || ''),
            ...best,
            missingRequired,
            blocking: missingRequired.length > 0,
            errorCode: missingRequired.length ? 'TEMPLATE_REQUIRED_FIELD_MISSING' : ''
        };
    };
    const applyAnalysisToLegacyMappings = (legacyMappings, analysis) => {
        const next = { ...(legacyMappings || {}) };
        const legacyKeyByField = { quantity: 'qty' };
        (analysis?.mappings || []).forEach(mapping => {
            if (!mapping.sourceHeader) return;
            const key = legacyKeyByField[mapping.fieldKey] || mapping.fieldKey;
            const values = uniqueText([mapping.sourceHeader, ...String(next[key] || '').split(',')]);
            next[key] = values.join(', ');
        });
        return next;
    };
    const updateRoleMappingsFromAnalysis = (templateInput, analysis) => {
        const template = sanitizeTemplate(templateInput);
        const role = String(analysis?.role || '');
        if (!Object.prototype.hasOwnProperty.call(template.roleMappings, role)) return template;
        const updated = {};
        (analysis?.mappings || []).forEach(mapping => { if (mapping.sourceHeader) updated[mapping.fieldKey] = mapping.sourceHeader; });
        template.roleMappings[role] = updated;
        return template;
    };
    const reorderColumns = (templateInput, fieldKey, direction) => {
        const template = sanitizeTemplate(templateInput);
        const index = template.columnOrder.indexOf(fieldKey);
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= template.columnOrder.length) return template;
        [template.columnOrder[index], template.columnOrder[nextIndex]] = [template.columnOrder[nextIndex], template.columnOrder[index]];
        return template;
    };
    const validateProductCodes = (rows, masterRows, templateInput) => {
        const template = sanitizeTemplate(templateInput);
        const master = Array.isArray(masterRows) ? masterRows : [];
        const codeMap = new Map(master.map(row => [String(row.code ?? row.코드 ?? '').trim(), row]).filter(([code]) => code));
        const nameMap = new Map(master.map(row => [normalizeHeader(row.name ?? row.품명 ?? ''), row]).filter(([name]) => name));
        const accepted = [];
        const errors = [];
        (Array.isArray(rows) ? rows : []).forEach((source, index) => {
            const row = { ...source };
            const code = String(row.code ?? row.코드 ?? '').trim();
            const name = String(row.name ?? row.품명 ?? '').trim();
            if (code && template.rules.rejectUnknownProvidedCode && !codeMap.has(code)) {
                errors.push({ code: 'UNREGISTERED_PRODUCT_CODE', rowIndex: index, providedCode: code, name });
                return;
            }
            if (!code && name && template.rules.fillCodeFromExactName) {
                const matched = nameMap.get(normalizeHeader(name));
                if (matched) row.code = row.코드 = String(matched.code ?? matched.코드 ?? '').trim();
                else if (!template.rules.allowUnmatchedNameForPostMatch) {
                    errors.push({ code: 'PRODUCT_NAME_NOT_MATCHED', rowIndex: index, name });
                    return;
                }
            }
            accepted.push(row);
        });
        return { accepted, errors, blocking: errors.length > 0 };
    };

    return Object.freeze({
        CONTRACT_VERSION,
        DEFAULT_TEMPLATE_ID,
        STORAGE_KEY,
        ACTIVE_KEY,
        PURPOSES,
        ROLE_LABELS,
        FIELD_DEFINITIONS,
        COMPUTED_FIELDS,
        normalizeHeader,
        makeDefaultTemplate,
        sanitizeTemplate,
        readCatalog,
        getActiveTemplate,
        setActiveTemplate,
        saveTemplate,
        deleteTemplate,
        analyzeRows,
        mapHeaders,
        applyAnalysisToLegacyMappings,
        updateRoleMappingsFromAnalysis,
        reorderColumns,
        validateProductCodes
    });
});
