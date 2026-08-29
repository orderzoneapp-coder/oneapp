# ItemMaster 독립 상품관리 앱 개발명세서 v1.3 — 폐기 결정 및 기능 승계 기록

- 최초 작업 ID: `ITEMMASTER-STANDALONE-20260829`
- 결정일: 2026-08-29
- 상태: 독립 구현 폐기·공식 상품관리 기능 승계
- 공식 앱 ID: `master-lookup`
- 공식 주소: `Master.html`

## 1. 최종 결정

과거 명세의 `Master.html`을 `ItemMaster.html`로 교체하고 공식 주소를 전환한 뒤 `Master.html`을 삭제하려던 계획은 폐기됐다. `Master.html`과 `master-lookup`을 유일한 공식 상품관리 기준으로 유지한다.

`ItemMaster.html`에서 격리 검증된 다음 기능만 `Master.html`에 선별 승계한다.

- 빈 상품 DB의 검증된 Excel 최초 등록
- 상품 단건 등록
- 상품 단건 수정
- 필수값과 중복 상품코드 검증
- 빈 상태 안내
- 등록·수정·새로고침 지속성 회귀검사

승계 기능은 별도 운영 DB를 만들지 않고 기존 `MerchOpsDB`, `coreEngine.js`, master revision, `merchHistory_v870`, 동기화 알림과 Cloud 계약을 사용한다.

## 2. 공식 구현과 호환 주소

1. `Master.html`은 NEXUS 홈·공통헤더·dashboard·manifest가 연결하는 공식 상품관리다.
2. manifest 앱 ID는 `master-lookup`, 경로는 `Master.html`로 유지한다.
3. `ItemMaster.html`은 상품 앱을 실행하지 않는 정적 호환 안내 페이지다.
4. 호환 페이지는 공식 `Master.html` 이동 링크만 제공하며 조회·등록·수정·Excel·IndexedDB 쓰기 기능을 포함하지 않는다.
5. `Item_manager.html`은 `item-manager` 경로와 카탈로그 소싱·행사테마·BOM 등 기존 기능을 유지하며 이번 통합 대상이 아니다.

## 3. 저장과 이력 기준

- 운영 DB: `MerchOpsDB`
- 상품 Store: `master_products`
- Snapshot: `merchMaster_v870`
- Revision: `merchMaster_revision_v870`
- History: `merchHistory_v870`
- 동기화 알림: `merchMaster_sync_trigger`

최초 등록, 단건 등록·수정과 Excel 추가·갱신은 읽은 revision을 비교하고 공통 원자 저장 경로를 사용한다. 저장 후 master와 history를 다시 확인하며 실패 시 변경 전 master와 history를 유지한다. 필수값이 없거나 상품코드가 중복되면 저장을 시작하지 않는다.

최초 등록은 공식 master가 0건일 때만 허용한다. 검증된 Excel 전체 행의 상품코드 중복과 품목명·규격·단위 누락을 차단하고, 저장 직전에 빈 상태와 revision을 다시 확인한다. 최초 등록은 전체 Snapshot과 건수를 공식 history 작업 이력 한 건으로 남긴다.

## 4. 레거시 격리 DB 보존

과거 배포된 `oneapp-itemmaster-isolated-v1`에는 브라우저별 데이터가 남아 있을 수 있다.

- `Master.html`은 DB 존재 여부를 비차단으로 확인한다.
- 실제 상품 데이터가 있을 때만 신규·동일·충돌 건수를 안내한다.
- 원본 DB를 자동 삭제·초기화·덮어쓰기하지 않는다.
- JSON 백업과 기존 추가·갱신 검토 화면 진입을 제공한다.
- 가져오기는 관리자가 명시적으로 승인한 신규·변경 필드만 공식 master에 저장한다.
- 동일 상품코드의 값 충돌은 자동 덮어쓰지 않는다.
- 레거시 DB 읽기 실패를 0건으로 표시하지 않고 원본 미변경 상태를 알린다.

## 5. 검증 기준

1. 기존 master 조회·검색·Excel 추가·갱신·revision 충돌·history·Cloud가 유지된다.
2. 빈 DB에서 검증된 Excel 최초 등록 후 새로고침해도 데이터와 revision이 유지된다.
3. 단건 등록·수정 후 새로고침해도 결과와 history가 유지된다.
4. 필수값 누락과 중복 상품코드는 저장 전에 차단된다.
5. 레거시 격리 DB 0건은 안내를 표시하지 않는다.
6. 레거시 데이터가 있으면 비차단 안내·백업·선택 검토를 제공한다.
7. 충돌 데이터는 관리자 승인 없이 공식 master를 덮어쓰지 않는다.
8. `/ItemMaster.html`은 중복 앱과 DB 코드를 실행하지 않고 공식 상품관리 안내·이동만 제공한다.
9. manifest, NEXUS 홈, 공통헤더와 dashboard의 공식 경로는 계속 `Master.html`이다.
10. `Item_manager.html`, MerchOps, SmartParser와 DataOps 회귀검사를 통과한다.

기존 ItemMaster 전용 소스·브라우저 테스트는 위 `Master.html` 승계 회귀검사와 정적 호환 페이지 검사로 재구성한다.

## 6. 롤백

코드 롤백은 해당 PR을 되돌리되 이미 존재하는 운영 master·history와 레거시 격리 DB를 삭제하지 않는다. 호환 페이지를 되돌리더라도 데이터 migration이나 DB 삭제를 수행하지 않는다.
