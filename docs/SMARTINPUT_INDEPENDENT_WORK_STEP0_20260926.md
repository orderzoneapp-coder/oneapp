# SmartInput 독립 업무 완성 — STEP 0 저장 경로 진단

- 기준 소스: `main` / `5e9673a7da0170f9fbee02cc0f5bf1d125c955ef`
- 진단일: 2026-09-26
- 범위: 견적·구매·판매·일반 주문·쇼핑몰 주문의 저장, 자체 목록, 재열기, 수정, 보고서, 공식 전달 경계
- 운영 자료: 읽기·쓰기 실험을 하지 않음

## 진단 결과

| 유형 | 실제 저장 진입·쓰기 | 자체 저장/목록/재열기 | 보고서·전달 | 분류 |
|---|---|---|---|---|
| 견적 | `smartinput/smartinput.js:completeOrder()`가 `saveEstimateDocument()` 또는 선택 견적 업데이트로 분기. `smartinput/estimate-workspace.js`와 `smartinput/smartinput-data-store.js`의 견적 CAS/원자 커밋 경로가 `estimates` Store를 사용 | 자체 견적 목록, 본문 지연 조회, 같은 ID 편집·복구 경로가 이미 존재 | F8 및 견적 보고서 경로가 있으며 소스 행/매핑 근거를 보존 | **A — 기존 구현 재사용·회귀 검증** |
| 구매 | `completeOrder()` → `completePurchaseOfficial()` → capability 확인 → `PurchaseFinalizeService.finalize()` → ORDER Q 소유 command 경계 | 자동저장 `autosave`는 복구용일 뿐 자체 저장 레코드/목록이 아님. SmartInput의 `draftVouchersV2` CRUD 사용처는 없음 | 구매 보고서 `buildPurchaseReportSourceRows()`가 현재 `inputMapping.sourceMatrix`, `workingRows`, 편집값을 사용. 공식 활동 목록은 별도 Read Adapter | **C — 자체 저장 경로 최소 구현** |
| 판매 | `completeOrder()` → `completeSaleOfficial()` → capability 확인 → `SaleFinalizeService.finalize()` → ORDER Q 소유 command 경계 | 구매와 동일하게 정식 자체 문서 저장/목록/재열기 없음 | 공식 저장 결과와 자동저장/활동 목록은 별도 경로. 판매 출력 계산은 현재 활성 초안에 의존 | **C — 자체 저장 경로 최소 구현** |
| 일반 주문 | `completeOrder()` → `completeOrderLegacy()` → `createOrder()` 또는 `saveOrderGroups()` → ORDER Q vNext | 자체 문서 목록·재열기 없음. 자동저장은 별도 | 저장 자체가 공식 주문 원장 쓰기이며 명시 전달이 분리되지 않음 | **C — 3단계에서 저장과 전달 분리** |
| 쇼핑몰 주문 | `completeOrder()`의 쇼핑몰 분기 → `completeShoppingOrderImport()` → ORDER Q shopping command adapter의 실제 원장 검사·commit | 업로드 원본과 판정 결과는 작업 초안/자동저장에 속하며 자체 업무 문서 저장 목록은 아님 | 중복·검토·성공 결과가 ORDER Q 전달 결과이며 해당 owner 판정·멱등 경계를 보존해야 함 | **C — 3단계에서 기존 전달 경계 유지하며 분리** |

## 저장소·수명주기 확인

- SmartInput은 `oneapp-smartinput` IndexedDB DB v5를 사용한다. `smartinput/smartinput-data-store.js`에서 `draftVouchersV2` Store를 `draftId` keyPath와 `byCompanyModeStatus`, `byUpdatedAt`, `byIdempotencyKey` index로 생성한다.
- 소스에서 확인된 `draftVouchersV2` 참조는 Store 이름 선언과 DB 초기화뿐이며 현재 앱의 조회·저장·수정 CRUD는 없다. 따라서 기존 레코드 형식·소비자는 확인되지 않았고, 이를 추정하거나 기존 레코드를 변환하면 안 된다. 신규 레코드는 새 namespace/schema version으로 구분하고 회사·업무 유형을 명시해야 한다.
- `autosave` Store와 `oneapp.smartinput.draft.v1` 호환 초안은 복구용이다. 정식 저장 목록을 대신하지 않으며 autosave 정리/복구가 자체 저장자료를 삭제하거나 변경해서는 안 된다.
- 구매·판매·주문의 공식 원장은 ORDER Q 소유다. SmartInput은 owner raw Store를 직접 열지 않는다. 이 작업의 자체 문서 writer는 SmartInput v5의 기존 `draftVouchersV2` 경계 안에 둔다.
- DB version, Store, keyPath, index, 기존 견적·주문·전표 payload, ORDER Q writer는 변경하지 않는다.

## 단계 결정 및 구현 경계

1. 견적은 재구현하지 않는다. 동일 ID 저장, 선택 대상만 갱신, F8/보고서 재현의 영향 검사를 추가한다.
2. 2단계에서는 구매·판매 작업 payload를 자체 문서로 저장하고, SmartInput 자체 목록에서 조회·재열기·같은 ID 수정 저장을 구현한다. 기존 구매·판매 공식 finalize는 별도 명시 동작으로만 유지한다.
3. 정식 문서 payload에는 전체 모드 작업본을 보존한다. 특히 매핑 `sourceMatrix`, 헤더, 원본 batch, 모든 행 ID/순서/값, 숨은 열, 작업 셀, 사용자 편집값과 레이아웃 snapshot을 보존해 보고서를 재현한다.
4. 자체 저장 경로에서는 `ensureOfficialCapability`, `PurchaseFinalizeService`, `SaleFinalizeService`, ORDER Q command, 동기화, 원장/재고/정산 writer가 호출되지 않아야 한다.
5. 2단계가 저장·목록·재열기·보고서 검수 기준을 충족한 후 일반 주문·쇼핑몰 주문을 같은 자체 저장 계약으로 확장한다. 공식 전달은 별도 단계/행동이다.

## 검증 게이트

- 2단계 변경은 우선 저장 계약/IndexedDB transaction, 기존 저장·자동복구, 구매 보고서 원본 재현, 구매·판매 브라우저 흐름 검사를 수행한다.
- 실패 저장·revision 충돌은 초안과 원본을 보존하고 성공 처리하지 않는다.
- 자체 저장·목록·재열기·보고서 호출에서 ORDER Q command, official finalize, master 쓰기, 재고·정산 writer가 0회임을 확인한다.
- 이 기록은 소스 정적 흐름 분석이며 실계정·운영 데이터 실험이나 독립 QA 판정은 아니다.
