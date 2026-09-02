# NEXUS-SI-V2-01 현재 동작 기준선 및 결함 재현 증거

## 실행 메타데이터

- 작업 ID: `NEXUS-SI-V2-01`
- 시작 SHA: `af1b4917c838d76db0ebc1c5ed34a64697a6a12c`
- 브랜치: `codex/nexus-si-v2-01-baseline-tests`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-si-v2-baseline-tests-20260902`
- 규범: `AGENTS.md` 2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` 2.1.21, `app-manifest.json` schema 1.3.8, `orderq/ARCHITECTURE.md` 0.8.1
- 업무 기준: 상위 개발명세 내부 v2.1, 개발로드맵 내부 v1.1 단계 1 / Gate G1, 개발이슈 처리기록
- 제품 JavaScript/HTML/CSS 변경: 0건
- DB schema/data, feature gate, Cloud/Apps Script, 배포 변경: 0건

## 자동화 범위

`scripts/test-smartinput-official-v2-baseline.mjs`는 제품 모듈을 직접 사용해 현재 공식전표 ID, 그룹, 검증, 매칭, 환산, Snapshot, 재고, AR/AP, 실사 경계를 특성화한다. 현재 결함은 `CURRENT_BASELINE_GAP`으로 고정하며 V2 목표 기대값을 통과 조건으로 가장하지 않는다.

`scripts/test-smartinput-browser-e2e.mjs`는 매 실행마다 `mkdtemp`로 만든 새 Chrome 프로필과 로컬 read-only fixture server만 사용한다. 직접입력, 표 붙여넣기, 자동저장·복구, 구매·판매 공식 저장, DOM/레이아웃, 단축키, IndexedDB 성공 및 rollback을 한 브라우저에서 검증한다. 외부 변경 요청은 페이지 제품 스크립트보다 먼저 설치한 테스트 전용 `fetch` 가드로 차단한다.

## 정상 동작 기준선

| 기준선 | 현재 기대값 | 자동 증거 |
|---|---|---|
| 직접입력 | 원문 유지, 분석 후 2행, 수량 2/3, 빈 trailing row 1개 | 브라우저 E2E |
| Excel 표 붙여넣기 | 헤더명 기준 재정렬, 빈 행 제외, 수량 7/9, undo 복구 | 브라우저 E2E |
| 작업본 자동저장 | `oneapp-smartinput` v5 `autosave/current` 1건 덮어쓰기 | 브라우저 E2E |
| 작업본 복구 | 화면 임시값을 버리고 마지막 autosave 복구, reset 후 재복구 | 브라우저 E2E |
| 구매 현재 저장 | 격리 customer/product/warehouse fixture로 공식 구매전표 1건 저장 | 브라우저 E2E |
| 판매 현재 저장 | 동일 격리 fixture로 공식 판매전표 1건 저장 | 브라우저 E2E |
| 정확 상품 매칭 | 구매 재고 `+2`, 판매 재고 `-3`; 구매채무/판매채권 생성 | 단위 특성화 |
| 0/음수 수량 | 0은 inventory movement 0건, 음수 구매 `-2`, 음수 판매 `+3` | 단위 특성화 |
| 미매칭 상품 | 전표/AR·AP 유지, 재고 movement 없음, pending effect 생성 | 단위 + 브라우저 E2E |
| 확정 Snapshot | frozen command envelope와 Revision `afterSnapshot`이 원본 변경과 분리 | 단위 특성화 |
| 중앙 저장 | 문서·행·명령·Revision·재고·AR/AP·pending·미해결·queue 9개 store를 하나의 readwrite transaction으로 처리 | 브라우저 E2E |
| 실패 rollback | unique-index 충돌 주입 후 DRAFT Revision 1 유지, Revision/재고/AP/pending/command/queue/미해결 부분 저장 각각 0건 | 브라우저 E2E |

## 현행 결함과 V2 목표의 분리

| 항목 | 현행 재현 결과 | 현행 기대값으로 고정한 조건 | V2 목표 기대값(이번 단계 미구현) |
|---|---|---|---|
| 회사가 다른 동일 원본 ID | 재현 | 회사 A/B의 같은 source로 구매 ID와 판매 ID가 각각 동일 | companyId를 ID seed에 포함해 서로 달라야 함 |
| 한 원본의 판매 다중그룹 ID | 재현 | 같은 sheet `sourceDocumentKey`를 가진 거래처 A/B는 `voucherGroupKey`와 Stage 1 idempotency가 달라도 공식 `salesDocumentId`가 동일 | company + source + saleGroupKey별 서로 다른 ID |
| 필수 검증 우회 | 재현 | 구매는 weak adapter validator가 미등록 non-empty customer ID를 허용; 판매 handler는 master validator를 호출/전달하지 않아 미등록 ID와 공란 판매일자도 core까지 통과 | 날짜/창고/활성행/수량·단가를 owner gateway에서 일관되게 검증 |
| 수량·단가 공란의 0 변환 | 공식 구매·판매 commit에서는 미재현; legacy helper에서 조건부 재현 | grid/Stage 1은 공란을 `null`로 유지하고 official builder가 차단한다. 단, weak 구매 preflight는 `Number(null)`을 유한수로 보고 legacy order payload는 공란 공급가액을 `0`으로 만든다 | 숫자 변환 전 공란 차단, 0은 명시 입력만 허용 |
| 거래처 미입력·미매칭 | 복합 재현 | ID 공란은 current core가 전표를 차단한다. non-empty 미검증 ID는 우회 시 전표와 AR/AP를 함께 만든다 | 거래처 없이도 전표 허용, 정확매칭 때만 AR/AP 기본효과 |
| 실사 이전/같은 날 시각 불명 | 재현 | 전표일이 checkpoint 이전 또는 같은 date-only이면 `RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE`로 자동 비소급; 이후 날짜만 movement 생성 | 포함/미포함/취소를 사용자가 선택 |
| 옵션·단위환산 충돌 | 재현 | 구매 `conversionFactor=12`는 `2 BOX`를 재고 `+24`, 판매 `actualToBaseFactor=12`는 `-24`로 반영 | 공식 gateway의 업무 환산 제거, 사용자 입력 수량 그대로 효과 |

추정 실패 테스트는 만들지 않았다. 공란 숫자의 공식 commit은 현재 `finiteRequired`/`finite`에서 실제로 차단되므로 “공식전표가 0으로 저장된다”는 실패 기대값을 두지 않았다. 대신 0으로 바뀌는 실제 compatibility helper와 그 helper가 공식 구매·판매 경로에 사용되지 않는 조건을 함께 기록했다.

## 실제 소스 경로와 실행 조건

| 증거 | 소스 경로 | 실행 조건 |
|---|---|---|
| 구매 ID에 company 없음 | `smartinput/purchase-official-stage3.js` `derivePurchaseDraftIdentity()` | `purchaseDocumentId` hash가 `sourceType + sourceDocumentKey`만 사용 |
| 판매 ID에 company/group 없음 | `smartinput/sale-official-stage4.js` `deriveSaleDraftIdentity()` | `salesDocumentId` hash가 `sourceType + sourceDocumentKey`만 사용 |
| sheet key 다중그룹 공유 | `smartinput/multivoucher-stage1.js` `groupVoucherRows()` | role별 group은 분리하지만 group root에 같은 `row.sourceDocumentKey` 복사 |
| 구매 master 검증 우회 | `smartinput/legacy-integration-adapter.js` `validatePurchaseGroup()` 및 `smartinput/smartinput.js` `completePurchaseOfficial()` | UI가 Stage 3 강한 validator가 아니라 adapter의 weak validator를 import |
| 판매 master/date 검증 우회 | `smartinput/sale-official-stage4.js` `validateSaleGroup()`/`postSaleGroup()` 및 `smartinput/smartinput.js` `completeSaleOfficial()` | UI가 `validateSaleGroup()`을 호출하지 않고 `context.masters`도 전달하지 않음 |
| 숫자 공란 유지/조건부 0 | `smartinput/smartinput-contract.js` `numberOrNull()`, `smartinput/multivoucher-stage1.js` `normalizeStage1Row()`/`buildOrderGroupPayload()` | grid는 null 유지, legacy payload의 `Number(row.quantity || 0)`에서만 0 |
| 거래처 차단/AR·AP 결합 | `orderq/official-voucher-core.js` `partnerId()`/`ledgerEntry()` | partner ID가 비면 차단, non-empty ID면 ledger 생성 |
| 실사 자동 비소급 | `orderq/inventory-rematch-core.js` `effectiveTime()`/`planPendingInventoryResolution()` | date-only를 UTC 일말로 보고 effect `<=` checkpoint이면 movement 생략 |
| 현재 환산 | `smartinput/purchase-official-stage3.js`/`smartinput/sale-official-stage4.js` draft builders | factor로 `baseQuantity` 계산 후 core가 base quantity를 재고효과로 사용 |
| 한 transaction/rollback | `orderq/official-voucher-repository.js` `runCentralOfficialVoucherCommand()` | 9개 store transaction 안에서 plan 전체 기록 후 `transactionDone()` 1회 |

## UI DOM, 스크린샷, 클릭 수와 응답시간

DOM baseline은 `browser-baseline.json`에 다음을 고정한다.

- 전표 탭 순서: 주문서 → 구매 → 판매 → 견적서
- 원본 입력 도구: Excel 파일, 음성, 직접 텍스트/붙여넣기 영역
- 주요 버튼: 자동저장 복구, 다시 분석, 빈 행 추가, 전표 초기화, 저장, 카톡 공유, EXCEL
- 테이블 열 순서: No., 상품 검색, 품목코드, 품목명, 규격, 수량, 단위, 단가, 공급가액, 메모, 적요(직원), 공지단가, 상태
- footer 버튼 순서와 1920px desktop의 app bar/parser/workbench/grid/right panel 좌표
- 실제 행사한 키보드 계약: grid ArrowRight, 열 폭 ArrowRight, parser 폭 ArrowRight, right panel 폭 ArrowLeft, 기준정보 Enter, 상품 선택 Enter

Windows 10 / Headless Chrome 151 / ko-KR, 동일 실행의 1920×1080 desktop 기준 단일 관측값이며 절대 목표가 아니다.

| 흐름 | 클릭 기준 | 응답시간 |
|---|---:|---:|
| 직접입력 → 분석 | 1 | `browser-baseline.json` `flows.directInput.responseMs` |
| Excel 표 Ctrl+V | 0 | `flows.excelTablePaste.responseMs` |
| 자동저장 | 0 | `flows.autosave.responseMs` |
| 자동저장 복구 | 1 | 완료 여부 고정, 시간 목표 없음 |
| 구매 공식 저장 | 6 | `flows.currentOfficialSaveEntry[purchase].saveFeedbackMs` |
| 판매 공식 저장 | 6 | `flows.currentOfficialSaveEntry[sale].saveFeedbackMs` |

구매·판매 6클릭의 측정 경계는 전표 탭, 빈 행, 거래처 찾기, 거래처 checkbox, 선택 적용, 저장이다. 필드 입력과 상품 정확선택은 키보드로 수행했다.

보존 화면:

- `smartinput-v2-baseline-purchase.png`
- `smartinput-v2-baseline-sale.png`
- `smartinput-0a-1920-light.png`, `smartinput-0a-1920-dark.png`
- `smartinput-0a-photo-reload.png`, `smartinput-estimate-library-cards.png`
- `smartinput-reference-mobile.png`, `smartinput-0a-mobile.png`

## 생산 DB·Cloud 격리 증거와 안전 발견

최종 기준선 run은 임시 Chrome profile만 사용했고 종료 후 profile을 삭제했다. `browser-baseline.json`에는 격리 DB 이름/버전, 실제 외부 변경 Network 요청 0건, local fixture server write 0건, production IndexedDB write 0건, transaction rollback의 부분 저장 0건을 기록한다. Cloud push/pull 계약 검사는 `window.fetch` 임시 stub 안에서만 수행한다.

중요: 외부 변경 가드를 추가하기 전 최초 진단 run에서 기존 E2E가 기본 Apps Script URL로 POST 2회를 시도한 사실을 Network 계측으로 발견했다. 응답 완료와 원격 쓰기 성공 여부는 확인하지 않았으며 추가 원격 조회도 하지 않았다. 가드를 추가한 뒤의 제출용 run에서는 제품 스크립트 실행 전 POST를 차단하고, 차단된 action/company/changeCount를 evidence에 남기며 실제 Network 변경 요청은 0건이다. 따라서 제출용 재현은 안전하지만 최초 진단 시도의 원격 결과는 “0건”으로 단정하지 않는다.

## 실행 명령과 rollback

핵심 명령:

```text
node scripts/test-smartinput-official-v2-baseline.mjs
SMARTINPUT_SCREENSHOT_DIR=<evidence-dir> SMARTINPUT_BASELINE_EVIDENCE_FILE=<evidence-json> node scripts/test-smartinput-browser-e2e.mjs
node scripts/validate-repository.mjs
```

코드 rollback은 이 단계 commit을 revert하면 된다. 이 단계가 만든 영속 대상은 Git의 테스트/CI/evidence 파일뿐이다. 격리 브라우저 profile은 매 실행 종료 시 삭제되므로 생산 IndexedDB rollback은 필요 없다. 원격 Cloud/Apps Script/배포 설정 변경은 없다.
