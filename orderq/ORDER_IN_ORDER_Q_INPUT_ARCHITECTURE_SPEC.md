# ORDER IN / ORDER Q 입력 아키텍처 개발명세

- 문서 상태: 구현 기준 확정안
- 분석 기준: `origin/main` `c236ca4708a3f76f5a7d14d92db7d5f87c1bb368`
- 적용 대상: `/orderq/parser.html`, `/orderq/input.html` 및 ORDER Q 주문 입력 경계
- 변경 등급: 중요 개발
- 원칙: 기존 M1~M10 원장·재고·출고·구매·ERP 계약을 유지하고 ORDER IN 계층만 확장한다.

## 1. 목적과 범위

ORDER IN은 카카오 대화, 일반 텍스트, 사진/OCR, 임의 Excel처럼 상품 식별이나 전표구조가 아직 결정되지 않은 외부정보를 읽어 관리자가 확인할 수 있는 정형 전표로 만든다.

ORDER Q는 상품 식별이 결정된 전표를 주문·재고·출고·구매·판매·ERP 업무로 운영한다. 상품 식별 결정은 `Master 상품 확정` 또는 `관리자 확정 임시상품`이다.

이번 개발의 목적은 현재의 `원문 메시지 1건 = 주문 1건` 제약을 제거하고 다음 흐름을 하나의 실제 업무 화면으로 완성하는 것이다.

```text
외부 원본
→ 거래정보 추출
→ 전표/거래처 단위 분리
→ 상품 매칭
→ 관리자 확인
→ 상품 식별이 결정된 주문전표
→ 기존 ORDER Q 주문원장
```

이번 범위는 ORDER Q 원장 재작성이나 M1~M10 재설계가 아니다. 주문원장 앞단에 `Intake` 계층을 추가하고 기존 `createOrder()` 경계로 인계한다.

## 2. 확정 제품 책임

### 2.1 ORDER IN

ORDER IN의 입력 대상은 다음과 같다.

- 카카오·문자·메신저 대화
- 일반 텍스트 및 텍스트와 이미지의 혼합 입력
- 사진·캡처·OCR 결과
- 거래처 임의 Excel
- ONEAPP Master와 아직 연결되지 않은 외부 상품코드
- 발신자, 실제 거래처, 전표 구분을 추가로 판단해야 하는 자료

ORDER IN은 다음을 책임진다.

- 원본을 수정값과 분리하여 보존한다.
- 한 원본에서 거래정보를 추출한다.
- 한 원본을 1개 또는 N개의 전표로 나눈다.
- 발신자와 실제 주문 거래처를 별도 값으로 관리한다.
- 상품 표현을 Master 상품 후보로 매칭한다.
- 관리자의 수정·확정을 이력으로 남긴다.
- 주문 저장이 가능한 전표 Draft를 기존 ORDER Q로 전달한다.

### 2.2 ORDER Q

ORDER Q는 다음 입력을 받는다.

- ORDER IN에서 관리자가 확정한 주문
- ONEAPP Master 코드가 포함된 쇼핑몰 주문
- 코드가 확정된 ERP·Excel·API 자료
- 직접 입력 주문

ORDER Q는 자연어 SmartParser를 다시 실행하지 않는다. 기존 주문원장 이후의 창고, 거래유형, 담당자, 배송, 재고, 출고, 구매, 판매, 미출고, ERP 업무를 담당한다.

### 2.3 Collector

Collector는 일상 주문입력기가 아니다. 다음 기초자료를 보존하고 초기 매칭 근거를 만드는 Bootstrap 작업대다.

- 과거 주문·판매·구매 이력
- 거래처와 취급상품 관계
- 상품 표현과 Master 상품의 과거 연결 근거
- 기초재고 Snapshot
- 수집 이력과 롤백

Collector의 `KAKAO_HISTORY` 흐름은 과거 이력 수집으로 유지한다. Collector에서 운영 주문을 직접 생성하지 않는다.

## 3. 입력 Routing 결정표

| 입력 조건 | 진입 경로 | 처리 | 최종 경계 |
| --- | --- | --- | --- |
| 카카오·텍스트·사진·OCR | ORDER IN | 추출·전표분리·거래처·상품 매칭 | `createOrder()` |
| 거래처 임의 Excel, 열·코드 불확정 | ORDER IN | 구조 해석 후 관리자 확인 | `createOrder()` |
| 외부 SKU가 있고 ONEAPP 대응표가 없음 | ORDER IN 코드매핑 | 외부코드↔Master 코드 확정 | 구조화 Import |
| ONEAPP 상품·거래처 코드가 모두 유효한 Excel | ORDER Q Import | 구조·중복·코드 검증 | `createOrder()` |
| 코드 계약이 완료된 쇼핑몰·ERP·API | ORDER Q Import | SmartParser 우회 | `createOrder()` |
| 관리자 직접 입력 | ORDER Q 수기입력 | 기존 실제 주문 Grid | `createOrder()` |
| 과거 판매·구매·주문자료 | Collector | 이력·매칭근거 저장 | 운영 주문 미생성 |
| 기초재고 | Collector | InventorySnapshot 기준 생성 | 현재고 기준에 반영 |

## 4. 최신 소스 기준 현재 구조

### 4.1 현재 호출 흐름

```text
parser.html
→ parser-ui.js
→ smartparser/source-parser.js
→ smartparser/parser-orchestrator.js
→ customer-resolver.js
→ line-parser.js
→ candidate-generator.js
→ parser-repository.js
→ parser-ui.js의 별도 결과 Grid
→ order-intake-engine.js createOrder()
→ orders / orderItems / orderEvents / syncQueue
```

수기 주문은 다음 별도 흐름을 사용한다.

```text
input.html의 실제 주문 Grid
→ product-master-search.js
→ order-intake-engine.js createOrder()
```

### 4.2 현재 저장구조

- `rawInputs`: 입력 원문과 raw fingerprint
- `parseResults`: 메시지별 분석결과, `bySourceMessageKey` unique
- `productMappings`: 거래처·출처·공통 표현 매핑
- `mappingEvents`: 매핑 변경 이력
- `orders`: 주문 헤더, `bySourceMessageKey` unique
- `orderItems`: 주문행
- `orderEvents`: append-only 주문 이벤트
- `syncQueue`: 로컬/중앙 동기화 대기열

현재 DB는 IndexedDB v7이며 전체 Store 백업·복원은 `Object.values(STORE)`를 동적으로 사용한다. 새 Store를 `STORE`에 등록하면 전체 백업 대상에 자동 포함되지만, v7 백업을 v8에서 복원하는 호환 테스트는 별도로 추가해야 한다.

### 4.3 현재 중복방지

- `rawInputs`: 동일 원본 fingerprint 중복 방지
- `parseResults`: `sourceMessageKey` unique
- `orders`: `sourceMessageKey` unique
- Cloud: `orderQFindOrderBundleBySourceMessageKey()`가 같은 키의 기존 주문을 찾는다.

이 계약 때문에 하나의 메시지에서 주문 N건을 만들 수 없다.

### 4.4 현재 매칭

- `customer-resolver.js`는 `senderRaw + sourceId`를 중심으로 고객을 찾는다.
- `candidate-generator.js`는 거래처·출처·공통 매핑, 거래처 주문이력, Master 검색을 함께 사용한다.
- 기존 빈도 `useCount`가 점수에 영향을 주므로 최신 관리자의 명시적 수정이 항상 우선한다고 보장할 수 없다.
- `parser-ui.js`는 실제 주문 Grid와 다른 Parser 전용 표를 사용하고 행별 `rememberMapping` 체크를 요구한다.

### 4.5 현재 사진 입력

`photo-ocr.js`의 paste 처리는 `#photoCollector`가 보이는 동안에만 동작한다. 텍스트와 이미지를 한 입력 세션으로 받는 공통 Clipboard 경계가 없다.

## 5. 기획과 현재 구현의 Gap

| 항목 | 현재 | 필요한 구조 | 분류 |
| --- | --- | --- | --- |
| 원문→전표 | 메시지 1건→결과 1건→주문 1건 | 원문 1건→전표 N건 | 수정 |
| 발신자/거래처 | 발신자가 거래처 판정 출발점 | 발신자는 출처 증거, 실제 거래처는 전표별 판단 | 수정 |
| 전표 ID | `sourceMessageKey` 하나 | `sourceMessageKey` + `sourceDocumentKey` | 신규 |
| Parser 화면 | Parser 전용 Card/Grid | 수기입력과 같은 실제 주문 Grid | 수정 |
| 다전표 편집 | 없음 | 분할·병합·행이동·거래처변경 | 신규 |
| 사진/텍스트 | 화면별 분리 | 공통 Clipboard Intake | 수정 |
| 매핑 확정 | 행별 저장 checkbox | 단계 완료 시 자동 피드백 기록 | 수정 |
| Collector | 이력 수집과 SmartParser 검수 | Bootstrap 전용 역할 유지 | 유지/명확화 |
| M1~M10 | 완성된 운영계약 | 변경하지 않음 | 유지 |

## 6. 목표 아키텍처

```text
                 ┌────────────────────────────┐
텍스트/사진/파일 →│ IntakeSession              │
                 │ Raw Evidence + SourcePart  │
                 └─────────────┬──────────────┘
                               ↓
                 SourceMessage / SourceBlock
                               ↓
                 Document Segmentation
                               ↓
            ┌──────── IntakeDocumentDraft N개 ────────┐
            │ 거래처·헤더·IntakeLineDraft             │
            │ 추출값·후보·관리자 확정값·원문근거       │
            └──────────────────┬───────────────────────┘
                               ↓
                 동일한 실제 Order Draft/Grid
                               ↓
                    기존 createOrder()
                               ↓
              orders/orderItems/orderEvents
                               ↓
             기존 M1~M10 출고·재고·구매·ERP
```

## 7. Intake Domain Model

### 7.1 `IntakeSession`

| 필드 | 계약 |
| --- | --- |
| `intakeSessionId` | 로컬 고유 ID |
| `documentType` | 계약상 `ORDER`, `QUOTE`, `PURCHASE`, `SALE`; 1차 runtime은 `ORDER`만 등록 |
| `sourceMode` | `CLIPBOARD`, `FILE`, `DIRECT_EXTERNAL` |
| `sourceType` | `KAKAO_TEXT`, `GENERAL_TEXT`, `IMAGE_OCR`, `MIXED`, `EXCEL` 등 |
| `sourceId` | 방·파일·연동 출처 식별자 |
| `sourceOccurrenceKey` | 실제 원본 발생건의 고유키, 세션 중복판정 기준 |
| `captureOccurrenceId` | 외부 발생 ID가 없는 수동 입력에 발급하는 입력 발생 ID |
| `rawFingerprint` | 입력 내용의 canonical SHA-256, 동일성·충돌 증거이며 전역 중복키 아님 |
| `stage` | 현재 업무 단계 |
| `status` | `ACTIVE`, `COMMITTED`, `EXCLUDED` |
| `revision` | 로컬 수정 충돌 검사 |
| `createdAt/By`, `updatedAt/By` | 감사 필드 |

### 7.2 `IntakeSourcePart`

| 필드 | 계약 |
| --- | --- |
| `sourcePartId` | 세션 내 원본 조각 ID |
| `intakeSessionId` | 소속 세션 |
| `partType` | `TEXT`, `IMAGE`, `FILE` |
| `contextIndex` | 원문 순서 |
| `rawText` | 수정하지 않는 원문 또는 OCR 이전 설명 |
| `mimeType`, `binaryBase64`, `byteLength` | 이미지 원본, 로컬 IndexedDB 전용 |
| `contentHash` | 조각 SHA-256 |
| `ocrText` | OCR 결과, 원본과 분리 |
| `sourceMessageKey` | 메시지 증거가 있을 때의 기존 키 |
| `senderRaw`, `timestampRaw` | 출처 증거, 거래처 확정값 아님 |

이미지 binary는 Google Sheet 중앙 동기화 대상에서 제외한다. 현재 전체 백업이 JSON 다운로드 방식이므로 원본은 `mimeType + binaryBase64 + byteLength`로 저장해 백업·복원에서 손실되지 않게 한다. 중앙에는 hash, OCR text, 전표·행 provenance만 전송한다. 다른 PC에서 원본 이미지 열람까지 필요해지는 시점에는 별도 Object Storage 계약을 추가하며, Sheet 셀에 base64를 넣지 않는다.

### 7.3 `IntakeDocumentDraft`

| 필드 | 계약 |
| --- | --- |
| `intakeDocumentId` | 편집 Draft ID |
| `intakeSessionId` | 소속 세션 |
| `sourceDocumentKey` | 파생 전표의 영구 중복방지 키 |
| `sourceMessageKeys[]` | 이 전표의 원문 메시지 provenance |
| `documentIndex` | 화면 순서, identity로 사용 금지 |
| `segmentationVersion` | 분리 알고리즘 버전 |
| `senderEvidence[]` | 발신자 증거 |
| `customerCandidate` | 시스템 추천 |
| `confirmedCustomerId/Name` | 관리자 확정 거래처 |
| `headerDraft` | 일자·창고·유형·담당자·배송·메모 |
| `stage`, `reviewStatus` | 화면 단계와 확인필요 상태 |
| `orderId` | 저장 후 생성된 ORDER Q 주문 |
| `revision` | 수정 충돌 검사 |

### 7.4 `IntakeLineDraft`

| 필드 | 계약 |
| --- | --- |
| `intakeLineId` | 행 ID |
| `intakeDocumentId` | 소속 전표 |
| `sourcePartId`, `sourceRange` | 원문 근거 위치 |
| `rawExpression` | 추출 전 원표현 |
| `productText`, `specification` | 추출값 |
| `quantity`, `unit`, `unitPrice` | 추출·관리자 수정값 |
| `candidateProducts[]` | 추천 후보와 근거 |
| `recommendedProductId` | 시스템 추천 |
| `productId`, `itemCode`, `itemName` | 관리자 최종값 |
| `matchStatus` | 기존 core 값 `MATCHED`, `MATCH_FAILED`, `EXCLUDED` 유지 |
| `reviewStatus` | `PENDING`, `CONFIRMED`, `EXCLUDED` |
| `productIdentityStatus` | `MASTER_LINKED`, `TEMPORARY_CONFIRMED`, `UNRESOLVED` |
| `reviewReasonCodes[]` | 확인필요 이유 |
| `revision` | 행 수정 충돌 검사 |

### 7.5 `IntakeEvent`

분할, 병합, 행이동, 거래처 변경, 추출 수정, 매칭 확정, 주문 저장을 append-only로 기록한다.

필수 필드:

```text
eventId, intakeSessionId, intakeDocumentId, intakeLineId,
eventType, before, after, reasonCode, actorId, occurredAt
```

### 7.6 `IntakeDocumentAdapter`

Intake의 추출·매칭·단계 이동은 공통 Shell로 두되, 업무 전표의 필드·검증·저장 명령은 Adapter로 분리한다.

```js
const orderAdapter = {
  documentType: 'ORDER',
  createHeaderDraft(context),
  normalizeLine(intakeLine),
  validateDocument(draft),
  buildCanonicalPayload(draft),
  commit(payload)
};
```

1차 runtime registry에는 `ORDER` Adapter만 등록하며 `commit()`은 기존 `createOrder()`를 호출한다. `QUOTE`, `PURCHASE`, `SALE`은 document type 코드와 interface만 예약하고 구현하지 않는다. Adapter는 Dispatch·Purchase 확정 상태나 ERP 상태를 공통화하지 않으며, 각 업무의 기존 엔진과 transaction 경계를 그대로 호출해야 한다.

## 8. 원문→다전표 분리 계약

### 8.1 자동 분리

Parser는 발신자를 거래처로 확정하지 않는다. 발신자, 거래처명 표현, 줄 구분, 시간, 기존 거래처 alias, 상품 묶음을 근거로 전표 후보를 나눈다.

자동 분리 결과는 추천이며 관리자 확정 전에는 운영 주문이 아니다.

### 8.2 MVP 필수 편집

1차 구현에 다음 네 가지를 모두 포함한다.

- 전표의 거래처 직접 변경
- 선택한 상품행을 새 전표로 분할
- 두 Draft 전표 병합
- 상품행을 다른 Draft 전표로 이동

OCR bounding box를 직접 편집하는 도구와 임의 도형 편집기는 제외한다.

### 8.3 분할·병합 identity

- `sourceDocumentKey`는 최초 Draft 생성 시 발급하고 저장한다.
- 거래처, 상품, 수량처럼 수정 가능한 업무값으로 키를 다시 계산하지 않는다.
- 분할 시 선택된 안정 원문근거로 결정적인 child key를 만들고 원 전표와 `SPLIT_FROM` 이벤트로 연결한다.
- 병합 시 구성 전표키의 정렬 집합으로 결정적인 merge key를 만들고 구성 전표는 `MERGED` 상태로 종료한다.
- 주문 저장 후에는 split/merge로 원 주문을 덮어쓰지 않는다. 기존 append-only 취소 후 새 주문을 만드는 별도 업무로 처리한다.

## 9. ID·중복·멱등 계약

### 9.1 키 역할

| 키 | 역할 |
| --- | --- |
| `rawFingerprint` | 원본 내용 동일성·변조 확인 증거, non-unique |
| `sourceOccurrenceKey` | 실제 발생한 입력 1건의 IntakeSession 중복방지 |
| `sourceMessageKey` | 원문 메시지 provenance |
| `sourceDocumentKey` | 원문에서 파생된 전표별 주문 중복방지 |
| `orderId` | ORDER Q 내부 주문 identity |
| 명령 `idempotencyKey` | 중앙 공식명령 재시도 |

### 9.2 입력 occurrence 계약

같은 내용이 다른 날짜·시간에 반복된 정상 주문은 서로 다른 IntakeSession이어야 한다. 따라서 내용 hash만으로 세션을 재사용하지 않는다.

| 입력 | `sourceOccurrenceKey` 재료 |
| --- | --- |
| 카카오·메신저 | source type + 방/source ID + 플랫폼 message ID. ID가 없으면 발신자 + 원문 timestamp + 메시지 occurrence ordinal |
| ERP·쇼핑몰·API | source system + external batch/document/message ID |
| 식별 가능한 파일 | source system + file/batch identity + file metadata + content hash |
| 일반 붙여넣기·사진 | 사용자가 `[새 입력]`을 시작할 때 한 번 발급한 `captureOccurrenceId` |

- 같은 `sourceOccurrenceKey`와 같은 `rawFingerprint`가 다시 도착하면 기존 세션을 연다.
- 같은 `sourceOccurrenceKey`인데 `rawFingerprint`가 다르면 `SOURCE_OCCURRENCE_CONTENT_CONFLICT`로 거부하고 두 원본을 증거로 남긴다.
- 서로 다른 `sourceOccurrenceKey`는 `rawFingerprint`가 같아도 새 세션을 만든다.
- 일반 붙여넣기를 A/B에서 각각 새로 시작하면 서로 다른 실제 입력으로 본다. 동일 외부 발생건으로 수렴시켜야 할 때는 원 sourceOccurrenceKey를 함께 전달해야 한다.

### 9.3 `sourceDocumentKey` 생성

자동분리 전표키는 같은 source occurrence와 같은 분리 결과에서 항상 같아야 한다. 먼저 각 자동 전표의 `stableSegmentIdentity`를 만든다.

```text
stableSegmentIdentity = SHA-256(
  sourceMessageKey 목록 정렬
  + sourceRange 시작/끝
  + 원문 내 line ordinal
  + 동일근거 occurrence ordinal
)

sourceDocumentKey = SHA-256(
  sourceDocumentKeyVersion
  + documentType
  + sourceOccurrenceKey
  + stableSegmentIdentity
)
```

`sourcePartId`, 생성시각, document random nonce, 거래처·상품·수량 같은 수정 가능한 업무값은 자동 전표키 재료로 사용하지 않는다. `sourceDocumentKeyVersion`은 키 정규화 계약 버전이며 Parser/segmentation 배포 버전과 분리한다. 동일 build의 PC A/B가 같은 source occurrence를 자동분리하면 같은 키가 나온다.

수동 분할 child key는 다음처럼 선택된 원문근거로 결정한다.

```text
SHA-256(parentSourceDocumentKey + 'SPLIT' + selectedStableEvidenceIdentity + keyVersion)
```

같은 parent에서 같은 원문행을 분할하면 A/B에서 같은 child key가 나온다. 수동 병합 결과는 `SHA-256('MERGE' + 정렬된 constituent sourceDocumentKey 목록 + keyVersion)`으로 만든다. 생성된 키는 편집 이후 재계산하지 않는다.

### 9.4 동일 occurrence·전표 재입력

- `sourceOccurrenceKey`가 같은 세션은 상태와 관계없이 새로 만들지 않는다. `EXCLUDED` 세션을 다시 쓰려면 명시적 `REACTIVATED` 이벤트를 남긴다.
- 같은 `sourceDocumentKey`로 `createOrder()`를 다시 호출하면 기존 주문을 반환한다.
- 같은 키에 다른 canonical 주문내용이면 `SOURCE_DOCUMENT_CONFLICT`로 전체 거부한다.
- 원문 1건에서 나온 서로 다른 N개의 `sourceDocumentKey`는 각각 주문을 1건씩 생성할 수 있다.
- 다른 날짜·발생건의 동일 텍스트는 다른 `sourceOccurrenceKey`와 다른 주문을 만든다.

### 9.5 Legacy 호환

- 기존 주문은 `sourceDocumentKey`가 없을 수 있다.
- 마이그레이션 시 `sourceMessageKey`가 있는 주문에는 `LEGACY:<sourceMessageKey>`를 sourceDocumentKey로 채운다.
- `sourceMessageKey`가 없는 수기·구조화 주문은 기존 `orderId`와 기존 idempotency 계약을 유지한다.
- Cloud는 새 주문의 `sourceDocumentKey`를 우선 조회하고, legacy payload만 `sourceMessageKey`로 fallback한다.

## 10. Parser Pipeline

```text
1. Capture
2. Preserve Raw Parts
3. Source Message/Block Parsing
4. Transaction Extraction
5. Document Segmentation
6. Customer Candidate Resolution
7. Line Parsing
8. Product Candidate Generation
9. Administrator Review
10. Canonical Order Draft
11. createOrder
```

각 단계는 입력과 결과를 덮어쓰지 않고 연결한다. 추출값, 추천값, 관리자 확정값을 별도 필드로 보존한다.

## 11. 거래처 판정 계약

- `senderRaw`는 출처 증거이지 거래처 확정값이 아니다.
- 거래처는 `IntakeDocumentDraft` 단위로 판정한다.
- 후보 근거는 원문 거래처 표현, 방/출처 alias, 과거 명시적 확정, Master 거래처 정확·유사 일치다.
- 한 메시지의 여러 Draft가 서로 다른 거래처를 가질 수 있다.
- 거래처가 확정되지 않아도 Draft 편집은 가능하지만 주문 저장 전 화면에 확인필요로 보고한다.
- 관리자 선택은 `before/after/reason/actor/time` 이력으로 남긴다.

## 12. Product Matching 계약

### 12.1 우선순위

1. 같은 거래처 + 동일 표현의 최신 관리자 확정
2. 같은 거래처 + 유사 표현의 최신 관리자 확정
3. 같은 거래처의 최근 사용상품
4. 같은 출처의 동일 표현 확정
5. 공통 동일 표현 확정
6. Master 정확일치
7. Master 유사후보

`useCount`는 같은 우선순위·같은 확정시각 범위의 tie-breaker로만 사용한다. 과거 빈도가 최신 관리자 수정을 이기지 못한다.

### 12.2 관리자 확인

SmartParser는 주문서를 먼저 채우는 추천 도구다. `[매칭 완료]` 시점의 실제 Grid 값이 최종 결과다.

- 추천과 동일: `ACCEPTED_AUTO`
- 다른 Master 상품 선택: `CORRECTED`
- 코드 없이 품명 직접입력: `TEMPORARY`
- 기존 행 삭제: `REMOVED`
- 주문에서 제외: `EXCLUDED`

행별 `매핑저장` checkbox는 제거한다. 단계 완료 시 시스템 추천과 최종값의 차이를 자동으로 기록한다.

## 13. Mapping 갱신과 변경이력

- Master 상품으로 확정된 행만 `productMappings` 갱신 대상이다.
- 동일 거래처+동일 표현 또는 동일 출처+동일 표현의 최신 관리자 결정을 현재값으로 만든다.
- 기존 값을 직접 삭제하지 않고 `mappingEvents`에 before/after를 남긴다.
- 매핑 이벤트에는 `sourceDocumentKey`, `intakeLineId`, actor, time, decision type을 추가한다.
- 임시상품·제외행은 학습용 확정 매핑을 만들지 않고 IntakeEvent만 남긴다.
- Collector 과거이력은 후보 근거가 될 수 있지만 실제 ORDER IN의 최신 관리자 확정보다 높은 우선순위를 갖지 않는다.

## 14. 임시상품 계약

신규·미등록 상품은 다음과 같이 보존한다.

```text
productId = null
itemCode = ''
itemName = 관리자 직접입력값
reviewStatus = CONFIRMED
productIdentityStatus = TEMPORARY_CONFIRMED
matchStatus = MATCH_FAILED  # 기존 Master 연결상태 호환 projection
```

가짜 `productId`나 가짜 상품코드를 생성하지 않는다. 관리자가 `[매칭 완료]`로 확정한 임시상품은 `createOrder()` 이후 `orderItems`와 Cloud payload에서도 `reviewStatus=CONFIRMED`, `productIdentityStatus=TEMPORARY_CONFIRMED`를 유지한다.

### 14.1 기존 상태 소비자 소스 점검 결과

기존 core `MATCH_STATUS`에는 새 상태를 추가하지 않는다.

- `order-intake-engine.js`가 `MATCHED/MATCH_FAILED/EXCLUDED/CANCELLED`로 정규화·주문상태·건수를 계산한다.
- `input.html`, `parser-ui.js`, `collector-smartparser-review.js`, SmartParser 요약과 기존 계약 테스트가 같은 값을 직접 비교한다.
- `order-fulfillment-lifecycle.js`는 취소상태만 별도로 보고, `dispatch-workbench.js`는 `actualProductId`가 없으면 기존 `PRODUCT_REVIEW`를 생성한다.

따라서 임시상품 판단을 core match enum에 섞지 않고 관리자 검토축과 상품 identity축으로 분리한다. 기존 `matchStatus=MATCH_FAILED`는 Master 미연결이라는 legacy projection일 뿐이며 사용자 화면의 `매칭 실패` 판정으로 사용하지 않는다.

### 14.2 사용자·저장·운영 계약

- 사용자 화면은 `reviewStatus + productIdentityStatus`를 기준으로 `임시상품 확인완료`를 표시한다.
- 빨간 `미매칭`은 `reviewStatus=PENDING + productIdentityStatus=UNRESOLVED`에만 표시한다.
- 기존 `matchingStatus`, `matchedCount`, `matchFailedCount`는 M1~M10 호환을 위해 계산방식을 바꾸지 않는다.
- 신규 사용자 집계는 다음처럼 별도 계산한다.

```text
reviewConfirmedCount         = 관리자 확인 완료행
masterLinkedCount            = Master 연결 행
temporaryConfirmedCount      = 관리자 확정 임시상품 행
unresolvedReviewCount        = 아직 결정하지 않은 행
```

기존 주문의 `productIdentityStatus`가 없으면 `productId + itemCode + itemName`이 모두 있을 때 `MASTER_LINKED`, 그렇지 않으면 `UNRESOLVED`로 읽는다. 이 호환 판정은 기존 행을 자동으로 임시상품 확정으로 승격하지 않는다.

임시상품 주문은 ORDER Q에 정상 저장할 수 있다. 다만 재고 Movement에는 실제 Master `productId`가 필요하므로 자동 출고제안은 기존 `PRODUCT_REVIEW`를 유지하고 화면에는 `출고상품 선택 필요`로 표시한다. 관리자가 Master를 연결하거나 실제 출고상품을 선택하기 전에는 RELEASE/CONFIRM으로 자동 진행하지 않는다.

숫자 0과 공란은 모든 입력·Grid·저장·동기화에서 구분한다. 단가 0을 자동으로 미정이나 오류로 바꾸지 않는다. 주문 확정 전에는 `단가 0 또는 미입력`을 보고하고, 관리자가 그대로 확정하면 0은 서비스 판매의 실제값으로 보존한다.

## 15. 단일전표 UX

### 15.1 공통 화면

처음 진행할 때의 상단 단계:

```text
[1 추출 확인] [2 매칭 확인] [3 주문 완성]
```

3단계에 도달한 뒤 이전 단계로 돌아가는 상단 탭:

```text
[✓ 추출 수정] [✓ 매칭 수정] [● 주문 완성]
```

하단에는 현재 단계의 Primary Action 하나만 둔다.

```text
[추출 확인]
[매칭 완료]
[주문 저장]
```

`DRAFT`, `Revision`, `Lease`, `sourceMessageKey` 같은 내부 용어는 일반 화면에서 숨기고 관리자 상세에서만 제공한다.

### 15.2 1단계: 추출 확인

- 텍스트·이미지·파일을 한 입력영역에서 받는다.
- PC에서는 원본과 추출결과를 나란히 보여준다.
- 추출 거래처·상품·수량은 직접 수정할 수 있다.
- 원본은 수정값으로 덮어쓰지 않는다.
- 이 단계의 질문은 `원문을 제대로 읽었는가?` 하나다.

### 15.3 2단계: 매칭 확인

- `input.html`과 같은 실제 주문상품 Grid를 사용한다.
- 코드 셀은 Master 검색·선택이다.
- 확인필요 행을 먼저 보여주고 전체행 전환을 제공한다.
- 추천 상품, 추천 근거, 최종 상품을 구분한다.
- 별도 SmartParser 전용 주문표를 만들지 않는다.

### 15.4 3단계: 주문 완성

- 같은 Draft/Grid 상태에 주문 Header만 추가로 보여준다.
- 일자, 거래처, 창고, 거래유형, 담당자, 배송일, 전표 전달메시지를 확인한다.
- Grid를 복사해 새 주문서를 만들지 않는다.
- 주문 저장 결과는 주문번호와 다음 행동 `처리할 주문 보기`를 보여준다.

## 16. 다전표 UX

상단 Navigator는 다음 요약을 제공한다.

```text
전체 18 · 정상 14 · 확인필요 3 · 미매칭 1
```

기본 목록은 확인필요 전표만 보여준다. `[전체 보기]`로 전환한다.

각 전표는 동일한 단일전표 1→2→3 UI로 편집한다. 별도 다전표 Parser 엔진을 만들지 않는다.

저장은 다음 규칙을 따른다.

- `[현재 주문 저장]`: 선택한 전표 한 건
- `[확인완료 주문 모두 저장]`: 저장 가능 전표만 독립 transaction으로 순차 생성
- 한 전표 실패가 다른 전표를 롤백하지 않는다.
- 결과 목록에 성공, 기존 주문, 확인필요, 실패를 전표별로 보여준다.

## 17. 상태전이와 수정 무효화

### 17.1 Intake 상태

```text
CAPTURED
→ EXTRACTION_REVIEW
→ MATCH_REVIEW
→ DOCUMENT_REVIEW
→ COMMITTED
```

보조 상태는 `NEEDS_REVIEW`, `EXCLUDED`, `MERGED`만 둔다.

### 17.2 이전 단계 이동

- 매칭 수정에서 추출 수정으로 돌아가도 Header Draft를 지우지 않는다.
- 주문 완성에서 매칭 수정으로 돌아가도 창고·담당자·배송·메모를 유지한다.
- 상품 표현, 규격, 수량, 단위 변경은 해당 행 후보를 재계산한다.
- `productId`, `itemCode`, Master 선택 변경은 해당 행의 매칭 재확인을 요구한다.
- 가격·전표메모만 바꾼 경우 상품 매칭을 무효화하지 않는다.
- 이미 COMMITTED된 주문을 Intake 수정으로 덮어쓰지 않는다.

## 18. 통합 Clipboard/OCR

- paste listener는 특정 사진 패널 표시 여부에 의존하지 않는다.
- Clipboard의 text와 image item을 같은 `IntakeSession`에 순서대로 저장한다.
- OCR 결과는 `ocrText`에 저장하고 이미지 원본은 그대로 보존한다.
- OCR 실패는 세션 실패가 아니라 해당 SourcePart의 `OCR_REVIEW_REQUIRED`로 표시한다.
- 관리자는 OCR 결과를 직접 고칠 수 있다.
- 여러 이미지와 텍스트의 순서를 바꿀 수 있다.
- OCR 엔진이 없어도 텍스트 수기입력으로 계속 진행할 수 있어야 한다.
- 저장 전 `navigator.storage.estimate()`와 원본 `byteLength`를 사용해 이번 입력 크기와 예상 사용량을 표시한다.
- 용량 부족 가능성은 경고하되 관리자의 입력 판단을 임의로 바꾸지 않는다. 실제 `QuotaExceededError` 발생 시 SourcePart 일부만 남기지 않고 해당 저장 transaction을 abort한다.

## 19. 구조화 ORDER Q Import

ONEAPP 코드가 확정된 Excel·쇼핑몰·ERP·API는 자연어 Parser를 우회한다.

```text
구조 확인
→ 거래처 코드 확인
→ 상품 코드 확인
→ sourceDocumentKey/외부전표 중복 확인
→ ORDER Q 주문 생성
```

Import Workbench는 전표별로 `정상`, `중복`, `코드 오류`, `거래처 오류`, `제외`를 보여준다.

외부 SKU 대응표가 없으면 fuzzy 상품명을 자동 확정하지 않고 ORDER IN 코드매핑으로 보낸다.

## 20. DB Migration

### 20.1 권고

IndexedDB를 v7에서 v8로 올리는 비파괴 migration을 사용한다. 기존 Store와 행을 삭제하거나 재작성하지 않는다.

### 20.2 신규 Store

| Store | keyPath | 주요 Index |
| --- | --- | --- |
| `intakeSessions` | `intakeSessionId` | `bySourceOccurrenceKey` unique, `byRawFingerprint` non-unique, `byStageUpdatedAt` |
| `intakeSourceParts` | `sourcePartId` | `bySession`, `bySourceMessageKey`, `byContentHash` |
| `intakeDocuments` | `intakeDocumentId` | `bySession`, `bySourceDocumentKey` unique, `byReviewStatus`, `byOrderId` |
| `intakeLines` | `intakeLineId` | `byDocument`, `bySourcePart`, `byMatchStatus`, `byReviewStatus`, `byProductIdentityStatus` |
| `intakeEvents` | `eventId` | `bySession`, `byDocument`, `byLine`, `byOccurredAt` |

### 20.3 기존 Index 변경

- 기존 `rawInputs.byFingerprint` unique와 `parseResults.bySourceMessageKey` unique는 legacy SmartParser·Collector 호환을 위해 유지한다.
- 신규 운영 ORDER IN은 두 legacy unique index를 IntakeSession 중복판정에 사용하지 않는다. 원본과 추출결과를 신규 `intakeSourceParts/intakeDocuments/intakeLines`에 저장한다.
- 같은 텍스트의 다른 occurrence는 같은 legacy sourceMessageKey를 provenance로 가질 수 있지만 서로 다른 `sourceOccurrenceKey/sourceDocumentKey`를 갖는다.
- `orders.bySourceMessageKey`는 unique를 제거하고 provenance 조회용 non-unique로 재생성한다.
- `orders.bySourceDocumentKey` unique를 추가한다.

IndexedDB는 index option을 현장에서 변경할 수 없으므로 v8 `onupgradeneeded`에서 `orders.bySourceMessageKey` index만 삭제 후 동일 keyPath의 non-unique index로 재생성한다. 주문행은 삭제하지 않는다.

### 20.4 Legacy backfill

같은 v8 upgrade transaction 안에서 다음만 수행한다.

- `sourceDocumentKey`가 없고 `sourceMessageKey`가 있는 주문에 `LEGACY:<sourceMessageKey>` 저장
- 기존 `sourceMessageKey`·orderId·revision·이벤트는 변경하지 않음
- 충돌이 발견되면 upgrade를 중단하고 원 DB v7을 유지

### 20.5 백업·복원

- upgrade 전에 v7 전체 Store 백업을 요구한다.
- v8 전체 백업에는 신규 5개 Store와 이미지 `mimeType/binaryBase64/byteLength`가 포함되어야 한다.
- v7 백업은 v8에서 복원 가능해야 하며 신규 Store는 빈 상태로 남긴다.
- v8 백업을 v7 앱에서 복원하는 downgrade는 지원하지 않는다.
- 복원 실패는 전체 readwrite transaction을 abort한다.

## 21. Cloud/Sync 영향

### 21.1 ORDER 계약

Cloud ORDER payload에 다음을 추가한다.

```text
sourceDocumentKey
sourceOccurrenceKey
sourceMessageKey
intakeSessionId
intakeDocumentId
```

Sheet header를 새로 늘리지 않고 기존 entity payload JSON에 포함한다.

### 21.2 중복 조회

서버 함수는 다음 순서로 바꾼다.

```text
orderQFindOrderBundleBySourceDocumentKey()
→ legacy payload에 한해 orderQFindOrderBundleBySourceMessageKey()
```

같은 sourceDocumentKey + 같은 canonical order는 duplicate success, 내용이 다르면 conflict다.

### 21.3 Intake 동기화 경계

- COMMITTED 주문과 매핑 결정은 기존 중앙 동기화 대상이다.
- IntakeSession/Document/Line의 운영 필요 메타데이터는 DRAFT 동기화 확장 시 별도 entity contract로 추가한다.
- 1차 Vertical Slice에서는 Intake Draft를 profile-local로 두고 최종 ORDER만 중앙화한다.
- 이미지 binary는 중앙 동기화하지 않는다.
- profile-local Draft임을 화면에 `이 PC에 임시 저장됨`으로 표시한다.

이 경계는 M9 공식 주문 원장과 무관한 대용량 Draft 때문에 중앙 Sheet 원자성·셀 한도 계약을 다시 흔들지 않기 위한 결정이다.

## 22. 오류·복구·롤백

| 오류 | 처리 |
| --- | --- |
| OCR 실패 | 원본 유지, 직접수정 허용 |
| 거래처 미확정 | 확인필요 보고, Draft 유지 |
| 상품 미매칭 | 임시상품 또는 Master 선택을 관리자가 결정 |
| 같은 occurrence·같은 내용 재입력 | 기존 IntakeSession 열기 |
| 같은 occurrence·다른 내용 | 원본 충돌 보고, 새 세션·주문 미생성 |
| 다른 occurrence·같은 내용 | 정상 반복입력으로 새 IntakeSession 생성 |
| 같은 전표키 같은 내용 | 기존 주문 반환 |
| 같은 전표키 다른 내용 | conflict, 주문·이벤트·queue 불변 |
| N전표 일괄저장 중 일부 실패 | 전표별 격리, 성공건 유지, 실패건 Draft 유지 |
| DB upgrade 실패 | v7 transaction abort, v7 데이터 유지 |
| Cloud offline | Intake Draft 편집 가능, 공식 주문 저장은 기존 중앙모드 정책 적용 |
| 주문 저장 응답 유실 | 같은 sourceDocumentKey/idempotency로 재조회 |

원본, 기존 주문, 확정 판매, Movement, 이행을 직접 덮어쓰거나 삭제하지 않는다. 저장 후 수정은 기존 append-only 취소·재처리 경계를 따른다.

## 23. 함수/API 계약

### 23.1 신규 핵심 API

```js
createIntakeSession({ sourceMode, sourceType, sourceId, sourceOccurrenceKey, captureOccurrenceId, parts, actor })
getOrOpenIntakeSessionByOccurrenceKey(sourceOccurrenceKey, rawFingerprint)
findIntakeSessionsByRawFingerprint(rawFingerprint)
extractIntakeSession(intakeSessionId, { parserVersion, actor })
segmentIntakeDocuments(intakeSessionId, { segmentationVersion, actor })
splitIntakeDocument({ intakeDocumentId, intakeLineIds, reasonCode, actor })
mergeIntakeDocuments({ targetDocumentId, sourceDocumentId, reasonCode, actor })
moveIntakeLine({ intakeLineId, targetDocumentId, reasonCode, actor })
confirmIntakeCustomer({ intakeDocumentId, customerId, reasonCode, expectedRevision, actor })
confirmIntakeMatching({ intakeDocumentId, lines, expectedRevision, actor })
buildOrderPayloadFromIntake(intakeDocumentId)
commitIntakeDocument({ intakeDocumentId, expectedRevision, actor })
```

Document Adapter registry의 최소 API는 다음으로 고정한다.

```js
registerIntakeDocumentAdapter(adapter)
getIntakeDocumentAdapter(documentType)
```

등록되지 않은 `documentType`은 `ORDERQ_INTAKE_ADAPTER_NOT_REGISTERED:<type>`으로 Draft 생성 전에 거부한다.

### 23.2 기존 API 변경

`createOrder(payload)`에 다음 계약을 추가한다.

```js
{
  sourceDocumentKey,
  sourceOccurrenceKey,
  sourceMessageKey,
  intakeSessionId,
  intakeDocumentId
}
```

행 payload에는 다음 identity 계약을 추가한다.

```js
items: [{
  productId,
  itemCode,
  itemName,
  matchStatus,
  reviewStatus,
  productIdentityStatus
}]
```

- ORDER_IN 입력은 `sourceDocumentKey` 필수
- 기존 DIRECT/legacy 입력은 선택
- 중복은 sourceDocumentKey 우선
- 주문·행·이벤트·SyncQueue는 기존 한 transaction 계약 유지
- `reviewStatus=CONFIRMED`, `productIdentityStatus=TEMPORARY_CONFIRMED`는 `orderItems`와 Cloud payload에 보존
- core `matchStatus`와 기존 주문 단위 `matchingStatus` 계산은 변경하지 않음

### 23.3 공통 주문 편집기

`input.html`의 Grid 상태·DOM 로직을 재사용 가능한 모듈로 추출한다.

```js
createOrderDraftEditor({
  root,
  mode: 'DIRECT' | 'ORDER_IN',
  initialDraft,
  onChange,
  masterSearch
})
```

`input.html`과 `parser.html`이 같은 모듈을 사용한다. iframe, HTML 복제, 별도 SmartParser Grid는 금지한다.

## 24. 정확한 수정파일 목록

### 24.1 신규 파일

- `orderq/orderq-v8-contracts.js`
- `orderq/intake-repository.js`
- `orderq/intake-engine.js`
- `orderq/intake-segmentation.js`
- `orderq/intake-document-adapter.js`
- `orderq/order-draft-editor.js`
- `orderq/intake-workbench.js`
- `scripts/test-orderq-intake-architecture.mjs`
- `scripts/test-orderq-intake-browser.html`

### 24.2 수정 파일

- `orderq/orderq-db.js`
- `orderq/orderq-v7-repository.js` — 이름은 유지하되 v8 backup 호환 또는 후속 rename
- `orderq/order-document-model.js`
- `orderq/order-intake-engine.js`
- `orderq/orderq-sync-engine.js`
- `orderq-cloud.gs`
- `orderq/smartparser/source-parser.js`
- `orderq/smartparser/parser-orchestrator.js`
- `orderq/smartparser/customer-resolver.js`
- `orderq/smartparser/candidate-generator.js`
- `orderq/smartparser/parser-repository.js`
- `orderq/parser-ui.js`
- `orderq/parser.html`
- `orderq/parser.css`
- `orderq/input.html`
- `orderq/product-line-common.js`
- `orderq/photo-ocr.js`
- `orderq/README.md`
- `orderq/ARCHITECTURE.md`
- `orderq/ROADMAP.md`
- `app-manifest.json`
- `.github/workflows/repository-validation.yml`
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-orderq-order-workflow.mjs`
- `scripts/test-orderq-vnext-cloud-contract.mjs`
- `scripts/test-orderq-manual-master-search.mjs`

### 24.3 1차 구현에서 수정 금지

- `orderq/collector-ui.js`
- `orderq/collector-smartparser-review.js`
- `orderq/history-collector/*`
- `orderq/dispatch-*`
- `orderq/purchase-*`
- `orderq/inventory-*`
- 구 `orderops/*`
- DataOps, MerchOps, Master 업무 소스

Collector 정리는 새 ORDER IN 실사용 검증 후 별도 단계에서 수행한다.

## 25. 테스트 시나리오

### 25.1 필수 계약

1. 카카오 원문 1건 → 주문 1건
2. 카카오 원문 1건 → 서로 다른 거래처 주문 N건
3. 발신자와 실제 거래처가 다른 경우
4. 같은 메시지에서 생성된 N전표의 독립 sourceDocumentKey
5. PC A/B가 같은 source occurrence와 자동분리 결과에서 같은 sourceDocumentKey 생성
6. PC A/B가 같은 원문행을 수동 분할·병합하면 같은 child/merge key 생성
7. 같은 occurrence·같은 내용 재입력 시 새 세션·주문 중복 없음
8. 같은 occurrence·다른 내용은 source occurrence conflict
9. 다른 날짜 occurrence의 동일 텍스트는 새 IntakeSession·주문 생성
10. 같은 sourceDocumentKey 같은 내용 재시도는 기존 주문 반환
11. 같은 sourceDocumentKey 다른 내용은 전체 conflict
12. 전표 분할·병합·행이동·거래처변경 이력
13. 추출 수정 후 영향 행만 매칭 재검증
14. Header·가격·메모 수정은 상품매칭 유지
15. 매칭 완료 시 Mapping Dictionary 자동 갱신
16. 과거 빈도보다 최신 관리자 확정 우선
17. 임시상품은 코드·productId 없음, 품명 원값과 `reviewStatus/productIdentityStatus` 보존
18. 임시상품은 사용자 화면에서 미매칭 실패가 아니라 `임시상품 확인완료`로 표시
19. 기존 core MATCH_STATUS·matchingStatus·건수 계산 회귀 없음
20. 임시상품의 출고 제안은 기존 PRODUCT_REVIEW이며 실제상품 선택 전 자동확정 없음
21. 코드 선택은 실제 Master productId 연결
22. 숫자 0, 문자열 `0`, 공란 보존
23. 단가 0 경고 후 관리자 확정 시 0 보존
24. 텍스트+이미지 혼합 붙여넣기
25. OCR 오독 직접수정, 원이미지 불변
26. 다전표에서 확인필요 전표 우선
27. Master 코드가 있는 ERP·쇼핑몰은 Parser 우회
28. 외부코드 미매핑은 ORDER IN으로 라우팅
29. v7→v8 upgrade 후 기존 주문·이벤트·revision 불변
30. v7 backup의 v8 복원
31. v8 전체 Store·이미지 base64 backup round-trip
32. Cloud sourceDocumentKey 중복과 legacy fallback
33. 서로 다른 PC에서 같은 source occurrence 전표 재시도 시 한 주문만 생성
34. runtime에 미등록된 QUOTE/PURCHASE/SALE Adapter 호출 차단

### 25.2 회귀

- 기존 수기 주문과 Master 검색
- 기존 SmartParser 단일 메시지
- Collector 수집·중복·롤백·사진 검수
- ORDER Q M1~M10 전 계약
- 중앙 prepare/commit/lease/idempotency/복구
- client safety
- repository validation
- DataOps 기존 계약

### 25.3 실제 브라우저 증거

- 실제 Chromium IndexedDB v7 데이터로 v8 upgrade
- 기존 수기입력 화면과 ORDER IN 화면의 동일 Grid 결과
- 독립 BrowserContext A/B 중복·수렴
- paste text+image
- split/merge/move 후 주문 N건
- console warning/error 0

## 26. 단계별 구현계획과 승인 게이트

본 문서는 개발명세 확정안이며 구현 승인을 의미하지 않는다. 문서 최종 승인 후 사용자의 별도 구현 착수 지시를 받아 단계 1을 시작한다. 이후 단계 전환은 직전 단계의 완료증거와 사용자 진행 지시를 기준으로 한다.

### 단계 1 — 계약과 DB v8

- v8 Store·index·legacy backfill
- rawFingerprint evidence와 sourceOccurrenceKey 중복계약 분리
- sourceDocumentKey client/cloud 계약
- reviewStatus/productIdentityStatus 추가와 기존 MATCH_STATUS 무변경
- v7 backup/restore 호환
- UI 변경 없음

완료조건: 기존 주문 불변, 동일내용 반복 occurrence, 1원문→N 주문, 임시상품 core 상태 회귀가 Node/Chromium/Cloud에서 PASS.

### 단계 2 — 실제 주문 Grid 공통화

- `input.html` Grid를 `order-draft-editor.js`로 추출
- 수기입력 동작·0/공란·Master 검색 완전 동일
- Parser에는 아직 연결하지 않음

완료조건: 기존 수기주문 회귀와 구조화 JSON 동일.

### 단계 3 — 단일전표 Vertical Slice

- 통합 IntakeSession
- 추출 확인→매칭 확인→주문 완성
- 기존 createOrder로 저장

완료조건: 실제 사용자 한 화면에서 텍스트 주문 1건 완료.

### 단계 4 — 다전표

- 자동 segmentation
- 분할·병합·행이동·거래처변경
- 문제 전표 우선 Navigator

완료조건: 1원문→N 거래처 주문과 독립 중복방지.

### 단계 5 — 사진·텍스트 통합

- 공통 Clipboard
- 이미지 원본·OCR 결과 분리
- 혼합 입력과 직접수정

완료조건: 특정 패널 표시 없이 paste, 원본 불변.

### 단계 6 — 매핑 정책

- 최신 관리자 확정 우선
- 단계 완료 자동 feedback
- 행별 checkbox 제거

완료조건: 최신 수정이 과거 빈도보다 우선하고 before/after 이력 보존.

### 단계 7 — 구조화 Import

- 코드확정 자료 Parser 우회
- 외부코드 미매핑 라우팅

완료조건: 정상·중복·코드오류·거래처오류·제외 전표별 결과.

### 단계 8 — Collector 정리

- 새 ORDER IN과 중복되는 일상 UI 제거 여부를 실사용 결과로 결정
- Historical/Bootstrap 계약은 유지

완료조건: Collector 수집·롤백·기초재고 회귀.

각 단계는 별도 branch/worktree/PR로 수행한다. 단계 1의 DB·Cloud 계약과 단계 2의 Grid 공통화를 한 PR에 섞지 않는다.

## 27. 제외범위

- M1~M10 원장·출고·재고·구매·ERP 재설계
- 실제 확정자료 직접 수정·삭제
- Collector를 운영 주문입력기로 변경
- 구 `orderops` 수정
- DataOps·MerchOps·Master 기능 변경
- 모든 필기체·사진 형식 100% 자동인식 보장
- 이미지 binary의 Google Sheet 저장
- 거대한 ORDER/QUOTE/PURCHASE/SALE 범용 프레임워크
- 구매 Workbench를 ORDER IN 화면에 합치기
- 실제 작업자 권한관리 완성
- ERP 자동 POSTED

이번 구현에서 `Common Intake Shell + IntakeDocumentAdapter` 경계와 ORDER Adapter까지만 만든다. ORDER UX가 실사용으로 검증된 뒤에만 QUOTE, PURCHASE, SALE Adapter를 각각 별도 승인·개발한다.

## 28. 최종 완료 기준

다음이 모두 충족되어야 입력 아키텍처 전환이 완료된다.

1. 한 원문에서 N개 거래처 주문을 만들 수 있다.
2. 발신자와 실제 거래처가 분리된다.
3. 원문·추출·추천·관리자 확정값이 서로 덮어쓰지 않는다.
4. ORDER IN과 수기입력이 동일한 실제 주문 Grid를 사용한다.
5. 전표별 `sourceDocumentKey`가 로컬·Cloud 중복방지를 일치시킨다.
6. 기존 v7 주문과 M1~M10 업무사실이 변하지 않는다.
7. Collector는 Bootstrap 역할을 유지한다.
8. 일반 사용자는 내부 상태명 없이 `추출 확인→매칭 확인→주문 완성` 흐름으로 작업하며, 완료 후에는 `추출 수정 / 매칭 수정`으로 되돌아간다.
9. 0·공란·음수·임시상품 원값을 보존한다.
10. 전체 백업·복원, 중앙 재시도, A/B 수렴이 통과한다.

이 명세의 최상위 기준은 다음 세 문장이다.

> ORDER IN은 외부정보를 해석하여 Master 상품 또는 관리자 확정 임시상품으로 상품 식별이 결정된 전표를 만든다.

> ORDER Q는 상품 식별이 결정된 전표를 실제 주문·재고·출고·구매·판매·ERP 업무로 운영한다.

> 기초데이터는 ORDER IN의 초기 인식률을 만들고, 실제 사용자의 확인·수정은 ORDER IN을 계속 고도화한다.
