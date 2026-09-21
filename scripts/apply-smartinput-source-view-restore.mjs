// Temporary branch-only builder, removed before PR. User: restore input/source view toggle.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const base='9e40d378e51d380133c3d61fb111595e0e8f1937';
assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'chat/smartinput-source-view-restore-20260921');
const expected={
  'smartinput/source-preparation-ui-v2.js':'b4828184f405da0ec716d337dddd8218d3e57542',
  'smartinput/index.html':'fc64a0770c8a5c4a03837368f6823b2559e01351',
  'smartinput/smartinput.js':'b806a1fa9ad1767ba12521cdd2f585a122867cb3'
};
for(const [path,sha] of Object.entries(expected)) assert.equal(execFileSync('git',['rev-parse','HEAD:'+path],{encoding:'utf8'}).trim(),sha,'Source baseline: '+path);
function replaceOnce(source,before,after,label){assert.equal(source.split(before).length-1,1,label);return source.replace(before,after);}
function edit(path,fn){const before=fs.readFileSync(path,'utf8');const after=fn(before);assert.notEqual(before,after,path);fs.writeFileSync(path,after);}
edit('smartinput/source-preparation-ui-v2.js',s=>{
  s=replaceOnce(s,'      #mappingWorktable { display:none !important; }\n','', 'unhide source worktable');
  return replaceOnce(s,'      #tableViewSwitch { display:none !important; }\n','', 'restore view controls');
});
edit('smartinput/index.html',s=>replaceOnce(s,'source-preparation-ui-v2.js?v=0.1.2','source-preparation-ui-v2.js?v=0.1.3','cache invalidation'));
edit('scripts/test-smartinput-stage5-feature-loading.mjs',s=>replaceOnce(s,'source-preparation-ui-v2\\.js\\?v=0\\.1\\.2','source-preparation-ui-v2\\.js\\?v=0\\.1\\.3','cache assertion only'));

edit('scripts/test-smartinput-estimate-report-preset-browser.mjs',s=>{
  const ready="  const { ESTIMATE_REPORT_HEADERS:H }=await import('../smartinput/estimate-report-preset.js');";
  s=replaceOnce(s,ready,String.raw`  assert.equal(await evaluate(client,'(()=>{const c=document.querySelector("#tableViewSwitch");return !c.hidden && getComputedStyle(c).display!=="none" && c.getBoundingClientRect().height>0;})()'),true,'input/source view switch must be visible');
  assert.equal(await evaluate(client,'document.querySelector("[data-table-view=source]").disabled'),true,'no original source means source view is unavailable');
`+ready,'view control regression');
  const anchor="  assert.equal(snapshot.draft.rows[0].type1OutPrice,200); assert.equal(snapshot.draft.rows[0].type1Code,'');";
  s=replaceOnce(s,anchor,anchor+String.raw`
  // A view switch must change presentation, not remap or rebuild business data.
  const visibleClick=async selector=>{
    const point=await evaluate(client,'(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.scrollIntoView({block:"nearest",inline:"nearest"});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,visible:!el.disabled&&r.width>0&&r.height>0&&getComputedStyle(el).display!=="none"};})()');
    assert.equal(point.visible,true,'view button must be reachable');
    await pointerClick(client,point.x,point.y);
  };
  const dataSnapshot=()=>evaluate(client,'(()=>{const d=window.__presetTest.snapshot().draft;return JSON.stringify({rows:d.rows,source:d.inputMapping.sourceMatrix,mappings:d.inputMapping.mappings,journal:d.inputMapping.editJournal});})()');
  const beforeView=await dataSnapshot();
  await visibleClick('[data-table-view="source"]');
  await expr(client,'document.querySelector("#tableScroll").dataset.tableView==="source" && !document.querySelector("#mappingWorktable").hidden && getComputedStyle(document.querySelector("#mappingWorktable")).display!=="none"','source view actually visible');
  assert.equal(await evaluate(client,'document.querySelector("#voucherInputTable").hidden'),true);
  assert.deepEqual(await evaluate(client,'[...document.querySelectorAll("#mappingTableHeaders th[data-mapping-column]")].map(th=>th.querySelector("strong").textContent.trim())'),H,'all 24 original labels and column order');
  assert.equal(await dataSnapshot(),beforeView,'source switch preserves rows, source, mappings, edits');
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden && document.querySelector("#mappingWorktable").hidden','input view restored');
  assert.equal(await dataSnapshot(),beforeView,'round trip is presentation-only');
  const firstRowId=snapshot.draft.rows[0].rowId;
  const inputPrice='[data-row-id="'+firstRowId+'"] input[data-field="unitPrice"]';
  await input(client,inputPrice,'3100');
  await expr(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice===3100','input price edited');
  const afterInputEdit=await dataSnapshot();
  await visibleClick('[data-table-view="source"]');
  await expr(client,'!document.querySelector("#mappingWorktable").hidden','source after input edit');
  assert.equal(await dataSnapshot(),afterInputEdit,'switch must not revert an input edit');
  const sourcePrice='[data-mapping-row-id="'+firstRowId+'"] [data-mapping-column="7"] input';
  await input(client,sourcePrice,'4200');
  await expr(client,'window.__presetTest.snapshot().draft.rows[0].outPrice===4200','source work-copy price edited');
  const afterSourceEdit=await dataSnapshot();
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden','input after source edit');
  assert.equal(await dataSnapshot(),afterSourceEdit,'switch must not revert a source work-copy edit');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice'),3100);
  assert.equal(await evaluate(client,'JSON.stringify(window.__presetTest.snapshot().draft.inputMapping.sourceMatrix)'),JSON.stringify(snapshot.draft.inputMapping.sourceMatrix),'original evidence remains immutable');
  await visibleClick('[data-table-view="source"]');
  await click(client,'#sourcePreparationApply');
  assert.equal(await evaluate(client,'document.querySelector("#tableScroll").dataset.tableView'),'source','mapping apply does not change selected view');
  await click(client,'#inputTemplateReloadButton');
  await expr(client,'["READY","EMPTY"].includes(window.__presetTest.snapshot().templatesStatus)','template reload completed',60000);
  assert.equal(await evaluate(client,'document.querySelector("#tableScroll").dataset.tableView'),'source','template reload preserves selected source view');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice'),3100,'template reload retains work-copy edits');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].outPrice'),4200);
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden','return to input for preset regression');
`,'source-view and edit-preservation browser checks');
  return s.replace('PASS browser: actual XLSX upload, 273 synthetic items, all 24 mappings, enabled apply, user override save/reupload, no HTTP writes.','PASS browser: actual XLSX 273 rows/24 columns, visible source-input round trips, bidirectional edits preserved, original evidence immutable, template reload and mapping apply keep selected view, custom template save/reupload, no HTTP writes.');
});
fs.writeFileSync('smartinput/SOURCE_VIEW_RESTORE.md', '# SmartInput 원본형 보기 복구\n\n- 사용자 승인: 원본 엑셀의 항목명·열 순서로 중앙표를 전환할 수 있도록 업데이트.\n- 기준: '+base+'. 개발·검증은 실행 담당 직접 수행, 독립 PM 판정 아님.\n- 원인: source-preparation-ui-v2.js의 CSS가 mappingWorktable과 tableViewSwitch를 display:none!important로 강제 숨김.\n- 수정: 두 강제 숨김 규칙만 제거. 중앙 상단 입력형/원본형 및 기존 원본형 작업표 복구. source-preparation 캐시 0.1.3.\n- 기존 입력형 기본값, 24열 견적서현황 자동매핑, 매핑 적용·양식 저장·견적서 저장, 표 전환 로직, 원본·작업본·공통저장소와 타 앱은 변경하지 않음.\n- 검증: 실제 XLSX 합성 273행 업로드, 물리 클릭으로 24열 원본형 확인, 입력형 왕복, 입력형/원본형 각 수정값 및 원본 증적 보존, 양식 재조회/매핑 적용 후 선택한 보기 유지. 기존 preset·매핑·시트선택·F8·Stage5 및 저장소 CI.\n- 롤백: 이 PR의 소스만 revert. 업무 데이터 삭제·마이그레이션 없음.\n');
console.log('Generated source-view restore: only two production CSS rules removed plus cache version; existing view/state logic unchanged.');
