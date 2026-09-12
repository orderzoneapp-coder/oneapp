# 출고관리 파일 준비·끝행·헤더 UX 후속 개발 보고

- 기준: 원격 main `1a6f943f437e5f29c803cd70e08e55e1b6f82cc3` (PR #589)
- 브랜치: `codex/orderops-file-drop-visual-fix-20260912`
- 범위: PM-F09 드롭, PM-F10 디자인 및 사용자 추가 헤더/두 행 통합, PM-F11 마지막 상품행
- 상태: 구현·자체 검사 완료, PR 필수 CI 및 독립 PM 최종 판정 대기. 병합/배포 승인 아님.
- 공통헤더·SmartInput 제품·저장 owner·F10 계산/양식·출고결과는 변경하지 않음. PM-F03 성능 개선은 보류 유지.

## 변경

1. 파일 준비 패널과 재열기 버튼의 Excel drop을 버튼 선택과 같은 `prepare()`에 연결했다. 파일 drag만 브라우저 기본 이동을 막고 일반 텍스트 drag는 유지한다. 여러 파일은 기존 미적용 후보에 추가하며, 잘못된 형식/25MiB 초과는 파일별 안내한다. 드롭은 적용/분석을 자동 실행하지 않는다. 읽는 중 적용/지우기/초기화와 이탈을 보호한다.
2. SmartInput의 단일 입력면/상단 파일 도구/하단 주동작 구성을 출고관리 안에서만 적용했다. 얇은 테마 경계·정돈된 입력·52px 활성 적용 버튼을 사용한다. 중앙 표의 중복 입력 테두리를 없애되 `data-negative-balance=true` 배경은 초기화하지 않는다. 인쇄 화면에는 준비/상태 UI를 포함하지 않는다.
3. 출고관리 자체 헤더 6개 화면 탭을 중앙, 분석·초기화·환경설정을 우측 끝에 정렬했다. 좁은 폭에서는 단일 행 내부 가로 접근으로 겹침을 방지한다. 파일 재열기와 상태는 기존 검색 조작부로, 파일 준비 닫기는 파일 도구 줄로 합쳤다. 전체 상태는 body popover에서 확인한다. `validationBox.bad` 변경은 접힌 상태에서도 고정 버튼의 `! 확인 필요`로 표시하며 클릭/키보드/Escape 초점 복귀/live 안내를 유지한다.
4. 초기 글로벌헤더 삽입 이후 작업영역 높이를 재계산한다. 공통헤더 파일은 수정하지 않았다. 동일 1366×900 합성 화면에서 작업영역 상단 156→128px, 중앙 표 시작 290→221px. 기존 하단 64px 잘림도 해소했다.
5. `데이터 시작행` 입력을 `마지막 상품행(포함)`으로 교체했다. 새 파일은 헤더 다음 행에서 시작한다. `explicitMapping.dataEndRowIndex`는 0-based 포함 끝행이며 4개 자료 유형의 파싱/적용/저장/복구가 같은 범위를 사용한다. 전체 원본 행렬/cells/hash/sourceEvidence 및 원래 Excel 행 번호는 보존한다. 기존 custom 시작행/끝행 없는 매핑은 종전 범위를 유지한다. 범위 밖/소수/공란 값은 오류로 차단하며 자동 보정하지 않는다.

## 자체 검사

| 검사 | 결과/경계 |
|---|---|
| 저장소 검증 | 24 checks, 0 warnings 통과 |
| workbench-contract / purchase-selection | U06, U19, U22 계약 및 끝행/원문/복구 payload 통과 |
| preparation 전용 실제 XLSX 합성 브라우저 | 주문/재고/구매/판매 4종, 끝행 지정/오류/원문/원행/복구 UI, 시트 전환, 변경 후 재적용, 오류 배치 전체 미적용, F08 저장 대기 중 끝행 변경 통과 |
| 신규 drop/visual 브라우저 | DataTransfer/DragEvent 경로, 다중 파일/크기/형식 오류/기존 준비 보존/텍스트 drag, 1366·1024·819·390 일반/다크, 버튼 52px, 헤더 정렬/겹침/공간, 상태 팝업/Escape/오류 배지, print 영역 제외 통과 |
| 상태색 | 기존 CSS 대비 일반/다크 각각 정상·focus의 음수 잔량 배경/글자 동일. Light 공통 테마의 실제 기존 배경은 ivory였으며 노란색이었다고 보고하지 않음 |
| theme browser | 담당 색상·상태색·인쇄 회귀 통과 |
| Excel cell-grid browser | 셀 편집/Enter/방향키/행 경계/대체 대상 셀 통과 |
| PR544 operator browser | 기존 주문 목록·창고열 재검증·담당 건수·패널·하단 작업·인쇄 입력 보존·부분출고·충돌 복구 통과 |
| shipping-management / operations-improvements | 계산·저장/복구·날짜·설정·직원 적요 통과 |
| 전체 workbench 로컬 회귀 | U06 실제 F10 다운로드(6개 시트/구매 6개)/U19/U22 저장·Cloud 합성 roundtrip·1차 강제종료 복구 통과. 2차 Chrome 재실행은 Windows ProcessSingleton 프로필 잠금(exit 21)으로 실패. **전체 성공 아님**. 제품 Runtime exception 없음. 같은 전체 로컬 검사를 반복하지 않고 필수 CI에서 확인 |

기존 브라우저 테스트의 영어 표시 문자열 READY/APPLIED/INVALID 검사는 번역된 UI의 `data-prepare-state`로 변경했다. 준비·적용 성공 및 오류 검사 자체는 유지했다. SmartInput 이름의 소비자 테스트 수정도 OrderOps 준비 상태 검사에만 한정한다. 새 사용자 헤더 지시에 맞춰 우측 분석/초기화/환경설정 순서를 검사한다.

## 증거와 미검증

로컬 증거 루트: `artifacts/orderops-file-drop-visual` (작업 저장소 외부)

- `before`, `baseline-geometry`: 배포 기준 소스 재현 및 같은 테마/폭의 이전 화면
- `focused-states`: PM이 확인한 활성 버튼/상태색 증거
- `preparation-with-end-final/browser-result.json`: F11 네 유형/범위/복원/매핑 경합
- `final-browser`: 전체 폭/테마 및 헤더 geometry
- `status-final`: 최종 제품 해시, 활성 버튼, 상태 오류 표시, 팝업/키보드, 대표 헤더 화면
- `full-regression/browser-result.json`: 성공 구간과 Windows 재실행 실패를 포함한 전체 원기록
- CI는 동일 테스트와 합성 화면을 `orderops-workbench-v12` artifact로 게시한다.

**OS 실제 파일 드래그는 미검증이다.** Windows Computer Use가 브라우저 URL 안전 확인 실패로 중단했으며 우회/반복하지 않았다. DataTransfer/DragEvent 성공을 OS 드롭 성공으로 대체하지 않는다. PM은 코드/경로를 판단하고 실사용 드롭 확인을 사용자 검수에 남긴다.

격리 headful 창에서 직접 실행하지 않은 파일 적용이 관측되었다. 입력 주체/방법은 확인되지 않아 증거로 사용하지 않았다. 사용자 작업 가능성이 있어 그 창·프로필·자료는 보존하며 이후 테스트/종료 대상에서 제외했다. 다른 검사는 별도 합성 프로필에서 수행했다.

이번 후속 변경의 운영 배포/운영 검증은 아직 수행하지 않았다. PM 최종 개발 결과 검증과 필수 CI 통과 뒤 승인된 head만 병합/배포한다. 이전 PR #589 배포 승인을 이번 수정 승인으로 재사용하지 않는다.

## 복구 경계

기존 원본·로컬 복구본·Cloud revision·append-only 출고결과를 삭제하거나 재작성하지 않는다. 실패 시 현재 작업/미적용 준비를 유지한다. 소스 롤백은 후속 PR revert이며 데이터 삭제를 동반하지 않는다. 이전 파서 버전은 새 끝행 필드를 소비하지 않으므로 끝행을 지정한 새 작업을 이전 소스로 재파싱하지 않도록 배포/복구 시 버전을 대조한다. 새 UI/파서 URL은 함께 cache-bust했다.
