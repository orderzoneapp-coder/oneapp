# ORDER Q vNext

ORDER Q 주문 소유 경로. `orderops/` 및 `orderops_list.html`은 ORDER Q가 제공하는 읽기 전용 출고후보 Adapter를 소비하고 출고 작업·결과를 별도 소유한다.

## vNext 0.8.0 URL

- `/orderq/` 또는 `/orderq/index.html`: 주문조회(전표 목록·펼침·상품상세·수정·출력)
- `/orderq/input.html`: 주문서 직접입력·수정
- `/orderq/parser.html`: ORDER IN(카카오/일반 텍스트 SmartParser)
- `/orderq/operations.html`: ORDER Q 운영관리(전표조건 선필터·상품집계·재고·판매이관·미출고)
- `/orderops/list.html?orderId=...`: 주문조회에서 연결되는 출고관리. 주문은 자동연동하고 창고재고 Excel은 필수로 유지한다.
- `/orderops/list.html`: 주문현황 Excel 수동 입력도 호환 경로로 유지한다.
- `/orderq/collector.html`: 과거 주문·판매·구매·재고·거래처원장·카카오 이력수집과 주문↔판매 연결
- `/orderq/cloud.html`: Cloud Sync 설정·충돌 처리

## 데이터와 처리 원칙

브라우저 IndexedDB `oneapp-orderq-pre-m1-v6` v7을 로컬 업무 DB로 사용하고, Apps Script Web App을 통해 목적별 Google Sheet와 증분 동기화한다. 기존 M1~M10 DB는 삭제하지 않고 별도 보존한다. 주문 동기화와 공식 구매·판매 동기화는 서로 다른 schema와 회사별 cursor를 사용한다.

작업자 흐름은 `스마트입력 → 주문조회 → 출고관리`로 구분한다. 직접입력·ORDER IN·Excel·쇼핑몰·외부연동은 모두 공통 `createOrder`를 호출하며 입력경로는 `inputChannel`로 기록한다. SmartInput 다건 입력은 건별 부분 성공을 허용하고 성공 전표마다 공식 `focus` URL을 제공한다. `orderId` 조회 파라미터는 호환 별칭으로만 받아 `focus`로 정규화한다.

`orderId`는 시스템 내부키, `orderNo`는 저장 시 발급하는 날짜별 관리자 주문번호(`YYYYMMDD-NNN`), `externalOrderNo`는 쇼핑몰·외부 연결키다. 기존 주문은 DB v6 전환 때 주문일 순서로 주문번호를 보완한다.

주문상태(`ORDER/PAID/PREPARING/SHIPPING/COMPLETED/FULL_CANCEL/PARTIAL_CANCEL`), 관리자상태(`UNCHECKED/CHECKED/HOLD`), ORDER Q 운영상태(`ACTIVE/CLOSED`)를 서로 분리한다. `CLOSED`는 판매전표로 이관되어 운영 처리가 끝난 종결이며 주문상태 완료와 다르다.

판매이관은 `ORDER_EVENT`의 불변 이력(`SALES_TRANSFER_ALLOCATED` / `SALES_TRANSFER_REVERSED`)으로 보존한다. 총이관수량과 미출고수량은 이력을 합산해 계산하며 주문상품에 결과값을 덮어쓰지 않는다. 미출고가 음수면 0으로 보정하지 않고 초과이관으로 표시한다. 모든 유효 주문상품의 미출고가 0이고 초과이관이 없으며 관리자상태가 보류가 아닐 때만 종결되고, 역분개로 미출고가 생기면 자동 재개 이벤트를 남긴다.

담당자는 거래처가 아니라 주문전표 속성인 `assigneeId/assigneeName`으로 보존한다. 변경은 해당 전표에만 적용되고 주문 이벤트에 변경 전·후 값이 남는다. 판매전표는 같은 담당자 필드를 사용하며 주문 이관 시 `inheritedAssigneeSnapshot`을 적용한다.

주문현황의 일반 인쇄는 인쇄 전표를 열고, 카카오톡 복사는 모바일 세로형 주문전표 PNG를 생성해 이미지 클립보드에 기록한다. 브라우저가 이미지 클립보드를 지원하지 않거나 권한을 거부하면 PNG 다운로드로 전환한다.

쇼핑몰 주문에는 계산 정책이 아니라 결과값만 보관한다: `productAmount`, `couponDiscount`, `pointsUsed`, `shippingFee`, `paymentAmount`, `externalOrderNo`, `externalOriginalStatus`.

핵심 스토어:

- `customers`, `products`
- `customerAliases`, `productMappings`, `unitMappings`
- `rawInputs`, `parseResults`, `mappingEvents`
- `orders`, `orderItems`, `orderEvents`
- `importBatches`, `sourceRecords`
- `salesDocuments`, `salesLines`, `purchaseDocuments`, `purchaseLines`
- `ledgerDocuments`, `ledgerLines`, `inventorySnapshots`, `inventoryLines`
- `historicalOrderGroups`, `historicalOrderLines`, `fulfillmentLinks`, `fulfillmentBalances`, `parserEvidence`
- `officialCommands`, `voucherRevisions`, `inventoryMovements`, `payableEntries`, `receivableEntries`
- `pendingInventoryEffects`, `inventoryCheckpoints`, `unresolvedProducts`
- `syncQueue`, `meta`

공식 구매·판매는 전표·재고·채권·채무를 먼저 로컬 transaction으로 확정한 뒤 `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1`으로 백그라운드 동기화한다. 서버 미배포·오류는 로컬 확정을 취소하지 않는다. 서버는 회사별 전표 Revision과 미매칭 상품 최초 매칭을 검사하고 경쟁 변경은 `CONFLICT`로 보존한다.

주문 수정은 `revision` 비교를 사용한다. 같은 주문을 두 탭에서 열고 한쪽이 먼저 저장하면, 다른 쪽의 오래된 revision 저장은 차단한다. 출고관리는 작업 시작 시 주문 `revision`과 `snapshotHash`를 고정하고 확정 직전에 다시 읽는다. 불일치하면 작업자 입력을 유지한 채 확정을 차단하며, 확정 뒤 주문이 바뀐 결과는 `REVIEW_REQUIRED`로 표시한다. 출고결과 저장 transaction도 동시 확정의 잔여수량과 중복 역분개를 검사한다. 출고취소는 확정 기록을 삭제하지 않고 별도 역분개 결과를 추가한다. 주문조회에는 이 결과를 기존 주문·관리자·운영·판매이관 상태와 섞지 않고 `출고상태` 축으로 별도 표시한다.

주문현황은 전표별 대표품목·총수량·주문금액을 기본 목록에 표시한다. 전표를 펼친 뒤 별도 페이지 이동 없이 거래처, 창고, 담당자, 배송예정일, 주문상태, 관리자상태, 메모와 상품별 규격·수량·판매가를 수정할 수 있다. 담당자·상태·상품 변경은 변경자와 시간, 전후값을 기존 주문 이벤트에 기록한다. 전체취소 전표는 상품과 금액을 바꿀 수 없지만 담당자와 관리자상태는 다시 변경할 수 있다.

수기 주문은 같은 출처의 `MerchOpsDB/master_products`를 읽기 전용으로 검색한다. 공통 마스터 후보를 선택한 행만 매칭완료로 저장하며 직접입력 행은 미매칭 상태로 보존한다.

수기 주문 화면은 ERP 입력 밀도에 맞춰 최대 1,100px 폭과 고정 열 배분을 사용한다. 주문 입력의 기본 흐름은 거래처 → 출하창고 → 품목코드 → 수량 → 단가 → 적요이며, 마지막 행의 적요에서 Enter를 누르면 다음 행을 자동 생성한다. 상품 검색은 품목코드에서만 실행한다.

표 헤더의 오른쪽 끝선을 드래그하면 열 너비를 조정할 수 있다. 실제 조정 후 나타나는 `열너비 저장` 버튼을 누르면 현재 열 너비를 브라우저에 저장하고 다음 접속 때 복원한다. 일자 입력은 선택할 때 일(day) 두 자리에 자동 포커스하며 ↑·↓로 하루씩 증감한다.

공식 표시명은 `박스당수량`과 `단위`다. 박스당수량은 1박스 입수이고 단위는 상품 마스터 기준 처리 단위다. 합계는 수량×단가로 제안하지만 할인·잔액정리를 위해 직접 수정할 수 있다. 열 추가 메뉴에서 박스당수량·단위·부가세를 선택 노출하며, 부가세는 합계의 10% 제안값을 직접 수정할 수 있다.

단가 헤더는 클릭 가능한 드롭다운이며 기본값은 `판매가`다. 판매가는 행사가가 있으면 행사가, 없거나 0이면 출고가를 자동 적용한다. 헤더 선택이나 단가 셀의 ▲▼·키보드 위·아래 화살표로 `판매가 → 출고가 → 도매A → 도매B → 상장가 → 시중가 → 행사가`를 전환하면 헤더명과 전체 단가열이 함께 바뀐다. 직접 금액을 수정한 행은 `직접입력`, 서로 다른 단가가 섞인 주문은 `혼합단가`로 헤더에 표시한다. 선택한 단가 종류는 주문 품목의 `priceType`으로 보존한다.

SmartParser는 원문을 `rawInputs`, 메시지별 판정·후보·관리자 확정값을 `parseResults`에 분리 저장한다. 신규 주문으로 확정할 때만 공통 `createOrder`를 호출한다. 부분 변경·취소 메시지는 주문 전체를 자동 변경하지 않고 수기 검수 대기로 남긴다. 동일 `sourceMessageKey`와 동일 payload hash는 기존 결과를 다시 보여주고, 같은 키의 다른 payload는 충돌로 차단한다. `sourceDocumentKey`와 `sourceLineKey`는 주문·행까지 보존한다.
