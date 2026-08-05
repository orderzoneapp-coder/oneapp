# DO-20260805-01 재고실사 마스터 상품 추가

## 작업 기준

- 개발 분류: 중요 개발
- 대상: `DataOps.html`, 로컬 product master, change history, stop-management linked state
- 기준 SHA: `53663a07609cdfd951cd1c5cf19e6bee7f1fa7a6`
- 작업 브랜치: `codex/dataops-do-20260805-01`
- 변경하지 않는 범위: 기존 재고 계산, 전체마감 분석 의미, ERP/Excel 열 계약, 클라우드 API와 snapshot schema

## 구현 결과

### F6 상품 추가

- 툴바 `상품추가(F6)` 버튼과 F6 키가 같은 `handleOpenInventoryMasterAdd` 경로를 사용한다.
- 현재 실사 입력 포커스 행 바로 아래에 검색 임시행 하나만 표시한다.
- 임시행이 이미 열려 있으면 새 행을 만들지 않고 검색 입력으로 포커스를 돌린다.
- 열기 동작은 현재 정렬, 필터, 검색값과 스크롤을 변경하지 않는다.
- 추가된 행은 `_manualDisplayAfterBatchKey`로 현재 위치에 고정되고 다음 F6도 그 행 아래에서 연속 수행할 수 있다.

### 로컬 Master 검색과 신규등록

- `ONEAPP.STORAGE.readMasterSnapshotState()`로 같은 브라우저의 확정 로컬 master와 revision을 읽는다.
- 검색에는 품목코드, 품목명(업무상 상품명), 규격, 검색어등록만 사용한다.
- NFKC, 대소문자, 공백과 일반 구분기호를 정규화하고 여러 검색어는 AND 포함으로 판정한다.
- 정확한 품목코드 또는 단일 결과는 즉시 선택하고, 복수 결과는 선택 모달, 0건은 신규등록 모달로 연결한다.
- 신규등록 필수값은 ERP 품목코드, 상품명, 규격, 단위다.
- `masterAddUpdate.js`의 `commitSingleProductRegistration`이 중복코드와 expected revision을 검사하고 `commitMasterStateOrThrow`의 검증/rollback 경계에서 master와 공식 history를 함께 저장한다.
- revision 충돌은 입력을 확정하지 않고 최신 revision을 다시 읽어 재확인을 요구한다.

### 목록 외 실사 행

- 장부재고(기초), 입고, 출고, 전산잔량을 0으로 시작한다.
- 상태와 이슈를 `목록 외 실사발견`으로 기록한다.
- 실사수량은 사용자가 입력하고 오차수량(`로스`)은 실사수량과 같다.
- 전체 `productData`에서 품목코드를 검사하므로 필터로 숨겨진 행도 중복 생성하지 않는다.
- 중복이 보이는 상태면 기존 행으로 이동하고, 숨겨진 경우 관리자에게 필터 초기화 후 이동 여부를 확인한다.
- F6으로 추가한 기존 master 상품과 신규등록 상품은 실사수량 0 입력 시 목록에서 제거되며, 빈값/0 행은 F9 전체 마감 데이터에서도 제외된다.

### 판매중단 상품과 복구 경계

- canonical 판매상태 필드는 `판매여부`이며 중단은 `0`, 재개는 `1`이다.
- 판매중단 상품도 동일한 검색/추가 경로를 사용한다.
- 양수 실사수량만 `_inventoryMasterResumeRequired` 대상으로 표시한다.
- F9는 다음 순서로 실행한다.

  1. 현재 입력을 flush하고 양수 마감 행을 고정한다.
  2. 기존 workbook을 생성·다운로드한다.
  3. 기존 FULL inventory snapshot을 클라우드에 확정한다.
  4. 확정 revision과 판매재개 코드를 `dataops_inventory_master_resume_v1`에 기록한다.
  5. `commitSalesStatusChanges`로 master `판매여부`, stopped-products, pending shop status, history와 동기화 알림을 원자 반영한다.

- 5단계가 실패해도 3단계의 재고 마감은 유지한다.
- 툴바 `판매재개 재시도`는 클라우드 마감이나 Excel 생성을 다시 실행하지 않고 5단계만 재시도한다.
- 이미 판매재개와 linked state가 반영된 코드는 `noop`으로 처리해 재시도가 멱등적이다.
- 성공한 재시도 레코드는 검증 후 삭제한다. 코드 rollback 시 미처리 레코드는 보존해 수동 판매상태 확인 근거로 사용한다.

## 공유계약 영향

- 기존 product master, history, stopped-products, pending shop status의 키와 schema는 변경하지 않는다.
- stop-management 일반 소유자는 SmartParser로 유지한다.
- DataOps는 확정된 양수 실사 후 `masterAddUpdate.js`를 통한 resume-only writer다.
- 신규 로컬 키 `dataops_inventory_master_resume_v1`의 소유자와 유일 소비자는 DataOps다.
- `APP_ARCHITECTURE.md`와 `app-manifest.json`에 소비자, writer 경계와 rollback을 기록했다.

## 검증 기준

- 전용 테스트: `scripts/test-dataops-inventory-master-add.mjs`
- 기존 master 회귀: `scripts/test-master-add-update.mjs`
- 기존 DataOps 회귀: `scripts/test-dataops-*.mjs`
- 교차 저장 회귀: client safety, SmartParser stop-management, MerchOps shared-storage/atomicity
- 저장소 검사: `scripts/validate-repository.mjs`
- 브라우저 대표 흐름: 로컬 앱 로드 후 F6 임시행, 검색/복수선택/신규등록 UI, 실제 수량 포커스와 F9 전후 상태를 안전한 테스트 master/profile에서 확인한다.

## 개발자 검증 결과 (2026-08-05)

- `node --check masterAddUpdate.js`: 통과
- `scripts/test-dataops-inventory-master-add.mjs`: 통과
  - 네 필드 검색, 정규화/AND/코드 우선, 1건·복수·0건 분기
  - F6 클릭/키보드 공용 경로, 임시행 단일성, 현재 위치 고정과 연속 추가
  - 숨김행 포함 중복 방지, 목록 외 수치/상태, 0 제외와 양수 반영
  - 신규등록 필수값/중복/revision/master 실패/history 실패/rollback
  - 판매중단 양수 대상, 마감 후 재개, 실패 재시도와 멱등성
- 기존 DataOps 테스트 15개 전체: 통과
  - 판매업로드 열/XLSX 재열기, 실사양식 마감일/XLSX 재열기, 관리자 통합 전체재고와 원본 Lot 보존 포함
- `scripts/test-master-add-update.mjs`: 35개 필수 시나리오 통과
- `scripts/test-master-add-update-xlsx-e2e.mjs`: 실제 XLSX fixture 승인/제외, 저장, 새로고침, master/history 재검증 통과
- 교차 저장 회귀: client safety, SmartParser stop-management, MerchOps shared-storage/atomicity 모두 통과
- `scripts/validate-repository.mjs`: 19 checks, 0 warnings
- `git diff --check`: 오류 없음(Windows 줄바꿈 안내만 발생)

## 브라우저 검증과 남은 위험

- 개발 worktree의 로컬 HTTP 서버가 격리된 인앱 브라우저에서 연결 거부되어 개발자 브라우저 직접 흐름은 검증 근거로 만들지 못했다.
- 자동 테스트는 UI 정적 계약과 핵심 저장/복구 흐름을 고정하지만 실제 포커스 이동, 모달 시각 배치와 동일 브라우저 IndexedDB 연동은 PM 대표 브라우저 흐름에서 별도 확인한다.
- 브라우저 직접 검증 전까지 위 세 항목을 정상으로 추정하지 않는다. 기능·저장 회귀와 XLSX 재열기 검증은 모두 통과했다.

commit/PR 정보와 PM 판정은 개발 종료 보고에 기록한다.
