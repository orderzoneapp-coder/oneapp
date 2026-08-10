import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const html = fs.readFileSync(path.join(ROOT, "orderops", "list.html"), "utf8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length > 0, "OrderOps inline script를 찾을 수 없습니다.");
inlineScripts.forEach((match, index) => new vm.Script(match[1], { filename: `orderops/list.html:inline-${index + 1}` }));

const REQUIRED_ORDER_HEADERS = ["담당", "품목코드", "품목명", "규격", "수량", "적요", "적요1", "거래처", "그룹"];
const INVENTORY_MATRIX = [
  ["품목코드", "품목명", "규격", "수량", "1창고", "3서울", "4전송"],
  ["DATE-001", "날짜 상품", "EA", 0, 0, 0, 0],
];

function parseOrders(dateHeaders, rows) {
  const headers = [...dateHeaders, ...REQUIRED_ORDER_HEADERS];
  const matrix = [
    headers,
    ...rows.map((row, index) => [
      ...dateHeaders.map((header) => row[header] ?? ""),
      row.manager ?? `담당${index + 1}`,
      row.productCode ?? "DATE-001",
      row.productName ?? "날짜 상품",
      row.specification ?? "EA",
      row.quantity ?? 1,
      row.note ?? "",
      row.note1 ?? "",
      row.customer ?? `거래처${index + 1}`,
      row.group ?? "기본",
    ]),
  ];
  return engine.parseOrderWorkbook({ fileName: "주문.xlsx", sheetName: "주문", rawMatrix: matrix, displayMatrix: matrix });
}

function parseInventory() {
  return engine.parseInventoryWorkbook({
    fileName: "재고.xlsx",
    sheetName: "재고",
    rawMatrix: INVENTORY_MATRIX,
    displayMatrix: INVENTORY_MATRIX,
  });
}

function analyze(orders) {
  return engine.analyze(orders, parseInventory(), { sourceFingerprint: "a".repeat(64) });
}

for (const [header, value] of [
  ["일자-No.", "2026-08-10-1"],
  ["일자", "2026/08/10"],
  ["주문일자", "2026.08.10"],
]) {
  const orders = parseOrders([header], [{ [header]: value }]);
  assert.equal(orders.errors.length, 0, `${header} 단독 날짜 열은 파싱되어야 합니다.`);
  assert.equal(orders.rows[0].basisDate, "2026-08-10");
  const workspace = analyze(orders);
  assert.equal(workspace.basisDateStatus, "valid");
  assert.equal(workspace.basisDate, "2026-08-10");
  assert.equal(workspace.uploadDate, "20260810");
}

const matchingDates = parseOrders(["일자-No.", "일자", "주문일자"], [{
  "일자-No.": "2026-08-10-7",
  "일자": "2026/08/10",
  "주문일자": "2026-08-10",
}]);
assert.equal(matchingDates.errors.some((issue) => issue.code === "ORDER_DUPLICATE_CANONICAL_HEADERS"), false);
assert.equal(matchingDates.rows[0].basisDateStatus, "valid");
assert.equal(analyze(matchingDates).basisDate, "2026-08-10");

const mismatchedDates = parseOrders(["일자", "주문일자"], [{
  "일자": "2026-08-10",
  "주문일자": "2026-08-11",
}]);
assert.equal(mismatchedDates.rows[0].basisDateStatus, "conflict");
assert.equal(analyze(mismatchedDates).basisDateStatus, "conflict");

const invalidDates = parseOrders(["주문일자"], [{ 주문일자: "2026-02-30" }]);
assert.equal(invalidDates.rows[0].basisDateStatus, "invalid");
assert.equal(analyze(invalidDates).basisDateStatus, "invalid");

const mixedRowDates = parseOrders(["일자"], [
  { 일자: "2026-08-10" },
  { 일자: "2026-08-11" },
]);
assert.equal(analyze(mixedRowDates).basisDateStatus, "conflict");

const noticeOrders = parseOrders(["일자"], [
  { 일자: "2026-08-10", manager: "담당A", customer: "거래처A", note: "  원문 적요 A  " },
  { 일자: "2026-08-10", manager: "담당B", customer: "거래처B", note1: "원문 적요1 B" },
]);
const noticeValidation = engine.validateInputs(noticeOrders, parseInventory());
assert.equal(noticeValidation.canAnalyze, true, "전달사항은 분석을 차단하지 않아야 합니다.");
assert.equal(noticeValidation.noticeCount, 2);
const noticeWorkspace = analyze(noticeOrders);
assert.equal(noticeWorkspace.notices.length, 2, "원 주문별 전달사항을 별도 건으로 유지해야 합니다.");
assert.deepEqual(noticeWorkspace.notices.map((notice) => [notice.manager, notice.customer]), [
  ["담당A", "거래처A"],
  ["담당B", "거래처B"],
]);
assert.equal(noticeWorkspace.notices[0].note, "  원문 적요 A  ", "전달사항 원문의 앞뒤 공백도 보존해야 합니다.");
assert.equal(noticeWorkspace.validationResults.some((result) => result.item === "적요 확인"), false);
assert.equal(engine.getPurchaseUploadSelection(noticeWorkspace).included.length, 1, "전달사항 건수와 무관하게 구매업로드 대상이 유지되어야 합니다.");

const firstNoticeId = noticeWorkspace.notices[0].noticeId;
engine.setNoticeAcknowledged(noticeWorkspace, firstNoticeId, true);
assert.equal(engine.isNoticeAcknowledged(noticeWorkspace, firstNoticeId), true);
const workspaceRoundTrip = JSON.parse(JSON.stringify(noticeWorkspace));
engine.ensureNoticeState(workspaceRoundTrip);
assert.deepEqual(workspaceRoundTrip.noticeAcknowledgements.acknowledgedIds, [firstNoticeId]);

const legacyWorkspace = JSON.parse(JSON.stringify(noticeWorkspace));
delete legacyWorkspace.notices;
delete legacyWorkspace.noticeAcknowledgements;
engine.ensureNoticeState(legacyWorkspace);
assert.equal(legacyWorkspace.notices.length, 2, "기존 workspace JSON 복구 시 전달사항을 다시 구성해야 합니다.");
assert.deepEqual(legacyWorkspace.noticeAcknowledgements.acknowledgedIds, []);

const recoveryPayload = engine.buildLocalRecoveryPayload(
  noticeWorkspace,
  { activePreview: "notices" },
  { cloudUrl: "https://script.google.com/macros/s/example/exec", savedBy: "관리자", cloudToken: "SECRET" },
  "2026-08-10T12:00:00.000Z",
);
const recoveryJson = JSON.stringify(recoveryPayload);
assert.equal(recoveryJson.includes("SECRET"), false);
assert.equal(/cloudToken|"token"/i.test(recoveryJson), false, "로컬 복구 직렬화에는 Cloud token 키나 값이 없어야 합니다.");
assert.deepEqual(
  engine.sanitizeCloudTokenKeys({ settings: { cloudToken: "SECRET", savedBy: "관리자" }, nested: { token: "SECRET" } }),
  { settings: { savedBy: "관리자" }, nested: {} },
  "기존 로컬 복구자료 이관 시 중첩된 token 키도 제거해야 합니다.",
);
assert.deepEqual(recoveryPayload.workspace.noticeAcknowledgements.acknowledgedIds, [firstNoticeId]);
assert.equal(
  engine.canonicalStringify({ z: 1, a: { y: 2, b: 3 } }),
  engine.canonicalStringify({ a: { b: 3, y: 2 }, z: 1 }),
  "canonical JSON은 객체 키 순서와 무관해야 합니다.",
);
const recoveryHash = crypto.createHash("sha256").update(engine.canonicalStringify(recoveryPayload)).digest("hex");
const tamperedPayload = JSON.parse(JSON.stringify(recoveryPayload));
tamperedPayload.workspace.basisDate = "2026-08-11";
assert.notEqual(
  crypto.createHash("sha256").update(engine.canonicalStringify(tamperedPayload)).digest("hex"),
  recoveryHash,
  "복구 payload 변경은 SHA-256 불일치로 검출되어야 합니다.",
);

const selection = engine.selectLatestVerifiedRecovery([
  { valid: true, record: { recordId: "old", updatedAt: "2026-08-10T10:00:00.000Z" } },
  { valid: false, reason: "SHA-256 불일치", record: { recordId: "corrupt", updatedAt: "2026-08-10T13:00:00.000Z" } },
  { valid: true, record: { recordId: "new", updatedAt: "2026-08-10T12:00:00.000Z" } },
], "old");
assert.equal(selection.selected.recordId, "new", "유효 포인터보다 최신 updatedAt 정상본을 선택해야 합니다.");
assert.equal(selection.pointerOutdated, true);
assert.equal(selection.corruptionDetected, true);

function recoveryAdapter(store, pointerState, failure = {}) {
  return {
    getPointer: () => pointerState.value,
    putRecord: async (record) => {
      if (failure.put) throw new Error("INJECTED_PUT_FAILURE");
      store.set(record.recordId, structuredClone(record));
    },
    readRecord: async (recordId) => failure.read ? { recordId, tampered: true } : structuredClone(store.get(recordId)),
    verifyRecord: async (record) => ({ valid: !record?.tampered, reason: record?.tampered ? "SHA-256 불일치" : "" }),
    deleteRecord: async (recordId) => { store.delete(recordId); },
    setPointer: async (recordId) => {
      if (failure.pointer && recordId === "new") throw new Error("INJECTED_POINTER_FAILURE");
      pointerState.value = recordId;
    },
    clearPointer: async () => { pointerState.value = ""; },
    restorePointer: async (recordId) => { pointerState.value = recordId || ""; },
  };
}

const oldRecord = { recordId: "old", updatedAt: "2026-08-10T10:00:00.000Z" };
const newRecord = { recordId: "new", updatedAt: "2026-08-10T12:00:00.000Z" };
{
  const store = new Map([["old", oldRecord]]);
  const pointer = { value: "old" };
  await engine.commitVerifiedRecoveryRecord(newRecord, recoveryAdapter(store, pointer));
  assert.equal(pointer.value, "new");
  assert.equal(store.has("old"), true, "새 정상본 확정 전후에도 기존 복구자료를 선삭제하지 않아야 합니다.");
}
for (const failure of [{ put: true }, { read: true }, { pointer: true }]) {
  const store = new Map([["old", oldRecord]]);
  const pointer = { value: "old" };
  await assert.rejects(
    engine.commitVerifiedRecoveryRecord(newRecord, recoveryAdapter(store, pointer, failure)),
    /INJECTED|검산 실패/,
  );
  assert.equal(pointer.value, "old", "실패 주입 시 기존 포인터를 보존해야 합니다.");
  assert.deepEqual(store.get("old"), oldRecord, "실패 주입 시 기존 정상 레코드를 보존해야 합니다.");
  assert.equal(store.has("new"), false, "실패한 새 복구자료는 다음 실행에서 정상본으로 오인되지 않아야 합니다.");
}

const cloudRoundTrip = JSON.parse(JSON.stringify({ workspace: noticeWorkspace }));
assert.deepEqual(cloudRoundTrip.workspace.noticeAcknowledgements.acknowledgedIds, [firstNoticeId]);
assert.equal(engine.containsCloudTokenKey(cloudRoundTrip), false);

const mainMarkup = html.slice(0, html.indexOf("</main>"));
assert.equal(mainMarkup.includes('id="cloudUrlInput"'), false, "Cloud 설정 입력은 메인 화면에 남지 않아야 합니다.");
assert.equal(mainMarkup.includes('id="cloudTokenInput"'), false, "Token 입력은 메인 화면에 남지 않아야 합니다.");
assert.match(mainMarkup, /id="localSaveStatus"/);
assert.match(mainMarkup, /id="cloudStatus"/);
assert.match(html, /id="settingsModal"[\s\S]*role="dialog" aria-modal="true"/);
assert.match(html, /data-settings-extension-slot="future"/);
assert.match(html, /const LOCAL_RECOVERY_LIMIT = 10/);
assert.match(html, /const LOCAL_DB_NAME = "ONEAPPShippingRecoveryDB"/);
assert.match(html, /const LEGACY_LOCAL_DB_NAME = "ONEAPPShippingManagementDB"/);
assert.match(html, /async function persistLegacyCompatibilityRecord[\s\S]*payloadSha256[\s\S]*markLegacyMigration/);
assert.match(html, /id="discardRecoveryButton" disabled>선택 삭제/);
assert.match(html, /const candidateWorkspace = await analyzeCurrentInputs\(\);[\s\S]*await persistLocalWorkspace\(candidateWorkspace[\s\S]*state\.workspace = candidateWorkspace/);
assert.doesNotMatch(html, /cloudToken:\s*elements\.cloudTokenInput|record\.settings\?\.cloudToken/);
assert.match(html, /label: `전달사항 \$\{workspace\.notices\.length\}/);
assert.match(html, /data-open-notice-id/);
assert.match(html, /data-notice-acknowledgement/);
assert.doesNotMatch(html, /item:\s*"적요 확인"|정상기준 0/);

console.log("OrderOps recovery, date, settings-modal, and delivery-notice tests passed.");
