# NEXUS-SMARTINPUT-ERP-ORDER-BUSINESS-KEY-20260905 작업 기록

## 시작 기준

- 사용자 실행 승인: `쇼핑몰 주문업로드에도 문제없을듯한다 개발 진행해`
- 확정 규칙: 주문 전표는 `주문참조번호(발주No./구매No./일자-No.) → 창고코드 → 거래처코드 → 거래유형` 우선순위로 확인하고 네 값이 같을 때 한 전표로 묶는다.
- 제외 규칙: `UPLOAD_SER_NO`, `sourceVoucherIndex`, 화면 행번호, 원본의 연속 배치는 주문 전표 그룹키와 중복 판정 변수로 사용하지 않는다.
- `일자-No.`는 원문 전체를 주문참조번호로 보존하고 날짜만 주문일·납기일로 파생한다. 뒤 숫자는 별도 내부 순번으로 만들지 않는다.
- 기준 `origin/main`: `bf20694666dabe8802c042f81baf5ca914c4a83e`
- 브랜치: `codex/smartinput-erp-voucher-key-20260905`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-erp-voucher-key-20260905`
- 시작 상태: clean
- 확인 규범: `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md`, `app-manifest.json` schema v1.3.11, `orderq/ARCHITECTURE.md`, `smartinput/README.md`

## 현재 상태와 이슈

- 일반 주문 다중전표 그룹키는 한 업로드 안에서도 `sourceDocumentKey/sourceVoucherIndex/manualSplitKey`와 행 연속성으로 분리될 수 있고 거래유형은 포함하지 않아 확정된 ERP 업무키와 다르다.
- 주문 매핑 후보에는 같은 업무 의미가 상단 정보·작업테이블·기준정보 필드로 중복 노출된다. 이는 구현 저장 위치를 사용자 업무 구분처럼 노출한 것으로, 주문 입력의 `상단 정보 / 하단 정보` 2구역 원칙과 맞지 않는다.
- 쇼핑몰 exact 17열 업로드는 ORDER Q owner의 별도 공개 command adapter와 실제 원장 signature를 사용하고, `UPLOAD_SER_NO/sourceVoucherIndex`를 중복 판정키로 사용하지 않는다.

## 목표 구현

1. 한 번의 업로드를 안전한 작업 경계로 유지하고, 그 안의 주문 전표 그룹키를 네 가지 ERP 업무키로 구성한다. 같은 거래처의 행은 목록 순서와 무관하게 모은 뒤 같은 업무키의 비연속 행을 한 전표로 묶으며, 순번·행번호·원본문서키로 분리하지 않는다. 서로 다른 업로드 작업은 자동으로 교차 병합하지 않는다.
2. 거래유형은 행별 입력값을 지원하고 그룹키 및 저장 payload에 반영한다. 같은 주문참조번호라도 네 업무키 중 하나가 다르면 별도 전표로 나눈다.
3. 그룹키에서 제외된 주문일·납기일 등 상단 값이 한 전표 안에서 충돌하면 첫 값을 임의 채택하지 않고 해당 전표 전체를 확인 필요로 차단한다.
4. 주문 입력 매핑 화면은 사용자 기준으로 `상단 정보 / 하단 정보`만 표시한다. 동일 projection의 중복 후보와 주문의 내부 순번·수동 분할 후보는 선택 목록에서 제외하되 기존 저장 양식 호환 판독은 유지한다.
5. 쇼핑몰 exact 17열 업로드와 실제 원장 중복 제외 알고리즘은 변경하지 않는다. 동일 주문 occurrence count, unresolved owner 0-write, 후보별 격리 저장을 전체 회귀로 확인한다.

## 변경 금지와 경계

- ORDER Q의 쇼핑몰 실제원장 signature, DB v7 schema/Store/key/index/version/migration/reset을 변경하지 않는다.
- SmartInput DB v5 schema/Store/key, 공식전표 V2, 재고, 채권·채무, 기준정보 소유권, 공통 Runtime, Cloud gate를 변경하지 않는다.
- 승인된 매핑 명칭 정리 외 전체 레이아웃·기존 버튼·단축키·정상 작업 흐름을 바꾸지 않는다.
- 원본 셀 값·순서·주소·raw/formula/format, `sourceMatrix`, 양식 signature와 `일자-No.` 원문을 그대로 보존한다.

## 검증 계획

- 한 업로드 안의 같은 네 업무키 비연속 행 병합, 순번·원본문서키·manual split 변화 무시, 다른 업로드 경계 유지, 네 업무키 각각의 차이 분리, 거래유형 행값 저장을 순수 회귀로 고정한다.
- 같은 업무키 안의 주문일·납기일 충돌은 전표 전체 저장 차단, 정상 전표는 격리 저장되는지 확인한다.
- 주문 매핑 picker가 상단/하단 두 구역만 노출하고 창고 등 동일 의미 후보를 한 번만 제시하며 기존 저장 양식은 다시 열 수 있는지 확인한다.
- 쇼핑몰 실제 XLS 17열 경로, 중복 occurrence `1+2→1`, `2+2→0`, `1+3→2`, owner 미해소·금액 불일치·경계 불명확 0-write 회귀를 확인한다.
- 전체 SmartInput/ORDER Q 테스트, 브라우저 light/dark·1920/1440/390, repository validator, client safety, syntax, `git diff --check`를 수행한다.

## 롤백

- 이 작업의 단일 목적 commit 또는 향후 merge commit을 revert한다.
- schema와 migration이 없으므로 데이터 삭제·복원은 수행하지 않는다.

## 구현 결과

- 주문서용 행 상단 값에 `거래유형`을 추가하고 엑셀 항목명 `거래유형/거래구분`을 매핑할 수 있게 했다.
- 한 업로드 안의 주문 그룹키는 `주문참조번호 → 창고코드 → 거래처 식별값 → 거래유형` 순서로 생성한다. 원본 행이 떨어져 있어도 네 업무키가 같으면 같은 전표로 모은다.
- 주문 그룹키와 새 매핑 후보에서 `원본문서키`, `원본전표순번`, `전표분리키`를 제외했다. 구매·판매·견적의 기존 source partition 계약은 변경하지 않았다.
- 주문일·납기일·창고 owner ID처럼 그룹키 밖의 상단 값이 같은 그룹 안에서 충돌하면 `REVIEW_REQUIRED`로 전표 전체를 저장 차단한다.
- 매핑 후보는 projection이 같은 내부 필드를 한 개의 업무 항목으로 합치고 `상단 정보/하단 정보` 두 구역만 표시한다. 기존 양식이 숨겨진 과거 target ID를 사용하면 읽기·재열기 호환을 유지하고, 새 대상을 선택할 때 정리한다.
- SmartInput 자산은 `smartinput.js?v=0.11.23`, 다중전표 모듈은 `v0.2.1`로 cache-bust했다.

## 기술 이슈와 처리

- 최초 전체 Chromium 회귀에서 붙여넣기 취소 직후 이전 행을 읽는 시나리오가 한 차례 불일치했다. 같은 test를 단독 재실행하고 전체 재실행한 결과 수정 없이 통과해 일시적인 브라우저 상태/타이밍으로 판정했다.
- cache-bust 뒤 독립복구·설정 UX 테스트 두 곳이 이전 `0.11.22`를 고정하고 있어 실패했다. 생산 기능 문제가 아니며 기대 버전을 `0.11.23`으로 함께 갱신했다.
- 의도적인 SmartInput JS와 HTML 변경 때문에 Phase 6B 승인 UI 해시가 달라졌다. 공통 theme token 정규화 규칙을 유지한 채 현재 작업 산출물의 index/JS 해시를 새 기준으로 고정하고 CSS 불변 해시는 그대로 유지했다.

## 검증 결과

- `scripts/test-orderq*.mjs` 및 `scripts/test-smartinput*.mjs` 총 61개를 순차 실행해 모두 통과했다. 캐시 계약 보완 뒤 중단 지점부터 재실행해 나머지 전 범위도 통과했다.
- 주문 집중 회귀: 비연속 동일 업무키 병합, 다른 업로드 분리, 주문번호·창고·거래처·거래유형 각각의 차이 분리, 내부 순번·원본문서키·수동 분리키 무시, 날짜 충돌 전표 전체 보류, `일자-No.` 원문과 거래유형·창고 payload 보존이 통과했다.
- 매핑 브라우저 회귀: 거래처명과 창고코드가 각각 하나의 업무 후보로 표시되고 `상단 정보/하단 정보` 외 구현 구역이 노출되지 않으며 과거 target ID 투영 호환이 유지됐다.
- 쇼핑몰 실제 파일 회귀: `orderlist-260904.xls` 14행·5후보·수량 24·금액 288,400·검증오류 0, 누적 12,301행의 최신 14행 canonical 동일, occurrence `1+2→1`, `2+2→0`, `1+3→2`가 통과했다.
- 브라우저 회귀: 1920/1440/390 light/dark, F3 목록 검색, 원본형/입력형, 설정, 연동견적 원본선택, 쇼핑몰 후보 저장 격리와 console/runtime error 0이 통과했다.
- repository validator `24 checks, 0 warnings`, client safety, 변경 JS 문법검사, `git diff --check`가 통과했다.

## 데이터·소유권 결과

- 쇼핑몰 exact 17열 업로드는 기존 ORDER Q 공개 command adapter와 실제원장 중복 signature를 그대로 사용하며 이번 일반 주문 그룹키를 사용하지 않는다.
- DB schema/Store/key/index/version/migration/reset, SmartInput Draft 저장계약, 공식전표 V2, 재고, 채권·채무, 기준정보 owner, 공통 Runtime, Cloud gate 변경은 없다.
- 테스트는 격리 데이터로 수행했고 운영 주문·전표·재고·채권/채무 write는 0건이다.

## 병합 조건

- PM 독립검증 전 병합·배포하지 않는다.
- PM은 exact PR head에서 주문 그룹키 우선순위, 순번·행 위치 배제, 상단 충돌 fail-closed, 기존 양식 호환, 쇼핑몰 중복 제외 불변과 전체 CI를 재검증한다.
