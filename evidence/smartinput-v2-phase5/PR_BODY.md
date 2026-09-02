## 작업

- NEXUS-SI-V2-05 / SI-V2-STOCKTAKE-CONFLICT: SmartInput 공식 구매·판매 V2의 재고실사 checkpoint 충돌 판정과 승인 팝업
- 회사+상품코드(기존 숨은 productId 호환)+창고별 최신 확정 checkpoint 순수 판정
- `businessDate` 뒤 정상, 앞 충돌, 같은 날 시각 불명 충돌; command `occurredAt`/checkpoint `confirmedAt` 자동판정 금지
- 포함은 `ABSORBED_BY_CHECKPOINT`와 현재고 중복 0, 미포함은 `APPLIED_AS_LATE_ADJUSTMENT` 연결조정 정확히 1회, 취소는 공식자료 0건
- 결정 대상/effect/checkpoint/businessDate/actor/판단시각을 command payload와 Revision에 보존
- 승인 팝업의 행별 순차 선택으로 같은 전표·복수 그룹의 혼합 포함/미포함 결정을 지원하고, 중간 취소는 수집 선택 폐기·공식자료 0건
- 모든 그룹 선검사와 Gateway/Repository checkpoint 재검사, V2 inspection port 필수, payload/멱등성/Revision/transaction fail-closed
- 판단 `judgedAt`은 `Z` 또는 명시 offset을 가진 완전한 ISO timestamp만 허용
- 기존 승인 문구의 동적 dialog만 추가하고 입력·선택·스크롤·작업본 및 기존 DOM/버튼/열/탭/단축키/정상 클릭 수 보존

## 검증

- `node scripts/test-smartinput-v2-stocktake-conflict.mjs` PASS
- 단계 0~4 계약, owner boundary, repository validator, ORDER Q core/rematch 및 기존 관련 테스트 PASS
- 실제 격리 Chrome/IndexedDB E2E PASS: 선택 전 0건, 구매 포함 현재고 중복 0, 판매 미포함 조정 1건, 구매/판매 각각 2행 혼합결정, 첫 선택 후 중간 취소 0-write, 재시도 중복 0, stale checkpoint 거부, 강제 rollback, 회사 격리
- 일반/다크/390px 팝업, 정확 문구·행정보·3버튼, ESC/취소 포커스·선택범위·행선택·스크롤·작업표·layout 보존 PASS
- 실제 외부 mutating request 0, local fixture server write 0, production IndexedDB write 0
- 상세 증거: `evidence/smartinput-v2-phase5/README.md`, `G5-P.md`, `G5-S.md`, `browser-after.json`, `screenshots/`

## 범위 통제와 Rollback

- 구매/판매 V2 gate는 독립·기본 OFF이며 검증 fixture에서만 활성화
- 새 DB Store/index/schema/migration과 기준정보 owner write 없음
- Pilot/Cloud 활성화·배포, 수정·취소 기능, Draft V2, 영구 검수 UI/재매칭 배치, 새 영구 버튼·열·탭, 단계 6 이후 기능 제외
- SmartInput은 consumer, ORDER Q Adapter→Gateway→Repository가 공식 데이터 owner
- rollback은 gate OFF 유지 후 이 단일 목적 commit revert; 데이터 migration 복구 불필요

Draft 제출입니다. PM 승인 전 Ready 전환·병합·배포·Pilot 활성화·단계 6 착수를 금지합니다.
