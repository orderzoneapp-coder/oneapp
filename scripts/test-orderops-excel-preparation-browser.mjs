import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Actual canonical page + Chromium. Only the local test server exposes __ops.
// Files and failures are synthetic; no production profile, external POST or
// inactive workbench module is used. DOM file events are not an OS picker claim.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const XLSX = require(join(ROOT, "customer-master/vendor/xlsx.full.min.js"));
const evidence = resolve(process.env.ORDEROPS_PREPARATION_EVIDENCE_DIR || join(tmpdir(), "orderops-excel-preparation-evidence"));
const profile = mkdtempSync(join(tmpdir(), "orderops-excel-preparation-browser-"));
mkdirSync(evidence, { recursive: true });
const downloads = mkdtempSync(join(evidence, "downloads-"));
const sourcePaths = ["orderops/list.html", "orderops/excel-preparation.js", "orderops/excel-preparation-ui.js", "orderops/excel-preparation.css", "orderFulfillmentEngine.js", "orderFulfillmentWorkbook.js"];
const sources = new Map(sourcePaths.map((path) => [path, readFileSync(join(ROOT, path))]));
const report = {
  startedAt: new Date().toISOString(), result: "running", evidence, profile,
  interaction: "DOM File/DataTransfer/change/click events in real Chromium; not OS file-picker automation",
  sourceHashes: Object.fromEntries([...sources].map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")])),
  checks: [], consoleProblems: [], errors: [], externalRequests: [], externalWrites: [],
};
const originalHtml = String(sources.get("orderops/list.html"));
const anchor = "      // Keep the current NEXUS host handshake";
assert.equal(originalHtml.split(anchor).length, 2, "Expected one canonical test injection point");
const html = originalHtml.replace(anchor, `      globalThis.__ops = { state, get preparationController() { return preparationController; }, handleFile, handleBundleFiles, handleIntegratedFile, commitInputCandidates, runAnalysis, renderResults, persistLocalWorkspace, restoreLocalRecord };\n${anchor}`);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    report.errors.push(`Unexpected local write: ${request.method} ${request.url}`);
    response.writeHead(405).end();
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  const file = resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(pathname === "/orderops/list.html" ? html : sources.get(pathname.slice(1)) || readFileSync(file));
});
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function until(action, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await action()) return; }
    catch (error) {
      if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(error.message)) throw error;
    }
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}
const commandPath = (name) => {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
};
function workbookRow(book, sheetName, headerName) {
  const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, defval: "" });
  const headerIndex = rows.findIndex((row) => row.includes(headerName));
  assert.ok(headerIndex >= 0, `${sheetName}: ${headerName} header`);
  return Object.fromEntries(rows[headerIndex].map((header, index) => [header, rows[headerIndex + 1]?.[index] ?? ""]));
}

let browser, socket, send, ev, shot;
try {
  const executable = [process.env.CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"), process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"), commandPath("google-chrome"), commandPath("chromium")].filter(Boolean).find(existsSync);
  assert.ok(executable, "Chromium/Chrome required; set CHROME_PATH");
  assert.equal(typeof WebSocket, "function", "Node with built-in WebSocket is required");
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1366,900", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let port;
  await until(() => {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]; return Boolean(port); }
    catch (error) { if (!["ENOENT", "EBUSY"].includes(error.code)) throw error; return false; }
  }, "Chromium debugging endpoint");
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page");
  assert.ok(target?.webSocketDebuggerUrl);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
    }
    if (message.method === "Runtime.exceptionThrown") report.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(message.params.type)) {
      report.consoleProblems.push({ type: message.params.type, text: message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ") });
    }
    if (message.method === "Log.entryAdded" && ["warning", "error"].includes(message.params.entry.level)) report.consoleProblems.push(message.params.entry);
    if (message.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: true }).catch((error) => report.errors.push(error.message));
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const response = async () => {
        if (request.url.startsWith(origin + "/")) return send("Fetch.continueRequest", { requestId });
        report.externalRequests.push({ method: request.method, url: request.url });
        if (!["GET", "HEAD"].includes(request.method)) report.externalWrites.push({ method: request.method, url: request.url });
        if (request.url === "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js") {
          return send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: readFileSync(join(ROOT, "customer-master/vendor/xlsx.full.min.js")).toString("base64") });
        }
        // No external request reaches a network endpoint, even on failure paths.
        return send("Fetch.fulfillRequest", { requestId, responseCode: 204, body: "" });
      };
      void response().catch((error) => report.errors.push(error.message));
    }
  };
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
  ev = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  shot = async (name) => {
    const result = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidence, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log(`PASS ${name}`); };
  const settled = (label) => until(() => ev(`Boolean(__ops?.preparationController && !__ops.state.analysisRunning && !Object.values(__ops.state.loading).some(Boolean) && !__ops.preparationController.isBusy())`), label);
  const assertApplyReleased = async (label) => {
    await settled(label);
    check(`${label}: execution button and system status leave busy state`, await ev("!document.querySelector('#analyzeButton').disabled && !/자료\\s*처리\\s*중/.test(document.querySelector('#systemMessage').textContent)"));
  };
  const change = async (selector, value) => {
    await ev(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input || input.disabled) throw Error('Missing/disabled editor: ' + ${JSON.stringify(selector)}); input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
    await settled(`change ${selector}`);
  };
  const assertPreview = async (view, label) => {
    await until(() => ev(`__ops.state.activePreview===${JSON.stringify(view)}`), label);
    check(label, await ev(`document.querySelector('#prepPreviewTabs [data-preview="${view}"]').getAttribute('aria-selected')==='true' && !document.querySelector('#resultsPanel').classList.contains('hidden')`));
  };
  const selectPreview = async (view) => {
    await ev(`document.querySelector('#prepPreviewTabs [data-preview="${view}"]').click();true`);
    await settled(`select ${view} preview`);
    await assertPreview(view, `explicit ${view} preview selection`);
  };
  const snapshot = () => ev(`JSON.stringify({workspace:__ops.state.workspace,inputs:['orders','inventory','purchases','sales'].map(kind=>__ops.state[kind]),pointer:localStorage.getItem('oneapp.shipping.recovery.pointer.v1'),downloadDisabled:document.querySelector('#downloadButton').disabled})`);
  const installFixtures = () => ev(`(() => {
    globalThis.__fixture = (kind, options = {}) => {
      const headers = ['일자','창고','담당','단위','품목코드','품목명','규격',options.quantityHeader || (options.custom ? '주문량X' : '수량'),'단가','공급가액','적요','적요1','거래처','그룹'];
      const quantity = options.quantity ?? 10, price = options.price ?? 1000;
      let matrix = kind === 'inventory'
        ? [['품목코드','품목명','규격','단위','수량','1창고','3서울','4전송'],['0001','합성상품','원본규격','EA',quantity,quantity,0,0]]
        : [headers,[options.date || '2026-09-17','1창고','담당A','EA','0001','합성상품','원본규격',quantity,price,Number(quantity)*Number(price),'원본 적요','','거래처A','기본']];
      if (kind === 'inventory' && options.explicitWarehouse) matrix = [
        ['품목코드','품목명','규격','단위','수량','1창고','신선A','가격표','참고금액'],
        ['0001','합성상품','원본규격','EA',12,2,4,6,999]
      ];
      if (kind === 'purchases' || kind === 'sales') matrix = [
        ['품목코드','품목명','규격','단위','수량',kind==='purchases'?'구매처':'거래처'],
        ['0001','합성상품','원본규격','EA',quantity,kind==='purchases'?'참고 구매처':'참고 판매처']
      ];
      if ((kind === 'purchases' || kind === 'sales') && options.duplicateQuantity !== undefined) {
        matrix[0].splice(5,0,'수량');matrix[1].splice(5,0,options.duplicateQuantity);
      }
      if (options.reorder) { const indices = [7,4,0,2,1,3,5,6,8,9,10,11,12,13]; matrix = matrix.map(row=>indices.map(index=>row[index])); }
      const book = XLSX.utils.book_new();
      if (options.instruction) XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['업로드 안내'],['합계 행을 제외하세요']]),'설명');
      for (const name of options.sheets || [{orders:'주문',inventory:'재고',purchases:'구매',sales:'판매'}[kind]]) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), name);
      return new File([XLSX.write(book,{type:'array',bookType:'xlsx'})], options.name || kind+'.xlsx');
    };
    globalThis.__inputFixture = (kind, options = {}) => {
      const data = new DataTransfer(); data.items.add(__fixture(kind, options));
      const input = document.getElementById(kind+'Input'); input.files = data.files;
      input.dispatchEvent(new Event('change',{bubbles:true})); return true;
    };
    globalThis.__extraActions = [];
    globalThis.__sourceInputChanges = [];
    document.addEventListener('click',event=>{if(event.target.closest('#analyzeButton,#prepApplyButton')) __extraActions.push(event.target.closest('button').id);},true);
    document.addEventListener('change',event=>{if(['ordersInput','inventoryInput','purchasesInput','salesInput','integratedInput'].includes(event.target.id)) __sourceInputChanges.push(event.target.id);},true);
    return true;
  })()`);
  const upload = async (kind, options = {}) => {
    await ev(`__inputFixture(${JSON.stringify(kind)},${JSON.stringify(options)})`);
    await settled(`${kind} file change`);
  };
  const uploadIntegrated = async (kind, options = {}) => {
    await ev(`(()=>{const data=new DataTransfer();data.items.add(__fixture(${JSON.stringify(kind)},${JSON.stringify(options)}));const input=document.querySelector('#integratedInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await settled(`${kind} integrated file change`);
  };
  const workValues = () => ev(`(() => { const w=__ops.state.workspace, row=w?.orders?.[0], inventory=w && ShippingManagementEngine.getInventoryViewRows(w).rows[0]; return {quantity:row?.quantity,price:row?.unitPrice,purchase:w && ShippingManagementEngine.getPurchaseInputs(w)['0001'],stock:inventory?.stockTotal,preview:__ops.state.activePreview}; })()`);
  for (const method of ["Runtime.enable", "Page.enable", "Log.enable"]) await send(method);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  report.browser = await send("Browser.getVersion");
  report.origin = origin;
  await send("Page.navigate", { url: `${origin}/orderops/list.html?isolated=excel-preparation` });
  await until(() => ev("Boolean(globalThis.__ops?.state.db && __ops.preparationController && globalThis.XLSX)"), "page + preparation controller + IndexedDB");
  await installFixtures();

  const relativeFooterRange = await ev(`(()=>{
    const helper=OrderOpsExcelPreparation;
    const header=['일자','품목코드','품목명','규격','단위','수량','단가','공급가액','적요','적요1','거래처','그룹','원본참고'];
    const row=index=>['2026-09-18',String(index).padStart(4,'0'),'상품'+index,'','EA',1,1200,1200,'','','거래처','G','유지'];
    const original=[['주문 원본'],header,...Array.from({length:101},(_,index)=>row(index+1)),['생성일','2026-09-18']];
    const draft=helper.createDraft({kind:'orders',rawMatrix:original,parsed:{headerRowIndex:1}});draft.endRow=103;
    const saved=helper.createTemplate({name:'하단 날짜 제외',draft,rawMatrix:original});
    const next=[['다음 주문'],header,...Array.from({length:157},(_,index)=>row(index+1)),['생성일','2026-09-19']];
    const matched=helper.matchTemplate({template:saved.template,kind:'orders',rawMatrix:next});
    const applied=matched.ok&&helper.applyDraft({rawMatrix:next,draft:matched.draft});
    return {saved:saved.ok,footerRows:saved.template?.rangePolicy?.footerRowCount,absoluteEndStored:Object.hasOwn(saved.template||{},'endRow'),matched:matched.ok,endRow:matched.draft?.endRow,applied:applied.ok,count:applied.sourceMetadata?.sourceRowNumbers?.length,last:applied.sourceMetadata?.sourceRowNumbers?.at(-1)};
  })()`);
  assert.deepEqual(relativeFooterRange, { saved: true, footerRows: 1, absoluteEndStored: false, matched: true, endRow: 159, applied: true, count: 157, last: 159 });
  check("actual Chromium applies saved bottom-1 rule from row 104/103 through row 160/159", true);

  await upload("orders");
  check("left range status explains the currently applied end row and relative footer rule", await ev("document.querySelector('#prepRangeRule').textContent.includes('현재 적용 끝 행: 2행') && document.querySelector('#prepRangeRule').textContent.includes('하단 0행 제외')"));
  check("orders alone: raw rows visible, no invented workspace/stock", await ev(`!__ops.state.workspace && __ops.state.orders.rows[0].quantity===10 && !document.querySelector('#resultsPanel').classList.contains('hidden') && document.querySelector('#previewTable').textContent.includes('합성상품')`));
  await assertPreview("allocations", "order upload opens order preview without a calculation workspace");
  check("orders alone expose the shared column and view-preset tools", await ev(`!document.querySelector('#viewPresetSaveButton').disabled && document.querySelectorAll('#columnVisibilityMenu [data-column-visible]').length>=10`));
  await ev(`(()=>{const search=document.querySelector('#tableSearchInput');search.value='합성';search.dispatchEvent(new Event('input',{bubbles:true}));const group=[...document.querySelectorAll('#columnVisibilityMenu .column-menu-item')].find(label=>label.querySelector('span')?.textContent.trim()==='그룹')?.querySelector('[data-column-visible]');if(!group)throw Error('Missing standalone order group column');group.checked=false;group.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#viewPresetSaveButton').click();document.querySelector('#viewPresetNameInput').value='단독 주문 양식';document.querySelector('[data-save-view-preset]').click();return true;})()`);
  await until(() => ev("__ops.state.selectedOrderViewPresetId && document.querySelector('#viewPresetSelect').value===__ops.state.selectedOrderViewPresetId"), "orders-only view preset saved");
  const orderOnlyPresetId = await ev("__ops.state.selectedOrderViewPresetId");
  check("orders-only preset applies search and hides group without inventing stock", await ev(`!__ops.state.workspace && __ops.state.searchQuery==='합성' && ![...document.querySelectorAll('#previewTable thead th')].some(th=>th.textContent.includes('그룹')) && !document.querySelector('#previewTable').textContent.includes('재고수량')`));
  await shot("01-orders-only");
  await upload("inventory");
  await until(() => ev("__ops.state.workspace?.orders?.length===1 && __ops.state.activePreview==='inventory'"), "automatic inventory preview");
  assert.deepEqual(await workValues(), { quantity: 10, price: 1000, purchase: "", stock: 10, preview: "inventory" });
  await assertPreview("inventory", "inventory upload opens inventory even when orders are already available");
  check("valid input changes require no apply/analyze click", await ev("__extraActions.length===0 && !document.querySelector('#downloadButton').disabled"));

  await selectPreview("allocations");
  await ev(`(()=>{const select=document.querySelector('#viewPresetSelect');select.value=${JSON.stringify(orderOnlyPresetId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await settled("apply the orders-only preset to the calculated order view");
  check("orders-only preset can be selected after inventory creates a calculation workspace", await ev(`__ops.state.selectedOrderViewPresetId===${JSON.stringify(orderOnlyPresetId)} && document.querySelector('#tableSearchInput').value==='합성' && ![...document.querySelectorAll('#previewTable thead th')].some(th=>th.textContent.includes('그룹'))`));
  await change('.order-edit-input[data-order-field="quantity"]', 7);
  await change('.order-edit-input[data-order-field="unitPrice"]', 1200);
  await change('.purchase-input[data-purchase-code="0001"]', "수정 구매처");
  await upload("inventory", { quantity: 4, name: "재고-교체4.xlsx" });
  assert.deepEqual(await workValues(), { quantity: 7, price: 1200, purchase: "수정 구매처", stock: 4, preview: "inventory" });
  await assertPreview("inventory", "replacement inventory upload keeps its own result view");
  check("inventory replacement preserves order7 / price1200 / supplier", await ev("__ops.state.workspace.sourceFiles.orders.matrix[1][7]===10 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4"));

  await selectPreview("allocations");
  await ev(`(()=>{const select=document.querySelector('#viewPresetSelect');select.value=${JSON.stringify(orderOnlyPresetId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await settled("restore the saved order view before manual reanalysis");
  const beforeReanalysisView = await ev("JSON.stringify({preview:__ops.state.activePreview,search:__ops.state.searchQuery,preset:__ops.state.selectedOrderViewPresetId,hidden:__ops.state.hiddenColumnSettings.tabs.allocations})");
  await ev("document.querySelector('#analyzeButton').click();true");
  await settled("manual reanalysis preserves the current result view");
  assert.equal(await ev("JSON.stringify({preview:__ops.state.activePreview,search:__ops.state.searchQuery,preset:__ops.state.selectedOrderViewPresetId,hidden:__ops.state.hiddenColumnSettings.tabs.allocations})"), beforeReanalysisView);
  check("manual reanalysis preserves the current table, search and saved preset", await ev(`__ops.state.activePreview==='allocations' && document.querySelector('#tableSearchInput').value==='합성' && document.querySelector('#viewPresetSelect').value===${JSON.stringify(orderOnlyPresetId)} && ![...document.querySelectorAll('#previewTable thead th')].some(th=>th.textContent.includes('그룹'))`));
  await selectPreview("inventory");

  const existingDownloads = new Set(readdirSync(downloads));
  await ev("document.querySelector('#downloadButton').click(); true");
  let downloaded;
  await until(() => { downloaded = readdirSync(downloads).find((file) => /\.xlsx$/i.test(file) && !existingDownloads.has(file)); return Boolean(downloaded); }, "actual Excel download");
  const reopened = XLSX.read(readFileSync(join(downloads, downloaded)), { type: "buffer" });
  const exportedOrder = workbookRow(reopened, "주문현황", "주문수량");
  assert.equal(exportedOrder["주문수량"], 7);
  assert.equal(exportedOrder["단가"], 1200);
  assert.equal(exportedOrder["공급가액"], 8400);
  assert.equal(exportedOrder["구매"], "수정 구매처");
  assert.equal(workbookRow(reopened, "창고별재고", "1창고")["1창고"], 4);
  check("downloaded XLSX reopens with edited values and replaced stock", true);
  report.download = join(downloads, downloaded);

  const savedId = await ev("__ops.persistLocalWorkspace().then(record=>record.recordId)");
  const previousTimeOrigin = await ev("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(() => ev(`performance.timeOrigin!==${previousTimeOrigin} && document.readyState==='complete' && Boolean(globalThis.__ops?.state.db && __ops.preparationController && __ops.state.recoveryRecords.some(item=>item.valid && item.record.recordId===${JSON.stringify(savedId)}))`), "verified IndexedDB record after reload");
  await ev("document.querySelector('#headerRestoreButton').click(); true");
  await until(() => ev("__ops.state.workspace?.orders?.[0]?.quantity===7"), "restore through header action");
  assert.deepEqual(await workValues(), { quantity: 7, price: 1200, purchase: "수정 구매처", stock: 4, preview: "inventory" });
  check("IndexedDB recovery restores work without source File objects", await ev("!__ops.state.orders && !__ops.state.inventory"));
  await installFixtures();

  await ev("__ops.persistLocalWorkspace().then(()=>true)");
  const beforeFailures = await snapshot();
  await ev(`(async()=>{const file=__fixture('orders',{name:'read-failure.xlsx'});Object.defineProperty(file,'arrayBuffer',{value:async()=>{throw Error('INJECTED_READ_FAILURE');}});await __ops.handleFile('orders',file);return true;})()`);
  await settled("read rejection");
  assert.equal(await snapshot(), beforeFailures);
  check("read rejection preserves work / inputs / output / recovery pointer", true);
  const calculationError = await ev(`(async()=>{const parsed=await __ops.preparationController.parse(__fixture('inventory',{quantity:9,name:'calculation-failure.xlsx'}),'inventory',{probe:true});parsed.toJSON=()=>{throw Error('INJECTED_CANDIDATE_CALCULATION_FAILURE');};try{await __ops.commitInputCandidates(new Map([['inventory',parsed]]));return '';}catch(error){return error.message;}})()`);
  assert.match(calculationError, /INJECTED_CANDIDATE_CALCULATION_FAILURE/);
  await settled("candidate calculation rejection");
  assert.equal(await snapshot(), beforeFailures);
  check("candidate calculation rejection is atomic", true);

  const beforeMapping = await ev("JSON.stringify(__ops.state.workspace)");
  await upload("orders", { custom: true, quantity: 6, name: "custom-orders.xlsx" });
  check("unknown quantity header enters left review, preserving work", await ev("document.querySelector('#prepMappingStatus').dataset.state==='review' && document.querySelector('#prepFileDetails').open && document.querySelector('#prepMappingDetails').open"));
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeMapping);
  await change('#prepColumnMappings select[data-prep-column="7"]', "수량");
  for (const invalid of [0, "", 1.5, 999]) {
    await change('#prepHeaderRow', invalid);
    assert.equal(await ev("document.querySelector('#prepHeaderRow').value"), "1");
    assert.equal(await ev("document.querySelector('[data-prep-column=\"7\"]').value"), "수량");
  }
  check("invalid header-row input preserves the current mapping instead of resetting it", true);
  await ev("document.querySelector('#prepTemplateName').value='합성 주문 양식';document.querySelector('#prepTemplateName').dispatchEvent(new Event('input',{bubbles:true}));true");
  await ev("document.querySelector('#prepFileDetails').open=false;document.querySelector('#prepMappingDetails').open=false;document.querySelector('[data-prep-kind=inventory]').click();document.querySelector('[data-prep-kind=orders]').click();document.querySelector('#prepFileDetails').open=true;document.querySelector('#prepMappingDetails').open=true;true");
  check("file/kind selection and both accordions preserve mapping draft", await ev(`document.querySelector('#prepFileName').textContent==='custom-orders.xlsx' && document.querySelector('#prepTemplateName').value==='합성 주문 양식' && document.querySelector('[data-prep-column="7"]').value==='수량'`));
  await ev("document.querySelector('#prepSaveTemplateButton').click();true");
  await until(() => ev("JSON.parse(localStorage.getItem('oneapp.orderops.excel-templates.v1')||'{}').items?.some(item=>item.name==='합성 주문 양식')"), "mapping template saved");
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeMapping);
  check("mapping save alone does not replace central work", true);
  await shot("02-mapping-review");
  await ev("document.querySelector('#prepApplyButton').click();true");
  await settled("mapped candidate apply");
  await assertApplyReleased("manual quantity mapping apply");
  await until(() => ev("__ops.state.workspace?.orders[0].quantity===6 && __ops.state.activePreview==='allocations'"), "mapped allocations");
  check("manual quantity mapping applies without re-upload or analysis click", await ev("__extraActions.filter(id=>id==='prepApplyButton').length===1 && !__extraActions.includes('analyzeButton')"));

  await upload("orders", { custom: true, reorder: true, date: "2026-09-18", quantity: "0", price: 0, name: "custom-orders-next-day.xlsx" });
  await until(() => ev("__ops.state.workspace?.orders[0].quantity===0 && __ops.state.workspace.basisDate==='2026-09-18'"), "reordered next-day template");
  check("saved template reconnects reordered columns and preserves zero/code", await ev("__ops.state.workspace.orders[0].productCode==='0001' && __ops.state.workspace.orders[0].unitPrice===0 && document.querySelector('#prepMappingStatus').dataset.state==='applied' && __extraActions.filter(id=>id==='prepApplyButton').length===1"));

  const beforeDuplicate = await ev("JSON.stringify(__ops.state.workspace)");
  await upload("orders", { quantity: 9, sheets: ["주문A", "주문B"], name: "duplicate-sheets.xlsx" });
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeDuplicate);
  check("duplicate candidate sheets require selection, not last-sheet overwrite", await ev("document.querySelector('#prepMappingStatus').dataset.state==='review' && document.querySelector('#prepSheetSelect').options.length===2"));
  await change("#prepSheetSelect", "주문B");
  await ev("document.querySelector('#prepApplyButton').click();true");
  await settled("explicit duplicate sheet selection");
  await assertApplyReleased("manual sheet selection apply");
  await until(() => ev("__ops.state.workspace?.sourceFiles.orders.sheetName==='주문B' && __ops.state.workspace.orders[0].quantity===9"), "chosen sheet in work");
  check("explicit sheet selection completes automatically", await ev("__ops.state.activePreview==='allocations'"));

  await uploadIntegrated("orders", { quantity: 8, instruction: true, name: "instruction-and-order.xlsx" });
  check("integrated instruction sheet does not block its valid order sheet", await ev("__ops.state.integratedFile.ignored.includes('설명') && __ops.state.integratedFile.applied.has('orders') && __ops.state.workspace.orders[0].quantity===8 && __ops.state.workspace.sourceFiles.orders.sheetName==='주문'"));

  const explicitWarehouseValues = () => ev(`(()=>{
    const w=__ops.state.workspace,view=ShippingManagementEngine.getInventoryViewRows(w),row=view.rows.find(item=>item.productCode==='0001');
    const intake=w.sourceFiles.inventory.intakeMapping;
    return {stock:row.stockTotal,remaining:row.remainingQuantity,
      warehouses:view.columns.flatMap((column,index)=>column.role==='warehouseQuantity'?[[column.header,column.sourceIndex,row.values[index]]]:[]),
      originalHeaders:intake?.originalRawMatrix?.[0],originalValues:intake?.originalRawMatrix?.[1],
      excludedMetadata:intake?.draft?.columns.find(column=>column.sourceIndex===8)};
  })()`);
  const assertExplicitWarehouse = async (label) => {
    const values = await explicitWarehouseValues();
    assert.equal(values.stock, 12, `${label}: explicit warehouse sum`);
    assert.equal(values.remaining, 4, `${label}: stock12 minus order8`);
    assert.deepEqual(values.warehouses, [["1창고", 5, 2], ["신선A", 6, 4], ["가격표", 7, 6]], `${label}: original names/coordinates/values`);
    assert.deepEqual(values.originalHeaders, ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "신선A", "가격표", "참고금액"]);
    assert.deepEqual(values.originalValues, ["0001", "합성상품", "원본규격", "EA", 12, 2, 4, 6, 999]);
    assert.equal(values.excludedMetadata?.enabled, false);
    check(label, true);
  };
  const beforeWarehouseMapping = await ev("JSON.stringify(__ops.state.workspace)");
  await upload("inventory", { explicitWarehouse: true, name: "explicit-warehouse.xlsx" });
  check("price-looking warehouse requires explicit mapping", await ev("document.querySelector('#prepMappingStatus').dataset.state==='review'"));
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeWarehouseMapping);
  await change('#prepColumnMappings select[data-prep-column="7"]', "warehouseQuantity");
  await change('#prepColumnMappings select[data-prep-column="8"]', "");
  await ev("document.querySelector('#prepTemplateName').value='명시 창고 양식';document.querySelector('#prepTemplateName').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#prepSaveTemplateButton').click();true");
  await until(() => ev("JSON.parse(localStorage.getItem('oneapp.orderops.excel-templates.v1')||'{}').items?.some(item=>item.name==='명시 창고 양식')"), "explicit warehouse template saved");
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeWarehouseMapping);
  await ev("document.querySelector('#prepApplyButton').click();true");
  await assertApplyReleased("manual warehouse mapping apply");
  await assertPreview("inventory", "manual inventory mapping opens inventory results");
  await assertExplicitWarehouse("manual warehouse role includes 가격표6, excludes numeric metadata999");
  await shot("03-explicit-warehouse");

  // Persist the legacy alias record independently of new template storage.
  await ev(`(()=>{const types=JSON.parse(JSON.stringify(__ops.state.excelMappings));types.sales.sheetAliases=['저장판매'];types.purchases.columns['구매처']=[...types.purchases.columns['구매처'],'거래처'];localStorage.setItem('oneapp.orderops.excel-mappings.v1',JSON.stringify({schemaVersion:'orderops-excel-mappings/v1',types}));return true;})()`);
  const beforeFreshOrigin = await ev("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(() => ev(`performance.timeOrigin!==${beforeFreshOrigin} && document.readyState==='complete' && Boolean(globalThis.__ops?.state.db && __ops.preparationController)`), "fresh workspace with saved templates");
  check("saved templates do not auto-restore or invent a workspace", await ev("!__ops.state.workspace"));
  await installFixtures();
  await upload("inventory", { explicitWarehouse: true, name: "explicit-warehouse-next.xlsx" });
  await assertPreview("movement", "saved inventory template opens a computed inventory movement workspace");
  check("saved warehouse template calculates inventory-only input without apply or invented orders", await ev("__ops.state.workspace?.inventoryOnly && !__ops.state.orders && __ops.state.workspace.orders.length===0 && __ops.state.inventory.rowCount===1 && __extraActions.length===0 && document.querySelector('#prepMappingStatus').dataset.state==='applied'"));
  check("inventory-only movement retains the explicitly mapped stock total", await ev("ShippingManagementEngine.getInventoryMovementView(__ops.state.workspace).rows[0].openingQuantity===12"));
  await ev("document.querySelector('[data-preview=inventory]').click();true");
  await assertPreview("inventory", "inventory-only workspace retains its warehouse view");
  check("inventory-only preview displays warehouse names and original quantities", await ev("document.querySelector('#previewTable').textContent.includes('신선A') && document.querySelector('#previewTable').textContent.includes('가격표') && document.querySelector('#previewTable').textContent.includes('12')"));
  check("inventory alone exposes the shared column and view-preset tools", await ev(`!document.querySelector('#viewPresetSaveButton').disabled && document.querySelectorAll('#columnVisibilityMenu [data-column-visible]').length>=8`));
  await ev(`(()=>{document.querySelector('#viewPresetSaveButton').click();document.querySelector('#viewPresetNameInput').value='단독 재고 양식';document.querySelector('[data-save-view-preset]').click();return true;})()`);
  await until(() => ev("__ops.state.selectedOrderViewPresetId && document.querySelector('#viewPresetSelect').value===__ops.state.selectedOrderViewPresetId"), "inventory-only view preset saved");
  check("inventory-only view preset is saved without creating orders", await ev("__ops.state.workspace?.inventoryOnly && !__ops.state.orders && __ops.state.workspace.orders.length===0 && __ops.state.orderViewPresets.some(item=>item.name==='단독 재고 양식'&&item.previewId==='inventory')"));
  await upload("orders", { quantity: 8, name: "fresh-order8.xlsx" });
  await assertExplicitWarehouse("first fresh workspace retains saved explicit warehouse roles");
  check("fresh template processing requires no extra action", await ev("__extraActions.length===0 && __ops.state.activePreview==='allocations'"));
  const preservedInventorySource = await ev("JSON.stringify(__ops.state.workspace.sourceFiles.inventory)");
  await upload("purchases", { quantity: 2, name: "unrelated-purchases.xlsx" });
  await assertPreview("purchases", "purchase upload opens purchase results with complete primary inputs");
  await assertExplicitWarehouse("unrelated purchase replacement retains mapped warehouses");
  assert.equal(await ev("JSON.stringify(__ops.state.workspace.sourceFiles.inventory)"), preservedInventorySource);
  check("legacy saved sales sheet alias wins even when transaction structures tie", await ev("__ops.state.excelMappings.sales.sheetAliases.includes('저장판매') && __ops.state.excelMappings.purchases.columns['구매처'].includes('거래처')"));
  await uploadIntegrated("sales", { quantity: 3, sheets: ["저장판매"], name: "legacy-sales-alias.xlsx" });
  await assertPreview("sales", "sales-only integrated upload opens sales results");
  check("legacy sales alias routes valid integrated transaction to sales only", await ev("__ops.state.integratedFile.applied.size===1 && __ops.state.integratedFile.applied.has('sales') && __ops.state.sales.rows[0].quantity===3 && __ops.state.purchases.fileName==='unrelated-purchases.xlsx'"));
  await assertExplicitWarehouse("sales alias application also preserves mapped inventory");

  const warehouseSavedId = await ev("__ops.persistLocalWorkspace().then(record=>record.recordId)");
  const beforeWarehouseReload = await ev("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(() => ev(`performance.timeOrigin!==${beforeWarehouseReload} && document.readyState==='complete' && Boolean(globalThis.__ops?.state.db && __ops.preparationController && __ops.state.recoveryRecords.some(item=>item.valid && item.record.recordId===${JSON.stringify(warehouseSavedId)}))`), "mapped warehouse recovery after reload");
  await ev("document.querySelector('#headerRestoreButton').click();true");
  await until(() => ev("Boolean(__ops.state.workspace?.sourceFiles.inventory.intakeMapping)"), "restore mapped warehouse source metadata");
  await assertExplicitWarehouse("IndexedDB recovery retains explicit warehouse roles and raw metadata");
  check("restored source names remain visible in the left file list", await ev("document.querySelector('#prepFileList').textContent.includes('explicit-warehouse-next.xlsx') && document.querySelector('#prepFileList').textContent.includes('복구')"));
  assert.equal(await ev("JSON.stringify(__ops.state.workspace.sourceFiles.inventory)"), preservedInventorySource);
  const warehouseDownloads = mkdtempSync(join(evidence, "warehouse-downloads-"));
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: warehouseDownloads });
  await ev("document.querySelector('#downloadButton').click();true");
  let warehouseDownload;
  await until(() => { warehouseDownload = readdirSync(warehouseDownloads).find((file) => /\.xlsx$/i.test(file)); return Boolean(warehouseDownload); }, "mapped warehouse Excel download");
  const warehouseBook = XLSX.read(readFileSync(join(warehouseDownloads, warehouseDownload)), { type: "buffer" });
  const warehouseRow = workbookRow(warehouseBook, "창고별재고", "1창고");
  assert.equal(warehouseRow["1창고"], 2);
  assert.equal(warehouseRow["신선A"], 4);
  assert.equal(warehouseRow["가격표"], 6);
  assert.equal(warehouseRow["잔량"], 4);
  assert.equal(warehouseRow["참고금액"], undefined, "Excluded numeric metadata must not be a result warehouse");
  check("reopened XLSX preserves explicit warehouse 2/4/6 and remaining4", true);
  report.warehouseDownload = join(warehouseDownloads, warehouseDownload);

  for (const theme of ["light", "dark"]) {
    for (const width of [1366, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      await send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await ev(`document.documentElement.dataset.nexusUiTheme=${JSON.stringify(theme)};localStorage.setItem('oneapp.nexus.ui.theme.v1',${JSON.stringify(theme)});document.querySelector('.excel-preparation-panel').scrollTop=0;true`);
      await ev("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const bounds = await ev(`(()=>{const panel=document.querySelector('.excel-preparation-panel'),buttons=[...document.querySelectorAll('[data-prep-kind]')].map(node=>node.getBoundingClientRect().toJSON());return {bodyWidth:document.documentElement.scrollWidth,panel:panel.getBoundingClientRect().toJSON(),panelWidth:panel.clientWidth,panelScrollWidth:panel.scrollWidth,buttons};})()`);
      report.checks.push({ theme, width, bounds });
      check(`${theme} ${width}: preparation controls keep 2x2 and fit their panel`, bounds.buttons.length === 4 && Math.abs(bounds.buttons[0].top - bounds.buttons[1].top) <= 2 && Math.abs(bounds.buttons[2].top - bounds.buttons[3].top) <= 2 && bounds.buttons[2].top > bounds.buttons[0].top && bounds.panelScrollWidth <= bounds.panelWidth + 1);
      check(`${theme} ${width}: preparation panel remains within viewport`, bounds.panel.left >= 0 && bounds.panel.right <= width + 1);
      await shot(`${theme}-${width}`);
    }
  }
  await installFixtures();
  await upload("orders", { quantity: 3, name: "removable-order.xlsx" });
  await upload("inventory", { quantity: 4, name: "kept-stock.xlsx" });
  await selectPreview("inventory");
  await ev(`(()=>{const cell=[...document.querySelectorAll('.inventory-input')].find(node=>decodeURIComponent(node.dataset.inventoryColumn?.split(':').at(-1)||'')==='1창고');if(!cell)throw Error('Missing stock editor');cell.value='2';cell.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await ev(`(()=>{const file=[...document.querySelectorAll('[data-prep-file]')].find(node=>node.textContent.includes('removable-order.xlsx'));file.closest('.prep-file-item').querySelector('[data-prep-remove]').click();return true;})()`);
  await until(() => ev("!__ops.state.workspace && !__ops.state.orders && !__ops.preparationController.isBusy()"), "detach only the selected order input");
  await upload("orders", { quantity: 3, name: "new-order.xlsx" });
  check("detaching an order and loading another preserves retained stock edits", await ev("ShippingManagementEngine.getInventoryViewRows(__ops.state.workspace).rows[0].stockTotal===2 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4"));

  const retainedStockSavedId = await ev("__ops.persistLocalWorkspace().then(record=>record.recordId)");
  const beforeRetainedStockReload = await ev("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(() => ev(`performance.timeOrigin!==${beforeRetainedStockReload} && document.readyState==='complete' && Boolean(globalThis.__ops?.state.db && __ops.preparationController && __ops.state.recoveryRecords.some(item=>item.valid && item.record.recordId===${JSON.stringify(retainedStockSavedId)}))`), "retained stock recovery after reload");
  await ev("document.querySelector('#headerRestoreButton').click();true");
  await until(() => ev("__ops.state.workspace?.orders?.[0]?.quantity===3"), "restore retained stock work");
  check("restored retained stock work has no live order or inventory input", await ev("__ops.state.orders===null && __ops.state.inventory===null && ShippingManagementEngine.getInventoryViewRows(__ops.state.workspace).rows[0].stockTotal===2 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4"));
  const recoveredStockOverrides = await ev("JSON.stringify(__ops.state.workspace.inventoryOverrides)");
  await installFixtures();
  await upload("orders", { quantity: 6, name: "recovered-removable-order.xlsx" });
  check("order-only replacement preserves recovered stock edits without a live inventory input", await ev("__ops.state.inventory===null && __ops.state.workspace.orders[0].quantity===6 && ShippingManagementEngine.getInventoryViewRows(__ops.state.workspace).rows[0].stockTotal===2 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4"));
  assert.equal(await ev("JSON.stringify(__ops.state.workspace.inventoryOverrides)"), recoveredStockOverrides);
  await ev(`(()=>{const file=[...document.querySelectorAll('[data-prep-file]')].find(node=>node.textContent.includes('recovered-removable-order.xlsx'));if(!file)throw Error('Missing recovered replacement order');file.closest('.prep-file-item').querySelector('[data-prep-remove]').click();return true;})()`);
  await until(() => ev("!__ops.state.workspace && __ops.state.orders===null && !__ops.preparationController.isBusy()"), "detach recovered replacement order");
  check("detaching recovered order reconstructs retained inventory input from its source", await ev("__ops.state.inventory?.sourceMatrix?.[1]?.[5]===4 && __ops.state.inventory.rows.length===1"));
  assert.equal(await ev("JSON.stringify(__ops.state.inventory.preservedOverrides)"), recoveredStockOverrides);
  await upload("orders", { quantity: 5, name: "recovered-reuploaded-order.xlsx" });
  check("re-upload after recovered order detach retains edited stock2 and raw stock4", await ev("__ops.state.workspace.orders[0].quantity===5 && ShippingManagementEngine.getInventoryViewRows(__ops.state.workspace).rows[0].stockTotal===2 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4"));
  assert.equal(await ev("JSON.stringify(__ops.state.workspace.inventoryOverrides)"), recoveredStockOverrides);

  await upload("purchases", { quantity: 2, name: "purchase-removal-race.xlsx" });
  await assertPreview("purchases", "purchase removal fixture upload opens purchase results");
  await selectPreview("allocations");
  const beforePurchaseRemoval = await ev("JSON.stringify(__ops.state.purchases)");
  const beforePurchaseRemovalSource = await ev("JSON.stringify(__ops.state.workspace.orderOpsInputs.purchases)");
  // Pause only the removal fingerprint. Autosave digests and all other hashing
  // still use the real SubtleCrypto implementation in this isolated test page.
  await ev(`(()=>{
    const subtle=crypto.subtle,originalDigest=subtle.digest;
    let release;
    globalThis.__purchaseRemovalRace={paused:false,workspace:__ops.state.workspace,purchases:__ops.state.purchases};
    globalThis.__releasePurchaseRemovalDigest=()=>{subtle.digest=originalDigest;release?.();};
    subtle.digest=async function(algorithm,data){
      let payload;try{payload=JSON.parse(new TextDecoder().decode(data));}catch(_){/* Binary/source hashes are not the removal fingerprint. */}
      if(payload?.removedKind==='purchases'&&!__purchaseRemovalRace.paused){
        __purchaseRemovalRace.paused=true;
        await new Promise(resolve=>{release=resolve;});
      }
      return originalDigest.call(this,algorithm,data);
    };
    return true;
  })()`);
  let workEditedDuringRemoval;
  try {
    await ev(`(()=>{const file=[...document.querySelectorAll('[data-prep-file]')].find(node=>node.textContent.includes('purchase-removal-race.xlsx'));if(!file)throw Error('Missing purchase removal fixture');file.closest('.prep-file-item').querySelector('[data-prep-remove]').click();return true;})()`);
    await until(() => ev("__purchaseRemovalRace.paused && __ops.preparationController.isBusy()"), "purchase removal paused at fingerprint digest");
    check("pending purchase removal leaves the active inputs and workspace available", await ev("__ops.state.workspace===__purchaseRemovalRace.workspace && __ops.state.purchases===__purchaseRemovalRace.purchases && __ops.state.activePreview==='allocations'"));
    // Do not use change(): it waits for the intentionally suspended operation.
    await ev(`(()=>{const input=document.querySelector('.purchase-input[data-purchase-code="0001"]');if(!input||input.disabled)throw Error('Missing active supplier editor during removal');input.value='제거 중 수정 구매처';input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    check("central supplier edit commits while the removal candidate is pending", await ev("__purchaseRemovalRace.paused && __ops.preparationController.isBusy() && ShippingManagementEngine.getPurchaseInputs(__ops.state.workspace)['0001']==='제거 중 수정 구매처'"));
    workEditedDuringRemoval = await ev("JSON.stringify(__ops.state.workspace)");
  } finally {
    await ev("__releasePurchaseRemovalDigest();true");
  }
  await settled("purchase removal rejected after concurrent central edit");
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), workEditedDuringRemoval);
  assert.equal(await ev("JSON.stringify(__ops.state.purchases)"), beforePurchaseRemoval);
  assert.equal(await ev("JSON.stringify(__ops.state.workspace.orderOpsInputs.purchases)"), beforePurchaseRemovalSource);
  check("concurrent supplier edit rejects stale purchase removal and retains its file", await ev("__ops.state.workspace===__purchaseRemovalRace.workspace && __ops.state.purchases===__purchaseRemovalRace.purchases && ShippingManagementEngine.getPurchaseInputs(__ops.state.workspace)['0001']==='제거 중 수정 구매처' && document.querySelector('#prepFileList').textContent.includes('purchase-removal-race.xlsx') && document.querySelector('#toast').textContent.includes('자료 해제 중 작업이 변경') && !document.querySelector('#downloadButton').disabled"));

  for (const [kind, first, second] of [["purchases", 2, 20], ["sales", 1, 11]]) {
    for (const [excludedIndex, expectedQuantity] of [[5, first], [4, second]]) {
      const name = `duplicate-${kind}-exclude-${excludedIndex}.xlsx`;
      const beforeDuplicateQuantity = await ev("JSON.stringify(__ops.state.workspace)");
      const beforeDuplicateInput = await ev(`JSON.stringify(__ops.state[${JSON.stringify(kind)}])`);
      const beforeDuplicateTable = await ev("document.querySelector('#previewTable').innerHTML");
      await upload(kind, { quantity: first, duplicateQuantity: second, name });
      assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeDuplicateQuantity);
      assert.equal(await ev(`JSON.stringify(__ops.state[${JSON.stringify(kind)}])`), beforeDuplicateInput);
      assert.equal(await ev("document.querySelector('#previewTable').innerHTML"), beforeDuplicateTable);
      check(`${kind} duplicate quantity ${first}/${second} stays in left review without changing work`, await ev(`document.querySelector('#prepFileName').textContent===${JSON.stringify(name)} && document.querySelector('#prepMappingStatus').dataset.state==='review' && document.querySelector('#prepColumnMappings [data-prep-column="4"]') && document.querySelector('#prepColumnMappings [data-prep-column="5"]')`));
      const beforeDuplicateApplyInputCount = await ev("__sourceInputChanges.length");
      await change(`#prepColumnMappings select[data-prep-column="${excludedIndex}"]`, "");
      await ev("document.querySelector('#prepApplyButton').click();true");
      await assertApplyReleased(`${kind} duplicate quantity exclude column ${excludedIndex}`);
      await assertPreview(kind, `${kind} duplicate quantity apply opens its own result view`);
      assert.equal(await ev(`__ops.state[${JSON.stringify(kind)}].rows[0].quantity`), expectedQuantity);
      assert.equal(await ev(`__ops.state.workspace.orderOpsInputs[${JSON.stringify(kind)}].rows[0].quantity`), expectedQuantity);
      const duplicateEvidence = await ev(`(()=>{const source=__ops.state.workspace.orderOpsInputs[${JSON.stringify(kind)}];return {headers:source.intakeMapping.originalRawMatrix[0],values:source.intakeMapping.originalRawMatrix[1],excluded:source.intakeMapping.draft.columns.find(column=>column.sourceIndex===${excludedIndex}).enabled};})()`);
      assert.deepEqual(duplicateEvidence.headers.slice(4, 6), ["수량", "수량"]);
      assert.deepEqual(duplicateEvidence.values.slice(4, 6), [first, second]);
      assert.equal(duplicateEvidence.excluded, false);
      assert.equal(await ev("__sourceInputChanges.length"), beforeDuplicateApplyInputCount);
      check(`${kind} explicit duplicate-column choice yields exactly ${expectedQuantity} without re-upload`, true);
    }
  }

  const beforeRejectedFiles = await ev("JSON.stringify({workspace:__ops.state.workspace,inputs:['orders','inventory','purchases','sales'].map(kind=>__ops.state[kind])})");
  await ev(`(()=>{const original=File.prototype.arrayBuffer;window.__rejectedFileReads=[];window.__restoreFileRead=()=>{File.prototype.arrayBuffer=original;};File.prototype.arrayBuffer=function(){if(this.name.startsWith('rejected-'))__rejectedFileReads.push(this.name);return original.call(this);};const data=new DataTransfer();data.items.add(__fixture('inventory',{quantity:8,name:'valid-beside-rejected.xlsx'}));data.items.add(new File([__fixture('orders')],'rejected-format.txt'));data.items.add(new File([new Uint8Array(25*1024*1024+1)],'rejected-oversize.xlsx'));document.querySelector('#prepDropZone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));return true;})()`);
  try {
    await settled("unsupported and oversized batch files stay rejected");
    assert.deepEqual(await ev("__rejectedFileReads"), []);
    assert.equal(await ev("JSON.stringify({workspace:__ops.state.workspace,inputs:['orders','inventory','purchases','sales'].map(kind=>__ops.state[kind])})"), beforeRejectedFiles);
    check("batch failure never re-reads or offers mapping apply for format/25MB rejected files", await ev("!document.querySelector('#prepFileList').textContent.includes('rejected-format.txt') && !document.querySelector('#prepFileList').textContent.includes('rejected-oversize.xlsx') && document.querySelector('#prepFileList').textContent.includes('valid-beside-rejected.xlsx')"));
  } finally {
    await ev("__restoreFileRead();true");
  }

  const beforeBundleReview = await ev("JSON.stringify(__ops.state.workspace)");
  const beforeBundleTable = await ev("document.querySelector('#previewTable').innerHTML");
  const beforeBundleInputChanges = await ev("__sourceInputChanges.length");
  await ev(`(()=>{const data=new DataTransfer();data.items.add(__fixture('orders',{quantity:9,quantityHeader:'묶음주문량미확인X',name:'묶음미확인-주문.xlsx'}));data.items.add(__fixture('inventory',{quantity:8,name:'묶음정상-재고.xlsx'}));document.querySelector('#prepDropZone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));return true;})()`);
  await settled("two-file drop classification failure");
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeBundleReview);
  assert.equal(await ev("document.querySelector('#previewTable').innerHTML"), beforeBundleTable);
  check("failed mixed-validity bundle keeps both candidates in the left file list", await ev("['묶음미확인-주문.xlsx','묶음정상-재고.xlsx'].every(name=>[...document.querySelectorAll('#prepFileList [data-prep-file]')].some(node=>node.textContent.includes(name)))"));
  await ev(`(()=>{const file=[...document.querySelectorAll('#prepFileList [data-prep-file]')].find(node=>node.textContent.includes('묶음미확인-주문.xlsx'));if(!file)throw Error('Missing failed bundle order candidate');file.click();return true;})()`);
  await until(() => ev("document.querySelector('#prepFileName').textContent==='묶음미확인-주문.xlsx'"), "select failed bundle order candidate");
  await change("#prepKindSelect", "orders");
  await change('#prepColumnMappings select[data-prep-column="7"]', "수량");
  await ev("document.querySelector('#prepApplyButton').click();true");
  await assertApplyReleased("failed bundle order mapping repaired in place");
  await assertPreview("allocations", "repaired bundle order opens order results");
  check("bundle order can be repaired and applied without another file selection", await ev("__ops.state.workspace.orders[0].quantity===9 && __ops.state.workspace.sourceFiles.orders.fileName==='묶음미확인-주문.xlsx'"));
  assert.equal(await ev("__sourceInputChanges.length"), beforeBundleInputChanges);

  await upload("inventory", { quantity: 4, name: "inventory-detach-with-order-edits.xlsx" });
  await assertPreview("inventory", "inventory detach fixture opens inventory results");
  await selectPreview("allocations");
  await change('.order-edit-input[data-order-field="quantity"]', 7);
  await change('.order-edit-input[data-order-field="unitPrice"]', 1200);
  await change('.purchase-input[data-purchase-code="0001"]', "재고 해제 전 구매처");
  await selectPreview("inventory");
  await ev(`(()=>{const cell=[...document.querySelectorAll('.inventory-input')].find(node=>decodeURIComponent(node.dataset.inventoryColumn?.split(':').at(-1)||'')==='1창고');if(!cell)throw Error('Missing inventory detach stock editor');cell.value='2';cell.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await settled("edit inventory before detaching it");
  check("inventory detach starts from edited stock2 and raw stock4", await ev("ShippingManagementEngine.getInventoryViewRows(__ops.state.workspace).rows[0].stockTotal===2 && __ops.state.workspace.sourceFiles.inventory.matrix[1][5]===4 && __ops.state.workspace.inventoryOverrides.cells.length>0"));
  await ev(`(()=>{const file=[...document.querySelectorAll('#prepFileList [data-prep-file]')].find(node=>node.textContent.includes('inventory-detach-with-order-edits.xlsx'));if(!file)throw Error('Missing removable inventory fixture');file.closest('.prep-file-item').querySelector('[data-prep-remove]').click();return true;})()`);
  await until(() => ev("!__ops.state.workspace && __ops.state.inventory===null && !__ops.preparationController.isBusy()"), "detach inventory while retaining edited orders");
  check("inventory detach retains order quantity7 and price1200 as prepared input", await ev("__ops.state.orders.rows[0].quantity===7 && __ops.state.orders.rows[0].unitPrice===1200"));
  await upload("inventory", { quantity: 9, name: "inventory-after-detach-new9.xlsx" });
  await assertPreview("inventory", "new inventory after detach opens inventory results");
  assert.deepEqual(await workValues(), { quantity: 7, price: 1200, purchase: "재고 해제 전 구매처", stock: 9, preview: "inventory" });
  check("new inventory keeps order edits and supplier without carrying old stock overrides", await ev("__ops.state.workspace.sourceFiles.inventory.matrix[1][5]===9 && __ops.state.workspace.inventoryOverrides.cells.length===0"));

  const fourSourceNames = { orders: "recovery-four-orders.xlsx", inventory: "recovery-four-inventory.xlsx", purchases: "recovery-four-purchases.xlsx", sales: "recovery-four-sales.xlsx" };
  for (const kind of ["orders", "inventory", "purchases", "sales"]) {
    await upload(kind, { quantity: { orders: 7, inventory: 9, purchases: 2, sales: 1 }[kind], name: fourSourceNames[kind] });
    await assertPreview(kind === "orders" ? "allocations" : kind, `four-source ${kind} upload opens its matching view`);
  }
  const fourSourceSavedId = await ev("__ops.persistLocalWorkspace().then(record=>record.recordId)");
  const beforeFourSourceReload = await ev("performance.timeOrigin");
  await send("Page.reload", { ignoreCache: true });
  await until(() => ev(`performance.timeOrigin!==${beforeFourSourceReload} && document.readyState==='complete' && Boolean(globalThis.__ops?.state.db && __ops.preparationController && __ops.state.recoveryRecords.some(item=>item.valid && item.record.recordId===${JSON.stringify(fourSourceSavedId)}))`), "four-source IndexedDB record after reload");
  await ev("document.querySelector('#headerRestoreButton').click();true");
  await until(() => ev("__ops.state.workspace?.orders?.[0]?.quantity===7 && Boolean(__ops.state.workspace.orderOpsInputs?.purchases && __ops.state.workspace.orderOpsInputs?.sales)"), "restore all four source attachments");
  await settled("four-source restore");
  check("four-source recovery has no live File inputs and shows all recovered filenames", await ev(`['orders','inventory','purchases','sales'].every(kind=>__ops.state[kind]===null) && ${JSON.stringify(Object.values(fourSourceNames))}.every(name=>[...document.querySelectorAll('#prepFileList .prep-file-item')].some(node=>node.textContent.includes(name)&&node.textContent.includes('복구')))`));
  const beforeBadRestoredOrder = await ev("JSON.stringify(__ops.state.workspace)");
  const beforeBadRestoredTable = await ev("document.querySelector('#previewTable').innerHTML");
  await installFixtures();
  await upload("orders", { quantity: 88, quantityHeader: "복구후미확인주문량X", name: "failed-after-four-source-recovery.xlsx" });
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), beforeBadRestoredOrder);
  assert.equal(await ev("document.querySelector('#previewTable').innerHTML"), beforeBadRestoredTable);
  check("failed replacement remains visible beside all four recovered sources", await ev(`(()=>{const items=[...document.querySelectorAll('#prepFileList .prep-file-item')];return items.length===5 && ${JSON.stringify(Object.values(fourSourceNames))}.every(name=>items.filter(node=>node.textContent.includes(name)&&node.textContent.includes('복구')).length===1) && items.some(node=>node.textContent.includes('failed-after-four-source-recovery.xlsx')&&node.dataset.state==='review') && document.querySelector('#prepMappingStatus').dataset.state==='review';})()`));
  await assertPreview("sales", "failed order replacement preserves the recovered sales view");
  await settled("final state");
  assert.deepEqual(report.externalWrites, [], "No external write attempts");
  assert.deepEqual(report.errors, [], "No browser runtime errors");
  assert.deepEqual(report.consoleProblems, [], "No console warnings/errors");
  report.result = "passed";
  console.log(`ORDER Q Excel preparation browser: passed; evidence ${evidence}`);
} catch (error) {
  report.result = "failed";
  report.error = error.stack || String(error);
  console.error(report.error);
  process.exitCode = 1;
  if (shot) { try { await shot("failure"); } catch (_) { /* Browser may already be unavailable. */ } }
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(evidence, "verification.json"), JSON.stringify(report, null, 2));
  socket?.close();
  if (browser?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(browser.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else { spawnSync("pkill", ["-TERM", "-P", String(browser.pid)], { stdio: "ignore" }); browser.kill("SIGTERM"); }
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
