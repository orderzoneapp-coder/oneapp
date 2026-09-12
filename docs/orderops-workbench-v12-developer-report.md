# 출고관리 UI/UX v1.2 개발자 자체검증 보고 — 진행본

판정: **Draft PR #589 / PM-F08 개별 대조 통과 / U29 CI 증거 대조 통과 / 성능 미통과 / PM 최종 검증 전 / 병합·배포 금지**.

### 필수 CI 단계 갱신

`7573356817c3bf23308c851a69a44f22dabe2679`의 [workflow 34696022446](https://github.com/orderzoneapp-coder/oneapp/actions/runs/34696022446)은 필수 4개 job 전체 성공이다. PM도 동일 head의 CI 단계를 직접 대조해 통과로 기록했다. 이는 PR 전체 최종 승인 또는 배포 승인이 아니다. 해당 workbench artifact는 `artifacts/orderops-v12/ci-75733568`에 별도 보존했다.

### 성능 증거의 조건 보정

이전 `diagnostic-cell-pair-final`과 `diagnostic-predecorated-pair`는 같은 프로필에서 우측 열림 상태가 다음 variant에 남아 표 가용폭이 달랐다. 두 번째 실험에는 짧은 단위검사 실행 중첩도 있었다. 이 수치들은 당시 관찰값으로만 보존하고 **개선율·채택·동일 조건 비교의 근거에서 제외**한다. 시험용 프로필의 좌측 열림·우측 닫힘·폭만 매 variant 초기화하고 실제 시작 표 크기와 열림 상태를 기록한 `diagnostic-predecorated-fixed-panels`를 후속 비교로 사용한다. 운영 사용자 설정은 수정하지 않았다.

첫 정상 Chrome trace에서는 공통 패널의 layout read 뒤에 공통 표 `decorate()`가 `nexus-table-ux` 클래스를 추가하면서 별도의 스타일 재계산(44,696요소/약1,040ms)과 layout(약331ms)을 발생시킨 호출 순서를 확인했다. 조상 style/class 변경 관찰에서는 현황 전환 중 패널 상속변수 재변경이 없었다. 상세 invalidation trace 3회는 수집 종료 timeout으로 실패해 종료했으며 제품 오류로 분류하지 않는다. 같은 실행의 실제 commandLine/SystemInfo에는 Intel UHD610/ANGLE D3D11, compositing/rasterization enabled가 기록됐다. 실사용 브라우저와 동일하다고 확대하지 않는다.

### 최소 후속 후보 — 화면 표 스타일 사전 부여

- 제품 수정은 `orderops/list.html`의 표 생성 한 줄이다. 화면 표만 기존 `nexus-table-ux` 클래스를 처음부터 부여하고 `printOutput`의 클래스는 원래 그대로 유지한다. 공통 `decorate()`는 class 존재 여부로 listeners/resize/tools/applyView를 건너뛰지 않으므로 기존 동작을 그대로 실행한다. 공통 파일·계산·저장·입력 DOM·출력 양식 변경 없음.
- PM은 원인/한 줄 diff/후속 비교를 직접 대조하고 최소 후보 채택을 허용했다. 이는 전체 PR 통과나 성능 조건 면제, 배포 승인이 아니다.
- `diagnostic-predecorated-fixed-panels`: 2026-09-12 13:29:01~13:30:06 UTC, Chrome152, 500행·10창고. 시작 양쪽 모두 중앙956×452/우측닫힘, 끝664×392. 개발자의 다른 로컬 검사 중첩 없음. runtimeErrors=[]/실행exit0, `performanceVerdict=not-met`.

| 동작 | 기존 원시값(ms) | 최소 수정 원시값(ms) | 판정 |
|---|---|---|---|
| 최초 전체 표시 | 6459 | 5465 | 각 1회 관찰, 정식 비교 아님 |
| 주문 전환 | 2618, 2631, 2600 | 2343, 3029, 2944 | 일관된 개선 없음·목표 미달 |
| 재고 전환 | 3535, 3202, 2506 | 2304, 2044, 2252 | 이번 3회 개선 관찰·목표 미달 |
| 행 선택 | 327, 718, 422 | 330, 402, 416 | 목표 미달·물리 터치 미측정 |
| 패널 | 286, 292, 407 | 305, 204, 312 | 목표 미달·물리 터치 미측정 |

- 이 증거의 `diagnosticOnly=false`는 당시 메타데이터에 predecoratedPair를 포함하지 않은 표기 오류다. 실제 실행은 각3회 **진단**이며 이후 기록 필드를 바로잡았다. 수치 재실행/정식30회 성공으로 소급 변경하지 않았다.
- 한 줄 수정 후 실제 Chrome의 `test-orderops-excel-cell-grid-browser.mjs`(업무셀 편집·Enter/화살표·행 테두리·대상 셀만 대체) 및 `test-orderops-theme-browser-e2e.mjs`(OrderOps 테마/인쇄·DataOps 페이지/전환) PASS. U06 실제 workbook, U19/U22 pure 계약, 일반0/총량0/미확인 표시 검사 PASS. 화면/인쇄 table class의 실제 템플릿도 별도 assertion으로 보존한다.
- 상세 추적/전송 재시도/변경 호출 계측 코드는 제품/필수 CI 하네스에서 제거하고 `artifacts/orderops-v12/diagnostic-instrumentation-75733568.patch`, `audit-layout-mutations.js`로 분리했다. 기존 trace·GPU 원본·실패 증거·최종 전후 원본은 그대로 보존한다. 시험용 paired 비교·패널 초기화·DOM 규모/시작 폭 메타데이터만 재현 가능한 하네스에 유지한다.
- **남음: 성능 PM-F03, 안정 후보의 정식 30회 p95, 물리 터치·실제 사용자 환경, PM 최종 결과 판정 및 운영 검증.** 동일 CSS/구조 후보나 상세 추적을 추가 확대하지 않는다. 후속 검수 후보 SHA와 필수 CI는 PR/PM 제출 메시지에서 확정한다.

## 현재 제출 상태 (2026-09-12, `40c2fdb2` 이후 검사 보정)

- PR: https://github.com/orderzoneapp-coder/oneapp/pull/589 (Draft 유지). 기준 원격 main은 `a5eeb19ca3ae104f66c86dc5b6b9b63df501d41c`로 재확인했다. 공통헤더·호스트·SmartInput 제품 소스 변경 없음.
- `40c2fdb2c518283856975ebe2783d66b7425c82a` CI [34695427021](https://github.com/orderzoneapp-coder/oneapp/actions/runs/34695427021)는 workbench/Phase 6B/SmartInput initial 세 job 성공, repository job 실패다. 실패는 일반 수량 0을 공란으로 표시하는 **정적 문자열 검사**가 TOTAL_ONLY의 실제 0 표시 예외를 허용하지 못한 것이다. 실제 제품 표시식을 실행하여 일반 0→공란 / 총량비교 0→0 / 미확인→미확인을 확인하도록 보정했고 로컬 검사 PASS했다. 필수 CI 우회나 기능 assertion 삭제는 없다. 새 head의 전체 CI 결과는 별도로 제출한다.
- workbench CI artifact `ci-40c2fdb2/browser-result.json`: 2026-09-12 13:05:07~13:05:29 UTC, clean merge-test HEAD `92e7746e3dd87c40575d97a122dbe5175d37be8c`. PR head 자체와 구분하며 제품 파일 SHA256 및 전체 성공 로그를 보존한다. U29는 실제 호스트의 준비/충돌 이동 차단과 DataOps→브라우저 이력 복귀, 직원 적요·단가·orderId·returnTo·focus를 확인했다. PM은 해당 소스 assertion과 CI 원문 **증거 대조**를 통과시켰으며 독립 운영 브라우저 통과로 확대하지 않는다.
- 완전한 표 2개를 문서에 동시에 유지하는 실험은 실제 reuse hit에도 주문 2.2~4.5초, 재고 2.1~3.7초로 개선되지 않아 폐기했다. `resident-surface-trial.patch`, `diagnostic-resident-hits`에 보존했으며 제품 소스에서 제거했다. 현재 제품은 한 표만 연결하는 기존 detached cache 방식이다.
- 입력 셀 내부 block의 `content-visibility:auto`는 **시험 HTTP 응답에만** 주입했다. 첫 3회 진단도 주문 2.7~3.3초, 재고 약3.7초로 미달이다. 이어 같은 Chrome/프로필/1366×768/500행·10창고에서 전후 각 3회를 `diagnostic-cell-pair-final`에 기록했다. 미주입 주문 `[2210,2135,1977]`ms / 재고 `[3101,3346,1554]`ms, 주입 주문 `[3062,1491,1675]`ms / 재고 `[3991,2163,1879]`ms다. 초기 전체 표시는 5483→4057ms지만 전환에 일관된 개선이 없고 여전히 목표 미달이다. 첫 표시·재전환·동기 JS·원시 샘플·시각·응답 hash와 실제 응답 HTML을 보존했다. 이 후보도 채택하지 않으며 같은 CSS 값 조정이나 30회 실패 시험으로 확장하지 않는다. 운영 반영 없음.
- `browser-result.json.result`는 실행 성공 여부다. 후속 성능 증거는 별도 `performanceVerdict`로 `not-met`, `diagnostic-only` 등을 명시하여 시험 실행 성공을 성능 통과로 오해하지 않게 했다. 과거 원시 증거는 덮어쓰지 않는다.

## 2026-09-12 추가 자체검증 (초안 head `8b0a6df` 이후)

- PM-F08: 재고 단독 적용 시 시작 시점 parsed를 복제하고 진행 Promise를 이탈 경계에 공개한다. 적용 중 새 매핑/포함 선택은 이전 성공으로 지우지 않는다. 준비 지우기·중복 적용만 보호하고 현재 작업 입력과 준비 편집은 유지한다.
- 실제 Chrome + 기존 재고 적용/IndexedDB 경로에서 digest 대기를 주입하여 시작행·포함 여부·시트 변경, 성공/실패/새 버전 재적용, dirty 이탈 차단을 확인했다. `ORDEROPS_PREPARATION=1 node scripts/test-orderops-workbench-browser.mjs` PASS.
- 같은 브라우저 fixture로 U05 구매/판매 단독 원문 조회, U07~U11 복수 시트/선택별 매핑 보존/같은 종류 차단/오류 배치 전체 미적용/오류 제거 후 적용을 확인했다. U13 준비 항목 제거·재고 사용해제는 주문을 유지하고 초기화는 복구 clear를 호출하지 않으며 출처별 마지막 확정본을 유지했다. 초기화 직전 최신 저장에 따른 **기존 자동저장 보유 수 제한 정리**는 별개로 유지한다.
- 첫 PR CI의 4개 job 중 3개 성공, repository contracts는 TOTAL_ONLY 비교 7/2가 기존 주문현황 전환 후 보이지 않는 문제로 실패했다. 주문현황에 가짜 창고 대신 읽기 전용 총재고/비교잔량을 표시하고 TOTAL_ONLY 재고현황도 총량 비교를 사용하도록 보완했다. 관련 `test-orderops-common-inventory-browser.mjs` PASS. 전체 새 CI는 다음 head에서 다시 확인한다.
- 성능 진단: 500행 기준 `getPreviewDefinitions` 1회 약 410~450ms, 중복 정의 생성과 기존 readiness 추가 구성을 정리했다. 그러나 총 표시 지연은 여전히 수초로 **미통과**이며 공통 표 장식은 약 20~30ms여서 지배 원인으로 단정하지 않는다. 개선이 검증되지 않은 containment는 제거했다. 준비된 자료의 30회 최종 비교·U29 iframe 추가 조합·공통 영향 최종 검증은 남아 있다.

### U29 및 렌더 진단 추가 (후속 head)

- 실제 `nexus/workspace.html` + 실제 OrderOps/DataOps를 사용한 격리 브라우저에서 미적용 준비 파일·실제 B/W/N 충돌창 대기/취소는 부모 URL과 iframe을 유지했다. DataOps 이동 후 **브라우저 뒤로가기**로 주문 경로에 복귀하면 직원 적요·단가·orderId가 보존됐다. 앱 탭 클릭의 새 canonical 기본 진입과 구분하며 공통헤더/호스트를 변경하지 않았다. `orderops-workbench-host.js`를 필수 브라우저 시험에 포함했다.
- 같은 전체 브라우저 실행에서 U06 실제 다운로드, U19 명령/기출고 보호, U22 이력·적요·대체·Cloud 및 두 번의 프로세스 종료 복구도 PASS했다. Excel-grid와 테마/인쇄, operator-flow 관련 회귀 PASS. 소스 정적 자동 기본보기 assertion은 사전 계산 정의를 넘기는 동일 기능 호출에 맞게 갱신했다.
- 정의 재사용은 workspace 객체 동일성만 신뢰하지 않고 **전체 작업 JSON·출고 초안·순기출고·원본 Snapshot·창고 필터·발주 범위**를 비교한다. 값이 바뀌면 재생성하고 F10 최종 선정 함수는 별도로 현재 작업본에서 계산한다. DOM은 전체 표 두 개까지만 보관하며 한 개만 연결하고 입력 변경 시 폐기한다. 행 생략/가상화·새 공통 엔진 없음. Intl 숫자 포맷터도 재사용한다.
- 500행 정의 조회는 단회 진단 약23ms로 줄었지만, 짧은 3회 표시 진단은 주문 1.8~2.6초 / 재고 2.0~3.1초로 여전히 성능 미통과다. 30회 최종 수치가 아니다. 테두리 분리 실험은 개선이 불명하여 제거했다. 더 큰 렌더 표면 변경은 PM에게 경계를 보고했다.
- 브라우저 실행은 이제 `browser-result.json`에 시작/종료 시각·Git HEAD·dirty 상태·제품 파일 SHA256·Chrome/Node 버전·전체 성공 로그/실패 사유를 기록하여 CI artifact와 함께 제출한다. 이전 미커밋 로그를 새 head 증거로 대체하지 않는다.

이 문서는 개발자의 직접 확인 기록이며 기획자 명세 통과나 독립 PM 결과 검증을 대신하지 않는다. 승인 명세 원문은 [v1.2](orderops-workbench-v12-approved-spec.md), 착수/승인·역할 기록은 [진행 기록](orderops-workbench-v12-progress.md)이다.

## 기준과 책임

- 기준 main/HEAD: `a5eeb19ca3ae104f66c86dc5b6b9b63df501d41c` (PR #587). 재확인 결과 동일.
- 개발 브랜치: `codex/orderops-workbench-v12-20260912`.
- 개발 경로: `C:/Users/USER/Documents/ChatGPT/검증 PM/work/oneapp-orderops-workbench-v12-20260912`.
- 독립 PM: 「출고관리 UI 고도화 검증 관리」, task `01a09574-fb70-7e02-adc7-6b1ce8ea490e` / local.
- 승인: 사용자가 기획자 검증 통과 v1.2 구현·자체검증·PR 제출을 지시. **PM이 통과한 최종 head에 한해서** 개발자가 병합·배포·기술 확인한다.
- PR/최종 commit/CI 결과는 제출 시 갱신한다. 현재 작업은 운영 반영되지 않았다.

## 변경·유지 경계

| 구분 | 내용 |
|---|---|
| 이동 | 파일 준비/매핑은 왼쪽, 기존 배송 조회/담당 수정과 선택행 편집은 오른쪽, 6개 현황 전환은 앱헤더, 저장/다음 업무는 중앙 내부 하단바 |
| 유지 | 기존 allocations 열 key·편집/대체/합계·필터·정렬·색상, 주문/재고 원문, 일반/직원 적요 분리, 실제출고 단일 초안, append-only 확정/취소, Cloud revision 및 로컬 복구 |
| 정리 | readiness 별도 기본 화면 제거(이전 진입/복구 식별자는 기존 주문현황으로 연결), 보조 패널 중첩 제거, 팝업을 clipping 밖으로 이동 |
| 신규 | 명시 헤더/시작행/열 매핑과 원셀 증거, 일괄 후보 적용, B/W/N 충돌 선택·기록, 삭제행/초안 보관, 최종 후보 원자 게시, 실제/작업 창고·담당 불일치 확정 차단 |
| F10 최소 수정 | `getFinalPurchaseUploadSelection()`을 화면/통합·개별 구매업로드/안내가 공통 사용. 기존 재고 매칭·단위/기준일·대체·소분 제외 유지. 구매업로드 대상/수량 이외 양식·다른 시트 불변 |
| 공통 영향 | `nexus-workbench-layout-v2.js`의 leftOpen 폭/handle/dataset 보완, OrderOps compact/desktop 폭 분리. 성능 진단에 따라 동일 속성 쓰기와 관계없는 표 mutation 재배치 억제. 다른 다섯 앱의 회귀 갱신 필요 |
| 제외 | 공통 글로벌헤더·호스트, SmartInput 제품 소스, `orderops_list.html`, ORDER Q 원장/서버 schema, 원본 개정 승인/자동 출고 취소·재개 정책 |

공통 패널 수정은 ‘OrderOps 전용 분기만’이 아니다. 다른 다섯 앱은 좌측 상시 노출 계약을 유지하므로 원래 폭 계산을 유지해야 하며 U33으로 검증한다.

## 직접 기능 증거

환경: Windows, Node 24.19.0, headless Chrome, localhost, 매 실행 새 임시 프로필. 합성 주문/상품/재고 및 해당 프로필의 격리 IndexedDB. Cloud는 브라우저의 실제 UI 경로를 사용하되 fetch 응답만 메모리 fixture로 대체했다. 실제 운영 주문/Cloud/Revision/출고결과 쓰기는 없다.

| 핵심 조건 | 기대와 직접 관찰 |
|---|---|
| U06-a/b | 주문 10 / 다른 창고 재고 20은 제외, 4는 구매 6. 실제 화면 F10 버튼 다운로드를 다시 열어 구매업로드 1행·수량 6, 충분 재고 상품 제외를 확인. 화면 안내도 구매업로드 1행 |
| U06-c | 재고 미확인·단위 불일치·대체/소분·TOTAL_ONLY·분석 전·기준일 미확정은 정상 업로드에서 제외. 활성 원문/이력 JSON 불변 검사 |
| U06-d | 고정 기준판 workbook과 개발판의 실제 SheetJS workbook 대조. 시트 이름/순서, 구매업로드 헤더·서식·수량 외 필드, 모든 다른 시트 전체가 동일 |
| U19-a/b | 혼합/작업-원본 차이는 guard로 차단. 확정 전 owner의 전체 창고/담당 변경 후 최신 적용은 실제 격리 확정 가능, 생성 문서 창고 `1창고`·담당 `담당2` 일치 |
| U19-c/d | 실제 확정 4 → 같은 commandId 재시도 중복 없음 → 추가 2로 순기출고 6. 이후 owner 창고/담당 변경·최신 적용에도 기존 문서 불변, REVIEW_REQUIRED 유지·우회 명령도 차단 |
| U19-e | 기존 shipment-conflict 브라우저의 경합/명시 취소·복구 회귀, pure guard의 조회 ERROR 차단. 변경 후 조건 검증을 최종 CI와 대조 |
| U22-a/b | 대체 ALT·단가·일반/직원 적요·구매·0/공란 초안·이력 보존. 실제 B/W/N 팝업의 취소는 현재 작업 유지, 필수 선택 후 채택값과 결정 이력 저장 |
| U22-c | 삭제행의 원문/작업/초안은 미적용 작업으로 유지. pure 검사에서 안전한 ID 연결, 중복 sourceLineKey 미연결, 대상 0 처리 |
| U22-d | STAGED put 뒤 직원 적요 수정은 후보 재생성으로 최신 입력 반영. 최종 PUBLISHED put 이벤트 중 단가 수정은 transaction abort 후 현재 최신 입력 유지 |
| U22-e | 최종 put 실패는 기존 작업 유지. STAGED 직후 실제 Chrome 프로세스를 종료하고 동일 프로필 재시작 시 미확정 후보 제외·이전 확정 전체 복구. 복구 후 다시 프로세스 종료해도 적요/삭제행/재고 유지. reload 증거와 구분 |
| U22-f/U24 | 실제 IndexedDB payload와 지원 F8 UI의 모의 Cloud save/get round-trip에서 orders·substitutionHistory·systemHistory·shipmentExecutionDraft·workbenchReconciliation·workbenchUnapplied 동일. Cloud 저장 중 추가 입력은 보존되고 별도 미저장 안내 |

핵심 명령:

```text
node scripts/test-orderops-workbench-purchase-selection.mjs
node scripts/test-orderops-workbench-contract.mjs
node scripts/test-orderops-workbench-browser.mjs
node scripts/test-orderops-pr544-operator-flow-browser.mjs
node scripts/test-orderops-shipment-conflict-browser.mjs
node scripts/test-orderops-common-inventory-browser.mjs
node scripts/test-orderops-excel-cell-grid-browser.mjs
node scripts/test-orderops-theme-browser-e2e.mjs
node scripts/test-shipping-management.mjs
node scripts/test-orderops-operations-improvements.mjs
```

## 전체 인수 항목 상태표

‘부분’은 상위 항목 전체 통과가 아니다. 최종 head 및 공통 성능 보완 이후 영향을 받는 검사는 다시 대조한다.

| ID | 자체 증거/상태 |
|---|---|
| U01~U04 | 신규 workbench 브라우저 + 기존 operator-flow 브라우저. 3개 형제 패널·중앙 하단바·기존 full allocations·분석 전 표시/메모 분리 확인. 7573356 전체 CI 통과, 한 줄 후보 이후 필수 CI 별도 대조 |
| U05 | 재고 단독 기존 회귀 및 새 준비 경로의 구매/판매 단독 원문 조회, 계산 불가 사유 확인. 신규 workbench CI 포함 |
| U06 | 위 a~d 직접 검증. 실제 파일/메모리 worksheet/화면 안내를 구분 |
| U07~U11 | 명시 구조/열 충돌의 pure 및 실제 파일 UI, 원셀 보존. 여러 시트/매핑 보존/같은 종류 복수 후보 차단/혼합 오류 전체 미적용과 수정 후 재적용을 신규 workbench CI에서 확인 |
| U12~U13 | 후보 경합/실패/종료, 준비 파일 사용해제·초기화 시 복구 clear 없음·출처별 최근 확정본 보존을 실제 브라우저 확인. PM-F08의 적용 중 준비 변경 보존도 개별 PM 대조 통과 |
| U14~U16 | 1920/1366/1024/819/640/639/390 viewport에서 pane 위치·하단바·가로 스크롤·손잡이 및 기존 operator-flow의 재열기/폭 보존 확인. 공통 변경 후 7573356 전체 CI 통과 |
| U17~U18 | 거래처 코드별 전체 담당 변경·창고/지역 범위 담당 건수·필터 유지, 우측 대상별 입력 보존 확인 |
| U19~U22 | 위 세부 증거 및 기존 명령 adapter/브라우저. pure만 확인한 identity 변형과 실제 브라우저 사례를 구분 |
| U23~U25 | TOTAL_ONLY 기존 common-inventory 브라우저, F8 모의 Cloud 추가 입력/복구, 출고 충돌/멱등성/실패. 실운영 Cloud 쓰기는 미검증 |
| U26~U28 | 실제 F10 다운로드 + 기준 workbook 대조. operator-flow/theme/Excel-grid 브라우저의 F9 취소/흰색/필터·입력/스크롤·단축키 계약. 물리 프린터/실제 하드웨어 IME·터치는 미검증 |
| U29 | 실제 host에서 미적용 준비/충돌 대기·취소의 이동 차단, 실제 DataOps 이동 후 history 복귀와 최신 입력·주문 경로 보존을 동일 CI에서 확인. PM 소스/CI 증거 대조 통과. 앱 탭의 새 기본 진입 정책 변경 없음 |
| U30~U32 | 기존 portal 메뉴/바깥 클릭/Escape·테마 시험과 대표 viewport 화면 증거. 125%는 819 CSS px 대응(1024/1.25)이며 OS의 실제 확대 조작과 구분 |
| U33 | SmartInput/공통헤더 제품 diff 없음. 공통 패널 변경 후 다른 다섯 앱·헤더·호스트 포함 7573356 필수 CI 통과. 실제 사용자 운영환경 미검증 |

## 성능 — 미통과

`ORDEROPS_PERFORMANCE=1 node scripts/test-orderops-workbench-browser.mjs`는 동일 장비/프로필/localhost에서 기준판과 개발판, 주문 100/500/2000 및 창고 3/10열, 현황 전환/행 선택/패널 동작별 30회를 계측한다. 실제 선택 행/state/class와 패널 requested 상태/폭을 검증한다. 표시 지표는 동작 이후 다음 두 animation frame 및 검색 입력 가능 시점이다. **물리 터치의 시각 피드백 p95를 측정한 것은 아니다.**

초기 기준판 100행 p95 현황 약 1초, 개발판 단독 500행 진단 1회 약 4초로 500ms 목표에 미달했다. 30회 최종 결과로 사용하지 않는다. V8 profile에서 렌더링/레이아웃 read의 큰 비용을 확인했다. 공통 패널의 동일 값 반복 쓰기·표 mutation 재배치 억제와 정의/Intl 재사용은 유지했지만 실제 프레임 목표 충족으로 이어지지는 않았다. strict containment·row content-visibility·분리 테두리·resident table은 효과가 없어 제거했다. 남은 비용을 특정하는 기술 판단 전 추가 구조 변경이나 목표 완화는 하지 않는다. 안정된 후보의 최종 30회 비교와 물리 터치 피드백 범위는 미완료이다.

## 로그·그림·출력 위치

- 루트: `C:/Users/USER/Documents/ChatGPT/검증 PM/artifacts/orderops-v12` (개발 worktree 바깥).
- 대표 PNG: `orderops-1366.png`, `orderops-819.png`, `orderops-390.png`.
- 실제 다운로드 재검산본: `U06-F10-synthetic.xlsx`.
- 최초 필수 검사 기록: `required/summary.json`, `required-other/summary.json` 및 각 로그. 최초 실패를 그대로 남겼으므로 이 목록만으로 최종 통과를 판정하면 안 된다. 이후 독립 재실행 결과는 도구 세션 출력/최종 CI와 대조한다.
- 통과 세션 예: 신규 브라우저 `99894` exit 0, 기존 operator-flow `34527` exit 0, unresolved-review `42609` exit 0, SmartInput template `3748` exit 0. 당시 미커밋 소스이므로 이것을 이후 커밋 전체의 완결 증거로 확대하지 않는다.
- 최종 커밋은 GitHub CI 로그/업로드 artifact와 매칭하며 테스트 재실행 시 소스 hash와 시작/종료 시각을 함께 기록한다.

## 배포·미검증·롤백

Draft PR은 진행 공유용이며 최종 PM 검증 요청이 아니다. 성능 및 남은 인수시험/필수 CI → 최종 head PM 결과 검증 → 통과 버전 병합 → Pages 성공 및 배포 파일 hash/SHA 확인 → PM 운영 검증 순서이다. 운영 브라우저·실제 서버 쓰기·사용자 실무 확인은 아직 수행하지 않았다.

코드 롤백은 해당 PR revert와 Pages 재배포다. ORDER Q 원본/Revision·출고 문서/보상 이력·Cloud 완료본·기존 로컬 확정 복구본은 삭제하지 않는다. 신규 STAGED 후보는 정상 복구 대상에서 계속 제외되어야 한다. 임의 플래그 해제로 부분출고를 재개하지 않는다.
