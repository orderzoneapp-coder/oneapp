# ONEAPP-DO-20260810-01 DataOps 판매상품 재매칭·판매전표 정정

## 상태와 범위

- 개발 분류: 중요 개발
- 대상: `DataOps.html`
- 원본 판매전표와 Source Ledger는 불변 보존한다.
- 거래처 칩 드래그는 실제 출고상품 재매칭으로 처리하고 최종 현재고에 반영한다.
- 판매상품 변경 과정은 기존 `substHistory` 안에 보존한다. 새 저장키나 별도 변경원장은 만들지 않는다.
- 현재 정정 판매현황은 `원본 판매전표 + active 판매재매칭 이력`으로 재구성한다.
- F9 기존 10개 시트 계약은 유지하고 마지막에 `원본 판매전표`, `정정 판매현황`을 추가한다.
- 역마진은 `원가 > 판매가`만 해당한다. 동일 금액은 제외한다.

## 데이터 계약

### 원본 판매전표

분석 시 `_sourceEntries`에 생성된 `role=out` 항목과 각 항목의 `sourceRaw`를 원본으로 사용한다. 드래그, 부분이동, Ctrl 대체·묶음, 취소는 이 객체를 수정하지 않는다.

원본 식별자는 원본 행의 전표번호·판매번호·주문번호·번호 계열 값을 우선하고, 값이 없으면 Source Ledger `id`를 사용한다.

### 판매 재매칭 이력

기존 작업상태의 `substHistory`를 호환 확장한다.

- `id`, `groupId`: 작업과 다중 Lot 분할 작업 식별자
- `type`: 판매 재매칭은 `SALES_REMATCH`, 칩 수량 정정·삭제는 `SALES_CHIP_CORRECTION`
- `isSalesRematch`: 판매 정정 이벤트 구분
- `status`: `active`, `cancelled`, `superseded`
- `sourceKey`, `targetKey`: 적용 당시 재고 Lot 행
- `sourceCode`, `targetCode`, `sourceName`, `targetName`: 재매칭 전후 상품
- `vendor`: 판매 거래처
- `sourceQty`, `targetQty`, `revenue`: 판매수량·실제 출고수량·보존 공급가액
- `sourceLedgerEntryIds`: 해당 작업이 실제 사용한 최초 원본 판매행 ID 요약
- `sourceLedgerAllocations`: 원본 판매행별 `sourceEntryId`, `originalIdentifier`, 수량, 공급가액의 결정적 배분. 신규 이력 재구성은 이 필드만 우선하며 연속 재수정에도 그대로 승계한다.
- `sourceAllocations`: 결정적으로 분배된 Lot, 거래처키, 수량, 매출액, 원가
- `sourceItemPrev`, `targetItemPrev`: 해당 작업 직전 복원 스냅샷
- `createdAt`, `cancelledAt`: 생성·취소 시각

레거시 이력은 필드가 없더라도 `status=active`로 읽는다. 과거 `CTRL_DRAG_REPLACEMENT`도 판매 이벤트로 인식하며 누락 필드는 안전한 기본값을 사용한다. `sourceLedgerAllocations`가 없는 레거시 이력에만 상품코드+거래처 순차 배분 fallback을 허용한다.

## 처리 규칙

### 일반·부분 드래그

1. UI에는 Source Ledger 원본칩과 정정칩을 함께 표시하지 않는다.
2. 원본+active 이력으로 만든 현재 정정 판매현황만 조작 대상으로 표시한다.
3. 같은 거래처 판매분이 여러 Lot에 배정됐으면 `sourceAllocations` 순서대로 이동한다.
4. `sourceLedgerAllocations`는 현재 정정 판매현황에서 정확한 원본 판매행을 먼저 선택하고, 부분 수량과 공급가액은 원본 판매단가 비율로 배분하며 중간 반올림하지 않는다.
5. 출처 상품의 출고·매출액·매출원가는 출처 Lot 기존 원가로 줄이고, 대상 실제 출고상품의 출고·매출원가는 대상 Lot 원가로 더한다. 대상 원가가 0이면 기존 안전정책대로 출처 원가를 fallback으로 사용한다.
6. 원본 Source Ledger는 그대로 두고 `substHistory`에 active 이벤트를 추가한다.

### Ctrl 대체·묶음

- 출처 판매수량과 대상 실제 출고수량이 달라도 공급가액은 원본 판매분 합계를 유지한다.
- 대상 재고 차감과 매출원가는 대상 Lot 단가를 사용한다.
- 정정 판매현황의 판매단가는 `보존 공급가액 / 대상 판매수량`으로 계산한다.

### 연속 재수정·취소

- 재매칭된 현재 상품 칩을 다시 드래그하면 최초 원본 식별자를 유지한 채 새 active 이벤트를 연속 적용한다.
- 개별 취소는 해당 이벤트의 직전 스냅샷만 복원하고 상태를 `cancelled`로 바꾼다.
- 같은 행을 사용하는 후속 active 작업이 있으면 최신 작업부터 취소하도록 차단한다.
- 전체 취소는 active 이벤트를 역순 복원한다.
- 어떤 취소도 이력 행을 삭제하지 않는다.

## UI 계약

- 기존 재고 테이블과 조정내역 모달을 재사용한다.
- 거래처 칩은 현재 정정 판매현황만 한 번 표시한다.
- 칩 툴팁에 정정 판매수량과 판매단가를 표시한다.
- 조정내역에는 적용중·취소됨·대체됨 상태를 표시하고 취소된 행도 보존한다.
- 여러 Lot 대상상품은 기존 안전정책대로 Lot 상세형에서 실제 출고 Lot을 선택한다.

## F9 계약

기존 시트 순서:

1. 전체재고
2. 구매잔량
3. 기타상품
4. 실사양식
5. 확인요청
6. 재고수불_마감
7. 수불마감_분석원장
8. 소분치환_후보
9. 마스터_확인필요
10. 보고서

추가 시트:

11. 원본 판매전표
12. 정정 판매현황

`원본 판매전표`는 Source Ledger의 거래처, 상품, 수량, 판매단가, 공급가액과 원본 식별자를 출력한다. `정정 판매현황`은 active 이력을 적용한 현재 상품과 최초 원본 상품을 함께 출력한다. 일반 재매칭은 수량·공급가액 합계를 보존하고, Ctrl 환산은 대상수량이 달라도 공급가액 합계를 보존한다.

## 저장·복구와 실패 처리

- 기존 IndexedDB `oneapp_dataops_work_v1/workspaces/current` 계약을 유지한다.
- 자동·수동 저장은 `productData`와 상태형 `substHistory`를 같은 snapshot에 저장한다.
- IndexedDB readwrite transaction이 완료된 뒤에만 저장 성공으로 처리한다.
- write 오류·abort 시 기존 snapshot을 삭제하거나 선행 덮어쓰기하지 않고 오류를 호출자에게 전달한다.
- 복구 시 레거시 이력 정규화 후 UI와 F9 재구성에 사용한다.

## 검증 계약

`scripts/test-dataops-sales-rematch.mjs`가 다음을 검증한다.

- Source Ledger와 `sourceRaw` 불변
- 일반·부분 이동과 연속 재수정
- Ctrl 대상수량 환산과 공급가액 보존
- 다중 원본행·다중 Lot의 결정적 배분
- 개별 취소 후 직전 유효 상태 재구성, 이력 삭제 금지
- 레거시 `substHistory` active 호환
- 저장 실패 시 기존 snapshot 보존
- 원가=판매가 역마진 제외, 원가>판매가 포함
- 기존 F9 시트 순서 유지와 2개 판매 시트 추가
- 실제 XLSX 생성·재열기·대표행·합계

## 복구

변경은 `DataOps.html`, 이 명세, 전용 회귀 테스트로 한정한다. 문제 발생 시 해당 PR을 revert하면 기존 Source Ledger 격리 동작과 F9 계약으로 복구된다. 저장키·IndexedDB 이름·공통 Core·클라우드 계약은 변경하지 않으므로 별도 데이터 마이그레이션이나 역마이그레이션은 없다.
