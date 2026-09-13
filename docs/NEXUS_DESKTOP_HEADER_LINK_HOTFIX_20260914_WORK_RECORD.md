# NEXUS 데스크톱 공통헤더 링크 긴급 수정 기록

- 목적: 1080px 데스크톱 웹에서 공통헤더의 출고관리·DataOps 링크가 오른쪽 화면모드 영역 뒤에 가려져 클릭되지 않는 문제를 수정하고, NEXUS 홈 12개 카드와 공통헤더 7개 링크의 목적지를 함께 검증한다.
- 기준 소스: `origin/main`의 `c57b20e23593fde0af2a79dfefcc033647341248`.
- 허용 범위: 공통헤더 반응형 레이아웃, CSS 캐시 버전, NEXUS 홈·공통헤더 링크 클릭 회귀검사, 관련 아키텍처·manifest 기록.
- 금지 범위: 앱 공식 경로 변경, 업무 데이터·저장·Revision·인증·lifecycle 계약 변경.
- 실행·검증 책임: 현재 개발 작업에서 구현, 자동검사, 실제 데스크톱 브라우저 검수, PR·병합·Pages 배포·운영 확인까지 수행한다.
- 완료 조건: 1080px 데스크톱에서 12개 홈 카드와 7개 공통헤더 링크의 중심 클릭 대상이 자기 자신이고, 실제 마우스로 출고관리에 도착하며, 기존 모바일 터치·42개 앱 전환·저장 전 lifecycle 검사가 유지되고, 병합 SHA와 Pages 배포 SHA가 일치한다.

## 재현과 수정

- 운영 재현: 1080px 데스크톱에서 공통헤더가 `270px / 520px / 270px`로 계산되었고, 702px 너비가 필요한 앱 링크 트랙의 출고관리·DataOps 중심 좌표가 링크가 아닌 헤더를 가리켰다.
- 수정: 761~1279px 구간의 헤더를 60px 브랜드·테마 행과 44px 전체 너비 앱 탐색 행으로 나눴다. 1280px 이상 기본 64px 헤더와 760px 이하 모바일 계약은 유지한다.
- 배포 반영: 모든 공통 UI 소비 페이지의 `nexus-ui.css` cache key를 `1.4.1`로 갱신한다.

## 로컬 검증

- `test-nexus-workspace-host-browser.mjs`: 1080px 홈 카드 12개·공통헤더 7개 실제 클릭 중심, 데스크톱 마우스와 모바일 터치 출고관리 도착, 42개 방향 전환 통과.
- `test-nexus-common-ui-recovery.mjs`: 공통 UI와 18개 소비 페이지 계약 통과.
- `test-nexus-workspace-host.mjs`: 단일 iframe·공식 경로·same-origin 메시지·이력·재시도 계약 통과.
- `test-nexus-header-navigation-contract.mjs`, `test-nexus-basic-login-home.mjs`, `test-orderops-theme-browser-e2e.mjs`, `test-master-itemmanager-app-header.mjs`: 통과.
- `test-history-settings-export-owner-boundaries.mjs`: manifest `1.3.21` 기대값 갱신 후 통과.
