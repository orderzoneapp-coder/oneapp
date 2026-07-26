#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const source = fs.readFileSync(path.join(ROOT, "masterAddUpdate.js"), "utf8");
const browser = { crypto: { randomUUID: () => crypto.randomUUID() } };
const context = vm.createContext({ window: browser, console, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean });
vm.runInContext(source, context, { filename: "masterAddUpdate.js" });
const api = browser.ONEAPP_MASTER_ADD_UPDATE;

assert.ok(api, "Master add/update module must initialize");

const clone = (value) => structuredClone(value);
const baseMaster = {
  "001": { 코드: "001", 품목코드: "001", 품목명: "사과", 규격: "1kg", 단위: "EA", 시중가: 1000, 유지필드: "보존" },
  "002": { 코드: "002", 품목코드: "002", 품목명: "배", 규격: "2kg", 단위: "BOX", 시중가: 2000, 유지필드: "누락 유지" }
};

const makeRow = (rowNumber, code, values = {}, codeField = "품목코드") => ({
  __rowNumber: rowNumber,
  __display: { [codeField]: code, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value])) },
  [codeField]: code,
  ...values
});

const analyze = ({ rows, headers, master = baseMaster, revision = "rev-1", masterMismatch = false, fileName = "master.xlsx" }) => (
  api.analyzeUploadRows({ rows, headers, currentMaster: master, revision, masterMismatch, fileName })
);

const findCode = (analysis, code) => analysis.candidates.find(candidate => candidate.code === code && candidate.status !== "missing");
const hasTag = (candidate, tag) => candidate.issueTags.includes(tag);

const approveProduct = (analysis, code, { excludeField } = {}) => {
  const candidate = findCode(analysis, code);
  let next = analysis;
  if (excludeField) {
    next = api.setFieldDecision(next, candidate.id, excludeField, { excluded: true });
  }
  next = api.setProductApproved(next, candidate.id, true);
  next = api.setAdminComplete(next, candidate.id, true);
  return next;
};

const approveField = (analysis, code, field) => {
  const candidate = findCode(analysis, code);
  let next = api.setFieldDecision(analysis, candidate.id, field, { approved: true, excluded: false });
  next = api.setAdminComplete(next, candidate.id, true);
  return next;
};

class MemoryLocalStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

function createStorage(initialMaster, localStorageRef, options = {}) {
  let state = { masterMap: clone(initialMaster), revision: options.revision || "rev-1" };
  let revisionCounter = 1;
  let historyWriteAttempts = 0;
  return {
    get state() {
      return clone(state);
    },
    stableSerialize: api.stableSerialize,
    async readMasterSnapshotState() {
      return clone(state);
    },
    writeLocalJSON(key, value) {
      historyWriteAttempts++;
      if (options.failHistoryAfterConcurrent && historyWriteAttempts === 1) {
        localStorageRef.setItem(key, JSON.stringify([...value, { id: "concurrent-history" }]));
        throw new Error("forced history failure after concurrent write");
      }
      if (options.failHistoryOnce && historyWriteAttempts === 1) {
        throw new Error("forced history failure");
      }
      localStorageRef.setItem(key, JSON.stringify(value));
    },
    restoreLocalValue(key, raw) {
      if (raw === null) localStorageRef.removeItem(key);
      else localStorageRef.setItem(key, raw);
    },
    async commitMasterStateOrThrow(nextMaster, commitOptions) {
      if (state.revision !== commitOptions.expectedRevision) {
        const error = new Error("forced revision conflict");
        error.code = "MERCH_MASTER_REVISION_CONFLICT";
        throw error;
      }
      if (options.failMaster) {
        const error = new Error("forced master failure");
        error.code = "MERCH_MASTER_COMMIT_FAILURE";
        throw error;
      }
      const previous = clone(state);
      const revision = `rev-${++revisionCounter}`;
      state = { masterMap: clone(nextMaster), revision };
      if (options.mutateAfterWrite) options.mutateAfterWrite(state.masterMap);
      try {
        if (commitOptions.afterVerified) await commitOptions.afterVerified();
      } catch (cause) {
        state = previous;
        const error = new Error(cause.message);
        error.code = "MERCH_MASTER_COMMIT_FAILURE";
        error.result = { revision, rollbackOk: true };
        throw error;
      }
      return { ok: true, verified: true, revision };
    }
  };
}

const scenarios = [];
const scenario = async (name, fn) => {
  await fn();
  scenarios.push(name);
};

await scenario("1. 신규 상품", () => {
  const formattedCodeRow = {
    __rowNumber: 2,
    __display: { 품목코드: "003", 품목명: "감", 규격: "1kg", 단위: "BOX" },
    품목코드: 3,
    품목명: "감",
    규격: "1kg",
    단위: "BOX"
  };
  const review = analyze({
    headers: ["품목코드", "품목명", "규격", "단위"],
    rows: [formattedCodeRow]
  });
  const candidate = findCode(review, "003");
  assert.equal(candidate.status, "new");
  assert.ok(hasTag(candidate, api.ISSUE_TAGS.NEW));
  assert.equal(review.summary.newCount, 1);
});

await scenario("2. 기존 상품 단일 필드 변경", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  });
  const candidate = findCode(review, "001");
  assert.equal(candidate.status, "changed");
  assert.equal(Object.values(candidate.fields).filter(field => field.changed).length, 1);
});

await scenario("3. 기존 상품 복수 필드 변경", () => {
  const review = analyze({
    headers: ["품목코드", "규격", "단위"],
    rows: [makeRow(2, "001", { 규격: "2kg", 단위: "BOX" })]
  });
  const candidate = findCode(review, "001");
  assert.equal(Object.values(candidate.fields).filter(field => field.changed).length, 2);
  assert.equal(
    api.filterCandidates(review, [api.ISSUE_TAGS.CHANGED, api.ISSUE_TAGS.SPEC_CHANGED]).filter(item => item.code === "001").length,
    1
  );
});

await scenario("4. 동일 상품", () => {
  const review = analyze({
    headers: ["품목코드", "품목명", "규격", "단위"],
    rows: [makeRow(2, "001", { 품목명: "사과", 규격: "1kg", 단위: "EA" })]
  });
  assert.equal(findCode(review, "001").status, "same");
  assert.equal(api.filterCandidates(review).some(candidate => candidate.code === "001"), false);
});

await scenario("5. 누락 상품", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "사과" })]
  });
  const missing = review.candidates.find(candidate => candidate.code === "002" && candidate.status === "missing");
  assert.ok(missing);
  assert.ok(hasTag(missing, api.ISSUE_TAGS.MISSING));
});

await scenario("6. 품명 불일치", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "풋사과" })]
  });
  assert.ok(hasTag(findCode(review, "001"), api.ISSUE_TAGS.NAME));
  assert.equal(review.summary.nameMismatchCount, 1);
});

await scenario("7. 규격 변경", () => {
  const review = analyze({
    headers: ["품목코드", "규격"],
    rows: [makeRow(2, "001", { 규격: "3kg" })]
  });
  assert.ok(hasTag(findCode(review, "001"), api.ISSUE_TAGS.SPEC_CHANGED));
});

await scenario("8. 규격 누락", () => {
  const review = analyze({
    headers: ["품목코드", "규격"],
    rows: [makeRow(2, "001", { 규격: "" })]
  });
  assert.ok(hasTag(findCode(review, "001"), api.ISSUE_TAGS.SPEC_MISSING));
});

await scenario("9. 단위 변경", () => {
  const review = analyze({
    headers: ["품목코드", "단위"],
    rows: [makeRow(2, "001", { 단위: "BOX" })]
  });
  assert.ok(hasTag(findCode(review, "001"), api.ISSUE_TAGS.UNIT_CHANGED));
});

await scenario("10. 단위 누락", () => {
  const review = analyze({
    headers: ["품목코드", "단위"],
    rows: [makeRow(2, "001", { 단위: "" })]
  });
  assert.ok(hasTag(findCode(review, "001"), api.ISSUE_TAGS.UNIT_MISSING));
});

await scenario("11. 동일 중복코드", () => {
  let review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [
      makeRow(2, "001", { 품목명: "청사과" }),
      makeRow(3, "001", { 품목명: "청사과" })
    ]
  });
  let candidate = findCode(review, "001");
  assert.ok(hasTag(candidate, api.ISSUE_TAGS.DUPLICATE_SAME));
  assert.ok(candidate.blockingReasons.includes("duplicate_unresolved"));
  review = api.resolveDuplicate(review, candidate.id, 3);
  candidate = findCode(review, "001");
  assert.equal(candidate.selectedDuplicateRowNumber, 3);
  assert.equal(candidate.blockingReasons.length, 0);
});

await scenario("12. 상이 중복코드", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [
      makeRow(2, "001", { 품목명: "청사과" }),
      makeRow(3, "001", { 품목명: "홍사과" })
    ]
  });
  const candidate = findCode(review, "001");
  assert.ok(hasTag(candidate, api.ISSUE_TAGS.DUPLICATE_DIFFERENT));
  assert.ok(hasTag(candidate, api.ISSUE_TAGS.BLOCKING));
  assert.equal(candidate.duplicateRows.length, 2);
});

await scenario("추가. 공란 상품코드 저장 차단", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "", { 품목명: "코드없음" })]
  });
  const candidate = review.candidates.find(item => item.status === "blocked");
  assert.ok(candidate);
  assert.ok(candidate.blockingReasons.includes("blank_code"));
  assert.equal(review.summary.newCount, 0);
  assert.equal(review.summary.requiredMissingCount, 1);
  assert.equal(review.summary.blockingCount, 1);
});

await scenario("13. 업로드 공란", () => {
  const review = analyze({
    headers: ["품목코드", "규격"],
    rows: [makeRow(2, "001", { 규격: "" })]
  });
  const field = findCode(review, "001").fields.규격;
  assert.equal(field.uploadRaw, "");
  assert.ok(field.issueTags.includes(api.ISSUE_TAGS.BLANK));
});

await scenario("14. 업로드 숫자 0", () => {
  const review = analyze({
    headers: ["품목코드", "시중가"],
    rows: [makeRow(2, "001", { 시중가: 0 })]
  });
  const field = findCode(review, "001").fields.시중가;
  assert.equal(field.uploadRaw, 0);
  assert.ok(field.issueTags.includes(api.ISSUE_TAGS.ZERO));
  assert.equal(field.issueTags.includes(api.ISSUE_TAGS.BLANK), false);
});

await scenario("15. 업로드에 없는 필드", () => {
  const review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  });
  const candidate = findCode(review, "001");
  assert.equal(Object.prototype.hasOwnProperty.call(candidate.fields, "규격"), false);
  const plan = api.buildExecutionPlan(approveProduct(review, "001"), baseMaster);
  assert.equal(plan.nextMaster["001"].규격, "1kg");
});

await scenario("16. 상품 전체 승인 후 필드 제외", () => {
  const review = analyze({
    headers: ["품목코드", "품목명", "규격"],
    rows: [makeRow(2, "001", { 품목명: "청사과", 규격: "5kg" })]
  });
  const approved = approveProduct(review, "001", { excludeField: "규격" });
  const plan = api.buildExecutionPlan(approved, baseMaster);
  assert.equal(plan.nextMaster["001"].품목명, "청사과");
  assert.equal(plan.nextMaster["001"].규격, "1kg");
});

await scenario("17. 상품 전체 제외", () => {
  let review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  });
  const candidate = findCode(review, "001");
  review = api.setProductExcluded(review, candidate.id, true);
  review = api.setAdminComplete(review, candidate.id, true);
  const plan = api.buildExecutionPlan(review, baseMaster);
  assert.equal(plan.counts.savedProductCount, 0);
  assert.equal(plan.nextMaster["001"].품목명, "사과");
});

await scenario("18. 일부 상품만 승인 후 부분 저장", () => {
  let review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [
      makeRow(2, "001", { 품목명: "청사과" }),
      makeRow(3, "002", { 품목명: "황금배" })
    ]
  });
  review = approveField(review, "001", "품목명");
  const plan = api.buildExecutionPlan(review, baseMaster);
  assert.equal(plan.counts.updateCount, 1);
  assert.equal(plan.nextMaster["001"].품목명, "청사과");
  assert.equal(plan.nextMaster["002"].품목명, "배");
});

await scenario("19. master revision 충돌", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const local = new MemoryLocalStorage();
  const storage = createStorage(baseMaster, local, { revision: "rev-2" });
  await assert.rejects(
    api.commitApprovedChanges({
      analysis: review,
      currentMaster: baseMaster,
      expectedRevision: "rev-1",
      storage,
      localStorageRef: local
    }),
    error => error.code === "MERCH_MASTER_REVISION_CONFLICT"
  );
  assert.equal(storage.state.masterMap["001"].품목명, "사과");
});

await scenario("20. master 저장 실패", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const local = new MemoryLocalStorage({ [api.HISTORY_KEY]: JSON.stringify([{ id: "before" }]) });
  const storage = createStorage(baseMaster, local, { failMaster: true });
  await assert.rejects(api.commitApprovedChanges({
    analysis: review, currentMaster: baseMaster, expectedRevision: "rev-1", storage, localStorageRef: local
  }), /forced master failure/);
  assert.equal(storage.state.masterMap["001"].품목명, "사과");
  assert.equal(JSON.parse(local.getItem(api.HISTORY_KEY))[0].id, "before");
});

await scenario("21. history 저장 실패", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const beforeHistory = JSON.stringify([{ id: "before" }]);
  const local = new MemoryLocalStorage({ [api.HISTORY_KEY]: beforeHistory });
  const storage = createStorage(baseMaster, local, { failHistoryOnce: true });
  await assert.rejects(api.commitApprovedChanges({
    analysis: review, currentMaster: baseMaster, expectedRevision: "rev-1", storage, localStorageRef: local
  }), /forced history failure/);
  assert.equal(storage.state.masterMap["001"].품목명, "사과");
  assert.equal(local.getItem(api.HISTORY_KEY), beforeHistory);
});

await scenario("22. 저장 후 값 불일치", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const local = new MemoryLocalStorage();
  const storage = createStorage(baseMaster, local, {
    mutateAfterWrite: master => { master["001"].품목명 = "불일치"; }
  });
  await assert.rejects(api.commitApprovedChanges({
    analysis: review, currentMaster: baseMaster, expectedRevision: "rev-1", storage, localStorageRef: local
  }), /일치하지 않습니다/);
  assert.equal(storage.state.masterMap["001"].품목명, "사과");
});

await scenario("23. rollback 검증", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const beforeHistory = JSON.stringify([{ id: "stable-history" }]);
  const local = new MemoryLocalStorage({ [api.HISTORY_KEY]: beforeHistory });
  const storage = createStorage(baseMaster, local, { failHistoryOnce: true });
  await assert.rejects(api.commitApprovedChanges({
    analysis: review, currentMaster: baseMaster, expectedRevision: "rev-1", storage, localStorageRef: local
  }));
  assert.equal(api.stableSerialize(storage.state.masterMap), api.stableSerialize(baseMaster));
  assert.equal(local.getItem(api.HISTORY_KEY), beforeHistory);
});

await scenario("추가. rollback 중 다른 history 보호", async () => {
  const review = approveProduct(analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  }), "001");
  const local = new MemoryLocalStorage({ [api.HISTORY_KEY]: JSON.stringify([{ id: "before" }]) });
  const storage = createStorage(baseMaster, local, { failHistoryAfterConcurrent: true });
  await assert.rejects(api.commitApprovedChanges({
    analysis: review, currentMaster: baseMaster, expectedRevision: "rev-1", storage, localStorageRef: local
  }), /concurrent write/);
  const remainingIds = JSON.parse(local.getItem(api.HISTORY_KEY)).map(log => log.id);
  assert.ok(remainingIds.includes("before"));
  assert.ok(remainingIds.includes("concurrent-history"));
  assert.equal(remainingIds.some(id => id.includes("-job") || id.includes("-detail-")), false);
  assert.equal(api.stableSerialize(storage.state.masterMap), api.stableSerialize(baseMaster));
});

await scenario("24. 누락 상품 유지 검증", async () => {
  let review = analyze({
    headers: ["품목코드", "품목명"],
    rows: [makeRow(2, "001", { 품목명: "청사과" })]
  });
  review = approveProduct(review, "001");
  const local = new MemoryLocalStorage();
  const storage = createStorage(baseMaster, local);
  const result = await api.commitApprovedChanges({
    analysis: review,
    currentMaster: baseMaster,
    expectedRevision: "rev-1",
    storage,
    localStorageRef: local,
    historyApi: { normalizeHistoryLog: log => ({ ...log, normalized: true }) },
    actor: null
  });
  assert.equal(result.masterMap["002"].품목명, "배");
  assert.equal(result.counts.missingRetainedCount, 1);
  const logs = JSON.parse(local.getItem(api.HISTORY_KEY));
  assert.ok(logs.some(log => log.recordType === "master_add_update_job" && log.executionId === result.executionId));
  const detail = logs.find(log => log.recordType === "master_add_update_detail" && log.finalValue === "청사과");
  assert.ok(detail);
  assert.equal(detail.uploadRaw, "청사과");
  assert.equal(detail.uploadOriginalValue, "청사과");
  assert.equal(detail.oldMasterValue, "사과");
  assert.equal(detail.adminValue, null);
  assert.equal(detail.approvalStatus, "상품 승인");
  assert.equal(detail.executionId, result.executionId);
  assert.equal(logs[0].actor, null);
});

await scenario("25. MerchOps F7 회귀검사", () => {
  const merchOps = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
  assert.match(merchOps, /afterVerifiedError:\s*'F7 히스토리 저장 실패'/);
  assert.match(merchOps, /setMasterProducts\(newMaster,\s*\{/);
  assert.match(merchOps, /expectedRevision/);
});

await scenario("26. SmartParser 반영 경로 회귀검사", () => {
  const smartParser = fs.readFileSync(path.join(ROOT, "SmartParser.html"), "utf8");
  assert.match(smartParser, /commitSmartParserMaster/);
  assert.match(smartParser, /commitMasterStateOrThrow\(data,\s*\{/);
  assert.match(smartParser, /afterVerifiedError:\s*'SmartParser 히스토리 저장 실패'/);
});

const masterHtml = fs.readFileSync(path.join(ROOT, "Master.html"), "utf8");
assert.match(masterHtml, /masterAddUpdate\.js/);
assert.match(masterHtml, /ONEAPP_MASTER_ADD_UPDATE\.analyzeUploadRows/);
assert.match(masterHtml, /ONEAPP_MASTER_ADD_UPDATE\.commitApprovedChanges/);
assert.doesNotMatch(masterHtml, /const newMaster = \{\};[\s\S]{0,1500}saveMasterLocal\(newMaster\)/);
assert.match(masterHtml, /기존 master가 0건입니다[\s\S]*최초 등록은 차단/);

console.log(`Master add/update tests passed (${scenarios.length} required scenarios).`);
