# Gate G3-P — 구매 V2 독립 증거

## Gate 상태

- 설정 키: `PURCHASE`
- 기본값: `false`
- 격리 자동검사에서만 `true`로 주입했다. 현재 SmartInput UI와 `OfficialCommandGateway` 기본 instance는 V2 구매를 활성화하지 않는다.
- 판매 gate만 켠 Gateway가 V2 구매 명령을 `ORDERQ_OFFICIAL_V2_PURCHASE_FEATURE_DISABLED`로 거부하고 판매 명령은 통과시키는 것을 확인했다.

## 필수검사와 Snapshot

- 코드만/이름만 허용, 둘 다 공란 차단.
- 수량·단가 공란은 숫자 변환 전에 차단. `0`, 문자열 `"0"`, 음수는 유한 숫자로 허용하고 `NaN`·±무한대·비숫자는 차단.
- 기술 필드만 있는 완전 빈 행은 제외하고 값이 하나라도 있는 행은 활성 행으로 검사.
- day 공란은 1일로 확정, 전체 날짜 공란·유효하지 않은 날짜 차단.
- 명시한 최종금액 `0`·음수는 원값과 `SOURCE_OR_USER` 출처를 보존하고, 미명시 금액은 확정 시 수량×단가와 `DERIVED_AT_CONFIRM` 출처로 고정.
- 확정 Snapshot에 상품코드·상품명·규격·단위·수량·단가·금액·원본 코드/이름·매칭 근거가 포함된다.
- 기준상품 입력 객체의 이름·코드·ID를 변경/삭제한 뒤 Repository에서 다시 읽은 구매 Snapshot이 확정 당시 값을 유지했다.

## ID·Gateway·Repository

- 회사 A/B에서 구매 문서·행·명령·Revision ID가 모두 다르다.
- ID seed에 schemaVersion/entityType/companyId가 들어가고 행은 documentId/sourceLineKey를 함께 사용한다.
- 명령 형식, identity version, 회사, `commandId=idempotencyKey`, payload digest, expected Revision을 Gateway와 Repository/Core가 반복 검사한다.
- 격리 IndexedDB의 동일 명령 2회 실행 결과는 두 번째가 `duplicate=true`, 저장된 command/revision은 각각 1건이다.
- 변경 payload, 잘못된 Revision, 회사 불일치가 차단됐다.
- 강제 transaction 실패 뒤 문서/행은 기존 Draft이고 revision/inventory/payable/pending/command 신규 효과는 0건이다.

## 증거 위치

- 순수 계약: `scripts/test-smartinput-v2-validation-identity.mjs`
- 실제 transaction: `scripts/fixtures/smartinput-v2-stage3-browser-scenario.js`
- 실행 결과: `browser-after.json`의 `officialTransaction.stage3V2.purchase`, `safety`, `rollback`
- 대표 화면: `screenshots/smartinput-v2-baseline-purchase.png`

판정: **G3-P 자동 증거 PASS / 기능 gate 기본 OFF / Pilot 미활성화**.
