# ItemMaster 독립 상품관리 앱 개발명세서 v1.1

- 작업 ID: `ITEMMASTER-STANDALONE-20260829`
- 작성일: 2026-08-29
- 기준 소스: `origin/main` `cedc328b00b5a2079dbd5f2dcd33748349cb8fe7`
- 상태: 개발·독립 사용 검증 완료

## 1. 목적

현재 `Master.html` 상품관리 화면을 그대로 복사해 `ItemMaster.html` 독립 앱으로 만든다. 새로운 저장 엔진이나 공통 아키텍처를 만들지 않고, 기존 화면과 검증된 상품 기능을 최소 변경으로 복구한다.

## 2. 개발 범위

1. `Master.html`을 `ItemMaster.html`로 복사한다.
2. 기존 상품 조회·검색·카테고리·Excel 추가·갱신 검토 기능을 유지한다.
3. 전용 DB가 0건이면 검증된 Excel 전체본으로 최초 등록할 수 있다.
4. 상품을 단건 등록하고 기존 상품을 수정할 수 있다.
5. 저장 DB 이름만 ItemMaster 전용 격리 DB로 변경한다.
6. 복사본 안에서 직접 조회·저장하며 운영 Master 저장 함수를 호출하지 않는다.
7. 구형 15개 메뉴, 설정 iframe, 클라우드 Push·Pull 코드를 제거한다.
8. Pipeline·BOM·카탈로그 기능을 포함하지 않는다.
9. 독립 실행, 저장과 새로고침 후 유지 여부만 검증한다.

## 3. 변경 금지 범위

- `Master.html`
- `Item_manager.html`
- `MerchOps.html`
- `coreEngine.js`
- `masterAddUpdate.js`
- `app-manifest.json`
- NEXUS 공통헤더 앱 주소
- 운영 `MerchOpsDB`와 `merchMaster_v870`
- 서버·Gateway·인증·권한
- 거래처·ORDER Q·SmartInput
- 운영 데이터 병합·삭제·자동 이전

## 4. 저장 기준

- DB: `oneapp-itemmaster-isolated-v1`
- 상품 Store: `products`
- 상태 Store: `store`
- Snapshot Key: `itemMasterSnapshot_v1`
- Revision Key: `itemMasterRevision_v1`

상품 Snapshot과 Revision은 같은 IndexedDB transaction에서 저장한다. 저장 시작 Revision과 현재 Revision이 다르면 기존 데이터를 덮어쓰지 않는다. 운영 DB로 fallback하지 않는다.

## 5. 유지 기능

- 상품 전체 조회
- 상품코드·상품명·규격 검색
- 1·2·3차 카테고리 조회
- Excel 신규 상품 추가
- Excel 기존 상품 수정
- 0건 상태의 Excel 최초 등록
- 상품 단건 등록
- 기존 상품 단건 수정
- Excel 동일·신규·변경·누락·중복 판정
- 관리자 선택 항목만 저장
- Excel에 없는 기존 상품 유지
- 새로고침 후 저장 결과 유지

최초 Excel 등록은 전용 DB가 0건일 때만 허용한다. 상품코드 중복과 품목명·규격·단위 누락을 차단하고, 관리자가 검증 건수와 Revision을 확인한 뒤 저장한다. 단건 등록·수정은 동일한 전용 DB와 Revision 저장 경로를 사용한다.

## 6. 제거 기능

- 구형 앱 메뉴
- 설정 iframe
- 클라우드 URL 설정
- 클라우드 Push·Pull
- 운영 Core 저장 호출
- 운영 history 기록
- 운영 동기화 trigger
- 오류 화면의 운영 DB 삭제

## 7. 화면 기준

- 기존 Master 상품 조회 화면과 Excel 검토 화면을 유지한다.
- 상단에는 `ITEMMASTER · 독립 상품관리`와 전용 DB 상태만 표시한다.
- 공통헤더와 Manifest에는 아직 ItemMaster 주소를 등록하지 않는다.
- 기존 Master 화면과 MerchOps 화면은 변경하지 않는다.

## 8. 검증 기준

1. `ItemMaster.html` 직접 진입이 가능하다.
2. 업무 Gateway 요청 없이 화면이 표시된다.
3. 운영 `MerchOpsDB`와 운영 localStorage에 접근하지 않는다.
4. 격리 DB의 상품을 조회한다.
5. Excel 추가·갱신 결과를 격리 DB에 저장한다.
6. 새로고침 후 동일 데이터와 Revision이 유지된다.
7. Revision 충돌 시 기존 데이터를 보호한다.
8. Master·MerchOps·Item Manager·Core·Manifest가 변경되지 않는다.
9. Pipeline·BOM·카탈로그·거래처·SmartInput 코드가 포함되지 않는다.
10. 전용 DB 0건 상태에서 최초 Excel 등록이 가능하다.
11. 상품 단건 등록·수정 후 새로고침해도 결과가 유지된다.

## 9. 완료 후 별도 작업

ItemMaster 독립 복구가 완료된 뒤 별도 개발명세로 진행한다.

1. MerchOps 상품정보 연동
2. 운영 데이터 적용·복구
3. 공통헤더·Manifest 공식 주소 변경
4. 기존 `Master.html` 유지·연결·폐기 결정
