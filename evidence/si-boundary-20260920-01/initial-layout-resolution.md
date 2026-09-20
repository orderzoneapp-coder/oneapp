# PR 638 입력 레이아웃 CI 실패 해소

CI job `106135291448` 및 격리된 로컬 브라우저에서 같은 실패를 재현했다. 판매 전표를 새로고침한 뒤 `PRESERVE-sale` 행의 사용자 날짜 셀 `custom.text.02`가 없었다. 저장 모델에는 원문 `09/10 오전 (미정)`이 남아 있었고 헤더와 비포커스 기본행에는 날짜 열이 있었다. 활성 `saleAmount2` 입력이 포함된 행만 이전 HTML을 보존한 상태였다. [변경 전 진단](deploy-initial-layout-before-fix.json).

`renderRows`가 렌더 단위로 사용자 필드 정의를 한 번 캡처하고, id·label·valueType 구조가 바뀔 때만 가상 테이블을 무효화하도록 수정했다. 일반 값 입력 시 활성 DOM 보호와 IME 중 갱신 지연은 그대로 적용한다. 테스트 기대값을 줄이지 않았으며, 날짜 셀 생성 및 저장된 `saleAmount2` 포커스 복원을 명시적으로 확인하는 assertion을 추가했다.

- 실제 `test-smartinput-initial-input-layout-browser.mjs` 전체 **PASS**: 첫 진입·기존 설정 마이그레이션·4개 전표의 양식·사용자 변경 저장/복원·Enter 순서·독립 값·0·음수·사용자 날짜 원문·기존 사용자 필드·다른 전표 데이터 보존·반응형/테마 검사. 런타임 예외 0개. [변경 후 결과](deploy-initial-layout-after-fix.json).
- `test-smartinput-table-viewport.mjs` **23/23 PASS**: 일반 활성 편집기 보호, 명시 무효화, IME 조합 중 지연, 숨긴 테이블의 지연 갱신 포함.
- 레이아웃 브라우저 실행 main SHA-256: `6851ec57367a9211177102aa07b6eabea9395b3a4bef84bac56d18d19612828b`.
- 해당 실행 종료 후 별도 쇼핑몰 계약 수정에 맞춰 main의 `shopping-order-upload.js` import만 v0.1.3으로 올렸다. 최종 main SHA-256: `23fb22c1d6d8001fe090e05981233782875708d404d9a6f1e50aad7cd96b547b`. 레이아웃 함수는 동일하며 쇼핑몰 연동은 담당자가 별도 검증한다.
