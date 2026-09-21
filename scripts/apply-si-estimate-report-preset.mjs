// Temporary branch-only patch builder. Removed before the implementation PR.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
assert.equal(branch, 'chat/smartinput-estimate-report-preset-20260921');
function replaceOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `Exact integration anchor: ${label}`);
  return source.replace(before, after);
}
function edit(path, change) { const before = fs.readFileSync(path, 'utf8'); const after = change(before); assert.notEqual(before, after, path); fs.writeFileSync(path, after); }

edit('smartinput/input-template-mapper.js', s => {
  s = "import { createEstimateReportPreset, isEstimateReportHeaders, isEstimateReportMetadataRow, estimateReportField } from './estimate-report-preset.js?v=0.1.0';\n\n" + s;
  s = replaceOnce(s, '  if (!matches.length) {\n    return {', '  if (!matches.length) {\n    const builtin = createEstimateReportPreset(headers, targetDefinitions, voucherMode);\n    if (builtin) return builtin;\n    return {', 'builtin fallback after user templates');
  s = replaceOnce(s, 'function workingRows(sourceMatrix, sourceCellMatrix, headerRowIndex, headers, editJournal = {}, manualRows = []) {', 'function workingRows(sourceMatrix, sourceCellMatrix, headerRowIndex, headers, editJournal = {}, manualRows = [], voucherMode = \'\') {', 'working row signature');
  s = replaceOnce(s, '  }).filter(row => row.cells.some(hasMeaningfulSourceValue));\n  const manual =', '  }).filter(row => row.cells.some(hasMeaningfulSourceValue)\n    && !(isEstimateReportHeaders(headers, voucherMode) && isEstimateReportMetadataRow(row.cells, headers)));\n  const manual =', 'structural metadata exclusion');
  s = replaceOnce(s, '    editJournal || {},\n    manualRows || []\n  ).filter', '    editJournal || {},\n    manualRows || [],\n    session?.voucherMode\n  ).filter', 'rebuild mode');
  s = replaceOnce(s, '    templateRevision: Number(resolved.template?.revision || 0),', '    templateRevision: Number(resolved.template?.revision || 0),\n    ...(resolved.template?.builtinPresetId ? { builtinPresetId: resolved.template.builtinPresetId } : {}),', 'builtin provenance');
  s = replaceOnce(s, 'workingRows: workingRows(sourceMatrix, cellMatrix, safeIndex, headers, editJournal, manualRows),', 'workingRows: workingRows(sourceMatrix, cellMatrix, safeIndex, headers, editJournal, manualRows, voucherMode),', 'initial metadata exclusion');
  s = replaceOnce(s, 'workingRows(session.sourceMatrix, session.sourceCellMatrix || [], session.headerRowIndex, session.headers, session.editJournal, manualRows)', 'workingRows(session.sourceMatrix, session.sourceCellMatrix || [], session.headerRowIndex, session.headers, session.editJournal, manualRows, session.voucherMode)', 'deletion rebuild exclusion');
  s = replaceOnce(s, '          fieldId: target.id,\n          sourceDisplayValue:', '          fieldId: target.id,\n          ...(isEstimateReportHeaders(session.headers, session.voucherMode)\n            ? { informationGroup: estimateReportField(session.headers, mapping.columnIndex)?.informationGroup, valueSource: \'SOURCE_FILE\' } : {}),\n          sourceDisplayValue:', 'reference provenance');
  return s;
});

edit('smartinput/smartinput-contract.js', s => replaceOnce(s,
  "    productField('type1Code', '1종코드', 'ADDITIONAL',",
  "    productField('type1InboundPrice', '1입고', 'ADDITIONAL', { valueType: 'NUMBER', voucherModes: ['estimate'], inputAliases: ['1입고'] }),\n    productField('type1OutPrice', '1출고', 'ADDITIONAL', { valueType: 'NUMBER', voucherModes: ['estimate'], inputAliases: ['1출고'] }),\n    productField('type1Code', '1종코드', 'ADDITIONAL',", 'reference price fields'));

edit('smartinput/estimate-workbook-selector.js', s => {
  s = "import { isEstimateReportHeaders, isEstimateReportMetadataRow } from './estimate-report-preset.js?v=0.1.0';\n\n" + s;
  s = replaceOnce(s, 'export function isEstimateWorkbookItemRow(row = []) {\n  return', 'export function isEstimateWorkbookItemRow(row = [], headers = ERP_ESTIMATE_HEADERS) {\n  if (isEstimateReportHeaders(headers)) return Array.isArray(row) && row.some(meaningful) && !isEstimateReportMetadataRow(row, headers);\n  return', '24-column row filter');
  s = replaceOnce(s, '    && ERP_ESTIMATE_HEADERS.every((expected, index) => cellText(header[index]) === expected)\n    && header.slice(ERP_ESTIMATE_HEADERS.length).every(value => !meaningful(value));', '    && (isEstimateReportHeaders(header) || (ERP_ESTIMATE_HEADERS.every((expected, index) => cellText(header[index]) === expected)\n      && header.slice(ERP_ESTIMATE_HEADERS.length).every(value => !meaningful(value))));', 'legacy and current recognition');
  s = replaceOnce(s, 'const itemRows = matrix.slice(headerRowIndex + 1).filter(isEstimateWorkbookItemRow);\n  const customerNames = new Set(itemRows.map(row => cellText(row[2])).filter(Boolean));', "const itemRows = matrix.slice(headerRowIndex + 1).filter(row => isEstimateWorkbookItemRow(row, header));\n  const customerColumn = header.map(cellText).indexOf('거래처명');\n  const customerNames = new Set(itemRows.map(row => cellText(row[customerColumn])).filter(Boolean));", 'header-indexed recognition');
  return s;
});

edit('smartinput/smartinput.js', s => {
  s = s.replaceAll("./input-template-mapper.js?v=0.3.0", "./input-template-mapper.js?v=0.3.1");
  s = s.replaceAll("./estimate-workbook-selector.js?v=0.1.1", "./estimate-workbook-selector.js?v=0.1.2");
  s = s.replaceAll("./xlsx-source-reader.js?v=0.2.0", "./xlsx-source-reader.js?v=0.2.1");
  s = replaceOnce(s, "fileIntake: Object.freeze({ feature: 'file-intake-module', assetVersion: '0.2.0'", "fileIntake: Object.freeze({ feature: 'file-intake-module', assetVersion: '0.2.1'", 'reader asset version');
  s = replaceOnce(s, 'row.manual || isEstimateWorkbookItemRow(row.cells)', 'row.manual || isEstimateWorkbookItemRow(row.cells, session.headers)', 'projection header context');
  s = replaceOnce(s, "  if (!applyLatestTemplate && existing.status === MAPPING_SESSION_STATUS.NEW_TEMPLATE\n", "  if (!applyLatestTemplate && (existing.status === MAPPING_SESSION_STATUS.NEW_TEMPLATE || existing.templateDirty)\n", 'preserve edited mappings on recovery');
  s = replaceOnce(s, 'restored = { ...restored, status: existing.status, mappings: existing.mappings.map(mapping => ({ ...mapping })), issues: [...(existing.issues || [])] };', 'restored = { ...restored, status: existing.status, templateId: existing.templateId, templateName: existing.templateName, templateRevision: existing.templateRevision, builtinPresetId: existing.builtinPresetId, templateDirty: existing.templateDirty, mappings: existing.mappings.map(mapping => ({ ...mapping })), issues: [...(existing.issues || [])] };', 'preserve override identity');
  const start = s.indexOf('async function saveAppliedInputTemplateChanges()');
  const end = s.indexOf('\nfunction openInputTemplateEditor', start);
  assert.ok(start > 0 && end > start);
  let section = s.slice(start, end);
  section = replaceOnce(section, '  if (!previous) {', "  if (!previous && session.builtinPresetId !== 'SMARTINPUT_ESTIMATE_REPORT_V1') {", 'builtin customization allowed');
  section = replaceOnce(section, 'const updated = createTemplateRecord(session, previous.templateName, inputMappingDefinitions(), previous);', 'const updated = createTemplateRecord(session, previous?.templateName || session.templateName, inputMappingDefinitions(), previous || null);', 'save independent custom copy');
  section = replaceOnce(section, 'const next = state.inputTemplates.map(template => template.templateId === updated.templateId ? updated : template);', 'const next = previous\n      ? state.inputTemplates.map(template => template.templateId === updated.templateId ? updated : template)\n      : [...state.inputTemplates, updated];', 'retain other templates');
  section = replaceOnce(section, '      ...session,\n      templateName:', "      ...session,\n      templateId: updated.templateId,\n      builtinPresetId: '',\n      templateName:", 'custom identity');
  s = s.slice(0, start) + section + s.slice(end);
  const managerStart = s.indexOf('function openInputTemplateManager()');
  const managerEnd = s.indexOf('\nfunction ', managerStart + 10);
  let manager = s.slice(managerStart, managerEnd);
  const marker = "    message.textContent = state.inputTemplates.length ? '기존 양식의 변경은 다음 파일부터 적용됩니다.'";
  manager = replaceOnce(manager, marker, "    if (state.draft.activeMode === 'estimate') list.insertAdjacentHTML('afterbegin', '<article class=\"template-manager-row\" data-builtin-template=\"SMARTINPUT_ESTIMATE_REPORT_V1\"><div><strong>견적서현황</strong><small>기본 양식 · 24열 · 전표정보·품목 입력정보·상품 참조정보</small></div><span>자동 매핑</span></article>');\n" + marker, 'default visible in manager');
  s = s.slice(0, managerStart) + manager + s.slice(managerEnd);
  s = replaceOnce(s, "  $('mappingTableHeaders').innerHTML = `<th", "  $('mappingTableHeaders').dataset.mappingSessionId = session.sessionId;\n  $('mappingTableHeaders').dataset.mappingTemplateName = session.templateName || '';\n  $('mappingTableHeaders').innerHTML = `<th", 'mapping session identity');
  s = replaceOnce(s, 'data-mapping-column="${columnIndex}" ${issue ?', 'data-mapping-column="${columnIndex}" data-mapping-target-id="${esc(mapping?.targetFieldId || \'\')}" data-mapping-target-label="${esc(mappingTargetById(mapping?.targetFieldId)?.label || \'\')}" ${issue ?', 'exact target identity for left panel');
  return s;
});

edit('smartinput/xlsx-source-reader.js', s => s.replaceAll('estimate-workbook-selector.js?v=0.1.1', 'estimate-workbook-selector.js?v=0.1.2'));

edit('smartinput/source-preparation-ui-v2.js', s => {
  s = replaceOnce(s, '  let staged = new Map();', "  let staged = new Map();\n  let sourceSessionId = '';", 'session-scoped staging');
  const declaration = '  const guessedTargetId = stateText => targets.filter(target => String(stateText || \'\').includes(target.label)).sort((a,b)=>b.label.length-a.label.length)[0]?.id || \'\';';
  s = replaceOnce(s, declaration, "  function syncSourceSession() {\n    const id = byId('mappingTableHeaders')?.dataset.mappingSessionId || '';\n    if (id !== sourceSessionId) { sourceSessionId = id; staged = new Map(); targets = []; }\n  }\n\n  function includeMappedTargets(headers) {\n    headers.forEach(header => {\n      const id = header.dataset.mappingTargetId;\n      if (id && !targets.some(target => target.id === id)) targets.push({ id, label: header.dataset.mappingTargetLabel || id });\n    });\n  }", 'remove label guessing');
  s = replaceOnce(s, "    const fileName = byId('sourceSheetTitle')?.textContent?.trim() || '불러온 자료';", "    includeMappedTargets(headers);\n    const fileName = byId('sourceSheetTitle')?.textContent?.trim() || '불러온 자료';\n    const templateName = byId('mappingTableHeaders')?.dataset.mappingTemplateName || '';", 'include all preset targets');
  s = replaceOnce(s, '`${fileName} · ${headers.length}열 · 매핑을 확정한 뒤 적용하세요.`', '`${templateName ? templateName + \' · \' : \'\'}${fileName} · ${headers.length}열 · 매핑을 확인한 뒤 적용하세요.`', 'preset status label');
  s = replaceOnce(s, "        if (/비매핑/.test(stateText)) value = '__UNMAPPED__'; else value = guessedTargetId(stateText);", "        value = state === 'UNMAPPED' ? '__UNMAPPED__' : (header.dataset.mappingTargetId || '');", 'display real decisions');
  s = replaceOnce(s, "currentText:header.querySelector('small')?.textContent?.trim()||''", "currentId:header.dataset.mappingTargetId||''", 'exact current target');
  s = replaceOnce(s, "const changed = desired.filter(item=>item.state!=='MAPPED' || guessedTargetId(item.currentText)!==item.value);", "const changed = desired.filter(item=>item.value==='__UNMAPPED__' ? item.state!=='UNMAPPED' : item.state!=='MAPPED' || item.currentId!==item.value);", 'compare real decisions');
  s = replaceOnce(s, "if (item.state==='MAPPED' || item.state==='RECOMMENDED') await choose", "if (item.value==='__UNMAPPED__' || item.state==='MAPPED' || item.state==='RECOMMENDED') await choose", 'apply undecided exclusions');
  s = replaceOnce(s, '      staged = new Map();\n      status.textContent', '      status.textContent', 'retain success decisions until refresh');
  s = replaceOnce(s, '      queueRefresh(true);\n    } catch', '    } catch', 'defer refresh until idle');
  s = replaceOnce(s, '    finally { applying=false; updateStatus(); }', '    finally { applying=false; updateStatus(); queueRefresh(true); }', 'refresh after apply');
  s = replaceOnce(s, '    refreshQueued=false;\n    const headers=mappingHeaders();', '    refreshQueued=false;\n    syncSourceSession();\n    const headers=mappingHeaders();', 'clear stale session selections');
  s = replaceOnce(s, "attributeFilter:['data-mapping-state']", "attributeFilter:['data-mapping-state','data-mapping-target-id','data-mapping-session-id']", 'observe exact mapping identity');
  return s;
});

edit('smartinput/index.html', s => s.replaceAll('smartinput.js?v=0.15.0', 'smartinput.js?v=0.15.1')
  .replaceAll('smartinput-contract.js?v=0.6.5', 'smartinput-contract.js?v=0.6.6')
  .replaceAll('source-preparation-ui-v2.js?v=0.1.1', 'source-preparation-ui-v2.js?v=0.1.2'));

fs.writeFileSync('scripts/test-smartinput-estimate-report-preset.mjs', String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ESTIMATE_REPORT_HEADERS as H, ESTIMATE_REPORT_FIELDS, isEstimateReportHeaders } from '../smartinput/estimate-report-preset.js';
import { createMappingSession, projectMappedRows, validateTemplateDraft, createTemplateRecord, setColumnDecision, updateWorkingCell, deleteWorkingRows, reassignHeaderRow } from '../smartinput/input-template-mapper.js';
import { inspectEstimateWorkbookCandidate, ERP_ESTIMATE_HEADERS } from '../smartinput/estimate-workbook-selector.js';
import { buildEstimateF8RowsFromDraft } from '../smartinput/estimate-output.js';
const sandbox = { console, Date, Math, crypto: globalThis.crypto };
vm.runInNewContext(fs.readFileSync('smartinput/smartinput-contract.js','utf8'), sandbox);
const contract = sandbox.SMART_INPUT_CONTRACT;
assert.ok(contract);
const targets = ESTIMATE_REPORT_FIELDS.map(field => {
  const definition = contract.PRODUCT_FIELD_DEFINITIONS.find(item => item.id === field.projectionFieldId);
  assert.ok(definition, field.projectionFieldId);
  return { id: 'test.' + field.projectionFieldId, label: field.sourceHeader, projectionFieldId: field.projectionFieldId, scope:'voucher', valueType:definition.valueType };
});
const values = { '일자':'2026/09/02', '창고':'01', '거래처명':'테스트 거래처', '품목명':'테스트 상품', '규격':'EA', '품목코드':'001234', '입고가':2800, '출고가':3800, '입고B':'', '도매A':3300, '도매B':0, '행사가':'21500', '적요2':'0012', '간단설명':'테스트 품위', '단위':'소분', '1종연산':'8.5', '외주비':200, '경비':100, '노무비':200, '재료비':0, '1종규격':'', '1종코드':'', '1입고':'', '1출고':200 };
const data = H.map(header => values[header]);
const matrix = [['회사명 / 출력일시'], [...H], data, H.map(header => header === '품목코드' ? '0002' : ''), ['2026/09/21 (월) 오후 12:22:12']];
const settings = { matrix, headerRowIndex:1, targetDefinitions:targets, companyId:'TEST', voucherMode:'estimate', fileName:'renamed.xlsx', sheetName:'견적서현황내역' };
const before = JSON.stringify(matrix);
let session = createMappingSession(settings);
assert.equal(session.templateName,'견적서현황');
assert.equal(session.status,'TEMPLATE_APPLIED');
assert.equal(session.mappings.filter(m=>m.state==='MAPPED').length,24);
assert.equal(validateTemplateDraft(session,targets).valid,true);
assert.equal(session.workingRows.length,2,'retain incomplete products, exclude only report footer');
assert.equal(JSON.stringify(matrix),before);
assert.equal(session.sourceMatrix.length,5);
let rows=projectMappedRows(session,targets);
assert.equal(rows[0].unitPrice,2800); assert.equal(rows[0].outPrice,3800);
assert.equal(rows[0].quantity,undefined); assert.equal(rows[0].purchasePriceB,null);
assert.equal(rows[0].wholesaleB,0); assert.equal(rows[0].promoPrice,21500);
assert.equal(rows[0].memo2,'0012'); assert.equal(rows[0].itemCode,'001234'); assert.equal(rows[0].rowWarehouseCode,'01');
assert.equal(rows[0].specification,'EA'); assert.equal(rows[0].unit,'소분');
assert.equal(rows[0].outsourcingUnitPrice,200); assert.equal(rows[0].laborStandardCost,200);
assert.equal(rows[0].type1OutPrice,200); assert.equal(rows[0].type1Code,'');
assert.equal(rows[0].fieldValues['test.outsourcingUnitPrice'].informationGroup,'상품 참조정보');
const normalized=contract.normalizeRow(rows[0]);
assert.equal(normalized.quantity,null); assert.equal(normalized.type1OutPrice,200);
const f8=buildEstimateF8RowsFromDraft({rows, inputMapping:session});
assert.equal(f8[0].estimateF8SourceFields['출고가'].currentDisplayValue,'3800');
assert.equal(f8[0].estimateF8SourceFields['입고B'].currentDisplayValue,'');
assert.equal(f8[0].estimateF8SourceFields['도매B'].currentDisplayValue,'0');
const candidate={matrix,detection:{rowIndex:1},sheetName:'견적서현황내역'};
assert.equal(inspectEstimateWorkbookCandidate(candidate,'estimate').itemCount,2);
const reordered=H.slice().reverse();
assert.equal(isEstimateReportHeaders(reordered,'estimate'),true);
const reverse=createMappingSession({...settings,matrix:[reordered,data.slice().reverse()],headerRowIndex:0});
assert.equal(projectMappedRows(reverse,targets)[0].rowWarehouseCode,'01');
for (const mode of ['order','purchase','sale']) assert.equal(createMappingSession({...settings,voucherMode:mode}).status,'NEW_TEMPLATE');
for (const headers of [H.slice(1),[...H,'미확인 열'],[...H.slice(0,-1),H[0]]]) assert.equal(isEstimateReportHeaders(headers,'estimate'),false);
assert.equal(isEstimateReportHeaders(ERP_ESTIMATE_HEADERS,'estimate'),false,'legacy 23 remains distinct');
let edited=updateWorkingCell(session,'source-2',H.indexOf('입고가'),'0');
assert.equal(edited.workingRows.length,2);
assert.equal(projectMappedRows(edited,targets)[0].unitPrice,0);
assert.equal(deleteWorkingRows(edited,['source-3']).workingRows.length,1);
assert.equal(reassignHeaderRow(edited,1,[],targets).workingRows.length,2);
session=setColumnDecision(session,H.indexOf('출고가'),'UNMAPPED','',targets);
const custom=createTemplateRecord(session,'나의 견적서현황',targets);
const customSession=createMappingSession({...settings,templates:[custom]});
assert.equal(customSession.templateId,custom.templateId); assert.equal(customSession.mappings[7].state,'UNMAPPED');
assert.equal(createMappingSession({...settings,templates:[custom,{...custom,templateId:'DUP'}]}).status,'TEMPLATE_CONFLICT');
const broken={...custom,mappings:custom.mappings.map((m,i)=>i===0?{...m,targetFieldId:'MISSING'}:m)};
assert.equal(createMappingSession({...settings,templates:[broken]}).status,'INVALID_TEMPLATE');
assert.equal(createMappingSession({...settings,targetDefinitions:targets.slice(0,-1)}).status,'INVALID_TEMPLATE');
const expanded=[matrix[0],matrix[1],...Array.from({length:1000},(_,i)=>H.map(h=>h==='품목코드'?String(i):values[h])),matrix.at(-1)];
assert.equal(createMappingSession({...settings,matrix:expanded}).workingRows.length,1000);
console.log('PASS: built-in 24-column preset, 23-column compatibility, overrides, metadata, blank/zero, references, F8 evidence, variable length.');
`);

// Reuse the repository's dependency-free CDP harness in an isolated fresh profile.
let harness=fs.readFileSync('scripts/test-smartinput-input-template-browser-e2e.mjs','utf8').split('let browser;')[0];
harness=harness.replaceAll('oneapp-smartinput-mapping-e2e-', 'oneapp-smartinput-preset-e2e-');
harness=replaceOnce(harness,'  response.end(readFileSync(target));', String.raw`  if (target === join(root,'smartinput','smartinput.js')) {
    response.end(readFileSync(target,'utf8') + '\nwindow.__presetTest={snapshot:()=>({mode:state.draft.activeMode,ready:state.smartDataReady,busy:state.busy,templatesStatus:state.inputTemplatesStatus,draft:structuredClone(modeDraft()),templates:structuredClone(state.inputTemplates)}),upload:async(matrix)=>{const x=await ensureXlsx();const w=x.utils.book_new();x.utils.book_append_sheet(w,x.utils.aoa_to_sheet(matrix),"견적서현황내역");await handleFile(new File([x.write(w,{type:"array",bookType:"xlsx"})],"견적서현황(테스트).xlsx"));},saveTemplate:()=>saveAppliedInputTemplateChanges(),manager:()=>openInputTemplateManager()};');
  } else response.end(readFileSync(target));`, 'test-only state observer');
fs.writeFileSync('scripts/test-smartinput-estimate-report-preset-browser.mjs', harness + String.raw`
let browser;
let client;
try {
  const address=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address())));
  const executable=browserExecutable(); assert.ok(executable,'Chrome is required');
  browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  const debugPort=await waitFor(()=>{try{return readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/)[0];}catch{return null;}},'Chrome');
  const pages=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  client=new CdpClient(pages.find(p=>p.type==='page').webSocketDebuggerUrl); await client.connect();
  await Promise.all([client.send('Page.enable'),client.send('Runtime.enable'),client.send('Network.enable')]);
  const exceptions=[]; const writes=[];
  client.on('Runtime.exceptionThrown',e=>exceptions.push(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text));
  client.on('Network.requestWillBeSent',e=>{if(['POST','PUT','DELETE','PATCH'].includes(e.request.method))writes.push(e.request.url);});
  await client.send('Page.navigate',{url:'http://127.0.0.1:'+address.port+'/smartinput/'});
  await expr(client,'Boolean(window.__presetTest?.snapshot().ready)','SmartInput ready',60000);
  await click(client,'.mode-tab[data-mode="estimate"]');
  await expr(client,'window.__presetTest.snapshot().mode==="estimate" && !window.__presetTest.snapshot().busy && ["READY","EMPTY"].includes(window.__presetTest.snapshot().templatesStatus)','estimate templates ready',60000);
  const { ESTIMATE_REPORT_HEADERS:H }=await import('../smartinput/estimate-report-preset.js');
  const source={일자:'2026/09/02',창고:'01',거래처명:'테스트 거래처',품목명:'테스트 상품',규격:'EA',품목코드:'001234',입고가:2800,출고가:3800,입고B:'',도매A:3300,도매B:0,행사가:'21500',적요2:'0012',간단설명:'참조',단위:'소분','1종연산':'8.5',외주비:200,경비:100,노무비:200,재료비:0,'1종규격':'','1종코드':'','1입고':'','1출고':200};
  const data=Array.from({length:273},(_,i)=>H.map(h=>h==='품목코드'?'00'+String(i).padStart(5,'0'):source[h]));
  const matrix=[['회사명 / 테스트 출력'],[...H],...data,['2026/09/21 (월) 오후 12:22:12']];
  await evaluate(client,'window.__presetTest.upload('+JSON.stringify(matrix)+')');
  await expr(client,'window.__presetTest.snapshot().draft.rows.length===273','273 uploaded rows',60000);
  await expr(client,'document.querySelectorAll("#sourcePreparationList select").length===24 && !document.querySelector("#sourcePreparationApply").disabled','24 exact mappings enabled',60000);
  let snapshot=await evaluate(client,'window.__presetTest.snapshot()');
  assert.equal(snapshot.draft.inputMapping.templateName,'견적서현황');
  assert.equal(snapshot.draft.inputMapping.mappings.filter(m=>m.state==='MAPPED').length,24);
  assert.equal(snapshot.draft.inputMapping.workingRows.length,273);
  assert.equal(snapshot.draft.rows[0].unitPrice,2800); assert.equal(snapshot.draft.rows[0].outPrice,3800);
  assert.equal(snapshot.draft.rows[0].rowWarehouseCode,'01'); assert.equal(snapshot.draft.rows[0].itemCode,'0000000');
  assert.equal(snapshot.draft.rows[0].quantity,null); assert.equal(snapshot.draft.rows[0].purchasePriceB,null); assert.equal(snapshot.draft.rows[0].wholesaleB,0);
  assert.equal(snapshot.draft.rows[0].type1OutPrice,200); assert.equal(snapshot.draft.rows[0].type1Code,'');
  await click(client,'#sourcePreparationApply');
  await expr(client,'!document.querySelector("#sourcePreparationApply").disabled','apply unchanged preset');
  const priorSource=JSON.stringify(snapshot.draft.inputMapping.sourceMatrix);
  await evaluate(client,'window.__presetTest.manager()');
  await expr(client,'Boolean(document.querySelector("[data-builtin-template]"))','built-in in template manager');
  await click(client,'.field-mapping-dialog[open] [data-close]');
  // Customize one reference column; saving creates a user override, never edits the built-in.
  await evaluate(client,'(()=>{const s=document.querySelector("#sourcePreparationList [data-source-column=\\"7\\"]");s.value="__UNMAPPED__";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await click(client,'#sourcePreparationApply');
  await expr(client,'window.__presetTest.snapshot().draft.inputMapping.mappings[7].state==="UNMAPPED"','explicit exclusion',60000);
  await evaluate(client,'window.__presetTest.saveTemplate()');
  await expr(client,'window.__presetTest.snapshot().templates.length===1','custom override saved',60000);
  snapshot=await evaluate(client,'window.__presetTest.snapshot()');
  assert.notEqual(snapshot.templates[0].templateId,'SMARTINPUT_ESTIMATE_REPORT_V1');
  assert.equal(JSON.stringify(snapshot.draft.inputMapping.sourceMatrix),priorSource);
  await evaluate(client,'window.__presetTest.upload('+JSON.stringify(matrix)+')');
  await expr(client,'window.__presetTest.snapshot().draft.inputMapping.mappings[7].state==="UNMAPPED"','saved override wins',60000);
  assert.equal((await evaluate(client,'window.__presetTest.snapshot().draft.rows.length')),273);
  assert.deepEqual(exceptions,[]); assert.deepEqual(writes,[],'No production or master writes');
  console.log('PASS browser: actual XLSX upload, 273 synthetic items, all 24 mappings, enabled apply, user override save/reupload, no HTTP writes.');
} catch(error) {
  if(client) console.error('BROWSER DIAGNOSTIC',JSON.stringify(await evaluate(client,'({text:document.body.innerText.slice(-3000),snapshot:window.__presetTest?.snapshot()})').catch(()=>null)).slice(0,16000));
  throw error;
} finally { client?.close(); browser?.kill(); server.close(); rmSync(profile,{recursive:true,force:true}); }
`);

fs.writeFileSync('smartinput/ESTIMATE_REPORT_PRESET.md', '# 견적서현황 기본 양식\n\n사용자 승인: 같은 구조의 견적서현황을 업로드 즉시 매핑한다. 기준 main: 67251bbb68b8cb12c1e70a88ae8cd326aa0807eb.\n\n- 견적 모드에서 24개 항목명을 확인한다. 파일명·일자·회사명·행 수는 고정하지 않는다. 열 순서는 달라도 항목명으로 연결한다. 부족·추가·중복 항목은 자동 승인하지 않는다.\n- 기존 회사별 저장 양식이 우선이다. 기본 양식 수정 저장은 별도 사용자 양식으로 보존한다.\n- 입고가는 견적 단가, 출고가는 별도 가격으로 보존한다. 규격과 단위는 분리한다. 외주비·경비·노무비·재료비·1종정보는 상품 참조값이며 원본 출처를 보존한다.\n- 1입고·1출고를 기본 참조항목으로 제공하되 중앙 입력 열은 늘리지 않는다. 숫자 0·공란·앞자리 0 코드·적요2 문자 값을 유지하고 수량을 생성하지 않는다.\n- 원본 행렬은 유지하고 출력시각만 있는 푸터와 반복 헤더만 작업행에서 제외한다. 상품정보 마스터 쓰기·새 가격 계산·견적서 병합·1종 품목 생성은 하지 않는다.\n- 기존 23열 선택 규칙, 다른 전표 모드, 공통 저장소·공통헤더·출력 계산 계약은 유지한다.\n- 롤백: 해당 PR을 revert한다. 저장 데이터 삭제나 DB 마이그레이션은 없다. 기존 추가 필드와 원본 증적은 보존된다.\n\n검증: test-smartinput-estimate-report-preset.mjs, test-smartinput-estimate-report-preset-browser.mjs와 기존 매핑·시트선택·XLSX·F8 회귀를 실행한다. 공개 테스트에는 합성 자료만 사용한다.\n');
console.log('Scoped preset integration generated.');
