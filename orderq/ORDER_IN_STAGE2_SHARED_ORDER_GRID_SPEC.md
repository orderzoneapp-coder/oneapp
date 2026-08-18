# ORDER IN Stage 2 — 실제 주문 Grid 공통화 개발명세

기준: Stage 1 승인·병합 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

현재 `input.html`에 인라인으로 결합된 실제 주문 행 편집 기능을 재사용 가능한 `OrderDraftEditor`로 추출한다. 기존 직접 주문등록의 기능·단축키·가격·Master 검색을 완전히 유지하면서 향후 ORDER IN 3단계가 같은 Grid를 쓰게 한다.

## B. 선행조건

- Stage 1 승인 HEAD와 DB v8 회귀 통과
- 직접 주문등록 실제 Chromium 기준 캡처·keyboard/price/master-search 결과 확보
- `input.html`, `product-line-common.js`, `product-master-search.js` 최신 함수 inventory 확정

## C. 허용범위

- 주문 header/line draft의 순수 편집 model
- 현재 Grid DOM·CSS·단축키·상품검색·가격선택의 component 추출
- `input.html`을 새 component consumer로 전환
- 동일 initial draft→동일 read result 계약
- Stage 2 전용 Node/Chromium 회귀

## D. 금지범위

- DB schema/Intake 저장/Parser 연결
- 기존 `createOrder()` payload 의미 변경
- 가격·Master·상품매핑 알고리즘 변경
- Dispatch/Purchase/SmartParser 상태 통합
- UI 재디자인, 컬럼 삭제, 새 업무상태 추가

## E. 실제 소스 분석

`input.html`은 다음 책임을 한 파일에 가진다.

- defaults/message/date: `loadManualDefaults`, `saveManualDefaults`, `showMessage`, `todayLocal`, `isValidOrderDate`
- row/grid: `rowTemplate`, `addRow`, `rowHasInput`, `readItems`, `readPayload`, `refreshSummary`
- match/search: `initializeProductCatalog`, suggestions, `applyProduct`, `clearProductMatch`, `focusQuantity`
- price: `getRowPriceOptions`, `setRowPriceOptions`, `applyRowPriceOption`, `activeMasterPriceKey`, `updatePriceTypeHeaderFromRows`, `applyPriceTypeToRows`, `cycleRowPrice`, `refreshRowAmounts`
- layout: column resize/visibility/sort/focus
- orchestration: edit load, assignee, cloud preflight, `save`, document open

`product-line-common.js`는 ORDER/DISPATCH/PURCHASE/SMARTPARSER context와 검색·선택·허용필드 편집을 제공하고, `product-master-search.js`는 Master/ORDER Q catalog와 가격 필드를 정규화한다. 공통 Grid는 이 둘을 소비하되 업무 command를 소유하지 않는다.

## F. Before → After

| Before | After |
|---|---|
| `input.html` 전용 Grid | `OrderDraftEditor`를 직접입력과 ORDER IN이 공유 |
| DOM에서 payload 직접 조립 | editor가 canonical draft를 반환 |
| 저장과 편집 책임 결합 | consumer가 저장 command를 소유 |
| 테스트가 페이지 내부 함수에 의존 | 순수 draft model + component contract 테스트 |

## G. 데이터 계약

`OrderDraft`:

- header: `orderDate`, `customerId`, `customerName`, `assigneeId`, `memo`, `inputChannel`
- lines[]: `draftLineId`, `productId`, `itemCode`, `itemName`, `quantity`, `unit`, `unitPrice`, price evidence, `reviewStatus`, `productIdentityStatus`, source provenance
- UI-only state는 별도 `viewState`에 두고 저장 payload에 spread하지 않는다.
- 숫자 `0`, 문자열 `'0'`, 공란을 임의 `||` fallback으로 합치지 않는다.
- row 순서는 stable `draftLineId`로 보존한다.

Stage 2는 새 Store를 만들지 않는다. Stage 1 필드는 손실 없이 round-trip만 한다.

## H. 함수·API 상세

신규 `orderq/order-draft-editor.js`:

```js
createOrderDraftEditor({ root, context, initialDraft, catalog, onChange, onIntent })
```

반환 API:

- `getDraft()` — canonical header/lines 반환
- `setDraft(draft)` — 전체 교체, dirty reset 선택
- `patchHeader(patch)`
- `addLine(seed)`, `removeLine(draftLineId)`, `focusLine(draftLineId, field)`
- `applyProduct(draftLineId, product)`, `clearProduct(draftLineId)`
- `setPriceChoice(draftLineId, choice)`, `cyclePrice(draftLineId)`
- `validate({mode})` — 오류를 line/field/path로 반환
- `getDirtyFields()`, `destroy()`

`onIntent`는 `SAVE`, `CANCEL`, `OPEN_PRODUCT_SEARCH` 같은 UI intent만 알리며 repository를 호출하지 않는다. `input.html`의 `save()`가 기존 `readPayload()` 대신 `editor.getDraft()`를 사용해 현행 `createOrder()`를 호출한다.

## I. 파일별 변경명세

신규:

- `orderq/order-draft-editor.js`
- `orderq/order-draft-editor.css`
- `scripts/test-orderq-stage2-order-grid.mjs`
- `scripts/test-orderq-stage2-browser.html`

수정:

- `orderq/input.html` — inline Grid 함수를 component consumer로 교체
- `orderq/product-line-common.js` — ORDER context allowlist만 필요한 경우 확장
- `orderq/product-master-search.js` — importable helper 노출만 허용
- `orderq/orderq.css` 또는 page stylesheet — 기존 시각 결과 보존용 import
- workflow — Stage 2 테스트 추가

## J. UI 계약

기존 직접 주문등록의 컬럼, label, 가격칩, 상품검색, 요약, 단축키를 시각·업무상 동일하게 유지한다. 키보드 흐름은 상품→수량→단가→다음 행이며, Enter/Escape/화살표가 회귀하면 완료가 아니다. 임시상품은 `확인 완료 · Master 미연결`로 표시하고 빨간 미처리 경고로 표시하지 않는다.

## K. 상태전이

editor 자체 상태는 `CLEAN ↔ DIRTY`, `VALIDATING`, `DESTROYED`뿐이다. ORDER/Intake 업무상태를 만들거나 변경하지 않는다. consumer가 저장 성공 후 `setDraft(savedDraft)`로 CLEAN 처리한다.

## L. 오류·충돌·롤백

- 잘못된 숫자/필수값은 저장 호출 전 field error로 반환한다.
- catalog load 실패 시 직접 품명 입력을 막지 않되 Master 선택 기능만 오류 안내한다.
- `setDraft` 중 렌더 오류 시 이전 canonical draft를 유지한다.
- 기존 ORDER revision conflict는 현행 저장 계층이 처리하며 editor가 재해석하지 않는다.

## M. Given / When / Then 계약 테스트

1. Given 기존 직접등록 fixture, When old/new payload를 비교, Then canonical JSON 동일.
2. Given product search 선택, When apply, Then code/name/price evidence 동일.
3. Given price 0, When 선택·읽기, Then 0이 공란으로 바뀌지 않는다.
4. Given 임시품명 확정, When editor round-trip, Then review/productIdentity 유지.
5. Given 30행 keyboard 입력, When Enter 흐름, Then focus 순서와 행 생성 동일.
6. Given hidden/resized/sorted columns, When reload, Then 현행 local preference 계약 유지.
7. Given validation error, When save intent, Then repository 호출 0.
8. Given existing order revision conflict, When 저장 실패, Then 편집 draft가 사라지지 않는다.
9. Given destroy 후 event, When key/click, Then duplicate listener 호출 0.

## N. 회귀 테스트

- `scripts/test-orderq-stage2-order-grid.mjs`
- `scripts/test-orderq-manual-master-search.mjs`
- `scripts/test-orderq-order-workflow.mjs`
- `scripts/test-orderq-user-flow.mjs`
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-client-safety.mjs`
- `scripts/validate-repository.mjs`
- 실제 Chromium direct create/edit/reload와 console 0

## O. 완료증거

- 추출 전후 함수 책임 mapping
- old/new canonical payload 비교
- 기존/신규 화면 pixel 또는 구조 비교
- keyboard focus trace, price 0, temp identity 결과
- 직접 주문 생성 DB/Cloud row count 동일
- 금지범위 diff 0

## P. 다음 Stage Gate

Stage 3은 direct order create/edit의 기능·payload·Cloud 회귀가 0이고, editor가 repository/parser를 import하지 않으며, public API가 고정된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- editor는 ORDER draft만 다룬다. Dispatch/Purchase 상태를 합치지 않는다.
- Stage 2는 UX 개선 단계가 아니라 무손실 추출 단계다.
- 기존 화면과 동작 차이가 생기면 새 기능을 추가하지 말고 parity부터 복구한다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 2 SHARED ORDER GRID] 최신 승인 main에서 Stage 2 전용 branch/worktree를 만들고 상위 명세·로드맵·ORDER_IN_STAGE2_SHARED_ORDER_GRID_SPEC.md를 전부 읽어라. input.html의 실제 주문 Grid를 OrderDraftEditor로 무손실 추출하고 직접 주문등록을 새 component consumer로 전환하라. DB·Parser·Intake repository·업무 command·가격 알고리즘·Dispatch/Purchase는 변경하지 않는다. old/new payload, 키보드, Master 검색, 가격 0, 임시상품, 실제 Chromium 회귀를 증명하고 승인 전 병합·Stage 3·배포를 보류하라.
```
