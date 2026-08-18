# ORDER IN Stage 3 — 단일전표 Vertical Slice 개발명세

기준: Stage 1·2 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

텍스트 원문 하나를 `추출 수정 → 매칭 수정 → 주문 완성` 3단계로 검토하여 ORDER Q 주문 하나로 확정하는 첫 실사용 Vertical Slice를 만든다.

## B. 선행조건

- DB v8 identity/provenance와 `OrderDraftEditor` 승인
- 현재 `smartparser/source-parser.js`, `smartparser/parser-orchestrator.js`, `smartparser/customer-resolver.js`, `smartparser/matching-engine.js`, `smartparser/candidate-generator.js`, `smartparser/parser-repository.js`, `parser-ui.js` 기준선 확보
- 단일 전표만 포함한 실제 익명 주문 fixture 승인

## C. 허용범위

- `documentType=ORDER`의 텍스트 입력
- IntakeSession/Document/Line 저장
- 기존 Parser·거래처·상품 후보 엔진 호출
- 3단계 검토 UI와 이전 단계 수정
- Master 확정 또는 관리자 임시상품 확정
- 최종 `createOrder()` 1회 및 ORDER Q 이동

## D. 금지범위

- 자동·수동 다전표 분할/병합
- 이미지/OCR/파일 Clipboard
- 매핑학습 write와 우선순위 변경
- 견적·구매·판매 Adapter
- 구조화 Import·Collector 정리
- Intake Draft Cloud 동기화

## E. 실제 소스 분석

- `smartparser/source-parser.js`는 sourceMessageKey를 만들고 한 message의 행을 해석한다.
- `smartparser/parser-orchestrator.js`는 sender/source로 customer를 판정하고 parse/candidate를 한 result로 결합한다.
- `smartparser/customer-resolver.js`는 senderRaw/sourceId history에 결합되어 있다.
- `smartparser/candidate-generator.js`와 `smartparser/matching-engine.js`는 Master·mapping·history 후보를 계산한다.
- `smartparser/parser-repository.js`는 raw/parse result와 mapping을 저장하지만 legacy unique key라 Stage 1 Intake repository가 원본 권위를 가져야 한다.
- `parser-ui.js`는 parser 전용 카드·표와 행별 mapping UI를 직접 가진다.
- `order-intake-engine.js.createOrder()`는 최종 주문 transaction을 이미 제공한다.

## F. Before → After

| Before | After |
|---|---|
| 분석 결과와 주문 확정 경계가 약함 | 후보와 확정 주문을 명확히 분리 |
| parser 전용 행 편집 | 3단계에서 공통 OrderDraftEditor 사용 |
| 코드 없는 품명은 실패처럼 보임 | 관리자 확정 임시상품으로 완료 가능 |
| 이전 단계 수정 무효화가 불명확 | 하위 증거만 유지하고 상위 확인을 무효화 |
| 최종 출처 일부 | Intake provenance 전체 보존 |

## G. 데이터 계약

- `IntakeDocumentAdapter` 인터페이스: `documentType`, `buildInitialDraft`, `validateExtraction`, `validateMatching`, `buildOrderPayload`.
- Stage 3 구현체는 `ORDER`만 등록한다. 미등록 type은 `ORDERQ_INTAKE_DOCUMENT_TYPE_UNSUPPORTED`.
- Parser output은 IntakeLine 초깃값일 뿐 확정 사실이 아니다.
- 거래처: `customerReviewStatus=PENDING|CONFIRMED`, 확정 시 customer ID 또는 명시적 임시/직접입력 정책을 보존한다.
- 상품: `reviewStatus`, `productIdentityStatus` 계약은 Stage 1을 따른다.
- `MATCH_REVIEW` 완료 event 전에는 `DOCUMENT_REVIEW` 진입과 final ORDER 생성 금지.
- `sourceOccurrenceKey/sourceDocumentKey`는 원문 저장 시 고정하고 재분석으로 변경하지 않는다.

## H. 함수·API 상세

신규 `orderq/intake-document-adapter.js`:

- `registerIntakeDocumentAdapter(adapter)`
- `getIntakeDocumentAdapter(documentType)`
- `createOrderIntakeAdapter({createOrder})`

신규 `orderq/intake-engine.js`:

- `captureTextIntake(command)` — occurrence/session/sourcePart 생성
- `analyzeSingleOrderDocument(command)` — 기존 parser 호출 후 document/lines 저장
- `saveExtractionReview(command)` — 추출 필드·수량·품명 수정
- `confirmExtraction(command)` — `EXTRACTION_CONFIRMED` event, MATCH_REVIEW 전이
- `saveMatchingReview(command)` — customer/product 선택 또는 임시상품 확정
- `confirmMatching(command)` — 모든 행 확인 검증, `MATCH_CONFIRMED`
- `saveOrderCompletion(command)` — 공통 editor draft 저장
- `commitIntakeOrder(command)` — sourceDocumentKey 멱등 검증 후 adapter payload→`createOrder()`
- `reopenIntakeStage(command)` — 상위 confirmation 무효화 event append

`commitIntakeOrder` transaction 경계는 Intake COMMITTED 표시와 ORDER 생성의 원자성 문제를 해결해야 한다. 같은 IndexedDB이므로 한 readwrite transaction에 통합하거나, 기존 `createOrder`에 외부 transaction runner를 주입하는 명시적 API를 사용한다. 두 번의 독립 transaction은 금지한다.

## I. 파일별 변경명세

신규:

- `orderq/intake-document-adapter.js`
- `orderq/intake-engine.js`
- `orderq/intake-workbench.js`
- `orderq/intake-workbench.css`
- `scripts/test-orderq-stage3-single-document.mjs`
- `scripts/test-orderq-stage3-browser.html`

수정:

- `orderq/parser.html` — 3단계 shell 및 접근성
- `orderq/parser-ui.js` — engine/workbench consumer로 축소
- `orderq/smartparser/source-parser.js`, `smartparser/parser-orchestrator.js` — 순수 결과와 occurrence input 분리
- `orderq/smartparser/customer-resolver.js`, `smartparser/matching-engine.js`, `smartparser/candidate-generator.js` — read-only 후보 API 사용
- `orderq/order-intake-engine.js` — 같은 transaction용 내부 command 지원
- `orderq/index.html`, `orderq/input.html`, `orderq/operations.html`, `orderq/workflow-guide.js` — ORDER IN 명칭·진입점
- workflow — Stage 3 테스트 추가

## J. UI 계약

상단 고정 단계:

1. `추출 수정` — 원문과 추출행 비교, 틀린 품명·수량 수정
2. `매칭 수정` — 거래처·상품을 Master로 선택하거나 임시상품으로 확정, Primary `매칭 완료`
3. `주문 완성` — 실제 공통 Grid에서 주문일·담당자·수량·단가 검토, Primary `ORDER Q로 보내기`

내부 `MATCH_FAILED`, revision, source key, lease는 전면에 표시하지 않는다. 상세 기술정보에서만 노출한다. 각 단계는 저장 여부, 확인 필요 수, 다음 행동을 한 문장으로 보여준다.

## K. 상태전이

`CAPTURED → EXTRACTION_REVIEW → MATCH_REVIEW → DOCUMENT_REVIEW → COMMITTED`.

- 추출 수정 후에는 matching confirmation과 order completion confirmation을 무효화한다.
- 매칭 수정 후에는 order completion confirmation만 무효화한다.
- COMMITTED 주문을 Intake에서 직접 수정하지 않는다. ORDER Q의 기존 revision/edit 정책을 따른다.
- 입력 제외는 session/document `EXCLUDED`와 사용자 명시 event로만 가능하며 별도 `CANCELLED` 상태를 추가하지 않는다.

## L. 오류·충돌·롤백

- 빈 원문: `ORDERQ_INTAKE_SOURCE_EMPTY`
- 단일전표 단계에서 복수전표 감지: 저장은 가능하되 `ORDERQ_INTAKE_MULTIPLE_DOCUMENTS_REQUIRES_STAGE4`로 확정 차단
- 거래처 미확인/상품 unresolved: 단계 이동 차단
- 임시상품명 공란: 차단
- final commit 실패: Intake COMMITTED, ORDER, ITEM, EVENT, syncQueue 모두 부분반영 0
- 응답 유실/재시도: 같은 sourceDocumentKey는 기존 order 결과 반환
- 다른 payload 재사용: conflict, 원 session/order 불변

## M. Given / When / Then 계약 테스트

1. Given 한 거래처·한 주문 텍스트, When 3단계 완료, Then ORDER 1, ITEM N, event/provenance 보존.
2. Given 같은 텍스트의 다음날 새 occurrence, When 완료, Then ORDER 2개.
3. Given 같은 occurrence 재시도, Then ORDER 증가 0.
4. Given parser 오인 수량 수정, When 추출 완료, Then 수정값이 후보·최종 주문에 사용.
5. Given Master 상품 선택, Then review/product identity와 product ID 일치.
6. Given 코드 없는 직접 품명 확정, Then TEMPORARY_CONFIRMED이고 사용자 경고 0, dispatch PRODUCT_REVIEW 근거는 보존.
7. Given 추출 단계로 돌아가 수정, Then 기존 매칭/주문완성 confirmation 무효.
8. Given final commit 실패주입, Then Intake/ORDER/Queue 전체 rollback.
9. Given same key different order date/quantity, Then idempotency conflict.
10. Given 복수 고객 segment, Then Stage 4 필요 안내와 ORDER 생성 0.

## N. 회귀 테스트

- `scripts/test-orderq-stage3-single-document.mjs`
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-orderq-order-workflow.mjs`
- `scripts/test-orderq-manual-master-search.mjs`
- `scripts/test-orderq-fulfillment-lifecycle.mjs`
- `scripts/test-orderq-vnext-cloud-contract.mjs`
- `scripts/test-client-safety.mjs`
- `scripts/validate-repository.mjs`
- 실제 Chromium 3단계/뒤로수정/임시상품/재시도 console 0

## O. 완료증거

- 익명 원문→각 단계 canonical bundle→최종 ORDER 비교
- 상태·revision·event transition trace
- temp item 실제 UI와 IndexedDB/Cloud 필드
- commit 실패주입 전후 전체 Store digest
- 동일내용 다른 occurrence 주문 2개, 동일 occurrence 중복 0
- 실제 화면 캡처 및 accessibility/console 결과

## P. 다음 Stage Gate

Stage 4는 단일전표 3단계가 실제 사용 가능하고 final commit 원자성·멱등성·이전단계 무효화가 승인된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- Stage 3은 ORDER 한 종류·전표 하나만 지원한다.
- 사진·다전표를 임시 heuristic으로 끼워 넣지 않는다.
- Parser 분석 완료는 주문 확정이 아니다.
- 원자 commit을 기존 engine 구조로 보장할 수 없다면 먼저 command API 경계를 국소 보완하고 범위 확대를 보고한다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 3 SINGLE DOCUMENT] 승인된 Stage 1·2 main을 기준으로 전용 branch/worktree를 만들고 상위 명세·로드맵·ORDER_IN_STAGE3_SINGLE_DOCUMENT_SPEC.md를 읽어라. 텍스트 단일 ORDER의 추출 수정→매칭 수정→주문 완성 Vertical Slice만 구현한다. 기존 Parser는 분석 후보로 재사용하고 공통 OrderDraftEditor를 사용하며 final Intake COMMITTED와 createOrder를 원자 처리한다. 다전표·OCR·Mapping write·구조화 Import·Collector·Cloud Intake는 금지한다. 실제 Chromium, 임시상품, 반복주문, 멱등충돌, 실패 rollback 증거로 검증 요청 후 병합·Stage 4·배포를 보류하라.
```
