# ItemMaster 독립 상품관리 앱 개발명세서 v1.2

- 작업 ID: `ITEMMASTER-STANDALONE-20260829`
- 작성일: 2026-08-29
- 기준 소스: `origin/main` `1f0797fd7fec3137a4d85a98d6d1ba26f5df4860`
- 상태: 독립 기능 완성·운영 안전 보완

## 1. 목적

현재 `Master.html` 상품관리 화면과 검증된 알고리즘을 기준으로 `ItemMaster.html` 독립 앱을 만든다. 새로운 공통 아키텍처를 만들지 않고 기존 상품 기능을 최소 범위로 복구한다. 현재 전용 격리 DB는 독립 기능 검증용이며 최종 운영 저장소가 아니다.

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

상품 단건 등록·수정은 최초 확정명세 이후 개발 과정에서 추가된 기능이다. 운영 검토를 통해 유용성을 확인했으며 v1.2부터 정식 승인 기능으로 유지한다.

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

이 저장소는 독립 기능 검증 단계의 임시 저장소다. 구버전 교체 단계에서는 현재 운영 상품 데이터를 이전·삭제하거나 별도 복제하지 않고, 신규 ItemMaster가 운영 상품정보에 연결되는 계약을 별도로 확정한다.

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
- 브라우저 상품정보를 초기화·교체하는 테스트 페이지

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
12. 자동검사는 실제 브라우저에서 상품 등록·수정·새로고침 후 IndexedDB 값과 Revision을 확인한다.
13. 운영에 함께 게시되는 초기화·시드 테스트 HTML이 존재하지 않는다.

## 9. 최종 운영 역할

ItemMaster는 향후 기존 앱과 신규 앱에 상품 기준정보를 제공하는 기준 앱으로 운영한다.

- 앱마다 별도의 상품정보를 생성하지 않는다.
- MerchOps 등 기존 앱의 상품정보 연결 대상을 구버전 `Master.html`에서 신규 `ItemMaster.html`로 전환한다.
- 공통 필드·조회·갱신 계약은 구버전 교체 개발명세에서 확정한다.
- ItemMaster 연결 장애가 기존·신규 앱의 기본 화면과 로컬 작업을 차단하지 않도록 구성한다.
- 구버전은 전환과 검증이 완료될 때까지 유지한다.

## 10. 구버전 교체 순서

1. 구버전 `Master.html`을 사용하는 앱·메뉴·DB·저장 함수를 전수 확인한다.
2. 상품정보 조회 연결과 저장 연결을 구분한다.
3. 신규 ItemMaster를 현재 운영 상품정보에 연결한다.
4. MerchOps 등 기존 앱의 연결 대상을 신규 ItemMaster로 변경한다.
5. 공통헤더·Manifest의 공식 상품관리 주소를 변경한다.
6. 동일 상품의 조회·수정·Excel 반영 결과를 구버전과 신버전에서 비교 검증한다.
7. 검증 완료 후 구버전 쓰기를 차단하고 기존 주소를 신규 주소로 전환한다.
8. 구버전 연결이 0건임을 확인한 후에만 폐기한다.

구버전 교체 과정에서 현재 운영 상품 데이터는 이전·삭제하지 않고 그대로 연결한다. 전환 전 구버전을 먼저 삭제하거나 운영 저장소를 자동 변경하지 않는다.
