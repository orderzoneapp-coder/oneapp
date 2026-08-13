# ORDER Q vNext

신규 ORDER Q 개발 경로. 기존 `orderops/` 및 `orderops_list.html`은 변경하지 않는다.

## Phase 1 URL

- `/orderq/` 또는 `/orderq/index.html`: 신규 주문현황
- `/orderq/input.html`: 수기 주문서 신규/수정

## Phase 1 데이터

브라우저 IndexedDB `oneapp-orderq-vnext`에 독립 저장된다. 아직 기존 ORDER Q 주문현황 또는 Google Sheet Cloud와 자동 연동하지 않는다.

핵심 스토어:

- `customers`, `products`
- `customerAliases`, `productMappings`, `unitMappings`
- `rawInputs`, `parseResults`, `mappingEvents`
- `orders`, `orderItems`, `orderEvents`
- `syncQueue`, `meta`

주문 수정은 `revision` 비교를 사용한다. 같은 주문을 두 탭에서 열고 한쪽이 먼저 저장하면, 다른 쪽의 오래된 revision 저장은 차단한다.
