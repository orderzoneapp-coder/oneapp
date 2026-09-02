# NEXUS-SI-V2-04 정상 재고효과·미매칭 상품·기본 원장효과 작업 기록

## 착수 기준

- 작업 ID: `NEXUS-SI-V2-04`
- 기준 SHA: `0492147cd3a9233e2b74d55fdbd7d8322305f5cc` (단계 3 merge SHA, 착수 당시 `origin/main`과 일치)
- 브랜치: `codex/nexus-si-v2-04-inventory-unresolved-ledger`
- 전용 worktree: `C:\Users\USER\Documents\GitHub\oneapp-nexus-si-v2-04-inventory-unresolved-ledger`
- 기준 저장소의 main checkout은 읽기 확인과 `origin/main` fetch만 수행했고 사용자 변경을 수정·reset·clean하지 않았다.
- 규범: `AGENTS.md` 2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` 2.1.22, `app-manifest.json` schema 1.3.8, `orderq/ARCHITECTURE.md` 0.8.2
- 업무 기준: 개발명세 내부 v2.1, 개발로드맵 내부 v1.1 단계 4 / Gate G4-P·G4-S, 최신 개발이슈 처리기록
- 착수 문서 SHA-256: `AGENTS.md` `1103AF32615F63FDC9B555B5F6EE7E405F6612BCADF7E37BC79FC3E29B9BCD0A`, `roles/DEVELOPER.md` `3ABF30674D6B346F36CDE254BDF086976616AD81986EC71BB9AA236690703034`, `APP_ARCHITECTURE.md` `5DFAE0752721E2D9EF27B14BE2FCC93F28F95395F6A4AE0ECACE3FE90AE21BED`, `app-manifest.json` `F3BBDA545C7553524E0E496F669BFBE9CD3CF7914D99E69AE6601C4607C9F694`, `orderq/ARCHITECTURE.md` `4CA6380664C31E70C770D59C027D150F0178DFF561F8BBE02F36C6722E173A3D`
- PM 문서 SHA-256: 명세 `D8BE9CFB520CDD89E93EB692E7C9A686BE86922C446FE1C49BAF6BFC8718C161`, 로드맵 `E8CC957AE93E946050623D038AB66BBF1CF482522E12AEF9CEC256F95071E56D`, 이슈 기록 `6229D593092C9BE345BEF38CABA5ECC7227E9850AB20D0D47BC69982FC67D14F`

## 구현 결과

- SmartInput V2 Finalize에서 현재 회사의 활성 기준정보를 읽어 `회사 + 사용자 상품코드`와 `회사 + 거래처코드`로만 정확매칭한다. 이름은 Snapshot·검수 정보일 뿐 자동매칭 키로 쓰지 않는다.
- 상품코드는 Product owner와 동일하게 외곽 trim 뒤 원문 문자열을 key로 사용한다. 대소문자·전각/반각·내부 공백이 다른 코드는 자동매칭하거나 같은 미매칭 ID로 합치지 않는다. ERP 코드 원문과 앞자리 0을 보존한다.
- 거래처코드는 Customer owner의 `normalizedCustomerCode` 규칙인 NFKC·한국어 locale 소문자·공백 축약을 별도로 사용한다. 상품코드 정규화와 공유하지 않는다.
- 기존 `productId`는 정확매칭 결과가 있을 때만 비노출 기술키로 전달하며, 입력에 남아 있던 stale ID는 매칭 결과로 덮어쓰거나 제거한다.
- 정확매칭 상품만 공식 재고효과를 만든다. 구매는 `+수량`, 판매는 `-수량`, 수량 0은 `ZERO_EFFECT`이며 V2의 `conversionFactor`는 항상 1이다.
- 미매칭 코드 행과 이름만 있는 행도 공식전표·확정 Snapshot을 만든다. 공식 재고효과는 만들지 않고 `UNRESOLVED_PRODUCT` 검수 기록에 원본 코드·상품명·규격·단위와 문서·행·Revision 연결을 저장한다. 같은 미매칭 코드를 여러 행에서 사용하면 하나의 검수 대상에 행별 링크가 누적된다.
- 거래처는 선택 입력이다. 정확한 회사별 코드 매칭 때만 구매 채무 또는 판매 채권을 최종금액 기준으로 만든다. V2 원장 `effectiveAt`은 전표 `businessDate`, `occurredAt`은 명령 기록시각으로 분리하며 Revision 판단에도 둘을 보존한다. 없음·미매칭이면 전표는 확정하고 원장효과는 만들지 않으며 Revision의 `partnerEffectDecision`에 이유와 발생일을 남긴다.
- 확정 transaction은 공식전표/행/Revision/재고효과 또는 미매칭 검수/기본 원장효과 또는 미생성 이유/명령/local sync queue를 함께 저장한다. 강제 unique-index 실패는 확정 부분 저장 0건이며 동일 명령 재시도는 효과를 중복 생성하지 않는다.
- ORDER Q가 Gateway·Repository·공식 자료의 owner이고 SmartInput은 consumer로 유지된다. Product/Customer 기준정보 저장소에는 쓰지 않는다.

## 계약 보존과 범위 통제

- 단계 3 필수검사와 금액 계약을 유지한다: 회사/모드/일자/창고, 활성 행의 코드 또는 이름, 수량·단가 공란 차단, 0·음수 허용, 명시 최종금액 보존 또는 `수량×단가` 계산.
- 구매·판매 V2 gate는 `PURCHASE: false`, `SALE: false` 기본값과 독립 제어를 유지한다. 검증 fixture에서만 둘을 켰다.
- HTML은 module cachebuster만 갱신했다. CSS·DOM·디자인·레이아웃·기존 탭·버튼·열·단축키·사용자 흐름은 바꾸지 않았다.
- Pilot, Cloud Push/Pull 활성화, 실사충돌 선택 팝업, 수정·취소, Draft V2, 데이터 migration, 영구 검수 UI, 상품입력창 통합, 옵션·단위환산, 마감·세금계산서·상계·조정계정은 구현하지 않았다.

## 검증 결과

- `node scripts/test-smartinput-v2-inventory-unresolved-ledger.mjs`: PASS. 구매·판매 정확/미매칭/이름-only/0·음수/선행 0/거래처 없음·미매칭/Revision 사유/원자성/멱등성/owner 쓰기 금지를 검증했다. 상품 `ABC↔abc`, `０００７↔0007`, 내부 공백 차이가 자동매칭되지 않고 서로 다른 미매칭 ID를 유지하며, 고객 정규화 매칭은 유지됨을 확인했다.
- `node scripts/test-smartinput-v2-validation-identity.mjs`: PASS. 단계 3 필수검사·Snapshot·ID·gate·payload/revision 충돌 계약이 유지됐다.
- `node scripts/test-smartinput-official-v2-baseline.mjs`, `node scripts/test-smartinput-official-write-boundary.mjs`, `node scripts/test-orderq-official-voucher-mvp-core.mjs`, `node scripts/test-orderq-inventory-rematch-boundary.mjs`: PASS.
- `node scripts/validate-repository.mjs`: PASS (`24 checks`, warning 0).
- 기존 SmartInput/parser/reference/input-template/client-safety/공통 UI 회귀 검사: PASS.
- `node scripts/test-smartinput-browser-e2e.mjs`: PASS. 단계 3 증적과 비교해 DOM·키보드 계약이 동일하고 구매/판매 각 `6 → 6` click 흐름을 유지하면서 실제 IndexedDB owner transaction을 검증했다.
- 브라우저 구매 결과: 정확매칭 재고 `+10 APPLIED_NORMAL`, `0 ZERO_EFFECT`; 미매칭 3행의 공식재고 0건·pending 3건; unresolved 대상 2건과 링크 수 `2/1`; 정확 거래처 채무 1건 `2,661`; 채무와 Revision 판단은 `effectiveAt=2026-08-05`, `occurredAt=2026-09-02T10:00:00.000Z`; 같은 명령 재시도 후 문서 1·Revision 1·명령 1·queue 1·재고효과 2로 유지됐다. 저장된 원장 발생일을 변조한 retry는 Repository가 거부했다.
- 브라우저 판매 결과: 정확매칭 재고 `-4`; 정확 거래처 채권 1건 `400`에 같은 전표일/명령시각 분리 저장; 별도 미매칭 거래처 전표는 채권 0건이고 Revision 사유 `CUSTOMER_CODE_UNMATCHED`와 두 날짜를 보존했다.
- 강제 실패 결과: 전표/행은 기존 Draft로 남고 새 Revision·재고·pending·unresolved·원장·명령·queue는 모두 0건이다.
- 실제 외부 mutating request 0건, 생산 IndexedDB write 0건, local fixture write 0건이다. Cloud 호출은 임시 `fetch` stub에서만 모의했고 운영 Apps Script POST 4건은 네트워크 전에 차단됐다.
- 기계 증적: [browser-after.json](./browser-after.json), 화면 증적: [screenshots](./screenshots/), 구매 Gate: [G4-P.md](./G4-P.md), 판매 Gate: [G4-S.md](./G4-S.md).

## Rollback

- 구매만 rollback: `OFFICIAL_VOUCHER_V2_FEATURE_GATES.PURCHASE=false`를 유지하고 판매 gate는 독립적으로 둔다.
- 판매만 rollback: `OFFICIAL_VOUCHER_V2_FEATURE_GATES.SALE=false`를 유지하고 구매 gate는 독립적으로 둔다.
- 전체 코드 rollback: 두 gate를 OFF로 유지한 뒤 이 PR commit을 revert한다.
- DB version·migration·운영 데이터·외부 배포 변경이 없으므로 별도 데이터 복구는 필요하지 않다.
