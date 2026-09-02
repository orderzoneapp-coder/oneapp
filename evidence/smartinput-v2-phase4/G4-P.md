# Gate G4-P — 구매 정상 재고·미매칭·기본 채무

## 판정

PASS. 구매 V2 gate를 격리 fixture에서만 활성화해 단계 4 계약을 통과했다. 운영 기본값은 OFF다.

## 확인 항목

- 회사와 사용자 상품코드가 Product owner key인 외곽 trim 뒤 원문 문자열로 정확히 일치한 활성 상품만 매칭했다. `ABC↔abc`, `０００７↔0007`, 내부 공백 차이와 이름-only 및 미등록 코드 행은 자동매칭하지 않았다.
- 선행 0 코드 `0007`의 정확매칭 기술 ID를 사용하면서 입력 코드 원문은 Snapshot에 보존했다.
- 정확매칭 수량 10은 `+10 / APPLIED_NORMAL`, 수량 0은 `0 / ZERO_EFFECT`; 두 효과 모두 factor 1이다.
- 미매칭 3행은 공식 재고효과 0건, `UNRESOLVED_PRODUCT` pending 3건이다. 검수 대상 2건에 문서·행·Revision 링크가 저장되고 같은 코드의 두 행은 링크 2개로 합쳐졌다.
- 정확매칭 거래처에서 최종금액 `2,661` 기준 기본 채무 1건을 만들었다. 실제 IndexedDB의 채무와 Revision 판단에 전표 발생일 `effectiveAt=2026-08-05`, 명령 기록시각 `occurredAt=2026-09-02T10:00:00.000Z`가 분리 저장됐다. 변조된 발생일의 retry는 Repository가 거부했다.
- 거래처 없음·미매칭은 별도 순수 계약 검사에서 전표 확정과 원장 미생성 사유·발생일 보존을 확인했다. 고객코드는 Customer owner의 `normalizedCustomerCode` 규칙을 유지한다.
- 동일 명령 재시도 뒤 공식 문서·Revision·명령·queue와 각 효과 건수가 증가하지 않았다.
- 강제 transaction 실패 뒤 새 Revision·재고·pending·unresolved·채무·명령·queue는 모두 0건이다.

## 증거

- 순수 계약: `scripts/test-smartinput-v2-inventory-unresolved-ledger.mjs`
- 실제 owner transaction: `scripts/fixtures/smartinput-v2-stage4-browser-scenario.js`
- 기계 결과: [browser-after.json](./browser-after.json)의 `officialTransaction.stage4V2.purchase`와 `rollback`
