# ORDER Q M10 병행운영·전환 훈련서

## 목적

M10은 기존 `orderops/`를 즉시 복귀 경로로 유지하면서 ORDER Q vNext를 단계적으로 활성화한다. 이 문서는 코드 완료후보 검증용이며, 운영 URL 교체나 기존 경로 종료를 승인하지 않는다.

## 모드

| 모드 | 의미 | 새 공식명령 |
| --- | --- | --- |
| `LEGACY_PRIMARY` | 기존 OrderOps가 기본 화면 | 차단 |
| `SHADOW` | 기존 결과와 ORDER Q 결과 비교 | 차단 |
| `PILOT_WRITE` | 승인된 관리자 감독 범위만 쓰기 | 허용 |
| `VNEXT_PRIMARY` | ORDER Q를 기본 실행 화면으로 사용 | 허용 |

공식 쓰기는 다음 두 조건이 모두 참일 때만 허용한다.

1. 해당 브라우저 프로필의 로컬 모드가 쓰기 허용 모드다.
2. Apps Script의 `ONEAPP_ORDERQ_CUTOVER_MODE` ScriptProperty가 쓰기 허용 모드다.

둘 중 하나가 불일치하거나 중앙이 오프라인이면 로컬 판매·구매·Movement·이행을 선반영하지 않는다. 중앙 Pull과 조회는 유지한다.

## Shadow 판정

기존 OrderOps와 ORDER Q를 다음 축으로 따로 비교한다.

- 기준재고
- 구매입고
- 실제 판매출고
- 주문요청과 활성예약
- 현재고
- 가용재고
- 기준일과 snapshot watermark

주문요청은 판매가 아니다. 차이는 `BASIS_MISMATCH`, `OPENING_DIFFERENCE`, `PURCHASE_DIFFERENCE`, `SALE_DIFFERENCE`, `REQUEST_RESERVATION_DIFFERENCE`, `OTHER_MOVEMENT_DIFFERENCE`, `MAPPING_MISSING` 같은 원인코드와 양쪽 근거 ID를 함께 기록한다. 음수와 숫자 0은 원값 그대로 비교한다.

## 전환 전 점검

1. 중앙 Sheet 백업과 digest, `PREPARED=0`, sequence gap 0을 확인한다.
2. A/B 각 프로필에서 전체 38 Store 백업을 생성하고 구조 검증한다.
3. 격리 프로필에서 백업을 복원해 canonical JSON 일치를 확인한다.
4. 잘못된 백업 복원 실패가 기존 전체 Store를 변경하지 않는지 확인한다.
5. Shadow 차이 0건 또는 각 차이의 원인·조치 근거가 남았는지 확인한다.
6. 정상·대체·부분·소분·구매·판매역분개·대체판단 역분개 대표 흐름을 재검증한다.
7. 두 독립 프로필의 cursor, ledgerSequence, projection이 수렴하는지 확인한다.

## 제한 활성화 순서

1. 중앙 ScriptProperty를 `PILOT_WRITE`로 설정한다.
2. 관리자 감독 프로필만 전환관리 화면에서 `PILOT_WRITE`로 바꾸고 사유를 남긴다.
3. 중앙 모드와 로컬 모드가 모두 허용으로 표시되는지 확인한다.
4. 첫 공식명령 1건을 실행하고 다른 프로필에서 Pull한다.
5. 판매·구매·Movement·이행·예약·sequence가 중앙과 두 프로필에서 일치하는지 확인한다.
6. 동일 idempotency key 재시도가 행과 sequence를 늘리지 않는지 확인한다.

## 즉시 복귀 훈련

1. 전환관리 화면에서 해당 프로필을 `LEGACY_PRIMARY`로 바꾸고 사유 `IMMEDIATE_ROLLBACK`을 기록한다.
2. 중앙 ScriptProperty를 `SHADOW` 또는 `LEGACY_PRIMARY`로 바꾼다.
3. 새 공식명령이 로컬 선반영 없이 차단되는지 확인한다.
4. 중앙 Pull과 조회가 계속되는지 확인한다.
5. 기존 `orderops/list.html`로 이동한다.

복귀 시 확정 판매·구매·Movement·주문이행을 삭제하거나 백업 시점으로 되감지 않는다. 오류가 있는 확정사실은 기존 append-only 역분개·정정 명령으로 처리한다.

## 즉시 중단 조건

- 중앙과 로컬 한쪽만 확정됨
- 판매·Movement·주문이행·예약 소비가 부분 반영됨
- sequence 중복 또는 gap 발생
- idempotency key 내용충돌이 승인됨
- `PREPARED`가 5분 이상 남음
- 두 번의 Pull 뒤 프로필이 수렴하지 않음
- 숫자 0, 공란, 음수 또는 actual/base/recognized 수량축이 손실됨

중단 시 새 입력만 막고 원값과 증거를 보존한다. kill switch 후 국소 수정, 회귀검증, 검증 PM 재승인 순서로 진행한다.

## 현재 금지 범위

- 운영 URL 교체
- 기존 OrderOps 경로 종료
- 실제 작업자 확대
- ERP 실제 업로드 또는 `POSTED`
- M11 선행 구현

위 항목은 M10 완료후보 승인과 사용자 운영 승인 이후 별도 단계로 진행한다.
