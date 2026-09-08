#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const canonicalHtml = readFileSync(join(root, "orderops", "list.html"), "utf8").replace(
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js",
  "/customer-master/vendor/xlsx.full.min.js",
);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  if (pathname === "/orderops/list.html") {
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": mime[".html"] });
    response.end(canonicalHtml);
    return;
  }
  const relative = pathname === "/" ? "orderops/list.html" : pathname.replace(/^\/+/, "");
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end("Forbidden");
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end("Not found");
  response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": mime[extname(target).toLowerCase()] || "application/octet-stream" });
  response.end(readFileSync(target));
});

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
};
const commandPath = (command) => {
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "" : "";
};
const browserPath = () => [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  commandPath("google-chrome"),
  commandPath("google-chrome-stable"),
  commandPath("chromium"),
  commandPath("chromium-browser"),
  commandPath("msedge"),
].filter(Boolean).find(existsSync) || "";

class Cdp {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      (this.events.get(message.method) || []).forEach((listener) => listener(message.params));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout = 20_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter((item) => item !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() {
    this.socket?.close();
  }
}

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const uploadWorkbook = (client, inputId, fileName, matrix, sheetName) => evaluate(client, `(async()=>{
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}),${JSON.stringify(sheetName)});
  const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'});
  const transfer=new DataTransfer();
  transfer.items.add(new File([bytes],${JSON.stringify(fileName)},{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const input=document.querySelector(${JSON.stringify(inputId)});
  Object.defineProperty(input,'files',{configurable:true,value:transfer.files});
  input.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})()`);

const orderMatrix = [
  ["일자-No.", "담당", "창고", "단위", "품목코드", "품목명", "규격", "수량", "재고", "단가", "공급가액", "적요", "적요1", "거래처", "그룹"],
  ["2026/09/10-001", "김담당", "1창고", "BOX", "GRID-001", "그리드 상품1", "BOX", 3, 0, 1000, 3000, "문앞", "오전", "거래처A", "그룹A"],
  ["2026/09/10-002", "박담당", "1창고", "BOX", "GRID-002", "그리드 상품2", "BOX", 2, 0, 2000, 4000, "경비실", "오후", "거래처B", "그룹B"],
];
const inventoryMatrix = [
  ["회사명 : Excel cell-grid browser fixture"],
  ["사용", "품목코드", "단위", "품목명", "규격", "수량", "1창고", "2전송", "3서울", "4전송", "7진영", "기본", "전송", "창고"],
  ["Yes", "GRID-001", "BOX", "그리드 상품1", "BOX", 20, 20, "", "", "", "", "", "", ""],
  ["Yes", "GRID-002", "BOX", "그리드 상품2", "BOX", 20, 20, "", "", "", "", "", "", ""],
];

let browserProcess;
let client;
const profile = mkdtempSync(join(tmpdir(), "oneapp-orderops-cell-grid-"));
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address()));
  });
  const executable = browserPath();
  assert.ok(executable, "Chrome/Edge is required");
  browserProcess = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "DevToolsActivePort");
  const debugPort = await waitFor(() => existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split(/\r?\n/)[0] : "", "browser debug port");
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).find((item) => item.type === "page") : null;
  }, "browser target");
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/orderops/list.html` });
  await loaded;
  await waitFor(() => evaluate(client, `typeof XLSX==='object'&&document.readyState==='complete'`), "local workbook runtime");

  await uploadWorkbook(client, "#ordersInput", "ORDERQ_그리드_주문.xlsx", orderMatrix, "주문현황");
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName').textContent.includes('ORDERQ_그리드_주문.xlsx')`), "order workbook");
  await uploadWorkbook(client, "#inventoryInput", "ORDERQ_그리드_재고.xlsx", inventoryMatrix, "창고별재고");
  await waitFor(() => evaluate(client, `!document.querySelector('#analyzeButton').disabled`), "analysis readiness");
  await evaluate(client, `document.querySelector('#analyzeButton').click()`);
  await waitFor(() => evaluate(client, `
    document.querySelector('#analyzeButton').textContent.includes('출고분석 Enter') &&
    !document.querySelector('#analyzeButton').disabled &&
    document.querySelector('#validationBox').textContent.includes('검증 완료')
  `), "completed analysis and order result tab");
  await evaluate(client, `document.querySelector('#ordersDrop').click()`);
  try {
    await waitFor(() => evaluate(client, `document.querySelectorAll('#previewTable table.preview-allocations tbody tr[data-grid-row-key]').length===2`), "allocation cell grid");
  } catch (error) {
    const diagnostic = await evaluate(client, `({
      console:document.querySelector('#systemConsole')?.textContent||'',
      validation:document.querySelector('#validationBox')?.textContent||'',
      preview:document.querySelector('#previewTable')?.textContent?.slice(0,1000)||'',
      active:document.querySelector('[role="tab"][aria-selected="true"]')?.textContent||'',
      toast:document.querySelector('.toast:not(.hidden)')?.textContent||'',
    })`);
    console.error("ORDER Q grid diagnostic", diagnostic);
    throw error;
  }

  const gridContract = await evaluate(client, `(()=>{
    const rows=[...document.querySelectorAll('#previewTable table.preview-allocations tbody tr[data-grid-row-key]')];
    const headers=[...document.querySelectorAll('#previewTable thead th')].map(node=>node.textContent.trim());
    const identityIndexes=['상품코드','품명','규격'].map(label=>headers.findIndex(header=>header.startsWith(label)));
    return {
      fields:rows.map(row=>[...row.querySelectorAll('.order-edit-input')].map(input=>input.dataset.orderField)),
      inventoryEditors:rows.map(row=>row.querySelectorAll('.inventory-input[data-inventory-column]').length),
      purchaseEditors:rows.map(row=>row.querySelectorAll('.purchase-input[data-purchase-code]').length),
      identityInputs:rows.flatMap(row=>identityIndexes.map(index=>row.cells[index]?.querySelector('input')).filter(Boolean)).length,
      identityIndexes,
    };
  })()`);
  for (const fields of gridContract.fields) {
    assert.deepEqual(fields, ["warehouse", "customer", "group", "manager", "quantity", "unitPrice", "deliveryNotice"]);
  }
  assert.ok(gridContract.inventoryEditors.every((count) => count > 0), "warehouse quantities must be editable in the order table");
  assert.ok(gridContract.purchaseEditors.every((count) => count === 1), "purchase place must be editable in the order table");
  assert.ok(gridContract.identityIndexes.every((index) => index >= 0), "all product identity columns must be present");
  assert.equal(gridContract.identityInputs, 0, "product code, name, and specification must remain fixed row identity");

  await evaluate(client, `(()=>{
    const input=document.querySelector('.preview-allocations .order-edit-input[data-order-field="customer"]');
    input.focus();
    input.value='거래처A 수정';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
    return true;
  })()`);
  const enterResult = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{
      const inputs=[...document.querySelectorAll('.preview-allocations .order-edit-input[data-order-field="customer"]')];
      return {
        values:inputs.map(input=>input.value),
        activeField:document.activeElement?.dataset?.orderField||'',
        activeIndex:inputs.indexOf(document.activeElement),
        outline:getComputedStyle(document.activeElement?.closest('tr')).outlineWidth,
      };
    })()`);
    return value.activeIndex === 1 ? value : null;
  }, "Enter downward navigation");
  assert.deepEqual(enterResult.values, ["거래처A 수정", "거래처B"]);
  assert.equal(enterResult.activeField, "customer");
  assert.equal(enterResult.outline, "2px");

  await evaluate(client, `(()=>{
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true,cancelable:true}));
    return true;
  })()`);
  const arrowResult = await waitFor(async () => {
    const value = await evaluate(client, `({field:document.activeElement?.dataset?.orderField||'',row:document.activeElement?.closest('tr')?.dataset?.gridRowKey||''})`);
    return value.field === "group" ? value : null;
  }, "ArrowRight cell navigation");
  assert.match(arrowResult.row, /^order:/);

  await evaluate(client, `(()=>{
    const input=document.querySelector('.preview-allocations .inventory-input[data-inventory-column]');
    document.body.dataset.testGridColumn=input.dataset.gridColumn;
    input.focus();
    input.value='18';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
    return true;
  })()`);
  const inventoryMove = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{
      const key=document.body.dataset.testGridColumn;
      const inputs=[...document.querySelectorAll('.preview-allocations .inventory-input[data-inventory-column]')]
        .filter(input=>input.dataset.gridColumn===key);
      return {values:inputs.map(input=>input.value),activeIndex:inputs.indexOf(document.activeElement)};
    })()`);
    return value.activeIndex === 1 ? value : null;
  }, "inventory ArrowDown navigation");
  assert.equal(inventoryMove.values[0], "18");

  await evaluate(client, `(()=>{
    const input=document.querySelector('.preview-allocations .purchase-input[data-purchase-code]');
    input.focus();
    input.value='구매처X';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
    return true;
  })()`);
  const purchaseMove = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{
      const inputs=[...document.querySelectorAll('.preview-allocations .purchase-input[data-purchase-code]')];
      return {values:inputs.map(input=>input.value),activeIndex:inputs.indexOf(document.activeElement)};
    })()`);
    return value.activeIndex === 1 ? value : null;
  }, "purchase Enter navigation");
  assert.deepEqual(purchaseMove.values, ["구매처X", ""]);

  await evaluate(client, `document.querySelector('#inventoryDrop').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('#previewTable table.preview-inventory [data-substitution-target-product="GRID-002"]'))`), "inventory substitution targets");
  const beforeNoop = await evaluate(client, `(()=>{
    const chip=document.querySelector('button[data-substitute-order-row]');
    chip.click();
    const table=document.querySelector('#previewTable table.preview-inventory');
    const row=table.querySelector('tbody tr[data-product-code="GRID-002"]');
    row.querySelector('td.primary-readable-cell').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}));
    return {
      selected:table.querySelectorAll('.substitution-selected').length,
      history:table.querySelectorAll('.system-history-message').length,
      historyText:[...table.querySelectorAll('.system-history-message')].map(node=>node.textContent.trim()),
      historyTitle:table.querySelector('.system-history-list')?.getAttribute('title')||'',
      products:[...table.querySelectorAll('tbody tr[data-product-code]')].map(node=>node.dataset.productCode),
    };
  })()`);
  assert.equal(beforeNoop.selected, 1, "Ctrl+row or non-target cell must not execute substitution");
  assert.equal(beforeNoop.history, 2, "the system column should show the latest two successful cell changes");
  assert.match(beforeNoop.historyTitle, /\[정보수정\] 거래처 · 거래처A → 거래처A 수정/);
  assert.match(beforeNoop.historyTitle, /\[정보수정\] 1창고 · 20 → 18/);
  assert.match(beforeNoop.historyTitle, /\[정보수정\] 구매처 · 빈값 → 구매처X/);
  assert.deepEqual(beforeNoop.products, ["GRID-001", "GRID-002"], "product rows must stay fixed by product code");

  await evaluate(client, `(()=>{
    document.querySelector('[data-substitution-target-product="GRID-002"]')
      .dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}));
    return true;
  })()`);
  let substitutionResult;
  try {
    substitutionResult = await waitFor(async () => {
      const value = await evaluate(client, `(()=>{
        const table=document.querySelector('#previewTable table.preview-inventory');
        return {
          selected:table.querySelectorAll('.substitution-selected').length,
          history:[...table.querySelectorAll('.system-history-message')].map(node=>node.textContent.trim()),
          targetInfo:table.querySelector('[data-substitution-target-product="GRID-002"]')?.textContent||'',
          products:[...table.querySelectorAll('tbody tr[data-product-code]')].map(node=>node.dataset.productCode),
        };
      })()`);
      return value.history.some((message) => message.includes("대체")) ? value : null;
    }, "successful target-cell substitution");
  } catch (error) {
    console.error("ORDER Q substitution diagnostic", await evaluate(client, `({
      console:document.querySelector('.system-console')?.textContent||'',
      toast:document.querySelector('.toast:not(.hidden)')?.textContent||'',
      selected:document.querySelectorAll('.substitution-selected').length,
      history:[...document.querySelectorAll('.system-history-message')].map(node=>node.textContent.trim()),
      info:[...document.querySelectorAll('[data-substitution-target-product]')].map(node=>[node.dataset.substitutionTargetProduct,node.textContent.trim()]),
    })`));
    throw error;
  }
  assert.equal(substitutionResult.selected, 0);
  assert.match(substitutionResult.targetInfo, /거래처A 수정/);
  assert.deepEqual(substitutionResult.products, ["GRID-001", "GRID-002"]);

  console.log("ORDER Q Excel cell-grid browser tests passed: editable business cells, Enter/arrows, row border, and target-cell-only substitution.");
} finally {
  client?.close();
  if (browserProcess && browserProcess.exitCode === null) {
    const exited = new Promise((resolveExit) => browserProcess.once("exit", resolveExit));
    browserProcess.kill();
    await Promise.race([exited, wait(3_000)]);
  }
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {}
}
