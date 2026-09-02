# Gate G5-S — 판매 재고실사 checkpoint 충돌

## 판정

PASS. 판매 V2 gate를 격리 fixture에서만 활성화해 단계 5 계약을 통과했다. 운영 기본값은 OFF이며 구매 gate와 독립이다.

## 확인 항목

- 9월 1일 실사 뒤 8월 5일 판매 수량 4의 원 효과는 `-4`로 보존됐다.
- `실사수량에 포함되지 않음`은 원 문서·Snapshot·checkpoint를 보존하고 `APPLIED_AS_LATE_ADJUSTMENT` 연결조정 정확히 1건으로 현재고 `-4`를 반영했다.
- 동일 command 재시도 뒤 조정·Revision·명령이 각각 1건으로 유지됐다.
- 포함 결정은 판매도 현재고 중복 0이며, 0·음수와 factor 1 계약은 구매와 같은 공통 순수 경계를 사용한다.
- 판매 Finalize도 모든 그룹의 읽기 전용 checkpoint 검사를 마친 뒤에만 첫 저장을 시작한다. 취소는 공식 문서·행·Revision·재고·채권·명령·queue 0건이다.
- 한 판매전표의 2행에서 `0007=포함`, `0008=미포함`을 독립 보존했고 현재고에는 미포함 행 수량 `-4`만 정확히 한 번 반영했다.
- V2 custom submit은 명시 inspector 없이는 실행되지 않으며, 모든 행 결정과 전 그룹 재검증이 끝나야 첫 submit을 시작한다.
- 거래처 선택성과 정확매칭 채권, `businessDate`/`occurredAt` 분리는 단계 4 회귀검사로 유지됐다.

## 증거

- 순수 계약: `scripts/test-smartinput-v2-stocktake-conflict.mjs`
- 실제 owner transaction: `scripts/fixtures/smartinput-v2-stage5-browser-scenario.js`
- 기계 결과: [browser-after.json](./browser-after.json)의 `officialTransaction.stage5V2.notIncluded`
