#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Real Chromium + standalone development page in an isolated profile and loopback origin.
// No production storage or network writes. DOM drag/paste events exercise the
// actual handlers; these checks do not claim OS file-picker/clipboard coverage.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const XLSX = createRequire(import.meta.url)(join(ROOT, "customer-master/vendor/xlsx.full.min.js"));
const fixtureDir = process.env.ORDEROPS_INVENTORY_FIXTURE_DIR || join(homedir(), "Desktop");
const evidence = resolve(process.env.ORDEROPS_INVENTORY_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), "orderops-inventory-evidence-")));
const profile = mkdtempSync(join(tmpdir(), "orderops-inventory-browser-"));
const downloads = join(evidence, "downloads");
mkdirSync(downloads, { recursive: true });
const filenames = { prior: "전일재고현황.xlsx", movement: "재고변동표.xlsx", sales: "판매현황.xlsx", purchases: "구매현황.xlsx" };
const realFixtures = process.env.ORDEROPS_INVENTORY_SYNTHETIC !== "1" && Object.values(filenames).every((name) => existsSync(join(fixtureDir, name)));
if (process.env.ORDEROPS_INVENTORY_FIXTURE_DIR && !realFixtures && process.env.ORDEROPS_INVENTORY_SYNTHETIC !== "1") throw Error("The specified fixture directory must contain all four inventory workbooks");
const report = { startedAt: new Date().toISOString(), result: "running", fixtures: realFixtures ? "provided four XLSX" : "synthetic", checks: [], errors: [], externalWrites: [] };
const synthetic = {
  prior: { sheet: "재고현황", matrix: [["회사명 : 테스트 / 1창고 / 2026/09/18 / 재고현황"], ["단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요"], ["BOX", "0001", "상품 가", "BOX", 10, "09/18", "공급처", 100, "1", ""], ["소분", "0002", "상품 나", "EA", 2.5, "09/19", "공급처", 50, "1", ""], ["2026/09/20 오전 1:44:52"]] },
  movement: { sheet: "재고변동표", matrix: [["순번", "분류2명", "단위", "적재위치", "구분(기본)", "구매처", "품목코드", "품목명", "규격", "재고", "입고", "출고", "잔량", "잔량", "입고가"], ["1", "채소", "BOX", "", "1", "공급처", "0001", "상품 가", "BOX", 10, 8, 4, 14, 14, 100], ["2", "채소", "소분", "", "1", "공급처", "0002", "상품 나", "EA", 2.5, 0.5, 4, -1, -1, 50], ["3", "채소", "EA", "", "1", "공급처", "0003", "신규 상품", "EA", null, null, 3, -3, -3, 25], ["합계", null, null, null, null, null, null, null, null, 12.5, 8.5, 11], ["2026/09/20 오전 1:40:04"]] },
  purchases: { sheet: "구매현황내역", matrix: [["회사명 : 테스트 / 2026/09/19 ~ 2026/09/19"], ["일자", "일자-No.", "거래처코드", "거래처명", "창고코드", "코드", "품명", "규격", "수량", "단가", "합계", "적요", "구매처"], ["2026/09/19", "2026/09/19 -1", "S1", "공급처", "01", "0001", "상품 가", "BOX", 3, 100, 300], ["2026/09/19", "2026/09/19 -1", "S1", "공급처", "02", "0001", "상품 가 [BOX]", "BOX", 5, 100, 500], ["2026/09/19", "2026/09/19 -2", "S1", "공급처", "01", "0002", "상품 나", "EA", 0.5, 50, 25], ["총합계", null, null, null, null, null, null, null, 8.5, null, 825], ["2026/09/20 오전 12:10:59"]] },
  sales: { sheet: "판매현황내역", matrix: [["회사명 : 테스트 / 2026/09/19 ~ 2026/09/19"], ["일자", "일자-No.", "창고코드", "거래처코드", "거래처명", "no.", "품목코드", "품명", "수량", "단가", "공급가", "적요", "출고지시", "출고가 (공지)", "구매처", "구매", "구매합계"], ["2026/09/19", "2026/09/19 -1", "01", "C1", "거래처", "배달1", "0001", "상품 가", 5, 200, 1000], ["2026/09/19", "2026/09/19 -2", "02", "C1", "거래처", "BOX", "0001", "상품 가 [BOX]", -1, 200, -200], ["2026/09/19", "2026/09/19 -2", "01", "C1", "거래처", "소분", "0002", "상품 나", 4, 100, 400], ["2026/09/19", "2026/09/19 -2", "01", "C1", "거래처", "EA", "0003", "신규 상품", 3, 50, 150], ["2026/09/19", "2026/09/19 -2", "01", "C1", "거래처", "EA", "0004", "수량 영", 0, 50, 0], ["2026/09 계", null, null, null, null, null, null, null, 1350], ["2026/09/20 오전 1:43:28"]] },
};
function sourceBytes(kind) {
  if (realFixtures) return readFileSync(join(fixtureDir, filenames[kind]));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(synthetic[kind].matrix), synthetic[kind].sheet);
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}
const sources = Object.fromEntries(Object.keys(filenames).map((kind) => [kind, sourceBytes(kind)]));
// Independent source controls use raw workbook columns, not app parser output.
// Actual business identifiers and quantities stay in local fixture/evidence files.
function controlRows(kind) {
  const book = XLSX.read(sources[kind], { type: "buffer" });
  const matrix = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: null });
  const headerIndex = matrix.findIndex((row) => row.includes(kind === "purchases" ? "코드" : "품목코드") && row.includes(["prior", "movement"].includes(kind) ? "재고" : "수량"));
  assert.ok(headerIndex >= 0, `${kind}: source-control headers`);
  const headers = matrix[headerIndex];
  const codeIndex = headers.indexOf(kind === "purchases" ? "코드" : "품목코드");
  const quantityIndex = headers.indexOf(["prior", "movement"].includes(kind) ? "재고" : "수량");
  const dateIndex = headers.indexOf("일자");
  return matrix.slice(headerIndex + 1).flatMap((row) => {
    if (!row[codeIndex] || /^(?:총)?합계$|^\d{4}\/\d{2}\s+계$/.test(String(row[0]).trim())) return [];
    if (dateIndex >= 0 && !/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(String(row[dateIndex]).trim())) return [];
    const quantity = row[quantityIndex] == null || row[quantityIndex] === "" ? 0 : Number(String(row[quantityIndex]).replace(/,/g, ""));
    assert.ok(Number.isFinite(quantity), `${kind}: source quantity must be numeric`);
    return [{ code: String(row[codeIndex]).trim(), quantity }];
  });
}
const controls = Object.fromEntries(Object.keys(filenames).map((kind) => [kind, controlRows(kind)]));
const quantitySum = (rows) => Math.round(rows.reduce((sum, row) => sum + row.quantity, 0) * 1e6) / 1e6;
const incoming = quantitySum(controls.purchases), outgoing = quantitySum(controls.sales);
const expected = { incoming, outgoing, salesRows: controls.sales.length, purchaseRows: controls.purchases.length };
for (const kind of ["prior", "movement"]) {
  const baselineCodes = new Set(controls[kind].map((row) => row.code));
  const missing = controls.sales.find((row) => !baselineCodes.has(row.code)) || controls.purchases.find((row) => !baselineCodes.has(row.code));
  expected[kind] = {
    rows: controls[kind].length, opening: quantitySum(controls[kind]),
    closing: Math.round((quantitySum(controls[kind]) + incoming - outgoing) * 1e6) / 1e6,
    count: new Set([...controls[kind], ...controls.purchases, ...controls.sales].map((row) => row.code)).size,
    missingCode: missing?.code,
    missingRemaining: missing ? quantitySum(controls.purchases.filter((row) => row.code === missing.code)) - quantitySum(controls.sales.filter((row) => row.code === missing.code)) : null,
  };
}
if (!realFixtures) {
  assert.equal(expected.prior.closing, 10); assert.equal(expected.movement.closing, 10);
  assert.equal(expected.prior.count, 4); assert.equal(expected.movement.count, 4);
}
report.sourceControls = expected;
const anchor = "      FILE_KINDS.forEach(bindDropZone);";
const original = readFileSync(join(ROOT, "orderops_list.html"), "utf8");
assert.equal(original.split(anchor).length, 2, "standalone test injection point");
const html = original.replace(anchor, `      globalThis.__inventoryTest = { state, get preparationController() { return preparationController; }, persistLocalWorkspace };\n${anchor}`)
  .replace("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js", "/customer-master/vendor/xlsx.full.min.js");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) return response.writeHead(405).end();
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/favicon.ico") return response.writeHead(204).end();
  const path = resolve(ROOT, `.${pathname}`);
  if (!path.startsWith(ROOT + sep) || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
  response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
  response.end(pathname === "/orderops_list.html" ? html : readFileSync(path));
});
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(action, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await action()) return; } catch (error) { if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error; }
    await delay(75);
  }
  throw Error(`Timeout: ${label}`);
}
const check = (label, actual) => { assert.ok(actual, label); report.checks.push(label); console.log(`PASS ${label}`); };
function commandPath(command) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
}
let browser, socket, send, ev;
try {
  const executable = [process.env.CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"), process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"), commandPath("google-chrome"), commandPath("chromium")].filter(Boolean).find(existsSync);
  assert.ok(executable, "Set CHROME_PATH to a Chromium browser");
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1600,1000", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let port;
  await until(() => { try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]; return port; } catch (error) { if (!["ENOENT", "EBUSY"].includes(error.code)) throw error; } }, "browser endpoint");
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(Error(message.error.message)) : call.done(message.result); }
    }
    if (message.method === "Runtime.exceptionThrown") report.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: true });
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      if (request.url.startsWith(origin + "/") || request.url === "about:blank") void send("Fetch.continueRequest", { requestId });
      else {
        if (!["GET", "HEAD"].includes(request.method)) report.externalWrites.push({ method: request.method, url: request.url });
        void send("Fetch.fulfillRequest", { requestId, responseCode: 204, body: "" });
      }
    }
  };
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  ev = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const ready = () => until(() => ev("Boolean(globalThis.__inventoryTest?.state.db && __inventoryTest.preparationController && globalThis.XLSX)"), "page + IndexedDB + preparation");
  const settled = () => until(() => ev("Boolean(globalThis.__inventoryTest && !__inventoryTest.state.analysisRunning && !Object.values(__inventoryTest.state.loading).some(Boolean) && !__inventoryTest.preparationController.isBusy())"), "input settled");
  const view = () => ev("ShippingManagementEngine.getInventoryMovementView(__inventoryTest.state.workspace)");
  const selectMovement = async () => { await ev("document.querySelector('#prepPreviewTabs [data-preview=movement]').click()"); await settled(); };
  const upload = async (kind) => {
    const base64 = sources[kind].toString("base64");
    const key = kind === "prior" || kind === "movement" ? "inventory" : kind;
    await ev(`document.querySelector('[data-prep-kind="${key}"]').click()`);
    await ev(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(filenames[kind])},{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));document.querySelector('#prepDropZone').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));})()`);
    await settled();
    check(`${kind}: preparation parses and applies selected inventory source`, await ev(`__inventoryTest.state.${key}?.fileName===${JSON.stringify(filenames[kind])} && [...document.querySelectorAll('#prepFileList .prep-file-item')].some(node=>node.textContent.includes(${JSON.stringify(filenames[kind])})&&node.dataset.state==='applied')`));
  };
  const uploadTransactions = async () => {
    const files = ["sales", "purchases"].map((kind) => ({ name: filenames[kind], base64: sources[kind].toString("base64") }));
    await ev(`(()=>{const transfer=new DataTransfer();for(const file of ${JSON.stringify(files)})transfer.items.add(new File([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],file.name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));document.querySelector('#prepDropZone').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));})()`);
    await settled();
    check("sales + purchases: batch auto-classification and preparation apply", await ev(`__inventoryTest.state.sales?.fileName===${JSON.stringify(filenames.sales)} && __inventoryTest.state.purchases?.fileName===${JSON.stringify(filenames.purchases)} && [...document.querySelectorAll('#prepFileList .prep-file-item[data-state=applied]')].length===3`));
  };
  const cell = (row, column) => `#previewTable tbody tr:nth-child(${row + 1}) .movement-input[data-movement-column="movement:${column}"]`;
  const change = async (selector, value) => { await ev(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing input '+${JSON.stringify(selector)});node.focus();node.value=${JSON.stringify(String(value))};node.dispatchEvent(new Event('change',{bubbles:true}));})()`); await settled(); };
  const paste = async (selector, text) => { await ev(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing paste target');node.focus();const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`); await settled(); };
  const screenshot = async (name) => { const result = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, `${name}.png`), Buffer.from(result.data, "base64")); };

  for (const inventoryKind of ["prior", "movement"]) {
    if (inventoryKind !== "prior") { await send("Page.navigate", { url: "about:blank" }); await until(() => ev("location.href === 'about:blank'"), "previous fixture unloaded"); await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }); }
    await send("Page.navigate", { url: `${origin}/orderops_list.html?inventory-acceptance=${inventoryKind}` });
    await ready();
    await upload(inventoryKind);
    check(`${inventoryKind}: inventory applies without orders`, await ev(`!__inventoryTest.state.orders && __inventoryTest.state.inventory.rows.length===${expected[inventoryKind].rows} && __inventoryTest.state.workspace?.orders?.length===0`));
    await uploadTransactions(); await selectMovement();
    check(`${inventoryKind}: exact transaction rows exclude totals and timestamp footers`, await ev(`__inventoryTest.state.sales.rows.length===${expected.salesRows} && __inventoryTest.state.purchases.rows.length===${expected.purchaseRows}`));
    const current = await view();
    writeFileSync(join(evidence, `${inventoryKind}-initial-view.json`), JSON.stringify(current, null, 2));
    assert.equal(current.rows.length, expected[inventoryKind].count, `${inventoryKind}: SKU union includes movement-only and zero rows`);
    // Field names are the public movement read-model contract.
    assert.equal(current.rows.reduce((sum, row) => sum + row.openingQuantity, 0), expected[inventoryKind].opening);
    assert.equal(current.rows.reduce((sum, row) => sum + row.inboundQuantity, 0), expected.incoming);
    assert.equal(current.rows.reduce((sum, row) => sum + row.salesQuantity, 0), expected.outgoing);
    assert.equal(current.rows.reduce((sum, row) => sum + row.remainingQuantity, 0), expected[inventoryKind].closing);
    check(`${inventoryKind}: opening + aggregated purchases - signed sales matches independent controls`, true);
    if (expected[inventoryKind].missingCode) {
      const missingOpening = current.rows.find((row) => row.productCode === expected[inventoryKind].missingCode);
      assert.equal(missingOpening.openingQuantity, 0, "missing opening inventory is zero");
      check(`${inventoryKind}: missing opening stock never blocks or invents a nonzero balance`, missingOpening.remainingQuantity === expected[inventoryKind].missingRemaining);
    }
    const aggregateBeforeRepeat = current.rows.map((row) => [row.rowKey, row.openingQuantity, row.inboundQuantity, row.salesQuantity, row.remainingQuantity]);
    await uploadTransactions(); await selectMovement();
    assert.deepEqual((await view()).rows.map((row) => [row.rowKey, row.openingQuantity, row.inboundQuantity, row.salesQuantity, row.remainingQuantity]), aggregateBeforeRepeat);
    check(`${inventoryKind}: reapplying source files does not double-count transactions`, true);
    check(`${inventoryKind}: movement table visibly renders`, await ev("document.querySelector('#prepPreviewTabs [data-preview=movement]').getAttribute('aria-selected')==='true' && document.querySelectorAll('#previewTable .movement-input').length>0 && document.querySelector('#previewTable').textContent.includes('재고실사')"));
    check(`${inventoryKind}: non-BOX row text is red`, await ev("(()=>{const row=document.querySelector('#previewTable table.preview-movement tbody tr.unit-alert-row');return !!row && getComputedStyle(row.cells[0]).color==='rgb(185, 28, 28)';})()"));
    check(`${inventoryKind}: negative quantity cells have yellow backgrounds`, await ev("(()=>{const cells=[...document.querySelectorAll('#previewTable .movement-negative-cell')];return cells.length>0 && cells.every(cell=>getComputedStyle(cell).backgroundColor==='rgb(254, 249, 195)');})()"));
    await screenshot(`${inventoryKind}-movement`);
    if (inventoryKind === "movement") continue;

    await change(cell(0, "stocktake"), 0);
    const stocktake = await view();
    assert.equal(stocktake.rows[0].stocktakeQuantity, 0, "stocktake zero is a real count");
    assert.equal(stocktake.rows[0].finalQuantity, 0, "zero stocktake overrides computed balance");
    check("stocktake zero updates visible final quantity", await ev(`document.querySelector(${JSON.stringify(cell(0, "stocktake"))}).value==='0'`));
    check("zero quantity is not highlighted yellow", await ev(`getComputedStyle(document.querySelector(${JSON.stringify(cell(0, "stocktake"))}).closest('td')).backgroundColor!=='rgb(254, 249, 195)'`));
    await paste(cell(0, "opening"), "20\t3\t5\n8.5\t1.5\t14");
    const pasted = await view();
    assert.deepEqual(pasted.rows.slice(0, 2).map((r) => [r.openingQuantity, r.inboundQuantity, r.salesQuantity]), [[20, 3, 5], [8.5, 1.5, 14]]);
    assert.equal(pasted.rows[1].remainingQuantity, -4, "oversold quantity is retained");
    check("two-row three-column paste preserves decimals and negative calculated stock", true);
    const beforeBadPaste = await ev("JSON.stringify(__inventoryTest.state.workspace)");
    await paste(cell(0, "opening"), "101\t2\n9\tinvalid");
    assert.equal(await ev("JSON.stringify(__inventoryTest.state.workspace)"), beforeBadPaste, "invalid rectangular paste leaves entire workspace untouched");
    check("failed multi-cell paste is atomic", true);
    await paste(cell(0, "sales"), "77\t88");
    assert.equal(await ev("JSON.stringify(__inventoryTest.state.workspace)"), beforeBadPaste, "paste crossing a calculated column leaves entire workspace untouched");
    check("paste cannot partially overwrite calculated columns", true);
    await ev(`(()=>{const input=document.querySelector(${JSON.stringify(cell(0, "opening"))});input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    check("Enter moves to same editable column on next row", await ev(`document.activeElement===document.querySelector(${JSON.stringify(cell(1, "opening"))})`));
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))");
    check("Tab moves to next editable column", await ev(`document.activeElement===document.querySelector(${JSON.stringify(cell(1, "inbound"))})`));
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))");
    check("ArrowUp moves to the same editable column in the previous row", await ev(`document.activeElement===document.querySelector(${JSON.stringify(cell(0, "inbound"))})`));

    const saved = await ev("JSON.stringify(ShippingManagementEngine.getInventoryMovementView(__inventoryTest.state.workspace).rows)");
    await until(() => ev(`!!__inventoryTest.state.recoveryRecord?.payload?.workspace && JSON.stringify(ShippingManagementEngine.getInventoryMovementView(__inventoryTest.state.recoveryRecord.payload.workspace).rows)===${JSON.stringify(saved)}`), "automatic local save");
    const savedTimeOrigin = await ev("performance.timeOrigin");
    await send("Page.reload", { ignoreCache: true });
    await until(() => ev(`performance.timeOrigin!==${savedTimeOrigin} && Boolean(globalThis.__inventoryTest?.state.db && __inventoryTest.state.recoveryRecords.some(candidate=>candidate.valid))`), "recovery record after reload");
    await ev("document.querySelector('#headerRestoreButton').click()");
    await until(() => ev("Boolean(__inventoryTest.state.workspace)"), "restore inventory-only workspace");
    await selectMovement();
    assert.equal(await ev("JSON.stringify(ShippingManagementEngine.getInventoryMovementView(__inventoryTest.state.workspace).rows)"), saved);
    check("refresh + recovery preserves sources, edits, stocktake zero and all row results", true);
    check("restored movement cells remain editable", await ev(`document.querySelector(${JSON.stringify(cell(0, "stocktake"))}).value==='0'`));
    const beforeDownloads = new Set(readdirSync(downloads));
    await ev("document.querySelector('#movementDownloadButton').click()");
    await until(() => readdirSync(downloads).some((name) => !beforeDownloads.has(name) && name.endsWith(".xlsx")), "movement Excel export");
    const exportedName = readdirSync(downloads).find((name) => !beforeDownloads.has(name) && name.endsWith(".xlsx"));
    const exported = XLSX.read(readFileSync(join(downloads, exportedName)), { type: "buffer" });
    const exportedRows = XLSX.utils.sheet_to_json(exported.Sheets[exported.SheetNames[0]], { header: 1, defval: null });
    check("export includes stocktake and final inventory columns", exportedRows.some((row) => row.includes("재고실사") && row.includes("확정재고")));
    const headerIndex = exportedRows.findIndex((row) => row.includes("재고실사") && row.includes("확정재고"));
    const headers = exportedRows[headerIndex];
    const restoredRows = JSON.parse(saved);
    const codes = new Set(restoredRows.map((row) => row.productCode));
    const exportedData = exportedRows.slice(headerIndex + 1).filter((row) => codes.has(String(row[headers.indexOf("품목코드")])));
    assert.equal(exportedData.length, expected[inventoryKind].count, "export keeps all movement rows");
    const firstExported = exportedData.find((row) => row[headers.indexOf("품목코드")] === restoredRows[0].productCode);
    assert.equal(firstExported[headers.indexOf("재고실사")], 0);
    assert.equal(firstExported[headers.indexOf("확정재고")], 0);
    assert.equal(firstExported[headers.indexOf("재고")], 20);
    check("export retains all SKU rows, edited opening stock and zero stocktake/final stock", true);
    await screenshot("restored-edited-movement");
  }
  assert.deepEqual(report.externalWrites, [], "No external write attempts");
  assert.deepEqual(report.errors, [], "No browser runtime exceptions");
  report.result = "passed";
  console.log(`Inventory movement browser acceptance passed (${report.fixtures}); evidence ${evidence}`);
} catch (error) {
  report.result = "failed"; report.error = error.stack || String(error); process.exitCode = 1; console.error(report.error);
  if (ev) { try { report.pageStatus = await ev("({inputs:Object.fromEntries(['inventory','sales','purchases','orders'].map(kind=>[kind,{file:__inventoryTest.state[kind]?.fileName,rows:__inventoryTest.state[kind]?.rows?.length,errors:__inventoryTest.state[kind]?.errors?.slice(0,3)}])),files:document.querySelector('#prepFileList')?.textContent,status:document.querySelector('#systemMessage')?.textContent,toast:document.querySelector('#toast')?.textContent.slice(0,800)})"); console.error(JSON.stringify(report.pageStatus)); } catch (_) { /* page may be navigating */ } }
  if (send) { try { const screenshot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, "failure.png"), Buffer.from(screenshot.data, "base64")); } catch (_) { /* Browser may have exited. */ } }
} finally {
  report.finishedAt = new Date().toISOString(); writeFileSync(join(evidence, "verification.json"), JSON.stringify(report, null, 2));
  socket?.close();
  if (browser?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(browser.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else { spawnSync("pkill", ["-TERM", "-P", String(browser.pid)], { stdio: "ignore" }); browser.kill("SIGTERM"); }
  }
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
