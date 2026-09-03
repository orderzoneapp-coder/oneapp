## 목적

연동견적을 저장할 때 작업자가 수정할 정확한 원본 견적과 원본 행을 확인·선택하게 합니다. 자동 배분이나 첫 원본 임의 선택은 하지 않습니다.

## 구현

- DOM과 분리된 순수 모듈에서 source evidence, 후보, before/after diff, 선택 필수 계획을 생성합니다.
- 단일 원본은 대상 확인 후 저장하고, 다중 원본과 신규 행은 작업행별 명시 선택 전까지 저장할 수 없습니다.
- 선택한 원본만 변경하며 미선택 원본은 저장 bundle에서 제외합니다.
- 연동견적과 선택한 원본들을 expected preimage 검사 후 기존 `estimates` Store의 한 transaction으로 저장합니다. stale/부분 실패는 전체 rollback합니다.
- 공백/0/음수 수량·단가를 구분하고 품목코드·품명 중 하나 이상을 요구하며 원본 Snapshot/evidence/signature를 보존합니다.
- 선택 원본에 persisted record와 다른 미저장 working copy가 있으면 0-write로 차단하고, 원본의 명시 저장/정리를 안내합니다. 차단·취소 시 원본 작업본과 연동 입력을 유지하고 미선택 원본 작업본은 성공 후에도 유지합니다.
- 차단 뒤 연동견적 재열기에서는 동일 linked refs의 sourced-row 작업값과 편집 marker만 화면에 복원하고 최신 원본 evidence/signature는 유지합니다.
- 원자 저장 성공 후 최신 원본들로 linked 행의 대표값·필드 충돌·단가 충돌을 다시 물질화해 저장 직후 화면, 저장 linked record, 재열기 결과를 일치시킵니다.
- 안전한 원본별 삭제 경계가 없는 연동행 삭제는 fail-closed합니다.

## UI

- 기존 레이아웃·버튼·단축키·보기 전환·F3 검색은 유지합니다.
- 승인 범위인 원본 선택 및 변경 전후 확인 dialog만 추가합니다.
- 1920/1440/390 light/dark, focus, overflow, footer 접근, 취소 0-write를 별도 집중 browser test로 고정했습니다.

## 검증

- 전체 `test-smartinput*.mjs` 40개
- 원본별 수정 순수 계약 및 estimate bundle atomicity
- SmartInput 전체 browser E2E: working-copy 0-write 차단 → 원본 명시 저장 → 연동 입력 복원 → 재시도, 미선택 작업본 불변, A=1/B=9 저장 직후·저장 record·재열기 일치, 부분 실패 rollback
- 집중 dialog browser test (console/runtime error 0)
- repository validator 24개 검사·경고 0
- client safety, 변경 JavaScript syntax, `git diff --check`

## 경계와 Gate

DB schema/Store/key/index/migration/reset, ORDER Q 공식전표 V2, Draft, 기준정보 소유권, 공통 Runtime, Cloud gate는 변경하지 않았습니다. 이 PR은 PM 독립검증 전 병합·배포하지 않습니다.
