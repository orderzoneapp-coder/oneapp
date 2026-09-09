import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const workbookTools = require(path.join(ROOT, "orderFulfillmentWorkbook.js"));

function parseOrders(rows) {
  const matrix = [
    ["일자-No.", "품목코드", "품목명", "규격", "수량", "적요", "적요1", "거래처", "그룹", "단위", "단가"],
    ...rows.map((row, index) => [
      `2026-09-10-${index + 1}`,
      row.productCode,
      row.productName || `상품 ${row.productCode}`,
      row.specification || "EA",
      row.quantity,
      "",
      "",
      row.customer || "거래처A",
      "기본",
      "EA",
      1000,
    ]),
  ];
  return engine.parseOrderWorkbook({
    fileName: "주문.xlsx",
    sheetName: "주문",
    rawMatrix: matrix,
    displayMatrix: matrix,
    fileHash: "1".repeat(64),
  });
}

function parseInventory(codes) {
  const matrix = [
    ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "3서울", "4전송"],
    ...codes.map((code) => [code, `상품 ${code}`, "EA", "EA", 10, 10, 0, 0]),
  ];
  return engine.parseInventoryWorkbook({
    fileName: "재고.xlsx",
    sheetName: "재고",
    rawMatrix: matrix,
    displayMatrix: matrix,
    fileHash: "2".repeat(64),
  });
}

function addIdentity(row, orderItemId) {
  row.orderId = "ORDER-20260910-001";
  row.orderItemId = orderItemId;
  row.sourceLineKey = orderItemId;
  return row;
}

const repeatedOrders = parseOrders([
  { productCode: "P-SAME", quantity: 2 },
  { productCode: "P-SAME", quantity: 2 },
]);
addIdentity(repeatedOrders.rows[0], "LINE-1");
addIdentity(repeatedOrders.rows[1], "LINE-2");
const repeatedReview = engine.getOrderReviewState(repeatedOrders);
assert.equal(repeatedReview.hasDuplicateOrders, false,
  "같은 주문·상품·날짜·수량이라도 서로 다른 원본 행이면 중복으로 간주하면 안 됩니다.");
const repeatedWorkspace = engine.analyze(repeatedOrders, parseInventory(["P-SAME"]), {
  sourceFingerprint: "3".repeat(64),
});
assert.deepEqual(engine.getInventoryViewRows(repeatedWorkspace).rows[0].systemMessages, []);
assert.doesNotThrow(() => workbookTools.assertExcelOutputAllowed(repeatedWorkspace),
  "정상 반복 주문은 Excel 출력을 막으면 안 됩니다.");

const reviewOrders = parseOrders([
  { productCode: "P-ERR", quantity: "" },
  { productCode: "P-ERR", quantity: "not-a-number" },
  { productCode: "P-OK", quantity: 0 },
  { productCode: "P-OK", quantity: -1.5 },
  { productCode: "P-OK", quantity: "(2)" },
  { productCode: "P-OK", quantity: 2.25 },
]);
addIdentity(reviewOrders.rows[0], "DUPLICATE-LINE");
addIdentity(reviewOrders.rows[1], "DUPLICATE-LINE");
reviewOrders.rows.slice(2).forEach((row, index) => addIdentity(row, `VALID-LINE-${index + 1}`));

assert.equal(reviewOrders.errors.length, 0, "수량 오류는 분석 자체를 차단하면 안 됩니다.");
assert.equal(reviewOrders.rows.length, 6, "수량 오류 행도 수정 가능하도록 유지해야 합니다.");
assert.deepEqual(reviewOrders.rows.slice(0, 2).map((row) => row.quantity), ["", "not-a-number"]);
assert.deepEqual(reviewOrders.rows.slice(2).map((row) => row.quantity), [0, -1.5, -2, 2.25],
  "0·음수·소수·괄호 음수는 유효한 수량이어야 합니다.");

const reviewWorkspace = engine.analyze(reviewOrders, parseInventory(["P-ERR", "P-OK"]), {
  sourceFingerprint: "4".repeat(64),
});
const review = engine.getOrderReviewState(reviewWorkspace);
assert.deepEqual(
  [review.hasDuplicateOrders, review.duplicateOrderCount, review.hasQuantityErrors, review.quantityErrorCount],
  [true, 1, true, 2],
);
assert.equal(reviewWorkspace.stats.totalOrderQuantity, -1.25,
  "수량 오류 행은 합계와 배정 계산에서 제외해야 합니다.");
assert.equal(reviewWorkspace.allocations[0].calculationQuantity, 0);
assert.equal(reviewWorkspace.allocations[0].quantityInputValid, false);

const inventoryRows = new Map(
  engine.getInventoryViewRows(reviewWorkspace).rows.map((row) => [row.productCode, row]),
);
assert.deepEqual(
  inventoryRows.get("P-ERR").systemMessages.map((message) => message.message),
  [engine.DUPLICATE_ORDER_REVIEW_MESSAGE, engine.QUANTITY_INPUT_REVIEW_MESSAGE],
  "동시 미해결 항목은 중복 확인 후 수량 오류 순서로만 표시해야 합니다.",
);
assert.equal(inventoryRows.get("P-ERR").systemMessage, "주문서 중복 여부 확인\n수량 입력 오류 확인");
assert.deepEqual(inventoryRows.get("P-OK").systemMessages, []);

reviewWorkspace.substitutionHistory.events.push({
  eventId: "substitution-history-kept",
  kind: "SUBSTITUTED",
  productCode: "P-ERR",
});
reviewWorkspace.systemHistory.events.push({
  eventId: "system-history-kept",
  kind: "CELL_EDITED",
  productCode: "P-ERR",
  message: "[정보수정] 수량",
});
const serializedWorkspace = JSON.parse(JSON.stringify(reviewWorkspace));
assert.deepEqual(serializedWorkspace.orders.slice(0, 2).map((row) => row.quantity), ["", "not-a-number"],
  "수량 오류 원문은 로컬·Cloud 직렬화 가능한 형태로 보존해야 합니다.");
assert.equal(serializedWorkspace.substitutionHistory.events.length, 1);
assert.equal(serializedWorkspace.systemHistory.events.length, 1);
assert.deepEqual(
  engine.getInventoryViewRows(serializedWorkspace).rows.find((row) => row.productCode === "P-ERR")
    .systemMessages.map((message) => message.message),
  ["주문서 중복 여부 확인", "수량 입력 오류 확인"],
  "업무 이력을 보존해도 시스템 메시지에는 미해결 검토 상태만 표시해야 합니다.",
);

assert.throws(
  () => workbookTools.buildWorkbook(reviewWorkspace),
  (error) => error?.code === "ORDER_QUANTITY_REVIEW_REQUIRED" && /2행/.test(error.message),
  "미해결 수량 오류가 있으면 라이브러리 호출 경로에서도 Excel 생성을 차단해야 합니다.",
);

const firstInvalidRow = reviewWorkspace.orders[0].sourceRowNumber;
const secondInvalidRow = reviewWorkspace.orders[1].sourceRowNumber;
engine.setOrderValue(reviewWorkspace, firstInvalidRow, "quantity", 3, {
  actor: "검증작업자",
  occurredAt: "2026-09-10T01:00:00.000Z",
});
assert.equal(engine.getOrderReviewState(reviewWorkspace).quantityErrorCount, 1);
engine.setOrderValue(reviewWorkspace, secondInvalidRow, "quantity", "4", {
  actor: "검증작업자",
  occurredAt: "2026-09-10T01:01:00.000Z",
});
const correctedReview = engine.getOrderReviewState(reviewWorkspace);
assert.equal(correctedReview.hasQuantityErrors, false, "유효 수량 수정 즉시 오류 상태를 해제해야 합니다.");
assert.equal(correctedReview.hasDuplicateOrders, true, "수량 수정은 별개의 중복 검토 상태를 지우면 안 됩니다.");
assert.equal(reviewWorkspace.stats.totalOrderQuantity, 5.75, "수량 수정 즉시 합계를 재계산해야 합니다.");
assert.deepEqual(
  engine.getInventoryViewRows(reviewWorkspace).rows.find((row) => row.productCode === "P-ERR")
    .systemMessages.map((message) => message.message),
  ["주문서 중복 여부 확인"],
);
assert.doesNotThrow(() => workbookTools.assertExcelOutputAllowed(reviewWorkspace),
  "중복 검토만 남은 경우 저장·Excel 출력을 차단하면 안 됩니다.");
assert.ok(reviewWorkspace.substitutionHistory.events.some((event) => event.eventId === "substitution-history-kept"));
assert.ok(reviewWorkspace.systemHistory.events.some((event) => event.eventId === "system-history-kept"));

for (const invalidQuantity of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
  const parsed = parseOrders([{ productCode: "P-NONFINITE", quantity: invalidQuantity }]);
  assert.equal(parsed.rows[0].quantity, String(invalidQuantity),
    "비유한 수량 원문은 JSON에서 소실되지 않는 문자열로 보존해야 합니다.");
  assert.equal(engine.getOrderReviewState(parsed).hasQuantityErrors, true);
}

for (const relativePath of ["orderops/list.html", "orderops_list.html"]) {
  const html = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  assert.ok(html.includes("elements.printButton.disabled = false;"),
    `${relativePath}: 수량 오류 상태에서도 인쇄는 허용해야 합니다.`);
  assert.ok(html.includes("elements.downloadButton.disabled = orderReview.hasQuantityErrors;"),
    `${relativePath}: 수량 오류 상태에서 Excel 버튼을 차단해야 합니다.`);
  assert.ok(html.includes("const cloudSaveDisabled = orderReview.hasQuantityErrors ||"),
    `${relativePath}: 수량 오류 상태에서 Cloud 저장 버튼을 차단해야 합니다.`);
  const cloudEnvelopeSource = html.slice(
    html.indexOf("async function buildCloudEnvelope"),
    html.indexOf("async function refreshCloudResult"),
  );
  assert.match(cloudEnvelopeSource, /getCurrentOrderReview\(\)[\s\S]*hasQuantityErrors/,
    `${relativePath}: Cloud 저장 호출 경로도 실패 폐쇄형이어야 합니다.`);
  const messageRendererSource = html.slice(
    html.indexOf("function renderSystemMessageHistory"),
    html.indexOf("function isQuantityColumn"),
  );
  assert.doesNotMatch(messageRendererSource, /actor|occurredAt|이전 이력/,
    `${relativePath}: 시스템 메시지 열에 과거 이력 메타데이터를 표시하면 안 됩니다.`);
}

console.log("ORDER Q unresolved system-message review tests passed.");
