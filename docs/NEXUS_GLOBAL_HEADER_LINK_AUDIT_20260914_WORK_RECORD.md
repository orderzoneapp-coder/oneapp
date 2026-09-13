# NEXUS 홈·글로벌헤더 링크 전수검수 작업기록

- 작업일: 2026-09-14 (Asia/Seoul)
- 저장소: `orderzoneapp-coder/oneapp`
- 최초 기준: `origin/main`의 `80f76bc595554388aeaeaa194d1a422cc38d8b4d`
- 작업 브랜치: `codex/nexus-global-header-links-20260914`
- 사용자 지시: 글로벌헤더의 `출고관리` 터치가 `스마트입력`으로 이동하는 문제를 수정하고, NEXUS 홈부터 모든 버튼 링크를 검수한다.

## 범위와 안전 경계

1. NEXUS 홈 12개 앱 카드의 표시명·앱 ID·선언 경로·실제 목적지를 전수 대조한다.
2. 7개 글로벌 탭의 표시명·앱 ID·선언 경로·실제 `href`와 통합 호스트 전환 경로를 전수 대조한다.
3. 모바일 390px에서 `출고관리` 탭의 시각 중심 터치 대상과 최종 부모/iframe 경로를 실제 브라우저로 검증한다.
4. 공통 UI와 호스트 정적 자산의 캐시 토큰을 함께 갱신한다.
5. 업무 데이터, 계산, 저장소, Revision, R1/R2 보존, ORDER Q·OrderOps 명령은 변경하지 않는다. 운영 확인은 페이지·링크 이동의 읽기 전용 검증으로 제한하고 공식 원장이나 업무 API에 쓰지 않는다.

## 최초 확인

- 기준 소스의 글로벌 탭 배열 자체는 `출고관리 → orderops/list.html`, `스마트입력 → smartinput/index.html`로 구분돼 있었다.
- 최신 운영 통합 화면을 390px로 직접 확인했을 때 `출고관리` 탭 중심의 hit target과 부모 `app=orderops&route=orderops/list.html`, iframe `orderops/list.html` 전환은 정상 재현됐다.
- 기존 정적 검사는 글로벌 탭의 순서·표시명만 확인하고 실제 `href`를 검사하지 않았다.
- 통합 호스트는 클릭한 앵커의 실제 `href`를 확인하지 않고 `data-nexus-ui-app-target`의 기본 경로를 다시 계산했다. 따라서 표시 앵커 속성의 불일치를 CI에서 놓치고 다른 앱으로 이동시킬 수 있는 검증 공백이 있었다.

## 구현

- 공통헤더가 각 탭에 정규 앱 ID, 선언 경로, 실제 `href`, 접근성 이름을 함께 기록한다.
- 통합 호스트는 앱 ID·선언 경로·실제 `href`가 동일한 공식 기본 경로인지 검증한 뒤 이동한다. 불일치는 다른 앱으로 추정 이동하지 않는다.
- NEXUS 홈 카드도 앱 ID·선언 경로·실제 목적지·접근성 이름을 같은 카드에 결속한다.
- `nexus-ui.js`는 `1.7.1`, `workspace.js`는 `1.1.1`, `nexus.js` 로드 토큰은 `1.3.6`으로 갱신해 이전 캐시가 남지 않게 한다.

## 검증·배포 기록

- `test-nexus-header-navigation-contract.mjs`: 7개 탭의 표시명·앱 ID·선언 경로·실제 `href`·접근성 이름과 기존 F01~F10 링크 계약 PASS.
- `test-nexus-basic-login-home.mjs`: 홈 12개 카드 정규 경로와 지정된 16개 업무 화면의 새 캐시 토큰 PASS. 저장소 전체 검색으로 공통 런타임 소비 HTML 21개가 모두 `1.7.1`이며 구 토큰은 0건임을 별도 확인했다.
- `test-nexus-workspace-host.mjs`: 7개 정규 헤더 경로와 `출고관리` ID/스마트입력 URL 불일치 fail-closed, 기존 경로·이력·복구 계약 PASS.
- `test-nexus-workspace-host-browser.mjs`: 홈 12개 실제 링크, 홈 `출고관리` 카드 클릭, 글로벌헤더 7개 실제 링크, 390px `출고관리` 중심 hit target·실제 touch, 7개 실앱, 42방향 전환 PASS.
- `test-nexus-unified-dark-app-headers-browser-e2e.mjs`: 1600·1280·390px 및 일반·다크에서 7개 직접 앱 각각의 7개 정규 링크, 헤더 시각·접근성 회귀 PASS.
- Repository validation 24 checks/0 warnings, 공통 UI 복구, 기본 로그인/홈, 인증 최소제어, 회사정보, 공통 작업영역, client safety 검사 PASS.
- 기준 `origin/main`에 이미 존재하는 별도 실패: SmartInput HTML은 `smartinput.css?v=0.9.22`인데 `test-smartinput-independent-recovery.mjs`와 `test-smartinput-settings-ux.mjs`는 `0.9.21`을 기대한다. `test-nexus-table-ux-contract.mjs`는 기준 SmartInput HTML에 없는 `nexus-table-ux.js?v=1.1.0`을 기대한다. 본 브랜치는 SmartInput의 이 자산이나 해당 기대값을 변경하지 않는다.
- PR·병합 SHA·CI·Pages 배포: 완료 후 기록한다.
- 운영 페이지의 자산 토큰·해시와 NEXUS 홈/글로벌헤더 이동: 배포 후 읽기 전용으로 확인한다.

## 롤백

문제가 있으면 본 변경 병합 커밋을 새 PR로 revert한다. 링크·공통 UI·호스트만 직전 버전으로 되돌리고 업무 데이터, 작업본, Revision, 복구·감사 이력은 삭제하거나 변환하지 않는다.
