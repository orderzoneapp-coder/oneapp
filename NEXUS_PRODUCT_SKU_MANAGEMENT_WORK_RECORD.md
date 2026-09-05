# NEXUS 상품관리·SKU 관리 개발 작업 기록

- 작업 ID: `NEXUS-PRODUCT-SKU-20260905-01`
- 기준 SHA: `9d642d689d2ce776ba3ab336714f244ddcbda199`
- 작업 브랜치: `codex/product-sku-management-v1-1-20260905`
- 기준 문서: `NEXUS 상품관리·SKU 관리 최종 개발기획안 v1.1`
- 확인 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md`, `app-manifest.json` v1.3.11
- 개발 분류: 중요 개발

## 현재 상태와 목표

- 현재: `Master.html`과 `Item_manager.html`이 같은 상품 Master 쓰기 계약과 공통헤더 탭을 사용하고, 상품 변경요청은 읽기 전용 Inbox로만 표시한다.
- 목표: `Master.html`만 공식 상품 Master를 확정하고, `Item_manager.html`은 SKU 후보·BOM 작업본과 상품 등록 요청만 생성한다.

## 적용 경계

- 공식 상품 Master·Revision·History 소유자는 `master-lookup`으로 유지한다.
- 기존 `Item_manager.html` URL과 SKU 후보 작업 데이터는 보존한다.
- SKU 관리의 행사테마·Cloud 전체 Master·공식 Master 직접 쓰기 UI를 제거한다.
- 요청 원본은 관리자 확인 전 Master에 반영하지 않는다.
- 요청 상태와 처리 결과는 기존 상품 owner KV 요청함에 additive 방식으로 보존한다.
- 공통헤더 캐시 갱신을 위해 소비 페이지의 `nexus-ui.js` 버전만 동일하게 올린다.

## 검증 결과

- 요청 상태 전이·멱등 접수·완료 충돌 검사 통과
- 상품 단건·Excel 저장, Revision·History·rollback 35개 시나리오 통과
- 실제 XLSX 승인·제외·저장·재조회 검증 통과
- Product/Customer Snapshot·요청 경계 회귀 통과
- SmartParser·SmartInput 요청 연계 회귀 통과
- NEXUS 공통헤더·로그인 격리·18개 화면 공통 UI 계약 통과
- `Master.html`, `Item_manager.html` JSX 문법검사 통과
- Chrome/Chromium 미설치로 실제 브라우저 E2E는 실행환경에서 시작 불가
