# ORDEROPS-3P-01 · Main 직접 적용 / 복구 경계

## 범위
- 출고관리 `orderops/list.html`만 새 3영역으로 연결한다. 원본 `orderops_list.html`, 공통헤더, SmartInput 파일은 변경하지 않는다.
- 좌측: 연결자료 4버튼, 파서 내부 Excel 선택/드롭, 기존 유형/열/범위 검토와 명시적 적용, 완료본/복구 메뉴.
- 중앙: 현황 제목, 기존 표 옵션/편집/출력. 빈 상태도 테이블이며 자료 불러오기 UI를 배치하지 않는다.
- 우측: 기간/창고/담당/검색, 전체선택 체크박스, 전표별 선택과 단위별 합계, 선택 전표의 창고/담당 작업본 변경.
- 공통 계산 엔진에는 `applyOrderPatches`만 추가한다. 기존 계산식, 원본 화면의 거래처 전체 변경 함수, 출력 모듈은 유지한다.
- 변경은 복제 후보에서 검증·1회 재계산하고 검산된 복구 레코드가 준비된 후 반영한다. 공식 원장/ERP 전송/출고확정은 수행하지 않는다.

## 이번 적용의 한계
- 주문서 버튼은 기존 ORDER Q 단일 주문 조회·적용 경로다. 여러 API 주문의 일괄 합성/동시 출고확정은 이번 적용에 포함되지 않는다. 중복 작업행 번호를 발견하면 임의 수정하지 않고 적용을 거부한다.
- 구매/판매는 기존 ORDER Q 내부 읽기 어댑터를 최대31일 순차 조회해 준비자료로 만든다. 외부 ERP 실시간 API 구현이 아니다.
- 실제 사용자 파일·계정 데이터·스타일 포함 전체 엑셀 출력·운영 브라우저는 별도 실사용 확인 대상이다.
- 브라우저 검사는 합성 자료와 격리된 로컬 저장소를 사용하며 외부 요청을 차단한다. CDN SheetJS 대신 저장소의 번들 파서를 테스트 응답에서만 사용한다.

## 복구
1. `git log --oneline --grep="feat(orderops): ORDEROPS-3P-01"`로 **적용 커밋**을 찾는다.
2. 그 커밋만 `git revert <적용커밋SHA>` 후 main에 반영한다. 전체 main reset/force-push는 금지한다.
3. 후속 변경과 충돌하면 해당 파일만 대조해 조정한다. SmartInput 등 다른 작업을 이전 시점으로 되돌리지 않는다.
4. 코드 복구는 브라우저 저장소·공식 원장·출고 이력을 삭제하지 않는다. 이미 저장한 업무 수정값까지 자동 취소하지 않는다.

## 변경 파일
- `orderops/list.html`
- `orderFulfillmentEngine.js`
- `orderops/workbench-ui.js`
- `scripts/test-orderops-three-section-preview.mjs`
- `orderops/three-pane-layout.js`
- `orderops/voucher-workbench.js`
- `orderops/source-coordinator.js`
- `orderops/three-pane-workbench.css`
- `scripts/test-orderops-three-pane.mjs`
- `scripts/test-orderops-three-pane-browser.mjs`
- `docs/ORDEROPS_3P_01_DEPLOYMENT.md`

## 검증
기존 계약 스크립트10개, 신규 선택전표 단위 검사, 신규 브라우저 조작 검사와 재고/구매 정보열 회귀검사를 적용 전에 실행한다. 실행 로그·화면·JSON은 ORDEROPS-3P-01 검증 Actions artifact에서 확인한다. 한시적인 설치 workflow는 적용 후 제거하며, 위 파일들의 단일 적용 커밋만 업무 코드 복구 단위다.
