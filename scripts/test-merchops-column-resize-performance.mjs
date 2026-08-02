import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../MerchOps.html', import.meta.url), 'utf8');
const start = source.indexOf('const resizeHandle =');
const end = source.indexOf('const saveColumnWidths =', start);

assert.ok(start >= 0 && end > start, '열폭 드래그 처리 구간을 찾을 수 있어야 한다.');

const resizeSource = source.slice(start, end);
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
assert.match(
    moveSource,
    /requestAnimationFrame\(paintPreview\)/,
    '드래그 미리보기는 프레임당 한 번으로 제한해야 한다.'
);
assert.match(
    upSource,
    /setColumnWidthDraft/,
    '마우스를 놓을 때 최종 열폭을 React 상태에 반영해야 한다.'
);
assert.match(
    resizeSource,
    /merch-column-resize-guide/,
    '드래그 중에는 열 전체가 아니라 독립된 안내선만 표시해야 한다.'
);
assert.match(
    resizeSource,
    /resizeGuide\.style\.transform/,
    '드래그 안내선은 레이아웃을 다시 계산하지 않는 transform으로 이동해야 한다.'
);
assert.doesNotMatch(
    resizeSource,
    /nth-child|previewStyle\.textContent|data-merch-column-resize-preview/,
    '드래그 중 테이블 열 전체에 CSS 너비를 적용해 레이아웃을 반복 계산하면 안 된다.'
);
assert.match(
    resizeSource,
    /addEventListener\('blur', onUp\)/,
    '창 포커스를 잃어도 드래그 자원을 정리해야 한다.'
);

console.log('MerchOps column resize performance contract passed');
