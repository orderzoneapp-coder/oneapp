# NEXUS-SI-V2-03 필수검사·Snapshot·공식 ID 작업 기록

## 착수 기준

- 작업 ID: `NEXUS-SI-V2-03`
- 기준 SHA: `269e0c949f3b63ca78834eccf55d309e217d3e7f` (`origin/main`, 단계 2 merge SHA와 일치)
- 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 브랜치: `codex/nexus-si-v2-03-validation-snapshot-id`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-si-v2-stage3-validation-id-20260902`
- 착수 상태: 전용 worktree clean. 기존 `C:\Users\USER\Documents\GitHub\oneapp` main checkout의 사용자 변경은 읽기 확인만 하고 보존했다.
- 규범: `AGENTS.md` 2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` 2.1.22, `app-manifest.json` schema 1.3.8, `orderq/ARCHITECTURE.md` 0.8.2
- 업무 기준: 상위 개발명세 내부 v2.1, 개발로드맵 내부 v1.1 단계 3 / Gate G3-P·G3-S, 개발이슈 처리기록의 2026-09-02 20:31 KST 단계 3 착수 기준
- 문서 SHA-256: `AGENTS.md` `1103AF32615F63FDC9B555B5F6EE7E405F6612BCADF7E37BC79FC3E29B9BCD0A`, `roles/DEVELOPER.md` `3ABF30674D6B346F36CDE254BDF086976616AD81986EC71BB9AA236690703034`, `APP_ARCHITECTURE.md` `5DFAE0752721E2D9EF27B14BE2FCC93F28F95395F6A4AE0ECACE3FE90AE21BED`, `app-manifest.json` `F3BBDA545C7553524E0E496F669BFBE9CD3CF7914D99E69AE6601C4607C9F694`, `orderq/ARCHITECTURE.md` `4CA6380664C31E70C770D59C027D150F0178DFF561F8BBE02F36C6722E173A3D`
- PM 문서 SHA-256: 명세 `D8BE9CFB520CDD89E93EB692E7C9A686BE86922C446FE1C49BAF6BFC8718C161`, 로드맵 `E8CC957AE93E946050623D038AB66BBF1CF482522E12AEF9CEC256F95071E56D`, 이슈 기록 `1C09B2C0403A65B205662BEAD1ABC080C9FF9480CFC5D5C02393C6F0F0723100`

## 현재 상태와 목표 상태

- 현재 단계 2 경계는 `SmartInput UI → 구매/판매 Finalize Service → ORDER Q command Adapter → OfficialCommandGateway → OfficialVoucherRepository`를 사용하지만, 기존 V1 ID·검증·Snapshot 형태와 현재 재고/거래처/실사 동작을 그대로 위임한다.
- 현재 구매·판매 문서 ID는 회사가 안정 입력에 없고, 판매 문서 ID는 `voucherGroupKey`가 없어 회사 A/B와 판매 다중그룹 충돌 기준선이 재현된다.
- 현재 Repository는 동일 `commandId` 영수증을 payload digest 비교 없이 중복 성공으로 반환한다. Revision·transaction 원자성은 단계 1/2 기준선에서 이미 고정됐다.
- 목표는 숫자 변환 전 공란 판정, 빈 행/활성 행 구분, 날짜 day 기본값, 명시 금액 보존, 확정 행 Snapshot, 회사·판매그룹 범위 ID V2와 Gateway/Repository 재검사를 추가하는 것이다.
- 구매와 판매의 V2 feature gate는 독립적으로 기본 비활성화한다. 단계 3 계약은 격리 테스트에서만 각 gate를 켜 검증하며 기존 공식 V1 경로 또는 Pilot를 부분 V2로 전환하지 않는다.

## 범위·소유권·충돌 점검

- SmartInput은 작업본·입력·자동저장 소유와 ORDER Q command Adapter 소비자 역할을 유지한다. ORDER Q만 Gateway·Repository와 공식 문서/행/명령/Revision/effect transaction을 소유한다.
- HTML·CSS·공통 UI·버튼·단축키·표 구조를 변경하지 않는다. 필수 오류는 기존 상태/토스트 경계를 재사용할 수 있는 오류 결과로 제공하고 고정 UI를 만들지 않는다.
- 단계 4의 재고 공식·미매칭 상태·거래처 선택성/기본 채권채무 변경, 단계 5의 실사 사용자 결정, 단계 7의 수정·취소, Cloud 활성화·서버 배포·V1 migration·단위환산 변경은 제외한다.
- `APP_ARCHITECTURE.md` 상단 current-source baseline은 단계 1 merge SHA `c38d0c...`로 남아 있으나, 본문은 단계 2 경계를 현재 사실로 기록하고 실제 `origin/main`은 `269e0c...`다. 이번 업무코드 단계에서 아키텍처 문서를 부수적으로 수정하지 않고 상태 표기 지연으로만 기록한다.
- 확인한 상위 규범·PM 명세·로드맵·현재 owner 경계 사이에 단계 3 구현을 막는 정책 충돌은 없다.

## 검증·제출 결과

### 구현과 변경 파일 역할

- `orderq/official-voucher-v2-contract.js`: 숫자 변환 전 공란 판정, 빈 행/활성 행 구분, 날짜 확정, 금액 출처 보존, 행 Snapshot, ID V2와 명령 envelope 검사를 담당하는 순수 owner 계약이다.
- `orderq/official-command-gateway.js`: 구매/판매 V2 gate를 서로 독립된 `false` 기본값으로 제공하고, 회사·명령 형식·identity version·명령/멱등키·payload·Revision 계약을 Repository 진입 전에 검사한다. 공개 Gateway API version은 기존 V1을 유지한다.
- `orderq/official-voucher-repository.js`: Draft와 commit 양쪽에서 회사·문서·그룹·행 범위를 재검사하고, 동일 명령의 payload/scope 충돌을 확인한다. V2 확정 identity/Snapshot에는 이후 단계의 자동 미매칭 갱신을 적용하지 않는다.
- `orderq/official-voucher-core.js`: V2 행 범위와 command를 다시 검사하고 회사별 Revision ID 및 확정 시점의 전체 상품 Snapshot을 불변 revision snapshot에 포함한다. 기존 V1 plan/effect 규칙은 유지한다.
- `smartinput/purchase-official-stage3.js`, `smartinput/sale-official-stage4.js`: V2 identity 요청에만 preflight·Snapshot·회사별 문서/행/명령 ID를 만들며, 판매 문서 ID에는 `voucherGroupKey`를 포함한다. V1 호출 결과는 baseline 그대로다.
- `smartinput/purchase-finalize-service.js`, `smartinput/sale-finalize-service.js`: 명시적 `identityVersion`만 builder에 전달한다. 현재 UI는 이를 전달하지 않으므로 기존 공식 V1 경로가 유지되고 Pilot는 켜지지 않는다.
- `scripts/test-smartinput-v2-validation-identity.mjs`: 구매·판매의 입력 검증, 날짜/금액, Snapshot, 회사/그룹별 ID, 명령 충돌, Revision 및 gate 독립성을 검증한다.
- `scripts/fixtures/smartinput-v2-stage3-browser-scenario.js`, `scripts/test-smartinput-browser-e2e.mjs`: 격리 IndexedDB에서 실제 Gateway/Repository V2 commit·retry·충돌·rollback을 검증하고 기존 UI 회귀 증거를 함께 수집한다.
- `.github/workflows/repository-validation.yml`: 단계 3 순수 계약 검사를 PR CI에 추가한다.
- HTML·CSS·DOM·버튼·단축키 소스는 변경하지 않았다.

### Gate 증거

- 구매 Gate G3-P: [G3-P.md](./G3-P.md)
- 판매 Gate G3-S: [G3-S.md](./G3-S.md)
- 두 gate는 `OFFICIAL_VOUCHER_V2_FEATURE_GATES`에서 각각 `PURCHASE: false`, `SALE: false`이며, 한쪽만 활성화한 자동검사에서 반대쪽 명령이 차단됨을 확인했다.

### 단계 1·2 baseline 비교

- `node scripts/test-smartinput-official-v2-baseline.mjs`: PASS. 단계 1에서 기록한 V1 정상 동작과 현행 gap이 모두 그대로 재현됐다. 이는 V2를 기존 경로에 혼합 활성화하지 않았다는 비교 증거다.
- `node scripts/test-smartinput-official-write-boundary.mjs`: PASS. SmartInput의 Repository 직접 import는 0건이고 `Finalize Service → Adapter → Gateway → Repository` owner 경계가 유지됐다.
- 기준 SHA의 detached 임시 비교 worktree와 현재 브랜치에서 같은 고정 입력을 실행해 V1 구매·판매 문서 ID, `draftIntentDigest`, command key 목록, line key 목록이 byte-for-byte 동일함을 확인했다. 비교 worktree는 즉시 제거했다.
- `browser-baseline.json`과 `browser-after.json` 비교: DOM 구조 동일, keyboard contract 목록 동일, 구매/판매 저장 클릭 수 각각 `6 → 6`, 실제 외부 변경 요청 `0 → 0`, 로컬 fixture write `0 → 0`.

### 자동검사 범위와 결과

- `node scripts/test-smartinput-v2-validation-identity.mjs`: PASS.
  - 구매·판매 각각 코드만/이름만/둘 다 공란, 수량·단가 공란/`0`/음수/`NaN`/무한대/비숫자, 완전 빈 행을 검사했다.
  - `YYYY-MM` 및 `YYYY-MM-`은 그 달 1일, 전체 공란·잘못된 달력 날짜는 차단됨을 검사했다.
  - 명시 금액 `0`·음수 보존과 미명시 금액 `수량×단가` 계산, 계산 출처 재검사를 확인했다.
  - 구매·판매 Snapshot의 코드·이름·규격·단위·수량·단가·금액·원본 코드/이름·매칭 근거를 확인했다.
  - 회사 A/B의 문서/행/명령/Revision ID 분리, 판매 다중그룹의 문서/행/명령 ID 분리, 배열 재정렬 안정성을 확인했다.
  - 명령 형식, identity version, `commandId=idempotencyKey`, 동일 ID의 변경 payload, expected Revision, 구매/판매 gate 독립성을 확인했다.
- `node scripts/validate-repository.mjs`: PASS (`24 checks`, warning 0).
- SmartInput 관련 CI 명령 12개와 `test-client-safety.mjs`: 모두 PASS. 최종 실행에서 10,000행 mapping `804.2ms`, 대형 reference snapshot `559.5ms`였다.
- `git diff --check`: PASS. 출력은 Windows checkout의 LF→CRLF 안내뿐이며 whitespace 오류는 없다.

### 실제 브라우저 격리 검증

- `node scripts/test-smartinput-browser-e2e.mjs`: PASS. `mkdtemp` 전용 Chrome profile과 로컬 read-only fixture server를 사용했고 제품 module 실행 전 외부 POST guard를 설치했다.
- 직접입력, Excel 표 붙여넣기, 자동저장/작업본 복구, 구매·판매 공식 저장 대표 흐름, 일반/다크, 390px 모바일, DOM, 버튼 순서/명칭, 단축키, 클릭 수를 확인했다.
- 단계 3 실제 IndexedDB 결과: 구매/판매 동일 command retry 모두 `duplicate=true`이고 각 command·revision 효과는 1건, 잘못된 expected Revision·변경 payload·회사 불일치는 거부됐다.
- 구매·판매 각각 강제 unique-index 충돌 뒤 V2 문서는 `DRAFT`, revision `1`, 행 `DRAFT`이며 새 revision/inventory/ledger/pending/command 효과는 모두 0건이었다.
- 기준상품 입력 객체의 이름·코드·ID를 변경/삭제한 뒤 다시 읽은 구매 Snapshot은 확정 당시 이름·코드를 유지했다. 판매 Snapshot 불변은 순수 core 검사에서도 별도로 확인했다.
- 실제 외부 mutating request 0건, 생산 IndexedDB write 0건, local fixture write 0건. guard가 운영 Apps Script POST 4건을 제품 실행 전에 차단했다. console error와 runtime exception은 0건이다.
- 단계 1 대비 성능: 직접입력 분석 `178.77 → 140.64ms`, Excel 표 붙여넣기 `67.22 → 53.92ms`, 자동저장 `221.94 → 225.56ms`. 사용자 흐름 회귀 기준 안이다.
- 기계 증거: [browser-after.json](./browser-after.json), 화면 증거: [screenshots](./screenshots/).

### 데이터·소유권·범위 판정

- SmartInput은 consumer와 작업본 owner만 유지하고 공식 문서/행/명령/Revision/transaction은 ORDER Q가 소유한다. Product/Customer/다른 앱 Store 원본에는 쓰지 않는다.
- 단계 4 재고 공식 변경·미매칭 영구 상태/UI·거래처 선택성/기본 채권채무 조건, 단계 5 실사 선택, 단계 7 수정·취소, Cloud/Apps Script, V1 migration, 옵션/단위환산은 구현하지 않았다.
- 현재 V1 공식 경로와 Cloud/Pilot 상태는 그대로이며 V2는 명시적 identity version과 독립 gate가 모두 있어야 진입한다.

### Rollback과 남은 범위

- 기능 rollback은 V2 gate가 기본 OFF이므로 먼저 OFF 상태를 유지하고 이 PR commit을 `git revert`하면 된다. DB version·migration·운영 데이터·외부 배포 변경이 없어 별도 데이터 복구는 필요하지 않다.
- 테스트 데이터는 실행마다 임시 Chrome profile/격리 IndexedDB에만 생성되고 종료 시 제거된다.
- 남은 범위는 로드맵 단계 4 이후 전부다. 특히 재고·미매칭·거래처 선택성/채권채무, 실사 결정, 수정·취소는 이 PR의 완료로 간주하지 않는다.

### Git 제출

- 구현·검증 commit: `ae9f96183b87d46fc627b88ae4ddf44ed268c17f`
- Draft PR: `https://github.com/orderzoneapp-coder/oneapp/pull/482`
- PR base/head: `main@269e0c949f3b63ca78834eccf55d309e217d3e7f` → `codex/nexus-si-v2-03-validation-snapshot-id`
- CI: `ONEAPP repository validation` run `33628033438`. 첫 시도는 기존 input-template browser 검사의 Chrome debugging port 기동 timeout으로 실패했고 변경 코드 실패는 없었다. 실패 job만 재실행한 두 번째 시도는 `1m4s`에 PASS했다: `https://github.com/orderzoneapp-coder/oneapp/actions/runs/33628033438/job/100240637248`.
- PR은 Draft/Open/Mergeable 상태다. PM 승인 전 Ready 전환·병합·배포·Pilot 활성화는 금지 상태다.
