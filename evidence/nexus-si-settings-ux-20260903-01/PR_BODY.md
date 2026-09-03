## 목적

SmartInput 환경설정의 전표별 표시 열을 선택 항목 중심으로 단순화합니다. 설정 화면의 고정 업무 순서는 작업테이블 열 배치와 분리하고, 저장 전 working copy를 사용해 활성 작업표를 보호합니다.

## 변경

- 넓은 데스크톱/모바일 전체화면형 설정 모달과 고정 제목·전표 탭·푸터
- 선택 항목만 `품목정보 → 수량·단가·금액 → 메모·기타`로 우선 표시
- 같은 모달 안의 전체 항목 검색·분류·개수·선택됨·사용자지정 항목 추가
- 새 항목 `노출 + Enter 0`, 빈칸·음수 저장 차단
- 마지막 편집 항목의 중복 순번 삽입과 양수 순번 연속 자동 정리
- 저장 전 작업표 불변, 취소 완전 복구, 4개 전표 설정 독립 저장
- SmartInput 앱 자산 cache-bust와 승인 UI hash baseline 갱신

## 보존 경계

- `voucherColumnsByMode` 배열 순서를 표시용 업무 정렬로 덮어쓰지 않음
- SmartInput IndexedDB v5, 설정 key/schema, Draft/공식전표 V2/기준정보/Excel 계약 변경 없음
- 공통 자산 토큰 `nexus-ui.css` 1.3.5, `nexus-ui-app-themes.css` 1.3.9, `nexus-ui.js` 1.4.2 유지
- DataOps 화면모드 및 다른 앱 변경 없음

## 검증

- `node scripts/test-smartinput-settings-ux.mjs`
- `node scripts/test-smartinput-settings-ux-browser.mjs`
- `node scripts/test-smartinput-independent-recovery.mjs`
- `node scripts/test-smartinput-field-settings-v2.mjs`
- `node scripts/test-smartinput-input-template-browser-e2e.mjs`
- `node scripts/test-smartinput-browser-e2e.mjs`
- 관련 SmartInput 공식전표 V2 회귀
- `node scripts/test-smartinput-v2-unresolved-review-ui.mjs`
- `node scripts/test-smartinput-v2-unresolved-review-ui-browser.mjs`
- `node scripts/validate-repository.mjs`
- `node scripts/test-client-safety.mjs`
- `node scripts/test-nexus-common-ui-recovery.mjs`

모두 PASS. 브라우저 증적은 `evidence/nexus-si-settings-ux-20260903-01/`에 포함했습니다.

## Rollback

이 PR을 revert합니다. 저장 schema와 migration을 추가하지 않았으므로 사용자 데이터 삭제·변환은 필요하지 않습니다.
