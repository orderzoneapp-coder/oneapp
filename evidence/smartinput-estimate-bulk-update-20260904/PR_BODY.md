## 목적

적용된 견적서 현황 입력 매핑에 둘 이상의 거래처 그룹이 있을 때 기존 `저장`에서 전체 기존 개별 견적서를 거래처별로 한 번에 업데이트합니다.

## 변경

- 순수 그룹/분류, exact ID→code→normalized name 매칭, 수동 대상/중복/연동 대상 검증
- 기존 버튼에서만 열리는 반응형 `전체 견적서 업데이트` 확인창
- header+해당 거래처 행만 갖는 `inputMapping`/source evidence 안전 분할
- 기존 `commitEstimateBundle` 한 transaction과 expected preimage 사용
- 대상/참조 연동견적의 dirty working copy fail-closed
- 성공 후 목록 갱신과 전체 업로드 검토 화면 유지

## 불변 경계

- 신규 견적 자동 생성 없음, 업로드에 없는 견적 삭제 없음
- ID/name/sort/created/customer header/연결 메타데이터 보존
- 그룹 간 동일 품목코드, 빈 셀, 0, 음수, 셀 주소·signature 보존
- DB schema/store/key/index/migration/reset, ORDER Q/공식전표, 기준정보 소유권, 공통 Runtime/Cloud gate 변경 없음

## 검증

- 전체 SmartInput 비브라우저 회귀 PASS
- 신규 bulk 및 기존 full/input-template/F3/linked-source/settings Chromium E2E PASS
- 1920/1440/390 light/dark, focus/scroll/Escape 0-write, 수동 변경/미해결 차단 PASS
- stale preimage와 IndexedDB 두 번째 put 실패 전체 rollback, localStorage fallback 실패 불변 PASS
- repository validator 24/24·warning 0, client safety, syntax, diff check PASS

## Rollback

- 실행 중 실패는 기존 원자 transaction/fallback 단일 write로 전체 rollback합니다.
- 성공 후 영구 undo Store는 추가하지 않았습니다. 코드 rollback은 이 PR merge revert이며 이미 교체된 사용자 데이터는 별도 원본/백업 복구가 필요합니다.

PM 독립검증 전 병합·배포하지 않습니다.
