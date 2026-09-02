# NEXUS-SI-V2-05 재고실사 checkpoint 충돌 작업 기록

## 착수 기준

- 작업 ID / 패키지: `NEXUS-SI-V2-05` / `SI-V2-STOCKTAKE-CONFLICT`
- 기준 SHA: `5595dfb265bb1efb4d5e925da749180b1d61e4dc` (착수 당시 원격 `origin/main`과 로컬 remote-tracking ref가 모두 일치)
- 브랜치: `codex/nexus-si-v2-05-stocktake-conflict`
- 전용 worktree: `C:\Users\USER\Documents\GitHub\oneapp-nexus-si-v2-05-stocktake-conflict`
- 실제 `oneapp` main checkout은 사용자 변경이 있는 상태로 확인만 했고 수정·정리·reset하지 않았다.
- 규범: `AGENTS.md` 2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` 2.1.24, `app-manifest.json` schema 1.3.8, `orderq/ARCHITECTURE.md` 0.8.4
- 업무 기준: 개발명세 내부 v2.1, 개발로드맵 내부 v1.1의 단계 5 / Gate G5-P·G5-S
- 시작 문서 SHA-256: `AGENTS.md` `1103AF32615F63FDC9B555B5F6EE7E405F6612BCADF7E37BC79FC3E29B9BCD0A`, `roles/DEVELOPER.md` `3ABF30674D6B346F36CDE254BDF086976616AD81986EC71BB9AA236690703034`, `app-manifest.json` `F3BBDA545C7553524E0E496F669BFBE9CD3CF7914D99E69AE6601C4607C9F694`
- PM 문서 SHA-256: 명세 `D8BE9CFB520CDD89E93EB692E7C9A686BE86922C446FE1C49BAF6BFC8718C161`, 로드맵 `E8CC957AE93E946050623D038AB66BBF1CF482522E12AEF9CEC256F95071E56D`

## 구현 결과

- 순수 `stocktake-conflict-v2` 경계가 각 정확매칭 행의 최신 `CONFIRMED` checkpoint를 회사+상품코드+창고로 판정한다. 기존 checkpoint의 숨은 `productId`는 호환키로만 인정한다. 같은 이름·다른 회사·다른 창고·다른 코드는 섞지 않는다.
- 전표 `businessDate`가 실사일 뒤면 정상이다. 앞이면 충돌이고, 같은 날은 전표와 checkpoint 양쪽에 timezone을 가진 신뢰 가능한 업무시각이 있어 전표가 뒤임을 증명할 때만 정상이다. 명령 `occurredAt`과 checkpoint `confirmedAt`은 업무 선후 판정에 사용하지 않는다.
- 모든 V2 그룹을 읽기 전용으로 먼저 검사한 뒤 충돌이 하나라도 있으면 승인 팝업에서 행을 한 건씩 순차 확인한다. 상품코드/상품명/창고/수량과 `실사수량에 포함됨`, `실사수량에 포함되지 않음`, `확정 취소`만 사용하며 같은 전표·복수 그룹에서도 행마다 서로 다른 결정을 보존한다. 전 행 선택과 전 그룹 재검증이 끝난 뒤에만 첫 저장을 시작한다.
- 포함 결정은 원 문서·행·Snapshot·Revision을 보존하고 원 이동을 적용수량 0, `ABSORBED_BY_CHECKPOINT`, checkpoint/결정 감사 연결로 저장한다.
- 미포함 결정은 원 이동을 비적용 연결기록으로 보존하고 결정적 ID의 `APPLIED_AS_LATE_ADJUSTMENT` 이동을 정확히 한 건 추가한다. 원 `businessDate`와 checkpoint 수량은 변경하지 않는다.
- 수량 0은 `ZERO_EFFECT`를 유지하면서 별도 `stocktakeEffectStatus`로 결정을 보존한다. 음수와 구매 `+`, 판매 `-`, factor 1, 미매칭 공식재고 미반영, 불변 Snapshot, 선택적 거래처/AP·AR, `effectiveAt`/`occurredAt` 계약을 유지한다.
- 결정 종류, 대상 행·상품·창고·수량, checkpoint, 판단시각, actor, `businessDate`를 command payload와 Revision에 넣는다. `judgedAt`은 `Z` 또는 명시 offset을 가진 완전한 ISO timestamp만 허용한다. 결정 변경은 payload digest와 commandId를 바꾸며, 동일 commandId의 변경 payload는 거부된다.
- Gateway는 독립 기본-OFF 구매/판매 gate와 command/projection을 검사한다. V2 inspection port가 없으면 preview와 `saveDraft` 모두 명시 오류로 차단하고, custom submit을 쓰는 Finalize Service도 inspector가 없으면 submit 0건으로 종료한다. Repository는 preview와 별개로 같은 쓰기 transaction 안에서 checkpoint를 다시 읽고 회사·결정값·대상·projection·멱등성·expected Revision을 재검사한다. preview 뒤 최신 checkpoint가 바뀌면 쓰기 전에 fail-closed한다.
- 향후 미매칭 재매칭이 사용할 수 있는 순수 `evaluateStocktakeCheckpointConflictV2()`만 제공한다. 현행 재매칭 배치·영구 검수 UI·자동선택 동작은 이 단계에서 확장하지 않았다.

## 취소·UI 보존

- `확정 취소`, 헤더 X, ESC는 Finalize 쓰기 전에 반환한다. 첫 행을 선택한 뒤 다음 행에서 취소해도 앞선 선택을 폐기한다. 격리 IndexedDB에서 submit 0건과 공식 문서·행·Revision·재고·pending·AP/AR·명령·queue 전후 카운트 동일을 확인했다.
- 팝업 종료 뒤 활성 입력, 텍스트 선택범위, 행 선택, 가로·세로 스크롤, 작업표 값, 기존 탭·footer 버튼 배열과 앱 shell geometry가 동일했다.
- 기존 영구 DOM·버튼·열·탭·단축키는 변경하지 않았다. 충돌 팝업은 동적 `<dialog>`와 기존 `.smart-dialog`/theme token을 사용한다. 정상 V1 및 기본-OFF V2 경로에는 팝업과 클릭이 추가되지 않는다.
- 일반·다크·390×844 모바일 캡처와 44px 모바일 동작 영역을 검증했다.

## 검증 결과

- `node scripts/test-smartinput-v2-stocktake-conflict.mjs`: PASS. 구매/판매, 복수 행/checkpoint와 혼합결정, 회사·상품·창고 격리, 같은 날 시각 불명/신뢰시각, 포함/미포함/취소, 0/음수, 엄격한 감사 timestamp, 누락 inspection port 차단, 감사 payload/Revision, 결정 변조와 동일 commandId payload 변경, 전체 그룹 선검사를 검증했다.
- 단계 0~4 계약, owner write boundary, ORDER Q core/rematch, repository validator와 관련 회귀검사: PASS.
- `node scripts/test-smartinput-browser-e2e.mjs`: PASS. 임시 Chrome profile의 실제 IndexedDB에서 선택 전 0건, 포함 현재고 중복 0, 판매 미포함 연결조정 1건, 구매/판매 각각 2행 `0007=포함·0008=미포함` 혼합결정, 중간 취소 0-write, 동일 명령 재시도 중복 0, preview 이후 checkpoint 변경 거부, 강제 transaction 실패 rollback, 회사 격리를 검증했다.
- 강제 실패 뒤 해당 Draft만 보존되고 새 Revision·재고·원장·명령·queue는 0건이다.
- 실제 외부 mutating request 0건, 생산 IndexedDB write 0건, local fixture server write 0건이다. 운영 Apps Script 요청 시도는 브라우저 네트워크 전에 차단했으며 Cloud 활성화·배포는 수행하지 않았다.
- checkpoint 조회는 명령의 고유 창고별 기존 `byCompanyWarehouseEffectiveAt` index range를 한 번씩 읽고, 행별 productCode/productId 판정을 메모리에서 수행한다. 새 Store·index·migration은 없다.
- 기계 증적: [browser-after.json](./browser-after.json), 화면 증적: [screenshots](./screenshots/), 구매 Gate: [G5-P.md](./G5-P.md), 판매 Gate: [G5-S.md](./G5-S.md).

## 소유권·범위·Rollback

- SmartInput은 작업본·입력·팝업을 소유하며 ORDER Q raw Store를 직접 쓰지 않는다. ORDER Q Adapter→Gateway→Repository가 공식 문서·checkpoint·Revision·재고·AP/AR·명령·queue를 소유한다. Product/Customer/창고 기준정보에는 쓰지 않았다.
- 구매·판매 V2 feature gate는 독립이고 기본 OFF다. 검증 fixture에서만 활성화했다.
- Pilot/Cloud 활성화·배포, 수정·취소 기능, Draft V2, migration, 기준정보 owner write, 영구 표·열·버튼·탭, 상품입력창 통합, 단계 6 재매칭 배치/UI는 제외했다.
- 구매만 rollback: `OFFICIAL_VOUCHER_V2_FEATURE_GATES.PURCHASE=false` 유지. 판매만 rollback: `SALE=false` 유지.
- 전체 rollback: 두 gate를 OFF로 유지한 채 이 단일 목적 commit을 revert한다. DB version·schema·migration·운영 데이터 변경이 없어 데이터 복구는 필요하지 않다.
