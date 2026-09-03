# OrderQ Lab 개발·검증 보고서

- 작업: archive Excel-only 독립 OrderQ Lab
- 작업일: 2026-09-03 (Asia/Seoul)
- 기준 원격: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 SHA: `51ad59092b35db475b3c807f65f987939dca7e2c`
- 브랜치: `codex/orderq-lab-20260903`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-orderq-lab-20260903`
- 목표 엔트리: `archive/OrderQ_Lab.html`

## 0단계 — 기준선·규범·배포 경계

`C:\Users\USER\Documents\ChatGPT\NEXUS\oneapp`의 저장 checkout은 `main`이 원격보다 450커밋 뒤처져 있었고 두 파일이 병합 충돌(`DU`) 상태였다. 다른 작업의 변경 보존과 기준선 정확성을 위해 이 checkout에서는 `origin` 참조만 갱신하고 소스 수정·checkout·reset을 하지 않았다. 최신 `origin/main`을 기준으로 전용 브랜치와 worktree를 만들었다.

생성 전에 원격·로컬의 `*orderq*lab*` 브랜치, 열린 GitHub PR의 제목·head 브랜치, `archive` 안의 OrderQ Lab 경로를 조회했다. 동일 구현이나 경로 충돌은 없었다. 기준 SHA, 브랜치 HEAD와 `origin/main`은 모두 위 SHA와 일치했고 새 worktree는 clean이었다.

### 패치 경로 오적용과 복구 확인

초기 골격을 처음 추가할 때 패치 도구의 기준 디렉터리가 명령별 workdir가 아니라 상위 공유 작업공간 `C:\Users\USER\Documents\ChatGPT\NEXUS`로 해석됐다. 직후 전용 worktree에서 테스트 파일을 찾지 못한 오류가 발생해 오적용을 발견했다. 당시 생성 명령은 존재하지 않던 아래 세 파일을 `Add File`로 새로 만드는 명령뿐이었고 기존 파일을 update하지 않았다.

- `C:\Users\USER\Documents\ChatGPT\NEXUS\archive\OrderQ_Lab.html`
- `C:\Users\USER\Documents\ChatGPT\NEXUS\scripts\test-orderq-lab-standalone.mjs`
- `C:\Users\USER\Documents\ChatGPT\NEXUS\docs\ORDERQ_LAB_DEVELOPMENT_REPORT_20260903.md`

세 파일의 내용을 전용 worktree 경로로 패치 이전한 뒤 상위 경로의 세 파일을 삭제했고, 이번 추가로 생긴 빈 `archive`, `scripts`, `docs` 디렉터리만 비재귀적으로 제거했다. 복구 후 위 세 상위 파일의 `Test-Path`는 모두 `False`였다. 저장 프로젝트 `git status --short`에는 작업 전부터 있던 다수의 untracked 자료와 작업 디렉터리만 보였고 위 세 경로는 남지 않았다. 실제 oneapp checkout 상태도 기존 충돌 두 건(`DU nexus/common/nexus-ui.css`, `DU scripts/test-nexus-common-ui-recovery.mjs`) 그대로이며 새 파일은 없었다. 어떤 기존 사용자 파일도 삭제·reset·덮어쓰기하지 않았다.

복구 재확인 시 전용 worktree 절대경로는 `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-orderq-lab-20260903`, 브랜치와 HEAD는 `codex/orderq-lab-20260903@51ad59092b35db475b3c807f65f987939dca7e2c`, `origin/main`도 같은 SHA였다. 이후 모든 패치는 상위 작업공간 기준 `work/oneapp-orderq-lab-20260903/` 접두 경로로 제한했다.

적용 문서는 `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md`, `orderq/ARCHITECTURE.md`, `app-manifest.json`이다. 적용한 핵심 경계는 다음과 같다.

- 원본 Excel 값과 공란/0을 보존하고 계산 결과와 원천을 비교 가능하게 한다.
- 앱은 로컬에서 독립 실행하며 다른 앱의 저장소나 운영 데이터를 직접 쓰지 않는다.
- ORDER Q가 주문·출고·재고 업무를 소유하지만 이 Lab은 기존 ORDER Q/OrderOps/DataOps 운영 앱과 저장계약을 덮어쓰지 않는다.
- archive lifecycle은 manifest의 운영 앱 승격이 아니므로 `app-manifest.json`과 NEXUS 내비게이션을 변경하지 않는다.
- GitHub Pages는 `main`의 정적 파일을 자동 배포한다. 따라서 병합 후 `archive/OrderQ_Lab.html` 직접 URL만 기술 확인하고 활성 메뉴 엔트리로 등록하지 않는다.
- rollback은 이 Lab 정적 파일·테스트·보고서 PR의 revert이며 운영 앱 데이터나 확정 이력을 삭제하지 않는다.

## 1단계 — 비교 분석과 구현 판단

| 대상 | 확인한 계약/동작 | 판단 | OrderQ Lab 적용 |
|---|---|---|---|
| PM 프로토타입 | 6종 Excel 카드, 시트/헤더 탐색, 상품 집계, 거래처 칩 드래그, 관계확정, 관리자 대체수량 모달, 4종 결과 시트 | 골격 재사용 후 강화 | 단일 HTML과 익숙한 화면 구조를 유지하되 파서·이벤트·대사·출력 계약을 보강 |
| OrderOps `orderFulfillmentEngine.js` | 30행 헤더 탐색, canonical alias, 중복 canonical 헤더 차단, 공란/0 구분, 원본 matrix 보존, 주문·재고 검증 | 계약 재작성 | 독립 HTML 안에 필요한 최소 파서 계약을 재작성. `창고코드`는 식별 필드로만 취급 |
| OrderOps `orderFulfillmentWorkbook.js` | 주문현황·수불·창고별재고 분리, 숫자/문자 형식, 필터·동결·출력 스타일 | 출력 관례 재작성 | 네 필수 출력물과 관계/대체 이력을 분리하고 원가·업로드 시트는 제외 |
| ORDER Q history collector | 거래처·상품·일자 증거 기반 주문/판매 링크, 미출고 잔량, 관리자 확정 링크, 모호성 보존 | 범위 축소 재작성 | 거래처+상품의 결정적 매칭과 행별 잔량만 사용. 추정 후보는 이슈로 남기고 자동 확정하지 않음 |
| DataOps 거래처 칩·치환 | 원본 판매근거와 칩 배정 분리, drag/drop, undo, 대체·소분 수불 반영 | 상호작용 개념만 재사용 | 거래처 칩 드래그와 이벤트 기반 실제 출고 반영. DataOps 저장소·마스터·원가층은 사용하지 않음 |
| DataOps 단위환산/원가 | 규격에서 kg를 추출해 환산수량·원가를 추론하는 코드가 존재 | 명시적 제외 | `inferEquivalentTargetQty`, `calcConvertedUnitCost`, 원가·마진·이익률·정산을 포함하지 않음 |
| DataOps 실사 | 전산잔량과 공란 실사를 구분하고 실사차이를 표시 | 규칙 재작성 | 실사 미제공은 `null`, 명시적 0은 0으로 유지하고 재고식과 수량대사를 검사 |

### 채택 결정

1. 관계확정 이벤트(`RELATION_CONFIRMED`)는 상품 인식 메모만 추가하고 어떤 수량도 바꾸지 않는다.
2. 실제 대체·소분 출고 이벤트(`SUBSTITUTION_CONFIRMED`)만 원상품의 실제출고를 줄이고 대상상품 실제출고를 늘린다.
3. 규격·단위는 화면 근거로만 보이며 대상 실제차감수량은 관리자 입력값과 `ADMIN_CONFIRMED` 권한을 요구한다.
4. 업로드 원본 행은 immutable source snapshot으로 저장하고, 변경은 append-only event로만 누적한다. undo는 과거 이벤트를 삭제하지 않고 별도 취소 이벤트를 추가한다.
5. 자료 역할별 원천을 합산한다. 같은 사실의 ERP 완성자료/출력물을 자동으로 다른 원천과 합산하지 않으며 동일 파일·행 digest의 중복 적용을 차단한다.

## 단계별 구현·검증

### 3단계 차단 이슈 — 판매 기간 합계행 오인식

첫 실제 파일 브라우저 검증에서 `0903판매.xlsx`의 338행이 적용되고 실제출고 합계가 `16,568,447`로 표시됐다. 상한처리나 보정 없이 `판매현황내역` 원본의 raw/display matrix와 파서 증적을 대조했다.

- 정확 헤더 위치: `수량` I열(index 8), `단가` J열(9), `공급가` K열(10), `구매` P열(15), `구매합계` Q열(16).
- 정상 대표 원본 행의 raw/display/파서 수량은 행 3=`8`, 행 73=`500`, 행 339=`2`로 모두 일치했다.
- 원본 행 340은 첫 셀이 `2026/09 계`, 품목코드 위치가 집계 건수 `2107`, 수량 위치가 금액 집계 `16566340`인 기간 합계행이었다. 종전 필터는 상품코드 위치가 비어 있지 않으면 합계행으로 보지 않아 이를 상품행으로 포함했다.
- `수량` 열이 단가·공급가·구매·구매합계 열과 중복 선택된 문제는 없었다. 문제는 위치가 다른 합계행의 집계 셀을 정상 품목코드·수량으로 오인한 행 분류였다.

선택한 수정은 첫 셀의 명시적 `총합계/합계/소계/총계`와 ERP 기간 합계 형식(`YYYY/MM 계`)을 원본 증거로 합계행에서 제외하는 것이다. 실제 상품 수량에 상한을 두거나 합계값을 임의 보정하면 500 같은 정상 대량 행을 훼손하므로 채택하지 않았다. 파서 결과에 exact `columnMap`을 보존하고, 동일 원천 열을 두 표준 필드가 재사용하지 못하게 유지했다.

회귀 테스트는 실제 `0903판매.xlsx`에서 헤더 positional contract, 대표 3행의 raw/display/sourceCells/parsed 증적, 기간 합계행 제외, 337개 정상행 및 raw/display/파서 전체 수량 합계 `2107` 일치를 검증한다. 수정 후 브라우저 재업로드 결과도 판매 337행, 실제출고 `2,107`, 오류 로그 0건으로 대사됐다. 이 게이트를 통과한 뒤에만 후속 엔진 검증으로 이동한다.

### 4단계 — 업무 엔진

- 주문/판매는 상품코드와 거래처코드(없으면 정규화한 거래처명)를 exact match하고, 주문일이 판매일보다 늦은 행은 매칭하지 않는다.
- 주문행별 `주문수량 = 매칭수량 + 미출고수량`을 검증하며, 음수 판매는 동일 상품·거래처의 선행 출고 링크를 역순 취소한다.
- 실제출고는 판매 원본 수량이며 대체·소분 이벤트가 있을 때만 원상품 복원과 대상상품 관리자 확정수량 차감으로 바뀐다.
- 발주필요는 `max(0, 미출고 - max(0, 계산재고))`, 계산재고는 `기초 + 구매 - 실제출고`, 실사차이는 명시적 실사값이 있을 때만 `실사 - 계산`으로 계산한다.
- 회귀에서 미래 주문 미매칭, 음수 판매 `-1` 취소, 판매 미매칭, 발주필요 `10 - 2 = 8`, 상품별 수불합계와 계산재고 일치를 확인했다.

### 5단계 — 사용자 작업 UI

기존 프로토타입의 익숙한 6개 파일 카드, 요약, 검색, 이슈 필터, 테이블, 거래처·창고 칩, 행 선택, 드래그 앤 드롭을 유지했다. 관계확정 버튼은 선택한 두 상품 사이의 `NONE` 수량영향 이벤트만 만들며, 칩을 대상 상품행으로 드래그하면 관리자 모달이 열린다. 모달은 원판매 전환수량과 실제 차감수량을 별도 필드로 표시하고 실제 차감수량을 자동 채우지 않으며 `ADMIN_CONFIRMED`로만 확정한다. 정적 DOM/event 계약과 엔진 이벤트 회귀를 통과했고, 실제 데이터 브라우저 화면에서 351개 상품, 거래처+창고 칩, 이슈 표시 및 오류 로그 0건을 확인했다.

기존 UI/UX 최소변경 원칙에 따라 카드→요약→검색/이슈→테이블→이력의 정보 구조, 테이블 컬럼 순서, 칩 드래그와 두 행 선택 동작을 유지했다. 운영 ORDER Q·OrderOps·DataOps의 HTML/CSS/JavaScript는 변경하지 않았고, 이 archive 앱과 전용 테스트·CI 호출·보고서만 추가했다.

관리자 치환 회귀는 원상품 규격 `10kg`, 대상상품 규격 `1kg`, 전환 판매수량 `1`, 관리자 직접 입력 실제차감 `2`를 사용한다. 대상상품 실제출고와 출력 `실제재고차감수량`은 모두 `2`이며 `10`이 아님을 검증한다. `AUTO_INFERRED` 권한은 거부되고 `ADMIN_CONFIRMED` 값만 반영된다.

### 6단계 — Excel 출력

단일 결과 파일의 시트는 `출고현황`, `발주현황`, `재고수불부`, `창고별재고`, `대체소분이력`, `상품관계`로 고정했다. 비용·원가·마진·이익률·정산 시트는 생성하지 않는다. 실제 4개 파일과 대표 주문을 결합한 검증에서 337개 출고행, 기초 267 + 구매 249 + 판매 337 = 853개 수불행, 원본파일·시트·행·digest 증적을 직렬화 후 재개봉했다. 수식형 문자열은 Excel 수식으로 실행되지 않도록 escape한다.

초기 시각 렌더에서 품명과 거래처 열이 짧게 보인 문제를 발견해 헤더뿐 아니라 최대 500개 데이터행의 한글 표시폭을 반영하도록 열 너비 계산을 수정했다. 재렌더 결과 품명·규격·수불유형·증감수량과 원본 증적 열이 서로 겹치지 않고 읽을 수 있음을 확인했다.

이 열 너비 수정은 workbook의 `!cols` 표시 메타데이터만 변경한다. 출력 데이터 배열, 수량식, 매칭, 수불과 실사 계산 계약은 변경하지 않았다.

### 7단계 — validator·회귀·브라우저

배포 전 로컬 검증 결과:

- `node scripts/validate-repository.mjs`: 24 checks, 0 warnings.
- `node scripts/test-orderq-lab-standalone.mjs`: standalone DOM·문법·드래그·관리자 모달·6시트 계약 PASS.
- `node scripts/test-orderq-lab-engine.mjs`: 파서, exact columnMap, 실제 파일 대사, 주문/판매 매칭, 이벤트 불변성, 중복실행 방지, undo, `ADMIN_CONFIRMED`, 수불·실사·출력 직렬화 PASS.
- `node scripts/test-shipping-management.mjs`: OrderOps 전체 계약 PASS. 이 테스트가 만든 주문 fixture `주문현황_브라우저.xlsx`를 Lab에 업로드해 4행·주문수량 13을 확인한 뒤 fixture 임시 디렉터리만 검증 후 제거했다.
- 기존 영향범위 회귀 PASS: `test-orderq-fulfillment-lifecycle`, `test-orderq-history-collector`, `test-orderq-smartparser`, `test-dataops-zero-stock-contract`, `test-dataops-operational-integrity`, `test-dataops-manual-substitution-actual-error`, `test-dataops-substitution-preview-readonly`.
- 실제 브라우저 업로드: 기초 267행, 구매 249행, 판매 337행, 실사 265행, 주문 fixture 4행. 판매 합계 2,107, 주문 13, 브라우저 오류·경고 로그 0건.
- 최신 수정본을 별도 빈 origin에서 다시 열어 title, 준비 메시지, 파일카드·요약·검색·테이블의 렌더와 오류·경고 로그 0건을 확인했다.
- CI가 동일 신규 테스트 두 개를 실행하도록 `.github/workflows/repository-validation.yml`에 archive Lab 전용 단계를 추가했다. 실데이터는 저장소에 포함하지 않으며 실제 파일 회귀는 로컬 경로가 있을 때 추가 실행한다.

### 변경 범위

- 신규 `archive/OrderQ_Lab.html`
- 신규 `scripts/test-orderq-lab-standalone.mjs`
- 신규 `scripts/test-orderq-lab-engine.mjs`
- 수정 `.github/workflows/repository-validation.yml` (신규 테스트 호출 5줄)
- 신규 본 보고서

운영 ORDER Q, OrderOps, DataOps, NEXUS 공통 UI, manifest와 내비게이션 파일은 변경하지 않았다.

구현 커밋 `1b922e2a56fea60b43c778799ee9fdc694ae7ecf`의 diff는 5 files changed, 1,981 insertions이다. 기존 파일 수정은 workflow의 신규 테스트 호출 5줄뿐이며 나머지는 archive 앱·테스트 2개·본 보고서 신규 파일이다.

### CI 대기와 판단

PR #500의 `Validate repository contracts` job은 2026-09-03 17:43 KST 생성 후 약 5분간 `ubuntu-latest` runner가 할당되지 않은 queued 상태였다. Actions 조회에서 같은 run의 `Validate Phase 6B approved-base UI`는 먼저 통과했고, 대기 job은 `runner_id/name=null`이며 실패·취소가 아니었다. 동일 job을 재실행하거나 다른 run을 취소하면 검증 증적과 다른 작업을 훼손할 수 있어 실행 중인 하나를 그대로 기다렸다. 17:48 KST runner가 배정됐고 1분 43초 동안 신규 OrderQ Lab 단계와 저장소 전체 단계를 포함한 모든 step이 통과했다. Actions run은 `33734878396`, 필수 job은 `100582990630`이다.

## 배포·운영 확인

- 구현 커밋: `1b922e2a56fea60b43c778799ee9fdc694ae7ecf`
- 구현 PR: `https://github.com/orderzoneapp-coder/oneapp/pull/500`
- CI: Actions run `33734878396`, 두 job 모두 success
- 병합 시각: 2026-09-03 17:50:19 KST
- main 병합 SHA: `85c746471bb65b4b402616056f040a96160c9ce8`
- GitHub Pages build: `1191654809`, commit `85c746471bb65b4b402616056f040a96160c9ce8`, status `built` (17:51:01 KST)
- 운영 URL: `https://oneapp.orderz.co.kr/archive/OrderQ_Lab.html`
- 운영 브라우저 확인: title `ORDER Q LAB · 주문·출고 독립 실험실`, 표시 버전 `EXCEL-ONLY STANDALONE · v1.0`, 준비 메시지 정상, console error/warning 0건

archive lifecycle 원칙에 따라 운영 URL은 직접 진입점이며 manifest·NEXUS 메뉴에는 등록하지 않았다.

## 잔여 위험·rollback·별도 개선 제안

### 잔여 위험

- 실제 주문은 저장소 fixture로 검증했다. 현장 주문 양식이 fixture와 다른 새 헤더를 도입하면 exact 계약에 따라 자동 추정하지 않고 업로드 오류로 차단된다.
- Excel 해석 라이브러리는 기존 저장소 관례와 같은 jsDelivr CDN을 사용한다. 네트워크가 차단된 환경에서는 파일 선택 전 안내 UI는 열리지만 Excel 읽기·쓰기는 불가하다.
- 300개 이상 상품을 한 테이블에 렌더한다. 현재 351상품 실데이터에서 동작했지만 더 큰 파일에서는 가상 스크롤이 필요할 수 있다.

### rollback

배포 변경의 rollback은 main에서 `git revert -m 1 85c746471bb65b4b402616056f040a96160c9ce8` PR을 만들어 `archive/OrderQ_Lab.html`, 신규 테스트·workflow 호출·보고서를 제거하는 것이다. Lab은 manifest와 운영 앱 데이터에 연결되지 않으므로 기존 ORDER Q/OrderOps/DataOps 데이터 rollback은 필요하지 않다. 이미 사용자가 내려받은 Excel/JSON은 브라우저 밖의 별도 파일이므로 자동 삭제하지 않는다.

### 별도 개선 제안(이번 범위 미적용)

1. CDN 자산을 저장소에 vendoring하고 무결성 hash를 고정해 완전 오프라인 모드 제공.
2. 1,000개 이상 상품을 위한 행 가상화와 이슈·창고 복합 필터.
3. 실제 운영에서 반복 확인된 헤더 alias를 관리자 승인 후 버전된 계약으로 추가하는 매핑 프로필.
4. 차단 오류와 경고만 모은 별도 검증 리포트 시트. 필수 네 출력물과 혼동되지 않도록 선택 출력으로 제안한다.

이번 구현에는 포함하지 않았다. 모두 기존 UI 최소변경과 archive 독립 경계를 넘어서는 별도 승인 대상이다.
