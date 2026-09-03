# NEXUS-SI-SETTINGS-UX-20260903-01 검증 기록

## 착수 기준

- 작업명: SmartInput 환경설정 선택항목 중심 개편
- 사용자 실행 승인: `확인사항없으면 개발 진행시켜`
- 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 최초 확인 `origin/main`: `ab0f6020ea98cf1c14160c1cfa1745fbe9116dbb`
- 갱신 기준 `origin/main`: `76af96cbc24c6bfdaa99fdb1897e75af71337770` (PR #496 병합 반영)
- 브랜치: `codex/nexus-si-settings-ux-20260903-01`
- worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\nexus-si-settings-ux-20260903-01`
- 시작 상태: clean, `origin/main` 직접 추적, 기존 `main` 작업공간의 충돌 변경과 분리

## 확인 문서

- `AGENTS.md` 2.3.4 (2026-08-30)
- `roles/DEVELOPER.md`
- `APP_ARCHITECTURE.md` 2.1.30 (2026-09-03)
- `app-manifest.json` 1.3.9 (2026-09-03)
- `orderq/ARCHITECTURE.md` 0.9.0 (2026-09-03)
- `smartinput/README.md` (`SMARTINPUT-STANDALONE-V1`)
- `APP_ARCHITECTURE.md`의 `Current-Source Baseline` 표기는 착수 SHA보다 이전 값이지만, 문서 자체의 앱 경계·보존 규칙에는 충돌이 없음을 확인했다.

## 현재 상태와 목표 상태

- 현재: 전표별 표시 열 설정이 전체 필드를 한 번에 렌더링하며, 항목 추가는 중첩 모달을 연다. 추가 항목의 Enter 순서는 마지막 순번 다음 값으로 자동 지정되고, 중복 순번을 연속 순번으로 정리하는 미리보기 규칙이 없다.
- 현재: `voucherColumnsByMode`의 배열 순서는 작업테이블 열 배치 순서이기도 하다. 환경설정에서 선택 목록을 업무상 고정 순서로 다시 표시하더라도 이 배열 순서를 재정렬하면 작업테이블 열 배치가 덮어써진다.
- 목표: 환경설정에서는 선택된 항목만 업무상 고정 순서로 보여주고, 같은 모달 안의 탐색 영역에서 검색·분류·전체/선택 개수와 선택 상태를 확인하며 항목을 추가한다.
- 목표: 노출 상태와 Enter 순서 `0`/양의 정수를 저장 전 작업본에서만 편집한다. 순번 입력은 마지막 편집 항목을 지정 위치에 끼워 넣고 양수 순번만 1부터 연속으로 정리한다.
- 목표: 설정 저장 전에는 활성 작업표와 영구 설정을 바꾸지 않고, 저장 시 선택 전표별 설정만 적용한다. 설정 화면의 고정 업무 순서는 기존 작업테이블 열 배치 순서와 분리한다.

## 적용 경계

- 기본 기능: 주문서·구매·판매·견적서 작업본 작성, 로컬 자동저장과 기존 전표별 표시/입력 설정.
- 소유 데이터: SmartInput DB v5와 기존 `oneapp.smartinput.settings.v1` 호환 설정. Schema와 저장 계약은 변경하지 않는다.
- 외부 읽기: 기존 Product/Customer Snapshot과 필드 등록부를 그대로 소비한다.
- 외부 장애 시 유지: 설정 모달, 기존 저장 설정, 작업표 편집과 저장 전 임시 미리보기는 로컬에서 동작한다.
- 서버 필수 작업: 이번 변경에는 없다(`LOCAL_OPERATION`).
- Adapter 경계: ORDER Q 공식전표 Adapter/Gateway/Repository, 기준정보 Adapter와 Draft/IndexedDB 계약을 변경하지 않는다.
- 활성 작업본 보호: 별도 working copy에서만 편집하고 `설정 저장` 성공 뒤에만 `state.settings`와 작업표 렌더링을 갱신한다.
- 롤백: SmartInput 설정 UI·앱 전용 순번 helper·해당 테스트와 증거만 되돌리며 다른 앱 데이터나 저장소를 건드리지 않는다.

## 충돌 확인

- 착수 시 열린 PR 중 SmartInput 대상 PR 없음.
- DataOps 다크모드 PR #496은 구현 전 `origin/main`에 병합됐다. 업무 로직은 분리하며, 같은 `smartinput/index.html`의 공통 자산 토큰 `nexus-ui.css` 1.3.5, `nexus-ui-app-themes.css` 1.3.9, `nexus-ui.js` 1.4.2를 유지한다.
- 공식전표 V2, 상품·거래처 기준정보, Excel 붙여넣기, Draft/IndexedDB schema 변경 없음.
- 공통 Runtime·공통 테마 controller·범용 설정 엔진 추가 없음.

## 검증 결과

### 구현

- 환경설정 모달을 데스크톱 `1180 × 최대 860px`, 모바일 `100vw × 100dvh`로 확장하고 제목·전표 탭·안내·푸터를 스크롤 영역 밖에 고정했다.
- `전표별 표시 열`을 첫 번째 열린 그룹으로 배치하고 선택된 항목만 `품목정보 → 수량·단가·금액 → 메모·기타` 순서로 렌더링한다. 표시용 정렬 결과는 `voucherColumnsByMode`에 다시 쓰지 않는다.
- 같은 모달 안에 전체 항목 검색·3개 업무 분류·전체/선택/검색 결과 수·선택됨 표시·사용자지정 항목 생성을 제공한다. 새 항목은 현재 전표 배열 끝에 추가하고 Enter 순서는 `0`으로 둔다.
- 앱 전용 순수 helper에서 `0`, 양의 정수, 빈칸·음수 검증과 마지막 편집 항목의 중복 위치 삽입·연속 순번 정리를 수행한다.
- 모든 변경은 모달 working copy에만 반영하며 `설정 저장` 성공 후에만 영구 설정과 현재 작업표를 갱신한다. 변경 중 취소·X·Escape는 공통 확인 후 working copy를 폐기한다.
- IndexedDB v5, 저장 key/schema, 공식전표·기준정보·Excel·Draft 계약과 공통 Runtime은 변경하지 않았다.

### 자동 검증

- `scripts/test-smartinput-settings-ux.mjs`: PASS
  - 입력순서 `0`/양수/빈칸/음수/소수/상한, 앞·뒤 이동, 중복 위치 삽입, 연속 순번, 읽기 전용 제외
  - 주문서·구매·판매·견적서 독립 배열 및 기존 작업테이블 열 순서 보존
  - 선택 우선·인라인 탐색·저장/취소·필수항목·반응형·공통 자산 토큰 정적 계약
- `scripts/test-smartinput-settings-ux-browser.mjs`: PASS
  - 1920×1080, 1440×900, 390×844 및 light/dark
  - 선택 8개만 우선 표시, 그룹 행 겹침/잘림 0, 인라인 검색·분류·개수·선택됨, 중첩 모달 0
  - 추가 항목 순서 `0`, 요청 예시 중복 삽입, 빈칸·음수 저장 차단, 키보드 `focus-visible`
  - 저장 전 작업표 불변, 취소 후 저장값·작업표 복구, 판매 저장 후 다른 3개 전표 불변
  - runtime exception 0, console error 0
- 기존 회귀: `test-smartinput-field-settings-v2`, `test-smartinput-appheader-workspace`, `test-smartinput-grid-clipboard`, `test-smartinput-input-template-mapping`, `test-smartinput-input-template-browser-e2e`, `test-smartinput-browser-e2e`, SmartInput 공식전표 V2 관련 정적/브라우저 회귀: PASS
- `scripts/test-smartinput-independent-recovery.mjs`: PASS
- `scripts/test-smartinput-v2-unresolved-review-ui.mjs`와 browser E2E: PASS
- `scripts/validate-repository.mjs`: PASS (`24 checks`, warning 0)
- `scripts/test-client-safety.mjs`: PASS
- `scripts/test-nexus-common-ui-recovery.mjs`: PASS (`18 pages`)

브라우저 수치와 저장 결과는 [browser-evidence.json](./browser-evidence.json)에 기록했다. 대표 화면은 [선택 항목](./screenshots/smartinput-settings-1920-selected.png), [전체 탐색 light](./screenshots/smartinput-settings-1920-light.png), [전체 탐색 dark](./screenshots/smartinput-settings-1920-dark.png), [1440px](./screenshots/smartinput-settings-1440-light.png), [390px](./screenshots/smartinput-settings-390-light.png)이다.

## Git·PR·배포 상태

- 최종 PR 직전 `origin/main`: `76af96cbc24c6bfdaa99fdb1897e75af71337770`
- 공통 자산 토큰: `nexus-ui.css` 1.3.5, `nexus-ui-app-themes.css` 1.3.9, `nexus-ui.js` 1.4.2 유지
- commit/PR/CI/PM 판정/병합/Pages 배포/운영 확인은 진행 결과에 맞춰 갱신한다.
