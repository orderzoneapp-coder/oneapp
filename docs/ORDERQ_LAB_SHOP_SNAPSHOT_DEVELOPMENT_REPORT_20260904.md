# OrderQ Lab 쇼핑몰 주문 스냅샷 개발·검증 보고서

- 작업 ID: `NEXUS-ORDERQ-SHOP-SNAPSHOT-20260904-01`
- 작업일: 2026-09-04 (Asia/Seoul)
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- fetch 후 기준 SHA: `5c10113442890a78b03435ee3f990eedd389fe13`
- 브랜치: `codex/orderq-shop-snapshot-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-orderq-shop-snapshot-20260904`
- 구현 커밋: `b6d5e35bd0e28745e342e4db7154fdb5e985efd9` (`b6d5e35`)
- PR: `https://github.com/orderzoneapp-coder/oneapp/pull/507`
- 병합 상태: 미병합. PM 독립검증 전 병합 금지

## 기준선·변경 경계

작업 시작 시 `origin/main`을 fetch했고 HEAD가 요구된 최소 기준과 같은 `5c10113442890a78b03435ee3f990eedd389fe13`임을 확인했다. 저장 프로젝트 checkout `C:\Users\USER\Documents\ChatGPT\NEXUS\oneapp`에는 기존 병합 충돌 두 건(`DU nexus/common/nexus-ui.css`, `DU scripts/test-nexus-common-ui-recovery.mjs`)이 있었으므로 수정·정리·reset하지 않았다. 최신 `origin/main`에서 위 전용 브랜치와 worktree를 만들었고 모든 구현과 검증은 그 안에서만 진행했다.

적용 규범은 `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md` v2.1.30과 관련 archive/manifest 계약이다. 운영 `orderq/`, `orderops/`, 공통 runtime/header, manifest, DB schema, 서버, Gateway는 변경하지 않았다. 변경 범위는 독립 앱 HTML, OrderQ Lab 전용 테스트, 본 보고서 하나뿐이다.

구현 커밋의 diff는 4 files changed, 808 insertions, 7 deletions이다.

- 수정 `archive/OrderQ_Lab.html`
- 수정 `scripts/test-orderq-lab-engine.mjs`
- 수정 `scripts/test-orderq-lab-standalone.mjs`
- 신규 `scripts/test-orderq-lab-shop-snapshot.mjs`
- 신규 본 보고서(후속 문서 커밋)

## 구현 선택과 이유

### 식별·비교 규칙

입력에 주문번호가 없으므로 주문번호를 만들거나 추정하지 않았다. `documentNo`는 계속 빈 문자열이며 `candidateId`와 `workingOrderId`는 로컬 내부 중복 방지·연결용 기술 식별자일 뿐 외부 주문번호가 아니다.

1. 정확한 17열 헤더와 `Worksheet` 시트를 검증하고 배송일자를 정규화한다.
2. 선택한 배송일자의 행만 원본 순서로 필터한 뒤, 같은 거래처이면서 원본 행번호가 연속인 구간만 후보 블록으로 묶는다. 같은 날짜·거래처라도 떨어져 있으면 별도 후보다.
3. 블록의 핵심 내용 digest와 상태 포함 digest를 분리했다. 상태만 바뀐 블록은 같은 후보의 상태변경으로 연결되고, 수량·상품·메모·주소 등 다른 핵심값이 바뀌면 자동 덮어쓰기하지 않고 확인 필요로 보낸다.
4. 절대 행번호는 원본 증거로 저장하되 동일 내용 비교 digest에는 넣지 않았다. 따라서 일일 파일 2~15행과 누적 파일 12,289~12,302행처럼 위치만 다른 동일 배송일자 데이터는 변경 없음이다.
5. 행수·마지막 행은 UI 메타데이터일 뿐 동일성 기준으로 사용하지 않는다. 상태를 포함한 선택 날짜 전체 블록의 정규화 hash가 같을 때만 변경 없음이다.

### 상태·재주문 처리

- 첫 업로드의 `주문`·`입금` 블록은 신규 주문, `준비`·`완료` 블록은 이미 처리된 기준선으로 기록한다. 모두 현재 활성 작업 원천을 구성하지만 기준선은 신규 건수에서 제외한다.
- 첫 업로드의 `취소` 블록은 활성 작업에서 제외하고 최신 source snapshot과 compact event의 취소 증거에 보존한다.
- 후속 새 활성 블록은 한 번만 신규 입력한다. `주문`·`입금`에서 `준비`·`완료`로의 이동은 상태변경이며 신규로 세지 않는다.
- 활성 블록이 취소되면 기존 `workingOrderId`를 유지한 채 `CANCELLED`로 바꾸므로 작업 계산에서는 빠지고 이력·원본 연결은 남는다.
- 기존 취소 블록과 그 뒤의 새 활성 블록은 digest 발생 순번이 다른 두 후보로 취급해 기존 취소 + 신규 재주문으로 처리한다. 같은 후보 위치의 취소를 다시 활성화하는 모호한 경우는 확인 필요로 차단한다.

### 원본·저장 경계

선택 날짜의 최신 성공 source snapshot에는 파일 fingerprint, 파일/시트, 헤더, 원본 행번호·상대 순서, 17개 `sourceCells`/`sourceValues`, 상태·메모·주소·전화, 행·블록 digest를 보존한다. derived working orders만 상태에 따라 다시 구성하며 source snapshot을 주문 처리 결과로 덮어쓰지 않는다. 배송일자별 성공 snapshot은 하나만 유지하고 compact event는 최근 300건으로 제한한다.

파일 선택과 날짜 변경은 메모리의 임시 분석만 바꾸며 `반영 확정` 전 localStorage와 작업 주문을 수정하지 않는다. 확정 시 다음 workspace 전체를 메모리에서 먼저 만들고 기존 v1 key `oneapp.orderq.lab.workspace.v1`에 한 번 저장한 뒤 동일 payload를 재조회한다. 쓰기 또는 검증 실패 시 직전 payload를 복원하고 복원까지 확인한 뒤에만 오류를 반환한다. 성공 후에만 메모리 state를 교체하므로 새 snapshot과 derived orders가 함께 성공하거나 함께 이전 상태로 남는다. 같은 분석의 중복 확정은 직전 hash/회차가 달라져 `SHOP_ANALYSIS_STALE`로 거절된다.

기존 key와 `orderq-lab-workspace/v1` schema를 유지하고 쇼핑몰 필드만 additive migration으로 보완했다. 실제 브라우저에서 기존 v1 주문·기초·구매·판매·실사 workspace를 복원한 상태로 v1.1을 열어 호환성을 확인했다. 이 앱은 로컬 독립앱이며 서버/API나 다른 앱 저장소에는 쓰지 않는다.

## 실제 입력 분석

| 파일 | 실제 범위 | 분석 결과 |
|---|---:|---|
| `C:\Users\USER\Desktop\orderlist-260904.xls` | `Worksheet!A1:Q15`, 데이터 14행 | 2026-09-04 한 날짜, 5개 연속 블록, 준비 9행·입금 3행·주문 2행, 신규 3건·처리 기준선 2건·확인 필요 0건 |
| `C:\Users\USER\Desktop\orderlist-260904 (분석).xls` | `Worksheet!A1:Q12302`, 데이터 12,301행 | 207개 배송일자, 완료 11,220행·준비 798행·취소 236행·입금 45행·주문 2행, 전체 3,324개 거래처 연속 블록, 0수량 8행 |

누적 파일의 2026-09-04 마지막 14행은 첫 파일의 14행과 내용·상태·순서가 같고 절대 원본 행번호만 다르다. 첫 파일을 확정한 뒤 누적 파일을 올렸을 때 `9월 4일 2차 업로드 · 변경 없음`으로 판정됐다. Node 자동 테스트의 누적 파일 parse는 1,994.0ms, 인앱 브라우저 parse는 664ms였다. 5초 실용성 게이트를 통과했다.

## 자동 검증

사용한 런타임은 Codex bundled Node.js다.

```powershell
& $node scripts/test-orderq-lab-standalone.mjs
& $node scripts/test-orderq-lab-engine.mjs
& $node scripts/test-orderq-lab-shop-snapshot.mjs
& $node scripts/validate-repository.mjs
```

결과:

- standalone DOM·버전·저장키·전용 UI·문법 계약 PASS
- 기존 parser/matching/immutable event/inventory/output engine PASS
- 기존 6종 결과 시트 `출고현황`, `발주현황`, `재고수불부`, `창고별재고`, `대체소분이력`, `상품관계` 생성·직렬화 PASS
- 관리자 확정 대체/소분, 실제 재고차감, 명시적 실사 0 보존 회귀 PASS
- 실제 14행/12,301행 parse·동일 날짜 비교 PASS
- 합성 `1차 → 완전 동일 2차 → 신규 추가 3차`, 같은 행수 상태변경, 활성→취소, 취소+재주문, 같은 날짜/거래처 비연속 블록, 핵심값 변경, 이전 행 소실, 0수량, 최초 취소 증적, 저장 실패 rollback, 같은 분석 중복 확정 차단 PASS
- 주문번호 미생성, 원본 주소·행번호·17열 보존 PASS
- 저장소 validator 24 checks, 0 warnings
- `git diff --check` PASS
- 구현 커밋 GitHub Actions run `33835049392`: `Validate Phase 6B approved-base UI` 15초 PASS, `Validate repository contracts` 2분 5초 PASS

## 브라우저·UI 검증

로컬 HTTP origin에서 인앱 브라우저로 실제 파일 선택 이벤트를 사용했다.

- 1920×1080 dark 및 light: 페이지 가로 넘침 없음, 쇼핑몰 패널 1,554px, 파일 선택 버튼 대비 정상
- 1440×900 dark 및 light: 페이지 가로 넘침 없음, 쇼핑몰 패널 1,359px, 파일 선택 버튼 대비 정상
- 390×844 dark 및 light: 문서 폭 375px로 페이지 가로 넘침 없음, 쇼핑몰 패널 337px. 1,506px 결과 표는 357px `table-wrap` 내부 스크롤로 제한
- 모바일 상단 5개 액션은 동일 폭 grid로 배치해 잘림을 줄였고 light 모드 파일 선택 버튼의 전경/배경 대비를 별도로 보정
- 실제 14행 파일: `9월 4일 2차 업로드 · 변경 없음`, 14행·5블록·2ms
- 실제 누적 파일: 207개 날짜 옵션, 기본 선택 2026-09-04, 전체 12,301행 중 14행·5블록·664ms, 변경 없음
- `결과 Excel`을 브라우저에서 실행해 성공 안내를 확인했고, 생성 workbook의 6개 시트와 값은 engine 재개봉 테스트로 검증
- 최종 console/runtime error/warning: 0건

캡처는 저장소 밖 작업 증적 폴더에 두어 제품 diff에 포함하지 않았다.

- `C:\Users\USER\Documents\ChatGPT\NEXUS\evidence\NEXUS-ORDERQ-SHOP-SNAPSHOT-20260904-01\orderq-shop-1920-dark.png`
- `C:\Users\USER\Documents\ChatGPT\NEXUS\evidence\NEXUS-ORDERQ-SHOP-SNAPSHOT-20260904-01\orderq-shop-390-light.png`

## 알려진 제한·rollback

- 고정 양식 안전성을 위해 시트명과 17열 헤더·순서가 다르면 자동 추정하지 않고 거절한다. 새 양식 지원은 별도 버전 계약이 필요하다.
- 주문번호가 없으므로 외부 시스템 주문과 자동 조인하지 않는다. 거래처·연속 행 블록의 발생 순번으로도 안전하게 식별할 수 없는 재배열·내용 교체·소실은 확인 필요로 남는다.
- 화면에는 확인 필요 상세를 처음 20건까지 표시하고 나머지는 추가 건수로 알린다. 전체 원본은 임시 분석에 남지만 확인 필요가 하나라도 있으면 확정하지 않는다.
- 배송일자별 최신 snapshot과 derived orders는 localStorage에만 존재한다. 많은 날짜를 장기간 누적해 브라우저 quota에 닿으면 원자 저장이 실패하고 이전 workspace로 rollback된다. `작업 저장`으로 내려받은 JSON은 브라우저 외 별도 백업이다.
- CDN 차단 시에도 저장소의 기존 vendored SheetJS를 먼저 읽어 로컬 Excel parse가 가능하다. 스타일 확장 CDN이 없으면 기본 SheetJS 출력 경로를 사용한다.
- 독립 archive 앱이므로 서버 동기화, 운영 ORDER Q 주문 생성, 다른 앱 저장소 쓰기는 의도적으로 없다.

PR이 병합되기 전 rollback은 PR #507을 닫고 전용 브랜치를 보존 또는 삭제하면 된다. 이후 코드 rollback이 필요하면 구현·보고서 커밋을 되돌리는 별도 revert PR을 사용한다. v1 key/schema는 유지했으므로 새 필드를 모르는 구버전은 기존 필드만 읽고, 사용자의 기존 v1 workspace를 강제로 삭제하거나 reset하지 않는다.

## PM 독립검증 요청

PR #507은 PM 승인 전 병합하지 않는다. 독립 검증은 실제 두 Excel의 9월 4일 동일성, 최초 기준선/신규/취소, 활성→취소 연결, 취소+재주문, 확인 필요 자동적용 차단, 저장 실패 rollback, 주문번호 공백, 기존 6종 Excel·대체/소분·재고실사 회귀, 390/1440/1920 light/dark와 console 0건을 재확인해야 한다.
