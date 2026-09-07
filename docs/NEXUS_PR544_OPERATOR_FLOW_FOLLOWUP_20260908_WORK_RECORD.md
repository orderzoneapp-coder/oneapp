# PR #544 주문·출고 작업자 흐름 후속 작업 기록

- 작업일: 2026-09-08 (Asia/Seoul)
- 저장소: `orderzoneapp-coder/oneapp`
- 기준 브랜치/SHA: `origin/main` / `005a8d1dccdffb7e670dedb4358dbe7e9a70a378`
- 작업 브랜치: `codex/pr544-operator-flow-fix-20260908`
- 전용 작업트리: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-pr544-operator-flow-fix-20260908`
- 선행 PR: #544, merge `247bcbbd085986edb6e76a66af0bd564c2682235`
- 개발 분류: 중요 개발 (ORDER Q와 OrderOps의 앱 간 읽기 계약, 출고 결과 append-only 계약 및 Revision 검증 영향)

## 확인 문서

- 최신 `AGENTS.md` v2.3.4
- `roles/DEVELOPER.md`, `roles/PM.md`
- `APP_ARCHITECTURE.md`, `app-manifest.json`, `orderq/ARCHITECTURE.md`
- `evidence/order-shipment-pipeline-v1.1/development-record.md`
- 사용자 첨부 `pasted-text.txt`의 `PR #544 후속 수정 — Codex 인수인계서`

사용자가 언급한 ZIP과 `00_START_HERE.md`, `01_PR544_CODEX_HANDOFF.md`, `02_ACCEPTANCE_TESTS.md`, 원본 개발명세서 v1.1은 현재 첨부 폴더, 저장소 및 접근 가능한 최근 작업 기록에서 발견되지 않았다. 존재하지 않는 패치를 추정 적용하지 않고, 제공된 상세 인수인계에서 확정된 A~D와 현재 소스의 재현 결과를 기준으로 작업한다.

## 현재 상태와 목표

현재 PR #544는 ORDER Q 주문의 immutable 출고 후보, OrderOps 직접 진입, 별도 출고 결과 저장소, Revision/hash 재검증을 제공한다. 그러나 일반 진입의 저장 주문 선택, 분석 작업표와 확정표 사이 실제 출고수량 전달, 주문 변경/읽기 오류 복구 선택지가 부족하다.

목표는 다음 네 항목이다.

1. 주문조회 상단 보조 기능을 `운영 도구`로 묶어 주 업무와 구분한다.
2. 출고관리 일반 진입에서도 저장된 출고 가능 주문을 검색·선택한다.
3. 분석 작업표의 실제 배정수량을 출고 확정표 기본값으로 전달하고 주문수량·남은수량·실제출고수량 역할을 분리한다.
4. NOT_FOUND/ERROR/주문 변경에서 현재 작업을 보존하면서 복귀·재시도·최신 주문 적용·현재 작업 유지 선택을 제공하고, 확정 직전 Revision/hash 차단은 유지한다.

## 보존 계약과 제외 범위

- 창고재고 Excel은 계속 필수다.
- 기존 주문현황 Excel 수동 입력, 구매/판매 Excel, 출력, 로컬 복구, Cloud 발주계획 경로를 유지한다.
- ORDER Q는 주문 원본의 유일 소유자이며 OrderOps는 공개 read adapter만 사용한다.
- OrderOps 출고 결과 DB는 append-only 소유권과 Revision/hash 검증을 유지한다.
- DB schema/Store/version/migration/reset, ERP API, 판매전표 직접 등록, 출고 Cloud 동기화, 신규 업무정책은 추가하지 않는다.
- 기존 사용자 checkout의 미커밋 변경은 수정·정리·reset하지 않는다.

## 구현 전 재현 결과

- A: `orderq/index.html` 상단에 이력수집·클라우드·ORDER IN·ORDER Q 운영이 같은 수준으로 펼쳐져 있다.
- B: `orderops/list.html`은 `?orderId=`가 있을 때만 주문을 읽으며 일반 진입에서 `listShipmentOrderCandidates()`를 사용하는 UI가 없다.
- C: 분석 결과의 작업표 수량은 `state.workspace.orders`에 있으나 확정표는 남은 주문수량을 기본 출고수량으로 다시 채워 실제 작업 결과가 전달되지 않는다.
- D: 실패는 토스트/문구만 표시하고 주문조회 복귀, 읽기 재시도, 최신 주문 적용/현재 작업 유지 동작이 없다. Revision/hash 기반 stale 확정 차단 자체는 이미 구현되어 보존한다.

## 검증 계획

- 순수 계약 테스트: 후보 목록·선택, 작업표→확정표 수량 전달, 안전한 행 매칭, 초과/부분출고, stale 차단
- 브라우저 작업자 흐름: 일반 진입 주문 선택, 창고재고 Excel 필수, 수량 10 중 6 확정, 남은 4 재진입, 주문 변경 후 입력 보존과 최신 주문 적용
- 회귀: ORDER Q 출고 read model, OrderOps source/result, 관련 브라우저, 저장소 validator/client safety

## 구현 결과

- A: 주문조회 상단의 이력수집·클라우드·ORDER IN·ORDER Q 운영을 접근 가능한 `운영 도구` 메뉴로 묶고 `+ 주문서 입력`은 주 작업으로 유지했다.
- B: 출고관리 일반 진입에 저장 주문 검색·선택·목록 새로고침·주문조회 복귀를 추가했다. 목록은 기존 bounded read adapter의 최근 최대 200건만 읽고, 성공적으로 읽은 주문만 현재 작업에 반영한다.
- C: ORDER Q 직접 연결 작업표에서 원본 `주문수량`은 읽기 전용으로 유지하고 별도 `실제출고` 입력을 추가했다. 동일 draft가 확정표의 `이번 실제 출고수량`으로 전달되며, 확정표에는 주문수량·기출고·남은 주문수량을 별도 표시한다. 수동 주문현황 Excel의 기존 `주문` 편집 계약은 유지했다.
- D: NOT_FOUND/EMPTY/ERROR에서 주문조회 복귀·목록 재시도·수동 Excel 대안을 표시하고 기존 화면 작업을 교체하지 않는다. 주문 변경 시 입력수량·사유를 보존하고 `최신 주문 적용`과 `현재 작업 유지`를 분리했다. 최신 적용은 `orderItemId` 우선, 양쪽에서 유일한 `sourceLineKey`만 보조 매칭하며 추가/삭제/중복 행을 임의 연결하지 않는다. 이전 Revision/hash의 확정은 UI와 command adapter 양쪽에서 계속 차단한다.

제외한 중복 구현은 선행 PR #544에 이미 있는 immutable 주문 snapshot, 별도 출고 결과 DB, append-only 결과/취소, idempotency, Revision/hash 재검증, 주문조회 출고상태 표시다.

## 이번 변경 검증 결과

- 실패 재현: 최초 `test-orderops-pr544-operator-flow-browser.mjs`에서 작업표 `6`이 확정표의 기존 `10`에 덮이는 실패를 확인하고 렌더 순서를 수정했다.
- 신규 순수 계약: 저장 주문 검색, 안전한 draft 행 재연결, 신규/삭제/중복 source line fail-closed, 주문 10 → 실제출고 6 → 잔량 4 `PASS`.
- 신규 브라우저 수락: 일반 진입 주문 검색/선택, 창고재고 Excel 필수, 작업표→확정표 6 전달, 부분출고/주문조회 상태, 주문 변경 후 수량·사유 유지, 최신 주문 적용, NOT_FOUND 복귀 `PASS`.
- ORDER Q·OrderOps 비브라우저 관련 회귀: 21개 스크립트 `PASS` (실제 쇼핑몰 XLS 전용 선택 검사는 로컬 파일 부재로 `SKIP`, 합성 회귀는 `PASS`).
- 관련 브라우저 회귀: 5개 스크립트 `PASS`.
- `scripts/validate-repository.mjs`: 24 checks, 0 warnings.
- client safety, common UI 18 pages, basic login/home 16 apps, shipping purchase-plan failure injection `PASS`.
- `scripts/test-shipping-management.mjs`: 실제 기준 fixture 83주문/274재고 포함 `PASS`.
- DB schema/Store/version/migration 변경 없음. ORDER Q/OrderOps 데이터 소유권과 창고재고 Excel 필수 계약 유지.

GitHub PR/CI/병합/배포 상태는 후속 커밋·Push 이후 exact SHA와 run을 추가 기록한다.
