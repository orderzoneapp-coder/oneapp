# NEXUS 공통 UI 기반 복구 개발명세서 v1.0

- 작성일: 2026-08-29
- 작업 분류: 독립적인 공통 UI 기반 복구
- 코드 내용 기준: `28d0e45ff468a78312052cb56802919e89badaa3`
- 개발 브랜치 기준: `85dadffc71afb21405639c6771b800ee71142699`
- UI 참고 기준: `backup/pre-m1-full-rollback-20260828-4960f24`
- 배포 경계: GitHub Pages만 허용

## 1. 목적

개별 앱의 업무 기능·데이터·로딩을 통제하지 않는 순수 공통헤더와 일반·다크모드를 복구한다. 공통 UI는 정적 자산만 사용하며 서버 상태와 관계없이 표시되고 앱 URL 이동을 제공해야 한다.

이 작업은 NEXUS 인증·Gateway·Runtime 아키텍처 구축이 아니다.

## 2. 적용 대상

### Manifest 주요 앱

| 앱 ID | 기준 화면 |
|---|---|
| `merchops` | `MerchOps.html` |
| `dataops` | `DataOps.html` |
| `smart-parser` | `SmartParser.html` |
| `export-center` | `export_center.html` |
| `settings` | `settings.html` |
| `master-lookup` | `Master.html` |
| `item-manager` | `Item_manager.html` |
| `history-viewer` | `history_viewer.html` |
| `orderops` | `orderops/list.html` |
| `orderq-vnext` | `orderq/index.html` |

### ORDER Q vNext 동일 앱군 화면

- `orderq/input.html`
- `orderq/operations.html`
- `orderq/parser.html`
- `orderq/collector.html`
- `orderq/cloud.html`

## 3. 구현 범위

### 공통헤더

- 모든 대상 화면 상단에 고정된 한 줄 헤더를 표시한다.
- 정적 앱 네비게이션과 현재 앱 표시를 제공한다.
- 모바일에서는 줄바꿈하지 않고 가로 스크롤한다.
- 기존 NEXUS 브랜드 색상·로고·간격을 시각적 기준으로 사용한다.
- 앱 이동은 일반 URL 이동만 사용한다.
- 공통 UI 로드 실패가 앱의 업무 스크립트 실행을 차단해서는 안 된다.

### 일반·다크모드

- `일반모드`와 `다크모드`만 제공한다.
- `시스템 모드`는 제공하지 않는다.
- 선택값은 동일 Origin의 `oneapp.nexus.ui.theme.v1` 로컬 키에 저장한다.
- 저장된 값이 없거나 유효하지 않거나 기존 값이 `system`이면 `light`로 정규화한다.
- 테마 초기화는 기존 스타일시트 표시 전에 실행해 화면 깜빡임을 줄인다.
- 앱 이동 후에도 선택 모드를 유지한다.
- 공통헤더와 앱 본문에 동시에 적용한다.
- 일반·다크 NEXUS 로고를 모드와 함께 전환한다.
- 저장소 접근 실패 시 기본 일반모드로 계속 실행하고 앱을 차단하지 않는다.

### 앱별 허용 변경

- 공통헤더 마운트에 필요한 정적 CSS·JS 연결
- 정적 앱 ID 지정
- 테마 초기화 코드 선적용
- 본문 색상·로고 토큰 적용
- 공통헤더 높이만큼의 상단 여백

기존 업무 스크립트와 의존성의 상대적 로딩 순서는 변경하지 않는다. 공통헤더 영역을 제외한 업무영역 내부 구성과 레이아웃은 변경하지 않는다.

## 4. 금지 범위

- 인증·권한·로그인 연결
- Gateway·서버 상태·앱 준비 Runtime 연결
- `fetch`, `XMLHttpRequest`, `WebSocket`, `google.script.run` 사용
- 업무 IndexedDB·localStorage·SessionStorage 접근
- 업무 데이터 조회·저장·동기화
- 기존 업무 JavaScript 변경
- `.gs`, Script Property, Apps Script 배포와 서버 데이터 변경
- 롤백 전 공통헤더 JavaScript의 복원·Cherry-pick
- 영구 앱 셸, 범용 상태관리, 앱 준비 로더

테마 선택값 저장만 공통 UI 전용 localStorage 접근 예외로 허용한다.

## 5. 정적 파일 계약

새 공통 UI는 다음 파일로 제한한다.

- `nexus/common/nexus-ui-theme-init.js`: 테마 선적용과 정규화
- `nexus/common/nexus-ui.js`: 헤더 생성, 정적 URL 이동, 테마 전환
- `nexus/common/nexus-ui.css`: 헤더·모바일 한 줄·공통 색상 토큰
- `nexus/common/nexus-ui-app-themes.css`: 앱 본문 색상 소비 규칙
- `nexus/assets/brand/oneapp-nexus-light.svg`
- `nexus/assets/brand/oneapp-nexus-dark.svg`

앱 목록은 `nexus-ui.js` 내부의 불변 정적 목록으로 둔다. 외부 JSON·manifest·Gateway를 실행 중에 요청하지 않는다.

## 6. 완료조건

1. 15개 대상 화면 모두 공통헤더가 표시된다.
2. 현재 앱이 `aria-current="page"`로 표시된다.
3. 모바일 390px에서 헤더가 한 줄을 유지하고 네비게이션을 가로 스크롤할 수 있다.
4. 일반·다크모드만 표시되며 본문과 로고가 동시에 전환된다.
5. 화면을 새로 열거나 다른 앱으로 이동해도 선택 모드가 유지된다.
6. 공통 UI 코드의 업무 Gateway·서버·업무 저장소 요청은 0건이다.
7. 서버 없이 정적 파일만 제공되는 환경에서 헤더 표시와 URL 이동이 가능하다.
8. 이동한 앱 자체의 기존 서버 의존 문제는 이번 완료조건에 포함하지 않는다.
9. 기존 업무 스크립트·저장·데이터 계약 변경은 0건이다.
10. 공통 UI 준비 시간은 로컬 Warm p95 150ms 이하다.
11. 기존 저장소 회귀검사와 대상 화면 브라우저 검사가 통과한다.
12. GitHub Pages 배포 SHA가 병합 SHA와 일치하고 운영 화면 검사가 통과한다.

## 7. 롤백

- 이 작업의 PR을 GitHub에서 Revert한다.
- 추가된 공통 정적 파일과 각 HTML의 공통 UI 연결부만 제거한다.
- 업무 데이터·브라우저 DB·서버 데이터 Migration은 없으므로 별도 데이터 롤백을 수행하지 않는다.

## 8. 2026-08-29 공개 회사 Footer 후속 계약

- 이 문서의 공통헤더·테마 코드는 계속 인증·업무 Gateway·업무 저장소와 분리한다.
- `nexus-ui.js`는 별도 공통 자산 `nexus-company-footer.js`를 비차단으로 로드하는 역할만 추가한다. 헤더 준비와 업무 앱 실행은 Footer 네트워크 확인을 기다리지 않는다.
- Footer는 공개 6필드와 revision만 갖는 별도 Snapshot 계약이며, 마지막 정상 로컬 Snapshot 또는 배포 기본값을 즉시 렌더한다.
- 백그라운드 최신 확인은 무인증 고정 read-only action `nexus_public_company_snapshot`만 사용한다. 다른 action, target URL, token 또는 보호 회사정보 요청은 허용하지 않는다.
- 이 후속 계약은 15개 업무 화면에 구 NEXUS 인증 redirect 또는 app-ready Runtime을 재도입하지 않는다.
