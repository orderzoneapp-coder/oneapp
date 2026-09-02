# Gate G3-S — 판매 V2 독립 증거

## Gate 상태

- 설정 키: `SALE`
- 기본값: `false`
- 격리 자동검사에서만 `true`로 주입했다. 현재 SmartInput UI와 `OfficialCommandGateway` 기본 instance는 V2 판매를 활성화하지 않는다.
- 구매 gate만 켠 Gateway가 V2 판매 명령을 `ORDERQ_OFFICIAL_V2_SALE_FEATURE_DISABLED`로 거부하고 구매 명령은 통과시키는 것을 확인했다.

## 필수검사와 Snapshot

- 코드만/이름만 허용, 둘 다 공란 차단.
- 수량·단가 공란은 숫자 변환 전에 차단. `0`, 문자열 `"0"`, 음수는 유한 숫자로 허용하고 `NaN`·±무한대·비숫자는 차단.
- 기술 필드만 있는 완전 빈 행은 제외하고 값이 하나라도 있는 행은 활성 행으로 검사.
- day 공란은 1일로 확정, 전체 날짜 공란·유효하지 않은 날짜 차단.
- 명시한 최종금액 `0`·음수는 원값과 출처를 보존하고 미명시 금액만 확정 시 수량×단가로 계산.
- 확정 Snapshot에 상품코드·상품명·규격·단위·수량·단가·금액·원본 코드/이름·매칭 근거가 포함되며, 원본 입력을 변경한 뒤 core revision snapshot이 바뀌지 않는다.

## ID·Gateway·Repository

- 회사 A/B에서 판매 문서·행·명령·Revision ID가 모두 다르다.
- 판매 문서 identity seed에 `voucherGroupKey`가 필수이며 같은 source의 그룹 A/B에서 문서·행·명령 ID가 모두 다르다.
- 배열 재정렬은 안정 source row key가 있는 행의 ID를 바꾸지 않는다. 저장시각은 문서/행 안정 ID seed가 아니다.
- 명령 형식, identity version, 회사/그룹, `commandId=idempotencyKey`, payload digest, expected Revision을 Gateway와 Repository/Core가 반복 검사한다.
- 격리 IndexedDB의 동일 명령 2회 실행 결과는 두 번째가 `duplicate=true`; 판매 다중그룹 문서 ID가 분리됨을 실제 transaction 시나리오에서 확인했다.
- 판매 명령의 잘못된 expected Revision과 변경 payload를 각각 차단했다.
- 판매 store의 강제 unique-index transaction 실패 뒤 문서/행은 기존 Draft이고 revision/inventory/receivable/pending/command 신규 효과는 모두 0건이다.

## 증거 위치

- 순수 계약: `scripts/test-smartinput-v2-validation-identity.mjs`
- 실제 transaction: `scripts/fixtures/smartinput-v2-stage3-browser-scenario.js`
- 실행 결과: `browser-after.json`의 `officialTransaction.stage3V2.sale`, `safety`, `saleRollback`
- 대표 화면: `screenshots/smartinput-v2-baseline-sale.png`

판정: **G3-S 자동 증거 PASS / 기능 gate 기본 OFF / Pilot 미활성화**.
