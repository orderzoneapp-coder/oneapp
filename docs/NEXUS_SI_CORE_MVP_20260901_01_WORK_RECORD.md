# NEXUS-SI-CORE-MVP-20260901-01 작업 기록

- 분류: 중요 개발
- 사용자 승인: 확정 개발명세 전체 구현·테스트·Git·병합·배포 선승인
- 원격 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main`: `59f510667c882258ad0bb53d3641be6b15814f2f`
- 브랜치: `codex/nexus-smartinput-core-mvp-v2`
- worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-core-mvp-v2`
- 시작 상태: clean
- 적용 규범: `AGENTS.md` v2.3.4
- 적용 아키텍처: `APP_ARCHITECTURE.md` v2.1.17
- 적용 Manifest: `app-manifest.json` v1.3.6
- 확정 명세: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\SmartInput_Core_MVP_개발명세서_v2.0.md`

## 목적

SmartInput의 전표별 필드·선택 노출·기준정보 사본·Excel 매핑·다중전표·관련 전표·공식 저장·재고/원장 연결 Core MVP를 구현한다.

## 현재 상태와 목표 상태

- 현재 SmartInput은 주문·견적·구매·판매 작업본과 V1 Excel 매핑을 제공한다.
- 현재 수량·단가는 전표 공통 필드이고 매핑양식은 회사·전표 파티션이 없다.
- 현재 기준정보 캐시는 상품·거래처 중심이며 전체 수동 세대교체 계약이 없다.
- 현재 구매·판매 Stage가 import하는 공식 전표 Core/Repository와 연관 모듈은 기준 소스에 없다.
- 목표는 확정 개발명세의 `SI-MVP-00`부터 `SI-MVP-07`까지를 순서대로 구현하고 단계별 회귀 증거를 남기는 것이다.

## 적용 경계

- SmartInput의 수기입력·로컬 작업본 편집은 외부 앱과 서버 장애 중에도 유지한다.
- 기준정보는 owner Read Adapter에서 읽고 SmartInput에서 원본을 직접 수정하지 않는다.
- 원본 Excel 표시값·공란·0·코드 앞자리 0을 자동 보정하지 않는다.
- 관련 전표는 읽기 전용 원본을 대상 작업본으로 복사하며 원본을 수정하지 않는다.
- 전표·금융·재고 효과는 원장 owner의 멱등 저장 경계로만 반영한다.
- 현재 활성 작업본은 새 기준정보 Revision으로 자동 덮어쓰지 않는다.

## 확인된 충돌과 처리

- 역사상의 공식 전표 구현은 전체 ORDER Q v7~v14 계약에 의존하고, 이 구조는 이후 안정 기준선 rollback에서 제거됐다.
- 현재 기준 소스에 남은 SmartInput 구매·판매 Stage import는 이 rollback 상태와 불일치한다.
- 전체 과거 ORDER Q 구조를 다시 도입하지 않고, 검증된 공식 전표 알고리즘을 현재 v6 저장구조와 확정 MVP 계약에 맞게 최소 복구한다.
- 각 단계는 additive schema, 호환 읽기와 독립 rollback을 유지한다.

## 완료 증거

단계별 변경 파일, 실행 테스트, 실패/복구 결과, commit·PR·CI·배포 상태를 이 문서 끝에 누적한다.

## 구현 결과

### SI-MVP-00 · 공식 저장 경계

- `orderq/official-voucher-core.js`, `orderq/official-voucher-repository.js`, canonical hash를 현재 롤백 기준 DB에 맞춰 복구했다.
- 구매·판매의 저장, 정정 delta, 취소 반대효과, revision 낙관적 잠금과 command 멱등성을 구현했다.
- 원본 공급가액·부가세·합계가 있으면 그대로 사용하고 공란만 수량×단가로 파생한다.
- 공식 구매·판매는 로컬 Pilot 권위다. 현재 Apps Script 동기화 계약이 신규 entity를 지원하지 않으므로 후속전송 행은 `WAITING_SERVER_CONTRACT`로 격리하고 기존 동기화에 제출하지 않는다.

### SI-MVP-01 · 필드 등록부와 최소 노출

- `oneapp-smartinput` DB를 v5로 additive 승격하고 기존 Store와 호환 키를 유지했다.
- ERP 전수 재분류 Excel에서 2,178개 고유 필드 발생을 Seed로 생성했다. 원본 발생 수 2,178개, 검토필요 63개, source SHA-256은 `933b28c2e2c73bb7ac64befd51aeaf8171c813ce10d8147919ecca869a5ee64c`다.
- 견적·주문·구매·판매의 수량과 거래단가를 각각 별도 canonical fieldId로 구성했다.
- DB는 전체 필드를 보유하되 설정과 입력·매핑 화면은 회사·전표에서 사용 설정한 필드만 노출한다. 고급 추가 화면에서만 전체 등록 필드를 검색한다.
- 사용자지정 문자형·숫자형을 전표별 각 10개로 제공하고 원장 효과가 없는 보조 입력으로 유지했다.

### SI-MVP-02 · 기준정보 전체 수동 새로고침

- 상품·거래처·창고·담당자·프로젝트·필드 정의의 6개 Domain을 하나의 불변 generation으로 staging한다.
- 전부 검증된 경우에만 활성 포인터를 한 번 교체한다. 프로젝트 owner가 없는 현재 상태는 명시적인 `EMPTY`로 기록한다.
- 새로고침은 관리자 버튼 한 번으로만 실행한다. 검색어와 입력값을 유지하고 완료 후 같은 검색어를 다시 실행한다.
- 부분 실패는 기존 활성 generation과 현재 작업본을 유지한다.

### SI-MVP-03 · Excel V2와 다중 전표

- 표시값, 원시값, 수식, 숫자 형식, 셀 주소를 원본 증거로 보존한다.
- 입력 양식 서명은 `companyId + voucherMode + 헤더 문자열/개수/순서`다. 하나라도 다르면 신규 양식이며 모든 열의 매핑/비매핑 재검수를 요구한다.
- V1 양식은 삭제하지 않지만 V2로 무단 자동전환하지 않는다.
- 수기 입력과 Excel 매핑 후보가 같은 사용 필드 등록부를 사용한다.
- 거래처·일자·창고·외부전표번호·원본문서 식별자로 여러 전표를 분리하고, 여러 그룹이면 저장 전에 관리자 확인을 요구한다.
- 10,000행 매핑 성능은 테스트 환경에서 약 0.94초였다.

### SI-MVP-04 · 관련 전표 불러오기와 행 편집

- 견적·주문·구매·판매의 4×4 방향 변환 Core를 구현했다. 원본 수량·단가 의미는 대상 전표의 canonical fieldId로 복사한다.
- 주문·구매·판매는 ORDER Q 읽기 Adapter, 견적은 SmartInput 견적 읽기 Adapter를 사용한다.
- 원본 voucher/line ID와 표시값 Snapshot을 보존하고 원본 Store는 수정하지 않는다.
- 거래처·창고가 현재 입력과 다르면 확인창 전에는 결합하지 않는다.
- 기존 선택삭제·행 추가·개별수정에 선택행 단가 일괄적용을 추가했다. 일괄 변경 전후값과 작업자·시각을 행 이력에 남긴다.

### SI-MVP-05 · 공식 Revision·채권·채무

- 구매는 채무와 재고 증가, 판매는 채권과 재고 감소를 전표와 같은 IndexedDB transaction에 기록한다.
- 정정은 전체 재기록이 아니라 이전 revision과의 차이를 기록하고, 취소는 물리 삭제 없이 반대효과를 남긴다.
- 같은 command 재실행은 기존 결과를 반환하며 중복 원장효과를 만들지 않는다.
- 회사 ID를 모든 신규 공식 레코드의 필수 파티션으로 적용했다.

### SI-MVP-06 · 미매칭 상품과 실사 경계

- 회사·상품코드 또는 품명·규격·단위로 안정적인 미매칭 시스템 ID를 생성한다. 동일 표현의 구매·판매는 같은 ID를 사용한다.
- 미매칭 상품도 공식 구매·판매와 채권·채무에 반영하지만 재고효과는 대기한다.
- 상품 연결 시 같은 회사·창고의 최신 확정 실사를 확인한다. 전표일이 실사일 이전 또는 같은 날짜이면 연결만 기록하고 재고를 소급 변경하지 않는다.
- 실사 이후 전표는 연결 시 재고효과를 기록하며 창고별 checkpoint를 독립 적용한다.
- 이미 연결된 미매칭 ID가 다음 전표에 들어오면 실제 상품 ID로 해석해 즉시 정상 재고효과를 만든다.

### SI-MVP-07 · 통합 Pilot

- 데스크톱 1,920px, 중간폭 1,280px, 모바일 390px, 일반/다크 화면을 브라우저에서 검증했다.
- 실제 IndexedDB에서 주문 저장, 미매칭 구매 저장, 채무 기록, 중복 명령, 실사 checkpoint, 사후매칭, 이후 전표 정상 재고반영을 검증했다.
- 실제 거래처별 ERP Excel 양식의 업무 적합성 판정은 배포 후 사용자가 양식별로 순차 Pilot한다. 구조가 다른 파일은 자동으로 신규 양식 전체검수로 분리된다.

## 스키마와 호환성

- SmartInput: DB v4 → v5. 신규 Store만 추가하며 기존 Store·localStorage·V1 양식을 삭제하거나 변환하지 않는다.
- ORDER Q 롤백 기준 DB: v6 → v7. 공식 command/revision/inventory/AR/AP/checkpoint Store와 기존 Store의 보조 index만 추가한다.
- 배포 후 브라우저 DB version은 낮출 수 없다. 기능 rollback 시에도 `smartinput-data-store.js` v5와 `orderq-db.js` v7의 빈 호환 스키마 및 캐시 버전은 유지하고, 화면·controller·공식 명령 연결만 이전 동작으로 되돌린다. 신규 Store 데이터는 삭제하지 않는다.

## 검증 결과

통과한 직접·회귀 테스트:

- `test-smartinput-field-settings-v2.mjs`
- `test-smartinput-reference-generation-v1.mjs`
- `test-smartinput-input-template-mapping.mjs`
- `test-smartinput-xlsx-source-reader.mjs`
- `test-smartinput-multivoucher-stage1.mjs`
- `test-smartinput-related-voucher-import-v1.mjs`
- `test-smartinput-grid-bulk-edit.mjs`
- `test-orderq-official-voucher-mvp-core.mjs`
- `test-orderq-inventory-rematch-boundary.mjs`
- `test-smartinput-structured-sheet-parser.mjs`
- `test-smartinput-grid-clipboard.mjs`
- `test-reference-data-contract.mjs`
- `test-smartinput-reference-data-ux.mjs`
- `test-smartinput-independent-recovery.mjs`
- `test-smartinput-appheader-workspace.mjs`
- `test-smartinput-browser-e2e.mjs`
- `test-smartinput-input-template-browser-e2e.mjs`
- `test-orderq-order-workflow.mjs`
- `test-orderq-smartparser.mjs`
- `test-orderq-manual-master-search.mjs`
- `test-orderq-history-collector.mjs`
- `test-orderq-fulfillment-lifecycle.mjs`
- `test-orderq-cloud-atomicity.mjs`
- `test-orderq-vnext-cloud-contract.mjs`
- `test-client-safety.mjs`

정적 검증:

- 변경 JavaScript/ESM Node syntax 검사 통과
- `app-manifest.json` JSON parse 통과
- `git diff --check` 통과

## 명시적 후속 범위

- 기존 Apps Script에 공식 command/revision/재고/채권·채무 entity를 추가하는 서버 다중기기 동기화는 Core MVP에 포함하지 않았다. 로컬 Pilot 기록을 기존 서버가 잘못 처리하지 않도록 격리했다.
- 프로젝트 기준정보 owner 앱 구축, 잔량·부분이행, FIFO 원가, 이익표시, 자동 VAT·환율·단위 변환, 전자결재·세금계산서·회계전표 전송은 포함하지 않았다.
- 실제 ERP Excel 양식별 예외는 구조를 하드코딩하지 않고 Pilot 결과에 따라 별도 고도화한다.

## Git·배포 추적

- 최초 구현 commit: `d34ad588ecef1288386804c2f853eda085dbced7`
- PR: `#469` (`codex/nexus-smartinput-core-mvp-v2` → `main`)
- CI: PR의 `ONEAPP repository validation` 성공을 병합 게이트로 사용한다.
- merge: PR `#469`의 검증 성공 후 squash merge한다.
- GitHub Pages: `main` 반영 후 운영 URL에서 `smartinput.js?v=0.9.0`과 FieldDefinition V2 자산을 직접 확인한다.
