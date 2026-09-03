# NEXUS-SI-V2-07A 검증 증거

## 착수 기록

- 확인 시각: 2026-09-03 KST
- 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 착수 시 `origin/main`: `2ab5378562ae26118219e715fa474eb8d1950047`; repository validation run `33682624030`, Pages run `33682623065` 성공
- 최종 재기준화 `origin/main`: `46154150a02da3e3d256a1e39c0f8e3562902bfb`; repository validation run `33691285448`, Pages run `33691284414` 성공
- 브랜치: `codex/si-v2-stage7-revision`
- 전용 worktree: `C:\Users\USER\Documents\GitHub\oneapp-si-v2-stage7-revision-20260903`
- 최초 worktree HEAD: `2ab5378562ae26118219e715fa474eb8d1950047`; 두 차례 원격 전진을 반영해 최종 제출 commit의 직접 부모를 `46154150a02da3e3d256a1e39c0f8e3562902bfb`로 재배치
- 전용 worktree 시작 상태: clean
- 기본 checkout 보존 상태: `main`은 별도 변경이 있는 dirty 상태이며 파일 수정·정리·reset·checkout/switch·commit을 수행하지 않음

착수 전에 다음 최신 기준을 확인했다.

- `AGENTS.md` v2.3.4 (2026-08-30)
- `roles/DEVELOPER.md` (별도 문서 버전 표기 없음)
- `APP_ARCHITECTURE.md` v2.1.29 (2026-09-03)
- `app-manifest.json` schema v1.3.9 (2026-09-03)
- `scripts/validate-repository.mjs`: 기준선 24 checks / 0 warnings
- `orderq/ARCHITECTURE.md` v0.8.9 (2026-09-03, 6C review)
- PM 상위 명세 파일명 v2.0 / 내부 문서버전 v2.1
- PM 로드맵 파일명 v1.0 / 내부 문서버전 v1.1
- PM 개발 이슈·처리 기록의 2026-09-03 06:11 KST 7A 착수 항목

문서·소스 대조에서 확인한 차이는 `APP_ARCHITECTURE.md` 머리말의 `Current-source baseline`이 `9c47d3c412235be593f11389353555d5a3d5b532`로 남아 있다는 점이다. 본문, manifest와 ORDER Q 문서는 6C 완료 상태를 포함하고 최종 제출 기준 원격 main과 성공 CI 기준은 `46154150a02da3e3d256a1e39c0f8e3562902bfb`이다. 이 차이는 착수 기록에 먼저 남겼고, 7A 계약을 같은 문서에 추가하면서 문서 버전과 baseline 표기를 함께 현재 기준으로 맞췄다. PR #493의 전 행 입력면, 관리자 색상, 공통 테마·인쇄, SmartInput/OrderOps UI 및 회귀 변경과 7A owner 계약 사이의 충돌은 재기준화에서 발생하지 않았고, 해당 변경은 그대로 보존했다.

## 현재 상태와 목표 상태

- 현재: 최초 확정과 Phase 6C 재매칭은 ORDER Q `OfficialCommandAdapter → OfficialCommandGateway → OfficialVoucherRepository` 경계를 사용한다. 공식 DB는 `oneapp-orderq-pre-m1-v6` v7이고 correction/cancel owner command는 아직 없다.
- 목표: 확정 문서의 직접 덮어쓰기·삭제 없이 `CORRECT` 또는 `CANCEL`을 새 immutable Revision, 행별 재고 차이효과 또는 pending/review 상태, 명령 receipt와 local queue로 한 transaction에 기록한다.
- 보존: 원 document Revision Snapshot, 기존 효과와 실사 checkpoint, 단계 0~6C, SmartInput/OrderOps UI와 PR #490 UI/Excel 변경.
- 금지: 제품 UI 연결, 신규 Store/schema/migration, 기존 AR/AP 생성·수정·삭제·반전, Cloud allowlist/Push/Pull, Pilot/production gate 활성화, 단계 7B/8.
- 제한: 현재 문서에 연결된 기본 payable/receivable entry가 하나라도 있으면 금액·거래처 효과의 조용한 불일치를 막기 위해 correction/cancel을 명시적 미지원 오류로 fail-closed한다.

## 구현 및 검증 결과

### 구현

- `orderq/official-voucher-revision-core.js`에 versioned Target/Command/Plan 계약을 추가했다. 회사·종류·document ID·expected Revision·action·actor·timezone 포함 시각, `commandId=idempotencyKey`, payload/Head/delta digest, 원 immutable Revision hash와 완전한 현재/교체 Snapshot을 검증한다.
- `OfficialCommandAdapter → OfficialCommandGateway → OfficialVoucherRepository`만 owner-side 수정·취소를 노출한다. 네 gate(`CORRECT_PURCHASE`, `CANCEL_PURCHASE`, `CORRECT_SALE`, `CANCEL_SALE`)는 각각 독립이고 기본값은 모두 `false`다.
- Repository는 read-only preflight 뒤 동일한 정보를 DB v7 readwrite transaction에서 다시 읽어 검증한다. stale Head/Revision, 회사·종류·ID 불일치, 취소된 문서, hash/현재 projection 불일치, command payload 충돌, 연결 AR/AP가 모두 fail-closed다.
- `CORRECT`는 유효한 현재 효과와 다음 상태를 비교한다. 상품·창고·일자·수량이 바뀌면 기존 효과 반대행과 새 효과행을 분리한다. 매칭↔미매칭과 6C 재매칭 완료 상태는 movement 또는 pending supersession/creation으로 연결한다. 구매는 `+quantity`, 판매는 `-quantity`, 0·양수·음수와 factor 1을 보존한다.
- `CANCEL`은 projection을 `CANCELLED`인 새 Revision으로 전진시키고 문서·행·기존 Revision을 삭제하지 않는다. 이미 checkpoint에 흡수돼 실제 적용되지 않은 효과는 `signedQuantity=0`, `REVERSED`, `ABSORBED_BY_CHECKPOINT`, `officialInventoryApplied=false`를 서로 구분해 기록한다.
- 각 delta가 기존 Phase 5 `evaluateStocktakeCheckpointConflictV2`를 원 businessDate로 다시 사용한다. 같은 날 순서 미확정은 `SAME_DAY_ORDER_UNPROVEN`으로 결정을 요구하며, 모든 결정을 검증하기 전 write가 없다. 중간 취소는 `officialWrites: 0`이다.
- document/line Head projection, 새 immutable Revision, movement 또는 pending/unresolved, command receipt, syncQueue를 기존 Store만 사용하는 한 transaction에 기록한다. queue entity는 `OFFICIAL_VOUCHER_REVISION_COMMAND`, 상태는 `WAITING_SERVER_CONTRACT`이며 Cloud allowlist에는 추가하지 않았다.
- payable/receivable Store는 검사용 read-only 참여만 하고 쓰지 않는다. 연결 entry가 있으면 `ORDERQ_OFFICIAL_REVISION_ARAP_EFFECT_UNSUPPORTED`로 거부한다.

### PM 차단 결함 보완

- `G7A-REPLACEMENT-REFERENCE-001`: 교체 후 동일한 확정 당시 상품·거래처 identity와 Snapshot은 현재 마스터가 삭제돼도 재사용한다. 새로 추가되거나 바뀐 `MATCHED` 상품만 현재 Product owner Snapshot의 회사+ERP 코드 exact/unique 결과와 productId·코드·품명·규격·단위·revision을 command 작성 시와 Repository 실행 직전에 검증한다. 변경 거래처도 현재 Customer owner Snapshot으로 같은 방식으로 다시 판정한다. 가짜 self-consistent Snapshot은 실제 owner Snapshot hash/identity 대사에서 거부한다. 기존 AR/AP 0건 문서라도 새 `MATCHED` 거래처로 바꾸는 명령은 검증 후 `ORDERQ_OFFICIAL_REVISION_ARAP_NEW_MATCHED_PARTNER_UNSUPPORTED`로 0-write 차단한다.
- `G7A-HEAD-PROJECTION-001`: 초기 POST `businessSnapshot`과 7A 전체 after Snapshot을 명시적으로 구분한다. 초기 형식은 Snapshot이 실제 저장한 document/line 업무·identity 필드를 모두 대사하고 businessDate, 문서/행 상태, command/Revision 연결을 별도로 검사한다. 7A 형식은 현재 document와 ACTIVE/CONFIRMED line 전체를 after Snapshot과 canonical 비교한다. `status`와 `businessStatus`는 둘 다 독립적으로 `CONFIRMED`여야 한다.
- `G7A-SOURCE-EFFECT-INTEGRITY-001`: 원 projection에서 구매/판매 부호와 factor 1 기대효과를 재계산하고, 각 movement의 회사·종류·문서·행·상품 ID/코드·창고·businessDate/effectiveAt·hash-valid source Revision·command·movement/effect role/status·signed/original quantity를 검사한다. 정상, 실사흡수, late source/adjustment, revision-after, Phase 6C rematch는 각각 허용 shape와 lineage가 다르며 합계만 같아서는 유효효과로 채택되지 않는다.
- `G7A-UNRESOLVED-LIFECYCLE-001`: supersede/cancel 후 모든 review link의 활성 상태에서 최상위 unresolved 상태를 다시 계산한다. 활성 link가 남으면 `UNRESOLVED_PRODUCT`, 없으면 감사 link를 보존한 `NO_ACTIVE_REVIEW`가 되어 6B 목록에서 제외된다. Phase 6C가 이미 `MATCHED`로 확정한 unresolved identity는 지우거나 되돌리지 않으며 새 pending 재사용은 transaction 안에서 fail-closed한다.
- `G7A-REPLACEMENT-PREFLIGHT-002`: correction replacement를 기존 V2 preflight와 금액 계약으로 다시 검증한다. 문자열 공백과 숫자 0을 구분하고, 코드/품명 필수, 수량·단가, line과 Product Snapshot의 수량·단가·금액, document 합계를 모두 대사한다. 실제 수량 정정 fixture도 새 Revision Snapshot에 정정 수량·단가·금액을 기록한다.
- `G7A-REFERENCE-CLASSIFICATION-002`: 변경 상품의 거래 수량·가격·금액은 identity 변경 판단에서 제외한다. 새/변경 코드의 MATCHED/UNRESOLVED를 모두 현재 Product owner Snapshot exact 0/1/복수/기술 ID 누락 결과로 재계산하고, 코드 없는 품명-only는 결정적 `unresolvedProductStableId`를 검증한다.
- `G7A-CUSTOMER-CLASSIFICATION-002`: 현재 Customer owner Snapshot의 exact 1건+ID 결과는 반드시 MATCHED이며 false-unresolved 선언을 거부한다. 새 MATCHED 거래처는 이후 AR/AP 미지원 오류로 계속 fail-closed한다.
- `G7A-SOURCE-EFFECT-INTEGRITY-002`: 전체 document movement에서 reversal을 반영한 현재 유효효과 집합을 계산해 full Snapshot active effect 집합과 exact 대사한다. 각 movement의 source Revision.effects membership, reversal lineage, `businessOccurredAt`을 검사해 같은 날 시각변조·숨은 reversal·추가 active effect·Revision 미등록 movement를 거부한다.
- `G7A-PENDING-LINK-INTEGRITY-002`: active pending과 `unresolvedProducts.reviewLinks`의 동일 ID 링크가 정확히 하나인지 확인하고 회사·문서·행·Revision·command·창고·업무일/시각·수량/부호·금액·Snapshot·resolution을 대사한다. missing/duplicate/tampered link는 readonly와 동일 write transaction 재검사에서 fail-closed한다.
- `G7A-ACTIVE-SET-COVERAGE-003`: 문서의 모든 movement에 reversal 관계를 적용한 current non-reversal ID 전체와 모든 `PENDING_PRODUCT_MATCH` ID 전체를 Head `effectiveLineStates`의 inventory/pending ID 합집합과 각각 exact 대사한다. 초기 POST Snapshot도 행 상태를 derive한 직후 같은 전역 coverage를 적용하므로 삭제·교체된 과거 행의 reversal 누락, 살아난 과거 pending, 현재 행과 무관한 추가 효과가 fail-closed된다. Revision effect membership은 POST·6C·7A 형식별 필수 type/status/applied/role 또는 pending ID/quantity 필드를 요구해 `{id}`만 남은 축약 항목을 허용하지 않는다. 7A가 새 pending을 만들 때도 저장 row와 immutable afterSnapshot에 같은 새 `voucherRevisionId`를 계획 단계부터 기록해 다음 inspect/수정·취소가 동일 Head를 읽는다.

### 제품 UI 진입점 분석

- `smartinput/index.html`, `orderops/list.html` 및 제품 HTML/CSS/화면 JS에는 확정전표 `CORRECT`/`CANCEL` 진입점이 없다.
- 검색에서 확인된 “수정/취소”는 입력 양식, 붙여넣기, 색상, 일반 주문현황 등 기존 기능뿐이며 공식 확정전표 Revision 명령과 연결되지 않는다.
- 제품 연결은 UI Gate U2 후속 작업으로 남긴다. 버튼·탭·열·패널·팝업·route를 추가하지 않았고 Revision 경고 팝업도 이번 7A에서 구현하지 않았다.

### 검증 증거

- `scripts/test-smartinput-v2-official-revision-command.mjs`: 구매/판매, 양수·0·음수, 가격 0·음수, factor 1, 상품·창고·일자 변화, 매칭/미매칭, payload tamper, stale Revision, AR/AP 차단, 실사 이전/같은 날/이후 결정 의미, 중간 취소 0-write를 검증했다.
- `scripts/test-smartinput-v2-official-revision-browser.mjs`: 실제 Chromium IndexedDB `oneapp-orderq-pre-m1-v6` v7에서 회사 A/B, 판매 복수 문서 그룹, 동일 재시도, DB receipt payload 충돌, 이미 취소, matched↔unmatched, 6C 재매칭 완료행, 혼합 stocktake 결정을 검증했다. 결과는 `browser-evidence.json`에 보존했다.
- 같은 Chromium 시나리오에서 임의 productId와 가짜 exact Product Snapshot, 실제 존재 거래처를 가짜 미매칭으로 만든 Customer Snapshot, 현재 Snapshot으로 검증된 신규 matched 거래처, 삭제된 마스터를 모사한 기존 identity 재사용을 각각 검증했다. 거짓/미지원 경로는 count 불변이고 기존 identity 재사용만 성공했다.
- replacement 수량·단가 공백, 코드·품명 공백, line/Snapshot 불일치, document/line 합계 불일치는 모두 거부되고 명시적 0·음수는 보존됐다. 현재 owner Snapshot에 exact 상품/거래처가 있는 false-unresolved와 임의 name-only unresolved ID도 write 0으로 차단했다.
- 초기 Snapshot의 일자·창고·금액·거래처·line 원문 Snapshot 동시 변조, 7A 전체 Snapshot의 line identity/command 변조, `status=CONFIRMED`/`businessStatus=CANCELLED` 모순을 각각 거부했다. 같은 합계의 movement 상품·창고·일자·source Revision·command·status·original quantity 변조도 command lineage와 효과 identity 검사를 나눠 0-write로 거부했다.
- movement의 같은 날 `businessOccurredAt` 변조, 숨은 reversal, Snapshot에 없는 추가 active effect, source Revision.effects 미등록을 각각 별도 문서에서 거부했다. pending reviewLink missing/duplicate/warehouse·시각·signed quantity 변조도 실제 IndexedDB에서 모두 write 0이었다.
- 2행 전표에서 정상 행 삭제를 먼저 성공시킨 뒤 과거 matched 행의 reversal 삭제와 과거 unresolved 행 pending 재활성화를 각각 주입했다. 별도 전표에는 Head line과 무관한 lineage-valid movement와 active pending을 추가했고, 초기 POST Revision의 inventory effect member를 `{id}`로 축약했다. 네 전역 coverage 공격과 축약 membership 공격 모두 readonly inspect와 execute 재검사에서 같은 오류로 거부되고 Store count가 불변이었다.
- matched→unmatched correction으로 새 pending을 만든 직후 동일 document를 다시 inspect해 Revision 3의 `UNRESOLVED_PRODUCT` Head와 저장 pending/afterSnapshot Revision 연결이 일치함을 확인했다.
- unresolved 동일 identity의 다중 link 중 하나만 해소하면 6B 목록에 남고, 마지막 link와 sole link 취소 뒤에는 감사 link를 보존하면서 6B 목록에서 사라짐을 실제 read Adapter로 확인했다. Phase 6C `MATCHED` ID의 pending 재사용은 전체 rollback되고 matched productId가 유지됐다.
- 같은 브라우저 시나리오에서 document projection, line projection, movement, pending supersession, unresolved projection, pending creation, immutable Revision, command receipt, syncQueue의 9개 쓰기 지점에 각각 실패를 주입했다. 모든 경우 count·Head·Revision 수가 동일하고 command는 미커밋이었다. 별도의 실제 syncQueue unique constraint 후기 실패도 전체 rollback됐다.
- `scripts/test-smartinput-v2-official-revision-boundary.mjs`: DB명/버전, 신규 Store 없음, 네 gate 기본 OFF, SmartInput/OrderOps raw Repository import 0, Cloud allowlist 추가 0을 검증했다.
- repository validator: 24 checks / 0 warnings.
- 핵심 Node 회귀: 공식 V2 baseline/write boundary/identity/unresolved ledger/stocktake, 6A·6B·6C, rematch boundary, 공식 voucher core, 독립 recovery, multivoucher, related voucher import, OrderOps improvements가 모두 PASS다.
- 실제 브라우저 회귀: Phase 6C rematch, unresolved-review UI, SmartInput protected desktop workspace, OrderOps theme/print가 모두 PASS다.
- `git diff` 기준 `smartinput/index.html`, `orderops/list.html`, 제품 CSS/화면 JS, `orderq/orderq-db.js`, Cloud sync allowlist 파일의 변경은 0이다. 외부 및 로컬 mutating network request도 0이다.
- 최종 기준 main의 PR #493 전 행 입력면·관리자 색상·공통 테마·인쇄·SmartInput/OrderOps UI 및 회귀 변경과, 그 이전 PR #490 UI/Excel 변경을 재기준화 후 최신 브라우저 회귀로 다시 확인해 보존했다.

### DB·소유권·외부 요청 경계

- DB/schema: 기존 DB v7과 Store/index만 사용, 신규 Store·migration·version bump 0.
- owner write: Adapter → Gateway → Repository 외 경로 0; SmartInput/OrderOps raw Repository import 0.
- AR/AP: 생성·수정·삭제·반전 0; 연결 기본 효과가 있으면 실행 자체를 차단.
- Cloud/Pilot: 네 gate 기본 OFF, Cloud allowlist/Push/Pull/Pilot 활성화 0.
- 네트워크: 검증 중 외부 mutating request 0.

### 남은 위험과 후속

- 현재 제품 UI 진입점이 없으므로 운영자가 7A 명령을 실행할 수 없다. UI Gate U2 승인 뒤 별도 연결·경고 UX가 필요하다.
- AR/AP가 연결된 금액·거래처 변경/취소는 의도적으로 전부 차단된다. 채권·채무 마감·조정·세금계산서·상계 정책과 원장 반전은 별도 단계가 필요하다.
- `OFFICIAL_VOUCHER_REVISION_COMMAND`의 서버 계약이 없어 queue는 격리 상태다. Cloud 계약·충돌/ACK 정책이 정해질 때까지 allowlist에 넣으면 안 된다.
- 이번 변경은 단계 7B/8, Ready 전환, 병합, 배포, 데이터 migration을 포함하지 않는다.
- 범위 밖 발견사항: 공유 Git object 디렉터리에 기존 `tmp_obj_*` garbage 경고가 109건 보였으나 제품 변경과 무관하고 다른 작업 상태일 수 있어 prune/정리하지 않았다.

### 정확한 rollback

이 단계의 단일 커밋을 `git revert <7A-commit-sha>`로 되돌린다. 그러면 새 owner-side command surface와 gate/계약이 제거되고 DB v7 및 단계 0~6C는 그대로 남는다. 이미 명시적으로 커밋된 Revision/effect는 감사 사실이므로 자동 삭제하지 않는다. 강제 데이터 삭제, schema downgrade, 기본 `main` reset은 rollback 절차가 아니다.
