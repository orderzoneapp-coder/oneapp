# NEXUS SmartInput 우측 패널 즉시 노출 작업 기록

- 작업 ID: `NEXUS-SMARTINPUT-RIGHT-PANEL-EARLY-REVEAL-20260906-01`
- 개발 분류: 빠른 처리
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 SHA: `102da8c88d3a148a64b6be2ff9448313dc60d300` (`origin/main`)
- 작업 브랜치: `codex/smartinput-right-panel-touch-hotfix-20260906`
- 작업 경로: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-right-panel-touch-hotfix-20260906`
- 시작 상태: clean, 기존 우측 패널 터치 수정 브랜치를 최신 `origin/main`으로 fast-forward해 재사용
- 확인 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md`, `app-manifest.json` v1.3.12, `roles/PM.md`, `roles/DEVELOPER.md`

## 목적과 현재 문제

SmartInput의 저장된 활성 모드와 우측 패널 열림 상태는 로컬 저장소에 이미 있지만, 현재 화면은 대형 ES module과 모든 정적 import가 평가된 뒤 마지막 `renderMode()`에서만 이를 적용한다. 운영 모바일 측정에서 새로고침 후 `견적서 목록`·`연동견적서` 선택 탭 노출까지 약 9.7초가 걸렸다.

사용자는 클라우드나 선택 기능 모듈의 준비를 기다리지 않고 우측 패널 골격과 목록 종류 선택을 즉시 보고 사용할 수 있어야 한다.

## 적용 정책과 경계

- 화면 골격과 로컬 저장 UI 상태 복원: `LOCAL_OPERATION`
- 견적서 목록 데이터 읽기와 외부 최신화: 기존 로컬 우선 경로 유지
- 공통 NEXUS UI 자산: 기존 `nexus-ui-theme-init.js`, `nexus-ui.css`, `nexus-ui-app-themes.css`, `nexus-ui.js` 유지
- 허용 파일: `smartinput/index.html`, `smartinput/smartinput.js`, 관련 SmartInput 브라우저 회귀 테스트, 이 작업 기록
- 변경 금지: IndexedDB schema/Store, 로컬 draft 형식, Cloud 계약, 견적서 데이터 의미·저장·삭제, 다른 앱과 공통 UI 자산

## 목표 상태와 완료조건

1. 저장된 활성 모드와 우측 패널 열림 상태를 대형 module 초기화 전에 동기 복원한다.
2. `견적서 목록`·`연동견적서` 탭은 즉시 노출하고 초기화 중에도 두 탭 사이를 전환할 수 있다.
3. 목록 데이터가 준비되기 전에는 빈 화면 대신 종류별 `불러오는 중` 상태를 표시한다.
4. 초기화 중 사용자가 선택한 탭·패널 열림·활성 전표 모드는 본 module 준비 후에도 유지된다.
5. 기존 `+` 터치, 목록 전환, 입력 작업본 복원과 저장 계약은 그대로 유지한다.
6. SmartInput 계약·main module 초기화를 의도적으로 지연한 모바일 브라우저 테스트에서 조기 노출·조기 전환·초기화 후 상태 인계를 검증한다.

## 충돌·영향 평가

- 현재 소스·manifest와 요청 사이에 정책 충돌 없음.
- 로컬 저장 UI 상태를 먼저 적용하는 변경이며 서버 요청·Cloud 의존성은 추가하지 않는다.
- 데이터 구조와 활성 작업본을 변경하지 않아 독립 롤백은 SmartInput 정적 자산과 테스트 commit 되돌리기로 가능하다.

## 구현·검증 결과

- 초기 shell script를 CSS와 업무 계약 module보다 먼저 준비하고, 본문 파싱 직후 로컬 draft의 활성 전표 모드·패널 열림 상태를 적용했다.
- `견적서 목록`과 `연동견적서`는 데이터 준비 전에도 전환할 수 있고 종류별 `불러오는 중` 상태를 표시한다.
- 본 module은 초기 사용자의 모드·패널·목록 선택을 인계하며 실제 목록 준비 후 기존 카드와 `+` 다중 선택 기능을 활성화한다.
- 로컬 견적 자료 로드 실패는 정상 0건과 분리해 오류 문구로 표시하고 현재 입력 작업은 유지한다.
- 계약 script를 1,800ms 지연한 390×844 터치 테스트의 반복 실행에서 패널과 두 목록 탭이 456~610ms에 노출됐고, 초기 `연동견적서` 터치 선택이 본 module 준비 후에도 유지됐다.
- 세 우측 패널 컨트롤은 준비 후 각각 최소 44px와 `touch-action: manipulation`을 유지했고 실제 touch pointer 15건이 확인됐다.
- 문법·독립실행·AppHeader/workspace·환경설정 계약·전체 SmartInput 데스크톱/모바일 브라우저 회귀검사가 통과했다.
