# 본체·선택 연동·출력 통합 기록

기준 SHA: `21eaf44d50883c68f6c40a6eca9d368df1eff09f`. 최종 승인 명세: `docs/SI-BOUNDARY-20260920-01.md`.

| 기존 구현·경로 | 현재 책임과 동작 | 검증·유지 근거 |
|---|---|---|
| 본체의 행 공란·의미값·연결원본 판별·빈행 정리 함수 6개와 상수 | `input.js`에 본문 이동, 본체는 결과 소비 | 공란/0/음수/custom field/연결원본 fixture, 기존 입력 회귀 |
| render → voucher activity 자동조회, 정적 owner reader import | 표시 함수는 현재 상태만 표시. 목록 열기·다시 불러오기·조회조건 변경 시에만 기존 reader 지연 로드 | 실제 브라우저 독립 경로 원장 접근 0, 명시 조회 양성 대조 |
| 초기 hydrate의 공식 동기화 | 초기 실행 제거. 기존 명시 전달 완료 뒤 동기화·활성화 조건 보존 | 원장·syncQueue 접근 및 외부 요청 계측, 기존 공식쓰기 검사 |
| 쇼핑몰 입력·편집·복구 후 자동 중복 검사 | 입력 때는 기존 순수 요청 계약으로 후보만 준비. 확인·전달에서 owner inspect/commit 실행 | 3회 업로드 준비 원장 읽기 0, 기존 동일내용 중복/신규/실패 재시도 회귀 |
| 복구된 쇼핑몰 READY/ANALYZING 판정 | 부팅·checkpoint·명시 복구에서 조회 상태만 LOADED로 무효화. 원본·선택·저장 영수증 보존 | 상태별 복구 unit fixture. 이전 판정으로 버튼이 영구 잠기지 않음 |
| 명시 전달의 사전 검사 중 host 이동 승인 | 검사 시작부터 전달 결과 확인까지 같은 busy·try/finally 경계 적용 | 실제 함수 지연 검사 fixture에서 beforeLeave의 idle 대기 미해제, 빈 결과·오류 후 guard 해제 및 commit 0 검증 |
| 초기 `loadWarehouseCatalog` | 로컬 SmartInput 활성 6영역 세대만 읽고 회사·세대·수량·창고 hash 검증 | 기존 owner 함수는 주문 migration 부작용이 있어 명시 전체 갱신에서만 사용 |
| warehouse 세대에 별칭 누락 | 명시 갱신 때 동일 warehouse 도메인 행에 별칭을 함께 보존하고 동일 hash 검증 | DB/도메인/원장 구조 변경 없음. 구세대에 별칭이 없으면 안내하며 임의 생성하지 않음 |
| Settings 읽기 실패 시 기본 마진·빈 매핑 사용 | 해당 보고서 생성을 중단하고 오류 표시, 입력·견적 보존 | ERROR 및 잘못된 값 구조 fixture. 정상 0 값 보존 |
| `file-intake-feature`, `ocr-feature`, `estimate-bulk-feature` | 실제 구현 파일을 직접 선택 로딩; 대표 wrapper 삭제 | 초기 XLSX/OCR/대량처리 로딩 없음 |
| `estimate-report-feature`, `voucher-output-feature` | 실제 출력 파일로 직접 로드. 기존 자료 전환은 별도 지연 로딩, Worker 제어는 실제 출력 모듈에서 제공 | 출력 행렬·Worker/direct/fallback 동일성, 기존 F8 계약 |
| 사용 소비자가 없는 reference-bootstrap/readiness | 전체 경로 검색 후 구 소스 삭제 | 현재 실행 경로·테스트·manifest 소비자 없음 |
| 붙여넣기 확정·취소·자동저장 복구 후 기존 편집 DOM 잔류 | 명시 배치 확정·복원에 virtual-table-body.invalidate 적용 | 붙여넣기 모델/DOM 8→취소 모델/DOM 0, 일반 편집·IME·숨김 창 보호 23회귀 및 실제 브라우저 |
| 행의 각 표시값마다 전체 매핑 정의 생성 | 일반행은 정의 계산을 생략하고 매핑행은 해당 renderRows의 지연 조회표를 재사용 | 기존 최초 projection 우선순위·공란·0·편집값·다음 렌더의 새 정의를 회귀 검증. 설정 전체를 장기 캐시하지 않음 |
| 기본행을 입력행으로 바꾼 뒤 작은 표의 viewport 목록 미갱신 | 행 수와 관계없이 새 행 ID를 microtask에서 renderRows로 반영하고, 후보 창을 열기 전 최신 행 모델 반영 | 실제 포커스·정확한 행 ID로 상품 후보 취소 시 행 소실과 여러 번 입력 시 첫 글자로 되돌아오는 현상을 재현한 뒤 수정 |
| 변경 없는 열 순서도 모든 셀을 다시 이동 | 실제 순서가 다른 셀만 이동 | 기존 정렬 결과 보존 단위검증. 같은 셀 이동으로 첫 글자 뒤 포커스가 사라진 실제 브라우저 현상을 수정 |
| Enter 상품 검색 뒤 활성 행 DOM에 이전 검색어·상태 잔류 | 코드·품명 Enter의 일치·후보·미등록 결과에 viewport 무효화 후 기존 다음 셀 포커스 적용 | 모델과 화면 불일치를 실제 포커스 입력으로 재현한 뒤 수정. 일반 타이핑과 change 이벤트는 기존 활성 입력 보호 유지 |
| 전체 화면 갱신에서 행 표시와 본체가 같은 레이아웃·분석을 반복 | 본체 갱신에서는 마지막 단계에 한 번만 수행. 행 단독 갱신은 기존 처리 유지 | 최종 경계 브라우저·20회 Warm 성능 측정, 초기 초안 bootstrap 회귀 |
| 본체 module 의존 준비가 HTML 뒤에서 시작 | 기존 필수 main만 modulepreload하고 실제 실행 script 위치·순서 유지 | 선택 XLSX/OCR/공식 명령 사전 로딩 없음. 최종 48개 초기 JS·독립 경로 원장 I/O 0 확인 |

## 유지한 분리 파일

- `smartinput-contract.js`: 기존 전역 소비 계약과 초기 HTML 실행 순서 유지. 문서 형식·수량·금액·공식 ID 규칙을 바꾸지 않았다.
- `estimate-workbook-selector.js`: 작은 순수 판별은 초기 화면에서도 사용하므로 XLSX reader에 본문을 복제하지 않고 기존 파일을 유지한다.
- `stage5-compute-runner.js`, `stage5-compute-worker.js`: Window/Worker 실행 환경·취소·대용량 계산 경계가 다르므로 유지한다.
- `official-voucher-feature.js`: 공식 전달 때만 두 서비스와 충돌 대화상자를 준비하는 기존 호환 경계다. 공식 거래 규칙은 소유 앱 명령을 사용한다.
- `virtual-table-body.js`, 입력 검색·표 상태: 화면·스크롤·IME 수명과 입력 처리 수명이 달라 유지한다.
- `shopping-order-dedupe-core.js` 소비: 기존 owner 순수 요청 계약의 후보 ID·signature 동일성을 유지하기 위한 기존 읽기 의존이다. owner 명령·repository는 명시 동작으로 지연했다. 동일 거래 판정 엔진을 새로 복제하지 않았다.
- NEXUS 공통 UI의 ready/beforeLeave/print/theme 연결은 본체에 그대로 유지했다.

## 완료를 막는 확인 사항

기존 상품사전·거래이력은 소유 앱 원시 저장소에서 입력행마다 읽혔다. 이를 제거한 현재 입력 context는 검증된 상품 Snapshot을 공급하지만, 승인 사전을 전달하는 owner Snapshot 계약은 없다. 기존 최종 재판정은 ID를 지웠어도 사전에서 채운 코드·품명·규격을 남겼으므로 현재 결과와 차이가 나는 실제 함수 fixture가 확인됐다(`review-final-row-regression.json`). 이 차이는 성능 개선으로 정당화하거나 동일 출력으로 판정하지 않는다. 사용자에게 사전 결과 보존을 위한 읽기 계약 연결과 현재 상품 Snapshot만 사용하는 기준 중 선택을 요청했다. 엔진·원장·DB 소유권 변경은 하지 않았다.

성능 결과는 별도 before/after 자료로 판정한다. 전용 계측 서버는 before/after 모두 `Cache-Control: public, max-age=3600`을 사용한다. 동일 브라우저의 Warm 직접진입과 실제 NEXUS 앱 전환을 서로 대체하지 않는다. 별도의 기능 E2E 서버는 no-store를 사용하며 그 실행시간을 Warm 성능 수치로 사용하지 않는다.

초기 함수별 3회 진단에서 renderMode 969~1273ms 중 renderRows가 914~1204ms였고, 168회 중복된 매핑 정의 경로가 836~1119ms였다. 포함 시간은 중첩되므로 합산하지 않는다. 진단 wrapper 오버헤드를 포함한 병목 귀속 자료이며 수용 성능값이 아니다. 위 표시값 변경 뒤 일반 20회 계측으로 효과를 별도 확인한다.
