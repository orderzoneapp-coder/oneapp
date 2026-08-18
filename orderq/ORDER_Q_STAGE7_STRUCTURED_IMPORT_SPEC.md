# ORDER Q Stage 7 — 구조화 주문 Import 개발명세

기준: Stage 1~6 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

상품·거래처 식별코드와 주문 구조가 이미 확정된 Excel/쇼핑몰/API 자료를 Parser 없이 ORDER Q로 직접 검수·등록한다. 코드가 미해결이면 ORDER IN으로 넘긴다.

## B. 선행조건

- Intake identity·final ORDER provenance·Mapping 계약 승인
- 지원할 첫 structured format의 실제 header/ID/중복 사례 승인
- 외부 시스템의 transaction/line ID 안정성 확인

## C. 허용범위

- `documentType=ORDER` structured file/JSON 분석
- 거래처코드·상품코드 exact validation
- 주문별 묶음·요약·샘플·오류행 검수
- 결정형 source occurrence/document/line identity
- existing `createOrder()`를 통한 document별 등록
- 미해결 code 행의 ORDER IN 전달 package 생성

## D. 금지범위

- 자연어 Parser/OCR 호출
- fuzzy 자동확정
- 구매·판매·견적 Import
- 현재재고·채권·채무 반영
- ERP POSTED 처리
- 외부 API 실시간 자동수집·scheduler
- 미해결 행을 임시상품으로 자동확정

## E. 실제 소스 분석

- 현 `INPUT_CHANNEL`은 `DIRECT/ORDER_IN/EXCEL/SHOPPING_MALL/EXTERNAL`을 이미 지원한다.
- `createOrder()`는 확정 payload의 원자 저장·Cloud queue 경계를 제공한다.
- `product-master-search.js`는 Master/ORDER Q product catalog를 읽을 수 있다.
- Stage 6 `productMappings`의 `mappingKind=EXTERNAL_CODE`를 source-specific code alias로 사용할 수 있다.
- 전용 structured import workbench·batch 검수 화면은 현재 없다.

## F. Before → After

| Before | After |
|---|---|
| 구조화 자료도 Parser/수동입력 우회 | schema→code validation→ORDER Q 직접등록 |
| 오류행과 정상행 경계 없음 | 문서별 READY/BLOCKED와 상세 reason |
| 외부 전표 중복계약 약함 | origin transaction/line ID 우선 identity |
| code 미해결 처리 불명확 | ORDER IN 전달 package 또는 관리자 중단 |

## G. 데이터 계약

`StructuredOrderImportBatch`는 IntakeSession의 `sourceMode=STRUCTURED` 표현을 사용하며 신규 Store를 만들지 않는다.

필수 canonical row:

- source: `sourceSystem`, `sourceFileName`, `importBatchId`, `originTransactionId`, `originLineId`
- order: order date, customer external/code ID, order memo
- line: product external/code ID, quantity, unit, unit price(optional), line memo
- evidence: raw row number는 표시용이며 fingerprint identity에 쓰지 않는다.

identity 우선순위:

1. source system + origin transaction ID → document key
2. source system + origin transaction ID + origin line ID → line key
3. 외부 ID가 없으면 승인된 schema의 결정형 canonical row group fingerprint

`0`, `'0'`, 공란을 보존한다. 같은 external identity의 다른 content는 conflict다.

## H. 함수·API 상세

신규 `orderq/structured-order-import.js`:

- `detectStructuredOrderFormat(input)`
- `parseStructuredOrderRows({formatId, rows})`
- `groupStructuredRowsIntoDocuments(rows)`
- `validateStructuredOrderCodes({documents, customerCatalog, productCatalog, mappings})`
- `buildStructuredOrderPayload(document)`
- `buildOrderInHandoff(blockedRows)`

신규 `orderq/structured-order-import-repository.js`:

- `prepareStructuredOrderImport(command)` — IntakeSession/Documents/Lines 생성
- `commitStructuredOrderDocuments(command)` — document별 idempotency
- `getStructuredImportSummary(sessionId)`

Parser modules를 import하면 계약 위반이다. code validation은 exact Master 또는 승인된 `EXTERNAL_CODE` mapping만 허용한다.

## I. 파일별 변경명세

신규:

- `orderq/import.html`
- `orderq/structured-order-import.js`
- `orderq/structured-order-import-repository.js`
- `orderq/structured-order-import-ui.js`
- `orderq/structured-order-import.css`
- `scripts/test-orderq-stage7-structured-import.mjs`
- `scripts/test-orderq-stage7-browser.html`

수정:

- `orderq/index.html`, `orderq/operations.html` — 구조화 주문 가져오기 진입
- `orderq/order-document-model.js` — structured provenance allowlist
- `orderq/order-intake-engine.js` — 기존 final ORDER command 재사용만
- `orderq/intake-document-adapter.js` — ORDER structured adapter 선택
- workflow — Stage 7 테스트

## J. UI 계약

사용자가 화면을 여는 이유는 `코드가 있는 주문파일을 ORDER Q에 등록`하기 위해서다. 첫 행동은 `[파일 선택]`. 분석 후 `자료유형/기간/주문수/행수/정상/확인필요/중복`을 보여주고 샘플 10행과 열→시스템 항목 mapping을 제공한다. Primary는 `[정상 주문 등록]`. code 미해결은 `ORDER IN에서 상품 확인` CTA를 제공하며 기술 status는 숨긴다.

## K. 상태전이

Intake stage는 `CAPTURED → EXTRACTION_REVIEW → MATCH_REVIEW → DOCUMENT_REVIEW → COMMITTED`를 그대로 사용한다. 화면의 format/code 검증은 stage 안의 derived check이며 신규 core 상태를 만들지 않는다. 오류 문서는 `NEEDS_REVIEW`, 제외는 `EXCLUDED`, 동일 사실은 결과 분류 `DUPLICATE`다. 정상 document commit은 실패 document와 격리한다.

## L. 오류·충돌·롤백

- format/header 불일치: 파일 전체 저장 전 오류
- 필수 외부 ID 중복: 문서/행 conflict
- unknown customer/product code: 해당 document BLOCKED, 자동 임시품 금지
- 같은 identity·same content: duplicate 무증가
- 같은 identity·different content: content conflict
- document commit 실패: 해당 ORDER/ITEM/EVENT/Queue 부분행 0
- 일부 성공 후 전체 재시도: 성공은 duplicate, 실패만 재실행 가능

## M. Given / When / Then 계약 테스트

1. Given 정확 code Excel, When 분석/등록, Then Parser 호출 0, ORDER N 생성.
2. Given 숫자 0/문자열 0 external IDs, Then `'0'` canonical 유지, 공란과 구분.
3. Given unknown product, Then BLOCKED와 ORDER IN handoff, ORDER 0.
4. Given same file retry, Then document/order/queue 무증가.
5. Given reordered rows with stable line IDs, Then same identity/duplicate.
6. Given same transaction ID different quantity, Then conflict.
7. Given two orders one invalid, Then valid 1 commit/invalid 1 blocked.
8. Given approved EXTERNAL_CODE mapping, Then exact target와 evidence 보존.
9. Given natural language-only row, Then Parser로 몰래 처리하지 않고 unsupported/handoff.
10. Given commit failure injection, Then target document transaction rollback.

## N. 회귀 테스트

- `scripts/test-orderq-stage7-structured-import.mjs`
- Stage 1~6 테스트
- `scripts/test-orderq-order-workflow.mjs`
- `scripts/test-orderq-vnext-cloud-contract.mjs`
- `scripts/test-orderq-smartparser.mjs`(Parser 비회귀)
- `scripts/test-orderq-collector-contracts.mjs`
- client safety/repository validation/diff check
- 실제 Chromium xlsx/json/unknown code/duplicate/partial commit

## O. 완료증거

- 지원 format schema·열 mapping·샘플
- Parser import/call 0 증거
- external ID 0/공란/row reorder identity
- 정상/blocked/duplicate/conflict document 결과
- failure rollback DB digest
- ORDER IN handoff package와 final ORDER provenance

## P. 다음 Stage Gate

Stage 8은 구조화 자료가 Parser 없이 처리되고, 미해결은 ORDER IN으로 안전하게 넘기며, 현재 Collector의 운영입력 경로를 대체할 준비가 승인된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- 구조화 여부는 확장자가 아니라 필수 code/identity schema로 판단한다.
- 현재재고·채권·채무를 만들지 않는다.
- 외부 ID가 불안정하거나 정상 반복거래를 구분 못하면 그 format 지원을 중단하고 identity 규칙을 승인받는다.
- 외부 code mapping을 기존 Store에서 의미 충돌 없이 표현할 수 없는 경우 DB 변경을 별도 승인받는다.

## Codex 5.3 착수 명령

```text
[개발][ORDER Q][STAGE 7 STRUCTURED IMPORT] 승인 Stage 1~6 main에서 전용 branch/worktree를 만들고 ORDER_Q_STAGE7_STRUCTURED_IMPORT_SPEC.md와 상위 문서를 읽어라. 코드·구조가 확정된 ORDER Excel/JSON의 schema 검증, exact code mapping, 문서별 createOrder, duplicate/conflict, 미해결 ORDER IN handoff만 구현한다. 자연어 Parser/OCR/fuzzy 자동확정, 구매·판매 Import, 재고·채권·채무, ERP POSTED는 금지한다. Parser call 0, external identity, 0/공란, 부분성공, rollback 실제 증거로 검증 요청하고 승인 전 병합·Stage 8·배포를 보류하라.
```
