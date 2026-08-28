# NEXUS 공통 UI 기반 복구 검증보고서 v1.0

- 검증일: 2026-08-29
- 기준 SHA: `85dadffc71afb21405639c6771b800ee71142699`
- 검증 환경: 로컬 정적 HTTP, Chromium 계열 브라우저, 1280px·390px

## 1. 범위 준수

- 15개 대상 HTML에는 공통 UI 연결 4줄과 정적 앱 ID만 추가했다.
- 기존 업무 JavaScript와 의존성의 상대적 순서는 변경하지 않았다.
- 업무 JavaScript, `.gs`, Script Property, 서버 데이터는 변경하지 않았다.
- 이전 공통헤더·인증·Gateway·Runtime 코드는 반입하지 않았다.
- 롤백 전 코드에서 재사용한 파일은 허용목록의 NEXUS SVG 2개뿐이다.

## 2. 정적 계약 검증

- 저장소 기본 검증: 통과
- 클라이언트 저장·가져오기 안전성: 통과
- NEXUS 공통 UI 전용 계약: 15개 화면 통과
- 공통 UI의 `fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `google.script`, Gateway·앱 준비 Runtime 참조: 0건
- 테마 저장 쓰기: 전용 키 `oneapp.nexus.ui.theme.v1` 1개

## 3. 브라우저 검증

- 15개 화면 공통헤더 표시: 통과
- 각 화면 현재 앱 `aria-current="page"`: 통과
- 일반·다크모드 버튼 각각 1개: 통과
- 앱 이동 후 다크모드 유지: 통과
- 일반·다크 로고 동시 전환: 통과
- 본문 배경·입력·표·주요 패널 색상 전환: 통과
- 390px: 헤더 54px 한 줄 유지, 두 모드 버튼 표시, 네비게이션 가로 스크롤 가능
- 서버 없이 정적 HTTP에서 헤더 표시와 앱 URL 이동: 통과

## 4. 성능

`orderq/index.html`을 Warm 조건으로 20회 다시 열어 테마 초기화 시작부터 공통헤더 준비까지 측정했다.

- p95: 17.2ms
- 최대: 36.7ms
- 기준: p95 150ms 이하
- 판정: 통과

## 5. 기존 앱 회귀검증

GitHub 저장소 검증 Workflow의 Node 테스트를 순차 실행했다.

- NEXUS·ORDER Q vNext·DataOps·MerchOps·Master 관련 검증: 통과
- OrderOps 저장소 안전 모드(`SHIPPING_SKIP_REFERENCE_FILES=1`): 통과
- OrderOps 클라우드 실패 주입 검증: 통과

로컬 바탕화면의 실데이터 `창고별재고.xlsx`를 자동 참조하는 기존 OrderOps 검증 1건은 `85dadffc` 원본에서도 동일하게 실패했다. 이번 변경 파일과 무관한 기준선 문제로 분리했으며, 저장소·CI 환경과 동일한 참조파일 제외 모드는 통과했다.

## 6. 배포 판정

정적 기능·범위·성능·회귀검증 기준은 충족했다. GitHub Pages 병합 SHA 일치와 운영 화면 확인 후 최종 완료로 판정한다.
