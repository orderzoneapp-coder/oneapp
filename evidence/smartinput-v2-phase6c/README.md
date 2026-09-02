# NEXUS-SI-V2-06C 검증 증거

## 기준과 범위

- 기준 `origin/main`: `9c47d3c412235be593f11389353555d5a3d5b532` (Phase 6B merge SHA)
- 브랜치: `codex/si-v2-stage6c-rematch`
- 독립 worktree: `C:\Users\USER\Documents\GitHub\oneapp-si-v2-stage6c-rematch-20260903`
- 원본 `C:\Users\USER\Documents\GitHub\oneapp` checkout은 상태 확인과 `origin/main` fetch 이외에 파일 수정·정리·reset하지 않았다.
- 시작 전에 `AGENTS.md`, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md`, `app-manifest.json`, `orderq/ARCHITECTURE.md`, 검증 PM의 개발명세 v2.0·로드맵 v1.0·개발이슈 처리기록을 확인했다.

Phase 6C는 ORDER Q owner의 실제 재매칭 명령 안전 경계만 추가한다. 제품 UI 연결, 새 버튼·탭·열·패널·팝업·라우트, 기존 정상 흐름 변경, 상품 기준정보 write, 단계 7 수정/취소, Pilot/Cloud 활성화는 없다.

## 구현과 소유권

- `orderq/inventory-rematch-core.js`: `ONEAPP_ORDERQ_INVENTORY_REMATCH_COMMAND_V2` build/assert/plan. 명시 선택, 결정적 command ID/digest, expected 문서·효과, checkpoint 행별 결정을 검증한다.
- `orderq/official-command-adapter.js` → `orderq/official-command-gateway.js`: 유일한 공개 build/commit 흐름. 기본 rematch gate는 OFF이며 cancel은 Repository에 진입하지 않는다.
- `orderq/official-voucher-repository.js`: 현재 Product Snapshot schema/snapshot ID/revision/hash와 정확한 상품 행을 재검증하고, Phase 6A 링크 대사와 Phase 5 순수 checkpoint 분류를 현재 DB 상태에서 다시 호출한다. 이전 raw 로컬 rematch entry point는 `ORDERQ_REMATCH_OWNER_GATEWAY_REQUIRED`로 닫았다.
- `orderq/official-voucher-sync.js`: 기존 remote product-resolution replay도 raw 직접 호출 대신 owner Gateway를 경유한다. 새 `OFFICIAL_INVENTORY_REMATCH_COMMAND` queue type은 Cloud allowlist에 넣지 않았다.
- 데이터 owner는 `orderq-vnext`, 상품 Snapshot owner는 기존 `master-lookup`이다. 제품 UI consumer는 추가하지 않았다.

한 명령의 공식 write는 기존 ORDER Q DB `oneapp-orderq-pre-m1-v6` v7에서 다음 Store를 하나의 IndexedDB `readwrite` transaction으로 묶는다.

`purchaseDocuments`, `purchaseLines`, `salesDocuments`, `salesLines`, `officialCommands`, `voucherRevisions`, `inventoryMovements`, `pendingInventoryEffects`, `inventoryCheckpoints`, `unresolvedProducts`, `syncQueue`

문서·행·기존 Revision·checkpoint는 검증을 위해 같은 transaction에 포함되지만 수정하지 않는다. 새 Store, index, schema, migration은 없으며 `orderq/orderq-db.js`는 기준 SHA와 byte-equivalent다.

## 알고리즘

1. Gateway가 `companyId`, `identityVersion`, explicit selection, `commandId=idempotencyKey`, payload digest, actor, zoned `occurredAt`/`judgedAt`, Product Snapshot 증거와 완전한 expected 문서/effect 집합을 검사한다.
2. 이미 commit된 동일 영수증이면 현재 Product Snapshot이 나중에 바뀌었어도 저장 결과를 그대로 duplicate로 반환한다. ID/payload/scope가 다르면 충돌이다.
3. 새 명령이면 Product owner Snapshot의 content hash를 다시 계산하고 schema/snapshot ID/revision/hash 및 선택된 회사·product ID·code·name·specification·unit을 정확히 대사한다. 이름·유사도는 선택 권한이 아니다.
4. readonly preflight와 DB v7 write transaction 안에서 unresolved/reviewLink/pendingEffect/확정 문서/ACTIVE·CONFIRMED 행/원 Revision과 expected 목록을 각각 대사한다. 원 행에서 factor 1 수량, 구매+/판매- 부호, 창고, 달력상 유효한 업무일, 원 line/document에 존재하는 업무시각과 동일 원 command를 재계산하므로 reviewLink와 pendingEffect를 같은 거짓값으로 함께 바꿔도 fail-closed다.
5. `previewUnresolvedRematchImpact()`를 통해 Phase 6A 무결성 검사를 재사용하고 그 내부의 `evaluateStocktakeCheckpointConflictV2()`로 Phase 5 판정을 재사용한다.
6. checkpoint 없음·증명된 이후의 0이 아닌 효과는 `APPLIED_NORMAL`로 원 `businessDate`와 signed quantity를 유지한다. 원 수량 0은 정상·포함·미포함 모두 주 상태 `ZERO_EFFECT`이며, 별도 `stocktakeEffectStatus`에 각각 빈 값·`ABSORBED_BY_CHECKPOINT`·`APPLIED_AS_LATE_ADJUSTMENT`를 남긴다. 포함은 stock delta 0/미반영, 정상과 미포함은 반영이며 미포함은 결정적 1건이다. 두 상태는 movement·resolved pending·감사 Revision에 모두 보존한다.
7. unresolved 해결상태, pending-effect 연결결과, inventory/absorption movement, unresolved 단위 감사 Revision, 명령 영수증, local `WAITING_SERVER_CONTRACT` queue를 함께 commit한다. 실패는 전부 rollback한다.

`voucherRevisions.byCommandId`가 unique이고 한 rematch 명령이 복수 전표를 포함할 수 있어, 감사 Revision은 원 전표별 새 revision이 아니라 unresolved 단위 1건으로 저장하고 그 안에 모든 원 문서·행·기존 Revision·효과를 링크한다. 원 확정 문서/행/Revision과 확정 시 Product Snapshot은 수정하지 않는다.

## 검증 결과

- repository validator: 24 checks, warning 0
- Phase 0~6B: official V2 baseline, owner write boundary, Phase 3 identity, Phase 4 inventory/unresolved/ledger, Phase 5 checkpoint, Phase 6A read model/UI unchanged, Phase 6B UI/browser PASS
- Phase 6C pure command: 구매/판매, 코드만·품명만, 0/양수/음수, 복수 전표, 정상/이전/같은날, 포함/미포함 혼합, 정상·포함·미포함 0의 `ZERO_EFFECT`/`stocktakeEffectStatus`, 불가능한 timestamp, 비자동선택, 누락 결정·stale 결정 PASS
- Phase 6C IndexedDB browser: 회사 A/B, 동일 이름 복수 코드 명시 선택, 현재 Snapshot/revision/hash, payload/idempotency 충돌, stale 문서 Revision, 부분·손상·외부회사 링크, 변경된 확정 Snapshot, cancel/미완료 0-write, 동일 재시도와 Snapshot 변경 후 재시도 중복 0, 강제 queue constraint 전체 rollback PASS
- PM Gate G6C 보완: review+pending 동시 wrong-sign/quantity/warehouse/later-date/fabricated same-day 업무시각, inactive/cancelled line, document/line/Revision/pending commandId 불일치, `2026-02-30` businessDate·occurredAt·judgedAt·selectedAt을 모두 거부했다. 전 사례에서 공식 Store/queue/receipt/movement/audit 증가는 0이고 source/date 오류의 readwrite transaction 생성도 0이다.
- 실제 SmartInput 보호 작업공간 Chrome E2E PASS; 기존 layout/keyboard/작업복구/공식 저장/Phase 3~5/모바일 회귀 PASS
- 실제 OrderOps Phase 6B Chrome E2E PASS; light/dark/390px/201건 pagination/기존 버튼·단축키·정상 클릭 수 PASS
- OrderOps manager colors·dark table·print origin browser E2E PASS
- client safety PASS
- 제품 UI diff 0, ORDER Q DB schema diff 0
- 자동화 브라우저 외부 mutating request 0, fixture server write 0, browser exception 0
- 인앱 브라우저 직접 확인: OrderOps title `주문·출고 - NEXUS`, SmartInput title `스마트입력 - NEXUS`, 새 rematch 적용 컨트롤 0, 양쪽 console warning/error 0

구조화된 실제 IndexedDB 결과는 [browser-evidence.json](./browser-evidence.json), 인앱 브라우저 확인은 [in-app-browser-evidence.json](./in-app-browser-evidence.json)에 있다.

## 제한과 rollback

- rematch gate는 기본 OFF이고 제품 UI가 연결되지 않아 운영 사용자는 6C 명령을 실행할 수 없다.
- local queue는 기존 Store에 원자적으로 남지만 Cloud entity allowlist 밖의 `WAITING_SERVER_CONTRACT`다. 서버 replay·다기기 acceptance는 후속 승인 범위다.
- Product Snapshot은 별도 owner DB이므로 ORDER Q transaction과 cross-database atomic lock을 만들지 않는다. 6C는 명령 직전 현재 Snapshot을 다시 읽고 revision/hash/행 전체를 검증하며 그 증거를 영수증·Revision에 보존한다.
- 기존 V1 순수 planner와 기존 remote 호환 payload reader는 과거 자료 호환을 위해 남아 있으나, 6C local writer와 새 queue는 이를 호출하지 않으며 이전 raw local writer는 닫혀 있다.
- 정확한 코드 rollback은 이 Phase 6C 단일 commit을 `git revert <phase-6c-commit-sha>`로 revert하는 것이다. 그러면 core/Gateway/Repository/Adapter/sync routing, 문서/manifest/테스트만 되돌아가고 Phase 6A owner read와 Phase 6B read-only UI는 유지된다. 이미 명시적으로 commit된 재매칭 DB v7 행은 감사 가능한 업무 사실이므로 자동 삭제하지 않는다.
