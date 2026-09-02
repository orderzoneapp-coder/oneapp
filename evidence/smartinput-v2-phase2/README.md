# NEXUS-SI-V2-02 공식 쓰기 경계 작업 기록

## 착수 기준

- 작업 ID: `NEXUS-SI-V2-02`
- 시작 SHA: `c38d0ccdbf8d5fe16d14b9a325ade064bed35795`
- 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 브랜치: `codex/nexus-si-v2-02-official-write-boundary`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-si-v2-write-boundary-20260902`
- 착수 상태: 전용 worktree clean, 기존 `C:\Users\USER\Documents\GitHub\oneapp` dirty checkout 보존
- 규범: `AGENTS.md` 2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` 2.1.21, `app-manifest.json` schema 1.3.8, `orderq/ARCHITECTURE.md` 0.8.1
- 업무 기준: 상위 개발명세 내부 v2.1, 개발로드맵 내부 v1.1 단계 2 / Gate G2, 개발이슈 처리기록, 단계 1 기준선 README·단위 특성화·브라우저 E2E

## 현재 상태와 목표 상태

- 현재 SmartInput 구매·판매 공식 모듈은 각각 `official-voucher-repository.js`를 직접 import하여 Draft 조회·저장과 공식 command 실행을 호출한다.
- 현재 `smartinput.js` 구매·판매 handler는 입력 준비, 기준정보 보강, 그룹별 공식 저장 반복, 결과 포인터와 화면 피드백을 함께 수행한다.
- 목표는 기존 builder·validator·resolver·inventory planner·Repository transaction 결과를 바꾸지 않고 `SmartInput UI → 구매/판매 Finalize Service → ORDER Q command Adapter → OfficialCommandGateway → OfficialVoucherRepository` 경계로만 분리하는 것이다.
- 단계 3 이후 대상인 V2 필수검사, 거래처 선택성, ID V2, 환산 제거, 실사 사용자 선택, feature gate 변경은 이 작업에 포함하지 않는다.

## 착수 시 직접 경로 목록

### 생산 코드의 Repository 직접 import

1. `smartinput/purchase-official-stage3.js` → `orderq/official-voucher-repository.js`
2. `smartinput/sale-official-stage4.js` → `orderq/official-voucher-repository.js`
3. `orderq/official-voucher-sync.js` → `orderq/official-voucher-repository.js`

### 현재 공식 변경 호출

- SmartInput 구매 finalize: Draft 조회·저장 후 `runCentralOfficialVoucherCommand()` 실행
- SmartInput 판매 finalize: Draft 조회·저장 후 `runCentralOfficialVoucherCommand()` 실행
- Cloud replay: `official-voucher-sync.js`가 `applyRemoteOfficialVoucherCommandPayload()`와 `applyRemotePendingInventoryResolutionPayload()`를 직접 호출
- 미매칭 재해결: Repository의 `resolveUnresolvedProductInventory()` 공개 함수가 있으며 현재 제품 호출자는 확인되지 않음
- 실사 checkpoint: Repository의 `recordInventoryCheckpoint()` 공개 함수가 있으며 현재 제품 호출자는 확인되지 않음
- 수정·취소: Core command 종류는 존재하지만 현재 제품 호출자는 확인되지 않음

### 테스트의 Repository 직접 import

- `scripts/test-smartinput-browser-e2e.mjs`가 Repository 성공·중복·rollback·Cloud replay 기준선을 직접 검증한다. 테스트 코드는 제품 소비자 경계 검사에서 제외하되 Gateway rollback 증거를 추가한다.

## 적용 경계와 충돌 점검

- SmartInput은 입력·Draft·화면 상태와 finalize 요청 조립을 유지한다.
- ORDER Q는 command Adapter, Gateway, Repository와 공식 문서·Revision·재고/미매칭·기본 AR/AP·local queue를 소유한다.
- Repository의 회사·Revision·멱등성·transaction 최종 방어는 유지한다.
- 새 NEXUS 공통 Gateway, 전역 Runtime, 범용 Core, DB schema/data migration을 만들지 않는다.
- Cloud replay·재매칭·수정·취소는 이번 SmartInput finalize 전환 범위 밖이며 owner Gateway 적용 후속 대상으로 기록한다.
- 확인한 규범·명세·현행 소스 사이에 단계 2 실행을 막는 충돌은 없다.

## 구현된 모듈 책임과 호출 흐름

| 모듈 | 책임 | 보존한 경계 |
|---|---|---|
| `smartinput/smartinput.js` | 입력·현재 작업본·그룹 조립·확인·busy 상태·성공/실패 안내 | 구매/판매 handler는 해당 Finalize Service만 호출하며 공식 ID·Store·transaction을 알지 않음 |
| `purchase-finalize-service.js` | 구매 그룹별 현행 validator 실행, 현행 producer/context 조립, 결과 수집 | 기존 weak 구매 validator, builder와 오류별 부분 성공 표시를 그대로 사용 |
| `sale-finalize-service.js` | 판매 그룹별 현행 customer/product/warehouse revision 및 DIRECT/ORDER_Q 행 보강, 결과 수집 | 판매 handler의 현행 master/date 검증 우회와 환산 값을 그대로 유지 |
| `purchase-official-stage3.js` / `sale-official-stage4.js` | 기존 ID·Draft·불변 command envelope builder와 retry 조립 | Repository 대신 ORDER Q command Adapter만 호출 |
| `orderq/official-command-adapter.js` | 구매/판매 업무별 find/begin/commit 명령을 owner Gateway 연산으로 번역 | 구매/판매 API는 분리하고 Gateway 안전경계만 공유 |
| `orderq/official-command-gateway.js` | ORDER Q owner façade, Repository port 위임 | 업무판단을 추가하지 않고 Repository의 회사·Revision·멱등성·transaction 방어와 반환/오류를 그대로 전달 |
| `orderq/official-voucher-repository.js` | 공식 문서·행·명령·Revision·재고/미매칭·기본 AR/AP·local queue transaction | 소스·DB schema·Store·동작 변경 없음 |

구현된 제품 호출은 다음과 같다.

`SmartInput UI → PurchaseFinalizeService 또는 SaleFinalizeService → 기존 구매/판매 builder/orchestrator → ORDER Q OfficialCommandAdapter → OfficialCommandGateway → OfficialVoucherRepository`

공통 validator, 기준정보 resolver와 inventory planner를 새 범용 모듈로 옮기지 않았다. Finalize Service는 현행 validator·준비된 resolver 결과를 port로 받고, Gateway는 Repository 내부 현행 `planOfficialVoucherCommand()` 경로를 그대로 사용한다.

## Repository 직접 import 전후와 공식 변경 경로

착수 전 생산 코드의 직접 import는 SmartInput 구매, SmartInput 판매, ORDER Q Cloud sync의 3곳이었다. 변경 후 `rg -n 'official-voucher-repository\.js' smartinput --glob '*.js'` 결과는 **0건**이다. 생산 코드 전체의 직접 import는 owner Gateway 1곳과 범위 밖 Cloud sync 1곳만 남는다.

| 변경 경로 | 단계 2 결과 |
|---|---|
| SmartInput 구매 finalize | Finalize Service와 ORDER Q Adapter/Gateway 뒤로 이동 |
| SmartInput 판매 finalize | Finalize Service와 ORDER Q Adapter/Gateway 뒤로 이동 |
| Cloud replay | `official-voucher-sync.js`의 두 remote apply 직접 호출 유지; 서버/Cloud 활성화와 함께 별도 owner 경계 전환 필요 |
| 미매칭 상품 재해결 | Repository 공개 함수는 있으나 현재 제품 호출자 없음; 단계 5 실사 결정·재매칭 구현 때 Gateway command로 연결 |
| 실사 checkpoint | Repository 공개 함수는 있으나 현재 제품 호출자 없음; 단계 5 owner 정책과 함께 연결 |
| 수정·취소 | Core command 종류만 있고 현재 제품 호출자 없음; 실제 제품 경로 도입 전에 같은 Gateway 정책을 적용 |

테스트의 Repository import는 성공·중복·transaction failure·Cloud replay의 저장 결과를 owner 최종 상태에서 검증하기 위한 white-box fixture이므로 생산 소비자 0건 계약에서 제외한다.

## 동작 보존과 rollback 증거

`scripts/test-smartinput-official-v2-baseline.mjs`가 단계 1 정상 결과와 현재 결함을 모두 동일하게 재현했다.

- 정상 구매 재고 `+2`, 판매 재고 `-3`, 0수량 이동 0건, 음수 허용, frozen Revision Snapshot 유지
- 회사 간 구매·판매 ID 충돌, 판매 다중그룹 ID 충돌 유지
- 구매 미등록 non-empty ID 및 판매 master/date 검증 우회 유지
- 거래처 공란 공식 commit 차단과 미검증 non-empty ID AR/AP 생성 유지
- 실사 이전·같은 날 효과의 자동 비소급과 기존 환산 재고효과 유지
- V2 필수검사, optional customer, ID V2, 환산 제거와 실사 선택은 기대값만 기록하고 구현하지 않음

브라우저 E2E는 UI에서 실제 구매·판매 저장을 실행해 기존 안내문구와 결과를 확인했다. 성공 기준선은 미매칭 대기효과 1건, payable 1건, 중복 command 멱등 결과, 재매칭 후 재고 3과 대기 0으로 동일하다.

기존 Repository 직접 rollback 검사와 새 Gateway 경유 rollback 검사를 함께 실행했다. 강제 `IndexedDB transaction failed` 뒤 Draft는 `status=DRAFT`, `revision=1`로 유지되고 voucher Revision·inventory·ledger·pending·command는 모두 0건이었다. 기존 검사는 finalize transaction 1회, queue와 unresolved product까지 부분 저장 0건임을 계속 확인한다.

## UI·클릭·화면·성능 비교

단계 1 `browser-baseline.json`과 단계 2 `browser-after.json`을 같은 Windows 10 / Headless Chrome 151 / ko-KR 환경에서 비교했다.

- DOM title, 탭·도구·버튼 문구와 순서, 13개 표 열, footer 순서, keyboard 계약: JSON exact match
- 구매·판매 입력값, 금액, label, parser/workbench/right-panel 폭: exact match
- 정상 공식 저장 클릭: 구매 6 → 6, 판매 6 → 6
- HTML·CSS·공통 UI·단축키 변경 파일: 0건

| 대표 흐름 | 단계 1 ms | 단계 2 ms | 차이 |
|---|---:|---:|---:|
| 직접입력 분석 | 178.77 | 174.60 | -4.17 |
| Excel 표 붙여넣기 | 67.22 | 82.06 | +14.84 |
| 자동저장 | 221.94 | 201.04 | -20.90 |
| 구매 공식 저장 완료 안내 | 98.83 | 162.28 | +63.45 |
| 판매 공식 저장 완료 안내 | 117.66 | 98.94 | -18.72 |

단일 브라우저 관측의 구매 저장은 63.45ms 증가했으나 0.2초 안에서 완료됐고, 판매와 나머지 대표 흐름은 같은 응답 범위다. 클릭·키입력 피드백 경로에는 신규 await, 팝업 또는 클릭을 추가하지 않았다. 화면 증거 8장은 `screenshots/`에 보존했다.

## 외부 요청·DB·배포 격리

`browser-after.json`의 제출용 run은 제품 스크립트 실행 전에 `Page.addScriptToEvaluateOnNewDocument`로 외부 변경 POST를 차단한다.

- 실제 외부 변경 요청: 0건
- 차단 기록: 기존 Apps Script URL의 official sync pull/push 시도 4건
- Cloud 계약 검사: 임시 `window.fetch` stub의 push/pull만 사용
- local fixture server write: 0건
- production IndexedDB write: 0건
- 임시 Chrome profile: run 종료 후 제거
- DB schema/data migration·초기화, Apps Script, feature gate, 배포 변경: 0건

## 테스트 결과

| 검증 | 결과 |
|---|---|
| 변경 모듈 Node syntax | PASS |
| Repository/manifest 계약 24 checks | PASS, warning 0 |
| 새 공식 쓰기 구조 계약 | PASS; SmartInput direct import 0, UI direct call 0, Adapter→Gateway→Repository |
| 단계 1 정상·결함 특성화 | PASS |
| SmartInput 브라우저 E2E | PASS |
| GitHub Actions `repository-validation.yml` 로컬 53개 command | 모두 PASS. 연속 실행 중 범위 밖 ItemMaster 브라우저 fixture가 1회 입력 로드 timing으로 실패했으나 즉시 단독 재실행 PASS, 이후 남은 command 모두 PASS |

원격 Draft PR의 Linux CI는 제출 뒤 별도로 확인한다.

## Rollback

이 작업은 schema/data migration과 생산 DB 쓰기가 없으므로 코드 rollback만 필요하다. PR merge 전에는 브랜치/worktree를 폐기하면 되고, merge 뒤에는 이 작업 commit을 `git revert`하면 된다. Repository·DB·Cloud 복구 작업은 필요하지 않으며 기존 `oneapp-orderq-pre-m1-v6` v7 데이터는 건드리지 않는다.

PM Gate G2 검증 전에는 병합하지 않으며 단계 3 작업을 시작하지 않는다.
