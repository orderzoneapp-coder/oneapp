## 목적

Phase 6A/6B의 읽기 전용 미매칭 검수 다음 단계로, 실제 재매칭 요청을 ORDER Q의 기존 Official Command Adapter → Gateway → Repository 단일 owner 경계에 추가합니다.

## 변경

- 명시적 회사 상품 선택과 Product Snapshot revision/hash를 포함하는 결정적 `ONEAPP_ORDERQ_INVENTORY_REMATCH_COMMAND_V2`
- 현재 unresolved/pending/document/line/original Revision/Snapshot 완전 링크 재검증
- Phase 5 checkpoint 분류 재사용과 행별 포함/미포함 필수 결정
- 정상 `APPLIED_NORMAL`, 포함 `ABSORBED_BY_CHECKPOINT` 재고 0, 미포함 결정적 `APPLIED_AS_LATE_ADJUSTMENT` 1건
- unresolved/pending/movement/audit Revision/receipt/local syncQueue를 기존 DB v7 한 transaction에 commit
- 동일 retry 결과 재사용, payload/idempotency 충돌·stale·손상·외부회사 fail-closed, 강제 실패 전체 rollback
- 이전 raw local rematch writer 차단과 remote compatibility replay의 Gateway routing
- 기본 rematch gate OFF, 새 queue는 Cloud allowlist 밖 `WAITING_SERVER_CONTRACT`

제품 UI, 버튼·탭·열·패널·팝업·라우트, 기존 정상 흐름, 상품 master write, 수정/취소, Pilot/Cloud 활성화, DB Store/schema/migration은 변경하지 않았습니다.

## 검증

- repository validator 24/24, warning 0
- Phase 0~6B 핵심 정적/계약/브라우저 회귀 PASS
- Phase 6C pure + 실제 IndexedDB Chrome E2E PASS
- 구매/판매, 코드만/품명만, 0/양수/음수, 복수 전표, 회사 격리, 동일 이름 복수 코드, 정상/실사 이전/같은날, 포함/미포함 혼합 PASS
- cancel/미완료 0-write, retry duplicate 0, Snapshot 변경 후 retry 동일 결과 PASS
- payload/idempotency 충돌, stale Snapshot/Revision, 부분·손상·외부회사 링크 거부 PASS
- forced transaction failure 전 Store rollback PASS
- PM Gate G6C 3건 보완 PASS
  - 정상/포함/미포함 0 모두 `effectStatus=ZERO_EFFECT`, 별도 `stocktakeEffectStatus` 보존
  - review+pending 동시 부호·수량·창고·일자·업무시각 변조 및 inactive/cancelled line·원 command 불일치 거부
  - `2026-02-30` businessDate/occurredAt/judgedAt/selectedAt 달력 검증, source/date 오류 write transaction 0
- SmartInput/OrderOps 실제 브라우저, client safety PASS
- 제품 UI diff 0, ORDER Q DB schema diff 0, 외부 mutating request 0

상세: `evidence/smartinput-v2-phase6c/README.md`, `browser-evidence.json`, `in-app-browser-evidence.json`

## Rollback

이 Phase 6C 단일 commit을 revert합니다. Phase 6A owner read와 Phase 6B UI는 유지하며, 기존 DB v7 자료 또는 이미 감사 기록된 재매칭 업무 사실은 삭제·초기화하지 않습니다.
