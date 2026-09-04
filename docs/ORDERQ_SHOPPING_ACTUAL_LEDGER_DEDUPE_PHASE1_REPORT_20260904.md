# ORDER Q 쇼핑몰 실제 원장 중복 판정·원자 저장 코어 1단계 개발 보고

- 작업 ID: `NEXUS-ORDERQ-SHOP-ACTUAL-LEDGER-20260904-01`
- 기준 브랜치/SHA: `origin/main` / `ae2a80df1724b7171b15c883f4b2dc725dbea095`
- 기준 확인: 사용자 제시 SHA와 2026-09-04 fetch 결과가 정확히 일치
- 개발 브랜치: `codex/orderq-actual-ledger-dedupe-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-orderq-actual-ledger-dedupe-20260904`
- 범위: ORDER Q owner Core/Repository/Adapter, 전용 테스트/fixture, 계약 문서와 CI 등록
- 제외: SmartInput·ORDER Q 제품 UI 연결, DB schema/Store/key/index/version/migration/reset, 공식전표 V2, 재고·채권/채무, 공통 Runtime, 서버/Cloud gate, 병합·배포

## 구현 결과

`orderq/shopping-order-dedupe-core.js`가 고정 17열 원본 행을 불변 증거와 비교용 정규화 값으로 분리하고 주문 후보, canonical signature, source occurrence, 실제 원장 개수 기반 `isDuplicate`를 계산한다. 사용자 판정 boolean은 후보별 `isDuplicate` 하나이고 canonical basis/signature, `occurrenceNo`, `existingCount`, 연결 주문 ID는 내부 근거다.

`orderq/shopping-order-import-repository.js`만 기존 ORDER Q DB v7을 연다. 조회 시 실제 `orders`와 `orderItems` bundle을 조합하고, 저장 시 후보 하나마다 `orders + orderItems + orderEvents + syncQueue + meta` 기존 Store를 같은 readwrite transaction으로 연다. transaction 안에서 실제 signature 개수를 다시 계산한 뒤 정확히 다음 surplus occurrence만 ORDER Q 내부 주문번호와 함께 생성한다. 주문·모든 품목·생성이력·ORDER/ORDER_EVENT queue·주문번호 counter 중 하나라도 실패하면 후보 transaction 전체가 rollback된다. 다른 signature 후보는 별도 transaction에서 계속 처리된다.

`orderq/shopping-order-command-adapter.js`는 향후 SmartInput이 소비할 owner façade다. SmartInput은 이 단계에서 연결하지 않았고 ORDER Q IndexedDB나 raw Store를 직접 여는 새 경로가 없다.

## 선택 이유와 업무 규칙

1. 중복 진실은 Lab snapshot, SmartInput autosave, 파일명이 아니라 현재 ORDER Q 실제 주문·품목이다. 수기 주문도 같은 signature이면 개수에 포함한다.
2. signature는 회사, owner에서 확정된 거래처, 배송일자, 출하창고와 품목 다중집합의 상품 identity·규격·단위·수량·단가·금액으로 구성한다. 품목은 정렬하되 같은 품목 반복행을 제거하거나 합산하지 않는다.
3. 주문상태, `그룹`, 파일명, 업로드시각, 절대 행번호, 전달사항, 상점메모, 주소, 전화는 source evidence에 그대로 보존하지만 중복 판정을 바꾸지 않는다. 수량·단가·금액은 판정값이므로 변경되면 다른 signature다.
4. 같은 signature의 이번 원본 occurrence가 `n`, 실제 ORDER Q 개수가 `m`이면 `isDuplicate = n <= m`, 신규 수는 `max(0, n-m)`다. 집합 존재 여부만 보는 판정을 사용하지 않는다.
5. `SHOPPING_ORDER_V1:<SHA-256 signature>:<occurrence>`는 기존 unique `orders.bySourceMessageKey`를 재사용하는 내부 멱등키다. 원본 주문번호나 외부 주문번호를 만들어낸 것이 아니며 원본에 번호가 없으므로 `externalOrderNo`는 빈 값으로 저장한다. ORDER Q의 `YYYYMMDD-NNN`은 원장 자체의 내부 관리자 번호다.
6. 별도 index를 추가하지 않고 실제 bundle 전체를 transaction 안에서 다시 읽는 방식을 선택했다. 현재 DB v7 계약을 보존하면서 stale read·더블클릭·동시 탭의 초과 생성을 막기 위한 선택이다.
7. 판정할 수 없는 기존 ORDER Q bundle이 같은 header scope와 충돌할 가능성이 있으면 무시하지 않고 `EXISTING_LEDGER_BUNDLE_INVALID`로 보류한다.

## 실제 파일 경계 조사

두 파일은 복사·수정하지 않고 로컬에서 읽기 전용으로 검사했다.

- `C:\Users\USER\Desktop\orderlist-260904.xls`: `Worksheet` `A1:Q15`, 헤더 17개 정확 일치, 2026-09-04 데이터 14행
- `C:\Users\USER\Desktop\orderlist-260904 (분석).xls`: `Worksheet` `A1:Q12302`, 데이터 12,301행, 최신 2026-09-04 데이터는 절대행 12,289~12,302의 14행
- 최신 14행은 두 파일에서 값과 상대순서가 완전히 같음
- 거래처 연속 구간은 5개, 수량 합계 24, 금액 합계 288,400원, 후보 signature 내부 중복 0, validation issue 0
- `그룹`은 앞 9행 공란, 뒤 5행 `88`이며 5개 후보를 식별하지 못한다. 따라서 주문번호나 주문 경계로 쓰지 않는다.
- 실제 파일에서 입증되는 자동 경계는 배송일자·거래처·확정 출하창고 scope가 바뀌는 연속 구간이다. 같은 거래처가 떨어져 다시 나오면 별도 후보다.
- 같은 scope의 연속행에 동일 주문 품목열이 반복되면서 별도 upstream boundary 또는 검토된 manual split이 없으면 주문 두 건인지 한 주문의 반복 품목인지 수학적으로 구분할 수 없다. 이 경우 `AMBIGUOUS_SOURCE_ORDER_BOUNDARY`로 fail-closed한다. 파일 단위 `sourceDocumentKey`와 `그룹`은 이 오류를 해제하지 않는다.

## 검증 결과

- 신규 pure/실파일: `node scripts/test-orderq-shopping-actual-ledger-dedupe.mjs` PASS
  - `1+2 → 신규 1`, `2+2 → 신규 0`, `1+3 → 신규 2`
  - 수기 주문 포함, 품목 반복행 보존, 품목 순서 무관 multiset, 상태/그룹/파일명/업로드시각/행 offset 무관
  - 수량·금액 변경은 신규, 0수량과 경계 불명은 보류, 판정 불가능한 기존 bundle은 보류
  - 실파일 14행/5후보/수량24/금액288400/validation0, 누적 12,301행 최신 데이터 동일, 단독 최종 실행 1.076초
- 신규 실제 브라우저 IndexedDB: `node scripts/test-orderq-shopping-actual-ledger-browser.mjs` PASS
  - 수기 기존 1 + 원본 2의 동시 두 호출 후 실제 주문 정확히 2
  - stale 사전판정 뒤 수기 주문 추가 시 transaction 재확인으로 duplicate 0-write
  - 동일 후보 재실행 0-write, 저장 원본 상태·메모·주소·행번호 보존, 외부 주문번호 공란
  - `orderItems`, `orderEvents`, `syncQueue` 각 강제 실패 시 `orders/items/events/queue/meta` 전체 rollback
  - 한 후보 강제 실패 또는 확인 필요가 다른 정상 signature 후보 저장을 막지 않음
  - 외부·로컬 HTTP mutation 0, 브라우저 runtime exception 0
- 기존 ORDER Q 14개 + SmartInput 44개 자동 테스트 전체 순차 실행: `ALL_PASS count=58`
- `node scripts/validate-repository.mjs`: `24 checks, 0 warnings` PASS
- `node scripts/test-client-safety.mjs`: PASS
- 변경 JavaScript 6개 `node --check`: PASS
- `git diff --check`: PASS

PR 최초 CI에서 manifest 계약을 고정한 기존 owner-boundary 테스트가 `1.3.9`를 기대해 실패했고, 이번 계약 추가로 올린 실제 manifest schema `1.3.10`과 일치하도록 assertion을 갱신했다. 업무 로직·DB schema 변경은 아니며 해당 테스트와 전체 CI를 다시 실행한다.

GitHub Actions에는 신규 pure/브라우저 검증을 repository validation job에 추가했다. 실제 Desktop XLS는 저장소나 CI artifact에 복사하지 않으며, CI에서는 동일 계약의 synthetic fixture를 실행하고 로컬 실파일 검증은 위 결과로 남긴다.

## 데이터·앱 소유권과 한계

- ORDER Q가 실제 주문·품목·이력·local sync queue와 중복 판정/저장을 소유한다.
- SmartInput은 다음 UI 단계에서 원본/작업본을 소유하고 owner-resolved 거래처·상품·창고를 이 Adapter에 전달하는 소비자가 된다. 이번 단계 manifest consumer는 빈 배열이며 제품 UI에는 연결하지 않았다.
- source evidence는 저장된 실제 주문과 품목의 additive 필드다. 기존 Store/index/레코드를 이전·삭제·초기화하지 않는다.
- 이 단계는 같은 브라우저의 로컬 실제 원장에 대한 idempotency다. 서버 계약과 2기기 검증이 없으므로 다기기 전역 중복 방지를 주장하지 않는다.
- 새 index를 만들지 않는 제약 때문에 판정은 현재 주문·품목 전체 scan이다. UI 단계에서 운영 원장 규모의 응답시간을 별도 측정하되 성능을 이유로 schema를 암묵 변경하지 않는다.
- 동일 signature occurrence의 앞선 저장 실패는 occurrence gap으로 보류될 수 있다. 이는 뒤 occurrence가 앞 occurrence 자리를 조용히 차지해 총 신규 수가 줄어드는 것을 막는 안전 경계다.

## Rollback

이 단일 목적 PR을 revert하면 향후 owner Adapter 호출과 CI 계약이 제거된다. DB v7 schema와 기존 데이터는 바뀌지 않으므로 migration rollback이나 Store 삭제는 없다. 명시적으로 실행되어 이미 생성된 ORDER Q 주문은 감사 가능한 실제 업무 사실이므로 코드 rollback 때 자동 삭제하지 않고 기존 ORDER Q 업무 절차로 관리한다.

Commit SHA와 PR URL은 push 후 PR 본문과 최종 개발 보고에 기록한다. PM 독립 검증 승인 전에는 병합·배포하지 않는다.
