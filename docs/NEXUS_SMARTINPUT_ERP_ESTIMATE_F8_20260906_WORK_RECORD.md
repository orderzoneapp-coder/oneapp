# NEXUS-SMARTINPUT-ERP-ESTIMATE-F8-20260906 작업 기록

## 착수 기준과 범위

- 작업일: 2026-09-06 (Asia/Seoul)
- 기준 `origin/main`: `abfd14e668fd0373ba46d6ed9e9b51ffa0d4ad5a`
- 브랜치: `codex/smartinput-estimate-cloud-report-20260906`
- 전용 worktree: `/workspace/scratch/7ec7f5653ab2/oneapp-smartinput-estimate-cloud-report-BeIURf`
- 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 착수 상태: 기준 SHA와 HEAD가 같고 기존 변경이 없는 clean 상태를 확인했다.
- 확인 규범: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md` v2.1.32, `roles/DEVELOPER.md`, `app-manifest.json` v1.3.12, `smartinput/README.md`.

## 현재 상태와 목표 상태

- 현재 SmartInput 견적서 현황 업로드는 점수가 같은 시트 중 앞 시트를 선택한다. 제공된 ERP 파일에서는 부분집합 `Sheet1` 205행·9거래처가 선택되고, 전체 원본 `견적서현황내역` 277행·10거래처가 누락된다.
- 현재 거래처별 일괄 갱신은 기존 견적 선택, 명시적 신규 생성과 제외를 지원하고 거래처별 원자 저장을 수행한다. 이 저장 계약과 기존 identity는 유지한다.
- 현재 SmartInput Excel은 MerchOps F8과 시트/열/파일명/가격 의미가 일치하지 않는다.
- 목표는 정확한 ERP `견적서현황내역` 시트를 한 번만 선택해 277행·10거래처를 검토·갱신하고, 선택 견적을 MerchOps F8과 동일한 `쇼핑몰업로드` 22열·`ERP업데이트` 16열·조건부 `확인요청` 형식으로 출력하는 것이다.
- 같은 출력 품목코드 중복 또는 상충은 임의 대표값을 선택하지 않고 출력 전에 차단한다.
- 일괄 갱신 모달은 본문만 스크롤하고 하단 실행 버튼명은 데스크톱·모바일 viewport에서 항상 보이도록 최소 수정한다.

## 적용 경계

- SmartInput은 견적 원본과 현재 로컬 견적 카탈로그를 계속 소유한다.
- 입력·일괄 갱신·F8 XLSX 출력은 `LOCAL_OPERATION`이며 다른 앱 Repository나 서버를 호출하지 않는다.
- MerchOps 생산 코드를 공통화하거나 수정하지 않고 실제 F8 구현을 출력 계약 기준으로만 읽는다.
- `code.gs`, Cloud Gateway, `app-manifest.json`, `APP_ARCHITECTURE.md`, DB schema/store/key/index/migration/reset은 변경하지 않는다.
- ERP 원본의 공란, 숫자 `0`, 선행 0이 있는 창고·품목코드와 원본 증적을 보존한다.
- 코드 rollback은 이 작업의 SmartInput 자산·테스트·기록 변경을 되돌리며, 사용자가 이미 저장한 견적 데이터는 자동 삭제하거나 변경하지 않는다.

## 원본 파일 기준

- `견적서현황내역!A3:W279`: 실제 품목 277행, 거래처 10곳.
- `견적서현황내역!A280`: 비데이터 생성시각 행.
- `Sheet1!A3:W207`: 전체 원본에 그대로 포함된 창고 `02` 부분집합 205행이며 함께 읽으면 중복된다.
- 헤더는 A:W `일자, 창고, 거래처명, 품목명, 규격, 품목코드, 입고가, 출고가, 입고B, 도매A, 도매B, 행사가, 적요2, 간단설명, 1종연산, 외주비, 경비, 노무비, 재료비, 1종규격, 1종코드, 1입고, 1출고`다.
- A:F가 모두 있는 행만 품목행이며, 창고·품목코드는 문자열로 취급한다.

## 검증 계획

- 순수 계약: ERP 시트 우선순위, 277행·10거래처, 부분집합 중복 미수집, 비데이터 푸터 제외, 공란/0/문자열 코드 보존.
- 일괄 갱신: 기존 견적 갱신, 명시적 신규 생성, 미해결/충돌 0-write, 거래처별 원자성 기존 회귀.
- F8: 파일명, 시트 순서, 정확한 22/16열, 조건부 확인요청, 가격 역할, 0/공란/누락, 출력코드 중복 차단, 생성 XLSX 재열기 검증.
- UI: 데스크톱·모바일, 일반·다크, 모달 footer와 버튼명 표시, 본문 스크롤, Escape/cancel 0-write, console error 0.
- 변경 JavaScript 문법, SmartInput 관련 회귀, repository validator, `git diff --check`.

## 구현·검증 결과

### 구현

- `smartinput/estimate-workbook-selector.js`를 추가했다. 견적서 모드에서 정확한 ERP 23열 헤더와 `견적서현황내역` 시트명을 함께 확인하며, 비견적 모드는 기존 최고 헤더점수·동점 첫 시트 정책을 그대로 사용한다.
- 선택한 ERP 시트의 시트명·거래처 수·품목 수·원본 행 수를 입력 원본뷰와 적용 상태에 표시한다. 제공 파일을 읽기 검증한 결과 `견적서현황내역`, 277품목, 10거래처, 원본 280행, 23열이 선택됐고 `Sheet1`과 중복 수집되지 않았다.
- `smartinput/estimate-output.js`의 F8 adapter를 MerchOps 실제 출력 계약에 맞췄다. 출력은 `쇼핑몰업로드` 22열, `ERP업데이트` 16열, 경고가 있을 때만 `확인요청`이며 파일명은 `통합업로드용_QuickF8_YYYY-MM-DD.xlsx`다. C/D 가격 네 열은 숫자 `0`, 비숫자 단가는 `0`, 품목코드는 공백만 제거하고 끝의 `.0`은 보존한다.
- 견적 작업행의 직접 필드뿐 아니라 저장된 `inputMapping.mappings`, 헤더, `fieldValues`, `workingRows`, `sourceMatrix` 증적을 읽는다. 거래처별 분할 뒤 remap된 rowId에서도 원본 공란·숫자 0·문자 코드가 유지된다.
- 일반 단가 `unitPrice`를 입고가·도매가로 사용하지 않는다. 원본에 없는 F8 의미는 공란으로 두고 기준상품은 상품 마스터로 보강하지 않는다. 소분상품은 MerchOps의 계산식을 적용할 수 있는 필드가 있을 때만 계산하며, 새 소분행은 공식 상품정보가 있을 때만 추가한다. 복수 원물 선택이나 상품정보가 필요한 경우는 파일 생성을 차단한다.
- `smartinput/estimate-f8-source-plan.js`에서 실제 출력 작업표와 중복 검사용 원본을 분리한다. 열린 견적과 조합 미리보기는 현재 화면의 저장 전 수정값을 출력하고, 명시적으로 지운 값은 과거 원본값으로 되살리지 않는다. 연동견적·조합은 최신 개별 원본을 펼쳐 first-wins 병합 전에 중복을 검사한다. 원본/작업본 유형·소유 ID·행 ID·행 참조가 불완전하거나 중복된 경우와 여러 원본에 연결된 편집값의 적용 대상을 결정할 수 없는 경우는 파일 생성을 차단한다. 품목코드는 공백만 제거하고 선행 0과 끝의 `.0`은 보존하며, 같은 출력 품목코드는 파일을 만들지 않고 코드 목록을 표시한다. 제공 파일의 277행에는 서로 다른 중복코드 4개가 있어 전체를 그대로 F8 출력하면 의도대로 차단됨을 확인했다.
- 견적서 화면에 `F8 EXCEL` 버튼과 F8 단축키를 같은 출력 경로로 연결했다. 모달이 열려 있거나 다른 작업 중이면 실행하지 않는다.
- 거래처별 일괄 갱신 모달은 shell 높이를 viewport 안으로 고정하고 본문만 스크롤하며 footer와 `닫기 / 정상 전표 업데이트` 버튼을 고정했다.
- 정적 자산 cache-bust를 `smartinput.css?v=0.9.7`, `smartinput.js?v=0.11.27`, `estimate-output.js?v=0.2.1`, `estimate-f8-source-plan.js?v=0.1.0`으로 갱신했다. DB schema/store/key/index, 저장 identity, 클라우드·Gateway·manifest·아키텍처 파일은 변경하지 않았다.

### 자동검증

- 통과: `test-smartinput-estimate-workbook-selection.mjs`
- 통과: `test-smartinput-estimate-f8.mjs` — 생성 XLSX 재열기, 22/16열, 조건부 확인요청, 원본 공란/0/문자 코드, 분할 증적 fallback, 소분 안전차단, 277행·10거래처·중복코드 4개
- 통과: `test-smartinput-structured-sheet-parser.mjs`
- 통과: `test-smartinput-xlsx-source-reader.mjs`, `test-smartinput-input-template-mapping.mjs`, `test-smartinput-multivoucher-stage1.mjs`, `test-smartinput-empty-source-rows.mjs`, `test-smartinput-grid-clipboard.mjs`
- 통과: `test-smartinput-estimate-bulk-update.mjs`, `test-smartinput-estimate-per-customer-commit.mjs`, `test-smartinput-estimate-bundle-atomicity.mjs`, `test-smartinput-linked-estimate-source-edit.mjs`
- 통과: `test-smartinput-appheader-workspace.mjs`, `test-smartinput-independent-recovery.mjs`, `test-smartinput-settings-ux.mjs`, `test-smartinput-input-list-search.mjs`
- 통과: `validate-repository.mjs` 24 checks, `test-client-safety.mjs`, 변경 JavaScript 문법검사, `git diff --check`
- 신규 시트·F8 테스트는 `.github/workflows/repository-validation.yml`의 SmartInput 파서 단계에 연결했다.
- 브라우저 회귀에는 실제 파일과 같은 거래처 10개 overflow, 1840×864 포함 네 viewport·공식 일반/다크 테마 전환, 본문 독립 스크롤과 하단 버튼 전체 가시성, 277/10 원본요약, 조합 미리보기 이전 원본 중복차단, F8 키 동일경로 검증을 추가하고 CI 브라우저 단계에 연결했다. 현재 개발 컨테이너에는 Chrome/Edge 실행파일이 없어 이 두 브라우저 스크립트의 현지 실행은 불가하며 CI Chrome 검증 대상으로 남긴다.

### Rollback

- 이 변경의 SmartInput JS/CSS/HTML, 테스트, README와 작업기록만 되돌린다.
- 기존 견적 Store, 거래처별 갱신 결과, 입력 양식과 원본 증적은 삭제하거나 재작성하지 않는다.
