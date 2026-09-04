# NEXUS SmartInput 쇼핑몰 주문내역 연결 작업 기록

- 작업명: `[개발][SmartInput] 쇼핑몰 주문내역 17열 업로드·실제원장 중복제외 연결`
- 상태: 개발 검증 완료 / PR 준비 — PM 독립 검증 전 병합·배포 금지
- 시작 기준: `origin/main` `d44bbda357268289269574aa8f7b36333e013be5`
- 브랜치: `codex/smartinput-shopping-order-upload-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-shopping-order-upload-20260904`
- 보존 상태: 원래 checkout의 기존 충돌/dirty 파일은 읽기 확인만 하고 수정·정리·reset하지 않음

## 착수 게이트

- 확인 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md` v2.1.31, `app-manifest.json` schema v1.3.10, `roles/DEVELOPER.md`, `orderq/ARCHITECTURE.md`, `smartinput/README.md`
- 현재 상태: ORDER Q owner의 쇼핑몰 주문 중복 판정 Core/Repository/Command Adapter는 운영 소스에 존재하지만 SmartInput 소비자는 아직 등록·활성화되지 않음.
- 목표 상태: SmartInput 주문서 탭의 기존 Excel picker가 정확한 17열 원본을 식별하고, 원본 증거를 유지하면서 기존 기준정보 선택 UX로 owner ID를 확정한 후보만 ORDER Q command Adapter에 검사·저장 요청함.
- 소유권 경계: SmartInput은 원본·열린 작업·표시 상태만 소유한다. 실제 주문·품목·이벤트·sync queue와 중복 판정은 ORDER Q owner가 소유한다.
- 실행 분류: 파일 읽기·기준정보 매칭·실제 로컬 원장 검사·후보별 저장은 `LOCAL_OPERATION`; 기존 주문 자동 변경과 Cloud 전역 중복 방지는 범위 밖.
- 공통 UI: 기존 NEXUS UI 자산과 SmartInput 레이아웃·테마를 그대로 소비하며 새 헤더·테마·공통 Runtime을 만들지 않음. 1920/1440/390 일반·다크에서 새 후보 상태 영역만 검증함.
- 충돌 여부: 금지된 DB schema/Store/key/index/version/migration/reset 변경 없이 현 DB v7 owner transaction을 재사용할 수 있어 착수 차단 없음.

## 선택 이유와 범위

- 정확한 17열 헤더 판정과 주문 후보 생성·중복 판정은 ORDER Q command Adapter를 단일 권위로 사용해 SmartInput 안에 별도 signature 또는 원장을 만들지 않는다.
- 일반 Excel 입력 양식·붙여넣기·사진·음성·구매·판매·견적 흐름은 기존 경로를 그대로 유지하고, 정확히 일치한 주문서 Excel만 쇼핑몰 전용 분기로 보낸다.
- 원본 수량·단가·금액은 표시·증거와 owner 요청에 그대로 전달한다. 계산값은 검증에만 사용하며 불일치는 후보 전체를 보류한다.
- 후보별 실패 격리와 중복 0-write는 owner Repository 결과를 그대로 표시한다.

## 검증 결과

### 실제 파일

- `C:\Users\USER\Desktop\orderlist-260904.xls`를 read-only로 파싱했다. `Worksheet!A1:Q15`, 정확한 17개 헤더, 데이터 14행, 연속 거래처 후보 5개, 수량 합계 24, 원본 금액 합계 288,400, 후보 validation 0건이다.
- `C:\Users\USER\Desktop\orderlist-260904 (분석).xls`를 read-only로 파싱했다. 전체 데이터 12,301행에서 최신 배송일자 `2026-09-04`의 14행을 선택했고 소형 파일과 canonical 주문 내용이 일치했다. 이번 최종 parse는 1,413.8ms였다.
- 소형/누적 파일의 선택된 14행은 source value와 셀 증거를 deep-equal로 대사했다. 누적 파일의 절대 셀 주소·행번호 차이는 증거에 남고 signature에서는 제외된다. 원본 파일은 수정·복사·업로드하지 않았다.

### 기능·원자성

- 정확한 17열 파일만 쇼핑몰 분기로 들어가며 다른 Excel은 기존 field mapping 흐름을 유지한다.
- 실제 원장 multiset은 `기존1+원본2 → 신규1`, `2+2 → 0`, `1+3 → 신규2`를 고정했다. 기존 orderNo가 있으면 `기존 주문서 제외 · <orderNo>`로 표시한다.
- 거래처/상품/창고 owner ID, 금액 일치, source boundary를 각각 검사한다. 미해소 또는 불일치 후보는 `REVIEW_REQUIRED`이고 같은 batch의 정상 후보는 계속 판정·저장된다. 기존 불완전 legacy bundle 가능성은 `EXISTING_LEDGER_BUNDLE_INVALID`로 보류한다.
- 격리 브라우저 DB에서 금액 문제 1후보 + 정상 4후보를 실행해 첫 commit은 정상 4건만 저장, 수정한 재업로드는 기존 4건 0-write + 초과 1건 저장, 최종 반복은 5건 전부 duplicate 0-write임을 확인했다.
- 최종 격리 DB는 주문 5, 품목 14, 생성 이벤트 5, local sync queue 10이었다. 모든 `externalOrderNo`는 빈 값이고 `sourceType`은 `SHOPPING_MALL_ORIGINAL`이며 각 저장 row의 17-cell evidence가 유지됐다.
- 1단계 owner browser 회귀에서 double click/two-tab/stale read가 정확한 surplus만 생성하고 item/event/queue 두 번째 put 실패는 해당 후보 transaction 전체를 rollback하며 다른 정상 후보와 격리됨을 다시 확인했다.

### 자동 테스트

- 저장소의 `scripts/test-orderq*.mjs`와 `scripts/test-smartinput*.mjs` 전부: **60/60 PASS**. 최초 전체 실행에서 이번 승인 자산 token/UI hash를 이전 버전으로 고정한 3개 assertion을 새 승인 baseline으로 갱신했고 해당 3개를 재실행해 PASS했다.
- `node scripts/test-smartinput-shopping-order-upload.mjs`: PASS. 실제 소형/누적 XLS, immutable evidence, 후보/총계, occurrence multiset, customer/product/warehouse/amount/boundary fail-closed를 검증한다.
- `node scripts/test-smartinput-shopping-order-upload-browser.mjs`: PASS. 실제 UI upload, 후보 상태, 부분 저장, duplicate 0-write, DB evidence와 1920/1440/390 light/dark를 격리 profile에서 검증한다.
- `node scripts/test-orderq-shopping-actual-ledger-dedupe.mjs`: PASS. 실제 파일과 canonical/core 규칙을 검증한다.
- `node scripts/test-orderq-shopping-actual-ledger-browser.mjs`: PASS. actual-ledger race, stale read, owner 미해소, legacy fail-closed, candidate isolation, rollback을 검증한다.
- `node scripts/validate-repository.mjs`: PASS, 24 checks / 0 warnings.
- `node scripts/test-client-safety.mjs`: PASS.
- 변경 JavaScript/ESM 11개 `node --check`: PASS.
- `git diff --check`: PASS.

### UI 증적

- 1920×1080, 1440×1000, 390×844 각각 light/dark 6장을 `evidence/smartinput-shopping-order-upload-20260904/screenshots/`에 저장했다.
- 각 viewport/theme에서 page horizontal overflow 0, panel/card horizontal clipping 0, 거래처 선택 버튼 focus 가능, console error 0, runtime exception 0을 assertion으로 확인했다.
- 캡처는 개인정보가 없는 합성 17열 XLS와 임시 Chrome profile만 사용했다. 1440에서는 원본표와 후보 5개/상태가 함께 보이고, 390에서는 기존 모바일 구조 안에서 단일열 후보·품목·상태 라벨이 읽힌다.

### 데이터·앱 소유권과 영구 write 경계

- SmartInput은 `shopping-order-upload.js`에서 raw source/evidence, owner 선택과 화면 상태만 관리하며 ORDER Q DB 이름, Store, index, Repository를 직접 열거나 import하지 않는다.
- 실제 원장 판정과 write는 `ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER_V1`만 호출한다. owner Repository가 기존 ORDER Q DB v7의 후보별 transaction에서 actual count와 `orders.bySourceMessageKey`를 재검사한다.
- DB schema/Store/key/index/version/migration/reset, 공식전표 V2, 재고, 채권·채무, 기준정보 owner, 공통 Runtime, Cloud gate는 변경하지 않았다.
- 실제 운영 profile/원본으로 저장하지 않았다. 브라우저 write 검증은 매 실행 후 제거되는 합성 DB/profile에서만 수행했고 외부·로컬 HTTP mutation은 0건이었다.

### 알려진 제한과 rollback

- 이 단계의 중복 보장은 한 기기의 local actual ledger 범위다. 서버와 두 기기 계약이 없으므로 다기기 전역 중복 방지를 주장하지 않는다.
- 원본 주문번호가 없으므로 같은 거래처 연속 run 내부의 반복 주문 경계를 결정할 수 없으면 자동 분할/병합하지 않고 `AMBIGUOUS_SOURCE_ORDER_BOUNDARY`로 보류한다. `그룹`은 주문번호로 사용하지 않는다.
- source 상태 변경은 기존 주문 상태를 수정하지 않는다. 기존 주문의 자동 수정·취소·삭제는 범위 밖이다.
- rollback은 이 PR의 SmartInput consumer/UI wiring, manifest/docs/tests와 ORDER Q adapter의 Phase 2 노출·금액 검증만 revert한다. Phase 1 owner core와 기존 DB v7 schema는 유지되며, 이미 작업자가 명시 저장한 주문 사실을 삭제하거나 다시 쓰지 않는다.

### Git/PR

- 최종 fetch 확인: `origin/main`, branch merge-base 모두 `d44bbda357268289269574aa8f7b36333e013be5`.
- Commit/PR/CI exact 값은 push와 PR 생성 직후 이 기록에 추가한다. PM 독립 검증 승인 전 merge/deploy는 금지한다.
