# ORDER IN / ORDER Q 구현 로드맵

- 문서 상태: 구현 전 상세계획
- 분석 기준 `origin/main`: `c236ca4708a3f76f5a7d14d92db7d5f87c1bb368`
- Master Architecture Spec: [ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md)
- 생산 코드 구현 여부: 미착수

## 1. 목표

기존 M1~M10의 주문원장·재고·출고·구매·판매·ERP·중앙권한 계약을 유지하면서 ORDER Q 앞단에 다음 ORDER IN 흐름을 단계적으로 추가한다.

```text
외부 원본
→ 추출 확인
→ 매칭 확인
→ 상품 식별이 결정된 전표
→ 기존 createOrder()
→ 기존 ORDER Q 운영
```

상품 식별 결정은 `Master 상품 확정` 또는 `관리자 확정 임시상품`이다. 임시상품은 사용자 검토가 완료됐지만 Master 연결은 없는 상태다.

## 2. Stage 의존성

```text
Stage 1  Intake DB v8·Identity·Cloud 계약
   ↓
Stage 2  실제 주문 Grid 공통 Editor 추출
   ↓
Stage 3  ORDER IN 단일전표 Vertical Slice
   ↓
Stage 4  1원문→N전표·분할·병합
   ↓
Stage 5  통합 Clipboard·OCR
   ↓
Stage 6  관리자 Mapping Feedback
   ↓
Stage 7  구조화 ORDER Q Import
   ↓
Stage 8  Collector Bootstrap 역할 정리
```

Stage는 선행 Stage가 병합되고 완료증거가 승인된 뒤에만 시작한다. Stage 1~8의 구현을 한 PR에 합치지 않는다.

## 3. Stage별 책임

### Stage 1 — Intake 기반·DB v8·Identity

- 목적: UI 없이 저장·중복·백업·Cloud 계약을 먼저 안전하게 만든다.
- 선행: Master Architecture Spec 승인.
- 데이터: 신규 Intake 5 Store, `sourceOccurrenceKey`, `sourceDocumentKey`, `reviewStatus`, `productIdentityStatus`.
- UI: 변경 없음.
- Cloud: ORDER payload와 sourceDocumentKey 중복조회만 확장.
- 유지: 기존 `MATCH_STATUS`, `rawInputs/parseResults` unique, 주문 transaction, M9/M10.
- 다음 Gate: v7→v8, legacy backfill, A/B 같은 occurrence 수렴, 동일문구 다른 occurrence 생성, 백업/복원 PASS.
- 중단: 기존 주문 변경·누락, Cloud 한쪽만 생성, 기존 M1~M10 회귀.

상세: [ORDER_IN_STAGE1_INTAKE_DB_CONTRACT_SPEC.md](./ORDER_IN_STAGE1_INTAKE_DB_CONTRACT_SPEC.md)

### Stage 2 — 실제 주문 Grid 공통화

- 목적: `input.html`의 실제 Grid를 동작 변경 없이 공통 Editor로 추출한다.
- 선행: Stage 1 병합.
- 데이터: 신규 저장계약 없음.
- UI: DOM·키보드·가격·열너비 동작 동일.
- Cloud: 변경 없음.
- 유지: `readItems()`, `readPayload()`, `save()`, Master 검색, 0/공란.
- 다음 Gate: 기존 수기입력 전/후 payload canonical 동일, Chromium 키보드 동선 PASS.
- 중단: 수기입력 필드·가격·focus·저장 결과 차이.

상세: [ORDER_IN_STAGE2_SHARED_ORDER_GRID_SPEC.md](./ORDER_IN_STAGE2_SHARED_ORDER_GRID_SPEC.md)

### Stage 3 — 단일전표 Vertical Slice

- 목적: 외부 텍스트 한 건을 실제 주문 한 건으로 저장하는 3단계 UX를 완성한다.
- 선행: Stage 1·2 병합.
- 데이터: IntakeSession/SourcePart/Document/Line/Event 사용.
- UI: 추출 확인→매칭 확인→주문 완성.
- Cloud: 최종 ORDER만 기존 흐름으로 중앙화; Intake Draft는 profile-local.
- 유지: Mapping 알고리즘과 productMappings 자동갱신은 아직 변경하지 않음.
- 다음 Gate: 단일 텍스트 주문, 임시상품, Master상품, 이전단계 Draft 보존 PASS.
- 중단: Parser 전용 Grid 생성, `[매칭 완료]`에서 productMappings 변경.

상세: [ORDER_IN_STAGE3_SINGLE_DOCUMENT_SPEC.md](./ORDER_IN_STAGE3_SINGLE_DOCUMENT_SPEC.md)

### Stage 4 — 다전표

- 목적: 그룹 주문방의 1원문→N거래처 전표를 안전하게 만든다.
- 선행: Stage 3 실사용 단일전표 PASS.
- 데이터: segmentation, deterministic split/merge identity, IntakeEvent.
- UI: 문제 전표 우선 Navigator, 거래처변경·분할·병합·행이동.
- Cloud: 전표별 sourceDocumentKey로 독립 주문 생성.
- 유지: 각 주문의 기존 createOrder transaction.
- 다음 Gate: N전표 독립 저장·중복·부분실패·A/B 수렴 PASS.
- 중단: 한 전표 실패가 다른 주문을 롤백하거나 같은 occurrence에서 중복 주문 생성.

상세: [ORDER_IN_STAGE4_MULTI_DOCUMENT_SPEC.md](./ORDER_IN_STAGE4_MULTI_DOCUMENT_SPEC.md)

### Stage 5 — Clipboard·OCR

- 목적: 텍스트·이미지·혼합 원본을 같은 IntakeSession에 보존한다.
- 선행: Stage 4 병합.
- 데이터: SourcePart `mimeType/binaryBase64/byteLength/contentHash/ocrText`.
- UI: paste·파일추가·원문순서·OCR 수정·용량표시.
- Cloud: 이미지 binary 미전송.
- 유지: 사용자의 명시적 Parser 실행 전 전표 생성 금지.
- 다음 Gate: 여러 이미지+텍스트, OCR 실패, backup round-trip, quota rollback PASS.
- 중단: OCR 완료만으로 Parser/주문 자동실행, 원이미지 덮어쓰기.

상세: [ORDER_IN_STAGE5_CLIPBOARD_OCR_SPEC.md](./ORDER_IN_STAGE5_CLIPBOARD_OCR_SPEC.md)

### Stage 6 — Mapping Feedback

- 목적: Stage 3~5에서 확정된 관리자 선택을 다음 주문 추천에 반영한다.
- 선행: Stage 5 병합과 실제 수정 사례 확보.
- 데이터: productMappings 최신결정, mappingEvents before/after, IntakeEvent decision.
- UI: 행별 `매핑저장` checkbox 제거, 매칭 완료 시 자동 feedback.
- Cloud: PRODUCT_MAPPING/MAPPING_EVENT 기존 SyncQueue 계약 유지.
- 유지: 임시상품은 productMappings에 기록하지 않음.
- 다음 Gate: 최신 관리자 수정이 useCount보다 우선, rollback·Collector evidence 회귀 PASS.
- 중단: 과거 빈도가 최신 명시적 수정을 이기거나 임시상품이 가짜 매핑 생성.

상세: [ORDER_IN_STAGE6_MAPPING_FEEDBACK_SPEC.md](./ORDER_IN_STAGE6_MAPPING_FEEDBACK_SPEC.md)

### Stage 7 — 구조화 ORDER Q Import

- 목적: 코드가 확정된 쇼핑몰·ERP·Excel·API 전표를 Parser 없이 다건 반영한다.
- 선행: Stage 6 병합.
- 데이터: external identity, sourceOccurrence/sourceDocument, Import 결과.
- UI: 정상·중복·상품코드 오류·거래처 오류·제외 Workbench.
- Cloud: 최종 주문별 기존 sync와 sourceDocumentKey 중복계약.
- 유지: fuzzy 자동확정 금지, 외부코드 미매핑은 ORDER IN 코드매핑으로 이동.
- 다음 Gate: 다건 부분성공·재시도·A/B·0/공란·외부 ID PASS.
- 중단: 코드 오류 자료 자동매칭, 한 전표 오류가 전체 성공건 취소.

상세: [ORDER_Q_STAGE7_STRUCTURED_IMPORT_SPEC.md](./ORDER_Q_STAGE7_STRUCTURED_IMPORT_SPEC.md)

### Stage 8 — Collector 정리

- 목적: 새 ORDER IN 실사용 후 Collector의 일상 입력 중복 UI만 제거·내부화한다.
- 선행: Stage 3~7 실사용 검증.
- 데이터: 변경하지 않음.
- UI: Bootstrap·Historical·기초재고·수집이력 중심으로 정리.
- Cloud: 기존 historical entity sync 유지.
- 유지: commit/rollback, fulfillment evidence, parser evidence, mapping lifecycle.
- 완료 Gate: 모든 Collector 회귀와 이전 수집자료 재개방 PASS.
- 중단: 과거자료·기초재고·롤백 의미 변경.

상세: [ORDER_IN_STAGE8_COLLECTOR_CLEANUP_SPEC.md](./ORDER_IN_STAGE8_COLLECTOR_CLEANUP_SPEC.md)

## 4. Stage 간 범위 배타성

| 기능 | 담당 Stage | 다른 Stage에서 금지 |
| --- | --- | --- |
| DB v8·identity·Cloud duplicate | 1 | 2~8에서 재설계 금지 |
| 실제 Grid 모듈화 | 2 | 1·3에서 복제 금지 |
| 단일전표 3단계 UX | 3 | 2에서 Parser 연결 금지 |
| 자동 segmentation·split/merge | 4 | 1·3에서 구현 금지 |
| Clipboard·OCR | 5 | 3·4에서 photo UI 확대 금지 |
| 매핑 자동학습·우선순위 | 6 | 3에서 productMappings 쓰기 금지 |
| 구조화 다건 Import | 7 | 3·4 Parser에 혼합 금지 |
| Collector UI 축소 | 8 | 새 ORDER IN 검증 전 변경 금지 |

## 5. 전 Stage 불변조건

- M1~M10 원장·InventoryMovement·Dispatch·Purchase·ERP·Central Authority를 변경하지 않는다.
- 확정자료는 append-only 취소·정정으로만 변경한다.
- `productId=null`, `itemCode=''`, 관리자 품명은 유효한 임시상품 판단이다.
- core `MATCH_STATUS` enum과 기존 matchingStatus 계산을 변경하지 않는다.
- 원본·추출값·추천값·관리자 확정값을 서로 덮어쓰지 않는다.
- 숫자 0, 문자열 `0`, 공란, 음수를 구분한다.
- Parser 전용 Grid를 만들지 않는다.
- Collector를 운영 주문입력기로 확대하지 않는다.
- `QUOTE/PURCHASE/SALE` Adapter는 interface만 예약하고 구현하지 않는다.

## 6. 테스트 Matrix

표시: `N` 신규검증, `R` 회귀검증, `-` 비대상.

| 테스트 축 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 수기입력 | R | N | R | R | R | R | R | R |
| ORDER IN 단일 | 계약 | - | N | R | R | R | R | R |
| ORDER IN 다전표 | 계약 | - | - | N | R | R | R | R |
| 임시상품 | N | R | N | R | R | R | R | R |
| Master상품 | R | N | N | R | R | R | R | R |
| 동일내용 반복주문 | N | - | N | R | R | R | R | R |
| 동일 occurrence 중복 | N | - | N | N | R | R | N | R |
| A/B | N | - | R | N | R | R | N | R |
| Cloud | N | R | R | N | R | N | N | R |
| backup/restore | N | R | R | R | N | R | R | R |
| OCR | - | - | - | - | N | R | R | R |
| Mapping | R | R | R | R | R | N | R | R |
| 구조화 Import | 계약 | - | - | - | - | - | N | R |
| Collector | R | R | R | R | R | R | R | N |
| Dispatch | R | R | R | R | R | R | R | R |
| Purchase | R | R | R | R | R | R | R | R |
| Inventory | R | R | R | R | R | R | R | R |
| ERP | R | R | R | R | R | R | R | R |

## 7. 공통 회귀 명령

각 Stage는 자기 신규 테스트 외에 다음 실제 테스트를 실행한다.

```text
scripts/test-orderq-vnext-cloud-contract.mjs
scripts/test-orderq-order-workflow.mjs
scripts/test-orderq-fulfillment-lifecycle.mjs
scripts/test-orderq-manual-master-search.mjs
scripts/test-orderq-smartparser.mjs
scripts/test-orderq-history-collector.mjs
scripts/test-orderq-collector-contracts.mjs
scripts/test-orderq-cloud-atomicity.mjs
scripts/test-orderq-m1-foundation.mjs
scripts/test-orderq-m2-inventory-ledger.mjs
scripts/test-orderq-m3-dispatch-workbench.mjs
scripts/test-orderq-m4-dispatch-confirmation.mjs
scripts/test-orderq-m5-substitution-conversion.mjs
scripts/test-orderq-m6-purchase-decision.mjs
scripts/test-orderq-m7-common-products.mjs
scripts/test-orderq-m8-post-dispatch-reconciliation.mjs
scripts/test-orderq-m9-central-sync-erp.mjs
scripts/test-orderq-m10-operational-transition.mjs
scripts/test-orderq-m10-admin-test.mjs
scripts/test-orderq-user-flow.mjs
scripts/test-client-safety.mjs
scripts/validate-repository.mjs
```

브라우저 변경 Stage는 해당 Stage 전용 Chromium 테스트와 영향받는 M1~M10 브라우저 테스트를 추가 실행한다.

## 8. 공통 완료보고

각 PR 완료후보는 다음을 제출한다.

- 기준 main SHA, branch, HEAD, merge-base, tree, clean worktree
- 정확한 diff 파일·줄수
- 신규 테스트와 전체 회귀 결과
- 실제 Chromium DB명·화면·console 결과
- v8 Store/index/count와 canonical digest
- A/B sourceOccurrence/sourceDocument/cursor 수렴
- Cloud duplicate/conflict와 중앙 row/sequence 무증가
- backup/restore canonical 동일
- 범위 밖 발견과 미구현 다음 Stage 기능

## 9. 결정 필요사항

현재 상위 명세와 최신 소스 사이에 개발을 막는 미결정 충돌은 없다.

다만 구현 시 다음은 Stage 내부에서 임의 확대하지 않는다.

1. 일반 붙여넣기의 `captureOccurrenceId`는 사용자가 `[새 입력]`을 시작할 때 발급한다. 서로 다른 PC의 독립 paste를 같은 발생건으로 자동 추정하지 않는다.
2. Intake Draft의 다중 PC 동기화는 1차 범위가 아니다. 최종 ORDER만 중앙화한다.
3. 이미지 원본의 중앙 Object Storage는 범위 밖이다.
4. 임시상품을 실제 재고상품으로 연결하는 업무는 기존 PRODUCT_REVIEW/M7 경계를 사용한다.

정책 변경이 필요하면 해당 Stage의 `결정 필요사항`으로 사용자 확인 후 별도 명세 개정을 한다.
