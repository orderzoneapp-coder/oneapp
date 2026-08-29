# NEXUS 상품·거래처 기준정보 계약 v1

- 작업 ID: `NEXUS-REFDATA-CONTRACT-20260830-01`
- 착수 원격 `main`: `6a69056090a43356807a3adae8ce5728a5edb3e6`
- 확인 문서: `AGENTS.md` v2.3.3, `APP_ARCHITECTURE.md` v2.1.8, `roles/DEVELOPER.md`, `app-manifest.json` v1.3.0
- 구현 범위: owner 정렬, 읽기 Snapshot, 공통 변경요청 validator, owner별 멱등 inbox, 읽기 전용 진단
- 제외: SmartInput·ORDER Q 소비자 전환, 기존 writer 제거, 서버·Apps Script 변경, 원본 DB·키 이동

## current와 target

| 구분 | 착수 시 current | 이 계약의 target |
|---|---|---|
| 상품 공식 화면 | `master-lookup` / `Master.html` | 유지 |
| 상품 manifest owner | `merchops` | `master-lookup` |
| 상품 물리 Repository | `MerchOpsDB/master_products`, `store.merchMaster_v870`, `store.merchMaster_revision_v870`, 호환 localStorage·Cloud | 이동·삭제·초기화 없이 유지 |
| 상품 Read Adapter | 없음 | `ONEAPP_PRODUCT_MASTER_READ_ADAPTER` |
| 거래처 owner/Repository | `customer-master` / `oneapp-customermaster-v1` | 유지 |
| 거래처 Read Adapter | `ONEAPP_CUSTOMER_MASTER_READ_ADAPTER`; 상태와 깊은 불변성 없음 | 기존 API 유지 + `READY|EMPTY|ERROR` 상태 경계와 깊은 불변성 |
| 변경요청 | 공통 schema·owner inbox 없음 | `ONEAPP_REFERENCE_CHANGE_REQUEST_V1` + 두 owner의 멱등 수신·조회 |

착수 시 아키텍처 문서에는 DataOps의 승인된 일부 상품 writer 역할이 기록돼 있으나 기준 SHA의 `DataOps.html`에서는 직접 master commit 경로가 검출되지 않았다. 이 차이는 target 구현으로 보정하지 않으며 후속 writer 전환 조사 대상으로 남긴다.

PR #353과 #356은 모두 오래된 ORDER Q/SmartInput 변경이며 최신 main과 `CONFLICTING` 상태다. 두 PR은 owner·Adapter 핵심 파일을 수정하지 않지만 중앙 CI workflow의 인접 구간을 수정한다. 해당 코드는 복사·병합하지 않았고 이번 작업은 최신 main만 기준으로 한다.

## 공개 읽기 API

### Product

```js
import { productMasterReadAdapter } from './reference-data/product-master-read-adapter.js';

const result = await productMasterReadAdapter.getSnapshotResult();
if (result.status === 'READY') {
  const snapshot = result.snapshot;
  const matches = productMasterReadAdapter.search(snapshot, '상품코드');
}
```

- Global: `ONEAPP_PRODUCT_MASTER_READ_ADAPTER`
- Adapter version: `ONEAPP_PRODUCT_READ_ADAPTER_V1`
- Snapshot schema: `ONEAPP_PRODUCT_SNAPSHOT_V1`
- Owner: `master-lookup`
- source 우선순위: `INDEXEDDB_RECORD_STORE` → `INDEXEDDB_SNAPSHOT_KEY` → `LOCAL_STORAGE_SNAPSHOT_KEY`
- `getSnapshot()`은 `READY` 또는 `EMPTY` Snapshot을 반환하고 읽기 실패 시 reject한다.
- `getSnapshotResult()`는 `{ status: READY|EMPTY|ERROR, snapshot, error }`를 반환한다.
- `search(snapshot, query, options)`는 전달된 Snapshot만 검색한다. DB·localStorage를 다시 읽거나 쓰지 않는다.
- DB 미존재 조회는 `indexedDB.databases()` 또는 versionless safe-open을 사용하고 생성 upgrade를 abort한다.

### Customer

```js
import { customerReadAdapter } from './customer-master/read-adapter.js';

const result = await customerReadAdapter.getSnapshotResult();
const legacySnapshot = await customerReadAdapter.getSnapshot();
const legacySearch = await customerReadAdapter.search('거래처');
```

- Global: `ONEAPP_CUSTOMER_MASTER_READ_ADAPTER`
- 기존 Adapter version과 schema는 각각 `ONEAPP_CUSTOMER_READ_ADAPTER_V1`, `ONEAPP_CUSTOMER_SNAPSHOT_V1`을 유지한다.
- 기존 `getSnapshot()`과 `search()` 의미를 유지한다.
- canonical 고객만 Snapshot에 포함하며 alias·source link는 canonical ID로 연결한다.
- envelope·data·배열·행을 깊게 freeze한다.
- DB 실패는 `getSnapshot()` reject 또는 `getSnapshotResult().status=ERROR`이며 빈 고객 목록으로 바꾸지 않는다.

두 Snapshot의 `contentHash`는 canonical `data`만 SHA-256으로 계산한다. 생성 시각은 hash 대상이 아니므로 같은 revision과 같은 data는 같은 hash와 snapshot ID를 가진다. 소비 앱이 Snapshot을 작업본에 복사한 뒤 owner revision이 변경돼도 그 복사본은 자동 변경되지 않는다.

## 변경요청 계약

```js
import { referenceChangeRequestContract } from './reference-data/change-request-contract.js';

const validation = referenceChangeRequestContract.validate(request);
```

- Schema/global: `ONEAPP_REFERENCE_CHANGE_REQUEST_V1`
- domain-owner: `PRODUCT` → `master-lookup`, `CUSTOMER` → `customer-master`
- operation: `CREATE|UPDATE|STATUS_CHANGE|MAPPING_CHANGE`
- UPDATE·STATUS_CHANGE·MAPPING_CHANGE는 `baseSnapshotId`와 `baseRevision` 필수
- 빈 changes, 중복 field, 민감 key/value, 잘못된 ISO-8601 시각은 `REJECTED`
- 요청은 JSON-compatible payload로 보존하며 비밀번호·token·credential·인증서 원본·private key·주민등록번호를 허용하지 않는다.

Owner 수신 예시:

```js
import { productMasterChangeRequestAdapter } from './reference-data/product-change-request-adapter.js';
import { customerMasterChangeRequestAdapter } from './customer-master/change-request-adapter.js';

const receipt = await productMasterChangeRequestAdapter.submitChangeRequest(productRequest);
const inbox = await customerMasterChangeRequestAdapter.listChangeRequests({ status: 'PENDING' });
```

| 상태 | 의미 | 호출자 처리 |
|---|---|---|
| `PENDING` | owner inbox에 신규 접수 | 승인 완료로 해석하지 않음 |
| `DUPLICATE` | 같은 idempotency key와 같은 payload 재전송 | 기존 접수 결과 사용 |
| `CONFLICT` | 같은 idempotency key 또는 request ID에 다른 payload | 작업본과 요청 보존 후 관리자 확인 |
| `REJECTED` | schema·domain-owner·revision·민감정보 검증 실패 | 오류 목록을 수정한 새 요청 생성 |
| `NOT_AVAILABLE` | owner Repository/Adapter 사용 불가 | 요청과 작업본을 보존하고 재시도 |
| `ERROR` | Repository transaction 등 실행 오류 | 요청과 작업본을 보존하고 재시도 |
| `APPLIED` | 후속 owner 승인 workflow가 사용할 예약 상태 | 이번 단계에서는 생성하지 않음 |

`submitChangeRequest`는 master writer, history writer, 승인·적용 API를 호출하지 않는다. 적용 단계가 추가되더라도 owner가 현재 revision, 필수필드, 중복, 권한과 원자성을 다시 검사해야 한다.

## additive migration과 데이터 보존

| Owner | 전 | 후 | 원본 영향 |
|---|---|---|---|
| Product | `MerchOpsDB` v2, `master_products` + `store` | 같은 DB·version·Store + `store.oneappProductReferenceChangeRequests_v1` | master rows, snapshot, revision, history key 불변 |
| Customer | `oneapp-customermaster-v1` v1, 기존 11 Store | 같은 DB·version·Store + `appMeta.referenceChangeRequestsV1` | customers, alias, links, events, import, migration snapshot 불변 |

- Inbox key는 첫 유효 submit 때만 추가하고 같은 요청 재실행은 항목을 늘리지 않는다.
- DB version과 Object Store 목록을 바꾸지 않아 구버전 앱은 추가 key를 무시하고 기존 데이터를 계속 읽는다.
- 상품 master commit은 KV store 전체를 clear하지 않으므로 inbox key를 보존한다.
- Customer backup/restore는 `appMeta`를 clear하지 않으므로 inbox key를 보존한다.
- rollback에서 inbox key나 미처리 요청을 자동 삭제하지 않는다.

## 현행 접근목록과 후속 전환

기준 SHA에서 확인된 상품 직접 writer allowlist:

- 공식 owner: `Master.html`
- 레거시 앱: `MerchOps.html`, `SmartParser.html`, `settings.html`, `export_center.html`, `Item_manager.html`
- 공유 원자 writer: `coreEngine.js`, `masterAddUpdate.js`
- 문서상 후속 후보이나 current source 미검출: `DataOps.html`

현재 reader에는 위 앱들과 History, ORDER Q 수기 상품검색이 포함된다. 이번 작업은 reader/consumer를 일괄 전환하지 않고 신규 직접 writer가 추가되지 않았는지만 고정한다. SmartInput 기준정보 UX와 최신 Snapshot 반영은 이 병합본의 공개 API를 사용하는 별도 후속 작업이다.

## 장애 격리와 rollback

- Product Read Adapter 장애는 상품 Snapshot 조회만 실패시키며 `Master.html`의 기존 조회·등록·수정을 막지 않는다.
- Customer request Adapter는 화면에서 dynamic import하므로 실패해도 기존 검색·단건 저장·Excel·backup/restore가 실행된다.
- 코드 rollback은 병합 PR revert 또는 직전 main 재배포다.
- Adapter rollback은 기존 직접 reader와 기존 Customer `getSnapshot()`/`search()` 호환을 유지한다.
- Inbox rollback은 새 key 사용을 중지할 뿐 key와 요청을 삭제하지 않는다.
- 원본 product/customer 데이터는 rollback 과정에서 삭제·복원·덮어쓰기하지 않는다.
