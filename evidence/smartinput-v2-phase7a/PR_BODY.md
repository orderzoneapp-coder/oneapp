## 목적

NEXUS-SI-V2-07A: 확정전표를 직접 덮어쓰거나 삭제하지 않고 ORDER Q owner 경계에서 `CORRECT`/`CANCEL`을 새 immutable Revision과 재고 차이효과로 기록하는 기반입니다. 제품 UI/운영/Cloud 활성화는 포함하지 않습니다.

## 핵심 변경

- versioned revision Target/Command/Plan 및 결정적 idempotency/payload·Head·delta digest 검증
- `OfficialCommandAdapter → OfficialCommandGateway → OfficialVoucherRepository` 전용 경계와 구매/판매 수정·취소 독립 기본-OFF gate
- DB v7 기존 Store 한 transaction에서 Head projection + immutable Revision + movement/pending + receipt + 격리 queue 원자 커밋
- 상품·창고·일자·수량 변화의 명시적 reversal/application, matched↔unmatched 및 Phase 6C 재매칭 상태 처리
- Phase 5 checkpoint classifier 재사용, 같은 날 미확정 수동 결정, absorbed/late/zero/reversed 감사 의미 분리
- 연결 payable/receivable 효과가 있으면 명시적 미지원 오류로 fail-closed; AR/AP mutation 0
- 변경/추가 matched 상품·변경 거래처를 현재 owner Snapshot으로 재검증하고, 확정 당시 동일 identity/Snapshot은 마스터 삭제와 무관하게 보존
- 초기 POST/7A 전체 Snapshot별 strict Head 대사, status/businessStatus 모순 차단, source movement의 상품·창고·일자·Revision·command·role/status·수량 lineage 검증
- review link 활성 상태에서 unresolved 최상위 상태를 재계산하고 Phase 6C matched identity의 pending 재사용을 rollback
- correction replacement V2 필수입력/Snapshot/합계 재검증, 공백과 명시적 0 구분
- Product/Customer owner Snapshot으로 MATCHED와 UNRESOLVED 분류를 모두 재계산하고 name-only unresolved ID를 결정적으로 검증
- 문서 전체 current non-reversal movement 및 active pending ID 합집합을 Head effectiveLineStates 합집합과 exact 대사(초기 POST derive 포함)
- reversal lineage, businessOccurredAt, POST·6C·7A 형식별 source Revision.effects 필수 membership 대사
- pending effect와 reviewLink의 1:1 회사/문서/Revision/시각/수량/금액/Snapshot 대사

## 검증

- 새 pure contract/plan 및 Chromium IndexedDB 브라우저 테스트 PASS
- 9개 write 지점별 강제 실패 + 실제 unique constraint 후기 실패 전체 rollback PASS
- 회사 A/B, 구매/판매, 복수 판매 그룹, 양수/0/음수, 가격 0/음수, retry/collision/stale/already-cancelled, matched/unmatched/rematched, stocktake 혼합 결정 PASS
- 가짜 Product/Customer exact 판정, 신규 matched 거래처 AR/AP 미지원, Head/line/Snapshot/status 모순, 동일합계 source-effect 변조가 모두 official write 0으로 거부됨
- 공백 수량·단가/상품, stale Snapshot·합계, false-unresolved 상품·거래처, 임의 unresolved ID가 모두 거부되고 0·음수는 보존됨
- 같은 날 업무시각 변조, 숨은 reversal, extra active/missing Revision effect, missing/duplicate/tampered pending reviewLink가 모두 official write 0
- 삭제된 과거 행 reversal 누락·pending 재활성화, Head 무관 active movement/pending 추가, `{id}` 축약 Revision membership을 inspect/execute 모두 거부하고 write 0
- 새 pending correction 직후 재-inspect에서 저장 row와 immutable afterSnapshot의 Revision 연결 일치 확인
- 다중/sole unresolved review-link 종료와 6B 목록 제외, 기존 Phase 6C MATCHED identity 재사용 rollback PASS
- repository validator 24/24, 기존 0~6C/SmartInput/OrderOps 핵심 Node 및 브라우저 회귀 PASS
- 신규 schema/Store 0, 제품 UI diff 0, raw Repository consumer import 0, 외부 mutating request 0

상세 증거: `evidence/smartinput-v2-phase7a/README.md`, `browser-evidence.json`

## 의도적 제한

- 네 gate 기본 OFF; Pilot/production 활성화 없음
- queue는 `WAITING_SERVER_CONTRACT`, Cloud allowlist 추가 없음
- 제품 UI 진입점/경고 팝업 없음(U2 후속)
- AR/AP 연결 문서는 전부 차단하며 마감·조정·세금계산서·상계는 후속
- 단계 7B/8, 배포, migration 없음

## Rollback

이 PR의 단일 커밋을 revert합니다. DB v7과 기존 0~6C 및 이미 기록된 감사 사실은 삭제하지 않습니다.
