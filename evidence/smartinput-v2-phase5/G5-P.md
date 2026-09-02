# Gate G5-P — 구매 재고실사 checkpoint 충돌

## 판정

PASS. 구매 V2 gate를 격리 fixture에서만 활성화해 단계 5 계약을 통과했다. 운영 기본값은 OFF다.

## 확인 항목

- 회사+상품코드+창고의 최신 확정 checkpoint를 행별 판정했고 기존 `productId` checkpoint 호환도 확인했다.
- 9월 1일 실사 뒤 8월 5일 구매에서 선택 전 공식자료 0건이다.
- `실사수량에 포함됨`은 문서·Snapshot·Revision을 저장하면서 원 효과 적용수량 0, `ABSORBED_BY_CHECKPOINT`, checkpoint 연결을 보존해 현재고 중복을 만들지 않았다.
- `실사수량에 포함되지 않음` 순수 계약은 구매 부호와 음수를 보존한 연결조정 정확히 1건을 생성했다. 수량 0은 `ZERO_EFFECT`와 판단 감사상태를 함께 유지했다.
- 같은 날 시각 불명은 결정필요, 양쪽의 신뢰 가능한 timezone 업무시각으로 전표가 뒤임이 증명될 때만 정상임을 확인했다.
- 한 구매전표의 2행에서 `0007=포함`, `0008=미포함`을 독립 보존했고 현재고에는 미포함 행 수량 `+4`만 정확히 한 번 반영했다.
- 첫 행 선택 뒤 두 번째 행에서 취소하면 수집된 선택을 폐기하고 submit 0건·공식 Store 전후 동일을 확인했다.
- V2 inspection port 누락과 timezone 없는 `judgedAt`은 첫 저장 전에 fail-closed한다.
- 결정 변조, 같은 commandId의 다른 payload, preview 이후 새 checkpoint와 잘못된 회사·행·수량·checkpoint 대상은 거부됐다.
- 강제 transaction 실패 뒤 새 Revision·재고·채무·명령·queue는 0건이다.

## 증거

- 순수 계약: `scripts/test-smartinput-v2-stocktake-conflict.mjs`
- 실제 owner transaction: `scripts/fixtures/smartinput-v2-stage5-browser-scenario.js`
- 기계 결과: [browser-after.json](./browser-after.json)의 `officialTransaction.stage5V2`
