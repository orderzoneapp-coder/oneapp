// ==========================================
// 🧠 ONEAPP MerchOps - Core Logic Engine (coreEngine.js)
// ==========================================

// 1. 공통 상수 정의
window.MASTER_HEADERS = [
    "창고", "1코드", "1그룹명", "2코드", "2그룹명", "3코드", "3그룹명", "오더즈", "구매처", "브랜드", 
    "품목코드", "품목명", "규격", "안전재고", "간단설명", "카탈로그", "견적서", "출고가", "입고가", "입고B", "도매A", 
    "도매B", "상장가", "최종전송", "최종입고", "단가H", "단가I", "시중가", "행사가", 
    "1종코드", "1종규격", "1종연산", "2종코드", "2종규격", "2종연산", "외주비", "노무비", 
    "경비", "비과세", "기본", "연동", "싯가", "단위", "준비기간", "마감시간", "검색어등록"
];

window.NUMERIC_HEADERS = [
    "안전재고", "출고가", "입고가", "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고",
    "단가H", "단가I", "시중가", "행사가", "1종연산", "2종연산", "외주비", "노무비", "경비",
    "1구매", "1출고", "2구매", "2출고", "1입고", "2입고"
];

// 2. 무제한 로컬 스토리지 (IndexedDB) 공통 모듈
window.initIDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('MerchOpsDB', 2);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
            if (!db.objectStoreNames.contains('master_products')) {
                db.createObjectStore('master_products', { keyPath: '코드' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

window.setIDB = async (key, val) => {
    const db = await window.initIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

window.getIDB = async (key) => {
    const db = await window.initIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readonly');
        const req = tx.objectStore('store').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(tx.error);
    });
};

window.bulkPutIDB = async (storeName, items) => {
    const db = await window.initIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        items.forEach(item => store.put(item));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

window.getAllIDB = async (storeName) => {
    const db = await window.initIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(tx.error);
    });
};

// 3. 유틸리티 함수 (UUID, 숫자 파싱 등)
window.generateUUID = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

window.parseNum = (v) => (!v ? 0 : Number(String(v).replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0);

window.getFirstValidNum = (objList, keys) => {
    for (let obj of objList) { if (!obj) continue; for (let k of keys) { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return window.parseNum(obj[k]); } } return 0;
};

window.getFirstValidStr = (objList, keys) => {
    for (let obj of objList) { if (!obj) continue; for (let k of keys) { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]; } } return '';
};

window.isValidSubItemCode = (code) => {
    if (!code) return false;
    const s = String(code).trim();
    return s !== '' && s !== '0' && s !== '00' && s !== '-' && s.toLowerCase() !== 'undefined' && s.toLowerCase() !== 'null';
};

// 4. 단가 중앙 계산 엔진 (v1.4.3 방어 로직 적용)
window.calculatePricesEngine = (baseInPrice, mItem = {}, currentFinalData = {}, marginRules = [], forceRecalc = false) => {
    const ROUND_UNIT = 100;

    const outsrc = window.parseNum(currentFinalData?.['외주비'] ?? mItem?.['외주비']);
    const labor = window.parseNum(currentFinalData?.['노무비'] ?? mItem?.['노무비']);
    const totalCost = baseInPrice + outsrc + labor;

    const whCode = String(currentFinalData?.['창고'] ?? mItem?.['창고'] ?? '').trim();
    const unitStr = String(currentFinalData?.['단위'] ?? mItem?.['단위'] ?? '').trim().toLowerCase();
    
    const matchWh = (ruleWh, targetWh) => {
        if (ruleWh === '*') return true;
        const targets = String(ruleWh).split(/[,./|\s]+/).map(s => s.trim()).filter(Boolean);
        return targets.some(s => s === targetWh || (targetWh !== '' && !isNaN(s) && !isNaN(targetWh) && Number(s) === Number(targetWh)));
    };
    
    const matchUnit = (ruleUnit, targetUnit) => {
        if (ruleUnit === '*') return true;
        const targets = String(ruleUnit).toLowerCase().split(/[,./|\s]+/).map(s => s.trim()).filter(Boolean);
        return targets.some(s => targetUnit === s || targetUnit.includes(s));
    };

    let bestRule = null;
    let bestScore = -1;

    const safeMarginRules = Array.isArray(marginRules) ? marginRules : [];
    safeMarginRules.forEach(r => {
        if (matchWh(r.whCode, whCode) && matchUnit(r.unit, unitStr)) {
            let score = 0;
            if (r.whCode !== '*') score += 2;
            if (r.unit !== '*') score += 1;
            if (score > bestScore) { bestScore = score; bestRule = r; }
        }
    });

    const appliedRule = bestRule || { rate: 10, type: 'divide' };

    let calcOutPrice = 0;

    if (baseInPrice > 0) {
        if (appliedRule.type === 'divide') {
            calcOutPrice = totalCost / (1 - (appliedRule.rate / 100));
        } else {
            calcOutPrice = totalCost * (1 + (appliedRule.rate / 100));
        }
        calcOutPrice = Math.round(calcOutPrice / ROUND_UNIT) * ROUND_UNIT;
    }

    let newFinalData = { ...currentFinalData, '입고가': baseInPrice };
    newFinalData['시중가'] = calcOutPrice;

    const providedOutPriceRaw = currentFinalData?.['출고가'];
    const hasProvidedOut = providedOutPriceRaw !== undefined && providedOutPriceRaw !== '';
    const providedOutPrice = hasProvidedOut ? window.parseNum(providedOutPriceRaw) : 0;
    
    const mIn = window.parseNum(mItem?.['입고가']);
    const mOut = window.parseNum(mItem?.['출고가']);

    if (baseInPrice === 0) {
        newFinalData['출고가'] = 0;
    } else if (hasProvidedOut && !forceRecalc) {
        newFinalData['출고가'] = providedOutPrice;
    } else if (baseInPrice === mIn && mOut > 0 && !forceRecalc) {
        newFinalData['출고가'] = mOut;
    } else {
        newFinalData['출고가'] = calcOutPrice;
    }

    const div1 = window.parseNum(currentFinalData?.['1종연산'] ?? mItem?.['1종연산']);
    const extraCost = window.parseNum(currentFinalData?.['경비'] ?? mItem?.['경비']); 
    if (div1 > 0) {
        if (baseInPrice === 0) {
            newFinalData['1입고'] = 0;
            newFinalData['1출고'] = 0;
        } else {
            newFinalData['1입고'] = Math.round(((baseInPrice + outsrc) / div1) / ROUND_UNIT) * ROUND_UNIT;
            const calc1Out = Math.round((newFinalData['출고가'] / div1) + extraCost);
            newFinalData['1출고'] = Math.round(calc1Out / 10) * 10; 
        }
    }
    return newFinalData;
};
