# NEXUS 헤더·테이블 재구축 작업기록

- 작업일: 2026-09-10 (Asia/Seoul)
- 기준 저장소: `orderzoneapp-coder/oneapp`
- 기준 브랜치: `main`
- 기준 SHA: `259a097fcc10ed2a8e0776dd95b78c5e32a88e10`
- 작업 브랜치: `codex/nexus-common-header`
- 개발명세: `NEXUS_글로벌헤더_앱헤더_테이블_재구축_개발명세_v1.0.md`

## 목표

1. 글로벌 헤더를 `상품관리 · 거래처관리 · 스마트파서 · MerchOps · 스마트입력 · 출고관리 · DataOps` 순서로 통일한다.
2. 정상 노출 설정, 빈 설정, 손상 설정의 복구 규칙을 분리하고 `item-manager → master-lookup` 호환을 유지한다.
3. 명세 F01~F10 및 G01~G03의 링크·복귀·회사 범위 결함을 먼저 해소한다.
4. 이후 앱별 화면을 스마트입력형 AppHeader, 역할 기반 3열, Excel형 테이블 규칙으로 순차 개편한다.
5. SmartParser의 관리자 확정 카탈로그 업데이트·상품 제외를 PENDING 재승인 없이 즉시 반영하고, 선택 판매정지와 연속 연결 UX를 복원한다.

## 범위와 금지사항

- manifest의 공식 앱 ID·경로·데이터 소유권은 변경하지 않는다.
- 기존 단축키와 저장·출력 함수의 의미를 바꾸지 않는다.
- 앱 간 저장소 직접 쓰기나 신규 인증·Gateway 의존성을 추가하지 않는다.
- 사용자 작업 상태를 자동 초기화하지 않는다.
- SmartParser 화면에 raw 상품 writer를 추가하지 않고 version command Adapter 경계만 사용한다.
- `legacy/dashboard.html`, `orderops_list.html`, `list1.html`은 별도 승인 없이 수정하지 않는다.

## 구현 순서

`기준 확인 → 공통헤더 → 거래처관리 → 상품관리·스마트파서 → MerchOps → DataOps → 출고관리 → 하위 화면`

링크 정합성은 `F01/F08 → F04~F07 → F02/F03/F09/F10 → G01~G03` 순서로 검증한다.

## 기준 확인 결과

- 원격 `main`과 명세 기준 SHA가 일치한다.
- 작업 시작 시 작업 트리는 깨끗하다.
- 공통헤더 런타임은 기존 11개 앱 후보를 사용하고 있어 7개 글로벌 후보 계약으로 변경이 필요하다.
- 앱 홈과 관리자 설정은 12개 공식 ID를 계속 보존한다.

## SmartParser 추가 구현 범위

- `APPLY_ANALYSIS`와 `EXCLUDE_CATALOG` 전용 version command를 추가한다.
- 관리자 확정 시 expected Product Snapshot/revision, 멱등 operation ID, 허용 field, 실제 변경이력과 알림을 한 원자적 저장 단위로 처리한다.
- 카탈로그 제외는 현재 카탈로그만 제거하고, 선택 시 `판매정지 함께 적용`과 `품절·공급중단·판매종료` 사유를 판매여부·정지목록·쇼핑몰 상태 대기열과 함께 원자 반영한다.
- 하단 체크박스 선택 시 검토된 상품명·규격·단위를 연결 마스터에 즉시 저장하고, 해제 시 기존 값을 유지한다.
- 수동 연결은 현재 탭·검색조건·양쪽 스크롤을 유지하고 연결 행만 갱신한다. 남은 항목이 없을 때도 안내만 표시하며 자동 이동·자동 검토창 열기를 하지 않는다.
- 명령 성공 뒤 Product Snapshot에서 실제 field와 선택 판매정지를 다시 확인한 경우에만 완료 표시와 작업행 정리를 수행한다.

## 커밋·검증 기록

- 헤더·링크 재구축 커밋: `c2369aad feat(nexus): rebuild global header and navigation`
- SmartParser 변경은 위 커밋과 분리하여 커밋한다.
- 계약·단위 검증: SmartParser 전체 8종, 상품 마스터 42개 필수 시나리오, 저장소·이력·manifest 소유권 경계 통과.
- 실제 브라우저 검증: 화면 렌더, 연속 연결 탭·검색·스크롤 유지, 자동 이동 방지, 제외 옵션, 체크/해제 상품명 정책, 즉시 카탈로그 저장, 다른 카탈로그 유지, 선택 판매정지·사유·변경이력 반영 통과.
- 공통 회귀: 7개 글로벌 헤더와 F01~F10 이동, 공통 UI 복구, 인증 최소 UI, 상품관리 AppHeader, ORDER Q/OrderOps, 스마트입력 전표, Export Center 통과.
