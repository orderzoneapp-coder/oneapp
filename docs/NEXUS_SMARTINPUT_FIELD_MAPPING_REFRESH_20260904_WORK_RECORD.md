# NEXUS-SI-FIELD-MAPPING-REFRESH-20260904 작업 기록

## 시작 기준

- 사용자 확정: 원본 항목명을 누르면 검색어와 일치하는 항목명을 보여주고, 결과가 없으면 기준정보를 새로고침한 뒤 같은 검색어로 다시 찾아 선택·매칭할 수 있어야 한다. 자동 추천 확대는 요구하지 않는다.
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main`: `8bf9ddf480be13f52fb93198bf0ef083be1dc892`
- 브랜치: `codex/smartinput-field-mapping-refresh-20260904`
- worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-field-mapping-refresh-20260904`
- 시작 상태: clean
- 확인 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md`, `app-manifest.json` v1.3.9, `roles/DEVELOPER.md`

## 현재 상태와 오류

- 원본 열 머리글을 누르면 매핑 검색창은 열리지만 검색 대상이 현재 화면에 선택된 필드로 제한된다.
- `거래처명`처럼 업무상 필요한 비노출 기본 필드는 검색 결과에 없을 수 있다.
- 매핑 창에서 기준정보를 다시 불러오고 동일 검색어로 재검색하는 작업 흐름이 없다.
- 전체 기준정보 새로고침 뒤 필드 등록부의 메모리 상태를 다시 읽지 않아 열린 화면의 항목 검색 결과가 갱신되지 않는다.

## 목표 상태

- 원본 항목명 클릭 후 검색어에 맞는 전체 사용 가능 매핑 항목을 경로와 함께 표시한다.
- 현재 표시 열이 아닌 기본 필드도 수동 검색·선택할 수 있게 하되 자동 추천 범위는 기존과 동일하게 유지한다.
- 매핑 창에서 `기준정보 새로고침`을 실행하고 성공 시 현재 검색어·원본·입력 작업본을 보존한 채 결과 목록만 다시 계산한다.
- 새로고침 실패 시 기존 기준정보와 검색어·작업본을 유지하고 이해 가능한 오류를 표시한다.

## 경계

- 변경 허용: SmartInput 필드 매핑 검색 UI, 필드 대상 조회, 명시적 전체 기준정보 새로고침 후 필드 등록부 재로딩, 관련 테스트와 캐시 토큰.
- 변경 금지: DB schema/Store/key/migration/reset, 원본 Excel 값·행·열·signature, 입력 양식 저장계약, 전표 저장 payload, 공식전표 V2, 상품·거래처 owner 쓰기, 공통 Runtime, 기존 버튼·단축키와 정상 전표 입력 흐름.
- 실행 분류: 일반 개발. 검색과 로컬 매핑은 `LOCAL_OPERATION`, 명시적 기준정보 새로고침은 기존 불변 generation 활성화 경계를 재사용한다.
- 롤백: 단일 작업 commit 또는 merge commit revert. 데이터 migration/복원 없음.

## 완료조건

1. 비노출 `거래처명` 필드를 검색해 행별 거래처명으로 선택·매핑할 수 있다.
2. 검색 결과가 없을 때 같은 창에서 기준정보 새로고침이 가능하다.
3. 새로고침 성공·실패 모두 검색어와 활성 입력 작업본을 보존한다.
4. 기존 자동 추천, 양식 signature, 원본형·입력형 전환, 저장 차단 규칙은 유지된다.
5. 집중 브라우저 검사와 관련 SmartInput 회귀검사가 통과하고 console/runtime error가 없다.

## 구현 결과

- 원본 열 머리글의 매핑창에서 공백을 무시하는 항목명 검색을 제공한다. 검색어가 있을 때는 현재 노출 열뿐 아니라 `ACTIVE`·`mappable`인 전체 수동 매칭 후보를 조회한다.
- 검색 결과에 전표 종류와 `상단 정보`·`작업테이블`·`기준정보 등록 필드` 경로를 표시하고, 사용자가 선택하기 전에는 자동 반영하지 않는다.
- 비노출 기본 필드 `rowCustomerName`을 `거래처명`으로 검색·선택하면 각 원본 행의 거래처명이 작업행에 투영된다.
- `기준정보 새로고침`은 기존 6개 도메인 불변 generation 경계를 재사용하고 필드 catalog를 강제 재조회한 뒤 전표별 메모리 등록부를 다시 읽는다. 검색어, sourceMatrix, 양식 signature, workingRows는 유지한다.
- 수동 검색 후보 확대와 자동 추천을 분리했다. 비노출·등록부 후보는 `recommendable=false`로 두고, 헤더 자동 탐지와 기존 자동 추천은 현재 회사·전표 표시 설정 범위를 유지한다.
- SmartInput CSS/JS cache token은 `0.9.3`/`0.11.17`, 매퍼/새로고침 모듈 token은 `0.2.4`/`0.1.1`로 갱신했다.

## 검증 결과

- 실제 Chromium 집중 E2E: 숨은 `거래처명` 검색, 새로고침 뒤 검색어 유지, 원본·signature·working copy 불변, 수동 선택 후 행별 거래처명 투영, console/runtime error 0 통과.
- 화면: 1440 light 및 390 dark에서 결과 경로, 새로고침 버튼, 고정 footer와 viewport 무가로넘침을 확인했다.
- 전체 `scripts/test-smartinput*.mjs` 40개 현재 버전 통과. 중간의 자산 버전/승인 UI hash 실패는 의도한 cache token·매칭창 변경을 새 승인 기준으로 갱신한 뒤 통과했다.
- `scripts/validate-repository.mjs`: 24 checks, warning 0. `scripts/test-client-safety.mjs`, 변경 JS 문법검사, `git diff --check` 통과.
- DB schema/Store/key/migration/reset, 원본 Excel 값·행·열·signature, 전표 저장 payload, 공식전표 V2, 상품·거래처 owner 쓰기, 공통 Runtime 변경 없음.

## 증적

- `evidence/smartinput-field-mapping-refresh-20260904/smartinput-field-mapping-search-1440-light.png`
- `evidence/smartinput-field-mapping-refresh-20260904/smartinput-field-mapping-search-390-dark.png`
