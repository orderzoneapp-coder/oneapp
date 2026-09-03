# NEXUS-SI-ORDER-DOCNO-20260904-01 작업 기록

## 시작 기준

- 사용자 실행 승인: `업데이트해`
- 최신 범위: `내부 순번은 제외한다`
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main`: `a744d3d8c9117579b97bd3f8087fd6bedf050933`
- 브랜치: `codex/smartinput-order-docno-date-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-order-docno-date-20260904`
- 선행 시작 기록: clean
- 대체 인계 확인 상태: 생산 commit 없음. 같은 작업의 부분 변경 3개와 신규 구현·테스트·기록 파일, `.codex-tmp-xlsx-inspect/`가 미커밋 상태였으며 모두 보존·감사한 뒤 이어서 작업함
- 확인 규범: `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` v2.1.30, `app-manifest.json` schema v1.3.9, `orderq/ARCHITECTURE.md` v0.9.0, `smartinput/README.md`, SmartInput draft·field·mapping 계약

## 현재 상태와 실패 재현

- 주문 입력 양식은 원본 열 하나를 대상 필드 하나에만 연결한다. `일자-No.`는 현재 주문번호 별칭이 아니므로 자동 추천되지 않는다.
- `2026/09/04-35`를 주문번호에 수동 연결해도 주문일자와 납기일자는 파생되지 않는다.
- 다중 주문 저장 payload는 원본 주문번호를 ORDER Q의 외부 원문 필드 `externalOrderNo`로 전달하지 않는다.
- 실패 재현은 `scripts/test-smartinput-order-document-number.mjs`로 먼저 고정한다. 구현 전에는 순수 파서 모듈이 없어 실패해야 한다.

## 실제 자료 확인

- 원본 `C:\Users\USER\Desktop\미출고현황.xlsx`은 수정하지 않는다.
- `미판매현황` 시트 사용범위는 `A1:O89`이고 2행 헤더에 `일자`, `일자-No.`, `담당`, `창고코드`, `단위`, `품목코드`, `품목명`, `규격`, `수량`, `재고`, `단가`, `적요`, `적요1`, `거래처`, `그룹`이 있다.
- 대표값 `2026/09/04-35`가 여러 품목행에 반복되므로 주문번호별 그룹 안에서 원본 품목행을 모두 보존해야 한다.
- Spreadsheet skill의 `artifact_tool`로 workbook을 읽기 전용 로드해 시트·범위·헤더·대표 반복값을 확인했다. 파일은 export·save하지 않았고 원본의 길이와 최종 수정시각도 변경하지 않았다.

## 구현 설계

1. 주문 모드에만 `일자-No.`를 주문번호의 정확 별칭으로 추가한다. 기존 위치 기반 signature와 사용자 매핑 결정은 바꾸지 않는다.
2. DOM·저장소와 분리된 순수 모듈이 마지막 `-`를 경계로 세 가지 날짜 구분자와 숫자 뒤부분을 검증한다. 반환값은 원문 전체와 정규화 날짜뿐이며 뒤 숫자는 반환·저장하지 않는다.
3. 매핑 projection 직후 같은 원본 셀 evidence를 주문일과 납기일 파생값에 연결한다. `sourceMatrix`, `sourceCellMatrix`, working rows와 signature는 변경하지 않는다.
4. 별도 주문일·납기일이 있으면 실제 날짜로 정규화해 파생 날짜와 비교한다. 다르거나 형식이 잘못되면 행 오류를 남기고 그룹 저장을 fail-closed한다.
5. 주문 그룹 payload는 검증된 원문 전체를 ORDER Q `externalOrderNo`로 전달한다. 기존 `orderNo`는 ORDER Q가 발급하는 관리자 번호 계약을 유지하고, `일자-No.` 뒤 숫자를 위한 신규 필드·DB·UI는 만들지 않는다.
6. Excel과 표 형태 클립보드는 같은 mapping projection을 사용하므로 동일 변환을 공유한다. 주문 외 전표는 변환하지 않는다.

## 데이터·소유권 경계

- SmartInput draft와 입력 양식·원본 증적의 기존 소유권을 유지한다.
- ORDER Q 저장은 기존 `createOrder()` 경계만 사용하며 DB schema, Store, key, index, migration과 reset은 변경하지 않는다.
- 공식 구매·판매 V2, 기준정보 owner, 공통 Runtime과 다른 앱은 변경하지 않는다.
- HTML 마크업·CSS·입력테이블 열·버튼·단축키·레이아웃은 변경하지 않는다. 새 모듈 배포를 위한 `smartinput.js` cache token만 갱신한다.

## 구현 결과

- 주문 모드에서만 정확한 `일자-No.` 헤더를 기존 외부 주문번호 항목의 추천 후보로 제공하며, 사용자가 매핑을 확정하기 전에는 공식 양식으로 저장되지 않는다.
- 순수 파서는 마지막 `-`를 경계로 slash·dot·hyphen 날짜 형식을 검사하고 실제 달력 날짜와 숫자 뒤부분만 허용한다. 반환값에는 원문 전체와 정규화 날짜만 있으며 뒤 숫자 필드는 없다.
- projection 단계에서 주문일과 납기일을 같은 날짜로 파생하고 같은 원본 셀 evidence를 연결한다. 별도 일자가 있으면 정규화 후 비교하며 충돌 값을 포함한 오류로 그룹 저장을 차단한다.
- 동일 주문서번호의 여러 품목행은 하나의 전표 그룹 안에 모두 남는다. 완전 빈 행만 작업행에서 제외하고 내부 빈 셀, `0`, 음수를 보존한다.
- ORDER Q payload는 원문 전체를 `externalOrderNo`, 날짜를 `orderDate`와 `deliveryExpectedDate`로 전달한다. ORDER Q 관리자 `orderNo` 발급 계약은 그대로이며 `일자-No.` 뒤 숫자를 별도 내부 값으로 만들지 않는다.

## 검증 결과

- 신규 순수 회귀: slash·dot·hyphen, 불가능 날짜, 번호 누락·비숫자, 별도 주문일·납기일 일치/충돌, 반복 주문번호 다수 행, 원문 주문번호 저장, 내부 순번 미생성, source evidence·signature·working rows 불변, 빈 행·내부 빈 셀·`0`·음수, 주문 외 모드 불변 통과.
- 전체 `scripts/test-smartinput*.mjs`: 41/41 통과.
- 실제 Chromium 회귀: 1920/1440/390 light·dark, 원본형/입력형, F3·Escape·닫기, 품목코드 Enter, 숨은 선택 일괄작업 방어, console error 0, runtime exception 0 통과.
- `scripts/validate-repository.mjs`: 24 checks, 0 warnings. `scripts/test-client-safety.mjs`, 변경 JavaScript 문법검사, `git diff --check` 통과.
- 승인 UI 기준은 4개 전표 탭, 7개 작업 버튼, 13개 표 열, 5개 footer action, 6개 keyboard contract를 유지했다.

## 롤백

- 이 작업의 단일 commit 또는 향후 merge commit을 revert한다.
- schema와 migration이 없으므로 데이터 삭제·복원은 수행하지 않는다.
