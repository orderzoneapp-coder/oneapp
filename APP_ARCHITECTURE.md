# ONEAPP Application Architecture

- Repository: orderzoneapp-coder/oneapp
- Architecture document version: 2.1.31
- Last reviewed: 2026-09-04
- Current-source baseline: `46154150a02da3e3d256a1e39c0f8e3562902bfb`
- Machine-readable companion: app-manifest.json

## 1. 문서 목적

ONEAPP은 여러 업무 앱을 한 화면에 묶는 단일 거대 앱이 아니라, 각 앱이 자기 기본 업무를 독립적으로 수행하고 필요한 정보만 계약을 통해 교환하는 앱 집합이다.

이 문서는 다음을 정의한다.

- 현재 운영 소스의 실제 구조와 한계
- 목표 앱 독립 구조와 계층별 책임
- 앱별 데이터 소유권과 Adapter 경계
- 서버가 필요한 작업과 서버 없이 유지해야 하는 기능
- 외부 장애 격리와 활성 작업본 보호
- 앱 상태(계획·파일럿·운영), 독립 배포·검증·롤백 기준
- 현재 공유 계약을 목표 구조로 옮길 때의 변경 영향

공통 작업 절차, Git, 역할, 승인, 병합·배포와 보고 규칙은 `AGENTS.md`를 따른다. 이 문서의 목표 구조는 구현 완료 선언이나 데이터 소유권 이전 승인이 아니다. 실제 소유권·저장소·운영 상태는 별도 개발, 마이그레이션, 검증과 `app-manifest.json` 갱신이 끝난 뒤에만 변경된다.

---

## 2. 앱 독립성 원칙

1. 각 앱은 해당 앱 역할의 기본 기능을 다른 앱·공통 Runtime·서버의 정상 작동 여부와 관계없이 실행할 수 있어야 한다.
2. 화면 표시, 로컬 조회, 검색, 계산과 작업본 편집은 검증된 로컬 데이터가 있으면 서버 응답을 기다리지 않는다.
3. 데이터의 쓰기 소유자는 하나로 정하고, 다른 앱은 소유 앱의 명시된 Adapter 또는 서버 계약을 사용한다.
4. 앱은 다른 앱의 IndexedDB, Object Store, localStorage 또는 원시 Repository에 직접 쓰지 않는다.
5. Read Adapter는 읽기 전용 Snapshot 또는 조회 계약만 제공하며 소유 저장소를 수정하지 않는다.
6. Integration Adapter 실패는 해당 연동 기능에만 영향을 주고 앱 Core와 무관한 기본 작업으로 전파되지 않는다.
7. 공통 Runtime과 NEXUS 공통 UI는 앱 실행을 통제하거나 업무 데이터 준비 완료를 결정하지 않는다.
8. 서버는 인증·권한·공유·동기화·충돌 조정·최종 확정처럼 서버 권위가 필요한 경계에서만 필수다.
9. 서버 오류, 조회 실패와 미확정 상태를 정상 데이터 `0건`으로 바꾸지 않는다.
10. 열린 전표와 활성 작업본은 생성 시점의 상품·거래처 Snapshot을 보존하며 마스터 변경으로 자동 덮어쓰지 않는다.
11. 경고·충돌은 관리자에게 알리되 관련 없는 작업을 차단하지 않는다. 실제 데이터 무결성 위험이 있는 작업만 차단한다.
12. 앱별로 독립 배포·검증·롤백이 가능해야 하며 공통 자산 실패 시에도 앱 본체의 기본 기능이 유지되어야 한다.
13. 계획 또는 목표 역할은 현재 운영 완료로 표시하지 않는다. 상태 변경은 소스, 검증, 배포와 manifest가 일치할 때만 확정한다.
14. 현재 운영 계약은 별도 승인된 이전 작업이 완료될 때까지 보존한다. 목표 구조를 이유로 기존 저장소를 즉시 통합·이전하거나 직접 접근을 일괄 차단하지 않는다.
15. GitHub `main`은 운영 소스 기준이며 공유 필드, 저장 키, API action, payload와 경로 변경은 모든 소비자 영향·이전·롤백을 검토한다.

---

## 3. 현재 구조와 목표 구조

### 3.1 현재 운영 구조

현재 `origin/main` 기준은 앱 독립 목표로 전환 중인 과도기다.

- MerchOps, DataOps, SmartParser, Export Center, Settings와 History Viewer는 `MerchOpsDB` 및 여러 localStorage 계약을 공유한다.
- `app-manifest.json`의 `product-master` 공식 소유자는 `master-lookup`이다. 물리 Repository는 기존 `MerchOpsDB/master_products`와 `merchMaster_v870`·`merchMaster_revision_v870`을 그대로 사용하며 데이터 이동이나 재초기화는 없다.
- `Master.html`은 manifest의 `master-lookup` 공식 경로이자 기존 운영 상품 저장계약을 사용하는 유일한 공식 상품관리 앱이다. 기존 주소·앱 ID·공통 표시 명칭 `상품관리`를 유지하며, 빈 DB 최초 Excel 등록과 상품 단건 등록·수정을 공용 revision·history 계약으로 수행한다.
- `reference-data/product-master-read-adapter.js`는 `ONEAPP_PRODUCT_MASTER_READ_ADAPTER_V1` / `ONEAPP_PRODUCT_SNAPSHOT_V1` 읽기 전용 경계를 제공한다. 조회는 record Store를 우선하고 기존 snapshot·revision으로 fallback하며 DB가 없을 때 생성하지 않는다.
- `SmartParser.html`은 이 Product Snapshot을 시작 기준으로 고정하고 `smartparser/analysis-result-contract.js`의 불변 `ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1`을 생성한다. 분석 F7의 신규상품·상품정보·가격·카탈로그 제안은 `ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER`에 `PENDING` 접수하며 product master·revision·확정 history·stop state를 직접 쓰지 않는다.
- SmartParser의 사용자가 별도 품절/정지 화면에서 명시한 `STOP`·`RESUME`·`UPDATE_METADATA`만 `smartparser/stop-management-command-adapter.js`를 통해 expected Snapshot/revision과 operation ID를 검증한 뒤 판매여부·정지목록·쇼핑몰 상태 대기열·실제 history·mirror·notification을 한 성공 단위로 반영한다. 분석의 0원·품절은 issue와 정지 권고일 뿐 command를 자동 실행하지 않는다.
- `reference-data/product-master-command-adapter.js`는 `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1` 아래 `MERCHOPS_REVIEWED_WORK_APPLY_V1`과 `MERCHOPS_PRODUCT_REGISTRATION_V1` 경계를 제공한다. MerchOps는 작업 시작 Snapshot ID·revision·hash와 검토 증거를 보내며 F7은 기존 상품 field patch만, 관리자 확인 신규등록은 제한된 생성 field만 수행한다. 행 삭제·임의 필드·일반 판매여부 변경은 거부하고 충돌, history 실패, 연결상태 변경, 후검산 실패는 전체 변경을 rollback한다.
- MerchOps의 bundled/external core 호환 API는 Adapter 로드 직후 owner boundary로 다시 고정한다. cloud URL seed·쓰기, full backup/restore, config 복원, master cloud import·Excel apply·backup restore 및 공개 master commit alias는 `OWNER_ROUTED`로 fail-closed하며 시작 시 Settings 키를 만들거나 덮어쓰지 않는다.
- 현행 상품 직접 writer 동결 allowlist에서 `MerchOps.html`, `SmartParser.html`, `settings.html`, `export_center.html`을 제거했다. SmartParser 전용 stop command Adapter는 범용 raw writer가 아니라 manifest에 명시된 판매상태 예외 경계다. 남은 호환 writer는 `Master.html`, `Item_manager.html`과 공유 `coreEngine.js`·`masterAddUpdate.js`며 새 cross-app 직접 writer를 허용하지 않는다. DataOps F6는 Product Snapshot만 소비하고, 관리자 단건등록·F9 판매재개가 필요할 때만 기존 `masterAddUpdate.js`의 CAS·history·rollback 명령 경계를 호출한다.
- DEC-021에 따라 History Viewer는 `ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1`의 불변 Snapshot만 읽고 Cloud 결과를 메모리에서만 병합한다. Settings는 `ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1` allowlist와 검증·pre-image·rollback·후검산 경계로 설정만 복구하며 상품·이력·정지 상태 변경은 owner 화면으로 보낸다. Export Center는 기존 `merch_export_draft`를 유지하고 Product Snapshot을 읽기 전용 참조하며 F9와 화면 버튼 모두 output-only로 실행한다.
- `ItemMaster.html` 독립 구현은 폐기됐다. 현재 파일은 기존 직접 주소를 위한 정적 호환 안내이며 앱 Runtime이나 DB 쓰기를 실행하지 않는다. 과거 `oneapp-itemmaster-isolated-v1` 데이터는 자동 삭제·덮어쓰기하지 않고 `Master.html`에서 실제 데이터가 발견될 때만 백업·선택 검토 경로를 제공한다.
- `Item_manager.html`은 manifest의 `item-manager`로 등록된 별도 상품 관리 파일럿이다. `Master.html`, `ItemMaster.html`과 현재 경로·저장계약을 각각 유지한다.
- `customer-master/index.html`은 독립 거래처관리 파일럿이다. `oneapp-customermaster-v1` DB의 거래처 원본·별칭·외부코드 매핑·변경이력·Excel 작업을 소유하고 상태가 명시된 읽기 전용 Snapshot Adapter를 제공한다. SmartInput은 이 Snapshot의 읽기 전용 소비자로 전환됐고 ORDER Q 소비자 전환은 아직 수행하지 않는다.
- 두 owner는 `ONEAPP_REFERENCE_CHANGE_REQUEST_V1`을 검증하고 기존 owner Repository의 additive KV inbox에 멱등 저장한다. 접수 상태는 `PENDING`이며 자동 승인·자동 master 적용은 하지 않는다.
- ORDER Q의 `orderops`와 `orderq-vnext`는 파일럿이며 각자의 로컬·클라우드 계약을 유지한다.
- ORDER Q vNext의 `oneapp-orderq-pre-m1-v6` DB v7과 `orderq/official-voucher-repository.js`가 현행 구매·판매 공식전표 저장 경계다. `runCentralOfficialVoucherCommand()`는 한 IndexedDB transaction에서 공식 문서·행, 명령 영수증, Revision, 매칭 재고 이동 또는 미매칭 대기효과, 현재 Adapter에서 정확히 확인된 거래처의 기본 채권·채무 효과와 공식 `syncQueue` 행을 함께 저장한다.
- `NEXUS-ORDERQ-SHOP-ACTUAL-LEDGER-20260904-01` 1단계는 ORDER Q owner 내부에 `shopping-order-dedupe-core.js → shopping-order-import-repository.js → shopping-order-command-adapter.js` 경계를 추가한다. 고정 17열 쇼핑몰 원본의 상태·그룹·파일명·업로드시각·절대 행번호는 증적으로만 보존하고 회사·확정 거래처·배송일자·확정 출하창고·반복행을 보존한 품목 다중집합으로 signature를 계산한다. 거래처·창고 owner ID와 모든 품목 owner ID·저장 코드·상품명 중 하나라도 미해소이면 후보 전체는 판정·저장 양쪽에서 `REVIEW_REQUIRED`/0-write이고, 동일 가능성이 있는 불완전 legacy 원장도 `EXISTING_LEDGER_BUNDLE_INVALID`로 fail-closed한다. 실제 `orders`·`orderItems` 전체와 같은 signature인 정상 수기 주문도 개수에 포함해 원본 occurrence `n`이 현재 개수 `m` 이하일 때만 `isDuplicate=true`이고 초과분만 생성한다. 후보별 기존 DB v7 readwrite transaction이 실제 개수를 다시 읽고 기존 `orders.bySourceMessageKey` unique index를 사용한 뒤 주문·품목·생성이력·local queue를 함께 확정하므로 중복·문제 후보는 0-write이고 실패 후보는 다른 signature의 정상 후보와 격리된다. `그룹`은 주문번호나 경계가 아니며, 같은 거래처 연속행 안의 동일 주문 반복을 나눌 원본 식별자가 없으면 `AMBIGUOUS_SOURCE_ORDER_BOUNDARY`로 보류한다. 이 단계는 owner Core/Adapter만 제공하고 SmartInput UI, DB schema/Store/index/version, Cloud 계약과 다기기 전역 중복 방지는 활성화하지 않는다.
- `NEXUS-SI-V2-02~05`는 SmartInput 구매·판매 UI handler를 업무별 Finalize Service에 연결하고, 공식 입력 모듈의 Repository 직접 import를 ORDER Q 소유 `official-command-adapter.js → official-command-gateway.js → official-voucher-repository.js` 경계로 교체했다. V2 경로는 필수검사·Snapshot·회사/판매그룹 ID, 회사+상품코드 및 회사+거래처코드 정확매칭, 입력수량 그대로의 재고효과, 미매칭 검수 레코드와 거래처 미입력·미매칭 원장 미생성 사유에 이어 재고실사 checkpoint 충돌 결정을 구현한다. 상품코드는 상품 owner와 동일하게 외곽 trim 뒤 원문 문자열을 key로 쓰고, 거래처코드는 customer master의 `normalizedCustomerCode` 규칙을 쓴다. V2 재고와 기본 채권·채무의 발생일은 전표 `businessDate`이고 명령 `occurredAt`과 분리된다. Gateway와 Repository는 회사·Revision·멱등성·발생일·checkpoint 결정·transaction을 재검사하며, V2 inspection capability가 없으면 검사·Draft 저장·명령 실행을 모두 fail-closed한다. 새 전역 Runtime이나 NEXUS 공통 Gateway가 아니다.
- `NEXUS-SI-V2-06A`는 ORDER Q owner 내부에 `ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_MODEL_V1`과 `ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_ADAPTER_V1`을 추가한다. owner Repository가 회사 범위의 기존 DB v7 미매칭 레코드·대기효과·확정 문서·행·Revision·실사 checkpoint를 `readonly`로 읽어 조합하며 소비자는 ORDER Q Store를 열지 않는다. 같은 pending-effect ID의 검수 링크와 대기효과는 공통 핵심 필드를 모두 대사한 뒤 중복 제거하고, 상충 필드는 `REVIEW_REQUIRED` issue로 보존한다. point-get 대상이 다른 회사이면 mismatch issue만 남기며 그 회사의 문서·행·Revision·상품·수량·창고·일자·시각 payload는 결과에 사용하지 않는다. 각 결과는 확정 시점 원문 상품·수량·창고·발생일과 전표 추적을 보존하고 공식재고 `미반영`을 수량 0과 구분한다. 현재 Product Snapshot 후보와 재매칭 영향은 검수 참고뿐이며 자동확정·재매칭 command·공식재고·기준정보 쓰기는 없다. 읽기 실패는 `ERROR`로 fail-closed하고 정상 `EMPTY`와 구분하며, 제품 UI와 SmartInput 작업본은 변경하지 않는다.
- UI Gate U1의 A안 승인에 따른 `NEXUS-SI-V2-06B`는 `orderops/list.html`의 기존 창고재고·출고 결과 영역과 검색·정렬·열 조건 구조 안에 `미매칭` 조회 상태만 추가한다. 제품 UI는 6A Read Adapter만 호출해 최대 200건 단위의 모든 페이지, 원전표 추적, 명시적 후보 선택 뒤 읽기 전용 영향 미리보기를 같은 `#previewTable` 안에서 전환한다. 페이지 이동은 이전·다음과 현재/전체 페이지를 표시하며 검색·정렬·열 조건은 현재 페이지 범위임을 명시한다. 새 상위 화면·탭·패널·팝업·라우트·적용 버튼은 없으며, 회사 범위 조회 실패는 기존 파일·재고·출고 작업과 격리된다. 이 소비자 상태를 제거하면 기존 결과 화면으로 즉시 롤백되고 6A owner 자산과 DB v7 자료는 유지된다.
- `NEXUS-SI-V2-06C`는 실제 재매칭을 `official-command-adapter.js → official-command-gateway.js → official-voucher-repository.js`의 단일 ORDER Q owner 경계로 제한한다. 명령은 사용자 명시 선택, 회사·identityVersion·결정적 commandId/idempotencyKey, 현재 Product Snapshot revision/hash, 모든 예상 문서·행·기존 Revision·pending-effect 링크, actor·달력상 유효한 occurredAt·judgedAt·selectedAt을 검증한다. Repository는 readonly preflight와 write transaction 내부에서 원 확정 document·ACTIVE/CONFIRMED line·hash 검증 Revision을 기준으로 factor 1 수량, 구매+/판매- 부호, 창고, 업무일, 원 source에 실제 존재하는 업무시각과 동일 원 command 링크를 재계산해 review/pending 양쪽 동시 변조도 차단한다. 이어 6A 링크 대사와 단계 5 순수 checkpoint 분류를 재실행한다. 원 수량 0은 항상 `ZERO_EFFECT`이고 실사 결과는 별도 `stocktakeEffectStatus`에 빈 값/`ABSORBED_BY_CHECKPOINT`/`APPLIED_AS_LATE_ADJUSTMENT`로 보존한다. unresolved 해결상태, pending-effect 연결결과, 재고/흡수 효과, unresolved 단위 감사 Revision, 명령 영수증과 로컬 syncQueue를 기존 DB v7 Store의 한 transaction으로 저장하며 확정 당시 전표·행·Product Snapshot은 수정하지 않는다. raw 로컬 재매칭 writer는 fail-closed하고 기본 feature gate와 Cloud 전송은 OFF다. 이 단계는 제품 UI·상품 기준정보·수정/취소·schema/migration/Store를 변경하지 않는다.
- `NEXUS-SI-V2-07A`는 확정전표 수정·취소 기반을 같은 ORDER Q owner Adapter→Gateway→Repository 경계에 추가한다. `CORRECT`/`CANCEL` 명령은 회사·구매/판매·document ID·expected Revision·actor·timezone 포함 시각·결정적 commandId/idempotencyKey·payload digest와 현재 document/ACTIVE line/hash 검증 Revision/유효 재고·pending 효과의 완전한 target Snapshot을 포함한다. Repository는 readonly preflight와 같은 DB v7 readwrite transaction 안에서 이를 다시 읽고 stale·취소·회사/종류/ID·command scope 충돌을 fail-closed한다. `CORRECT`는 공식 V2 필수입력·확정 Product Snapshot·행/문서 합계 계약을 다시 검사해 공백과 명시적 0을 구분하고, 새/변경 상품·거래처의 MATCHED/UNRESOLVED 분류를 현재 owner Snapshot으로 재계산한다. 거래수량·금액만 바뀐 기존 identity는 확정 당시 Snapshot을 유지하며 품명-only unresolved ID는 결정적으로 검증한다. 새 immutable Revision의 before/after Snapshot과 기존 유효효과의 별도 반전행·새 효과 또는 pending 상태를 만들고, `CANCEL`은 문서·행 삭제 없이 CANCELLED Revision과 실제 적용 효과의 반대 또는 흡수 효과의 감사상 0을 기록한다. 상품·창고·일자·수량 변경, 매칭↔미매칭과 6C 완료 행을 같은 계획으로 처리하며 구매 +수량/판매 -수량, 0·양수·음수와 factor 1을 보존한다. 문서의 모든 movement에서 reversal을 적용한 current non-reversal ID 합집합과 모든 active pending ID 합집합을 Head `effectiveLineStates`의 두 합집합과 각각 정확히 대사하며, 초기 POST 형식도 state를 derive한 뒤 같은 coverage를 적용한다. 따라서 삭제된 과거 행의 고아효과와 Head 무관 추가효과가 거부된다. source Revision.effects는 POST·6C·7A 형식별 필수 type/status/applied/role 또는 pending ID/quantity 필드를 요구하고 reversal lineage와 businessOccurredAt도 검사한다. active pending은 unresolved reviewLink가 정확히 하나이며 회사·전표·행·Revision·command·창고·업무일/시각·수량·금액·Snapshot이 일치해야 한다. 각 차이행은 원 businessDate의 단계 5 classifier를 재사용하고 `ZERO_EFFECT`, `stocktakeEffectStatus`, `REVERSED`를 별도 필드로 보존한다. 현재 기본 payable/receivable 효과가 연결된 문서는 금융 후속정책 전까지 명시적 미지원 오류로 차단하며 7A는 AR/AP를 쓰지 않는다. 구매/판매별 수정/취소 gate는 네 개 모두 기본 OFF이고 제품 UI·DB schema·Cloud allowlist·Pilot은 변경하지 않는다.
- 각 매칭 행은 회사+상품코드(기존 checkpoint의 숨은 `productId` 호환)+창고 범위에서 최신 확정 checkpoint를 판정한다. `businessDate`가 checkpoint 일자보다 뒤면 정상이고, 앞이면 결정이 필요하며, 같은 날은 양쪽의 신뢰 가능한 업무시각과 timezone으로 전표가 뒤임을 증명할 때만 정상이다. 팝업은 충돌 행을 순차 확인해 행마다 독립된 포함/미포함 선택과 timezone이 있는 완전한 ISO `judgedAt`을 수집한다. 모든 그룹의 모든 행 선택과 재검증이 끝난 뒤에만 첫 쓰기를 시작하며 중간 취소는 선택을 폐기한다. 포함 결정은 원 효과를 `ABSORBED_BY_CHECKPOINT`로 연결해 현재고에 중복 반영하지 않고, 미포함 결정은 `APPLIED_AS_LATE_ADJUSTMENT` 연결조정을 결정적 ID로 정확히 한 번 추가한다. 취소는 Finalize 쓰기 전 반환하며 작업본·선택·스크롤을 보존한다.
- 구매·판매 V2 Gate와 재매칭 Gate는 각각 기본 OFF라서 이 단계만으로 Pilot 또는 기존 공식 쓰기 경로가 활성화되지 않는다. Cloud Push/Pull 운영 활성화, 미매칭 재해결 제품 UI·대량 처리, 수정·취소 기능과 Draft V2는 후속 단계다. 단계 5의 순수 checkpoint 판정 계약은 단계 6C 명령 계획기가 재사용하며, 이름·유사도 기반 자동확정과 기존 조용한 누락 경로는 활성화하지 않는다.
- NEXUS 기본 로그인 홈은 `nexus/index.html`에서 운영한다. 배포된 `NEXUS_AUTH_V2` 서비스로 사용자 식별, 최초 활성화와 로그인·로그아웃 기록을 처리하며, 저장된 홈 Session은 즉시 표시한 뒤 서버 상태를 백그라운드에서 확인한다. `OWNER_MASTER`의 최소 사용자 관리는 `nexus/admin/index.html`에 한정하고 사용자 삭제·기능권한·서비스 연결·승인 UI를 두지 않는다.
- NEXUS 홈은 회사정보 카드·상태·Snapshot·Gateway 조회 없이 하단에 `원앱 | NEXUS 사내 업무 시스템`이라는 고정 소유 표시만 렌더링한다. 이 Footer는 Session Token·사용자 식별·회사정보 revision·서버 상태에 의존하지 않으며, 회사정보 장애가 홈 초기 표시와 앱 카드에 영향을 주지 않는다.
- `nexus/company.html`은 서버 권위 회사정보의 관리자 조회·수정 화면이다. `OWNER_MASTER`와 `admin.company`, 앱 컨텍스트, `expectedRevision`은 서버 Gateway가 최종 강제하며 성공한 쓰기는 revision과 감사이력을 남긴 뒤 재조회한다.
- 운영 NEXUS Gateway v24에서 읽기 전용으로 확보한 정확한 서버 기준본은 `nexus/server/nexus-auth-gateway.gs`와 같은 폴더의 Apps Script manifest에 보존한다. 최소 사용자 통제 변경은 이 기준본 위에서만 수행하며 회사정보·업무 Gateway 레지스트리를 삭제하거나 과거 과잉 소스로 교체하지 않는다.
- 기준 main `24429a1cdb53bbe084ef08b6516d012737a01808`에는 운영 중인 NEXUS Gateway·회사정보 Apps Script 서버 소스가 없었고, 상류 ONEAPP Apps Script v44 롤백은 회사정보 모듈과 라우트를 포함하지 않아 인증된 `company.profile_read`를 처리하지 못했다. `code.gs`와 `company-profile.gs`는 기존 Foundation Gateway binding, revision, 감사, 원자적 백업, 1회 migration ledger 계약을 복원한다. 공식 배포는 기존 상류 deployment ID를 유지하고 v44를 롤백 기준으로 보존한다.
- 업무 앱 공통헤더는 사용자 정보를 표시하거나 인증 Runtime을 로드하지 않는다. 같은 탭의 `NEXUS_UI_VISIBILITY_V1` 비민감 투영을 동기식으로 읽어 탭만 숨길 수 있으며, 투영 부재·오류 시 전체 정적 목록으로 복구한다. 기존 권한별 앱 차단, 업무 Gateway 프록시와 앱 실행 통제 Runtime은 계속 롤백 상태다.
- `coreEngine.js`는 여러 앱이 사용하는 현행 공유 라이브러리지만, 앱 Core를 부팅시키거나 전체 앱 준비 상태를 결정하는 상위 Runtime으로 확대하지 않는다.
- GitHub Pages는 현재 저장소 단위로 배포된다. 앱 독립 배포 목표는 우선 앱별 변경·검증·PR·롤백 범위를 분리하는 것이며, 물리적 배포 단위 분리는 별도 호스팅 변경이 승인될 때만 수행한다.

이 현재 구조의 직접 공유 접근은 호환성 기준선이다. 새 기능이 이를 확대해서는 안 되며, 소유권 이전은 소비자별 Adapter 전환과 회귀검증을 갖춘 별도 작업으로 수행한다.

### 3.2 목표 계층

| 계층 | 책임 | 금지 경계 |
|---|---|---|
| 앱 Core | 화면, 검색, 계산, 작업, 로컬 작업 흐름 | 다른 앱·서버 상태로 기본 실행을 통제하지 않음 |
| 앱 Repository | 해당 앱이 소유하는 원본·작업본·로컬 저장 관리 | 다른 앱의 원시 저장소를 직접 수정하지 않음 |
| Read Adapter | 소유 데이터를 읽기 전용 Snapshot·조회 계약으로 제공 | 소비자 대신 쓰거나 업무 결정을 수행하지 않음 |
| Integration Adapter | 다른 앱 정보 조회·전달, 계약 변환, 실패 격리 | 실패를 앱 전체 오류나 정상 0건으로 바꾸지 않음 |
| Server Transport | 인증, 권한, 공유, 동기화, 충돌 조정, 최종 확정 | 화면 표시·로컬 조회·편집의 선행조건이 되지 않음 |
| NEXUS 공통 UI | 헤더, 앱 이동, 테마, 공통 상태 표시 | 업무 IndexedDB·Repository·앱 준비 상태를 통제하지 않음 |

### 3.3 목표 실행 흐름

```text
NEXUS 공통 UI ── 정적 이동·테마·공통 상태 ──> 각 독립 앱
                                                │
                         ┌──────────────────────┴──────────────────────┐
                         v                                             v
                 앱 Core + 앱 Repository                      Integration Adapter
                 즉시 표시·조회·계산                          외부 Snapshot 조회·전달
                         │                                             │
                         └──────── 필요한 작업만 Server Transport ────┘
                                      인증·공유·동기화·최종 확정
```

- 앱 Core는 자신의 Repository에서 검증된 로컬 상태를 먼저 표시한다.
- 외부 기준정보는 Read Adapter가 제공하는 불변 또는 revision이 있는 Snapshot으로 읽는다.
- 백그라운드에서 새 revision을 받아도 활성 작업본을 자동 변경하지 않는다.
- 서버 장애 시 로컬 기본 작업은 유지하고, 동기화·공유·최종 확정처럼 관계된 기능만 지연 또는 제한한다.

### 3.4 의존성 실행 방식

앱의 각 기능은 `AGENTS.md`의 실행 방식 중 하나로 명시한다.

| 방식 | 사용 조건 | 장애 시 동작 |
|---|---|---|
| `LOCAL_OPERATION` | 화면, 로컬 조회, 검색, 계산, 작업본 편집 | 외부 장애와 무관하게 계속 실행 |
| `BACKGROUND_SYNC` | 로컬 결과를 먼저 확정하고 최신 정보·백업을 후행 확인 | 마지막 정상 상태를 유지하고 재시도 |
| `SERVER_FINALIZE` | 인증·권한·공유 충돌·중앙 원장·최종 확정 | 해당 확정 작업만 보류하고 원인과 로컬 상태를 보존 |

---

## 4. 앱 책임과 상태

| 앱·영역 | 현재 상태 | 현재 사실 | 목표 역할 |
|---|---|---|---|
| NEXUS 홈·공통 UI | 운영 | 기본 로그인·최초 활성화·로그아웃과 앱 홈, `OWNER_MASTER` 최소 사용자 관리, 사용자별 비민감 카드·탭 노출, 서버 비의존 고정 소유 Footer, 정적 헤더·로고 홈 이동·일반/다크 테마. 권한별 업무 앱 차단·전역 Gateway Runtime은 롤백 상태 | 사용자 식별과 앱 연결을 제공하되 업무 앱 실행은 통제하지 않음 |
| NEXUS 회사정보 | 운영 | 전용 상세 화면의 보호 조회·쓰기·revision·감사는 서버 Gateway가 확정하며, 홈·공통헤더·업무 앱은 회사정보 서버를 조회하지 않음 | 회사 원본과 전용 관리 경계를 유지하고 다른 업무 앱 저장소를 수정하지 않음 |
| 상품관리 (`Master.html`) | 파일럿·공식 | `product-master` 공식 owner이며 기존 운영 상품 저장·revision·history·Cloud 계약, 읽기 Snapshot과 변경요청 inbox를 소유 | 유일한 공식 상품관리 구현과 Adapter owner로 유지 |
| ItemMaster (`ItemMaster.html`) | 폐기·호환 | 중복 앱 기능 없이 `Master.html`을 안내하는 정적 호환 주소 | 레거시 주소 호환만 유지하고 운영 쓰기 금지 |
| Item Manager (`Item_manager.html`) | 파일럿·유지 | 기존 `product-master` 계약을 사용하는 별도 상품 기초정보 관리 화면 | Master 교체와 무관하게 별도 상품 관리 화면으로 유지 |
| 거래처관리 (`customer-master/index.html`) | 파일럿 | 독립 DB에서 거래처 원본·매핑·변경이력·Excel 작업을 로컬 우선으로 운영하며 v17 원본을 읽기 전용으로 이전하고 Snapshot·변경요청 inbox를 제공 | 거래처 기준정보 단일 소유자, Read Adapter와 요청 수신 경계 제공 |
| SmartInput (`smartinput/index.html`) | 파일럿 | 네 전표 작업본·DB v5의 최신 자동저장·회사/전표별 필드 설정·V2 입력 양식·불변 기준정보 세대를 로컬 우선으로 운영. 구매·판매 UI는 업무별 Finalize Service만 호출하고 ORDER Q command Adapter를 거쳐 공식 Gateway를 소비하며 Repository나 공식 Store를 직접 열지 않음 | 전표 작성 작업본·필드 등록부·입력 양식·견적 원본 소유, owner Snapshot과 ORDER Q 공식 command Adapter 소비 |
| ORDER Q (`orderops`, `orderq-vnext`) | 파일럿 | 출고·주문 계약과 DB v7의 공식 문서·Revision·재고/미매칭·기본 채권채무·공식 sync queue Repository를 운영 전 검증 중 | 공식전표 `OfficialCommandGateway`·Repository와 공식 데이터의 단일 쓰기 소유자 |
| MerchOps | 운영 | Product Snapshot 소비, 가격·프로모션·Excel 작업, F7 reviewed-patch command, 관리자 명시 미등록 상품 owner-command 등록 | 작업표는 로컬에 보존하고 소유 설정·SmartParser 상태를 read-only로 소비 |
| DataOps | 운영 | 재고·매입·매출·원가 분석과 승인된 일부 상품 상태 갱신 | 분석 결과와 승인된 현행 master writer 경계 유지 |
| SmartParser | 운영 | 외부 문서 로컬 분석·매칭, 불변 분석결과, 상품 owner PENDING 요청, 공급사 제외와 명시적 stop command | 상품 원본은 Snapshot으로만 읽고 분석 제안과 즉시 stop command를 분리 |
| History Viewer | 운영 | 변경이력 Snapshot 조회·검색·가격 추세·현재 화면 JSON/CSV 출력 | local/Cloud 원본을 변경하지 않는 읽기 전용 감사 화면 |
| Settings | 운영 | 설정 allowlist 편집, JSON/Cloud 원자 복구, 상품·SmartParser owner routing | 설정만 쓰고 외부 소유 데이터는 불투명 복구 예외 외에 변경하지 않음 |
| Export Center | 운영 | MerchOps F9 초안 검토, Excel·이미지 출력, Product Snapshot 상태 표시 | master/history/revision 무쓰기 output-only 화면 |

### 4.1 상태와 소유권 전환

- `계획`: 목적과 계약만 정의됐으며 운영 의존성과 운영 쓰기를 허용하지 않는다.
- `파일럿`: 구현은 있으나 제한 검증 단계다. 목표 소유권을 전체 운영 소유권으로 간주하지 않는다.
- `운영`: 배포된 기본 흐름, 데이터 계약과 롤백이 검증된 상태다.
- 목표 역할은 방향을 뜻하며 현재 저장소 owner를 즉시 바꾸지 않는다.
- `Master.html`은 `master-lookup` 공식 경로와 운영 저장계약을 유지한다. `ItemMaster.html`의 중복 구현은 폐기되고 정적 호환 안내만 남으며, `Item_manager.html`은 별도 앱·경로·기능을 유지한다.
- `Item_manager.html`은 `master-lookup` 교체 대상이 아니며 기존 `item-manager` 앱 ID와 역할을 유지한다.
- 소유권 전환은 소유 Repository, Read/Integration Adapter, 소비자 전환, 데이터 이전, 회귀검증, 독립 롤백과 manifest 갱신을 같은 별도 작업에서 완료해야 한다.
- 미구축 앱의 이름이나 목표 계약을 기존 앱의 필수 Runtime 의존성으로 추가하지 않는다.
- `계획(미등록)`은 아키텍처 목표만 기록된 상태다. 실제 개발이 승인되면 `plannedApplications` 등록 기준을 충족한 뒤 파일럿 승격 절차를 시작한다.

### 4.2 현재 manifest 등록 목록

아래 표는 목표 역할이 아니라 `app-manifest.json` v1.3.8의 현재 등록 상태다.

| 앱 ID | 현재 경로 | 상태 | 현재 책임 |
|---|---|---|---|
| `nexus-home` | `nexus/index.html` | 운영 | 기본 로그인·로그아웃 기록, 사용자 식별과 독립 업무 앱 이동 |
| `nexus-admin` | `nexus/admin/index.html` | 운영 | `OWNER_MASTER`의 일반 사용자 추가·이름·사용상태·비민감 앱 노출과 최소 감사 조회. 삭제·기능권한·서비스 연결은 소유하지 않음 |
| `merchops` | `MerchOps.html` | 운영 | Product Snapshot 기반 가공·가격·프로모션, 관리자 확인 신규상품 owner-command 등록, F7 reviewed patch, F8 무쓰기, F9 호환 payload |
| `dataops` | `DataOps.html` | 운영 | 매입·매출·재고·원가·성과 분석 |
| `smart-parser` | `SmartParser.html` | 운영 | 외부 문서 해석·불변 분석결과, Product Snapshot 매칭, PENDING 상품요청, 공급자 제외와 전용 stop-management command |
| `export-center` | `export_center.html` | 운영 | MerchOps F9 초안 검토, Product Snapshot 상태 확인, master 무쓰기 Excel·이미지 출력 |
| `settings` | `settings.html` | 운영 | 매핑·가격정책·열·보기·Cloud URL과 검증된 설정 백업·복원, 외부 소유 작업 owner routing |
| `master-lookup` | `Master.html` | 파일럿 | 상품 조회와 관리자 검토형 추가·수정 |
| `customer-master` | `customer-master/index.html` | 파일럿 | 거래처 조회·등록·수정·정보 보완·Excel 업서트·매핑·Snapshot·v17 읽기 전용 이전 |
| `item-manager` | `Item_manager.html` | 파일럿 | 상품 기초정보 조회·등록·수정 |
| `history-viewer` | `history_viewer.html` | 운영 | 불변 상품 변경이력 Snapshot·가격 추이 조회와 현재 화면 JSON/CSV 출력 |
| `core-engine` | `coreEngine.js` | 운영 공유 라이브러리 | 현행 저장·가격·이력·출력·Cloud·master 유틸리티 |
| `orderops` | `orderops/list.html` | 파일럿 | 출고·재고·구매계획과 검토형 출력 |
| `orderq-vnext` | `orderq/index.html` | 파일럿 | 주문 입력·수집·이행근거와 revision 동기화 |
| `cloud-sync` | `code.gs`, `company-profile.gs` | 운영 Server Transport | 현행 master·이력·설정·DataOps·Shipping·ORDER Q와 NEXUS 회사정보 API |

`ItemMaster.html`은 manifest와 공통 메뉴에 등록하지 않는 정적 호환 페이지다. `master-lookup`과 `Master.html`, `item-manager`와 `Item_manager.html` 등록은 그대로 유지한다.

`customer-master`의 쓰기는 앱 소유 Repository에 한정한다. 다른 앱은 `ONEAPP_CUSTOMER_MASTER_READ_ADAPTER`가 발행하는 `ONEAPP_CUSTOMER_SNAPSHOT_V1` Snapshot만 소비한다. SmartInput은 로컬 캐시와 실패 격리로 거래처관리 장애 중에도 기존 업무를 계속하고, ORDER Q는 소비자 전환 전의 기존 업무를 유지한다. 변경요청은 `ONEAPP_CUSTOMER_MASTER_CHANGE_REQUEST_ADAPTER`로만 접수하며 `appMeta.referenceChangeRequestsV1`에 additive 보존하고 자동 적용하지 않는다.

### 4.3 Master·ItemMaster·Item Manager 확정 기준

1. `Master.html`은 `master-lookup` 공식 주소, 공통 메뉴 연결과 운영 상품 저장계약을 유지하는 유일한 공식 상품관리 구현이다.
2. 격리 검증된 빈 DB 최초 등록과 단건 등록·수정만 `Master.html`의 공용 저장·revision·history 계약으로 승계한다.
3. `ItemMaster.html`은 중복 앱·DB 쓰기 없이 공식 주소를 안내하는 정적 호환 페이지로 유지한다.
4. 과거 `oneapp-itemmaster-isolated-v1`은 자동 삭제·덮어쓰기하지 않는다. 실제 데이터가 있으면 `Master.html`에서 비차단 안내, JSON 백업과 관리자 승인형 추가·갱신 검토만 제공한다.
5. `Item_manager.html`은 `item-manager` 공식 경로와 카탈로그 소싱·행사테마·BOM 등 현재 기능·저장계약을 유지한다.
6. manifest와 NEXUS·dashboard 공식 상품관리 연결은 계속 `Master.html`을 가리킨다.

---

## 5. 현재 Runtime 계약과 목표 경계

### 5.1 현재 Navigation과 NEXUS 공통 UI

MerchOps links to SmartParser, export center, settings, and history viewer using relative application URLs.

SmartParser, export center, settings, and history viewer provide a route back to MerchOps.

Changing a filename or moving a file therefore requires a repository-wide navigation review.

Production files must not be reorganized into folders without first updating and testing:

- every relative link;
- every application entry route;
- GitHub Pages deployment paths;
- navigation regression tests;
- external bookmarks or operational links where applicable.

현재 `nexus/common/nexus-ui.js`와 관련 정적 자산은 앱 이동·NEXUS 홈 이동·현재 앱 표시·테마와 비권위 앱 탭 노출만 제공한다. 사용자명·계정 유형·Session 상태는 업무 앱 공통헤더에 표시하지 않는다. 공통 UI는 `oneapp.nexus.ui.visibility.v1`의 `schemaVersion`, `configured`, `visibleAppIds`만 동기식으로 읽고 수정하지 않으며, 실행 중 manifest, 인증 서버, Gateway 또는 업무 저장소를 조회하지 않는다. 투영 부재·오류는 전체 탭 표시로 복구하고 공통 UI 로드 실패가 각 앱의 업무 스크립트 실행을 차단해서는 안 된다.

`nexus/index.html`과 `nexus/nexus.js`는 기본 로그인 홈 경계다. 로그인 전·후 모두 하단에 `원앱 | NEXUS 사내 업무 시스템`을 고정 표시하며, 이 문구는 서버 조회·Session Token·사용자 정보·revision을 사용하지 않는다. 로그인 성공 시 NEXUS 홈에서만 사용자명과 `MASTER` 또는 `위임 사용자` 구분을 표시한다. 서버가 제공한 `visibleAppsConfigured`와 검증된 12개 `visibleAppIds`를 식별정보 없이 `NEXUS_UI_VISIBILITY_V1`으로 같은 탭에 투영해 홈 카드와 공통헤더 탭에만 적용하며, 직접 URL과 앱 실행권한에는 사용하지 않는다. 유효기간이 남은 탭 Session은 홈을 즉시 표시하는 데 사용하며 서버 최신 상태는 백그라운드에서 확인한다. 같은 브라우저에서 이미 로그인된 NEXUS 홈 창이 살아 있으면 `/nexus/` 범위의 `session-bridge.js`가 메모리에 있는 동일 Session을 새 NEXUS 창에 전달한다. 페이지는 활성 Bridge 등록을 우선 사용하고 최초 활성화 지연은 제한 시간 안에서 기다리며, 실패한 준비 상태를 고정하지 않고 다음 호출에서 재시도한다. 새 창 Session 요청도 제한된 횟수만 재시도해 백그라운드 창의 늦은 응답을 수용한다. Bridge는 페이지 요청을 가로채거나 Token을 Cookie·`localStorage`·IndexedDB에 저장하지 않고, `/nexus/` 밖의 클라이언트 요청을 거부한다. 로그아웃·만료는 같은 Session을 사용하는 모든 NEXUS 창에 전파하며, 로그인된 NEXUS 창이 하나도 없고 Bridge 메모리도 종료된 경우에는 다시 로그인한다. 로그인 서버 장애가 업무 앱의 직접 진입·화면 표시·로컬 기본 작업으로 확산되어서는 안 된다. 앱별 권한, 연동 허용, 업무이력 Adapter와 Gateway 정책은 별도 확정 전 구현하지 않는다.

회사정보는 이 일반 원칙의 승인된 독립 경계다. `nexus/company-transport.js`는 회사관리 화면에서만 배포된 Gateway를 호출하며 홈·전역 `fetch`·공통헤더·업무 앱 부팅을 바꾸지 않는다. 홈은 회사정보 Snapshot을 저장하거나 읽지 않는다. 관리 쓰기는 변경된 필드만 보내고 `expectedRevision` 충돌 시 최신 서버 원본을 다시 읽는다. 사업자등록증 원본과 대표자 생년월일은 이 경계에서 수집·저장·로그하지 않는다.

#### 5.1.1 NEXUS 공통 UI/UX 단일 계약

이 절은 신규·기존 NEXUS 업무 앱의 공통 UI/UX 기준에 대한 단일 권위다. 과거 제안서, 복구 명세, 검증보고서와 특정 앱 화면은 변경 근거와 증거로 참고할 수 있지만 이 절과 충돌할 때 별도 기준으로 사용하지 않는다.

**공통 자산과 적용 경계**

- manifest 등록 앱과 새로 만드는 NEXUS 업무 앱은 `nexus/common/nexus-ui-theme-init.js`, `nexus/common/nexus-ui.css`, `nexus/common/nexus-ui-app-themes.css`, `nexus/common/nexus-ui.js`를 공통 UI 자산으로 소비한다.
- 테마 초기화는 본문 표시 전에 실행해 FOUC를 방지하고, 앱은 공통 자산 로드 실패와 관계없이 자체 Core와 허용된 로컬 기능을 계속 실행한다.
- 공통 자산은 헤더, 앱 이동, NEXUS 홈 이동, 테마와 공통 시각 토큰만 소유한다. 업무 데이터, 업무 저장소, 계산, 로딩, 동기화, 서버 확정과 앱 준비 상태는 소유하지 않는다.
- 앱은 업무 흐름에 필요한 화면 구성과 전용 컨트롤을 가질 수 있지만 공통헤더, 페이지 배경, 패널, 표, 입력, 포커스와 상태 표현은 공통 의미 토큰을 우선 소비한다. 앱별 하드코딩 스타일이 공통 토큰의 실제 계산값을 무효화하지 않아야 한다.

**공통 화면 계약**

| 항목 | 계약 |
|---|---|
| 브라우저 식별 | NEXUS 파비콘과 `업무명 - NEXUS` 제목 형식을 사용한다. |
| 앱 명칭 | 공통 정적 앱 목록의 한글 명칭을 헤더와 브라우저 제목의 단일 매핑으로 사용한다. |
| 데스크톱 헤더 | 높이 64px, 탭 그룹 높이 44px, 탭 96×38px, 간격 4px, 모서리 8px, 글자 13px/600, 전환 150ms를 유지한다. 헤더와 탭은 화면모드와 무관하게 기존 다크 스타일을 사용한다. |
| 모바일 헤더 | 높이 104px, 탭 96×44px와 최소 44px 터치 영역을 유지한다. 로고와 테마 스위치는 겹치지 않고 탭 이동은 가로 사용이 가능해야 한다. |
| 선택·포커스 | 선택 탭은 밝은 글자와 얇은 민트 하단선으로 구분하고 넓은 강조 배경을 사용하지 않는다. 키보드 포커스는 공통 포커스 토큰으로 명확히 표시한다. |
| 앱헤더 | `Master.html`의 56px 단일 행 `AppHeader`를 구조 기준으로 사용한다. 왼쪽은 앱 식별·한 줄 목적, 오른쪽은 상태와 해당 앱의 주요 작업을 배치하고 글로벌 앱 이동·NEXUS 로고·화면 모드를 중복하지 않는다. |
| 폭 계층 | 글로벌헤더와 앱헤더의 배경·구분선은 viewport 전체 폭을 사용한다. 섹션헤더, 업무 패널과 작업테이블은 정보 밀도와 집중도를 근거로 앱별 제한 폭·가로 스크롤을 사용할 수 있다. |
| 화면 모드 | `일반모드`와 `다크모드`만 제공한다. 화면 모드 선택은 공통헤더에서 수행하며 앱별 환경설정에 중복 컨트롤을 만들지 않는다. |
| 다크 화면 | `--nexus-ui-page-bg: #15181d`를 body와 빈 영역의 기준으로 사용하고 패널·표 머리글·표 행·입력을 저채도 의미 계층으로 분리한다. |
| 일반 화면 | 본문·패널·표·입력은 흰색 위주의 배색 대신 저채도 아이보리 종이 톤의 공통 Light 토큰을 사용하고 다크 전용 계산값을 남기지 않는다. 공통헤더는 다크 스타일을 유지한다. |
| 접근성 | 일반·다크 모두 일반 본문과 주요 상태 텍스트 대비를 WCAG 4.5:1 이상으로 유지하고 색상만으로 상태를 전달하지 않는다. |
| 출력 경계 | 인쇄와 Excel·ERP·이미지·카카오 등 업무 출력물의 승인된 밝은 배경과 기존 형식을 유지한다. 화면 테마가 출력 데이터나 출력 렌더링 계약을 바꾸지 않는다. |

테마 값의 단일 권위는 `nexus-ui-theme-init.js`가 제공하는 `ONEAPP_NEXUS_UI_THEME` 컨트롤러와 `oneapp.nexus.ui.theme.v1` 저장키다. 문서 루트의 `data-nexus-ui-theme="light|dark"`가 공통 UI 소비 기준이며 기존 `data-nexus-theme`는 호환 alias로만 유지한다. 변경 알림은 `nexus-ui:theme-change`를 사용한다. 테마 전환은 재조회·새로고침·전체 재렌더링 없이 적용하며 검색, 필터, 선택, 입력, 편집, 스크롤과 동기화 상태를 보존한다.

상태색은 정보·성공·주의·위험 의미를 유지하되 넓은 면적과 반복 행에서 고채도 장식을 사용하지 않는다. 전역 Tailwind 팔레트 교체, 광범위한 `!important`, 앱별 테마 컨트롤러와 독립 토큰 체계로 공통 계약을 우회하지 않는다. 선택자 우선순위 보완이 필요하면 영향을 받는 앱·요소에만 제한하고 실제 계산 스타일로 검증한다.

**검증과 예외**

- 신규 앱과 공통 UI 변경은 저장소 공통 UI 계약 검사와 함께 데스크톱·모바일 실제 브라우저에서 일반/다크를 검증한다.
- 최소 증거는 body·주요 패널·표·입력의 computed style, 일반모드 정확 복귀, 헤더 치수, 제목·파비콘, 로고·테마 스위치 비겹침, 가로 탭 사용성, 상태 보존, console error 0과 대표 스크린샷이다.
- 화면 검증은 업무 저장·동기화·POST 없이 수행하고 인쇄·내보내기의 밝은 출력 회귀와 공통 자산 실패 시 앱 독립 실행을 함께 확인한다.
- 업무 목적상 공통 계약과 다른 UI가 반드시 필요하면 사용자가 승인한 예외, 영향 요소, 접근성·반응형·출력 대안과 롤백을 앱 개발명세에 먼저 기록한다. 승인되지 않은 차이는 허용된 변형으로 간주하지 않는다.
- SmartInput 등 현재 화면이 이 계약을 충족하지 않는 경우 문서 기준을 낮추지 않는다. 해당 차이는 구현 격차로 기록하고 업무 코드 변경과 분리된 앱별 UI/UX 작업에서 수정·검증한다.
- `Master.html`은 앱헤더 구조 기준이다. 이 기준보다 먼저 구축된 `MerchOps.html`과 `DataOps.html`의 앱헤더는 기능을 보존한 채 같은 구조·전체 폭·공통 의미 토큰으로 전환하는 수정 대상이다. 각 앱의 System.IO, 섹션헤더와 작업테이블은 앱헤더와 구분한다.

### 5.2 현재 레거시 공유 브라우저 상태

The current applications share the browser database `MerchOpsDB` and a set of `localStorage` keys.

이 목록은 현재 호환성·마이그레이션 기준선이지 목표 공유 Repository가 아니다. 신규 앱과 신규 기능은 목록의 원시 저장소에 새 직접 쓰기를 추가하지 않는다. 기존 직접 writer를 제거하거나 소유권을 바꿀 때는 소유 앱 Adapter, 소비자 전환, 데이터 이전과 독립 롤백을 먼저 구현한다.

Important contracts include:

| Contract | Current key or resource | Main consumers |
|---|---|---|
| Product master Snapshot | `merchMaster_v870`, `MerchOpsDB` / `master_products`; `ONEAPP_PRODUCT_MASTER_READ_ADAPTER_V1` | `master-lookup` 소유. MerchOps·SmartParser·DataOps·ORDER Q·History Viewer·Export Center 등은 읽기 Snapshot으로 소비 |
| Product master reviewed command | `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1`, `MERCHOPS_REVIEWED_WORK_APPLY_V1`, `MERCHOPS_PRODUCT_REGISTRATION_V1` | MerchOps F7 일반/행사비교 완료행의 field patch와 관리자 명시 신규상품 등록만 expected Snapshot·history·rollback 계약으로 사용 |
| Product read Snapshot | `ONEAPP_PRODUCT_MASTER_READ_ADAPTER` / `ONEAPP_PRODUCT_SNAPSHOT_V1` | `master-lookup`이 제공하는 공식 읽기 경계. DataOps F6와 ORDER Q 수기입력이 소비하며 READY·EMPTY·ERROR를 구분 |
| Product change-request inbox | `MerchOpsDB` / `store.oneappProductReferenceChangeRequests_v1` | `master-lookup`만 수신·조회. SmartInput·SmartParser가 자동분석·후속검토용 idempotent `PENDING` 요청을 접수하며 기존 master·revision Store와 분리된 additive KV |
| SmartParser analysis result | `smartparser/analysis-result-contract.js`; `ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1` | `smart-parser` 소유의 순수·불변 로컬 결과. 원본 전체 master·문서·비밀값을 포함하거나 Repository를 쓰지 않음 |
| Customer change-request inbox | `oneapp-customermaster-v1` / `appMeta.referenceChangeRequestsV1` | `customer-master`만 수신·조회. 기존 customer Store·레코드와 분리된 additive KV |
| Master change notification | `merchMaster_sync_trigger` | SmartParser, DataOps와 MerchOps. MerchOps는 새 revision 대기를 표시하고 열린 작업표를 자동 덮어쓰지 않음 |
| Change history Snapshot | `merchHistory_v870`; `ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1` / `ONEAPP_CHANGE_HISTORY_SNAPSHOT_V1` | `master-lookup` 소유. History Viewer와 MerchOps는 불변 Snapshot을 소비하고 실제 append는 승인된 owner command 성공 단위에서만 수행 |
| Parser dictionary | `parserDict_v870` | SmartParser 쓰기 소유, MerchOps 읽기 소비. Settings는 schema 검증된 불투명 백업·복구 예외로만 보존 |
| Parser supplier exclusions | `smartParserExcludeDict_v3012`, compatibility backup `smartParserExcludeDict_backup_v3015` | SmartParser owns writes, search, restore, scoped deletion, and automatic exclusion on the next parse; these keys are preserved without migration |
| Stopped-product management | `ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1`; IndexedDB `MerchOpsDB` keys `merchStoppedProducts_v2`, `pending_shop_status`; local mirrors `merchStoppedProducts_v2`, `pendingShopStatus` | SmartParser의 명시적 STOP/RESUME/UPDATE_METADATA는 전용 Adapter 한 경계에서 원자 처리. MerchOps는 보호 목적으로 읽고 DataOps의 기존 post-close resume-only 경계는 유지 |
| Stopped-product notification | `merchStopManager_sync_trigger` | SmartParser publishes verified stop-management changes; compatible readers refresh their stopped-state view without rewriting the shared list |
| DataOps post-close sale-resume recovery | `dataops_inventory_master_resume_v1` | DataOps only; records pending or failed sale-resume codes with the already-finalized inventory snapshot revision so retry never repeats inventory closing |
| Margin and pricing rules | `merchMarginRules_v878` | Settings 쓰기 소유; MerchOps는 `ONEAPP_MERCHOPS_SETTINGS_READ_ADAPTER_V1`로 읽기만 수행 |
| Parser catalog warehouse map | `parserCatalogWarehouseMap_v1` (`{ [catalogName]: warehouseCodeString }`) | SmartParser 쓰기 소유. Settings는 UI로 의미를 변경하지 않고 schema 검증된 불투명 `config_only` 백업·복구 예외로만 보존 |
| Mapping configuration | `merchMappings_v870` | Settings 쓰기 소유; MerchOps read-only |
| Master links | `merchMasterLinks_v870` | Settings 쓰기 소유; MerchOps read-only |
| Shared cloud URL | `oneapp_cloud_sync_url_v1` | Settings가 편집·백업·복원을 소유. MerchOps는 읽기·owner routing만 수행 |
| Legacy cloud URL | `merchCloudUrl_v870` | Compatibility fallback only |
| Settings table-view configuration | `merchActiveTableTarget_v1`, `merchActiveTableViewId_v1`, `merchTableViewPresets_v1` | Settings 쓰기 소유; MerchOps read-only |
| MerchOps current-work view | `merchops_work_view_state_v1` / `MERCHOPS_WORK_VIEW_STATE_V1` | MerchOps만 현재 작업 선택을 additive 저장. Settings 양식을 대체하지 않음 |
| Settings config recovery | `ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1` / `ONEAPP_SETTINGS_CONFIG_BUNDLE_V1` | Settings 소유 allowlist만 쓰며 전체 검증, pre-image, rollback, 후검산과 Cloud unknown-field round-trip 보존을 강제 |
| MerchOps export draft | `MerchOpsDB/store.merch_export_draft`; optional `merch_export_draft_meta` | MerchOps가 기존 draft shape를 소유하고 Export Center가 읽기·검토·출력만 수행. sidecar는 draft hash와 Product Snapshot version만 담음 |
| Shipping local recovery | IndexedDB `ONEAPPShippingManagementDB` / `workspaces`; `oneapp.shipping.recovery.pointer.v1` and `oneapp.shipping.recovery.meta.v1` | OrderOps only; IndexedDB stores the analysis workspace and inputs, while localStorage stores only the recovery pointer and metadata |
| Shipping substitution history | `shipping-workspace/v2.substitutionHistory`; `shipping-substitution-history/v1` | OrderOps only; append-only substitute/undo events preserve requested and actual products, order row, customer, quantity, unit price, actor and time in local recovery and explicit Cloud plan revisions |
| Shipping table widths | `oneapp.shipping.table-widths.v1` | OrderOps local UI preference only; tab-specific widths are excluded from workspace, IndexedDB recovery, cloud plans, and purchase uploads |
| OrderOps Excel aliases | `oneapp.orderops.excel-mappings.v1` | OrderOps local parser preference only; administrator filename, sheet, and column aliases are excluded from workspace recovery and cloud plans |
| OrderOps purchase-name history | `oneapp.orderops.purchase-history.v1` | OrderOps local input convenience only; up to 30 recent nonblank purchase-place names are excluded from workspace recovery and cloud plans |
| OrderOps order-view presets | `oneapp.orderops.order-view-presets.v1` | ORDER Q per-view local display preferences only; named search/filter/sort conditions, visible columns, column order, and saved widths may be captured, and one preset per view may be marked as the access-time default. Presets remain excluded from workspace recovery and cloud plans |
| ORDER Q vNext local ledger | IndexedDB `oneapp-orderq-vnext` v4 | ORDER Q vNext only; operational orders, historical source batches, sales/purchase/ledger/inventory facts, fulfillment links, parser evidence, and sync queue |
| Voucher activity Snapshot | `ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER_V1` / `ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1` | ORDER Q owns order, purchase, and sale documents. SmartInput owns estimate records and exposes them through its estimate Read Adapter. Related-voucher import copies a read-only source snapshot into the target draft; `EMPTY` and `ERROR` remain distinct and no path modifies the source voucher. |
| ORDER Q official voucher command | `ONEAPP_ORDERQ_OFFICIAL_COMMAND_ADAPTER_V1`; `ONEAPP_ORDERQ_OFFICIAL_COMMAND_GATEWAY_V1`; `VOUCHER_CORE_V1` | SmartInput purchase/sale Finalize Services use the ORDER Q command Adapter, which delegates owner operations through the OfficialCommandGateway to `official-voucher-repository.js`. ORDER Q owns documents, lines, commands, Revisions, inventory/pending effects, matched-customer base payable/receivable effects and the official local queue. Cloud replay remains a recorded direct-Repository follow-up path. |
| ORDER Q unresolved review Read Model | `ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_ADAPTER_V1`; `ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_MODEL_V1`; `ONEAPP_ORDERQ_UNRESOLVED_REMATCH_IMPACT_PREVIEW_V1` | ORDER Q alone reads its existing DB v7 stores and returns a company-scoped, deterministic, read-only review result. Official inventory remains `미반영` with `officialQuantity=null`, pending signed quantity stays separate, missing links remain explicit review issues, candidate rows never auto-confirm, and the pure preview reuses the Phase 5 checkpoint classifier without writing. After UI Gate U1 A approval, `orderops` consumes only the Adapter in its existing result-area state; removing that consumer leaves the owner data and contract intact. |
| ORDER Q official voucher sync | `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1` | Company-partitioned background transport for immutable official commands and product resolutions. Local finalize remains authoritative; Cloud activation and deployment acceptance are separate work. |
| ORDER Q vNext access token | `oneapp_orderq_access_token_v1` | Local cloud request credential only; excluded from IndexedDB records, imports, recovery payloads, and sync entities |
| ORDER Q manual-entry defaults | `oneapp.orderq.manual-defaults.v1` | ORDER Q vNext only; restores the last shipment warehouse and transaction type for the next new manual order in the same browser |

A storage-key rename is a schema migration.

It must:

1. provide a compatibility read path;
2. write the new key;
3. preserve existing user data;
4. identify all consumers;
5. include migration validation;
6. include a rollback plan;
7. confirm production behavior after deployment.

### 5.3 현재 Server Transport 계약

`code.gs` exposes the following current API actions:

| Method | Action | Responsibility |
|---|---|---|
| POST | `initSync` | Clear and initialize master and history synchronization data |
| POST | `chunk_master` | Append a chunk of product-master records |
| POST | `chunk_history` | Append a chunk of history records |
| POST | `config` | Save shared configuration |
| POST | `dataops_snapshot_commit` | Validate and atomically finalize one DataOps FULL inventory snapshot |
| POST | `dataops_snapshot_get` | Return the latest finalized DataOps FULL inventory snapshot |
| POST | `shipping_plan_save` | Stage, verify, append an immutable Shipping purchase-plan payload, then publish its index row |
| POST | `shipping_plan_list` | List only indexed Shipping purchase-plan revisions, newest first |
| POST | `shipping_plan_get` | Verify and return an indexed Shipping purchase-plan revision |
| POST | `orderq_sync_push` | Token-protected incremental ORDER Q entity push with revision conflict, source-message duplicate prevention, and recoverable order-bundle writes |
| POST | `orderq_sync_pull` | Token-protected incremental ORDER Q entity pull after the device cursor |
| POST | `orderq_order_head` | Token-protected latest ORDER Q order bundle and revision lookup |
| POST | `nexus_gateway_company_profile_get` | Foundation Gateway binding으로 서버 권위 회사정보와 회계기간 조회 |
| POST | `nexus_gateway_company_profile_write` | 관리자·revision 검사를 거쳐 제공된 회사정보 필드만 원자적으로 갱신하고 감사 기록 |
| POST | `nexus_gateway_company_accounting_period_get` | Foundation Gateway binding으로 회계기간 조회 |
| POST | `nexus_gateway_company_accounting_period_write` | 관리자·profile revision·기간 revision 검사를 거쳐 회계기간 갱신 |
| POST | `nexus_gateway_company_certificate_extract` | 영구 원본 저장 없이 허용 필드만 OCR 정규화 후보로 반환 |
| POST | `nexus_gateway_company_backup_create` | 현재 회사정보와 회계기간의 명시적 서버 백업 생성 |
| POST | `nexus_gateway_company_migrate_oneapp` | 작업 ID ledger로 보호되는 원앱 회사정보 1회 멱등 반영 |
| GET | `full` or omitted | Return master, history, and configuration |
| GET | `master_only` | Return product master and summary |
| GET | `config_only` | Return configuration only |

The DataOps snapshot contract is `ONEAPP_DATAOPS_SNAPSHOT_V1`. Its canonical row order is the existing whole-stock ten columns (`단위`, `품목코드`, `품명`, `규격`, `재고`, `기록`, `거래`, `구매가`, `기본`, `적요`) followed by `행사가`. It is a FULL snapshot; consumers must preserve every source LOT row and must not mutate units or treat it as a partial update. MerchOps inventory F8 is an output-only projection of that preserved snapshot: it emits one row per product code, sums stock quantity only, keeps the existing latest representative-LOT price/cost basis, never creates automatic subdivision inventory rows, and blocks output when missing codes, output duplicates, non-zero stock outside the source, total-stock mismatch, or shopping-mall/ERP code-order mismatch is detected.

`dataops_snapshot_commit` writes the inactive `DataOpsSnapshot_A` or `DataOpsSnapshot_B` sheet, verifies schema, SHA-256, row count, cell count, and same-code LOT promotion consistency, then switches the `ONEAPP_DATAOPS_CURRENT_SLOT` Script Property under `LockService`. A failed staging write leaves the previous current slot unchanged. The revision is derived by the server from basis date and canonical hash, so rereading or recommitting the same finalized snapshot returns the same identity.

Both DataOps snapshot actions keep their existing POST action names and snapshot data response shape. `dataops_snapshot_commit` and `dataops_snapshot_get` use the configured shared cloud URL without requesting, storing, sending, or validating an operator token. Existing requests that include a legacy token remain compatible and the server ignores that field. Existing master, history, configuration, and all other API actions, sheets, payloads, and response contracts remain unchanged.

The Shipping cloud contract is `ONEAPP_SHIPPING_PURCHASE_PLAN_V1`, and its embedded analysis contract is `shipping-workspace/v2`. `shipping_plan_save` writes `ShippingPlanStaging`, verifies SHA-256 and declared row/cell counts, appends the immutable payload to `ShippingPlanHistory`, rereads it, and only then appends `ShippingPlanIndex`. The index is the sole visibility boundary: an append that is not indexed is an orphan and must never be returned by list/get, while an index failure leaves every previously finalized revision and the previous latest revision unchanged. Revisions are not automatically deleted.

All Shipping plan actions use POST bodies and the separate `ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN`. They do not read or write DataOps A/B snapshots, `ONEAPP_DATAOPS_CURRENT_SLOT`, `MasterDB`, `HistoryLogs`, or `AppConfig`. Local autosave is not cloud transfer; another computer can retrieve only revisions saved through the explicit cloud-save action.

ORDER Q vNext actions use `ONEAPP_ORDERQ_ACCESS_TOKEN`, with the existing Shipping token as a compatibility fallback when a separate ORDER Q token has not been configured. Order and order-item writes are staged in `ORDER_TXN_LOG`, verified as a bundle, and restored to the previous bundle after a partial failure. Historical import facts are synchronized in shared purpose sheets; customer-specific sheets are prohibited.

NEXUS 회사정보 상류 action은 활성 Gateway가 전달하는 `NEXUS_AUTH_V2` 요청과 기존 `ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON` credential·scope를 함께 검증한다. 읽기 라우트도 legacy 또는 direct 요청을 허용하지 않는다. 관리 쓰기는 `OWNER_MASTER`, `admin.company`, 앱 컨텍스트와 `expectedRevision`을 다시 확인하며, 서버 배포만으로 migration이나 기존 레코드 변경을 실행하지 않는다.

Changing any action name, payload shape, response shape, authentication rule, or field normalization requires coordinated updates to:

- `code.gs`;
- `coreEngine.js`;
- every calling application;
- automated contract checks;
- backup and restore validation;
- rollback procedures.

서버 호출은 현재 API 계약을 보존하되 모든 화면의 공통 선행조건으로 사용하지 않는다. 읽기 실패는 `EMPTY`와 구분된 오류·지연 상태로 반환하며, 마지막 정상 로컬 Snapshot이 있으면 이를 유지한다. 쓰기·동기화·최종 확정은 서버 권한과 revision 검사를 유지한다.

### 5.4 현재 Shared Engine과 목표 Runtime 경계

`coreEngine.js` defines the intended ONEAPP shared modules:

- `ONEAPP.STORAGE`
- `ONEAPP.PRICING`
- `ONEAPP.HISTORY`
- `ONEAPP.EXPORT`
- `ONEAPP.CLOUD`
- `ONEAPP.MASTER`
- `ONEAPP.ERRORS`

As of this review, `settings.html`, `SmartParser.html`, `MerchOps.html`, `Master.html`, `Item_manager.html`, and `DataOps.html` explicitly load `coreEngine.js`.

`ItemMaster.html`은 앱 Runtime, `coreEngine.js`와 IndexedDB 쓰기를 포함하지 않는 정적 호환 안내다. 과거 격리 DB의 읽기·백업·선택 검토 경계는 공식 `Master.html`이 담당하며 원본을 변경하지 않는다.

The `merchMarginRules_v878` normalize/select/calculate path is owned by `ONEAPP.PRICING`. SmartParser supplies the catalog warehouse only as calculation context and the final product `단위`; neither SmartParser nor MerchOps infers that unit from product name or specification. Exact non-wildcard warehouse-and-unit matches use the first saved rule, and every other case uses the single `*/*` default rule. Partial wildcard rules are not selected.

`parserCatalogWarehouseMap_v1` trims catalog names and warehouse-code strings without numeric conversion, so values such as `01` retain their leading zero and blank values remain valid. SmartParser alone edits this value. Settings carries it as an opaque, schema-validated recovery item inside the existing cloud `settingsKeys`; the `code.gs` action and payload schema are unchanged.

The legacy `parserListMarginRules_v1` value is retained for data compatibility but is not read, normalized, migrated, deleted, or rewritten by SmartParser, settings, MerchOps, or the shared pricing engine.

SmartParser page code calls only `ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1` for explicit stopped-product commands. That Adapter alone uses the existing atomic storage primitive so product sale status, `merchStoppedProducts_v2`, `pending_shop_status`, actual history, local compatibility mirrors, and synchronization notifications form one verified success unit. A history, mirror, notification, or linked-store failure restores the previous state without overwriting a newer successful revision. Existing `pendingAction` records and keys are preserved.

MerchOps, DataOps, and SmartParser still contain other overlapping or locally implemented logic.

Treat `coreEngine.js` as the intended shared contract, but do not remove duplicated implementations until compatibility tests prove that each application produces the same output.

A shared-engine consolidation must not be performed as incidental refactoring during an unrelated feature or bug fix.

`coreEngine.js`의 현재 사용은 즉시 제거하지 않는다. 다만 목표 구조에서 공통 라이브러리는 순수 계산·검증·직렬화처럼 앱을 통제하지 않는 기능만 제공한다. 공통 Runtime이 앱 Repository를 열거나 초기화하고, 앱 준비 여부를 결정하고, 서버 상태를 이유로 전체 앱을 차단하는 기능은 추가하지 않는다.

### 5.5 클라이언트 안전과 장애 격리 기준

Settings no longer exposes master Excel apply, master backup restore, tag deletion, sale activation, or stop/status editing. Those actions route to `Master.html` or `SmartParser.html`. `ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1` applies the remaining configuration safety boundary:

- accept only Settings-owned allowlist keys plus the two explicit SmartParser opaque recovery keys;
- validate the entire JSON or Cloud payload before the first write;
- capture every target key pre-image and restore it if any write or post-read verification fails;
- re-read every applied value after write and every restored pre-image after rollback;
- exclude product master, history, pending, stop and product-status live data;
- read the existing Cloud `AppConfig` before upload and preserve all unknown external fields, otherwise stop with an actionable error;
- avoid seeding absent keys from computed defaults on page mount.

추가 장애 격리 기준은 다음과 같다.

- Adapter 응답이 늦거나 실패해도 앱 셸과 로컬 기본 기능은 먼저 사용 가능해야 한다.
- 외부 데이터 상태는 `READY`, `EMPTY`, `STALE`, `ERROR` 등 서로 구분 가능한 상태로 다루며 오류를 0건으로 정규화하지 않는다.
- 외부 최신 revision은 활성 작업본과 분리해 보관하고, 사용자 또는 승인된 앱 정책 없이 자동 적용하지 않는다.
- 서버 최종 확정이 실패하면 로컬 작업본, 입력값과 재시도 근거를 보존한다.
- 차단은 저장 대상 손상, 필수 식별자 충돌, revision 충돌 또는 원자성 보장 실패처럼 실제 무결성 위험이 있는 작업 범위에 한정한다.

### 5.6 Read Adapter와 Integration Adapter 계약

Read Adapter는 소유 Repository가 제공하는 읽기 전용 경계다.

- Snapshot에는 `schemaVersion`, 소유 앱 ID, `revision` 또는 동등한 불변 식별자를 둔다.
- 소비 앱은 Snapshot을 자기 작업본에 복사할 수 있지만 소유 Repository를 직접 수정하지 않는다.
- 소비 앱의 캐시는 원본 권위가 아니며 소유 앱의 write 규칙을 우회하지 않는다.
- Adapter가 제공하지 않는 필드를 원시 Store에서 임의로 읽어 계약을 확장하지 않는다.

Integration Adapter는 다른 앱으로 조회·명령·결과를 전달하는 경계다.

- 입력·출력 schema, 실패 상태, 재시도, idempotency와 권한을 명시한다.
- 대상 앱이 없거나 실패하면 관련 연동만 보류하고 호출 앱의 다른 작업을 유지한다.
- 쓰기 요청은 소유 앱 또는 Server Transport가 다시 검증한다.
- Adapter 내부 구현과 대상 저장소 위치는 소비 앱 계약이 아니다.

#### 5.6.1 상품·거래처 기준정보 확정 계약

- 상품: `ONEAPP_PRODUCT_MASTER_READ_ADAPTER` v`ONEAPP_PRODUCT_READ_ADAPTER_V1`가 `ONEAPP_PRODUCT_SNAPSHOT_V1`을 발행한다. `master_products` record Store, `store.merchMaster_v870`, 호환 localStorage 순으로 읽고 record Store를 우선한다. `merchMaster_revision_v870`이 없으면 canonical SHA-256을 동등한 불변 식별자로 사용한다.
- 거래처: 기존 `ONEAPP_CUSTOMER_MASTER_READ_ADAPTER` v`ONEAPP_CUSTOMER_READ_ADAPTER_V1`와 `ONEAPP_CUSTOMER_SNAPSHOT_V1` 필드를 유지한다. canonical 고객만 발행하고 alias·source link를 canonical ID로 연결한다.
- 두 Snapshot은 `status=READY|EMPTY`를 포함하고 `getSnapshotResult()`가 `ERROR`와 형식화된 재시도 정보를 제공한다. 기존 `getSnapshot()`은 오류 시 reject하며 정상 0건으로 변환하지 않는다.
- Snapshot envelope, `data`, 배열과 행은 깊은 불변 객체다. 검색 helper는 전달받은 상품 Snapshot만 검색하며 Repository를 다시 열거나 수정하지 않는다.
- 변경요청 schema와 validator는 `reference-data/change-request-contract.js`의 `ONEAPP_REFERENCE_CHANGE_REQUEST_V1`이다. domain-owner, base revision, 중복 field, 민감정보, ISO-8601과 필수값을 검증한다.
- 상품 수신 경계는 `ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER`, 거래처 수신 경계는 `ONEAPP_CUSTOMER_MASTER_CHANGE_REQUEST_ADAPTER`다. 같은 idempotency key·같은 payload는 `DUPLICATE`, 다른 payload는 `CONFLICT`, 신규는 `PENDING`이며 owner 원본에 자동 적용하지 않는다.
- Inbox migration은 기존 DB version과 Store 목록을 바꾸지 않는다. 상품은 `MerchOpsDB/store.oneappProductReferenceChangeRequests_v1`, 거래처는 `oneapp-customermaster-v1/appMeta.referenceChangeRequestsV1` 한 key만 추가한다. rollback은 이 key를 삭제하지 않으며 구버전은 알 수 없는 key를 무시한다.
- PR #440의 계약 도입에는 소비자 일괄 전환, SmartInput UI 연결, ORDER Q 전환, 기존 레거시 writer 제거와 Server Transport 추가가 포함되지 않았다. 후속 `NEXUS-SI-REFDATA-UX-20260830-01`은 SmartInput UI 연결만 수행하며 나머지 제외 범위를 유지한다.

#### 5.6.2 SmartInput Core MVP 계약

- SmartInput DB v5는 기존 Store를 유지하고 `fieldDefinitionsV2`, `companyVoucherFieldsV1`, `referenceGenerationsV1`, `referenceEntitiesV1`, `inputTemplatesV2`, `mappingSessionsV2`, `draftVouchersV2`를 additive로 추가한다. v1 양식은 보존하지만 회사·대상 전표·정확한 헤더 위치 서명을 갖춘 v2 양식만 자동 적용한다.
- 전표 수량과 거래단가는 `voucher.{estimate|order|purchase|sale}.line.{quantity|unitPrice}`로 분리한다. 화면과 Excel 매핑 후보는 회사·전표별 사용 설정 하나를 함께 사용하며 전체 등록부와 `REVIEW_REQUIRED` 필드는 기본 화면에 노출하지 않는다.
- 기준정보 전체 새로고침은 상품·거래처·창고·담당자·프로젝트·필드 정의를 하나의 불변 generation으로 staging하고 전부 검증된 뒤에만 활성 포인터를 교체한다. 부분 실패는 기존 활성 세대와 현재 검색어·입력 작업본을 유지한다.
- Excel V2는 셀 표시값, 원시값, 수식, 숫자 형식과 위치를 보존한다. 사용자가 수정하거나 선택행 단가 적용을 실행하기 전에는 표시값을 계산값으로 덮어쓰지 않는다. 헤더 개수·문자열·순서가 하나라도 다르면 신규 양식으로 보고 모든 열을 다시 검수한다.
- 관련 전표는 견적·주문·구매·판매 사이의 수량·단가 의미를 대상 전표 fieldId로 변환해 작업본에 복사하고 원본 voucher/line/revision 증거를 보존한다. 거래처·창고가 다르면 확인 전 자동 결합하지 않으며 원본 전표 Store는 쓰지 않는다.
- ORDER Q 롤백 기준 DB는 `oneapp-orderq-pre-m1-v6` v7을 유지한다. 기존 공식전표·Draft·테스트자료를 V2로 변환하거나 호환 읽기하는 V1 migration은 만들지 않고, 기존 Store·레코드를 삭제·초기화하지 않는 additive V2로 진행한다.
- V2 소유권 계약에서 ORDER Q가 `OfficialCommandGateway`, `OfficialVoucherRepository`와 공식 구매·판매 문서·행, 명령, Revision, 재고/미매칭, 실사 checkpoint, 기본 채권·채무와 공식 local sync queue를 소유한다. SmartInput은 작업본과 입력을 소유하는 command Adapter 소비자이며 ORDER Q IndexedDB나 Repository를 직접 쓰지 않는다. 단계 2~5는 `SmartInput UI → PurchaseFinalizeService` 또는 `SaleFinalizeService → ORDER Q command Adapter → OfficialCommandGateway → OfficialVoucherRepository` 경계와 V2 필수검사·불변 Snapshot·ID·정확매칭 재고/미매칭/기본 원장 및 행별 실사 충돌 판단을 구현했다. 단계 7A의 owner-only 수정·취소도 같은 경계만 사용하고, 변경·추가되는 정확매칭 상품과 변경 거래처는 현재 Product/Customer owner Snapshot으로 다시 검증한다. 확정 당시 상품·거래처 identity와 Snapshot이 그대로면 현재 마스터 삭제만으로 거부하지 않는다. Cloud 운영 활성화와 제품 수정·취소 UI는 완료 범위가 아니다.
- 단계 6A 미매칭 검수는 ORDER Q의 `unresolved-review-read-adapter.js → unresolved-review-repository.js` 경계에서만 기존 DB v7을 읽는다. 회사 범위는 필수이고 `READY|EMPTY|ERROR`를 구분한다. Read Model은 동일 unresolved ID의 모든 전표·행·Revision 링크를 중복 없이 집계하되 같은 pending-effect ID의 상충 증거를 필드별 issue로 남기고 `REVIEW_REQUIRED`로 보존한다. 다른 회사 point-get 대상은 원문 payload를 모두 폐기하고 회사 불일치 issue만 노출한다. 현재 Product Snapshot의 정확 코드·이름 후보는 모두 `automaticConfirmation=false`이고, 영향 미리보기는 단계 5의 `evaluateStocktakeCheckpointConflictV2()`를 재사용해 `APPLY_READY|DECISION_REQUIRED|REVIEW_REQUIRED`만 계산한다. 단계 6B 제품 표시는 승인된 A안대로 `orderops` 기존 결과 영역이 이 Adapter만 소비하며, DB migration, Store 추가, 재매칭 실행, 공식재고·기준정보 쓰기는 포함하지 않는다.
- 단계 7A는 초기 POST의 `businessSnapshot`과 7A 전체 after Snapshot 형식을 구분해 Head의 모든 저장 업무·identity·연결 필드를 현재 projection과 대사한다. `status`와 `businessStatus`는 둘 다 `CONFIRMED`여야 하며 모순을 허용하지 않는다. 현재 유효 movement는 원 document/line/Revision에서 재계산한 상품·코드·창고·일자·수량·factor·command·Revision·effect role/status와 정상·실사흡수·late adjustment·6C 재매칭 lineage를 모두 검증한 뒤에만 반전 대상으로 사용한다. pending review link가 닫힐 때 최상위 unresolved 상태를 활성 link에서 결정적으로 다시 계산하고, 활성 link가 없으면 감사 link를 보존한 채 6B 목록에서 제외한다. 이미 `MATCHED`인 unresolved identity는 새 pending으로 되돌리지 않고 stale 입력으로 거부한다.
- 사용자가 입력·조회하는 상품 식별자는 ERP와 같은 회사 범위 문자열 `productCode`이며 선행 `0`을 보존한다. 기존 `productId`는 Product Snapshot으로 해석하는 비노출 호환 기술키로만 유지하고, 현행 재고·실사·재매칭·sync 저장키에서 제거하거나 새 사용자 코드로 표시하지 않는다.
- 공식 finalize는 하나의 IndexedDB transaction에서 문서·행, 명령 영수증, Revision, 정확매칭 재고 이동 또는 미매칭 대기·검수 레코드, 정확매칭 거래처의 기본 채권·채무 효과와 공식 local `syncQueue`를 멱등 저장한다. V2는 회사 Customer Snapshot의 거래처코드가 정확매칭될 때만 판매채권·구매채무 기본효과를 만들고, 미입력·미매칭이면 전표·재고 처리는 계속하되 효과 미생성 사유를 Revision에 보존한다. V1의 기존 필수조건과 효과는 변경하지 않는다.
- 공식 명령과 미매칭 상품 해결은 기존 주문 cursor와 분리된 `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1`로만 백그라운드 전송한다. 서버는 `companyId`별 전표 head와 Pull cursor를 분리하고 command ID 불변성, 전표 expected Revision, 미매칭 상품 최초 매칭을 검사한다. 충돌은 로컬본과 서버본을 보존하며 자동 병합하지 않는다. 기존 `WAITING_SERVER_CONTRACT` 행은 새 계약이 배포된 뒤 그대로 재사용하고, 서버 미배포·오류 시 상태를 유지한다. Cloud Push/Pull 활성화와 서버 배포는 V2 전표·재고 단계의 완료조건이 아니다.
- 미매칭 상품은 회사·코드 또는 품명·규격·단위에서 안정적인 시스템 ID를 얻고, 전표와 정확매칭 거래처의 기본 채권·채무는 보존하되 재고는 대기한다. 현행 `inventory-rematch-core.js`의 checkpoint 이전 자동 비소급은 V2 목표와 다른 기준선이다. V2에서는 checkpoint 이전 또는 선후 시각을 확인할 수 없는 같은 날 효과를 자동 적용하거나 폐기하지 않고, 사용자가 `실사수량에 포함됨`을 선택하면 현재고를 변경하지 않으며 `실사수량에 포함되지 않음`을 선택하면 원 실사기록을 보존한 연결 소급조정을 생성하고, 취소하면 공식자료를 저장하지 않는다.
- 마감·세금계산서·상계·별도 계정조정, 공식 운영 활성화와 Cloud Push/Pull은 이 계약 정합성 작업과 후속 전표·재고 구현 범위에서 제외한다. 구매와 판매는 각각 전표·재고·기본 채권채무 transaction과 feature gate·Rollback을 통과한 뒤 별도 Pilot 후보로 판정한다.

### 5.7 활성 작업본 보호와 독립 배포

- 전표·분석표·가공표를 열 때 사용한 상품·거래처 정보는 작업본 Snapshot으로 보존한다.
- 마스터 최신화 알림은 기존 작업본을 자동 덮어쓰지 않는다. 새 작업 또는 관리자가 선택한 재적용 시점에만 반영한다.
- 각 앱은 자기 정적 자산, Repository migration, Adapter와 Server Transport 변경 범위를 구분해 배포한다.
- 공통 UI와 Adapter 변경은 소비 앱의 fallback 검증 없이 필수 의존성으로 전환하지 않는다.
- 롤백은 해당 앱 배포와 Adapter 계약을 이전 호환 버전으로 되돌릴 수 있어야 하며, 다른 앱의 정상 데이터나 확정 기록을 삭제하지 않는다.

---

## 6. 현재 운영 업무 흐름(전환 기준선)

이 절은 현행 동작의 호환성과 회귀검증을 위한 기준선이다. 여기 기록된 직접 공유 저장소 쓰기는 목표 구조의 승인된 방식이 아니며, 별도 소유권 전환 작업 전까지 유지되는 현재 동작을 뜻한다.

### 6.1 External information to shopping-mall update

1. SmartParser reads and normalizes an external document.
2. SmartParser matches against an explicit immutable Product Snapshot and keeps that identity for the open work.
3. The operator reviews the matched product, field proposals, price evidence, issues and stop recommendations in `ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1`.
4. F7 submits only reviewed before/proposed fields to the Product owner request Adapter as CREATE or UPDATE `PENDING`; it does not write product master, revision, confirmed history, stop state or notification.
5. Zero price or sold-out analysis remains an issue and stop recommendation. It never invokes an immediate stop command automatically.
6. Owner Adapter failure or partial batch failure preserves the immutable result and unsubmitted selections with row-level status.
7. A currently open MerchOps worktable and SmartParser analysis remain bound to their starting Product Snapshot; a newer notification marks stale state without automatic overwrite.
8. MerchOps information Excel import/export remains available, but import changes stay in the worktable until the operator invokes F7 reviewed-patch apply.

### 6.2 Supplier collision and stopped-product management

1. SmartParser removes saved supplier-exclusion entries before matching, without deleting or changing the internal product master.
2. Existing multiple-master candidates and multiple supplier rows that resolve to the same normalized applied code are shown in the duplicate tab and receive `_apply=false`.
3. No duplicate group is automatically merged, overwritten, or reduced to a representative row.
4. The operator resolves a duplicate through search and manual relinking, a reviewed new ERP code, connection cancellation, or supplier exclusion.
5. PENDING request submission is blocked while any applied-code duplicate remains, and the duplicate code, count, and duplicate-tab resolution path are shown.
6. SmartParser owns individual, selected, and all-product stop/resume management, including reason and memo updates.
7. Stop/resume/metadata commands pass only through the versioned SmartParser Adapter and write the allowed master sale state, stopped-product list, existing shop-status queue, actual history before/after, route, timestamp, mirrors and synchronization notifications as one verified unit.
8. MerchOps does not expose the stopped-product management button or panel and does not merge shared stop/resume `pendingAction` records into F7; it retains normalized compatibility reads and stopped-state worktable protection.
9. The existing exclusion, stopped-product, pending-status, history, and notification keys remain unchanged.

### 6.3 Inventory and performance insight

1. DataOps imports purchase, sales, inventory, and stock-ledger information.
2. Product codes and master information are matched using shared mappings.
3. Cost, inventory, and trend results are calculated.
4. MerchOps uses those results as review evidence.
5. DataOps inventory files do not become owners of promotion-theme data.
6. Approved changes are exported and recorded in history where the owning workflow requires it.
7. DataOps file absence, parsing failure, and legitimate empty input must remain distinguishable conditions.
8. DataOps calculations must preserve source quantities unless an explicitly approved business rule changes them.
9. During inventory counting, F6 reads the confirmed local master snapshot without cloud access and opens at most one search row below the selected work row.
10. An out-of-list product uses zero book, inbound, outbound, and system balance; the operator-entered actual quantity is the variance, and an actual quantity of zero is excluded from the inventory list and closing scope.
11. A stopped product with a positive counted quantity becomes a sale-resume target only after the inventory snapshot finalizes successfully.
12. Inventory finalization and sale resume are separate recovery boundaries. A resume failure preserves the finalized snapshot and writes `dataops_inventory_master_resume_v1` so resume can be retried idempotently without another closing.

### 6.4 Configuration and recovery

1. Settings manages shared mappings, pricing rules, columns, views, and cloud URL.
2. MerchOps consumes these values through `ONEAPP_MERCHOPS_SETTINGS_READ_ADAPTER_V1`; it does not seed, persist, reset, restore, or publish `config_sync_trigger` for Settings-owned values.
3. Configuration can be backed up to or restored from `code.gs` only through the owning Settings workflow; MerchOps has no full backup/restore action.
4. Data restoration must preserve:
   - the existing product master;
   - history;
   - compatibility keys;
   - application-readable data shapes.
5. An explicit migration review is required before compatibility data is removed.
6. Backup success must not be assumed from request completion alone.
7. Restored data must be re-read and checked for expected counts and structure.
8. Settings backup/restore excludes product master, history, pending, stop and product-status live data. `parserDict_v870` and `parserCatalogWarehouseMap_v1` remain opaque SmartParser recovery exceptions only.
9. Cloud upload first reads the current config and round-trips unknown external fields. If the current pre-image cannot be represented safely, upload stops without writing.

### 6.5 History·Settings·Export owner boundaries

1. History Viewer obtains local history only through `ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1`. Missing key, valid empty data, parse/read failure and ready data remain `NOT_AVAILABLE`, `EMPTY`, `ERROR`, `READY` respectively.
2. Cloud history stays in a separate memory Snapshot. De-duplication, filtering, JSON and CSV export never write `merchHistory_v870`; export uses the exact current sorted and filtered view.
3. Settings owns only the manifest allowlist. Product master/backup/tag actions route to `Master.html`; parser dictionary/catalog map editing and stop/resume route to `SmartParser.html`.
4. Export Center reads `merch_export_draft` before Product Snapshot so Snapshot failure cannot discard the draft. READY, EMPTY, ERROR and STALE are displayed as distinct actionable states.
5. MerchOps preserves the existing draft array shape and stores optional `ONEAPP_MERCH_EXPORT_DRAFT_META_V1` in a sidecar key. Exact revision comparison uses matching draft fingerprint metadata; legacy drafts use baseline-content comparison.
6. Export Center F9 and the visible Excel button call the same output-only handler. Excel/image output may write only the user file or the existing temporary image payload, never product master, history, revision or sync triggers.

### 6.6 MerchOps reviewed work and explicit new-product registration

1. App boot reads `ONEAPP_PRODUCT_SNAPSHOT_V1` with `READY`, `EMPTY`, or `ERROR`; it performs no startup migration or owner-store creation.
2. Ordinary Excel load, category/catalog staging, F8, F9, cloud routing, and cleanup routing do not write the product master.
3. F7 normal work and F7 promotion comparison build field-level patches against the immutable base Snapshot and call `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1`.
4. `판매여부` is accepted only when the patch history proves the explicit `입고가없음` F7 action; general file/manual sale changes remain outside this command.
5. 엑셀에서 발견한 미등록 상품은 사용자가 등록 대상을 명시적으로 선택·확인한 경우에만 `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1`의 `MERCHOPS_PRODUCT_REGISTRATION_V1` 명령으로 실제 등록한다. MerchOps page는 raw Store를 쓰지 않으며 owner adapter가 expected Snapshot revision/id/hash, 필수값, 중복코드, 허용필드, 멱등 operation ID를 재검사한다.
6. 신규상품 등록은 코드·품목명·규격·단위와 입력된 입고가·구매처·창고·기본·과세만 master에 반영한다. 수량·기준일자는 활성 Excel 작업값으로만 보존한다.
7. 선택한 신규상품은 하나의 master commit으로 저장하고 history·보호 연결상태·최종 Snapshot 검산 중 하나라도 실패하면 전건 rollback한다. 성공 command가 반환한 owner Snapshot은 사용자가 실행한 현재 등록 작업 결과로 활성 작업에 반영할 수 있으며 백그라운드 변경으로 간주하지 않는다.
8. 등록된 상품은 현재 작업행을 유지한 채 기존 업무 대상으로 전환하고 미등록 상품이 0건이면 등록 전용 화면에서 자동 복귀한다. 자동 분석이나 후속 관리자 검토가 필요한 SmartInput·SmartParser 제안은 기존 `PENDING` inbox를 계속 사용한다.
9. Category/catalog creation stages the `견적서` work field for later F7. Product category/tag rename and delete route to the `Master.html` owner screen.

### 6.7 Master add/update review

1. Master accepts a validated Excel workbook for initial registration only when the official master is empty; when an existing master is present it uses the administrator-reviewed add/update comparison workflow.
2. The operator reviews:
   - new products;
   - changed products;
   - same products;
   - missing products;
   - duplicate codes;
   - blank values;
   - numeric zero;
   - field-specific issues.
3. Products and fields begin unapproved.
4. Only administrator-confirmed and approved values enter the execution scope.
5. Missing products remain in the master.
6. Workbook columns that are absent do not become change candidates.
7. A new product is created only when the final approved values for product name, specification, and unit are all nonblank.
8. Upload omission, administrator-entered blank, blank selection, field exclusion, or partial field approval cannot bypass the required-value rule.
9. An add/update operation against a zero-row master remains rejected unless the caller is the explicit initial-registration workflow or the read-only legacy review path.
10. Initial registration validates duplicate codes and required name, specification and unit values, then rechecks the empty state and revision immediately before the atomic master/history commit.
11. The shared master writer checks the comparison revision.
12. The selected master changes and execution-linked history are completed as one verified unit.
13. A failure restores the previous master and history.
14. Master add/update uses the shared history retention contract, currently 5,000 records.
15. If complete new execution history and existing retained history cannot both fit, the operation stops before the master write.
16. Existing audit records must not be silently truncated to allow the new operation.
17. Storage quota or history verification failure restores the exact previous master and history.
18. Initial registration is available; full replacement remains unavailable. Initial registration writes one official audit job containing the validated file and count while the full snapshot is protected by the master revision.
19. `Item_manager.html` remains available during the transition.
20. `Item_manager.html` is not removed by this phase.
21. Single-product registration and update require product code, name, specification and unit, block duplicate codes, compare revision, and commit master, field-level history and synchronization notification as one verified unit.
22. Legacy `oneapp-itemmaster-isolated-v1` data is read only after its database existence is confirmed, is never automatically deleted or overwritten, and enters the same administrator approval workflow before any official write.

### 6.6 ORDER Q smart file intake

1. The input workbench exposes order, warehouse inventory, purchase, and sales file slots.
2. The existing four-slot source strip is one full drag surface that accepts one to four files and classifies every dropped file by worksheet structure and column names first; touching a named slot opens its single-file picker without adding a separate visible bundle target.
3. Configured sheet-name aliases are used only when structural candidates tie; filename aliases are the final tie-breaker.
4. Administrator column aliases are passed to the real order and inventory parsers without renaming source headers.
5. Order and warehouse inventory remain required. Inventory balance is the warehouse-stock sum minus the current editable order quantity. Purchase rows populate stock-ledger inbound and purchase-place displays, while sales rows populate the stock-ledger `출고` display. Sales-only product codes remain visible as zero-stock stock-ledger rows so uploaded outbound history is not omitted; neither optional source changes the existing inventory-balance formula.
6. Mapping aliases and purchase-place input history remain local UI preferences. Parsed optional-source rows travel with the analyzed workspace so local recovery and explicit cloud loading reproduce the same stock-ledger view.
7. The warehouse-inventory view and workbook expose order information as `거래처(수량)단가` in `정보`, while original `적요` and `적요1` text is preserved separately in `적요`. The source `사용` column is omitted, product identity remains first, and the trailing price field named `창고` in the source is displayed as `창고단가` without moving it.
8. Order-status edits to order quantity, purchase place, warehouse, delivery note, and unit price remain inside the existing `shipping-workspace/v2` optional row fields and are recalculated before local recovery, explicit cloud save, stock-ledger display, purchase selection, and integrated workbook output.
9. Warehouse and manager color assignments are local persistent display preferences. Changing a color saves and applies it immediately, while `전체 다시보기` clears only active warehouse and manager filters and never resets saved colors. A saved manager color and its contrast-safe text color cover every cell from the first through the final column of a manager-owned row, including editable controls, semantic cells, and focused cells, while the row-edge marker and manager label remain. Direct table printing receives a dedicated paper-safe manager color token and retains that complete-row treatment independently of the screen theme, and matching per-order information badges remain available in aggregated inventory and ledger rows; text labels remain the primary identity so color is supplementary in both Light and Dark modes. Manager colors are backed up independently and may be recovered from saved view snapshots, while applying a view preset never overwrites the active global color map.
10. The settings modal initially exposes the five most recent local recovery records and reveals the remaining retained records through an explicit `더보기` control; record retention and verification still follow the ten-record recovery contract.
11. System.IO status text states the current operator action in Korean. ORDER Q uses F2 to clear result search, specification, warehouse, manager, column-condition, and column-sort view state while preserving analyzed data and saved warehouse/manager colors. Each table header exposes an Excel-like menu for ascending or descending sort and independent blank/zero exclusion. Filter buttons sit after the column tools, and color assignment is a separate target selector with an explicit white cancel swatch, ten visible pastel choices, and a vivid-color expansion; choosing white removes only the selected warehouse or manager's visible color without clearing other saved assignments, and native color inputs are not embedded in filter buttons.
12. Warehouse inventory accepts only the aggregate wide layout: one row per product code, a required source `수량`, and one or more warehouse quantity columns. Every row must satisfy `수량 = signed sum of warehouse quantity columns`; duplicate product codes, missing breakdown columns, and row-based stock-closing workbooks are blocked.
13. The operator-facing product brand is `ORDER Q`, owned by ONEAPP, and its stated purpose is shipment management (`출고관리`). The approved ORDER Q image asset is the visible header identity and is displayed at the same apparent cap height as the ONEAPP wordmark. Existing `orderops` routes, source filenames, storage keys, workspace schemas, cloud actions, and internal compatibility labels remain unchanged until a separately approved internal rename or migration.
14. The integrated ORDER Q workbook contains six sheets: delivery notices, order status, stock ledger, warehouse inventory, purchase upload, and sales upload. In order status, `주문수량` remains the individual order-row value and `주문수량 합계` repeats the signed total for the same normalized product code on every matching row. The sales-upload sheet follows the administrator-provided 19-column `판매입력` contract from `일자` through `구매처`, writes `출하창고` as the text value `01`, and omits the former `날짜`, `구매`, and `생산전표생성` columns. It is generated only from current nonzero order allocation rows; previously uploaded sales-history files remain shipment-completion evidence and are never re-exported as new sales vouchers.
15. A table print uses the active visible rows, current sort/filter result, visible columns, complete-row manager/unit colors, and the last explicitly saved column-width proportions. Widths are proportionally fitted to A4 portrait, printed backgrounds use exact color adjustment, wrapped print cells must not clip long product names, and the hidden common header must not leave its screen-only top offset above the printed table.
16. The header recovery action restores the latest SHA-256-verified local temporary record directly. The settings modal remains the route for choosing older retained records, and corrupted candidates remain blocked by the existing verification contract.
17. ORDER Q v1.35 defines an actual shortage as an inventory-backed product whose `warehouse stock total - current order quantity` is negative. `재고부족` focus shows only those order rows in order status; stock ledger and warehouse inventory additionally show inventory-backed substitute candidates whose normalized product-code first six characters match a shortage category. Missing inventory information is a separate review state and is never promoted into the verified-shortage focus.
18. Quantity presentation preserves the administrator's calculation trail: the calculated column is named `잔량`, blank remains blank, zero is muted, and a negative remainder is displayed as the signed numeric result such as `-3` with the same pale-yellow emphasis as its purchase-place cell. `발주 N`, `정보없음`, or other explanatory text is never substituted into a numeric quantity cell; review state remains available to the separate status-column filter, while purchase-upload export may still derive the required positive quantity from the signed result. Ordered rows use one pale context fill from product code through order quantity unless an explicit manager row assignment supplies the complete-row fill. Exact `EA`/`소분` rows use normal-weight red text across the complete row, while an exact `BOX` row uses high-contrast text across the complete row and retains bold product name and specification. Automatic warehouse rainbow fills are disabled by default; only explicit saved color assignments are applied. Purchase-place Tab navigation centers the next verified-shortage row and selects its input. Order-information unit prices use thousands separators on screen and in the integrated workbook without changing numeric source values.
19. Named view presets persist local display conditions for order status, stock ledger, warehouse inventory, purchases, and sales: search and filters, sort, visible columns, column order, and explicitly saved column widths. One preset per view may be marked as the default and is applied automatically when that result view opens. Applying a preset discards keys absent from the current workbook and never changes analyzed rows, editable business values, workspace recovery, cloud plans, or color assignments. Header-body clicks do not sort; sorting remains available only inside the header filter control.
20. The small folder-shaped `통합` picker beside `데이터 소스` is a batch wrapper for the existing order, inventory, purchase, and sales inputs, not a sixth result tab or a new business-data type; no full-width integrated-upload panel is shown. The five result tabs are ordered as order, stock ledger, inventory, purchase, and sales. In `환경설정 > 통합 Excel 시트명 매칭`, administrators may register comma-separated per-kind aliases. An identical normalized alias assigned to more than one kind blocks saving with a warning. Each workbook sheet is classified by a ranked alias match: exact normalized sheet-name matches win over contained aliases, then the sheet must pass required-header and structure validation. This lets `판매입력` resolve to the exact sales alias instead of the contained purchase alias `매입`, while a configured `미출고` alias can still recognize `미출고현황`. Valid sheets replace only their active kind; a later valid sheet or individual upload of the same kind wins. Missing, ignored, or invalid sheets never clear the previously active kind, so one bad sheet cannot block valid sheets in the same workbook.
21. In warehouse inventory, selecting an order-information customer chip and Ctrl-clicking another product row is the explicit local substitute-shipment command. It preserves customer, quantity, unit price, the original source matrix, and a requested-product snapshot; changes only the actual shipment product identity; recalculates the existing workspace; and appends a `shipping-substitution-history/v1` event. The rightmost system-message column projects both source and target product events with actor and time. Ctrl+Z appends an undo event and restores the previous product state without deleting history. This remains a local operation until the administrator explicitly saves an existing Shipping Cloud revision.

---

## 7. Change-impact rules

| Change type | Minimum review scope |
|---|---|
| MerchOps layout or button placement | MerchOps plus navigation and basic load smoke test |
| DataOps display-only change | DataOps representative file load, result display, and basic regression test |
| Product field, canonical name, or Excel mapping | MerchOps, SmartParser, DataOps, export center, settings, history viewer |
| Pricing or margin calculation | coreEngine, MerchOps, DataOps, SmartParser, export center |
| Storage key or IndexedDB schema | Every listed consumer plus migration and rollback |
| New cross-app direct Repository write | Not allowed; define the owner and Integration Adapter instead |
| Read Adapter schema or Snapshot revision | Owning Repository, every consumer, stale/error fallback, active-work protection and rollback |
| Integration Adapter command or response | Owning app, caller, authorization, failure isolation, idempotency and retry |
| SmartInput·ORDER Q 공식전표 command 또는 Repository 계약 | SmartInput command Adapter, ORDER Q Gateway·Repository, 회사·상품·거래처 식별, 문서·Revision·재고/미매칭·기본 채권채무·local queue 원자성, 실사 충돌 판단, 구매/판매 feature gate와 rollback. 마감·세금계산서·상계·Cloud 활성화는 별도 범위 |
| Cloud action or payload | code.gs and every listed consumer; Shipping plan actions additionally require Shipping failure-injection and token-isolation tests |
| Navigation path or filename | Every HTML entry point and deployed route |
| Information-change workflow | SmartParser immutable analysis/PENDING request, Product Snapshot immutability, MerchOps 관리자 확인 신규등록과 F7 field patch/history/rollback, existing history viewer |
| Supplier exclusion or stopped-product management | SmartParser duplicate separation and save blocking, exclusion persistence and next-parse filtering, master/stopped-list/pending-status/history atomicity, MerchOps compatibility reads and worktable protection, rollback and failure injection |
| Master add/update or master writer | Master, coreEngine, MerchOps read adapter and reviewed command adapter, DataOps synchronization, SmartParser, history, backup and rollback |
| MerchOps owner-boundary change | complete MerchOps runner, Product Snapshot READY/EMPTY/ERROR, stale revision conflict, idempotent retry, history/linked-state rollback, Settings/SmartParser read-only, explicit registration and PENDING separation, F8 no-write, F9 payload compatibility |
| SmartParser owner-boundary change | complete SmartParser runner, immutable analysis result, Product Snapshot READY/EMPTY/ERROR/stale, row-level PENDING/DUPLICATE/CONFLICT/NOT_AVAILABLE, raw analysis writer 0, explicit stop command success/idempotency/conflict/rollback, dictionary/exclusion/session/pricing compatibility |
| Master·ItemMaster·Item Manager 관계 또는 경로 변경 | 세 파일의 현재 역할·저장경계, `master-lookup`·`item-manager` ID와 공식 경로, manifest·공통 메뉴, 모든 소비자, 데이터·이력 보존과 독립 롤백 |
| DataOps out-of-list inventory master add or post-close sale resume | DataOps F6 location/search/duplicate/zero rules, masterAddUpdate single-product API, coreEngine revision and rollback, Master/SmartParser canonical `판매여부`, stop-management linked state, history, finalized snapshot boundary, and retry idempotency |
| DataOps file classification or parsing | DataOps required/optional file policy, parsing errors, representative operational files, generated workbook, and regression tests |
| OrderOps file classification or parsing | OrderOps four-way structural classification, administrator aliases, required order/inventory validation, current allocation calculations, local recovery exclusion, and integrated workbook regression tests |
| Planned app promotion to production | Manifest update, architecture review, navigation review, and PR validation |
| Function-key behavior | Review only the owning application's workflow; do not assume the same function key has the same meaning in another application |
| Shared approval or audit rule | Every writer and reader of the affected data and history contract |
| Data deletion or migration | All consumers, backup, recovery, migration verification, and production acceptance |
| Common Runtime or NEXUS UI dependency | Every consumer's independent boot, no-server fallback, load-time budget and app-local rollback |

The table defines minimum impact review.

A development-path classification may require a broader review, but must not reduce the minimum review required for a shared contract.

모든 앱 변경은 최소한 다음 독립성 질문에 답해야 한다.

1. 앱의 기본 기능은 무엇이며 외부 장애 중에도 남는가?
2. 이 앱이 소유하는 데이터와 외부에서 읽는 데이터는 무엇인가?
3. 다른 앱 저장소에 직접 쓰는 새 경로가 생기지 않았는가?
4. Adapter와 서버 실패가 관련 없는 기능으로 확산되지 않는가?
5. 오류·미확정을 정상 0건으로 표시하지 않는가?
6. 열린 작업본이 외부 revision으로 자동 변경되지 않는가?
7. 앱 단독 배포·검증·롤백 증거가 있는가?

---

## 8. Application lifecycle

Applications use the following statuses:

### Planned

Purpose and scope are being designed.

No production dependency is allowed.

### Pilot

Implementation exists for controlled testing.

Production data writes require explicit safeguards.

### Production

Supported operational application.

### Deprecated

Read-only or migration period.

Replacement and removal date must be recorded.

### Archived

Retained only in Git history or releases.

Not deployed as an active entry point.

A planned application must record:

1. Stable application ID and proposed filename
2. Business purpose and owner
3. Input data
4. Output data
5. Shared contracts it reads
6. Shared contracts it writes
7. Upstream applications
8. Downstream applications
9. Validation method
10. Rollback method
11. Target lifecycle status

### 8.1 Registered planned applications

| Component | Status | Intended purpose | Development trigger |
|---|---|---|---|
| `trend_report.html` | Planned | Provide insight from MerchOps and DataOps results | Resume after both applications produce stable master, history, inventory, and performance data |
| `image_generator.html` | Planned utility | Produce offline-sales images and printed materials for price changes and promotional products | Resume after the MerchOps F9 review payload and downstream F10 print workflow are finalized |

These files may remain in the repository, but they are not production dependencies.

They do not receive feature expansion during the current MerchOps and DataOps development cycle unless separately approved.

Planned applications must not write production master data until they are promoted through architecture review.

ORDER Q is registered as a Pilot on the existing `orderops/list.html` compatibility route. It owns the isolated `shipping-purchase-plan` local/cloud contract, does not call `coreEngine.js`, and does not change MerchOps or DataOps business behavior. Disabling the route and reverting its PR is the code rollback path; already finalized cloud revisions remain append-only operational records and are not deleted by rollback.

---

## 9. 아키텍처 검증과 manifest 전환

개발 분류, 역할, Git, 검증 판정, 병합·배포와 보고 절차는 `AGENTS.md`만 단일 원본으로 사용한다. 이 절은 앱 독립성에 필요한 아키텍처 증거만 정의한다.

### 9.1 앱 개발명세 필수 경계

모든 앱 개발명세는 다음을 명시한다.

- 앱의 기본 기능
- 앱이 소유하는 데이터와 Repository
- 외부에서 읽어오는 데이터와 Snapshot 계약
- 외부 장애 시 유지되는 기능
- 서버가 반드시 필요한 작업
- Read Adapter와 Integration Adapter
- 활성 작업본 보호 방식
- 독립 실행·배포·롤백 검증 방법
- 현재 상태와 목표 상태

### 9.2 독립 실행 완료조건

앱 구현 또는 구조 변경은 관련 범위에서 다음을 검증한다.

1. 다른 앱이 로드되지 않아도 기본 화면과 로컬 기능이 실행된다.
2. NEXUS 공통 UI 또는 공통 Runtime 로드 실패가 앱 Core를 차단하지 않는다.
3. Server Transport 실패가 정상 0건으로 표시되지 않고 마지막 정상 상태와 오류가 구분된다.
4. Read/Integration Adapter 실패는 관계된 기능에만 표시되고 다른 작업은 유지된다.
5. 다른 앱의 원시 IndexedDB·Object Store·localStorage에 직접 쓰지 않는다.
6. 외부 revision 변경이 열린 전표·활성 작업본을 자동 덮어쓰지 않는다.
7. 서버 필수 작업만 해당 경계에서 권한·revision·원자성을 검사한다.
8. 앱 변경만 독립적으로 배포하고 되돌릴 수 있다.
9. 계획·파일럿·운영 상태가 실제 소스·검증·배포와 일치한다.

### 9.3 `app-manifest.json` 단계적 확장

`app-manifest.json` v1.3.1의 기존 운영 계약은 유지한다. SmartInput과 거래처관리 파일럿은 실제 엔트리와 독립 실행 경계를 구현해 아래 선택 필드와 각자의 로컬 계약을 등록하며, 다른 앱도 실제 구축·검증 시 같은 방식으로 단계적으로 등록할 수 있다.

| 필드 | 의미 | 등록 시점 |
|---|---|---|
| `coreCapabilities` | 서버·외부 앱 없이 제공하는 기본 기능 | 앱 기본 기능 구현·단독 검증 시 |
| `ownedContracts` | 앱이 쓰기 권위를 갖는 데이터 계약 | 소유권 이전·migration·rollback 검증 완료 시 |
| `consumedContracts` | Read/Integration Adapter로 소비하는 외부 계약 | 소비자 전환과 fallback 검증 시 |
| `dependencyMode` | 기능별 `LOCAL_OPERATION`, `BACKGROUND_SYNC`, `SERVER_FINALIZE` 구분 | 외부 의존 경계 구현 시 |
| `offlinePolicy` | 외부 장애 시 유지 기능, 마지막 정상 상태와 재시도 정책 | 장애 격리 검증 시 |

- 기존 `sharedContracts`, status와 productionWrites 의미를 임의로 바꾸지 않는다.
- 새 필드를 manifest 필수값으로 전환할 때는 schemaVersion, validator, 모든 기존 앱과 문서를 함께 갱신한다.
- 목표 owner를 먼저 기록하거나 미구축 앱을 운영 의존성으로 등록하지 않는다.
- 거래처관리는 자체 엔트리·Repository·Read Adapter와 로컬 이전·복원 경계를 갖춘 파일럿으로 등록한다. SmartInput 소비자 연결은 별도 후속 작업으로 완료됐으며 ORDER Q 소비자 연결, Cloud 동기화와 인증 통제는 아직 포함하지 않는다.
- `ItemMaster.html`은 manifest 미등록 정적 호환 주소로 유지하며 운영 앱이나 `product-master` owner로 등록하지 않는다. 기존 `master-lookup`·`Master.html`과 `item-manager`·`Item_manager.html` 항목은 변경하지 않는다.
- 공식 상품관리 주소 전환과 `Master.html` 삭제 계획은 폐기됐다. 이후 owner 변경을 검토하더라도 별도 사용자 확정, writer 전환, migration과 rollback 검증이 필요하다.

### 9.4 독립 롤백 원칙

- 앱 소스 롤백은 다른 앱의 Repository와 확정 데이터를 삭제하지 않는다.
- Adapter 롤백은 직전 호환 schema와 읽기 경로를 유지한다.
- Server Transport 롤백은 이미 확정된 revision·감사·원장 기록을 제거하지 않는다.
- 공통 UI 롤백은 업무 앱의 저장소 migration을 요구하지 않아야 한다.
- 데이터 소유권 이전은 이전 전 Snapshot, 양방향 검증 또는 명시된 cutover, 소비자 전환과 역이전 계획을 포함한다.

---

## 10. 문서 거버넌스

- `app-manifest.json` is the machine-readable application inventory.
- This document defines architectural intent, current and target boundaries, shared contracts, ownership, dependency isolation, and impact rules.
- `AGENTS.md` defines shared working, validation, Git, approval, release, and reporting rules for Codex and AI development tools.
- Application-specific project instructions define role-specific behavior.
- A PR that adds, renames, promotes, deprecates, or removes an application must update:
  - `app-manifest.json`;
  - this architecture document.
- A PR that changes a shared data contract must list every reviewed consumer.
- Unknown planned applications remain outside production dependencies until registered.
- Role-specific instructions must not weaken shared data and recovery contracts.
- A fast-track classification must not be used to bypass a shared-contract review.
- An application owner may require stricter validation than the minimum defined here.
- A difference between documentation and actual code must be reported before either is assumed correct.
- Architecture and manifest changes require explicit review.
- These documents must not be rewritten incidentally during unrelated feature work.
- 목표 구조와 현재 상태가 다르면 이 문서는 둘을 명시적으로 구분하고 `app-manifest.json`은 현재 검증된 상태만 기록한다.
- `roles/PM.md`와 `roles/DEVELOPER.md`는 역할 경계 문서이므로 상위 규칙과 실제 충돌이 확인될 때만 변경한다.

---

## 11. 현재 계약과 앱 독립성 전환 로드맵

Roadmap work is delivered as separate pull requests and verified after each merge.

### 11.1 Baseline and automated checks

- Establish a verified recovery point.
- Add JSON validation.
- Add HTML validation.
- Add JavaScript syntax validation.
- Add navigation checks.
- Add application-load checks.
- Keep repository contract validation aligned with documented architecture.

### 11.2 Client-side safety

- Validate imported rows before apply.
- Block ambiguous partial writes.
- Protect browser storage writes.
- Automatically restore failed master applies.
- Display actionable errors.
- Limit imported file:
  - type;
  - size;
  - row count.
- Distinguish missing optional files from parsing failures.
- Preserve source values including blank and numeric zero unless an approved rule changes them.

### 11.3 Cloud service protection

- Add request validation and access control to `code.gs`.
- Separate:
  - read actions;
  - write actions;
  - destructive actions.
- Reject unknown actions.
- Record authenticated actors where an approved identity system exists.
- Preserve compatibility until every consumer is updated and validated.

### 11.4 Atomic cloud backup

- Upload into a staging session.
- Verify counts and integrity.
- Finalize only after every chunk succeeds.
- Preserve the previous backup on:
  - interruption;
  - validation failure;
  - incomplete upload;
  - mismatched counts.
- Verify master and history together where they form one operational recovery unit.

### 11.5 Application-specific output stability

#### MerchOps

- Product Snapshot is the only product read input. The active worktable keeps its starting Snapshot and a newer notification never overwrites it automatically.
- F7 applies reviewed work through `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1` for normal work and completed promotion-comparison rows. The only other MerchOps product write is administrator-confirmed missing-product creation through the same owner adapter's `MERCHOPS_PRODUCT_REGISTRATION_V1` command.
- F7 does not consume shared stop-management `pendingAction` records. `판매여부` is limited to the explicit `입고가없음` action recorded in patch history.
- F8 creates the Excel output from the current work without changing the master.
- F9 sends the unchanged existing payload shape to Export Center for a separate review-and-output flow. Optional Product Snapshot version metadata is stored in a fingerprint-bound sidecar key and does not change the existing draft rows.
- Missing products remain in the worktable until the operator selects and confirms actual registration. The owner command atomically validates and creates the selected products; quantity and business date remain work values, and successful registration does not require Excel re-upload.
- Settings-owned cloud URL, margin rules, mappings, links, table views, and SmartParser-owned dictionary/stop state are read-only. Cloud backup/restore, master upload/cleanup, and rename/delete actions route to their owner screens.
- Legacy globals and the bundled core fallback enforce the same boundary: mutating calls return `OWNER_ROUTED`, while URL/config/Snapshot reads and non-mutating backup builders remain compatible.
- SmartParser information changes are submitted separately as Product owner `PENDING` requests and are not queued into MerchOps F7.
- Supplier exclusion and stopped/sold-out product management are SmartParser-owned workflows; MerchOps keeps read-only stopped-state protection for its worktable.

#### Export Center

- Product Snapshot is an immutable reference only. EMPTY, ERROR and revision mismatch keep the draft visible and never become a product write.
- The visible Excel button and F9 call one output-only handler. There is no master commit, history append, revision update or master synchronization trigger.
- Existing workbook sheets, columns, working-value precedence, numeric zero, boolean false, explicit blank, image temporary payload and MerchOps return routing remain compatible.

#### SmartParser

- Product reference input comes only from `ONEAPP_PRODUCT_MASTER_READ_ADAPTER_V1`; READY, EMPTY and ERROR remain distinct, and a newer notification marks the open work stale without replacing it.
- F7 creates and validates deep-frozen `ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1`, then submits reviewed CREATE/UPDATE fields to `ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER` as row-level `PENDING` requests.
- Analysis, new-product proposals, price changes and catalog tag changes never write the raw product master, revision, confirmed history, stop linked state or master notification. Zero price and sold-out detection create issues and recommendations only.
- Parser dictionary, supplier exclusion, session compatibility and catalog warehouse/pricing inputs keep their existing keys and local behavior.
- Explicit STOP, RESUME and UPDATE_METADATA use only `ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1`, with expected Snapshot/revision, idempotency, atomic linked state/history/mirrors/notifications and stale-safe rollback.

#### DataOps

- F6 opens one out-of-list product search row below the selected inventory row and uses only the confirmed local master snapshot.
- F9 downloads the combined inventory, ledger, and analysis workbook.
- After F9 finalizes the FULL inventory snapshot, stopped products with positive newly counted inventory are resumed through the shared atomic master/history path. Resume failure is retried separately and never repeats the finalized closing.
- F10 prints the DataOps result.
- F8 is currently unassigned.
- F8 remains reserved until a separate requirement is approved.

#### ORDER Q

- F3 focuses the integrated search field and keeps the caret ready for immediate input.
- F4 opens Smart Input, Enter starts shipment analysis, and a successful multi-file drop captures Enter for analysis so an earlier focused control is not reactivated; refresh remains an explicit button action without a function-key shortcut.
- F5 opens Order Status, F6 opens the Stock Ledger, F7 opens Warehouse Inventory, and F8 saves the reviewed cloud revision.
- F9 prints only the current visible tab state, including active filters, rows, column visibility and column order, on A4 portrait.
- F10 downloads the complete integrated workbook regardless of current screen filters, hidden columns or column order.
- The existing four-file source strip classifies one to four dropped files by columns and sheet structure before sheet-name and filename aliases; each named slot remains a single-file touch selector, and no persistent bundle panel is added.
- The result tabs are ordered Validation Summary, Order Status, Stock Ledger, and Warehouse Inventory; the former Unshipped Status label is Order Status.
- Result tables use a light Excel-style cell grid. Editors do not draw a second border inside the table cell, and the active editable cell receives a light focus fill.
- The default Order Status sequence is warehouse, customer, group, manager, product code, product name, specification, product information, order, unit price, all warehouse-inventory columns, notice, and purchase. Product information shows the product-code order-quantity total once only when that code has multiple order rows; a single order row remains blank, and product-name differences do not split the code aggregate. Warehouse is read-only; order, unit price, notice, and purchase remain editable.
- Warehouse inventory shows `정보` as `거래처(수량)단가` with grouped unit prices, preserves order notes in a separate `적요` column, omits `사용`, keeps product identity first, and displays the trailing source price field `창고` as `창고단가` on screen and in the integrated workbook.
- `재고부족` focus is shared across F5–F7. F5 keeps verified-shortage order rows only; F6/F7 group same-six-character inventory-backed substitutes after the shortage row. The calculated column is displayed as `잔량` and keeps the signed result such as `-3`; missing inventory information remains available as a status-column filter value.
- Purchase input supplies stock-ledger inbound/purchase-place displays and sales input supplies the `출고` display, including zero-stock rows for product codes absent from the current inventory file. The inventory balance remains warehouse stock minus the current order quantity.

Function keys are application-owned behavior.

They may share:

- validation;
- backup;
- download-status;
- audit utilities.

Their business meaning must not be unified merely because the key number is the same.

### 11.6 Dependency and shared-engine hardening

- Pin or self-host critical browser dependencies.
- Introduce content-security controls.
- Consolidate only proven-compatible, non-controlling calculation·validation·serialization utilities through `coreEngine.js`; do not centralize app boot or Repository ownership.
- Do not remove local implementations until equivalence is proven.
- Add consumer-contract tests before shared-logic replacement.
- Separate shared-engine hardening from unrelated operational fixes.

### 11.7 앱 독립성 전환 순서

목표 구조는 한 번에 전체 저장소를 갈아엎는 작업으로 수행하지 않는다. 다음 단계는 각각 별도 명세·PR·검증·롤백을 갖는다.

1. **현재 접근 목록 고정**
   - 앱별 기본 기능, 현재 reader/writer, IndexedDB·localStorage·server 계약을 기록한다.
   - 신규 직접 writer를 금지하고 현재 writer는 호환성 기준선으로 보존한다.
2. **Read Adapter 도입**
   - 먼저 읽기 소비자를 revision Snapshot 계약으로 전환한다.
   - Adapter 실패·stale·empty·error와 로컬 fallback을 검증한다.
3. **상품관리 중복 구현 일원화**
   - `Master.html`은 기존 `master-lookup` 공식 경로와 운영 상품 저장·revision·history·Cloud 계약을 유지한다.
   - 격리 검증된 최초 Excel 등록과 단건 등록·수정만 공식 `Master.html`에 승계한다.
   - `ItemMaster.html`은 미등록 정적 호환 안내로 축소하고 레거시 격리 DB는 자동 삭제·덮어쓰기하지 않는다.
   - `Item_manager.html`은 기존 `item-manager` 공식 경로와 카탈로그 소싱·행사테마·BOM 등 현재 구현을 유지한다.
4. **CustomerMaster 구축**
   - 독립 앱 엔트리, 소유 Repository, customer Snapshot Read Adapter와 v17 읽기 전용 이전 경계를 파일럿으로 구현한다.
   - SmartInput은 로컬 캐시 우선·장애 격리형 소비자로 연결하고, ORDER Q의 필수 운영 의존성, Cloud 동기화와 인증 통제는 소비자별 후속 작업으로 분리한다.
5. **SmartInput 구축**
   - 전표 작성 작업본과 최신 자동저장 1건 갱신·복구 및 기존 호환 키는 SmartInput DB v5 자체 Repository가 소유한다.
   - Excel 원본은 행·열·공란·순서를 보존하고, 필드명 문자열·개수·순서가 완전히 같은 입력 양식만 위치 기반으로 적용한다. 신규 구조의 매핑·비매핑 확정과 기존 양식 수정은 전표 저장 검증과 독립된 로컬 매핑 프로세스다.
   - V1 자료 migration 없이 SmartInput DB v5와 ORDER Q DB v7의 현행 소유계약 안에서 additive V2로 진행하며 기존 Store·작업본·테스트자료를 자동 삭제하거나 초기화하지 않는다.
   - 상품·거래처는 Snapshot으로 복사하고 열린 전표를 최신 master로 자동 덮어쓰지 않는다. 사용자는 ERP와 같은 `productCode`를 사용하고 `productId`는 비노출 호환 기술키로 유지한다.
   - ORDER Q가 공식 `OfficialCommandGateway`·Repository와 공식 데이터를 소유하고 SmartInput은 command Adapter만 소비한다. 공식 transaction은 전표·Revision·재고/미매칭·정확매칭 거래처 기본 채권채무·local sync queue 원자성을 유지한다.
   - ORDER Q 전달 실패가 작성·로컬 저장을 손상시키지 않도록 격리하며 마감·세금계산서·상계·Cloud 활성화는 별도 작업으로 둔다.
6. **NEXUS 공통 UI 유지**
   - 정적 앱 이동·테마·공통 상태만 제공한다.
   - 인증·공유가 필요해도 앱 Core의 준비 완료를 NEXUS Runtime이 결정하지 않는다.
7. **상태 승격**
   - 단독 실행, 장애 격리, 데이터 무결성, 운영 배포와 독립 롤백이 확인된 앱만 계획에서 파일럿, 파일럿에서 운영으로 승격한다.

SmartInput 파일럿은 5단계 기본 복구와 상품·거래처 Snapshot 소비자 연결을 수행했다. 상품·거래처·ORDER Q 원장 소유권 이전과 다른 단계의 상태 승격은 수행하지 않는다.
