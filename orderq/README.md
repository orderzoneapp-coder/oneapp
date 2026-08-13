# ORDER Q vNext

신규 ORDER Q 개발 경로. 기존 `orderops/` 및 `orderops_list.html`은 변경하지 않는다.

## vNext 0.4.2 URL

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

SmartParser는 원문을 `rawInputs`, 메시지별 판정·후보·관리자 확정값을 `parseResults`에 분리 저장한다. 신규 주문으로 확정할 때만 공통 `createOrder`를 호출한다. 부분 변경·취소 메시지는 주문 전체를 자동 변경하지 않고 수기 검수 대기로 남긴다. 동일 `sourceMessageKey`는 기존 결과를 다시 보여주며 신규 주문을 중복 생성하지 않는다.
