# NEXUS 앱 공통 UI 계약

`NEXUS_APP_UI_V1`은 공통헤더 아래 앱의 작업헤더, 대상 탭, 작업 도구와 표 밀도를 연결한다. 공통헤더가 루트에 설정한 `data-nexus-density`와 CSS 변수만 사용하므로 밀도 변경 시 앱 초기화, 데이터 재조회, 자동저장 또는 입력 초기화를 실행하지 않는다.

## 공통 변수

| 변수 | 표준 | 압축 |
|---|---:|---:|
| `--nexus-app-header-height` | 56px | 42px |
| `--nexus-target-tab-height` | 42px | 36px |
| `--nexus-work-tools-height` | 50px | 42px |
| `--nexus-table-header-height` | 40px | 34px |
| `--nexus-table-row-height` | 48px | 36px |
| `--nexus-content-gutter` | 24px | 12px |

지원 앱은 `nexus-app-ui.css`를 불러오고 `nexus-app-work-header`, `nexus-target-tabs`, `nexus-work-tools`, `nexus-data-table` 적용 지점을 선언한다. 적용 상태와 보존 식별자는 `nexus-ui-contract.js`가 단일 코드 등록부로 제공한다.

## 상태 보존

선언적 CSS 전환은 `activeTab`, `searchState`, `filterState`, `sortState`, `selectedRowId`, `activeCellId`, `scrollPosition`, `draftChanges`, `openedPanelId`를 읽거나 쓰지 않는다. Master의 내장 거래처 화면에는 밀도 값만 `ONEAPP_NEXUS_DENSITY` 메시지로 전달하며 기존 iframe을 다시 만들거나 다시 불러오지 않는다.

## 적용 상태와 예외

| 앱 ID | 상태 | 적용 범위 | 예외·대체 UI | 회귀 검증 | 재검토 조건 |
|---|---|---|---|---|---|
| `master-lookup` | 파일럿 적용 | 작업헤더, 대상 탭, 작업 도구, 표 | 없음 | 대상/검색/필터/검토/iframe 상태와 스크롤 유지 | Master 수용 기준 통과 후 운영 전환 |
| `item-manager` | 파일럿 적용 | 작업헤더, 대상 탭, 조회 도구, 편집표 | 없음 | 선택/활성 셀/초안/스크롤/저장 유지 | Master 수용 기준 통과 후 운영 전환 |
| `merchops` | 등록 예외 | 아직 미적용 | 기존 화면을 유지하고 F7/F8/F9 계약으로 동일 업무 수행 | 저장·적용·출력·F키 | Master 파일럿 통과 후 순차 적용 |
| `dataops` | 등록 예외 | 아직 미적용 | 기존 자체 환경설정과 검증표 유지 | LOT·재고·원가·마감 | MerchOps 적용 검증 후 |
| `orderq` | 등록 예외 | 아직 미적용 | 기존 주문·구매·출고 작업대 유지 | 저장·출력·F키·복구 | DataOps 적용 검증 후 |
| `smart-parser` | 등록 예외 | 아직 미적용 | 기존 원본·파싱·마스터 검토 화면 유지 | 파싱·매칭·마스터 적용 | ORDER Q 적용 검증 후 |

등록되지 않은 예외는 허용하지 않는다. 후속 앱 적용은 이 표와 코드 등록부를 함께 갱신하고 해당 앱 회귀검사를 통과해야 한다.
