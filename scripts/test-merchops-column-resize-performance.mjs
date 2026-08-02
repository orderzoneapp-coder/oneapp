import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../MerchOps.html', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/repository-validation.yml', import.meta.url), 'utf8');

const resizeStart = source.indexOf('const resizeHandle =');
const resizeEnd = source.indexOf('const saveColumnWidths =', resizeStart);
assert.ok(resizeStart >= 0 && resizeEnd > resizeStart, '열폭 드래그 처리 구간을 찾을 수 있어야 한다.');

const resizeSource = source.slice(resizeStart, resizeEnd);
const moveStart = resizeSource.indexOf('const onMove =');
const upStart = resizeSource.indexOf('const onUp =', moveStart);
assert.ok(moveStart >= 0 && upStart > moveStart, 'mousemove와 mouseup 처리기를 찾을 수 있어야 한다.');

const moveSource = resizeSource.slice(moveStart, upStart);
const upSource = resizeSource.slice(upStart);
assert.doesNotMatch(
    moveSource,
    /setColumnWidthDraft|setColumnWidthDirtyMap|setColumnWidthDirty/,
    '드래그 중에는 React 상태를 변경해 전체 작업표를 다시 렌더링하면 안 된다.'
);
assert.match(upSource, /setColumnWidthDraft/, '마우스를 놓을 때 최종 열폭을 React 상태에 반영해야 한다.');
assert.doesNotMatch(
    resizeSource,
    /nth-child|previewStyle\.textContent|data-merch-column-resize-preview|merch-column-resize-guide|document\.createElement|appendChild|requestAnimationFrame/,
    '드래그 중 테이블 열 전체 또는 별도 안내 요소를 만들면 안 된다.'
);
assert.match(resizeSource, /cursorRoot\.style\.cursor = 'col-resize'/, '드래그 중에는 실제 마우스 커서 하나만 열폭 조정 모양으로 유지해야 한다.');
assert.match(resizeSource, /cursorRoot\.style\.cursor = previousCursor/, '드래그 종료 시 기존 마우스 커서를 복원해야 한다.');
assert.match(resizeSource, /addEventListener\('blur', onUp\)/, '창 포커스를 잃어도 드래그 자원을 정리해야 한다.');

const gridStart = source.indexOf('const ExcelDataGrid =');
const gridEnd = source.indexOf('const WelcomeGuide =', gridStart);
assert.ok(gridStart >= 0 && gridEnd > gridStart, '작업표 컴포넌트 구간을 찾을 수 있어야 한다.');
const gridSource = source.slice(gridStart, gridEnd);
assert.match(gridSource, /const currentColumnWidths = useMemo\(/, '정규화된 열폭 참조를 입력이 같을 때 재사용해야 한다.');
assert.match(gridSource, /const tableRowState = useMemo\(/, '행에 전달하는 상태 객체를 메모화해야 한다.');
assert.match(gridSource, /const tableRowActions = useMemo\(/, '행에 전달하는 동작 객체를 메모화해야 한다.');
assert.match(gridSource, /const tableRowMasterItems = useMemo\(/, '행별 마스터 파생 객체 참조를 메모화해야 한다.');
assert.doesNotMatch(
    gridSource,
    /state:\s*\{\s*\.\.\.state,\s*columnWidths:/,
    '행 map 내부에서 state 객체를 새로 만들면 React.memo가 무력화된다.'
);

const shallowEqual = (left, right) => {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
};

const createResizeHarness = ({ rowCount = 2000, startWidth = 100 } = {}) => {
    const listeners = new Map();
    const rows = Array.from({ length: rowCount }, (_, idx) => ({ code: `ROW-${idx}` }));
    const actions = Object.freeze({});
    const masterItem = Object.freeze({});
    let rowState = Object.freeze({ columnWidths: Object.freeze({}) });
    let rowProps = rows.map((row, idx) => ({ row, idx, state: rowState, actions, isSel: false, mItem: masterItem }));
    let draft = {};
    let widthApplyCount = 0;
    let rowRenderIncrease = 0;
    let dirtyMapUpdates = 0;
    let dirtyUpdates = 0;

    const addEventListener = (type, callback) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
    };
    const removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
    const dispatch = (type, event = {}) => {
        for (const callback of [...(listeners.get(type) || [])]) callback(event);
    };
    const applyRowState = nextColumnWidths => {
        const nextState = Object.freeze({ columnWidths: Object.freeze({ ...nextColumnWidths }) });
        const nextProps = rows.map((row, idx) => ({ row, idx, state: nextState, actions, isSel: false, mItem: masterItem }));
        rowRenderIncrease += nextProps.reduce((count, props, idx) => count + (shallowEqual(rowProps[idx], props) ? 0 : 1), 0);
        rowState = nextState;
        rowProps = nextProps;
    };

    const windowMock = {
        innerHeight: 900,
        addEventListener,
        removeEventListener
    };
    const documentMock = {
        documentElement: { style: { cursor: '', userSelect: '' } }
    };
    const context = {
        React: { createElement: (type, props) => ({ type, props }) },
        MERCH_RESIZE_HANDLE_CLASS: 'resize-handle',
        window: windowMock,
        document: documentMock,
        getColumnWidthValue: () => startWidth,
        setColumnWidthDraft: updater => {
            widthApplyCount += 1;
            draft = typeof updater === 'function' ? updater(draft) : updater;
            applyRowState(draft);
        },
        setColumnWidthDirtyMap: updater => {
            dirtyMapUpdates += 1;
            if (typeof updater === 'function') updater({});
        },
        setColumnWidthDirty: value => {
            dirtyUpdates += 1;
            assert.equal(value, true);
        }
    };
    vm.runInNewContext(`${resizeSource}\nthis.resizeHandleUnderTest = resizeHandle;`, context, { filename: 'MerchOps-resize-handler.js' });

    const table = { getBoundingClientRect: () => ({ top: 20, bottom: 820 }) };
    const header = { closest: selector => selector === 'table' ? table : null };
    const currentTarget = { closest: selector => selector === 'th' ? header : null };
    const resizeElement = context.resizeHandleUnderTest('work:입고가', '입고가', 86);

    return {
        start(clientX = 200) {
            resizeElement.props.onMouseDown({
                button: 0,
                clientX,
                currentTarget,
                preventDefault() {},
                stopPropagation() {}
            });
        },
        move(clientX) { dispatch('mousemove', { clientX }); },
        finish(type = 'mouseup') { dispatch(type); },
        snapshot: () => ({
            draft: { ...draft },
            widthApplyCount,
            rowRenderIncrease,
            dirtyMapUpdates,
            dirtyUpdates,
            moveListenerCount: listeners.get('mousemove')?.size || 0,
            upListenerCount: listeners.get('mouseup')?.size || 0,
            blurListenerCount: listeners.get('blur')?.size || 0,
            cursor: documentMock.documentElement.style.cursor,
            userSelect: documentMock.documentElement.style.userSelect
        })
    };
};

const changedDrag = createResizeHarness({ rowCount: 2000, startWidth: 100 });
changedDrag.start(200);
for (let index = 0; index < 500; index += 1) {
    changedDrag.move(201 + (index % 300));
}

let changedSnapshot = changedDrag.snapshot();
assert.equal(changedSnapshot.widthApplyCount, 0, '반복 mousemove 중 최종 열폭 상태 반영은 0회여야 한다.');
assert.equal(changedSnapshot.rowRenderIncrease, 0, '2,000행 모델에서 mousemove 중 행 렌더 증가는 0이어야 한다.');
assert.equal(changedSnapshot.dirtyUpdates, 0, 'mousemove 중 dirty 상태를 바꾸면 안 된다.');
assert.equal(changedSnapshot.cursor, 'col-resize', '드래그 중에는 실제 마우스 커서 하나만 열폭 조정 모양이어야 한다.');
assert.equal(changedSnapshot.userSelect, 'none', '드래그 중 텍스트 선택을 막아야 한다.');

changedDrag.finish('mouseup');
changedSnapshot = changedDrag.snapshot();
assert.equal(changedSnapshot.widthApplyCount, 1, '드래그 종료 후 최종 열폭 반영은 정확히 1회여야 한다.');
assert.equal(changedSnapshot.draft['work:입고가'], 300, '마우스를 놓은 최종 폭이 실제 열폭 초안에 반영되어야 한다.');
assert.equal(changedSnapshot.rowRenderIncrease, 2000, '최종 열폭 반영 시에만 2,000행이 한 번씩 새 props를 받아야 한다.');
assert.equal(changedSnapshot.dirtyMapUpdates, 1, '실제 폭 변경은 dirty 열 목록에 1회 기록되어야 한다.');
assert.equal(changedSnapshot.dirtyUpdates, 1, '실제 폭 변경은 dirty 상태를 1회 설정해야 한다.');
assert.equal(changedSnapshot.moveListenerCount, 0, '종료 시 mousemove 이벤트를 정리해야 한다.');
assert.equal(changedSnapshot.upListenerCount, 0, '종료 시 mouseup 이벤트를 정리해야 한다.');
assert.equal(changedSnapshot.blurListenerCount, 0, '종료 시 blur 이벤트를 정리해야 한다.');
assert.equal(changedSnapshot.cursor, '', '종료 시 기존 마우스 커서를 복원해야 한다.');
assert.equal(changedSnapshot.userSelect, '', '종료 시 기존 텍스트 선택 상태를 복원해야 한다.');

const unchangedBlur = createResizeHarness({ rowCount: 2000, startWidth: 100 });
unchangedBlur.start(200);
unchangedBlur.finish('blur');
const unchangedSnapshot = unchangedBlur.snapshot();
assert.equal(unchangedSnapshot.widthApplyCount, 0, '폭이 바뀌지 않은 blur 종료는 열폭 상태를 반영하면 안 된다.');
assert.equal(unchangedSnapshot.rowRenderIncrease, 0, '폭이 바뀌지 않은 종료는 행을 다시 렌더링하면 안 된다.');
assert.equal(unchangedSnapshot.dirtyMapUpdates, 0, '폭이 바뀌지 않은 종료는 dirty 열을 만들면 안 된다.');
assert.equal(unchangedSnapshot.dirtyUpdates, 0, '폭이 바뀌지 않은 종료는 dirty 상태를 만들면 안 된다.');
assert.equal(unchangedSnapshot.cursor, '', 'blur 종료도 기존 마우스 커서를 복원해야 한다.');
assert.equal(unchangedSnapshot.userSelect, '', 'blur 종료도 기존 텍스트 선택 상태를 복원해야 한다.');

const widthContractStart = source.indexOf('window.normalizeMerchColumnWidths =');
const widthContractEnd = source.indexOf('const MERCH_RESIZE_HANDLE_CLASS', widthContractStart);
assert.ok(widthContractStart >= 0 && widthContractEnd > widthContractStart, '열폭 저장 계약 구간을 찾을 수 있어야 한다.');
const storage = new Map();
const widthContext = {
    window: {},
    localStorage: {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, value)
    },
    getDefaultMerchColumnWidth: (_label, fallback) => fallback
};
vm.runInNewContext(source.slice(widthContractStart, widthContractEnd), widthContext, { filename: 'MerchOps-width-contract.js' });
const normalize = value => JSON.parse(JSON.stringify(widthContext.window.normalizeMerchColumnWidths(value)));
assert.deepEqual(normalize({ min: 1, max: 900, rounded: 100.6, invalid: 0 }), { min: 48, max: 720, rounded: 101 }, '최소·최대·반올림 열폭 계약을 유지해야 한다.');
widthContext.window.saveMerchSharedColumnWidths({ 입고가: 133 });
assert.equal(widthContext.window.getMerchColumnWidthValue({ 'work:입고가': 111 }, 'work:입고가', '입고가', 86, widthContext.window.getMerchSharedColumnWidths()), 133, '공통 열폭은 양식별 열폭보다 우선해야 한다.');
assert.equal(widthContext.window.getMerchColumnWidthValue({ 'work:출고가': 122 }, 'work:출고가', '출고가', 86, {}), 122, '양식별 열폭을 유지해야 한다.');
widthContext.window.removeMerchSharedColumnWidths(['입고가']);
assert.deepEqual(normalize(widthContext.window.getMerchSharedColumnWidths()), {}, '열폭 초기화는 지정 공통 열폭을 제거해야 한다.');

assert.match(gridSource, /columnWidths:\s*widths,\s*updatedAt:/, '열폭 저장은 활성 양식에 정규화된 값을 기록해야 한다.');
assert.match(gridSource, /delete next\.columnWidths;/, '열폭 초기화는 활성 양식의 저장값을 제거해야 한다.');
assert.match(
    workflow,
    /run:\s*node scripts\/test-merchops-column-resize-performance\.mjs/,
    'GitHub Actions가 열폭 성능 검사를 실제 실행해야 한다.'
);

console.log('MerchOps column resize performance execution contract passed (2,000 rows, 500 mousemoves)');
