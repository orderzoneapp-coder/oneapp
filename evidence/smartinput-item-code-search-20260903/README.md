# NEXUS-SI-ITEMCODE-SEARCH-20260903-01 착수 기록

## 착수 기준

- 확인 문서: `AGENTS.md` v2.3.4, `roles/PM.md`, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md`의 NEXUS 공통 UI/UX 단일 계약·SmartInput Core MVP 계약, `app-manifest.json`, `smartinput/README.md`
- 원격 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main` 및 HEAD: `a7fa2abc6121917eb70e0f3d23b43a09bdcc7ba8`
- 브랜치: `codex/smartinput-search-in-item-code-20260903`
- worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-darkmode-soft-surfaces-20260902`
- 착수 상태: clean. 다른 작업 파일을 수정·삭제·reset하지 않는다.

## 현재 상태와 목표 상태

- 현재: SmartInput 작업표가 `상품 검색` 가상 열과 `품목코드` 열을 동시에 표시한다. 상품 후보 검색 이벤트와 신규 행 기본 포커스·Tab 이동은 별도 `상품 검색` 입력에 연결되어 있고, 품목코드는 검색 안내만 표시한다.
- 목표: 별도 `상품 검색` 열을 표·열폭·열순서·입력동선에서 제거한다. `품목코드` 입력 하나가 코드·품명·규격·검색어 조회, 단일 후보 적용, 복수 후보 선택, 미등록 입력 보존을 모두 수행한다.

## 정책·경계

- 분류: `LOCAL_OPERATION`. 상품 검색과 작업표 편집에 서버 선행조건을 추가하지 않는다.
- SmartInput 작업본, 기존 Product Snapshot Read Adapter, 상품 후보 선택·미등록 처리, 저장·복구 데이터 형식은 유지한다.
- 저장된 과거 레이아웃의 `productSearch` 항목은 열로 복원하지 않고 읽을 때 무시하며 `itemCode`를 필수 표시·검색 열로 사용한다. 저장키·DB schema migration은 만들지 않는다.
- 공통헤더, 다른 앱, Product owner 저장소, ORDER Q 공식전표 경계, 출력 형식은 변경하지 않는다.
- 검색어는 `itemCode` 입력 중에는 기존 `unregisteredProductQuery`에 보존하되 상품 확정 후에는 확정된 품목코드를 표시한다.

## 완료조건과 검증

- 작업표 DOM에 `productSearch` 열·셀·폭이 없고 `품목코드`가 첫 상품 입력 열이다.
- 품목코드 입력에서 Enter 검색, 단일 후보 자동 적용, 복수 후보 대화상자, 미등록 상태와 owner 앱 왕복 복구가 유지된다.
- Tab은 다음 행의 품목코드로 이동하고 Enter·방향키·붙여넣기·열 숨김/순서/폭 저장이 회귀하지 않는다.
- 일반/다크 화면에서 품목코드 검색 셀의 식별성과 텍스트 대비를 유지한다.
- 관련 SmartInput 브라우저·저장·계약 테스트와 저장소 검증을 통과한다.

## 독립 실행·Rollback

- 외부 Adapter 또는 서버 장애에서도 현재 로컬 Snapshot으로 검색·직접 입력·작업본 편집을 유지한다.
- Rollback은 이 작업의 SmartInput HTML/CSS/JS·문서·테스트 변경만 이전 commit으로 되돌리며 저장 데이터 삭제나 변환을 수행하지 않는다.

## 구현 결과

- 작업표의 `productSearch` col/header/body/footer를 제거하고 `itemCode`를 행 선택 다음의 첫 고정 상품 입력 열로 통합했다.
- 품목코드 셀은 품목코드·품명·규격·검색어를 받아 Enter 시 공통 상품 Snapshot을 조회한다. 정확 일치는 실제 품목코드로 치환하고, 복수 후보는 기존 선택창을 열며, 미등록은 입력값과 행을 유지한다.
- 신규행 기본 포커스, 거래처 선택 뒤 포커스, Tab 다음 행 이동, 방향키·Enter 입력 순서, 작업표 붙여넣기 시작 필드를 모두 `itemCode`로 통일했다.
- 과거 설정의 `productSearch` 열폭·입력순서는 정규화 결과에서 제거한다. 기존 저장키, DB schema와 전표 payload는 변경하지 않았다.
- 품목코드 검색 셀의 일반/다크 구분색과 210px 기본 폭을 적용했으며 헤더·다른 앱·출력 형식은 변경하지 않았다.

## 검증 결과

- `scripts/test-smartinput-independent-recovery.mjs`: PASS
- SmartInput 앱헤더·필드설정·그리드 일괄편집·클립보드·기준정보 UX/generation·V2 baseline·Phase 6A/6C 계약 9종: PASS
- `scripts/test-smartinput-browser-e2e.mjs`: PASS
  - 독립 상품검색 열 부재, 품목코드 첫 열, 일반/다크 구분색
  - 품목코드 `입력 → Enter` 정확 일치, 복수 후보 선택창, 미등록 입력 및 owner 왕복 보존
  - Tab 다음 행 품목코드, 전표 4종, 데스크톱·모바일, 전체 후속 회귀 시나리오
- 화면 증적: [일반 모드](./screenshots/smartinput-0a-1920-light.png), [다크 모드](./screenshots/smartinput-0a-1920-dark.png), [모바일](./screenshots/smartinput-0a-mobile.png)
