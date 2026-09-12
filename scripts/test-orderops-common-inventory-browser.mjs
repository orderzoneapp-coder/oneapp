#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = mkdtempSync(join(tmpdir(), "oneapp-orderops-common-inventory-e2e-"));
const dataOpsColumns = ["단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요", "행사가"];
const dataOpsRows = [["EA", "A100", "상품 A", "10입", 7, "LOT-1", "", 0, 0, "", 0]];
const dataOpsCanonical = {
  schemaVersion: "ONEAPP_DATAOPS_SNAPSHOT_V1",
  basisDate: "2026-09-12",
  columns: dataOpsColumns,
  rows: dataOpsRows,
};
const dataOpsSnapshot = {
  ...dataOpsCanonical,
  revision: "20260912-browser",
  savedAt: "2026-09-12T03:00:00.000Z",
  hash: crypto.createHash("sha256").update(JSON.stringify(dataOpsCanonical)).digest("hex"),
  rowCount: dataOpsRows.length,
  cellCount: dataOpsRows.length * dataOpsColumns.length,
};
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/cloud") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        if (payload.action !== "dataops_snapshot_get") {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ status: "error", message: "unexpected action" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        response.end(JSON.stringify({ status: "success", action: payload.action, data: dataOpsSnapshot }));
      });
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" ? "orderops/list.html" : `${pathname.replace(/^\/+/, "")}${pathname.endsWith("/") ? "index.html" : ""}`;
    const target = normalize(resolve(root, relative));
    if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end("Forbidden");
    if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end("Not found");
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": mime[extname(target)] || "application/octet-stream" });
    response.end(readFileSync(target));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
};
const commandPath = (command) => {
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "" : "";
};
const browserExecutable = () => [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  commandPath("google-chrome"), commandPath("chromium"), commandPath("msedge"),
].filter(Boolean).find(existsSync) || "";

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.events = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      }
      (this.events.get(message.method) || []).forEach((listener) => listener(message.params));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout = 30_000) {
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
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); }
}

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
};
const click = (client, selector) => evaluate(client, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing ${selector}'); node.click(); return true; })()`);

let browser;
let client;
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address()));
  });
  const executable = browserExecutable();
  assert.ok(executable, "Chrome, Chromium, or Edge is required for common inventory browser E2E");
  browser = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "DevToolsActivePort");
  const debugPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").trim().split(/\r?\n/)[0], "browser debugging port");
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter((target) => target.type === "page") : null;
  }, "browser target");
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  const runtimeErrors = [];
  client.on("Runtime.exceptionThrown", (event) => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "runtime error"));

  let loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/orderops/list.html` });
  await loaded;
  await waitFor(() => evaluate(client, `Boolean(window.ShippingManagementEngine && document.querySelector('#restoreButton'))`), "OrderOps runtime");
  await evaluate(client, `(async () => {
    const engine=window.ShippingManagementEngine;
    const orders={
      kind:'orders', fileName:'browser-orders.xlsx', sheetName:'주문', fileHash:'${"a".repeat(64)}', headerRowIndex:0, rowCount:1,
      rows:[{sourceRowNumber:2, inputOrder:1, productCode:'A100', productName:'상품 A', specification:'10입', sourceUnit:'EA', quantity:5, customer:'거래처 A', manager:'김담당', warehouse:'본사', note:'일반 적요 보존', note1:'직원 적요 보존', errors:[]}],
      errors:[], warnings:[], missingColumns:[], sourceMatrix:[['품목코드'],['A100']], productCodeColumnIndex:0,
    };
    const workspace=engine.createPreviewWorkspace(orders);
    const updatedAt='2026-09-12T02:00:00.000Z';
    const payload=engine.buildLocalRecoveryPayload(workspace,{activePreview:'readiness'},{cloudUrl:'https://script.google.com/macros/s/browser-test/exec',savedBy:'browser-test'},updatedAt);
    const bytes=new TextEncoder().encode(engine.canonicalStringify(payload));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
    const record={schemaVersion:'shipping-local-recovery/v2',publicationState:'PUBLISHED',inventoryApplyTransactionId:'',stagedAt:'',publishedAt:updatedAt,recordId:'browser-seed',sourceFingerprint:workspace.sourceFingerprint,updatedAt,hashAlgorithm:'SHA-256',payloadSha256:hash,payload};
    const interruptedAt='2026-09-12T03:00:00.000Z';
    const interruptedPayload=engine.buildLocalRecoveryPayload(workspace,{activePreview:'readiness'},{cloudUrl:'https://script.google.com/macros/s/browser-test/exec',savedBy:'browser-test'},interruptedAt);
    const interruptedBytes=new TextEncoder().encode(engine.canonicalStringify(interruptedPayload));
    const interruptedHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',interruptedBytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
    const interruptedRecord={schemaVersion:'shipping-local-recovery/v2',publicationState:'PUBLISHED',inventoryApplyTransactionId:'INTERRUPTED-BEFORE-FINAL-CHECK',stagedAt:updatedAt,publishedAt:interruptedAt,inventoryApplyCommittedAt:'',recordId:'browser-interrupted-inventory',sourceFingerprint:workspace.sourceFingerprint,updatedAt:interruptedAt,hashAlgorithm:'SHA-256',payloadSha256:interruptedHash,payload:interruptedPayload};
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('ONEAPPShippingRecoveryDB',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('recoveryRecords','readwrite');tx.objectStore('recoveryRecords').put(record);tx.objectStore('recoveryRecords').put(interruptedRecord);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    localStorage.setItem('oneapp.shipping.recovery.pointer.v1',record.recordId);
    localStorage.setItem('oneapp_cloud_sync_url_v1','https://script.google.com/macros/s/browser-test/exec');
    return true;
  })()`);

  loaded = client.once("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await loaded;
  await waitFor(() => evaluate(client, `!document.querySelector('#restoreButton').disabled`), "published recovery selection");
  assert.equal(await evaluate(client, `localStorage.getItem('oneapp.shipping.recovery.pointer.v1')`), 'browser-seed',
    "a newer PUBLISHED inventory candidate without final apply confirmation must not replace the confirmed recovery pointer");
  await click(client, "#restoreButton");
  try {
    await waitFor(() => evaluate(client, `document.querySelector('#previewTable').textContent.includes('상품 A') && [...document.querySelectorAll('#previewTable input')].some(input=>input.value==='거래처 A')`), "restored order workspace");
  } catch (error) {
    const debug = await evaluate(client, `({system:document.querySelector('#systemMessage').textContent,toast:document.querySelector('#toast').textContent,table:document.querySelector('#previewTable').textContent,recovery:document.querySelector('#recoveryMessage').textContent})`);
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
  }
  await evaluate(client, `(() => {
    const snapshot=${JSON.stringify(dataOpsSnapshot)};
    window.__savedCloudSnapshot=null;
    window.fetch=async (url,options)=>{
      if(!String(url).includes('/macros/s/browser-test/exec')) return Promise.reject(new Error('unexpected fetch '+url));
      const payload=JSON.parse(options?.body || '{}');
      let data;
      if(payload.action==='dataops_snapshot_get') data=snapshot;
      else if(payload.action==='shipping_plan_save') {
        window.__savedCloudSnapshot=payload.snapshot;
        data={planId:payload.snapshot.planId,revision:'CLOUD-BROWSER-1',hash:payload.snapshot.hash,rowCount:payload.snapshot.rowCount,cellCount:payload.snapshot.cellCount,savedAt:'2026-09-12T05:00:00.000Z'};
      } else if(payload.action==='shipping_plan_list') {
        const saved=window.__savedCloudSnapshot;
        data=saved ? [{planId:saved.planId,revision:'CLOUD-BROWSER-1',hash:saved.hash,rowCount:saved.rowCount,cellCount:saved.cellCount,savedAt:'2026-09-12T05:00:00.000Z',sourceFileName:'browser'}] : [];
      } else if(payload.action==='shipping_plan_get' && window.__savedCloudSnapshot) {
        const plan=JSON.parse(window.__savedCloudSnapshot.canonicalJson);
        data={plan,metadata:{planId:plan.planId,revision:'CLOUD-BROWSER-1',hash:window.__savedCloudSnapshot.hash,rowCount:window.__savedCloudSnapshot.rowCount,cellCount:window.__savedCloudSnapshot.cellCount}};
      } else return new Response(JSON.stringify({status:'error',message:'unexpected action '+payload.action}),{status:400,headers:{'Content-Type':'application/json'}});
      return new Response(JSON.stringify({status:'success',action:payload.action,data}),{status:200,headers:{'Content-Type':'application/json'}});
    };
    return true;
  })()`);
  await click(client, "#inventoryMenuButton");
  await click(client, "#inventoryDataOpsLoadButton");
  try {
    await waitFor(() => evaluate(client, `document.querySelector('#inventoryCurrentStatus').textContent.includes('적용 완료')`), "DataOps inventory application");
  } catch (error) {
    const debug = await evaluate(client, `({inventory:document.querySelector('#inventoryCurrentStatus').textContent,system:document.querySelector('#systemMessage').textContent,toast:document.querySelector('#toast').textContent})`);
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
  }

  const raceHookInstalled = await evaluate(client, `(() => {
    const original=crypto.subtle.digest.bind(crypto.subtle);
    let calls=0;
    try {
      crypto.subtle.digest=async (...args)=>{
        calls+=1;
        if(calls===7){
          const input=document.querySelector('.order-edit-input[data-order-field="deliveryNotice"],.order-edit-input[data-order-field="note1"]');
          if(input){
            input.focus();
            input.value='직원 적요 최종 수정';
          }
          await new Promise(resolve=>setTimeout(resolve,30));
        }
        return original(...args);
      };
      return crypto.subtle.digest!==original;
    } catch(error) { return false; }
  })()`);
  assert.equal(raceHookInstalled, true, "browser must allow the final-publication race fixture");
  const firstPointer = await evaluate(client, `localStorage.getItem('oneapp.shipping.recovery.pointer.v1')`);
  await click(client, "#inventoryMenuButton");
  await click(client, "#inventoryDataOpsLoadButton");
  await waitFor(() => evaluate(client, `localStorage.getItem('oneapp.shipping.recovery.pointer.v1')!==${JSON.stringify(firstPointer)} && document.querySelector('#inventoryCurrentStatus').textContent.includes('적용 완료')`), "DataOps inventory reapplication with a concurrent final input");

  await evaluate(client, `(() => {
    document.querySelector('#cloudTokenInput').value='browser-shipping-token';
    document.querySelector('#headerCloudSaveButton').click();
    return true;
  })()`);
  await waitFor(() => evaluate(client, `Boolean(window.__savedCloudSnapshot)`), "TOTAL_ONLY Cloud save");

  const outcome = await evaluate(client, `(async () => {
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('ONEAPPShippingRecoveryDB',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const records=await new Promise((resolve,reject)=>{const request=db.transaction('recoveryRecords','readonly').objectStore('recoveryRecords').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const published=records.filter(record=>(record.publicationState||'PUBLISHED')==='PUBLISHED').sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    const latest=published[0];
    return {
      publicationState:latest.publicationState,
      inventoryApplyCommittedAt:latest.inventoryApplyCommittedAt,
      applicationMode:latest.payload.workspace.inventoryApplicationMode,
      planId:latest.payload.workspace.planId,
      purchaseRows:latest.payload.workspace.purchaseManagement.length,
      manager:latest.payload.workspace.orders[0].manager,
      note:latest.payload.workspace.orders[0].note,
      note1:latest.payload.workspace.orders[0].note1,
      sourceEvidence:latest.payload.workspace.sourceFiles.inventory.sourceEvidence,
      stockTotal:latest.payload.workspace.allocations[0].stockTotal,
      remaining:latest.payload.workspace.allocations[0].remainingQuantity,
      stagedCount:records.filter(record=>record.publicationState==='STAGED').length,
      pointer:localStorage.getItem('oneapp.shipping.recovery.pointer.v1'),
      latestId:latest.recordId,
      tableText:document.querySelector('#previewTable').textContent,
      analyzeDisabled:document.querySelector('#analyzeButton').disabled,
      cloudSaveDisabled:document.querySelector('#headerCloudSaveButton').disabled,
      cloudSavePanelDisabled:document.querySelector('#cloudSaveButton').disabled,
      systemMessage:document.querySelector('#systemMessage').textContent,
      shipmentExecutionHidden:document.querySelector('#shipmentExecution').hidden,
      cloudSnapshot:window.__savedCloudSnapshot,
    };
  })()`);
  assert.equal(outcome.publicationState, "PUBLISHED");
  assert.match(outcome.inventoryApplyCommittedAt, /^2026-|^20\d\d-/);
  assert.equal(outcome.applicationMode, "TOTAL_ONLY");
  assert.match(outcome.planId, /^SHIPPLAN-20260912-[a-f0-9]{16}$/);
  assert.equal(outcome.purchaseRows, 0);
  assert.equal(outcome.manager, "김담당");
  assert.equal(outcome.note, "일반 적요 보존");
  assert.equal(outcome.note1, "직원 적요 최종 수정");
  assert.deepEqual(outcome.sourceEvidence.rows, dataOpsRows);
  assert.equal(outcome.stockTotal, 7);
  assert.equal(outcome.remaining, 2);
  assert.equal(outcome.stagedCount, 0);
  assert.equal(outcome.pointer, outcome.latestId);
  assert.ok(outcome.tableText.includes("7") && outcome.tableText.includes("2"));
  assert.equal(outcome.analyzeDisabled, true);
  assert.equal(outcome.cloudSaveDisabled, false);
  const cloudPlan = JSON.parse(outcome.cloudSnapshot.canonicalJson);
  assert.equal(cloudPlan.workspace.inventoryApplicationMode, "TOTAL_ONLY");
  assert.equal(cloudPlan.workspace.orders[0].note1, "직원 적요 최종 수정");
  assert.deepEqual(cloudPlan.workspace.sourceFiles.inventory.sourceEvidence.rows, dataOpsRows);
  assert.equal(outcome.shipmentExecutionHidden, true);
  assert.deepEqual(runtimeErrors, []);

  await waitFor(() => evaluate(client, `!document.querySelector('#cloudLoadButton').disabled`), "saved TOTAL_ONLY Cloud revision");
  await evaluate(client, `(() => {
    const input=document.querySelector('.order-edit-input[data-order-field="deliveryNotice"],.order-edit-input[data-order-field="note1"]');
    input.value='Cloud 복구 전 임시 변경';
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await click(client, "#cloudLoadButton");
  await waitFor(() => evaluate(client, `[...document.querySelectorAll('.order-edit-input[data-order-field="deliveryNotice"],.order-edit-input[data-order-field="note1"]')].some(input=>input.value==='직원 적요 최종 수정')`), "TOTAL_ONLY Cloud workspace restore");
  console.log("OrderOps common inventory browser E2E PASS");
} finally {
  client?.close();
  if (browser && !browser.killed) {
    browser.kill();
    await Promise.race([
      new Promise((resolveExit) => browser.once("exit", resolveExit)),
      wait(1500),
    ]);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) {}
}
