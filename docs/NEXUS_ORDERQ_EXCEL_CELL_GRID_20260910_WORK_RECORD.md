# NEXUS ORDER Q Excel 셀 편집·이동 작업 기록

## 시작 기준

- 사용자 실행 승인: `단계를 테이블 교체부터하고 그 테이블에 맞게 이동기능 알고리즘 수정한다`
- 선행 승인 범위: 구현 완료 후 PR 병합과 운영 배포까지 일괄 진행
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main`: `28746a5a594aaf2966d7f510a8aff7434ee40979`
- 병합 전 최신화: `281e53d07fd9bd4c0e3303c8bc25dfd84553e0bc`(#554)의 주문현황 `정보 → 합계` 변경 위로 rebase하고 합계 열 의미를 유지
- 작업 브랜치: `codex/orderq-smart-grid-navigation-20260910`
- 시작 상태: 최신 원격과 같은 clean HEAD
- 확인 규범: `AGENTS.md` v3.0.0, `roles/DEVELOPER.md` v3.0.0, `APP_ARCHITECTURE.md` v2.2.1, `app-manifest.json`의 SmartInput·OrderOps·shipping workspace 계약

## 목적과 완료 조건

1. SmartInput 첫 열의 별도 번호·체크박스를 하나의 번호 선택 컨트롤로 합친다.
2. SmartInput과 ORDER Q의 현재 셀 행을 굵은 테두리로 식별한다.
3. ORDER Q 주문표는 품목코드·품명·규격을 고정 identity로 유지하고 업무정보 셀만 직접 수정한다.
4. Enter는 같은 열의 다음 행, Shift+Enter는 이전 행, 방향키는 인접 편집 셀로 이동하고 즉시 입력할 수 있어야 한다.
5. 대체출고는 `거래처 칩 선택 → Ctrl+대상 상품의 정보 셀 클릭`에서만 실행한다. 다른 셀·행 클릭은 데이터와 이력을 바꾸지 않는다.
6. 성공한 수정·이동은 기존 workspace 재계산·자동저장·이력 계약에 반영하고 기존 출고확정·복구·Excel 출력은 유지한다.

## 허용·금지 범위

- 허용: SmartInput 번호 선택 UI, ORDER Q 표 렌더링·키보드 탐색·대체출고 대상 판정, 기존 engine의 주문 업무정보 수정 API, 관련 테스트·아키텍처 문서·캐시 버전.
- 금지: 품목 identity 직접 수정, 공식 ORDER Q 원장 Store 구조·DB version·쓰기 소유권 변경, 기존 데이터 삭제·초기화, 행 전체를 암묵적 이동 대상으로 처리.

## 구현 결과

- SmartInput의 `No.`와 각 행번호를 29px 선택 컨트롤 안에 표시하고, 현재 셀 행과 다중 선택 행에 서로 다른 테두리를 적용했다. 원본 매핑표에도 같은 첫 열 계약을 적용했다.
- ORDER Q 주문표에서 창고·거래처·그룹·담당자·주문수량·단가·창고별 재고·전달사항·구매처를 직접 편집한다. 상품코드·품명·규격과 계산된 정보·잔량은 고정한다.
- 전달사항은 화면의 단일 셀을 다시 저장할 때 원본 `적요`·`적요1` 결합값을 하나의 최신 값으로 치환해 중복 표시를 방지한다.
- 모든 편집기는 `data-grid-row-key`와 `data-grid-column`으로 좌표를 식별한다. 값 반영과 workspace 재계산 뒤에도 같은 좌표 또는 요청한 인접 좌표로 포커스를 복원한다.
- 실제 값이 바뀐 업무정보 셀은 `shipping-system-history/v1`에 필드·변경 전후 값·작업자·시각을 추가하고 재고표 시스템 메시지로 투영한다. 포커스·선택·같은 값 재확정은 기록하지 않는다.
- 대체출고 대상 속성을 재고표 `정보` 셀에만 부여했다. Ctrl+다른 셀·행 클릭은 무시하고, 성공한 정보 이동만 기존 append-only 시스템 이력을 생성한다.
- ORDER Q 표시 버전은 v1.56, fulfillment engine은 3.20.0, SmartInput 자산 캐시 토큰은 CSS 0.9.15·JS 0.11.44로 갱신했다.

## 검증 결과

- `scripts/validate-repository.mjs`: 24 checks, 0 warnings.
- `scripts/test-shipping-management.mjs`: 실제 주문 94건·재고 273건 포함 engine·workbook 회귀 통과.
- 신규 `scripts/test-orderops-excel-cell-grid-browser.mjs`: 실제 생성 Excel 입력, 업무정보 편집, Enter/방향키 포커스 이동, 2px 행 테두리, identity 고정, 잘못된 Ctrl+클릭 무이력, 정보 셀 대체출고 성공을 Chromium에서 통과.
- `scripts/test-orderq-substitute-shipment.mjs`, `scripts/test-orderops-orderq-source.mjs`, `scripts/test-orderops-pr544-operator-flow.mjs`, `scripts/test-orderops-pr544-operator-flow-browser.mjs`, `scripts/test-orderops-shipment-conflict-browser.mjs`, `scripts/test-orderops-theme-browser-e2e.mjs` 통과.
- `scripts/test-smartinput-independent-recovery.mjs`, `scripts/test-smartinput-grid-clipboard.mjs`, `scripts/test-smartinput-browser-e2e.mjs`, `scripts/test-smartinput-settings-ux-browser.mjs`, `scripts/test-smartinput-input-template-browser-e2e.mjs` 통과. 입력양식 브라우저 검사는 병렬 실행 중 1회 준비 타임아웃 후 단독 재실행에서 통과했다.
- SmartInput의 의도된 번호 선택·행 포커스 변경에 맞춰 app-header 캐시 계약과 Phase 6B 승인 UI 해시를 갱신했으며 해당 정적·브라우저 검사를 다시 통과시킨다.
- `git diff --check` 통과.

## 롤백

- 이 작업의 merge commit을 revert한다.
- DB schema나 migration을 추가하지 않았으므로 운영 데이터 삭제·복원은 수행하지 않는다.
