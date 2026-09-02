## 작업

- `NEXUS-SI-V2-06A` / `SI-V2-UNRESOLVED-REVIEW`: ORDER Q 소유의 미매칭 검수 Read Model/Adapter와 순수 재매칭 영향 미리보기 계약
- 회사 범위를 필수로 하여 기존 ORDER Q DB v7의 미매칭 record·pending effect·확정 문서/행/Revision·실사 checkpoint를 owner Repository에서 `readonly`로 조합
- 확정 당시 원본 상품코드·상품명·규격·단위, 창고, `businessDate`, 입력/부호수량, 공식재고 `미반영`과 별도 미반영 수량, 문서/행/Revision 추적을 반환
- 동일 unresolved ID의 복수 전표·행을 중복 없이 집계하고, 누락·손상 링크와 orphan effect를 `REVIEW_REQUIRED`로 보존
- Product Snapshot의 정확 원문 코드 및 이름 후보는 검수 참고만 제공하고 모든 후보를 `자동확정 아님`으로 고정
- 단계 5 순수 checkpoint classifier를 재사용해 `APPLY_READY|DECISION_REQUIRED|REVIEW_REQUIRED` 영향만 계산; 실제 command/재고/기준정보 write는 0
- `READY|EMPTY|ERROR`, 결정적 정렬·필터·페이지/limit, owner 오류의 null count fail-closed 계약
- 앱 아키텍처·manifest·ORDER Q 문서에 owner read 경계만 최소 등록; DB schema/migration/Store, 전역 Runtime/Common Core/Gateway 추가 없음

## UI Gate U1

- `evidence/smartinput-v2-phase6a/UI_GATE_U1.md`에 (A) 기존 재고·출고 결과 영역 재사용, (B) 기존 실사 팝업 안 검수, (C) 신규 표 열·탭·버튼·패널을 비교
- 변경 위치, 추가 클릭, 표시 필드, 장단점, 모바일/다크 영향, 공수와 rollback을 기록
- 최소 권장안은 A이지만 이 PR은 승인이나 구현이 아님
- 기존 제품 HTML/CSS/JS, DOM, 버튼, 표 열, 탭, 패널, 팝업, 레이아웃, 단축키와 저장 클릭 수 변경 0

## 검증

- `node scripts/test-smartinput-v2-unresolved-review-read-model.mjs` PASS
  - 코드만/이름만/코드+이름, 양수·0·음수, 구매·판매, 동일 unresolved 다중 링크, 회사 격리
  - 앞자리 0·대소문자·전각/반각·내부 공백 exact-string 격리, 이름 비자동확정
  - 공식재고 null/미반영 수량 분리, 문서·행·Revision 추적과 집계 대사
  - 손상/누락 링크와 ID 누락 effect 보존, 빈 결과/owner 오류 분리
  - 10,000 effects의 첫 200건 page 투영 5초 이내
- 실사 영향: 9월 1일 checkpoint 뒤 8월 5일 효과 `DECISION_REQUIRED`, 9월 2일 효과 `APPLY_READY`, 9월 1일 시각 불명 `DECISION_REQUIRED`; write plan 0
- 기존 단계 0~5, repository validator, official core/write boundary, rematch boundary, independent recovery, client safety PASS
- 격리 Chrome 브라우저 E2E PASS
  - 실제 Stage 4 owner records 2건/links 3개 조회
  - Phase 6A IndexedDB write 0, `readwrite` transaction 0, Store count 전후 동일
  - actual external mutating request 0, production IndexedDB write 0, fixture server write 0
- `node scripts/test-smartinput-v2-phase6a-ui-unchanged.mjs` PASS
  - 기존 모드 탭 4, action 버튼 7, 표 열 13, footer action 5, 단축키 계약 6 동일
  - 구매/판매 공식 저장 클릭 각각 6으로 동일
- `node scripts/validate-repository.mjs`, `git diff --check` PASS
- 상세 증거: `evidence/smartinput-v2-phase6a/README.md`, `UI_GATE_U1.md`, `browser-after.json`

## 소유권·범위·Rollback

- 데이터 owner는 `orderq-vnext`; Product Snapshot owner는 `master-lookup`이고 검수 참고로만 읽음
- 제품 UI 소비자는 U1 승인 전 등록하지 않음; SmartInput과 다른 앱은 ORDER Q Store를 직접 열지 않음
- 제외: 영구 검수 UI, 재매칭 실행, 공식재고 반영, 새 팝업, 수정/취소, Draft V2, Pilot/Cloud 활성화, DB migration, Product/Customer write, 단계 6B/7
- rollback은 새 read-only 3개 자산, 문서/manifest 등록, 테스트/evidence를 이 단일 목적 commit으로 revert한다. 기존 DB v7 데이터와 제품 UI에는 복구 작업이 없다.

Draft 제출입니다. 사용자·검증 PM 승인 전 Ready 전환, 병합, 배포, 제품 UI 구현, 단계 6B/7 착수를 금지합니다.
