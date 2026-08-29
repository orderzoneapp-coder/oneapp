# ONEAPP Application Architecture

- Repository: orderzoneapp-coder/oneapp
- Architecture document version: 2.1.2
- Last reviewed: 2026-08-29
- Current-source baseline: `fc20b24bb70abec5c3243edcb2ee07c6728c8f13`
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
- `app-manifest.json`에서 `product-master`의 현재 소유자는 `merchops`다. SmartParser, Export Center, Settings, `Master.html`과 일부 DataOps 흐름도 기존 공통 writer 계약을 사용한다.
- `Master.html`은 manifest의 `master-lookup` 공식 경로이자 기존 운영 상품 저장계약을 사용하는 마스터 앱이다. 현재 공식 주소, 앱 ID, 공통 메뉴 연결과 구현을 유지한다.
- `ItemMaster.html`은 `oneapp-itemmaster-isolated-v1` 격리 DB에서 독립 기능을 검증하는 별도 파일럿이다. manifest와 공통 메뉴에 등록되지 않았으며 `Master.html`의 확정 후속 구현, 공식 주소 또는 운영 상품 저장계약 소유자로 간주하지 않는다.
- `Item_manager.html`은 manifest의 `item-manager`로 등록된 별도 상품 관리 파일럿이다. `Master.html`, `ItemMaster.html`과 현재 경로·저장계약을 각각 유지한다.
- `CustomerMaster/partner_db.html` 운영 엔트리는 현재 기준선에 없다. SmartInput은 `smartinput/index.html` 파일럿으로 등록되어 전표 작업본과 기존 로컬 저장 계약을 소유하지만, 상품·거래처·ORDER Q 원장의 소유권은 이전받지 않는다. `orderops/input.html`은 계속 ORDER Q의 보조 입력 화면이다.
- ORDER Q의 `orderops`와 `orderq-vnext`는 파일럿이며 각자의 로컬·클라우드 계약을 유지한다.
- NEXUS 기본 로그인 홈은 `nexus/index.html`에서 운영한다. 배포된 `NEXUS_AUTH_V2` 서비스로 사용자 식별과 로그인·로그아웃 기록만 처리하며, 저장된 홈 Session은 즉시 표시한 뒤 서버 상태를 백그라운드에서 확인한다.
- 업무 앱 공통헤더는 사용자 정보를 표시하거나 인증 Runtime을 로드하지 않는다. 기존 권한별 앱 차단, 업무 Gateway 프록시와 앱 실행 통제 Runtime은 계속 롤백 상태다.
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
| NEXUS 홈·공통 UI | 운영 | 기본 로그인·로그아웃과 앱 홈, 정적 헤더·로고 홈 이동·일반/다크 테마. 권한별 앱 차단·업무 Gateway Runtime은 롤백 상태 | 사용자 식별과 앱 연결을 제공하되 업무 앱 실행은 통제하지 않음 |
| Master (`Master.html`) | 파일럿·유지 | manifest의 `master-lookup` 공식 경로이며 기존 운영 상품 저장계약을 사용 | 현재 공식 주소·앱 ID·구현을 유지 |
| ItemMaster (`ItemMaster.html`) | 파일럿·미등록 | manifest·공통 메뉴와 분리된 격리 DB에서 독립 기능을 검증 | 현재 독립 파일럿을 유지하며 통합·승계·운영 전환은 별도 사용자 결정 전 미확정 |
| Item Manager (`Item_manager.html`) | 파일럿·유지 | 기존 `product-master` 계약을 사용하는 별도 상품 기초정보 관리 화면 | Master 교체와 무관하게 별도 상품 관리 화면으로 유지 |
| CustomerMaster (`partner_db.html`) | 계획(미등록) | 현재 기준선에 운영 엔트리와 manifest 등록 없음 | 거래처 기준정보 단일 소유자, Read Adapter 제공 |
| SmartInput (`smartinput/index.html`) | 파일럿 | 네 전표 작업본·기존 DB v3·초안 키를 로컬 우선으로 운영. 기준정보·외부 입력·서버 확정은 기능별 Adapter로 격리 | 전표 작성 작업본 소유, 상품·거래처 Snapshot 소비, ORDER Q writer·서버 finalize 호출 |
| ORDER Q (`orderops`, `orderq-vnext`) | 파일럿 | 출고·주문 관련 독립 로컬/클라우드 계약을 운영 전 검증 중 | 확정된 주문 자료와 중앙 확정 경계 소유 |
| MerchOps | 운영 | 현재 상품 master·가격·프로모션 활용 및 일부 master writer 역할 | 상품 활용·가공 업무 소유, ItemMaster Snapshot 소비 |
| DataOps | 운영 | 재고·매입·매출·원가 분석과 승인된 일부 상품 상태 갱신 | 분석 결과 소유, 상품 변경은 ItemMaster Integration Adapter 사용 |
| SmartParser | 운영 | 외부 문서 해석과 승인된 상품정보·중지상태 직접 반영 | 해석 결과 소유, 상품 변경은 ItemMaster Integration Adapter 사용 |

### 4.1 상태와 소유권 전환

- `계획`: 목적과 계약만 정의됐으며 운영 의존성과 운영 쓰기를 허용하지 않는다.
- `파일럿`: 구현은 있으나 제한 검증 단계다. 목표 소유권을 전체 운영 소유권으로 간주하지 않는다.
- `운영`: 배포된 기본 흐름, 데이터 계약과 롤백이 검증된 상태다.
- 목표 역할은 방향을 뜻하며 현재 저장소 owner를 즉시 바꾸지 않는다.
- 현재 `Master.html`, `ItemMaster.html`, `Item_manager.html`은 서로 다른 파일·저장 경계로 유지한다. `Master.html`의 manifest 앱 ID `master-lookup`과 공식 경로를 유지하며, ItemMaster의 통합·승계·운영 전환을 현재 목표로 확정하지 않는다.
- `Item_manager.html`은 `master-lookup` 교체 대상이 아니며 기존 `item-manager` 앱 ID와 역할을 유지한다.
- 소유권 전환은 소유 Repository, Read/Integration Adapter, 소비자 전환, 데이터 이전, 회귀검증, 독립 롤백과 manifest 갱신을 같은 별도 작업에서 완료해야 한다.
- 미구축 앱의 이름이나 목표 계약을 기존 앱의 필수 Runtime 의존성으로 추가하지 않는다.
- `계획(미등록)`은 아키텍처 목표만 기록된 상태다. 실제 개발이 승인되면 `plannedApplications` 등록 기준을 충족한 뒤 파일럿 승격 절차를 시작한다.

### 4.2 현재 manifest 등록 목록

아래 표는 목표 역할이 아니라 `app-manifest.json` v1.3.0의 현재 등록 상태다.

| 앱 ID | 현재 경로 | 상태 | 현재 책임 |
|---|---|---|---|
| `nexus-home` | `nexus/index.html` | 운영 | 기본 로그인·로그아웃 기록, 사용자 식별과 독립 업무 앱 이동 |
| `merchops` | `MerchOps.html` | 운영 | 상품정보 가공·가격·프로모션과 현재 product-master 계약 |
| `dataops` | `DataOps.html` | 운영 | 매입·매출·재고·원가·성과 분석 |
| `smart-parser` | `SmartParser.html` | 운영 | 외부 문서 해석, 공급자 제외, 현재 상품정보·중지상태 반영 |
| `export-center` | `export_center.html` | 운영 | 검토 결과 확인, Excel 출력과 승인된 현행 master 반영 |
| `settings` | `settings.html` | 운영 | 매핑·가격정책·열·보기·Cloud URL 설정 |
| `master-lookup` | `Master.html` | 파일럿 | 상품 조회와 관리자 검토형 추가·수정 |
| `item-manager` | `Item_manager.html` | 파일럿 | 상품 기초정보 조회·등록·수정 |
| `history-viewer` | `history_viewer.html` | 운영 | 상품 변경이력·가격 추이 조회 |
| `core-engine` | `coreEngine.js` | 운영 공유 라이브러리 | 현행 저장·가격·이력·출력·Cloud·master 유틸리티 |
| `orderops` | `orderops/list.html` | 파일럿 | 출고·재고·구매계획과 검토형 출력 |
| `orderq-vnext` | `orderq/index.html` | 파일럿 | 주문 입력·수집·이행근거와 revision 동기화 |
| `cloud-sync` | `code.gs` | 운영 Server Transport | 현행 master·이력·설정·DataOps·Shipping·ORDER Q API |

`ItemMaster.html`은 실제 소스와 독립 검증이 존재하지만 manifest와 공통 메뉴에 등록되지 않은 별도 파일럿이다. 현재 구현대로 격리 상태를 유지하며 `Master.html`의 후속 구현이나 삭제 근거로 사용하지 않는다. `master-lookup`과 `Master.html`, `item-manager`와 `Item_manager.html` 등록은 그대로 유지한다.

### 4.3 Master·ItemMaster·Item Manager 현재 유지 기준

현재 소스의 세 구현을 다음과 같이 유지한다.

1. `Master.html`은 `master-lookup` 공식 주소, 공통 메뉴 연결, 현재 기능과 운영 상품 저장계약을 유지한다.
2. `ItemMaster.html`은 `oneapp-itemmaster-isolated-v1`을 사용하는 미등록 독립 파일럿으로 유지한다.
3. `Item_manager.html`은 `item-manager` 공식 경로와 현재 기능·저장계약을 유지한다.
4. 한 구현의 존재를 다른 구현의 대체·삭제·주소 변경 승인으로 해석하지 않는다.
5. 향후 통합, 기능 승계, 공식 경로 변경, 운영 저장계약 연결 또는 파일 삭제가 필요하면 현재 유지 정책의 변경으로 보고 별도 사용자 확정과 개발명세를 받는다.

현재 유지 정책만으로 세 파일 사이의 코드 이동, 저장소 이전, 메뉴 변경 또는 manifest 변경을 수행하지 않는다.

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

현재 `nexus/common/nexus-ui.js`와 관련 정적 자산은 앱 이동·NEXUS 홈 이동·현재 앱 표시·테마만 제공한다. 사용자명·계정 유형·Session 상태는 업무 앱 공통헤더에 표시하지 않는다. 공통 UI는 실행 중 manifest, 인증 서버, Gateway 또는 업무 저장소를 조회하지 않으며, 로드 실패가 각 앱의 업무 스크립트 실행을 차단해서는 안 된다.

`nexus/index.html`과 `nexus/nexus.js`는 기본 로그인 홈 경계다. 로그인 성공 시 NEXUS 홈에서만 사용자명과 `MASTER` 또는 `위임 사용자` 구분을 표시하고, 업무 앱 이동에는 권한별 필터나 서버 재검사를 적용하지 않는다. 유효기간이 남은 탭 Session은 홈을 즉시 표시하는 데 사용하며 서버 최신 상태는 백그라운드에서 확인한다. 로그인 서버 장애가 업무 앱의 직접 진입·화면 표시·로컬 기본 작업으로 확산되어서는 안 된다. 앱별 권한, 연동 허용, 업무이력 Adapter와 Gateway 정책은 별도 확정 전 구현하지 않는다.

### 5.2 현재 레거시 공유 브라우저 상태

The current applications share the browser database `MerchOpsDB` and a set of `localStorage` keys.

이 목록은 현재 호환성·마이그레이션 기준선이지 목표 공유 Repository가 아니다. 신규 앱과 신규 기능은 목록의 원시 저장소에 새 직접 쓰기를 추가하지 않는다. 기존 직접 writer를 제거하거나 소유권을 바꿀 때는 소유 앱 Adapter, 소비자 전환, 데이터 이전과 독립 롤백을 먼저 구현한다.

Important contracts include:

| Contract | Current key or resource | Main consumers |
|---|---|---|
| Product master | `merchMaster_v870`, `MerchOpsDB` / `master_products` | MerchOps, SmartParser, DataOps synchronization, export center, settings, history viewer, ORDER Q 수기입력(읽기 전용 검색) |
| Master change notification | `merchMaster_sync_trigger` | SmartParser, DataOps, export center, and settings; MerchOps reloads master values on a full page refresh and keeps an open worktable unchanged |
| Change history | `merchHistory_v870` | MerchOps, SmartParser, DataOps, history viewer, cloud backup |
| Parser dictionary | `parserDict_v870` | SmartParser, MerchOps, settings, cloud configuration |
| Parser supplier exclusions | `smartParserExcludeDict_v3012`, compatibility backup `smartParserExcludeDict_backup_v3015` | SmartParser owns writes, search, restore, scoped deletion, and automatic exclusion on the next parse; these keys are preserved without migration |
| Stopped-product management | IndexedDB `MerchOpsDB` keys `merchStoppedProducts_v2`, `pending_shop_status`; local mirrors `merchStoppedProducts_v2`, `pendingShopStatus` | SmartParser owns general stop/resume and management metadata writes; MerchOps reads stopped state for worktable protection; DataOps may perform resume-only writes through `masterAddUpdate.js` after a finalized positive inventory count |
| Stopped-product notification | `merchStopManager_sync_trigger` | SmartParser publishes verified stop-management changes; compatible readers refresh their stopped-state view without rewriting the shared list |
| DataOps post-close sale-resume recovery | `dataops_inventory_master_resume_v1` | DataOps only; records pending or failed sale-resume codes with the already-finalized inventory snapshot revision so retry never repeats inventory closing |
| Margin and pricing rules | `merchMarginRules_v878` | MerchOps, SmartParser, settings, core engine |
| Parser catalog warehouse map | `parserCatalogWarehouseMap_v1` (`{ [catalogName]: warehouseCodeString }`) | SmartParser, settings, core-engine `config_only` backup and restore |
| Mapping configuration | `merchMappings_v870` | MerchOps, settings, cloud configuration |
| Master links | `merchMasterLinks_v870` | MerchOps, settings, cloud configuration |
| Shared cloud URL | `oneapp_cloud_sync_url_v1` | MerchOps, DataOps, settings, history viewer, core engine |
| Legacy cloud URL | `merchCloudUrl_v870` | Compatibility fallback only |
| Active table target | `merchActiveTableTarget_v1` | MerchOps and settings |
| Active table view | `merchActiveTableViewId_v1` | MerchOps and settings |
| Shipping local recovery | IndexedDB `ONEAPPShippingManagementDB` / `workspaces`; `oneapp.shipping.recovery.pointer.v1` and `oneapp.shipping.recovery.meta.v1` | OrderOps only; IndexedDB stores the analysis workspace and inputs, while localStorage stores only the recovery pointer and metadata |
| Shipping table widths | `oneapp.shipping.table-widths.v1` | OrderOps local UI preference only; tab-specific widths are excluded from workspace, IndexedDB recovery, cloud plans, and purchase uploads |
| OrderOps Excel aliases | `oneapp.orderops.excel-mappings.v1` | OrderOps local parser preference only; administrator filename, sheet, and column aliases are excluded from workspace recovery and cloud plans |
| OrderOps purchase-name history | `oneapp.orderops.purchase-history.v1` | OrderOps local input convenience only; up to 30 recent nonblank purchase-place names are excluded from workspace recovery and cloud plans |
| OrderOps order-view presets | `oneapp.orderops.order-view-presets.v1` | ORDER Q per-view local display preferences only; named search/filter/sort conditions, visible columns, column order, and saved widths may be captured, and one preset per view may be marked as the access-time default. Presets remain excluded from workspace recovery and cloud plans |
| ORDER Q vNext local ledger | IndexedDB `oneapp-orderq-vnext` v4 | ORDER Q vNext only; operational orders, historical source batches, sales/purchase/ledger/inventory facts, fulfillment links, parser evidence, and sync queue |
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
| GET | `full` or omitted | Return master, history, and configuration |
| GET | `master_only` | Return product master and summary |
| GET | `config_only` | Return configuration only |

The DataOps snapshot contract is `ONEAPP_DATAOPS_SNAPSHOT_V1`. Its canonical row order is the existing whole-stock ten columns (`단위`, `품목코드`, `품명`, `규격`, `재고`, `기록`, `거래`, `구매가`, `기본`, `적요`) followed by `행사가`. It is a FULL snapshot; consumers must preserve every source LOT row and must not mutate units or treat it as a partial update. MerchOps inventory F8 is an output-only projection of that preserved snapshot: it emits one row per product code, sums stock quantity only, keeps the existing latest representative-LOT price/cost basis, never creates automatic subdivision inventory rows, and blocks output when missing codes, output duplicates, non-zero stock outside the source, total-stock mismatch, or shopping-mall/ERP code-order mismatch is detected.

`dataops_snapshot_commit` writes the inactive `DataOpsSnapshot_A` or `DataOpsSnapshot_B` sheet, verifies schema, SHA-256, row count, cell count, and same-code LOT promotion consistency, then switches the `ONEAPP_DATAOPS_CURRENT_SLOT` Script Property under `LockService`. A failed staging write leaves the previous current slot unchanged. The revision is derived by the server from basis date and canonical hash, so rereading or recommitting the same finalized snapshot returns the same identity.

Both DataOps snapshot actions keep their existing POST action names and snapshot data response shape. `dataops_snapshot_commit` and `dataops_snapshot_get` use the configured shared cloud URL without requesting, storing, sending, or validating an operator token. Existing requests that include a legacy token remain compatible and the server ignores that field. Existing master, history, configuration, and all other API actions, sheets, payloads, and response contracts remain unchanged.

The Shipping cloud contract is `ONEAPP_SHIPPING_PURCHASE_PLAN_V1`, and its embedded analysis contract is `shipping-workspace/v2`. `shipping_plan_save` writes `ShippingPlanStaging`, verifies SHA-256 and declared row/cell counts, appends the immutable payload to `ShippingPlanHistory`, rereads it, and only then appends `ShippingPlanIndex`. The index is the sole visibility boundary: an append that is not indexed is an orphan and must never be returned by list/get, while an index failure leaves every previously finalized revision and the previous latest revision unchanged. Revisions are not automatically deleted.

All Shipping plan actions use POST bodies and the separate `ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN`. They do not read or write DataOps A/B snapshots, `ONEAPP_DATAOPS_CURRENT_SLOT`, `MasterDB`, `HistoryLogs`, or `AppConfig`. Local autosave is not cloud transfer; another computer can retrieve only revisions saved through the explicit cloud-save action.

ORDER Q vNext actions use `ONEAPP_ORDERQ_ACCESS_TOKEN`, with the existing Shipping token as a compatibility fallback when a separate ORDER Q token has not been configured. Order and order-item writes are staged in `ORDER_TXN_LOG`, verified as a bundle, and restored to the previous bundle after a partial failure. Historical import facts are synchronized in shared purpose sheets; customer-specific sheets are prohibited.

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

`ItemMaster.html`은 현재 `coreEngine.js`와 운영 `MerchOpsDB`를 사용하지 않고 `oneapp-itemmaster-isolated-v1`에서 독립 기능을 검증한다. 이 구현은 현재 유지되는 별도 파일럿 경계이며 `Master.html`과의 통합·승계·대체가 승인됐다는 뜻이 아니다.

The `merchMarginRules_v878` normalize/select/calculate path is owned by `ONEAPP.PRICING`. SmartParser supplies the catalog warehouse only as calculation context and the final product `단위`; neither SmartParser nor MerchOps infers that unit from product name or specification. Exact non-wildcard warehouse-and-unit matches use the first saved rule, and every other case uses the single `*/*` default rule. Partial wildcard rules are not selected.

`parserCatalogWarehouseMap_v1` trims catalog names and warehouse-code strings without numeric conversion, so values such as `01` retain their leading zero and blank values remain valid. SmartParser and settings read and write this same key directly and synchronize it on browser storage and focus events. The key is carried inside the existing cloud `settingsKeys`; the `code.gs` action and payload schema are unchanged.

The legacy `parserListMarginRules_v1` value is retained for data compatibility but is not read, normalized, migrated, deleted, or rewritten by SmartParser, settings, MerchOps, or the shared pricing engine.

SmartParser uses `ONEAPP.STORAGE.commitMasterStateOrThrow` for stopped-product changes. The product master, `merchStoppedProducts_v2`, `pending_shop_status`, history, local compatibility mirrors, and synchronization notifications form one verified success unit. A history, mirror, notification, or linked-store failure restores the previous master and linked state. Existing `pendingAction` stop/resume records are normalized in place for compatibility and are not migrated to new keys.

MerchOps, DataOps, and SmartParser still contain other overlapping or locally implemented logic.

Treat `coreEngine.js` as the intended shared contract, but do not remove duplicated implementations until compatibility tests prove that each application produces the same output.

A shared-engine consolidation must not be performed as incidental refactoring during an unrelated feature or bug fix.

`coreEngine.js`의 현재 사용은 즉시 제거하지 않는다. 다만 목표 구조에서 공통 라이브러리는 순수 계산·검증·직렬화처럼 앱을 통제하지 않는 기능만 제공한다. 공통 Runtime이 앱 Repository를 열거나 초기화하고, 앱 준비 여부를 결정하고, 서버 상태를 이유로 전체 앱을 차단하는 기능은 추가하지 않는다.

### 5.5 클라이언트 안전과 장애 격리 기준

The master Excel workflow in `settings.html` uses the shared core engine and applies these controls before production data changes:

- Accept only `xlsx`, `xls`, or `csv` files up to 25 MB and 100,000 data rows.
- Block the entire apply action when a row has no product code.
- Block the entire apply action when a product code is duplicated.
- Block apply when no actual change exists.
- Keep existing products that are absent from the workbook.
- Treat workbook absence as a warning, not a delete instruction.
- Replace the IndexedDB master store in one transaction.
- Verify corresponding `localStorage` writes.
- If a post-write history or notification step fails, restore the previous master and history.
- Keep validation and storage errors visible until the operator fixes the file, retries, or clears the analysis.

Equivalent safety controls must be preserved when another application writes the same master or history contracts.

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
2. The operator reviews the matched product.
3. The operator saves approved name, specification, or unit changes.
4. SmartParser applies the saved product information directly to the product master.
5. Every changed field is recorded in the existing history with:
   - before value;
   - after value;
   - timestamp;
   - product code;
   - field;
   - SmartParser route.
6. A currently open MerchOps worktable remains a snapshot.
7. A full MerchOps page refresh loads the changed master values.
8. MerchOps information Excel import/export remains available as an independent bidirectional correction workflow.

### 6.2 Supplier collision and stopped-product management

1. SmartParser removes saved supplier-exclusion entries before matching, without deleting or changing the internal product master.
2. Existing multiple-master candidates and multiple supplier rows that resolve to the same normalized applied code are shown in the duplicate tab and receive `_apply=false`.
3. No duplicate group is automatically merged, overwritten, or reduced to a representative row.
4. The operator resolves a duplicate through search and manual relinking, a reviewed new ERP code, connection cancellation, or supplier exclusion.
5. Saving is blocked while any applied-code duplicate remains, and the duplicate code, count, and duplicate-tab resolution path are shown.
6. SmartParser owns individual, selected, and all-product stop/resume management, including reason and memo updates.
7. Stop/resume writes the master sale state, stopped-product list, existing shop-status queue, history before/after values, SmartParser route, timestamp, and synchronization notifications as one verified unit.
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
2. Configuration can be backed up to or restored from `code.gs`.
3. Data restoration must preserve:
   - the existing product master;
   - history;
   - compatibility keys;
   - application-readable data shapes.
4. An explicit migration review is required before compatibility data is removed.
5. Backup success must not be assumed from request completion alone.
6. Restored data must be re-read and checked for expected counts and structure.

### 6.5 Master add/update review

1. Master accepts an Excel workbook only as an add/update comparison source when an existing master is present.
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
9. A zero-row master is rejected independently at:
   - workbook analysis;
   - execution-plan construction;
   - final commit boundary.
10. A zero-row master must use a separately approved initial-registration workflow.
11. The shared master writer checks the comparison revision.
12. The selected master changes and execution-linked history are completed as one verified unit.
13. A failure restores the previous master and history.
14. Master add/update uses the shared history retention contract, currently 5,000 records.
15. If complete new execution history and existing retained history cannot both fit, the operation stops before the master write.
16. Existing audit records must not be silently truncated to allow the new operation.
17. Storage quota or history verification failure restores the exact previous master and history.
18. Initial registration and full replacement remain unavailable until separate approval, backup, and recovery workflows are implemented.
19. `Item_manager.html` remains available during the transition.
20. `Item_manager.html` is not removed by this phase.

### 6.6 ORDER Q smart file intake

1. The input workbench exposes order, warehouse inventory, purchase, and sales file slots.
2. The existing four-slot source strip is one full drag surface that accepts one to four files and classifies every dropped file by worksheet structure and column names first; touching a named slot opens its single-file picker without adding a separate visible bundle target.
3. Configured sheet-name aliases are used only when structural candidates tie; filename aliases are the final tie-breaker.
4. Administrator column aliases are passed to the real order and inventory parsers without renaming source headers.
5. Order and warehouse inventory remain required. Inventory balance is the warehouse-stock sum minus the current editable order quantity. Purchase rows populate stock-ledger inbound and purchase-place displays, while sales rows populate the stock-ledger `출고` display. Sales-only product codes remain visible as zero-stock stock-ledger rows so uploaded outbound history is not omitted; neither optional source changes the existing inventory-balance formula.
6. Mapping aliases and purchase-place input history remain local UI preferences. Parsed optional-source rows travel with the analyzed workspace so local recovery and explicit cloud loading reproduce the same stock-ledger view.
7. The warehouse-inventory view and workbook expose order information as `거래처(수량)단가` in `정보`, while original `적요` and `적요1` text is preserved separately in `적요`. The source `사용` column is omitted, product identity remains first, and the trailing price field named `창고` in the source is displayed as `창고단가` without moving it.
8. Order-status edits to order quantity, purchase place, warehouse, delivery note, and unit price remain inside the existing `shipping-workspace/v2` optional row fields and are recalculated before local recovery, explicit cloud save, stock-ledger display, purchase selection, and integrated workbook output.
9. Warehouse and manager color assignments are local persistent display preferences. Changing a color saves and applies it immediately, while `전체 다시보기` clears only active warehouse and manager filters and never resets saved colors.
10. The settings modal initially exposes the five most recent local recovery records and reveals the remaining retained records through an explicit `더보기` control; record retention and verification still follow the ten-record recovery contract.
11. System.IO status text states the current operator action in Korean. ORDER Q uses F2 to clear result search, specification, warehouse, manager, column-condition, and column-sort view state while preserving analyzed data and saved warehouse/manager colors. Each table header exposes an Excel-like menu for ascending or descending sort and independent blank/zero exclusion. Filter buttons sit after the column tools, and color assignment is a separate target selector with an explicit white cancel swatch, ten visible pastel choices, and a vivid-color expansion; choosing white removes only the selected warehouse or manager's visible color without clearing other saved assignments, and native color inputs are not embedded in filter buttons.
12. Warehouse inventory accepts only the aggregate wide layout: one row per product code, a required source `수량`, and one or more warehouse quantity columns. Every row must satisfy `수량 = signed sum of warehouse quantity columns`; duplicate product codes, missing breakdown columns, and row-based stock-closing workbooks are blocked.
13. The operator-facing product brand is `ORDER Q`, owned by ONEAPP, and its stated purpose is shipment management (`출고관리`). The approved ORDER Q image asset is the visible header identity and is displayed at the same apparent cap height as the ONEAPP wordmark. Existing `orderops` routes, source filenames, storage keys, workspace schemas, cloud actions, and internal compatibility labels remain unchanged until a separately approved internal rename or migration.
14. The integrated ORDER Q workbook contains six sheets: delivery notices, order status, stock ledger, warehouse inventory, purchase upload, and sales upload. The sales-upload sheet follows the administrator-provided 22-column `판매입력` contract and is generated only from current nonzero order allocation rows; previously uploaded sales-history files remain shipment-completion evidence and are never re-exported as new sales vouchers.
15. A table print uses the active visible rows, current sort/filter result, visible columns, and the last explicitly saved column-width proportions. Widths are proportionally fitted to A4 portrait, and wrapped print cells must not clip long product names.
16. The header recovery action restores the latest SHA-256-verified local temporary record directly. The settings modal remains the route for choosing older retained records, and corrupted candidates remain blocked by the existing verification contract.
17. ORDER Q v1.35 defines an actual shortage as an inventory-backed product whose `warehouse stock total - current order quantity` is negative. `재고부족` focus shows only those order rows in order status; stock ledger and warehouse inventory additionally show inventory-backed substitute candidates whose normalized product-code first six characters match a shortage category. Missing inventory information is a separate review state and is never promoted into the verified-shortage focus.
18. Quantity presentation preserves the administrator's calculation trail: the calculated column is named `잔량`, blank remains blank, zero is muted, and a negative remainder is displayed as the signed numeric result such as `-3` with the same pale-yellow emphasis as its purchase-place cell. `발주 N`, `정보없음`, or other explanatory text is never substituted into a numeric quantity cell; review state remains available to the separate status-column filter, while purchase-upload export may still derive the required positive quantity from the signed result. Ordered rows use one pale context fill from product code through order quantity. Exact `EA`/`소분` rows use normal-weight red text for product, specification, and quantity context, while an exact `BOX` row uses bold black for both product name and specification. Automatic warehouse rainbow fills are disabled by default; only explicit saved color assignments are applied. Purchase-place Tab navigation centers the next verified-shortage row and selects its input. Order-information unit prices use thousands separators on screen and in the integrated workbook without changing numeric source values.
19. Named view presets persist local display conditions for order status, stock ledger, warehouse inventory, purchases, and sales: search and filters, sort, visible columns, column order, and explicitly saved column widths. One preset per view may be marked as the default and is applied automatically when that result view opens. Applying a preset discards keys absent from the current workbook and never changes analyzed rows, editable business values, workspace recovery, cloud plans, or color assignments. Header-body clicks do not sort; sorting remains available only inside the header filter control.
20. The small folder-shaped `통합` picker beside `데이터 소스` is a batch wrapper for the existing order, inventory, purchase, and sales inputs, not a sixth result tab or a new business-data type; no full-width integrated-upload panel is shown. The five result tabs are ordered as order, stock ledger, inventory, purchase, and sales. In `환경설정 > 통합 Excel 시트명 매칭`, administrators may register comma-separated per-kind aliases. An identical normalized alias assigned to more than one kind blocks saving with a warning. Each workbook sheet is classified by a ranked alias match: exact normalized sheet-name matches win over contained aliases, then the sheet must pass required-header and structure validation. This lets `판매입력` resolve to the exact sales alias instead of the contained purchase alias `매입`, while a configured `미출고` alias can still recognize `미출고현황`. Valid sheets replace only their active kind; a later valid sheet or individual upload of the same kind wins. Missing, ignored, or invalid sheets never clear the previously active kind, so one bad sheet cannot block valid sheets in the same workbook.

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
| Cloud action or payload | code.gs and every listed consumer; Shipping plan actions additionally require Shipping failure-injection and token-isolation tests |
| Navigation path or filename | Every HTML entry point and deployed route |
| Information-change workflow | SmartParser direct master apply, existing history viewer, master refresh behavior, and cloud history backup |
| Supplier exclusion or stopped-product management | SmartParser duplicate separation and save blocking, exclusion persistence and next-parse filtering, master/stopped-list/pending-status/history atomicity, MerchOps compatibility reads and worktable protection, rollback and failure injection |
| Master add/update or master writer | Master, coreEngine, MerchOps refresh, DataOps synchronization, SmartParser, history, backup and rollback |
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

`app-manifest.json` v1.3.0의 기존 운영 계약은 유지한다. SmartInput 파일럿은 실제 엔트리와 독립 실행 경계가 구현되어 아래 선택 필드와 기존 로컬 계약을 등록하며, 다른 앱도 실제 구축·검증 시 같은 방식으로 단계적으로 등록할 수 있다.

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
- CustomerMaster는 실제 엔트리·Repository·Adapter·검증이 생기기 전까지 운영 애플리케이션 목록에 추가하지 않는다. SmartInput은 자체 로컬 계약과 실패 격리 Adapter를 갖춘 파일럿으로 등록하되 외부 master·원장의 소유자로 승격하지 않는다.
- `ItemMaster.html`은 현재 manifest 미등록 독립 파일럿으로 유지하며 `Master.html`의 후속 구현이나 운영 소유자로 선등록하지 않는다. 기존 `master-lookup`·`Master.html`과 `item-manager`·`Item_manager.html` 항목도 변경하지 않는다.
- 향후 ItemMaster의 `product-master` owner 전환을 검토하려면 먼저 별도 사용자 확정을 받고, 기존 writer의 Adapter 전환과 migration·rollback을 검증한 별도 PR에서만 수행한다.

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

- F7 applies reviewed work to the master and does not consume shared stop-management `pendingAction` records.
- F8 creates the Excel output from the current work without changing the master.
- SmartParser information changes are already applied directly and are not queued into F7.
- Supplier exclusion and stopped/sold-out product management are SmartParser-owned workflows; MerchOps keeps read-only stopped-state protection for its worktable.
- F9 sends the current result to Export Center for a separate review-and-output flow.

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
3. **Master·ItemMaster·Item Manager 현재 분리 유지**
   - `Master.html`은 기존 `master-lookup` 공식 경로, 현재 구현과 운영 상품 저장계약을 유지한다.
   - `ItemMaster.html`은 `oneapp-itemmaster-isolated-v1` 기반 미등록 독립 파일럿으로 유지한다.
   - `Item_manager.html`은 기존 `item-manager` 공식 경로와 현재 구현을 유지한다.
   - 세 구현 사이의 통합·승계·주소 변경·삭제·소유권 이전은 현재 로드맵에 포함하지 않으며 필요 시 별도 사용자 확정과 개발명세로 시작한다.
4. **CustomerMaster 구축**
   - 앱 엔트리, Repository, customer Snapshot, 쓰기 Adapter와 동기화 경계를 구현한다.
   - 파일럿 검증 전에는 SmartInput·ORDER Q의 필수 운영 의존성으로 등록하지 않는다.
5. **SmartInput 구축**
   - 전표 작성 작업본과 기존 로컬 저장 계약은 자체 Repository가 소유한다.
   - 상품·거래처는 Snapshot으로 복사하고 열린 전표를 최신 master로 자동 덮어쓰지 않는다.
   - ORDER Q 전달 실패가 작성·로컬 저장을 손상시키지 않도록 격리한다.
6. **NEXUS 공통 UI 유지**
   - 정적 앱 이동·테마·공통 상태만 제공한다.
   - 인증·공유가 필요해도 앱 Core의 준비 완료를 NEXUS Runtime이 결정하지 않는다.
7. **상태 승격**
   - 단독 실행, 장애 격리, 데이터 무결성, 운영 배포와 독립 롤백이 확인된 앱만 계획에서 파일럿, 파일럿에서 운영으로 승격한다.

SmartInput 파일럿 등록은 5단계의 기본 복구 범위만 수행한다. 상품·거래처·ORDER Q 원장 소유권 이전과 다른 단계의 상태 승격은 수행하지 않는다.
