# ORDER Q vNext

신규 ORDER Q 개발 경로. 기존 `orderops/` 및 `orderops_list.html`은 변경하지 않는다.

## vNext 0.4.9 URL

- `/orderq/` 또는 `/orderq/index.html`: 공통 주문현황
- `/orderq/input.html`: 수기 주문서 신규/수정
- `/orderq/parser.html`: 카카오/일반 텍스트 SmartParser
- `/orderq/collector.html`: 과거 주문·판매·구매·재고·거래처원장·카카오 이력수집과 주문↔판매 연결
- `/orderq/cloud.html`: Cloud Sync 설정·충돌 처리

## 데이터와 처리 원칙

브라우저 IndexedDB `oneapp-orderq-vnext`를 로컬 업무 DB로 사용하고, Apps Script Web App을 통해 목적별 Google Sheet와 증분 동기화한다.

핵심 스토어:

- `customers`, `products`
- `customerAliases`, `productMappings`, `unitMappings`
- `rawInputs`, `parseResults`, `mappingEvents`
- `orders`, `orderItems`, `orderEvents`
- `importBatches`, `sourceRecords`
- `salesDocuments`, `salesLines`, `purchaseDocuments`, `purchaseLines`
- `ledgerDocuments`, `ledgerLines`, `inventorySnapshots`, `inventoryLines`
- `historicalOrderGroups`, `historicalOrderLines`, `fulfillmentLinks`, `fulfillmentBalances`, `parserEvidence`
- `syncQueue`, `meta`

주문 수정은 `revision` 비교를 사용한다. 같은 주문을 두 탭에서 열고 한쪽이 먼저 저장하면, 다른 쪽의 오래된 revision 저장은 차단한다.

수기 주문은 같은 출처의 `MerchOpsDB/master_products`를 읽기 전용으로 검색한다. 공통 마스터 후보를 선택한 행만 매칭완료로 저장하며 직접입력 행은 미매칭 상태로 보존한다.

수기 주문 화면은 ERP 입력 밀도에 맞춰 최대 1,100px 폭과 고정 열 배분을 사용한다. 주문 입력의 기본 흐름은 거래처 → 출하창고 → 품목코드 → 수량 → 단가 → 적요이며, 마지막 행의 적요에서 Enter를 누르면 다음 행을 자동 생성한다. 상품 검색은 품목코드에서만 실행한다.

표 헤더의 오른쪽 끝선을 드래그하면 열 너비를 조정할 수 있다. 실제 조정 후 나타나는 `열너비 저장` 버튼을 누르면 현재 열 너비를 브라우저에 저장하고 다음 접속 때 복원한다. 일자 입력은 선택할 때 일(day) 두 자리에 자동 포커스하며 ↑·↓로 하루씩 증감한다.

공식 표시명은 `박스당수량`과 `단위`다. 박스당수량은 1박스 입수이고 단위는 상품 마스터 기준 처리 단위다. 합계는 수량×단가로 제안하지만 할인·잔액정리를 위해 직접 수정할 수 있다. 열 추가 메뉴에서 박스당수량·단위·부가세를 선택 노출하며, 부가세는 합계의 10% 제안값을 직접 수정할 수 있다.

단가 헤더는 클릭 가능한 드롭다운이며 기본값은 `판매가`다. 판매가는 행사가가 있으면 행사가, 없거나 0이면 출고가를 자동 적용한다. 헤더 선택이나 단가 셀의 ▲▼·키보드 위·아래 화살표로 `판매가 → 출고가 → 도매A → 도매B → 상장가 → 시중가 → 행사가`를 전환하면 헤더명과 전체 단가열이 함께 바뀐다. 직접 금액을 수정한 행은 `직접입력`, 서로 다른 단가가 섞인 주문은 `혼합단가`로 헤더에 표시한다. 선택한 단가 종류는 주문 품목의 `priceType`으로 보존한다.

SmartParser는 원문을 `rawInputs`, 메시지별 판정·후보·관리자 확정값을 `parseResults`에 분리 저장한다. 신규 주문으로 확정할 때만 공통 `createOrder`를 호출한다. 부분 변경·취소 메시지는 주문 전체를 자동 변경하지 않고 수기 검수 대기로 남긴다. 동일 `sourceMessageKey`는 기존 결과를 다시 보여주며 신규 주문을 중복 생성하지 않는다.
