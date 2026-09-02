# NEXUS-SI-V2-06A 검증 기록

## 기준과 격리

- 기준 remote main SHA: `a10e25048a67e7f0fcd285eda4f945cca0689760`
- 브랜치: `codex/nexus-si-v2-06a-unresolved-review-read-model`
- 격리 worktree: `C:\Users\USER\Documents\GitHub\oneapp-nexus-si-v2-06a-unresolved-review-read-model`
- 실제 main checkout은 읽기 확인만 했고 수정·정리·reset하지 않았다.
- 작업 목적: `SI-V2-UNRESOLVED-REVIEW`의 ORDER Q 소유 Read Model/Adapter, 순수 영향 미리보기, UI Gate U1 제안만 구현한다.
- 제외: 제품 UI, 재매칭 command, 공식재고 반영, Product/Customer 쓰기, DB migration/Store, Pilot/Cloud 활성화, 단계 6B/7.

## 시작 전 문서 증거

| 문서 | SHA-256 |
|---|---|
| `AGENTS.md` | `1103AF32615F63FDC9B555B5F6EE7E405F6612BCADF7E37BC79FC3E29B9BCD0A` |
| `roles/DEVELOPER.md` | `3ABF30674D6B346F36CDE254BDF086976616AD81986EC71BB9AA236690703034` |
| `APP_ARCHITECTURE.md` | `D494E42BCC297967ACBD28F0683BA33108AE81736818C9F3CAA2D51ED11E3246` |
| `app-manifest.json` | `F3BBDA545C7553524E0E496F669BFBE9CD3CF7914D99E69AE6601C4607C9F694` |
| `orderq/ARCHITECTURE.md` | `B1F7A49E0348D1B64D3D476999EBCC659C58A8007A98E2F70784D230FD60BA17` |
| 검증 PM 개발명세 v2.0 파일(본문 v2.1) | `D8BE9CFB520CDD89E93EB692E7C9A686BE86922C446FE1C49BAF6BFC8718C161` |
| 검증 PM 개발로드맵 v1.0 파일(본문 v1.1) | `E8CC957AE93E946050623D038AB66BBF1CF482522E12AEF9CEC256F95071E56D` |

## 구현 계약

- `orderq/unresolved-review-repository.js`: ORDER Q owner DB가 이미 있을 때만 열고 기존 8개 Store를 한 `readonly` transaction으로 조회한다. 회사 범위 미매칭/대기효과와 참조된 문서·행·Revision, 요청 시 창고별 checkpoint를 반환한다. DB가 없으면 생성·upgrade하지 않고 `ABSENT` 빈 결과를 반환한다.
- `orderq/unresolved-review-read-model.js`: 동일 unresolved ID의 review link와 pending effect를 `pendingEffectId`로 합쳐 중복 없이 정렬한다. 확정 당시 원문, 수량과 부호수량, 문서·행·Revision 추적, 공식재고 `미반영`과 `officialQuantity=null`, 무결성 문제를 제공한다. 정확 코드/이름 후보는 읽기 참고이고 모두 자동확정하지 않는다.
- `orderq/unresolved-review-read-adapter.js`: 소비자가 ORDER Q Store를 직접 열지 못하게 owner 조회와 Product Snapshot 조회를 조합한다. 공식 owner 결과의 `READY|EMPTY|ERROR`를 구분하고 owner 오류를 0건으로 바꾸지 않는다. Product 후보 조회 오류는 공식 검수 목록을 숨기지 않지만 선택 상품 검증이 필요한 영향 미리보기는 fail-closed한다.
- 영향 미리보기는 단계 5 `evaluateStocktakeCheckpointConflictV2()`를 재사용한다. 결과는 `APPLY_READY|DECISION_REQUIRED|REVIEW_REQUIRED`와 최신 checkpoint 근거뿐이고 `commands=0`, `inventoryWrites=0`, `referenceDataWrites=0`이다.

## 검증 결과

- 단위/계약: `scripts/test-smartinput-v2-unresolved-review-read-model.mjs` PASS. 코드만/이름만/코드+이름, 구매·판매, 양수·0·음수, 동일 unresolved 다중 링크, 회사/정확 문자열 격리, 손상 링크, 후보 비자동확정, 결정적 정렬·필터·페이지, 오류/빈 결과를 검증했다.
- 실사 영향: 2026-09-01 checkpoint 기준 2026-08-05 효과는 `BEFORE_CHECKPOINT/DECISION_REQUIRED`, 2026-09-02는 `AFTER_CHECKPOINT/APPLY_READY`, 같은 날 시각 불명은 `SAME_DAY_ORDER_UNPROVEN/DECISION_REQUIRED`로 검증했다.
- 대량 조회: 순수 Read Model 10,000 effects, 첫 200건 페이지 투영은 최종 로컬 검증에서 343.5ms로 5초 기준 이내였다. 이 수치는 실행 환경 의존 측정값이며 계약상 출력 limit은 최대 200이다.
- 실제 브라우저/owner Repository: 기존 Stage 4가 만든 2 unresolved/3 links를 읽었고 관찰된 쓰기 method 0건, `readwrite` transaction 0건, 전후 공식 Store count 동일을 확인했다.
- 격리 브라우저: 실제 외부 mutating request 0건, production IndexedDB write 0건, fixture server write 0건. Cloud 요청 시도는 테스트 stub에서만 차단·기록된다.
- UI 회귀: 제품 UI 파일 변경 없이 기존 브라우저 E2E를 통과했다. `browser-after.json`은 단계 5 증거와 DOM 모드 탭·버튼·표 열·footer, 단축키, 구매/판매 저장 클릭 수를 비교한다.
- UI Gate U1: `UI_GATE_U1.md`. A/B/C 비교만 있으며 사용자 승인 전 제품 UI 변경은 없다.

## 소유권, rollback, 남은 위험

- 데이터 owner는 `orderq-vnext`; Product Snapshot은 `master-lookup`의 읽기 참고다. 등록된 제품 UI 소비자는 아직 없다.
- rollback은 새 read-only 3개 자산, manifest/아키텍처 등록과 테스트·evidence를 revert한다. DB v7 records/schema, Product/Customer, SmartInput 작업본과 기존 제품 UI는 삭제·변환하지 않는다.
- 남은 위험: U1 선택 미승인, 재매칭 실행 계약 미구현, 사용자 결정 및 실제 재고 반영 미구현, Cloud/Pilot 미활성, 손상된 과거 링크는 자동 복구하지 않고 검수 상태로만 보존한다.
