# SmartInput 견적서 자동 연결·F8 복구 개발명세서 v1.0

- 작업 ID: `NEXUS-SI-ESTIMATE-AUTO-LINK-F8-20260910-01`
- 작성일: 2026-09-10 KST
- 대상 앱: `smartinput/`
- 문서 상태: 구현 기준 확정, 단계별 구현·검증은 각 PR에서 관리
- 기준 원격 소스: `origin/main` `d2d954486766210b6659f4691f6bcac90afa3efb`
- 확인 작업 HEAD: `af799b58d2ce8b1e5a2761dfac34a9e66720a54c`
- 적용 규범: `AGENTS.md` v3.0.0, `APP_ARCHITECTURE.md`, `app-manifest.json`

## 1. 목적

SmartInput 견적서 업무를 다음 운영 흐름으로 바꾼다.

> 최초 확인 또는 정확 일치 → 매칭 저장 → 같은 견적서 ID로 자동 업데이트 → 관련 연동견적서 자동 재구성 → F8 출력

관리자의 반복 작업을 자동화하되, 결과가 하나로 결정되지 않거나 저장된 작업을 덮어쓸 수 있는 경우에만 확인을 요청한다. 한 연결 묶음의 문제가 관계없는 거래처의 정상 처리를 막지 않게 한다.

이번 개발은 다음 네 단계로 분리한다.

1. 견적서·연동견적서 목록 전환 경량화
2. 자동 연결과 연결 묶음 원자 저장
3. 관리자 확인과 F8 무결성 복구
4. 최종 통합 검증과 단계별 운영 배포 확인

## 2. 확정 운영 원칙

1. 정상 데이터는 확인 없이 처리한다.
2. 안정적인 식별값으로 정확히 일치하는 대상이 하나일 때만 자동 선택한다.
3. 유사 일치가 하나뿐이어도 자동 선택하지 않는다.
4. 확인 화면에는 문제가 있는 거래처 또는 품목만 표시한다.
5. 저장은 문제 품목만 분리하지 않고 그 품목이 속한 연결 묶음 전체를 한 성공 단위로 처리한다.
6. 문제가 없는 다른 연결 묶음은 계속 처리한다.
7. 관리자가 확인하면 매칭 저장, 견적서 업데이트, 연동견적서 재구성, F8 재개까지 자동 완료한다.
8. 취소, 저장 실패, 동시 변경 충돌은 성공으로 표시하지 않는다.
9. 신규 Store와 IndexedDB version 상승은 이번 범위에 포함하지 않는다.
10. 다른 PC·브라우저 간 자동 연결은 공유 저장 단계로 분리한다.

## 3. 현재 구현 사실과 변경 이유

### 3.1 목록 전환

현재 `selectEstimateLibraryKind()`는 일반 목록 전환에도 다음 작업을 수행한다.

- `rememberActiveEstimateWork()`
- `saveDraftNow()`
- `renderMode()`

`renderMode()`는 작업표 행, 견적서 목록, 배송 상태, 원본 분석과 화면 레이아웃까지 다시 처리한다. 목록 종류는 저장 초안의 업무 데이터가 아니므로 일반 전환에서 전체 초안 저장과 전체 화면 재렌더는 필요하지 않다.

### 3.2 자동 연결

현재 거래처별 견적서 업데이트에는 매칭사전 조회와 기존 견적서 ID 재사용 기능이 있다. 다만 다음 경계가 분리돼 있다.

- 견적서 레코드는 `commitEstimateBundle()`로 먼저 저장한다.
- 매칭사전은 이후 `saveAliasMapping()`으로 별도 저장한다.
- 원본 행을 거래처별로 다시 나눌 때 행 ID가 `source-1`, `source-2` 순서로 재발급될 수 있다.
- 개별 견적서가 교체돼도 이를 참조하는 모든 연동견적서를 같은 저장 단위에서 재구성하지 않는다.

따라서 견적서 저장 성공 후 매칭 저장이 실패하거나, 원본 행 순서 변경만으로 기존 행 연결이 끊길 수 있다.

### 3.3 F8 무결성

현재 `buildEstimateF8DraftPlan()`은 연동견적서가 참조하는 개별 견적서 또는 원본 행을 찾을 수 없으면 실패를 반환한다. `exportEstimateExcel()`은 오류를 표시하고 F8 출력을 중단한다.

향후 삭제는 연동견적서까지 정리하지만, 이미 저장돼 있는 끊어진 연결을 진단·정리하거나 독립 사본으로 전환하는 경로는 없다.

## 4. 용어와 저장 단위

| 용어 | 정의 |
|---|---|
| 개별 견적서 | `estimateKind !== 'LINKED_GROUP'`인 원본 견적서 |
| 연동견적서 | 두 개 이상의 개별 견적서를 참조하는 `LINKED_GROUP` 견적서 |
| 매칭사전 | 원본 거래처의 안정적 식별값과 대상 개별 견적서 ID를 연결한 `customerAliasMappings` 레코드 |
| 정확 일치 | 확정된 ID 또는 코드가 계약상 정규화 후 완전히 같고 후보가 1개인 상태 |
| 유사 후보 | 이름, 부분 문자열, 유사도 또는 과거 이름만으로 제안되는 후보. 자동 선택 금지 |
| 연결 묶음 | 업데이트 대상 개별 견적서와 이를 참조하는 모든 연동견적서, 해당 대상을 가리키는 매칭 레코드를 그래프로 연결한 connected component |
| 저장 작업본 | IndexedDB `estimates` Store에 확정된 견적서 레코드 |
| 미저장 작업본 | 현재 탭 메모리의 `state.estimateWorkingCopies`에 있고 저장 레코드와 다른 초안 |
| preimage | 계획 작성 시점에 읽은 기존 저장 레코드 전체 Snapshot |
| 영향 지문 | 관리자에게 표시한 누락 ID, 제거·유지 행, 적용 값과 대상 연결 묶음을 정규화해 만든 hash |

### 4.1 연결 묶음 계산

그래프 노드는 다음과 같다.

- 이번 업데이트 대상 개별 견적서
- 대상 개별 견적서를 `linkedEstimateSources`에서 참조하는 모든 연동견적서
- 대상 개별 견적서를 가리키는 매칭사전 레코드

다음 관계를 edge로 본다.

- 개별 견적서 ↔ 연동견적서
- 개별 견적서 ↔ 매칭사전

하나의 연동견적서가 개별 견적서 A와 B를 함께 참조하면 A와 B는 같은 연결 묶음이다. 이 묶음 안의 일부만 저장하지 않는다.

## 5. 전체 처리 흐름

1. 업로드 자료를 거래처별로 분류한다.
2. 거래처의 안정적인 식별값으로 기존 매칭과 대상 견적서를 판정한다.
3. 정확히 결정된 대상들을 연결 묶음으로 그룹화한다.
4. 새 원본 행과 기존 행을 1:1로 대조해 기존 행 ID를 유지한다.
5. 업데이트 후의 개별 견적서들로 관련 연동견적서를 모두 재구성한다.
6. 미저장 작업본과 동시 변경을 검사한다.
7. 자동 결정 가능한 연결 묶음은 즉시 원자 저장한다.
8. 결정할 수 없는 연결 묶음만 `확인 필요`에 대기시킨다.
9. 관리자 확인이 끝난 묶음은 같은 파이프라인으로 자동 재개한다.
10. 모든 처리 결과는 마지막에 한 번만 요약한다.

## 6. 1단계 — 목록 전환 경량화

### 6.1 범위

`견적서 목록`과 `연동견적서` 버튼을 누를 때 작업표·초안·목록 DOM을 다시 만들지 않고 표시 상태만 전환한다.

### 6.2 일반 전환 계약

일반 전환에서는 다음 상태만 변경한다.

- `state.estimateLibraryKind`
- 목록별 선택 상태
- 두 목록의 `hidden`
- 두 전환 버튼의 `is-active`, `aria-pressed`, `disabled`
- 다중 선택 버튼과 하단 작업 버튼의 활성 상태
- 목록 안내 문구와 선택 요약
- 기존 카드의 선택 표시

일반 전환에서는 다음 함수를 호출하지 않는다.

- `rememberActiveEstimateWork()`
- `saveDraftNow()`
- `queueAutosaveSnapshot()`
- `renderMode()`
- `renderRows()`
- `renderCatalogControls()`
- `renderDelivery()`

두 목록의 기존 DOM node는 교체하지 않는다. `innerHTML`을 다시 쓰지 않고 `hidden`과 필요한 속성만 변경한다. 각 목록의 스크롤 위치도 유지한다.

### 6.3 선택과 작업표 보존

- 목록을 바꿔도 현재 열려 있는 견적서 작업표를 닫거나 다른 견적서로 바꾸지 않는다.
- 개별·연동 목록은 각자의 마지막 선택 ID를 메모리에서 유지한다.
- 다시 돌아오면 해당 종류의 선택 표시와 작업 버튼 상태를 복원한다.
- 작업표 입력값, 선택된 셀, 입력 selection, 작업표 스크롤을 변경하지 않는다.
- 전환 전 작업표 입력 요소가 focus 상태였다면 전환 처리 뒤 같은 요소와 selection을 복구한다.

### 6.4 조합 미리보기 중 전환

`COMPOSITION_PREVIEW` 또는 연동견적서 생성 다중 선택 중 다른 목록으로 전환하면 다음을 수행한다.

1. 저장 작업본은 변경하지 않는다.
2. 시작 전에 보관한 `returnDraft`를 복원한다.
3. 미리보기와 다중 선택 상태를 종료한다.
4. 목표 목록으로 전환한다.
5. 작업표 전체 재렌더를 정확히 1회 수행한다.

이 경로에서도 전체 저장은 수행하지 않는다. 미리보기는 저장 데이터가 아니므로 별도 확인 팝업 없이 안전하게 취소한다.

### 6.5 구현 경계

`smartinput/smartinput.js`에 목록 전환 전용 경량 함수 하나를 둔다.

```js
syncEstimateLibraryView({
  previousKind,
  nextKind,
  restorePreviewDraft
})
```

이 함수는 견적서 레코드 배열을 정렬하거나 카드 markup을 만들지 않는다. 실제 데이터 로딩, 저장, 카드 추가·삭제·이름 변경 때만 기존 `renderCatalogControls()`를 사용한다.

### 6.6 성능 완료조건

80행 작업표와 개별·연동 카드가 각각 40개인 fixture에서 다음을 검증한다.

- 일반 전환 30회 중 전체 저장 0회
- 일반 전환 30회 중 작업표 렌더 0회
- 일반 전환 30회 중 목록 `innerHTML` 변경 0회
- 두 목록 DOM node identity 유지
- 입력값·focus·selection·작업표 스크롤 유지
- 목록별 스크롤 유지
- 미리보기 취소 전환에서 전체 렌더 정확히 1회
- 경량 handler 실행시간 p95 50ms 이하, 50ms 이상 long task 0회

CI의 1차 회귀 gate는 호출 횟수와 DOM identity로 판단한다. 시간 측정값은 동일 Chromium fixture의 warm-up 5회 후 30회 결과를 증거로 남긴다.

## 7. 2단계 — 자동 연결 핵심

### 7.1 거래처 대상 자동 선택

자동 선택 우선순위는 다음과 같다.

1. 같은 회사에서 확정된 매칭사전의 `sourceCustomerId`와 현재 거래처 owner ID가 정확히 일치
2. 같은 회사에서 확정된 매칭사전의 `sourceCustomerCode`와 현재 거래처 코드가 정확히 일치
3. ID·코드가 없는 거래처에서 관리자가 최초 확인한 매칭사전의 정규화명과 현재 정규화명이 정확히 일치
4. 기존 개별 견적서의 거래처 owner ID가 정확히 일치
5. 기존 개별 견적서의 거래처 코드가 정확히 일치

각 단계에서 유효한 대상 개별 견적서가 정확히 1개일 때만 자동 선택한다. 다음은 자동 선택하지 않는다.

- 최초 확인 이력이 없는 거래처명만 일치
- 유사도 또는 부분 문자열 일치
- 매칭사전이 서로 다른 대상 ID를 가리킴
- 매칭 대상 견적서가 삭제됨
- 대상이 연동견적서임
- 같은 안정 식별값으로 후보가 여러 개임

최초 확인 이력이 없는 이름 일치 후보는 확인 화면의 추천으로만 표시한다. 관리자가 ID·코드 없는 거래처를 한 번 확정한 뒤 저장된 정규화명 매핑은 다음 업데이트부터 자동 적용한다. 정규화명 매핑도 완전 일치 후보가 하나일 때만 유효하며 유사명에는 적용하지 않는다.

### 7.2 최초 확인 결과 저장

관리자가 기존 견적서를 선택하거나 새 견적서를 생성하면 매칭사전에 다음 안정 정보를 저장한다.

- `companyId`
- `sourceCustomerId`
- `sourceCustomerCode`
- 원문 거래처명과 정규화명
- ID·코드가 모두 없으면 `sourceIdentityType: 'NORMALIZED_NAME'`으로 최초 관리자 확인 근거를 저장
- `targetEstimateId`
- `status: 'CONFIRMED'`
- 확인자와 확인 시각
- 작업 ID와 결정 이력

`이번 거래처 제외`는 현재 작업 계획에만 기록하고 매칭사전에는 저장하지 않는다.

### 7.3 품목 행 1:1 대조와 행 ID 유지

새 원본 행과 기존 대상 견적서 행은 아직 연결되지 않은 행끼리 다음 순서로 대조한다.

1. 상품 마스터 ID: `masterProductId` 또는 계약상 동등한 `productId`
2. 품목코드: `itemCode`
3. 품명·규격·단위: `itemName + specification + unit`

각 단계는 현재 owner·SmartInput 계약의 정규화만 사용한다. fuzzy, substring, Levenshtein, 첫 후보 선택은 사용하지 않는다.

각 단계의 처리 규칙은 다음과 같다.

- 새 행 1개와 기존 행 1개가 일치: 기존 `rowId`를 반드시 유지
- 상품 identity가 확정된 새 행의 기존 후보가 0개: 신규 행으로 자동 추가
- 기존 행에 대응하는 새 행이 0개: 현재 전체교체 계약에 따라 제거
- 어느 쪽이든 같은 key가 복수: 해당 품목을 `확인 필요`로 전환
- 상품 상태가 `SIMILAR`, `UNRESOLVED`, `MATCH_FAILED`: 자동 저장 금지

원본 행 순서가 바뀌어도 일치 결과와 기존 행 ID가 바뀌면 안 된다. 새 행 ID는 기존 ID 전체와 충돌하지 않는 `SIROW` ID로 한 번 생성하고 재시도 동안 같은 ID를 사용한다.

거래처별로 분리한 `inputMapping.workingRows`, `manualRows`, 행 edit evidence의 `rowId`도 최종 행 ID와 함께 다시 묶는다. 원본 셀 주소와 `sourceRowIndex`는 실제 새 파일 위치를 유지한다.

### 7.4 개별 견적서 업데이트

- 기존 대상은 `estimateId`, `catalogName`, `createdAt`, `sortOrder`를 유지한다.
- 기존 행과 1:1 일치한 행은 `rowId`를 유지한다.
- 새 파일의 행 값과 원본 증적을 최신 값으로 저장한다.
- 견적서와 draft의 `updatedAt`을 같은 operation 시각으로 갱신한다.
- 새 견적서는 새 `estimateId`를 발급하되 commit 전까지 확정으로 간주하지 않는다.

### 7.5 관련 연동견적서 자동 재구성

업데이트 대상 개별 견적서를 참조하는 모든 연동견적서를 찾는다. 연결 묶음 안의 개별 견적서가 여러 개 갱신되면 모두 갱신된 postimage를 사용해 연동견적서를 한 번만 재구성한다.

재구성 규칙은 다음과 같다.

- 새 원본에 추가된 품목 반영
- 새 원본에서 제거된 품목 제거
- 수량·단가·상품정보 변경 반영
- 동일 품목의 원본 참조 목록 재계산
- 연동견적서 `estimateId`, 이름, 생성일, 정렬순서 유지
- 원본 참조가 없는 수기 행의 값과 `rowId` 유지
- 수기 행 위치는 가장 가까운 생존 원본 행 anchor 뒤에 복원하고, anchor가 없으면 마지막에 배치

저장된 연동견적서 편집값은 새 원본 위에 다시 덮어쓰지 않는다. 저장된 편집은 기존 양방향 저장 과정에서 원본에 이미 반영됐으므로 재구성 결과의 최신 원본이 기준이다.

### 7.6 미저장 작업본 처리

미저장 작업본을 원본 견적서에 자동 저장하지 않는다. 저장 레코드, 새 재구성 결과, 미저장 작업본을 3-way 비교한다.

- 저장 기준과 작업본이 같고 새 원본만 변경: 새 원본 적용
- 저장 기준과 새 원본이 같고 작업본만 변경: 작업본을 메모리에 유지
- 양쪽이 같은 값으로 변경: 충돌 없음
- 같은 필드를 서로 다른 값으로 변경: 해당 품목 확인 필요

충돌 화면에는 해당 품목만 표시하지만, 결정 전에는 그 품목이 속한 연결 묶음 전체를 저장하지 않는다. 충돌 없는 다른 연결 묶음은 계속 저장한다.

### 7.7 연결 묶음 원자 저장 API

`smartinput-data-store.js`에 기존 함수와 별도로 다음 저장 경계를 추가한다.

```js
commitEstimateLinkBundle({
  operationId,
  estimateUpserts,
  estimateDeletes,
  aliasUpserts,
  aliasDeletes,
  expectedEstimatePreimages,
  expectedAliasPreimages,
  expectedMissingIds: {
    estimates,
    aliasMappings
  }
})
```

IndexedDB 경로는 기존 DB version 5를 유지하고 `estimates`, `customerAliasMappings` 두 Store를 하나의 `readwrite` transaction으로 연다.

쓰기 전에 다음을 전부 검사한다.

- 기존 견적서의 canonical preimage hash 일치
- 기존 매칭 레코드의 canonical preimage hash 일치
- 신규 견적서 ID가 실제로 없음
- 신규 매칭 ID가 실제로 없음
- 계획의 모든 연결 묶음 구성원이 transaction 대상에 포함됨

하나라도 다르면 put/delete를 수행하지 않고 transaction을 abort한다. 모든 검사가 끝난 후에만 매칭사전, 개별 견적서, 연동견적서를 쓴다.

localStorage fallback은 기존 fallback 객체의 두 Store 사본을 메모리에서 모두 검증·변경한 뒤 `setItem` 한 번으로 저장한다. 쓰기 실패 시 기존 문자열을 유지한다.

IndexedDB transaction 완료 후에만 `state.estimates`, `state.aliasMappings`, working-copy baseline을 갱신한다.

### 7.8 이력

신규 Store를 만들지 않는다. 기존 견적서와 매칭 레코드에 additive 배열을 추가한다.

```js
estimateAutomationHistory: [{
  operationId,
  operationType,
  status,
  actorId,
  occurredAt,
  componentId,
  reasonCode,
  sourceEstimateIds,
  changedRowIds,
  beforeHash,
  afterHash
}]
```

매칭 레코드의 `decisionHistory`에는 관리자 선택 또는 자동 정확 일치의 근거, 대상 ID와 결과를 같은 `operationId`로 기록한다. `이번만 제외`는 확정 매칭 레코드를 만들지 않고 현재 draft의 `estimateBulkProgress.operationHistory`와 autosave에만 기록한다. 원본 전체를 이력에 중복 저장하지 않는다.

전용 이력 Store와 서버 공유 이력은 공유 저장 단계에서 별도 설계한다.

### 7.9 2단계 출시 시 확인 필요 건

3단계 UI가 배포되기 전에는 자동 결정 가능한 연결 묶음만 새 파이프라인으로 저장한다. 모호하거나 충돌한 묶음은 현재 거래처별 업데이트 화면에서 `확인 필요`로 남기고 0-write한다. 임시 첫 후보 선택이나 부분 저장을 추가하지 않는다.

## 8. 3단계 — 관리자 확인과 F8 복구

### 8.1 확인 요청 조건

다음 경우에만 확인을 요청한다.

- 정확히 일치하는 거래처·견적서 대상이 없음
- 정확한 후보가 여러 개
- 기존 매칭 대상 견적서가 삭제됨
- 품목 행을 1:1로 연결할 수 없음
- 새 원본과 미저장 작업본이 같은 필드를 서로 다르게 변경
- F8 대상 연동견적서의 원본 견적서 또는 원본 행 참조가 누락됨
- 관리자가 기존 연결을 직접 변경하려 함

### 8.2 통합 `확인 필요` 화면

정상 연결 묶음을 먼저 처리한 뒤 문제 항목을 팝업 여러 개가 아닌 하나의 확인 화면에 모은다.

화면 상단에는 다음 요약을 표시한다.

- 자동 완료 연결 묶음 수
- 확인 필요 연결 묶음 수
- 제외 수
- 저장 실패 수

본문은 첫 미해결 항목을 자동으로 선택한다. 하나를 해결하면 다음 미해결 항목으로 이동한다. 좌측 목록 또는 상단 `이전/다음`으로 항목을 다시 볼 수 있다.

| 확인 유형 | 표시 정보 | 관리자 선택 |
|---|---|---|
| 거래처와 견적서 연결 | 원본 거래처 ID·코드·이름, 후보 견적서 ID·이름·최근 수정일 | 기존 견적서 연결 / 새 견적서 생성 / 이번 거래처 제외 |
| 품목 행 연결 | 상품 ID·품목코드·품명·규격·단위, 기존 후보 행 | 기존 행 선택 / 신규 행 추가 / 이번 품목 제외 |
| 삭제된 연결 대상 | 저장된 대상 ID, 확인 가능한 과거 이름, 추천 후보 | 다른 견적서로 재연결 / 새 견적서 생성 / 제외 |
| 미저장 값 충돌 | 저장 기준, 새 원본값, 작업 중 값, 충돌 필드 | 새 원본값 적용 / 작업 중인 값 유지 |

`이번 거래처 제외`, `이번 품목 제외`는 현재 operation에만 적용하며 매칭사전에 확정 연결로 저장하지 않는다.

모든 결정을 마치면 `확인 내용 적용` 버튼 하나로 해당 연결 묶음들을 다시 계획한다. 결정 가능한 묶음은 자동 저장하고 관련 연동견적서를 재구성한다. 완료 toast는 전체 작업 종료 시 한 번만 표시한다.

### 8.3 목록의 연결 무결성 표시

견적서 목록 로딩이 끝나면 메모리에 로드된 견적서 배열을 한 번 순회해 연동 무결성을 검사한다. 연동 카드에는 다음 badge 중 하나를 표시한다.

- `정상`
- `원본 1개 누락`
- `원본 N개 누락`
- `원본 행 N개 누락`

검사는 추가 DB 조회 없이 현재 로드 결과로 계산한다. 누락이 있어도 목록 열기와 관계없는 업무는 막지 않는다.

연동견적서를 열면 작업표 위에 비차단 안내를 표시한다.

> 연결된 원본 일부를 확인할 수 있습니다. 보고서 출력 전에 영향을 확인하고 자동 정리할 수 있습니다.

### 8.4 F8 진단 결과

`buildEstimateF8DraftPlan()`의 단순 문자열 실패와 별도로 구조화된 진단을 제공한다.

```js
{
  status: 'READY' | 'PARTIAL_MISSING' | 'ALL_MISSING' | 'INVALID',
  targetEstimateId,
  missingSourceIds,
  missingRowRefs,
  availableSourceIds,
  removedRows,
  keptRows,
  manualRows,
  impactFingerprint,
  errorCode,
  message
}
```

- `READY`: 확인 없이 기존 F8 출력 진행
- `PARTIAL_MISSING`: 영향 미리보기 후 관리자 확인
- `ALL_MISSING`: 저장 스냅샷 기반 독립 사본 또는 취소
- `INVALID`: 유형 불일치, 중복 참조처럼 자동 정리 결과를 보장할 수 없는 기술 오류. 출력 중단

### 8.5 일부 원본 누락

F8 실행 시 모달 한 번으로 다음을 표시한다.

- 누락 원본 견적서 ID
- 확인 가능한 경우 원본 견적서명과 거래처명
- 제거될 품목과 원본 행 참조
- 남을 품목
- 보존할 수기 행
- 적용 후 원본·품목 수

버튼은 다음 두 개다.

- `자동 정리 후 F8 계속`
- `취소`

확인 후 처리 순서는 다음과 같다.

1. 누락 원본 ID와 누락 원본 행 참조만 제거한다.
2. 남은 정상 원본의 최신 저장값으로 연동견적서를 재구성한다.
3. 원본 참조가 없는 수기 행을 보존한다.
4. 저장된 과거 연동 편집값을 최신 원본 위에 다시 적용하지 않는다.
5. 대상 연결 묶음의 preimage와 영향 지문을 재검사한다.
6. 연동견적서와 이력을 원자 저장한다.
7. 저장된 postimage로 무결성을 다시 검사한다.
8. `READY`이면 사용자의 추가 동작 없이 같은 F8 출력을 재개한다.

취소하면 저장·매칭·초안 변경 0회이고 Excel을 생성하지 않는다.

### 8.6 전체 원본 누락

모든 원본 견적서가 없으면 자동 복원하지 않는다. 저장된 연동견적서 Snapshot을 미리보기로 제공하고 다음만 선택할 수 있다.

- `독립 복구 사본으로 저장·출력`
- `취소`

미리보기에는 다음을 표시한다.

- 원본 견적서별 참조 행 수
- Snapshot에 남아 확인 가능한 경우에만 거래처명
- 저장된 품목 수와 금액
- 저장 시각
- 원본 전체 누락 ID

다음 경고를 고정 표시한다.

> 중복 품목은 저장 당시 대표값만 남아 원본별 값은 복원되지 않을 수 있습니다.

독립 복구 사본 처리 규칙은 다음과 같다.

- 새 `estimateId`를 한 번 생성하고 재시도 동안 재사용
- 원본 연동견적서는 변경·삭제하지 않음
- 새 레코드는 `estimateKind: 'INDIVIDUAL'`
- `linkedEstimateSources`와 행의 `linkedSourceEstimateId`, `linkedSourceRowId`, `linkedSourceEstimateIds`, `linkedSourceRefs` 제거
- 연결 근거가 없는 사본임을 `recoveryOrigin`과 이력에 기록
- 제목에 `독립 복구 사본` 표시
- `expectedMissingIds.estimates`로 새 ID의 부재 검증
- 저장 성공 후 새 사본을 대상으로 F8 출력 자동 실행

이는 삭제된 원본 복원이 아니라 현재 확인 가능한 값의 관리자 확인 사본이다.

### 8.7 revision/preimage 충돌 재시도

관리자 확인 뒤 commit 직전에 저장소를 다시 읽는다.

- preimage가 바뀌었지만 새 영향 지문이 이전과 완전히 같음: 최신 preimage로 자동 재시도 1회
- 누락 ID, 제거 행, 유지 값, 대상 연결 묶음 중 하나라도 바뀜: 기존 확인을 무효화하고 변경된 내용으로 같은 화면에서 한 번 다시 확인
- 두 번째 재검사에서도 변경됨: 자동 반복하지 않고 `다른 작업에서 계속 변경 중`으로 해당 연결 묶음만 대기
- 기술 저장 실패: Excel 출력하지 않고 저장 전 상태 유지

신규 견적서와 신규 매칭 레코드도 `expectedMissingIds`를 검사한다. 동시 작업이 같은 ID나 같은 확정 매칭을 먼저 만들었으면 새 대상을 중복 생성하지 않고 계획을 다시 판정한다.

## 9. 데이터 계약

### 9.1 견적서 additive 필드

```js
{
  estimateAutomationHistory: [],
  recoveryOrigin: {
    type: 'LINKED_SNAPSHOT_WITHOUT_SOURCES',
    sourceLinkedEstimateId: '',
    missingSourceIds: [],
    confirmedBy: '',
    confirmedAt: '',
    operationId: ''
  }
}
```

`recoveryOrigin`은 독립 복구 사본에만 저장한다. legacy 레코드에 필드가 없어도 정상 로딩해야 한다.

### 9.2 매칭사전 additive 필드

```js
{
  sourceIdentityType: 'CUSTOMER_ID' | 'CUSTOMER_CODE' | 'NORMALIZED_NAME',
  sourceIdentityValue: '',
  decisionHistory: []
}
```

최초 관리자 확인 이력이 없는 이름-only legacy 매칭은 삭제하지 않지만 자동 확정 근거로 사용하지 않는다. `confirmedBy`, `confirmedAt`, `sourceIdentityType: 'NORMALIZED_NAME'`이 있는 확정 매핑만 다음 업데이트의 자동 연결에 사용한다.

### 9.3 동시성 token

현재 견적서와 매칭 레코드에는 모든 writer가 공유하는 공통 revision 계약이 없다. 이번 단계에서 이름뿐인 revision 필드를 일부 경로에만 추가하지 않는다.

동시성 검사는 다음 token으로 수행한다.

- 기존 레코드: 정규화한 전체 preimage의 canonical hash
- 신규 레코드: `expectedMissingIds`
- UI 재확인: 관리자에게 표시한 `impactFingerprint`

향후 모든 견적서 writer가 공유하는 revision을 도입할 때는 별도 저장계약 변경으로 진행한다. 그 전까지 문서의 `revision/preimage 충돌`은 명시 revision이 있으면 revision을, 없으면 canonical preimage hash를 뜻한다.

### 9.4 operation 공통 필드

- `operationId`: 한 번의 관리자 또는 자동 작업을 식별하는 유일 ID
- `componentId`: 연결 묶음의 정렬된 estimate ID로 계산한 안정 지문
- `actorId`: 현재 SmartInput 관리자 식별값
- `occurredAt`: KST 표시가 가능한 ISO 시각
- `beforeHash`, `afterHash`: 정규화된 저장 레코드 hash
- `reasonCode`: 자동 일치, 관리자 선택, F8 정리, 독립 복구 등 고정 코드

## 10. 순수 로직과 UI 분리

다음 로직은 DOM을 참조하지 않는 순수 함수로 구현한다.

```js
resolveStableEstimateTarget()
reconcileEstimateRows()
buildEstimateLinkComponents()
rebuildLinkedEstimateRecord()
inspectEstimateWorkingCopyMerge()
createEstimateLinkUpdatePlan()
inspectEstimateLinkIntegrity()
createEstimateF8RecoveryPlan()
applyEstimateF8RecoveryPlan()
```

권장 파일 경계는 다음과 같다.

| 파일 | 책임 |
|---|---|
| `smartinput/estimate-bulk-update.js` | 거래처 분류, 안정 대상 판정, 기존 bulk 계획과 진행 상태 |
| `smartinput/estimate-link-sync.js` 신규 | 행 ID 대조, 연결 묶음 계산, 연동 재구성, working-copy 3-way 충돌 |
| `smartinput/estimate-f8-source-plan.js` | F8 구조화 진단과 복구 전·후 무결성 계획 |
| `smartinput/smartinput-data-store.js` | 두 Store 원자 transaction, preimage와 expected-missing 검증 |
| `smartinput/smartinput.js` | 단계 실행, 상태 반영, 단일 확인 화면, F8 자동 재개 |
| `smartinput/smartinput.css` | 확인 필요와 F8 영향 미리보기 스타일 |

## 11. 오류 코드

| 코드 | 의미 | 처리 |
|---|---|---|
| `ESTIMATE_LINK_TARGET_UNRESOLVED` | 안정 식별값으로 대상 없음 | 확인 필요 |
| `ESTIMATE_LINK_TARGET_AMBIGUOUS` | 정확 후보 복수 | 확인 필요 |
| `ESTIMATE_LINK_TARGET_MISSING` | 저장된 매칭 대상 삭제 | 확인 필요 |
| `ESTIMATE_ROW_MATCH_AMBIGUOUS` | 품목 행 1:1 대조 불가 | 품목 확인 필요 |
| `ESTIMATE_LINK_WORKING_COPY_CONFLICT` | 같은 필드의 미저장 값 충돌 | 품목 확인 필요, 묶음 대기 |
| `SMARTINPUT_ESTIMATE_LINK_BUNDLE_STALE` | 기존 레코드 preimage 불일치 | 영향 재검사 |
| `SMARTINPUT_EXPECTED_MISSING_CONFLICT` | 신규 ID 또는 매칭이 이미 존재 | 계획 재판정 |
| `ESTIMATE_F8_SOURCE_PARTIAL_MISSING` | 일부 원본 또는 행 누락 | 영향 확인 후 정리 가능 |
| `ESTIMATE_F8_SOURCE_ALL_MISSING` | 모든 원본 누락 | 독립 사본 또는 취소 |
| `ESTIMATE_F8_RECOVERY_IMPACT_CHANGED` | 확인 뒤 영향 범위 변경 | 변경 내용 재확인 |
| `ESTIMATE_F8_SOURCE_INVALID` | 자동 정리할 수 없는 구조 오류 | 해당 F8 중단 |

기존 오류 코드가 외부 테스트 계약으로 사용되면 호환 alias를 유지하고 UI에는 위 의미로 통합 표시한다.

## 12. 단계별 테스트 명세

### 12.1 1단계

신규 브라우저 테스트: `scripts/test-smartinput-estimate-library-switch-browser.mjs`

| ID | 조건 | 기대 결과 |
|---|---|---|
| `LS-01` | 80행, 일반 개별→연동 전환 | 저장 0, 작업표 렌더 0, 카드 DOM 유지 |
| `LS-02` | 연동→개별 왕복 30회 | 입력값·focus·selection·스크롤 유지 |
| `LS-03` | 목록별 카드 스크롤과 선택 후 왕복 | 각 목록 상태 유지 |
| `LS-04` | 조합 미리보기 중 연동 목록 전환 | returnDraft 복원, 전체 렌더 1회 |
| `LS-05` | 저장소 쓰기 spy | 일반·미리보기 전환 모두 영구 write 0 |
| `LS-06` | warm-up 후 30회 | p95 50ms 이하, long task 0 |

### 12.2 2단계 순수 계약

신규 테스트: `scripts/test-smartinput-estimate-auto-link.mjs`

| ID | 조건 | 기대 결과 |
|---|---|---|
| `AL-01` | 확정 customer ID 매칭 1개 | 확인 없이 기존 견적서 선택 |
| `AL-02` | 최초 확인 없는 이름 후보 1개 | 자동 선택 금지 |
| `AL-02A` | ID·코드 없이 최초 확인한 정규화명 매핑 1개 | 다음 업데이트에서 자동 선택 |
| `AL-03` | 정확 후보 복수 | 해당 연결 묶음 PENDING |
| `AL-04` | 대상 견적서 삭제 | 매칭 대상 누락 확인 필요 |
| `AL-05` | 같은 파일 두 번째 처리 | 수동 매핑 0, 견적서 ID 변경 0 |
| `AL-06` | 새로고침 후 같은 파일 처리 | 수동 매핑 0 |
| `RI-01` | 원본 행 순서만 변경 | 기존 행 ID 전부 유지 |
| `RI-02` | master ID 정확 일치 | 기존 행 ID 유지 |
| `RI-03` | master ID 없음, code 정확 일치 | 기존 행 ID 유지 |
| `RI-04` | code 없음, 이름·규격·단위 1:1 | 기존 행 ID 유지 |
| `RI-05` | 동일 key 복수 | 첫 후보 금지, 해당 품목 확인 필요 |
| `RI-06` | 식별 확정 신규 품목, 기존 후보 0개 | 확인 없이 신규 행 ID 생성 |
| `RI-07` | 새 견적서 생성의 확정 상품 | 신규 행 ID 생성 |

### 12.3 2단계 저장·연동 계약

신규 또는 확장 테스트:

- `scripts/test-smartinput-estimate-link-bundle-atomicity.mjs`
- `scripts/test-smartinput-estimate-auto-link-browser.mjs`

| ID | 조건 | 기대 결과 |
|---|---|---|
| `TX-01` | 견적·매칭·연동 모두 정상 | 한 transaction 성공 |
| `TX-02` | 두 번째 estimate put 실패 주입 | 견적·연동·매칭 모두 preimage 유지 |
| `TX-03` | alias put 실패 주입 | 견적·연동 모두 preimage 유지 |
| `TX-04` | preimage stale | 묶음 전체 0-write |
| `TX-05` | 신규 ID가 이미 존재 | 중복 생성 0, 계획 재판정 |
| `TX-06` | A 묶음 충돌, B 묶음 정상 | A 0-write, B 성공 |
| `LK-01` | 원본 하나를 연동견적서 여러 개가 참조 | 모든 연동견적서 자동 갱신 |
| `LK-02` | 같은 연동견적서가 갱신 원본 두 개 참조 | 같은 묶음으로 1회 재구성·저장 |
| `LK-03` | 연동 수기 행 존재 | 값·rowId 보존 |
| `LK-04` | 저장된 과거 연동 편집값 존재 | 최신 원본을 다시 덮어쓰지 않음 |
| `LK-05` | 미저장 비충돌 편집 | 작업본 유지, 자동 저장 안 함 |
| `LK-06` | 미저장 동일 필드 충돌 | 해당 묶음만 PENDING |

### 12.4 3단계 확인·F8 계약

신규 또는 확장 테스트:

- `scripts/test-smartinput-estimate-review-browser.mjs`
- `scripts/test-smartinput-estimate-f8-recovery.mjs`
- `scripts/test-smartinput-estimate-f8.mjs`

| ID | 조건 | 기대 결과 |
|---|---|---|
| `RV-01` | 문제 3건 | 팝업 1개, 첫 문제 자동 선택, 순차 이동 |
| `RV-02` | 거래처 제외 | 이번 작업만 제외, 매칭 write 0 |
| `RV-03` | 관리자 기존 대상 선택 | 결정 저장 후 묶음 자동 재개 |
| `RV-04` | 관리자 신규 대상 선택 | expected-missing 검증 후 생성 |
| `F8-01` | 정상 연결 | 확인 없이 즉시 출력 |
| `F8-02` | 일부 원본 누락 | 영향 모달 1회 |
| `F8-03` | 일부 누락 확인 | 정리·저장·재검사·F8 자동 완료 |
| `F8-04` | 일부 누락 취소 | 저장 변경 0, Excel 0 |
| `F8-05` | 전체 원본 누락 | Snapshot과 고정 경고 표시 |
| `F8-06` | 독립 사본 선택 | 새 ID 저장, 연결 제거, 원본 stale record 유지, F8 성공 |
| `F8-07` | 독립 사본 취소 | 저장 변경 0 |
| `F8-08` | 확인 후 preimage 변경, 영향 동일 | 자동 재시도 1회 |
| `F8-09` | 확인 후 제거·유지 행 변경 | 변경 내용 재확인 |
| `F8-10` | 재확인 중 다시 변경 | 해당 묶음 대기, 관계없는 작업 유지 |

### 12.5 전체 회귀

각 단계에서 영향받은 기존 검사를 실행한다.

- `node scripts/test-smartinput-estimate-bulk-update.mjs`
- `node scripts/test-smartinput-estimate-bulk-update-browser.mjs`
- `node scripts/test-smartinput-estimate-per-customer-commit.mjs`
- `node scripts/test-smartinput-estimate-bundle-atomicity.mjs`
- `node scripts/test-smartinput-linked-estimate-source-edit.mjs`
- `node scripts/test-smartinput-linked-estimate-source-dialog-browser.mjs`
- `node scripts/test-smartinput-estimate-f8.mjs`
- `node scripts/test-smartinput-right-panel-touch-browser.mjs`
- `node scripts/test-smartinput-browser-e2e.mjs`
- 저장소 validator, client safety, 변경 JavaScript syntax, `git diff --check`

## 13. 단계별 PR과 배포

### PR 1 — 목록 전환 경량화

- 저장·데이터 구조 변경 없음
- 목록 전환 전용 함수와 브라우저 성능 회귀 테스트만 포함
- 병합 후 실제 80행 작업표에서 개별↔연동 왕복 확인
- 문제 발생 시 PR 1만 revert

### PR 2 — 자동 연결 핵심

- 안정 거래처 판정
- 행 ID 유지
- 연결 묶음 계산
- 모든 관련 연동견적서 재구성
- 견적서·매칭사전 원자 transaction
- additive operation 이력과 canonical preimage hash 검증
- 자동 결정 가능한 묶음만 처리

PR 2는 위 항목 중 일부를 별도 배포하지 않는다. 네 핵심 항목이 서로 데이터 계약으로 연결돼 있으므로 한 PR 안에서 함께 검증한다.

### PR 3 — 관리자 확인과 F8 복구

- 통합 확인 필요 화면
- 목록 무결성 badge와 비차단 안내
- 일부 누락 자동 정리
- 전체 누락 독립 복구 사본
- 확인 후 F8 자동 재개
- 영향 지문 기반 재확인

### 최종 통합 검증

- PR 1~3이 모두 반영된 최신 `main` SHA 고정
- 연속 업데이트와 새로고침 후 자동 연결
- 원본 행 순서 변경
- 다수 연동견적서 동시 재구성
- Store별 실패 주입과 묶음 rollback
- F8 정상·일부 누락·전체 누락
- 단계별 운영 정적 파일 version과 배포 SHA 일치 확인

각 PR은 이전 PR이 배포된 최신 `main`에서 시작한다. 이전 단계의 실사용 문제가 있으면 다음 단계에 섞지 않고 해당 PR을 수정하거나 revert한다.

## 14. 롤백과 데이터 보호

- PR 1 롤백은 목록 전환 handler만 이전 방식으로 되돌린다. 저장 데이터 영향이 없다.
- PR 2·3의 additive 필드는 이전 코드가 무시할 수 있어야 하며 DB version downgrade가 없어야 한다.
- 실패한 transaction은 모든 Store의 preimage를 유지한다.
- 코드 revert는 이미 성공 저장된 견적서 내용을 자동으로 이전 상태로 되돌리지 않는다.
- 성공 작업의 추적은 각 레코드의 operation 이력과 원본 업로드 증적으로 수행한다.
- 운영 사용자 데이터에는 실패 주입이나 파괴적 복구 시험을 수행하지 않는다. 격리된 IndexedDB fixture만 사용한다.

## 15. 범위 제외

- 삭제된 개별 원본 견적서의 자동 재생성
- 연동견적서 대표값만으로 원본별 값을 추정 복원
- 유사도 기반 무확인 자동 매칭
- 신규 IndexedDB Store 또는 DB version 상승
- 서버 동기화와 다른 PC·브라우저 간 자동 연결
- 전용 영구 undo 저장소
- MerchOps Settings, 상품 Master 또는 다른 앱 owner 저장소 쓰기

다른 PC·브라우저 지원 단계에서는 매칭사전만 공유해서는 안 된다. 견적서의 안정 ID, 개별·연동 레코드와 revision도 함께 공유하는 별도 저장·충돌 계약이 필요하다.

## 16. 최종 완료조건

다음 조건을 모두 충족해야 전체 개발 완료로 판정한다.

1. 80행 일반 목록 전환에서 전체 저장, 작업표 렌더, 목록 재생성 0회
2. 목록 전환 후 입력값·focus·selection·작업표 및 목록 스크롤 유지
3. 같은 자료의 두 번째 업데이트에서 수동 매핑 0회
4. 새로고침 후 두 번째 업데이트에서도 수동 매핑 0회
5. 기존 견적서 ID 변경 0회
6. 원본 행 순서가 바뀌어도 1:1 일치 행 ID 유지
7. 하나의 원본을 참조하는 모든 연동견적서 자동 갱신
8. 견적서·매칭사전·관련 연동견적서가 연결 묶음 단위로 원자 저장
9. 충돌 연결 묶음만 대기하고 관계없는 묶음은 계속 처리
10. 정상 F8은 확인 없이 출력
11. 일부 원본 누락은 확인 1회 후 자동 정리·저장·출력 완료
12. 전체 원본 누락은 독립 복구 사본 또는 취소만 제공
13. F8 복구 취소 시 저장 변경 0회
14. 저장 실패·동시 변경 시 해당 연결 묶음 전체 rollback
15. 모든 관리자 선택과 자동 처리 결과가 같은 `operationId`로 추적 가능
16. 관련 비브라우저·브라우저 회귀와 배포 SHA 확인 통과

## 17. 구현 착수 전 열린 정책

추가로 결정할 업무 정책은 없다. 구현 중 함수 분리, 내부 hash 방식, 테스트 fixture 수량 같은 기술 세부는 위 계약을 바꾸지 않는 범위에서 개발자가 정한다.

이 문서는 구현·테스트·단계별 PR의 기준이며, 문서 작성만으로 생산 소스 변경이나 운영 배포가 완료된 것으로 보지 않는다.
