# Gate G4-S — 판매 정상 재고·미매칭·기본 채권

## 판정

PASS. 판매 V2 gate를 격리 fixture에서만 활성화해 단계 4 계약을 통과했다. 운영 기본값은 OFF다.

## 확인 항목

- 회사와 사용자 상품코드가 Product owner key인 외곽 trim 뒤 원문 문자열로 정확히 일치한 상품 수량 4에 공식 재고효과 `-4`와 factor 1을 생성했다. 대소문자·전각/반각·내부 공백 차이는 자동매칭하지 않는다.
- 이름 매칭을 사용하지 않으며 미매칭 상품은 공식 재고효과 대신 재매칭 가능한 `UNRESOLVED_PRODUCT` 상태로 남는다.
- 미등록 거래처코드는 이름이 같아도 자동매칭하지 않았다. 전표는 확정되고 기본 채권은 0건이며 Revision에 `UNRESOLVED_CUSTOMER / CUSTOMER_CODE_UNMATCHED`와 최종금액 `400`이 보존됐다.
- 정확 거래처코드의 기본 채권 1건 `400`을 실제 IndexedDB에 저장하고 `effectiveAt=2026-08-05`, `occurredAt=2026-09-02T10:00:00.000Z` 분리를 확인했다. 거래처 입력 없음의 원장 미생성, 0·음수 최종금액 보존은 순수 계약 검사에서 확인했다.
- 구매 gate와 판매 gate는 독립이며 각각 기본 OFF다.
- 판매 강제 transaction 실패도 새 Revision·재고·미매칭·채권·명령·queue 부분 저장이 0건이다.

## 증거

- 순수 계약: `scripts/test-smartinput-v2-inventory-unresolved-ledger.mjs`
- 실제 owner transaction: `scripts/fixtures/smartinput-v2-stage4-browser-scenario.js`
- 기계 결과: [browser-after.json](./browser-after.json)의 `officialTransaction.stage4V2.sale`와 `rollback`
