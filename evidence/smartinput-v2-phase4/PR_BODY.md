## 작업

- NEXUS-SI-V2-04: SmartInput 공식전표의 정상 재고효과, 미매칭 상품 상태, 기본 채권/채무 효과
- 회사+사용자 상품코드는 Product owner와 같은 외곽 trim 뒤 원문 문자열 exact key 사용; 이름 자동매칭 금지, 대소문자·전각/반각·내부 공백 구분, ERP 코드 원문/선행 0 보존
- 정확매칭 상품만 구매 `+수량`, 판매 `-수량`, 수량 0 `ZERO_EFFECT`, V2 factor 1 적용
- 미매칭/이름-only 행은 전표·Snapshot을 확정하되 공식재고 미반영; 재매칭 가능한 `UNRESOLVED_PRODUCT` 기록과 전표·행·Revision 링크 저장
- 회사+거래처코드는 Customer owner의 `normalizedCustomerCode` 규칙으로 분리 매칭; 일치할 때만 최종금액 기준 구매 채무/판매 채권 생성, 없음·미매칭은 Revision에 미생성 이유 보존
- V2 AP/AR `effectiveAt`은 전표 `businessDate`, `occurredAt`은 명령 기록시각으로 분리하고 Revision 판단에도 보존; Gateway와 Repository가 projection 일치 여부를 각각 검증
- ORDER Q 한 transaction에 공식 projection, 효과/미생성 결정, 명령, local sync queue를 저장하고 실패 시 부분 저장 0·재시도 중복 0 보장

## 검증

- `node scripts/test-smartinput-v2-inventory-unresolved-ledger.mjs` PASS
- 단계 3 validation/identity, V1 baseline, owner-boundary, ORDER Q core/rematch, 기존 SmartInput/parser/reference/input-template/client-safety/common UI 회귀 PASS
- `node scripts/validate-repository.mjs` PASS (`24 checks`, warning 0)
- 실제 Chrome/IndexedDB E2E PASS: 구매 채무 `2,661`과 판매 채권 `400` 모두 `effectiveAt=2026-08-05` / `occurredAt=2026-09-02T10:00:00.000Z`; Repository 변조 발생일 거부; 구매 `+10`, `0 ZERO_EFFECT`, 미매칭 pending 3/공식재고 0, 동일 미매칭 검수 링크 2, 판매 `-4`, 미매칭 거래처 채권 0 및 Revision 사유 보존
- 상품 `ABC↔abc`, `０００７↔0007`, 내부 공백 차이 자동매칭 금지와 미매칭 ID 분리, 고객 owner 정규화 매칭 유지 PASS
- 동일 명령 재시도 효과 중복 0; 강제 transaction 실패 후 새 Revision/재고/pending/unresolved/원장/명령/queue 0
- DOM·키보드 계약 동일, 기존 구매/판매 저장 각 6-click 유지, 실제 외부 변경 요청 0, 생산 IndexedDB write 0
- 상세 증거: `evidence/smartinput-v2-phase4/README.md`, `G4-P.md`, `G4-S.md`, `browser-after.json`, `screenshots/`

## 범위 통제

- 구매·판매 V2 feature gate는 서로 독립이며 기본 OFF. 테스트 fixture에서만 활성화
- HTML은 cachebuster만 갱신; CSS·DOM·디자인·레이아웃·탭·버튼·열·단축키 변경 없음
- SmartInput은 consumer, ORDER Q는 공식 데이터 owner. Product/Customer 기준정보 저장소 write 없음
- Pilot/Cloud Push·Pull 활성화/실사충돌 팝업/수정·취소/Draft V2/migration/영구 검수 UI/상품입력창 통합/옵션·단위환산/마감·세금계산서·상계·조정계정 제외

## Rollback

- 구매만: `OFFICIAL_VOUCHER_V2_FEATURE_GATES.PURCHASE=false` 유지
- 판매만: `OFFICIAL_VOUCHER_V2_FEATURE_GATES.SALE=false` 유지
- 전체: 두 gate OFF 유지 후 이 PR commit revert
- DB version·migration·운영 데이터·외부 배포 변경이 없어 데이터 복구 불필요

Draft 제출입니다. PM 승인 전 Ready 전환·병합·배포·Pilot 활성화를 금지합니다.
