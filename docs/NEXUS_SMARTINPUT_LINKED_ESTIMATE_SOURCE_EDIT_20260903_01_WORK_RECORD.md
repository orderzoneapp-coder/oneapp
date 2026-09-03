# NEXUS-SMARTINPUT-LINKED-ESTIMATE-SOURCE-EDIT-20260903-01 작업 기록

## 착수 기준

- 목적: SmartInput 3단계 `연동견적 원본별 수정`
- 기준 `origin/main`: `9a38a3c809ec8676c07d9232344a89663e817e59` (PR #502 merge SHA와 일치, 요구 최소 SHA의 ancestor 확인)
- 선행 단계: PR #499 원본형·입력형 테이블 전환 `5f6001a56e9a93ff17a08d86c74536414768c7ae`, PR #502 F3 입력목록 검색 `9a38a3c809ec8676c07d9232344a89663e817e59`
- 브랜치: `codex/smartinput-linked-estimate-source-edit-20260903`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-linked-estimate-source-edit-20260903`
- 실제 저장 프로젝트의 현재 checkout은 사용자 변경이 있는 상태로 확인만 했고 수정·정리·reset하지 않았다.
- 규범: `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` v2.1.30, `app-manifest.json` schema v1.3.9, `orderq/ARCHITECTURE.md` v0.9.0
- SmartInput 계약: `smartinput/README.md`, `docs/SMARTINPUT_FIELD_ROW_MAPPING_DEVELOPMENT_SPEC_V1.md`, `docs/NEXUS_SMARTINPUT_REFERENCE_DATA_UX_V1.md`, SmartInput Core/공식전표 V2 작업 기록
- PM 독립검증 전 병합·배포 금지

## 구조 조사와 실패 재현

SmartInput 견적은 `oneapp-smartinput` IndexedDB v5의 기존 `estimates` Store가 소유한다. 개별 원본 견적은 `estimateKind=INDIVIDUAL`, 연동견적은 `estimateKind=LINKED_GROUP`이고, 연동 작업행은 `linkedSourceRefs[]`의 `estimateId + rowId`로 원본 행을 지목한다. 원본 Excel 표시값·서명·cell evidence는 각 행의 `fieldValues`와 그 내부 `evidence`에 저장돼 있다. 연동견적은 저장된 원본들을 읽어 화면에서 다시 물질화한다.

기준 코드의 실패를 테스트로 먼저 고정했다.

- 연동행 수정 시 모든 `linkedSourceRefs`를 순회해 여러 원본 행을 함께 덮어썼다.
- 원본 선택 단계가 없어서 작업자가 어느 원본 행을 바꿀지 결정할 수 없었다.
- 신규 행은 추가할 원본을 선택할 계약이 없었다.
- 여러 견적의 저장 묶음에 원본 preimage 검사가 없어 확인 팝업 이후 다른 탭에서 바뀐 원본을 덮어쓸 수 있었다.
- 연동 원본 행 삭제는 대상 원본을 결정할 경계 없이 원본들에 전파될 수 있었다.
- 순수 원본별 편집 테스트는 최초 `ERR_MODULE_NOT_FOUND`, atomic bundle 테스트는 최초 기대한 rollback 거부가 발생하지 않아 각각 실패했고, 구현 후 통과했다.

## 원본 판정·수정 알고리즘

DOM과 저장소를 모르는 순수 모듈 `smartinput/linked-estimate-source-edit.js`가 다음 순서로 처리한다.

1. 현재 연동 작업행의 `linkedSourceRefs`를 정확한 개별 견적 레코드와 원본 `rowId`에 결합한다. 레코드나 행이 없으면 저장 전에 fail-closed한다.
2. 원본별 견적명/ID, 원본 행 번호/ID, 품목코드·품명·규격, 수량·단가·금액, 작업행 대비 차이와 source evidence를 불변 Snapshot으로 만든다.
3. 변경된 필드만 판정한다. 품목코드나 품명 변경 시 예전 상품 ID·매칭 판정이 남지 않도록 관련 식별 필드도 같은 변경 집합에 넣는다.
4. 기존 행의 원본이 하나면 그 행만 계획한다. 여러 원본이면 작업행별 `estimateId:rowId` 선택이 없을 때 계획 생성을 거부한다. 신규 행은 연결된 개별 견적 중 작업자가 선택한 `estimateId`가 없으면 거부한다. 첫 원본 자동선택은 없다.
5. 각 선택의 before/after, 대상, actor, 명시 offset이 있는 시각을 한 계획에 고정한다. 수량·단가는 공백, 0, 음수, 양수, 숫자 아님을 서로 다른 상태로 보존하며 숫자 아님만 거부한다. 품목코드·품명은 둘 중 하나 이상 필수다.
6. 계획 적용은 선택한 원본 레코드만 복제해 변경한다. 미선택 원본은 upsert 목록에도 넣지 않는다. 기존 `fieldValues.evidence`, 원본 표시값과 signature는 보존하고 `currentDisplayValue`와 감사기록만 갱신한다.
7. 연동 레코드와 선택한 모든 원본 레코드를 기존 Data Store의 `commitEstimateBundle()` 단일 경계에 전달한다. 확인 당시 preimage가 현재 값과 다르면 거부하고, IndexedDB 한 transaction에서 모두 put한다. 한 건이라도 실패하면 transaction을 abort해 전체 rollback한다. 성공 후에만 화면 상태를 갱신한다.

## UI 결정

- 기존 전체 레이아웃, 입력표, 버튼, 단축키, 보기 전환, F3 검색은 유지했다.
- 추가 영구 UI 없이 저장 직전 동적 원본 선택·변경 전후 확인 팝업만 추가했다.
- 단일 원본 기존 행은 유일한 원본이 선택된 상태로 표시하지만 작업자가 대상/원본 행/before→after를 보고 최종 저장 버튼을 눌러야 한다.
- 다중 원본과 신규 행은 아무 원본도 미리 선택하지 않는다. 모든 작업행의 선택 전까지 저장 버튼이 비활성화된다.
- 취소·X·ESC는 저장 0건이고 현재 입력을 유지한다.
- 팝업은 1920/1440에서 기존 데스크톱 폭 안에 놓이고 390에서는 카드와 수치 비교를 한 열로 쌓는다. 내용만 내부 스크롤하며 footer와 최종 결정 버튼은 접근 가능하다. focus는 dialog 안에 유지한다.
- 연동 원본 삭제는 이 단계에서 안전한 원본별 삭제 경계가 없으므로 이해 가능한 안내와 함께 fail-closed한다.

## 저장·소유권 경계

- 수정 대상은 SmartInput의 연결된 개별 원본 견적과 그 연동견적뿐이다.
- SmartInput 견적 owner의 기존 `smartinput-data-store.js` 경계만 사용하며 UI가 IndexedDB를 직접 쓰지 않는다.
- DB version/schema/Store/key/index/migration/reset, 공통 Runtime, Cloud gate를 변경하지 않았다.
- ORDER Q 공식전표 V2, 구매·판매 Draft, 공식문서·Revision·재고·채권·채무, 기준정보 owner Store에 읽기/쓰기를 추가하지 않았다.
- 원본형/입력형 숨은 선택·표시 합계·전체 업무검증 분리 계약과 F3 검색을 그대로 유지했다.

## 검증 결과

- 순수 원본별 편집: 단일/다중 원본, 선택 필수, 신규행 대상 필수, 미선택 원본 불변, 다중 작업행 계획, 수량·단가 공백/0/음수, 품목 식별 필수, stale 원본 차단, Snapshot/evidence/signature 보존 통과
- atomic store: localStorage fallback write 실패·stale preimage rollback, 실제 IndexedDB 두 번째 put 강제 실패 전체 rollback 통과
- 전체 SmartInput 브라우저 E2E: 다중 원본 선택, 단일 원본 확인·취소, 신규행 미선택 차단, 미선택 원본 불변, 저장 후 재열기, 강제 부분 실패 전체 rollback, console/runtime error 0 통과
- 집중 dialog 브라우저 테스트: 1920/1440/390 × light/dark의 viewport 경계·문서 overflow·본문 스크롤·footer 접근, 초기 focus, 취소 0-write 통과
- 대표 화면: `evidence/smartinput-linked-estimate-source-edit-20260903/focused-browser/smartinput-linked-source-dialog-1440-light.png`
- 1단계 원본형·입력형 보기 전환, 숨은 선택·표시 합계·전체 업무검증 분리 회귀 통과
- 2단계 F3 입력목록 검색 1920/1440/390 × light/dark 회귀와 console/runtime error 0 통과
- 전체 `test-smartinput*.mjs` 40개 통과
- repository validator 24개 검사·경고 0, client safety, 변경 JavaScript syntax, `git diff --check` 통과

## Rollback과 남은 위험

- 병합 전 rollback은 이 브랜치를 폐기한다. 병합 후에는 단일 목적 commit을 revert한다. schema/migration/운영 데이터 변경이 없어 데이터 복구 작업은 없다.
- 원본 확인 후 다른 탭에서 해당 견적이 바뀌면 preimage 검사가 저장 전체를 거부한다. 작업자는 연동견적을 다시 열어 최신 원본을 확인해야 한다.
- 연동 원본 행 삭제는 대상별 삭제 semantics와 감사 계약을 별도 확정할 때까지 지원하지 않는다.
- 원본이 많은 연동행은 팝업 본문 스크롤이 길어질 수 있으나 선택/확인 경계는 유지한다.
- 실제 운영 merge·배포와 데이터 변경은 수행하지 않는다. PR은 PM 독립검증과 CI 이후에도 별도 승인 없이 병합하지 않는다.
