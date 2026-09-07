# PR #544 후속 작업자 수락시험 결과

- 기준 SHA: `005a8d1dccdffb7e670dedb4358dbe7e9a70a378`
- 실행일: 2026-09-08 (Asia/Seoul)
- 실행 환경: 격리된 headless Chrome 프로필과 로컬 정적 HTTP 서버
- 운영 데이터 변경: 0건

## 핵심 작업자 흐름

1. 출고관리 일반 URL에서 자동 저장소 접근 없이 시작한 뒤 `목록 새로고침`을 눌러 ORDER Q 저장 주문 2건을 읽고 거래처 검색으로 1건을 필터링했다.
2. 선택 주문을 연결한 뒤 창고재고 Excel 없이는 분석 버튼이 비활성임을 확인했다.
3. 격리 fixture 창고재고 Excel을 입력하고 주문수량 10을 분석했다.
4. 작업표의 `실제출고`를 6으로 수정했을 때 확정표 `이번 실제 출고수량`이 6으로 유지됨을 확인했다.
5. 부분출고 사유를 입력해 확정한 뒤 기출고 6, 남은 주문수량 4, ORDER Q 주문조회 `부분출고`를 확인했다.
6. 별도 주문에서 실제출고 2와 사유를 입력한 뒤 ORDER Q Revision을 1→2, 주문수량을 5→6으로 변경했다.
7. 변경 감지 후 확정 차단, `현재 작업 유지`, `최신 주문 적용`, 수량 2와 사유 보존, 최신 Revision 2/최대 6 재검증을 확인했다.
8. 존재하지 않는 orderId 직접 진입에서 기존 작업을 만들지 않고 주문조회 복귀 링크와 재시도 안내를 확인했다.

## 실행 결과

- `scripts/test-orderops-pr544-operator-flow.mjs`: PASS
- `scripts/test-orderops-pr544-operator-flow-browser.mjs`: PASS
- `scripts/test-orderops-shipment-conflict-browser.mjs`: PASS
- `scripts/test-orderops-theme-browser-e2e.mjs`: PASS
- `scripts/test-orderq-query-browser-e2e.mjs`: PASS
- `scripts/test-orderq-processing-browser-e2e.mjs`: PASS
- ORDER Q·OrderOps 관련 비브라우저 스크립트 21개: PASS
- Repository validation: 24/24, warning 0
- Client safety/common UI/basic login/shipping management/cloud failure injection: PASS
- Phase 6B approved-base UI 브라우저 회귀: 기존 버튼 ID·단축키·작업 화면 배치 불변, 일반 진입 선행 ORDER Q DB 접근 0건 `PASS`

GitHub Actions에서도 같은 신규 수락시험과 선행 출고 파이프라인 시험을 실행하도록 repository workflow에 고정했다.

첫 GitHub Actions run `34152573800`은 새 버튼 ID가 기존 DOM 불변 계약에 포함된 문제와 출고 브라우저 시험이 Linux Chrome 경로를 찾지 못한 문제를 확인해 실패했다. 동작 식별자를 `data-*`로 분리하고 저장 주문 목록을 명시적 새로고침으로 전환했으며, 작업 시작 후 선택기를 접어 기존 배치를 유지하고 Linux 브라우저 검색 경로를 추가했다. 동일 수락·충돌·승인 UI 시험의 로컬 재실행은 모두 통과했으며 후속 exact SHA의 CI 결과는 PR에 남긴다.
