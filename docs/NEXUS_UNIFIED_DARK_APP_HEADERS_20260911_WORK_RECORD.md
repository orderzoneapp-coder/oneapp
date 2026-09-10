# NEXUS 전 앱 다크 앱헤더 통일 작업기록

- 작업일: 2026-09-11 (Asia/Seoul)
- 기준 저장소: `orderzoneapp-coder/oneapp`
- 기준 브랜치: `main`
- 기준 SHA: `c5273571e7b6f25ec3a07a418a7647a92578a483`
- 작업 브랜치: `codex/nexus-unified-dark-app-headers-20260911`

## 확정 범위

1. 글로벌헤더와 앱헤더를 본문 일반/다크 화면모드와 무관한 동일 다크 팔레트로 표시한다.
2. 상품관리·거래처관리·스마트파서·MerchOps·스마트입력·출고관리·DataOps 앱헤더 높이를 정확히 56px로 통일한다.
3. 앱 명칭 시작선을 데스크톱 24px, 700px 이하 10px로 통일한다.
4. SmartParser와 OrderOps 앱헤더의 ONEAPP·ORDER Q 로고와 버전 배지를 제거하고 앱 명칭만 표시한다.
5. 기존 앱 기능·저장 경계·단축키·본문 레이아웃·밝은 출력 형식은 변경하지 않는다.

## 구현

- `nexus-ui-app-themes.css`에 `data-nexus-app-header` 기반의 영구 다크 앱헤더 계약을 추가했다.
- 앱별 밝은 표면색과 OrderOps 다크 패널색이 앱헤더를 덮지 않도록 헤더 범위에 한정한 우선순위를 적용했다.
- 좁은 화면에서는 단일 행과 터치 높이를 유지하고, 조작부가 줄바꿈·겹침 없이 가로로 접근되도록 했다.
- 7개 앱의 앱 식별 요소에 공통 identity/title 표식을 추가했다.
- SmartParser와 OrderOps의 헤더 로고·보조문구·버전 배지 마크업과 잔여 공간을 제거했다.
- 공통 스타일 캐시 토큰을 `1.3.11`로 올리고 모든 소비 화면과 복구 검증을 함께 갱신했다.

## 검증

- `test-nexus-unified-dark-app-headers-browser-e2e.mjs`: 1600·1280·390px, 일반/다크, 7개 앱의 배경색·56px 높이·좌측선·제목/버튼 4.5:1 대비·무겹침·무세로넘침·로고 제거·런타임 오류 0 검증.
- `test-nexus-common-ui-recovery.mjs`: 공통 자산 실패 복구와 18개 화면 캐시 토큰 검증.
- `test-nexus-header-navigation-contract.mjs`: 7개 글로벌 앱과 F01~F10 이동 계약 검증.
- `test-nexus-workbench-layout-browser-e2e.mjs`: 5개 작업영역과 SmartInput·OrderOps 롤백 제외 계약 검증.
- SmartInput 승인 UI·작업영역·브라우저 E2E와 OrderOps 표준 업무 회귀를 함께 실행한다.

## 배포·운영 확인

- PR·병합 SHA·Pages 배포 실행: 완료 후 기록한다.
- 운영 URL의 캐시 토큰·계산 스타일·로고 제거·버튼 가독성·겹침 여부: 배포 후 실제 브라우저로 확인한다.
