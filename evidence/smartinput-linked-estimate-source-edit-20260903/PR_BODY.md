## 목적

연동견적을 저장할 때 작업자가 수정할 정확한 원본 견적과 원본 행을 확인·선택하게 합니다. 자동 배분이나 첫 원본 임의 선택은 하지 않습니다.

## 구현

- DOM과 분리된 순수 모듈에서 source evidence, 후보, before/after diff, 선택 필수 계획을 생성합니다.
- 단일 원본은 대상 확인 후 저장하고, 다중 원본과 신규 행은 작업행별 명시 선택 전까지 저장할 수 없습니다.
- 선택한 원본만 변경하며 미선택 원본은 저장 bundle에서 제외합니다.
- 연동견적과 선택한 원본들을 expected preimage 검사 후 기존 `estimates` Store의 한 transaction으로 저장합니다. stale/부분 실패는 전체 rollback합니다.
- 공백/0/음수 수량·단가를 구분하고 품목코드·품명 중 하나 이상을 요구하며 원본 Snapshot/evidence/signature를 보존합니다.
- 안전한 원본별 삭제 경계가 없는 연동행 삭제는 fail-closed합니다.

## UI

- 기존 레이아웃·버튼·단축키·보기 전환·F3 검색은 유지합니다.
- 승인 범위인 원본 선택 및 변경 전후 확인 dialog만 추가합니다.
- 1920/1440/390 light/dark, focus, overflow, footer 접근, 취소 0-write를 별도 집중 browser test로 고정했습니다.

## 검증

- 전체 `test-smartinput*.mjs` 40개
- 원본별 수정 순수 계약 및 estimate bundle atomicity
- SmartInput 전체 browser E2E와 집중 dialog browser test (console/runtime error 0)
- repository validator 24개 검사·경고 0
- client safety, 변경 JavaScript syntax, `git diff --check`

## 경계와 Gate

DB schema/Store/key/index/migration/reset, ORDER Q 공식전표 V2, Draft, 기준정보 소유권, 공통 Runtime, Cloud gate는 변경하지 않았습니다. 이 PR은 PM 독립검증 전 병합·배포하지 않습니다.
