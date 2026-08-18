# ORDER IN Stage 1 — Intake DB·Identity 계약 개발명세

기준 SHA: `c236ca4708a3f76f5a7d14d92db7d5f87c1bb368`

상위 명세: [ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md)

로드맵: [ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

ORDER IN의 원문 발생, 세션, 전표, 행, 변경이력을 IndexedDB v8에 안전하게 저장하고, 최종 ORDER Q 주문까지 출처를 잃지 않는 최소 기반을 만든다. 이 단계는 화면이나 파서 기능을 만들지 않는다.

완료 시 보장할 것:

- 같은 내용이 다른 시각·다른 실제 주문으로 들어오면 별도 occurrence와 주문이 된다.
- 같은 occurrence의 재시도는 같은 session/document/order로 수렴한다.
- 자동 분리키는 PC와 재시도에 무관하게 결정적이다.
- 관리자 확정 임시상품은 Master 미연결과 검토 완료를 별도 필드로 보존한다.
- v7 백업 복원, Cloud ORDER, M1~M10 공식명령 계약은 회귀하지 않는다.

## B. 선행조건

1. 기준 SHA와 상위 명세가 변경되지 않았는지 확인한다.
2. `orderq/orderq-db.js`, `orderq/orderq-v7-contracts.js`, `orderq/orderq-v7-repository.js`의 v7 계약을 다시 읽는다.
3. `orderq/order-intake-engine.js`, `orderq/order-document-model.js`, `orderq/orderq-sync-engine.js`, `orderq/orderq-cloud-adapter.js`, `orderq-cloud.gs`의 현행 ORDER 저장·동기화 계약을 고정한다.
4. 구현 전 `scripts/test-orderq*.mjs`, client safety, repository validation 기준선을 기록한다.

## C. 허용범위

- DB v7→v8 additive migration
- Intake 5개 Store와 index 추가
- identity canonicalization 및 SHA-256 함수
- Intake repository의 생성·조회·수정·event append API
- 최종 ORDER/ORDER_ITEM에 provenance와 상품 검토 필드 추가
- backup/export/validate/restore가 신규 Store를 포함하도록 확장
- 최종 주문 Cloud payload의 신규 선택 필드 보존
- Stage 1 Node·실제 Chromium 계약 테스트

## D. 금지범위

- Parser UI, 공통 Grid, 전표 분할·병합 UI
- OCR, Clipboard, 사진 저장 화면
- 상품매핑 우선순위·학습 변경
- 구조화 Import, Collector 정리
- core `MATCH_STATUS` 열거형 변경
- M9 중앙 공식명령, ledgerSequence, reservation, Sales/Purchase/Movement 계약 변경
- 운영 배포·DB 강제 초기화·기존 데이터 재작성

## E. 실제 소스 분석

- `orderq/orderq-v7-contracts.js`: `ORDERQ_DB_VERSION = 7`, v7 Store·동기화 entity 계약의 기준이다.
- `orderq/orderq-db.js`: `DB_VERSION`, `STORE`, `upgradeOrderQDbSchema()`를 소유한다. 현재 `rawInputs.byFingerprint`, `parseResults.bySourceMessageKey`, `orders.bySourceMessageKey`가 unique라서 내용 Hash와 occurrence를 분리하지 못한다.
- `orderq/orderq-v7-repository.js`: `STORE_NAMES = Object.values(STORE)`, `runOrderQTransaction()`, `exportOrderQBackup()`, `validateOrderQBackup()`, `restoreOrderQBackup()`을 소유한다.
- `orderq/order-intake-engine.js`: `MATCH_STATUS`는 `MATCHED/MATCH_FAILED/EXCLUDED/CANCELLED`이며 `createOrder()`가 ORDER·ITEM·EVENT·syncQueue를 한 transaction에 저장한다.
- `orderq/order-document-model.js`: 입력채널·주문 snapshot 정규화를 소유한다.
- `orderq/orderq-sync-engine.js`: 주문 push/pull 및 원격 bundle 적용을 담당한다.
- `orderq-cloud.gs`: `orderQFindOrderBundleBySourceMessageKey()`, `orderQApplyOrder()`가 legacy ORDER 중복·저장을 담당한다. M9 중앙 함수와 분리해 수정해야 한다.
- `orderq/dispatch-workbench.js`: actual product가 없으면 `PRODUCT_REVIEW`를 생성하므로 임시상품을 새 core match 상태로 만들 필요가 없다.

## F. Before → After

| 항목 | Before | After |
|---|---|---|
| 원문 동일성 | `rawFingerprint`가 사실상 중복키 | 내용 증거일 뿐 unique 아님 |
| 실제 입력 발생 | 별도 key 없음 | `sourceOccurrenceKey` |
| 전표 중복 | `sourceMessageKey` 중심 | 결정형 `sourceDocumentKey` |
| Intake 초안 | parser store에 일부 저장 | 전용 session/source/document/line/event Store |
| 임시상품 | 미매칭과 구분 불충분 | `reviewStatus`와 `productIdentityStatus` 분리 |
| 출처 추적 | sourceMessageKey 일부 | session/document/line provenance 보존 |
| 백업 | v7 Store | v8 전체 Store round-trip |

## G. 데이터 계약

### G.1 신규 Store

| Store | keyPath | 필수 index | 역할 |
|---|---|---|---|
| `intakeSessions` | `intakeSessionId` | `bySourceOccurrenceKey` unique, `byRawFingerprint` non-unique, `byStageUpdatedAt` | 한 번의 실제 입력 발생 |
| `intakeSourceParts` | `sourcePartId` | `bySession`, `bySourceMessageKey`, `byContentHash` | 텍스트·파일·이미지 source part |
| `intakeDocuments` | `intakeDocumentId` | `bySession`, `bySourceDocumentKey` unique, `byReviewStatus`, `byOrderId` | 전표 초안 |
| `intakeLines` | `intakeLineId` | `byDocument`, `bySourcePart`, `byMatchStatus`, `byReviewStatus`, `byProductIdentityStatus` | 전표 행 초안 |
| `intakeEvents` | `eventId` | `bySession`, `byDocument`, `byLine`, `byOccurredAt` | append-only 변경이력 |

### G.2 공통 상태

- session status: `ACTIVE | COMMITTED | EXCLUDED`
- 업무 stage: `CAPTURED | EXTRACTION_REVIEW | MATCH_REVIEW | DOCUMENT_REVIEW | COMMITTED`
- 보조 상태: `NEEDS_REVIEW | EXCLUDED | MERGED`
- line review: `PENDING | CONFIRMED | EXCLUDED`
- product identity: `MASTER_LINKED | TEMPORARY_CONFIRMED | UNRESOLVED`

상위 단계로 갈 수 있는 조건은 모든 유효 line이 `reviewStatus=CONFIRMED`이고 `productIdentityStatus`가 `MASTER_LINKED` 또는 `TEMPORARY_CONFIRMED`인 경우뿐이다.

### G.3 Identity

- `rawFingerprint`: 원문 canonical bytes의 SHA-256. non-unique, 수정 불가, 내용 동일성 증거다.
- `sourceOccurrenceKey`: 실제 외부 입력 발생 1건의 identity다. **플랫폼·외부시스템이 안정적인 native occurrence ID를 제공하면 그 ID를 최우선으로 사용하고 timestamp를 key 재료에 섞지 않는다.**
  - native ID 있음: `SHA-256(sourceSystem + sourceContainerId + sourceNativeId)`.
  - native ID 없음: `SHA-256(sourceSystem + sourceContainerId + senderEvidence + normalizedOccurredAt + occurrenceOrdinal)`.
  - 일반 붙여넣기·사진처럼 외부 native ID가 없는 수동 입력: 사용자가 `[새 입력]`을 시작할 때 한 번 발급한 `captureOccurrenceId`를 native occurrence evidence로 사용한다.
  - native ID가 같은데 표시 timestamp·timezone 표현만 달라진 경우에도 같은 `sourceOccurrenceKey`여야 한다. `occurredAtEvidence`는 provenance로 보존하되 native ID가 있을 때 identity 재료로 사용하지 않는다.
  - native ID가 없는 자동수집 채널은 sender/time/ordinal 정규화 계약이 확정되지 않으면 자동 생성하지 않고 Q의 중단조건을 적용한다.
- `sourceDocumentKey`: `sourceOccurrenceKey + documentType + stableSegmentIdentity`의 SHA-256. random nonce를 사용하지 않는다.
- 자동분리 `stableSegmentIdentity`: parser가 원문 offset·segment signature로 재현한다.
- 수동분할 child key: parent key + immutable split boundary identity.
- 병합 key: 정렬된 source document key 집합.
- `sourceLineKey`: document key + stable source range 또는 구조화 외부 line ID.

같은 `rawFingerprint`라도 `sourceOccurrenceKey`가 다르면 새 session이다. 같은 occurrence인데 content hash가 다르면 덮어쓰지 않고 `ORDERQ_INTAKE_OCCURRENCE_CONTENT_CONFLICT`로 거부한다.

### G.4 상품 검토 필드

ORDER ITEM과 Intake Line에 다음 선택 필드를 추가한다.

| 필드 | 임시상품 | Master 상품 |
|---|---|---|
| `reviewStatus` | `CONFIRMED` | `CONFIRMED` |
| `productIdentityStatus` | `TEMPORARY_CONFIRMED` | `MASTER_LINKED` |
| `productId` | `null` | Master ID |
| `itemCode` | `''` | Master code |
| `itemName` | 관리자 확정명 | Master name |
| legacy `matchStatus` | 기존 소비자 호환값 유지 | 기존 `MATCHED` |

legacy `matchStatus`는 사용자 경고의 단독 근거로 사용하지 않는다.

### G.5 provenance

최종 ORDER에 `intakeSessionId`, `intakeDocumentId`, `sourceOccurrenceKey`, `sourceDocumentKey`, `rawFingerprint`, `intakeContractVersion`을 선택 필드로 보존한다. ORDER ITEM에는 `intakeLineId`, `sourceLineKey`, review/product identity를 보존한다. 값은 생성 후 수정하지 않는다.

### G.6 `sourceDocumentKey` 재시도용 canonical 주문내용

같은 `sourceDocumentKey`의 재시도는 **생성된 시스템 메타데이터가 아니라 동일한 업무사실인지**를 비교한다. Client와 Cloud는 동일한 `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` projection을 사용한다.

비교에 포함하는 값:

- Header: `orderDate`, 확정 `customerId`(없을 때만 normalized customer identity), 확정 `warehouseId` 또는 안정 warehouse code, `transactionType`, `deliveryExpectedDate`, `orderMessage`, 외부전표 identity, 사용자가 명시한 담당자·초기 주문/관리자 상태 등 주문 업무사실.
- Item: `sourceLineKey` 기준으로 안정 정렬한 뒤 `productId`, `itemCode`, `itemName`, `specification`, raw/final quantity·unit, `price`, `priceType`, `supplyAmount`, `vatAmount`, `memo`, `description`, `noticePrice`, `reviewStatus`, `productIdentityStatus`, 기존 정규화된 `matchStatus` 등 주문행 업무사실.
- 숫자는 기존 ORDER 숫자 정규화 규칙을 사용하며 `0`, 문자열 `0`, 공란/null의 기존 저장 의미를 임의로 합치지 않는다.

비교에서 반드시 제외하는 값:

- `orderId`, `orderNo`, `orderItemId`, `eventId`, `queueId` 같은 시스템 생성 ID.
- `intakeSessionId`, `intakeDocumentId`, 로컬 UUID처럼 PC마다 달라질 수 있는 Draft identity.
- `revision`, `baseRevision`, `createdAt`, `updatedAt`, actor 처리시각, sync 상태·재시도 횟수.
- `matchingStatus`, `matchedCount`, `matchFailedCount`, 합계금액, `opsStatus` 등 위 업무값으로부터 다시 계산 가능한 파생값.
- 고객명·창고명 같은 표시 snapshot은 안정 ID가 존재하면 비교 기준으로 사용하지 않는다.

같은 `sourceDocumentKey` + 같은 canonical projection이면 duplicate success이며 ORDER·ITEM·EVENT·syncQueue를 추가하지 않는다. 같은 key + 다른 canonical projection이면 `ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT`로 전체 거부한다. 비교 함수/정규화 버전은 Client와 Cloud가 동일해야 하고 fixture hash로 고정한다.

## H. 함수·API 상세

신규 `orderq/intake-identity.js`:

- `canonicalizeIntakeSource(input): Uint8Array`
- `computeRawFingerprint(input): Promise<string>`
- `buildSourceOccurrenceKey(evidence): Promise<string>` — native ID 우선 규칙과 fallback 규칙을 G.3 그대로 적용한다.
- `buildAutomaticSourceDocumentKey({sourceOccurrenceKey, documentType, stableSegmentIdentity})`
- `buildSplitSourceDocumentKey({parentSourceDocumentKey, immutableBoundary})`
- `buildMergeSourceDocumentKey(sourceDocumentKeys)`
- `buildSourceLineKey({sourceDocumentKey, externalLineId, sourceRange})`
- `buildOrderSourceDocumentCanonicalProjection({order, items})` — G.6의 업무필드만 deterministic object로 만든다.
- `computeOrderSourceDocumentCanonicalHash({order, items})` — `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` projection의 canonical SHA-256을 계산한다.

신규 `orderq/intake-repository.js`:

- `createOrOpenIntakeSession(command)` — occurrence unique 검사 후 생성 또는 동일 session 반환
- `appendIntakeSourcePart(command)` — source part와 event를 한 transaction에 기록
- `createIntakeDocument(command)` — sourceDocumentKey conflict 검증
- `replaceIntakeLines(command)` — expected revision CAS, document lines 일괄 교체, event append
- `updateIntakeLine(command)` — 허용 필드만 patch, revision 증가
- `appendIntakeEvent(event)` — 외부 임의 system evidence를 제거하고 repository 생성값 사용
- `getIntakeSessionBundle(intakeSessionId)`
- `findIntakeDocumentBySourceDocumentKey(sourceDocumentKey)`

기존 변경:

- `upgradeOrderQDbSchema(db, transaction, oldVersion)`는 `oldVersion < 8`에서만 신규 Store/index를 생성한다.
- v8 upgrade는 `orders.bySourceMessageKey`만 삭제 후 같은 keyPath의 non-unique index로 재생성하고 `orders.bySourceDocumentKey` unique index를 추가한다. 다른 legacy index는 변경하지 않는다.
- 같은 upgrade transaction에서 sourceDocumentKey가 없는 legacy 주문에 `LEGACY:<sourceMessageKey>`만 backfill한다. orderId/sourceMessageKey/revision/event는 변경하지 않으며 충돌 시 upgrade 전체를 abort한다.
- `createOrder(payload)`는 provenance와 review/product identity를 allowlist 정규화하고, 같은 `sourceDocumentKey`가 있으면 G.6 canonical projection/hash를 비교한다. 동일하면 기존 주문 bundle을 duplicate success로 반환하고 ORDER·ITEM·EVENT·syncQueue를 추가하지 않으며, 다르면 conflict를 반환한다.
- Cloud ORDER 조회도 같은 `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` 비교 규칙을 사용하고 신규 `sourceDocumentKey` 우선, 없으면 legacy `sourceMessageKey` fallback을 사용한다.
- `exportOrderQBackup/validateOrderQBackup/restoreOrderQBackup`은 schema v8과 신규 Store를 포함하고 실패 시 전체 rollback한다.

## I. 파일별 변경명세

신규:

- `orderq/orderq-v8-contracts.js`
- `orderq/intake-identity.js`
- `orderq/intake-repository.js`
- `scripts/test-orderq-stage1-intake-db.mjs`
- `scripts/test-orderq-stage1-browser.html`

수정:

- `orderq/orderq-db.js` — v8 Store/index upgrade
- `orderq/orderq-v7-repository.js` — v8 전체 Store backup/restore
- `orderq/order-document-model.js` — provenance·review 필드 정규화
- `orderq/order-intake-engine.js` — sourceDocumentKey 멱등·충돌 계약
- `orderq/orderq-sync-engine.js` — 신규 ORDER 선택 필드 보존
- `orderq/orderq-cloud-adapter.js` — ORDER payload 보존
- `orderq-cloud.gs` — legacy ORDER apply/find의 신규 key fallback
- `.github/workflows/repository-validation.yml` — Stage 1 계약 단계 추가

## J. UI 계약

사용자 화면 변경 없음. DB upgrade 실패 시 기존 공통 오류표시만 사용하고 v7 데이터를 삭제하거나 자동 초기화하지 않는다. Stage 1 browser fixture는 개발 증거용이며 운영 navigation에 연결하지 않는다.

## K. 상태전이

Stage 1 테스트 API가 허용하는 최소 전이는 `CAPTURED → EXTRACTION_REVIEW → MATCH_REVIEW → DOCUMENT_REVIEW → COMMITTED`다. 각 전이는 expected revision이 일치해야 하며 event가 append된다. 이전 단계 수정 시 상위 확인을 무효화하고 event를 남긴다. Stage 1에는 실제 UI나 자동 parser 전이를 구현하지 않는다.

## L. 오류·충돌·롤백

- occurrence key 동일/content hash 다름: `ORDERQ_INTAKE_OCCURRENCE_CONTENT_CONFLICT`
- sourceDocumentKey 동일/G.6 canonical 주문내용 다름: `ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT`
- expected revision 불일치: `ORDERQ_INTAKE_REVISION_CONFLICT`
- temp confirmed인데 itemName 공란: `ORDERQ_INTAKE_TEMPORARY_NAME_REQUIRED`
- unresolved line을 READY로 전환: `ORDERQ_INTAKE_REVIEW_INCOMPLETE`
- DB upgrade/restore 실패: transaction 전체 abort, 기존 v7 canonical digest 불변
- Cloud duplicate state 훼손: 성공으로 숨기지 않고 conflict

## M. Given / When / Then 계약 테스트

1. Given 동일 텍스트와 서로 다른 paste occurrence, When session 생성, Then session/order key가 다르고 둘 다 저장된다.
2. Given 동일 native message ID와 동일 content지만 PC A/B의 표시 timestamp·timezone 표현이 다름, When occurrence key 생성, Then 같은 `sourceOccurrenceKey`로 수렴한다.
3. Given native ID가 없는 동일 container에서 sender/time/ordinal이 같은 실제 occurrence, When A/B가 key 생성, Then 같은 `sourceOccurrenceKey`로 수렴한다.
4. Given 동일 occurrence·동일 content, When A/B가 같은 자동 segment를 생성, Then sourceDocumentKey가 같고 두 번째는 duplicate다.
5. Given 동일 occurrence·다른 content, When 재사용, Then conflict이며 Store 전체 digest 불변이다.
6. Given 수동 split/merge input 순서가 다름, When key 생성, Then 같은 논리 결과는 같은 key다.
7. Given 코드 없는 품명, When 관리자가 임시상품 확정, Then review=CONFIRMED/productIdentity=TEMPORARY_CONFIRMED이며 사용자 미해결로 분류되지 않는다.
8. Given unresolved line, When READY 요청, Then 거부되고 event/revision 불변이다.
9. Given v7 실제 backup, When v8 upgrade/export/restore, Then 기존 모든 Store와 신규 empty Store canonical round-trip이 일치한다.
10. Given legacy orders.bySourceMessageKey unique DB, When upgrade, Then index는 non-unique, sourceDocumentKey는 `LEGACY:*`, 기존 order/event canonical 필드는 불변이다.
11. Given 동일 sourceDocumentKey의 final ORDER 재시도, When 업무내용은 같지만 새 `orderId/orderNo/orderItemId/createdAt/intakeSessionId`가 달라질 수 있는 A/B 입력, Then G.6 canonical hash는 같고 기존 주문을 duplicate success로 반환하며 ORDER·ITEM·EVENT·syncQueue가 증가하지 않는다.
12. Given 동일 sourceDocumentKey의 final ORDER 재시도, When 고객·창고·수량·상품·가격 등 G.6 업무사실 하나가 다름, Then canonical hash가 달라 conflict이며 ORDER·ITEM·EVENT·syncQueue가 증가하지 않는다.
13. Given Cloud pull, When 신규 필드가 있는 ORDER를 A/B 적용, Then provenance와 temp identity가 동일하다.
14. Given 실패주입, When Intake document+lines+event 저장 중 오류, Then 세 Store 모두 부분행 0이다.

각 테스트는 DB row count, canonical digest, canonical order hash, event type, syncQueue 상태, duplicate/conflict 결과를 구조화 JSON으로 출력한다.

## N. 회귀 테스트

필수:

- `node scripts/test-orderq-stage1-intake-db.mjs`
- `node scripts/test-orderq-vnext-cloud-contract.mjs`
- `node scripts/test-orderq-order-workflow.mjs`
- `node scripts/test-orderq-manual-master-search.mjs`
- `node scripts/test-orderq-smartparser.mjs`
- `node scripts/test-orderq-cloud-atomicity.mjs`
- `node scripts/test-client-safety.mjs`
- `node scripts/validate-repository.mjs`
- `git diff --check`

실제 Chromium에서 v7→v8 upgrade, 전체 Store backup/restore, temp identity A/B pull을 실행한다.

## O. 완료증거

- base/HEAD/tree/merge-base, clean worktree, 변경파일·통계
- v8 Store/index 목록과 upgrade 전후 canonical digest
- identity 입력·출력 fixture SHA-256
- `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` fixture와 Client/Cloud canonical hash 일치 증거
- 모든 Given/When/Then 구조화 결과
- 실제 Chromium DB명 2개, row count, console warning/error 0
- Cloud 신규 필드 수렴 및 legacy fallback
- 전체 회귀/CI와 기준선 실패 분리
- 금지범위 변경 0 확인

## P. 다음 Stage Gate

Stage 2는 다음이 모두 충족될 때만 착수한다.

- Stage 1 HEAD 독립 검증 승인 및 병합
- DB v8 backup/restore와 v7 데이터 불변
- raw fingerprint 반복주문, source occurrence 재시도, sourceDocument conflict 계약 통과
- native ID 우선 occurrence key와 fallback key의 A/B 결정성 통과
- Client/Cloud `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` 동일 fixture hash 통과
- core MATCH_STATUS 무변경
- M1~M10/Cloud 증가 실패 0

## Q. 결정사항·중단조건

확정:

- Intake Draft는 1차 로컬 전용이다.
- final ORDER만 현행 Cloud 계약으로 동기화한다.
- `rawFingerprint`는 unique key가 아니다.
- native occurrence ID가 있으면 timestamp는 `sourceOccurrenceKey` 재료로 사용하지 않는다.
- 같은 `sourceDocumentKey`의 duplicate/conflict 판단은 G.6 `ORDER_SOURCE_DOCUMENT_CANONICAL_V1` 업무 projection으로만 한다.
- temporary confirmed는 review와 Master identity를 분리한다.

중단:

- 기존 v7 data를 삭제해야만 upgrade 가능한 경우
- M9 중앙 entity/official command 변경이 필요한 경우
- source occurrence를 결정적으로 만들 원본 native evidence가 없는 자동수집 채널이 발견되면 해당 채널 계약을 먼저 명시한다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 1 INTAKE DB CONTRACT] 최신 origin/main을 fetch하고 기준 SHA를 고정하라. orderq/ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md, orderq/ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md, orderq/ORDER_IN_STAGE1_INTAKE_DB_CONTRACT_SPEC.md를 전부 읽고 Stage 1만 구현한다. DB v8 additive migration, Intake 5 Store, native ID 우선 sourceOccurrenceKey/fallback identity, deterministic sourceDocumentKey, ORDER_SOURCE_DOCUMENT_CANONICAL_V1 기반 duplicate/conflict, final ORDER provenance·review/productIdentity, 전체 Store backup/restore, legacy Cloud fallback과 지정 테스트만 허용한다. Parser UI·Grid·분할·OCR·Mapping·Import·Collector·M9 공식명령은 금지한다. 완료후보 전 병합·배포·Stage 2 착수를 하지 말고 HEAD/diff/구조화 DB·Chromium·Cloud·회귀 증거로 검증을 요청하라.
```
