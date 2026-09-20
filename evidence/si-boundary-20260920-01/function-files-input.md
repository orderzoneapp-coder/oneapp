# SmartInput 입력 역할 통합 대응표

- 작업 ID: SI-BOUNDARY-20260920-01
- 기준 소스: `21eaf44d50883c68f6c40a6eca9d368df1eff09f`
- 범위: 입력 관련 실제 구현 통합. 다른 앱의 원본 파서·후보 엔진·저장소는 변경하지 않았다.
- 본체 import·호출 연결은 root 담당, 본 문서의 입력 모듈 구현과 직접 회귀 검증은 입력 담당.

| 기존 소유 위치 | 현재 소유 위치 | 통합 내용·실행 경계 |
|---|---|---|
| `source-row-values.js` | `input-template-mapper.js?v=0.3.0` | 보이지 않는 공백과 의미 있는 원본값·행 판정의 실제 함수 이동. 본체·붙여넣기·구조 시트 파서가 같은 구현을 사용한다. 기존 파일 제거. |
| `mapped-row-sync.js` | `input-template-mapper.js?v=0.3.0` | `projectedRowValue`, `mappedRowMutationPlan`, `applyMappedFieldUpdates` 이동. 공급가 산식·공란/0/음수·원본 증거 및 mapping 상태는 변경하지 않았다. 기존 파일 제거. |
| `grid-bulk-edit.js` | `input-template-mapper.js?v=0.3.0` | `parseBulkUnitPrice`, `applyBulkUnitPrice` 실제 구현 이동. 대상행 선택·표시값·이력 보존. 기존 파일 제거. |
| `file-intake-feature.js` | `xlsx-source-reader.js?v=0.2.0` | worksheet 실제 구현을 선택 진입점으로 직접 사용. 견적 시트 선택 export를 같은 진입점에서 제공해 재내보내기 전용 파일 제거. |
| `estimate-workbook-selector.js` | 기존 경로 유지 | 본체의 가벼운 상품행 판정은 초기 사용, XLSX 파일 처리와 로딩 시점이 달라 별도 유지. XLSX reader의 초기 정적 로딩은 추가하지 않았다. |
| 외부 순수 source parser → event detector → line parser → extractor | `input.js?v=0.1.0` | SmartInput이 필요한 순수 추출 구현을 소유한다. 단일 파일에 실제 구현을 통합했으며 다른 앱 파서를 런타임에 import하지 않는다. 메시지 키·그룹·취소/공지/정보·속성·문맥·단위·수량은 기존 결과와 비교했다. 외부 원본 파일은 유지한다. |
| `legacy-integration-adapter.js`의 text intake·문서 분석·재매칭 | `input.js?v=0.1.0` | `captureTextIntake`, `analyzeSingleOrderDocument`, `rematchExtractedLinesForCustomer`, `isSelectableMasterProduct` 실제 이동. 원본·세션·문서 ID 생성 규칙 유지. 외부 전달·창고·공식 명령 등 연동 함수는 이 입력 변경에서 수정하지 않았다. |
| 본체의 행 보존·정리 규칙 | `input.js?v=0.1.0` | `MEANINGFUL_ROW_FIELDS` 및 `hasEnteredValue`, `rowHasMeaningfulInput`, `rowHasLinkedSource`, `compactRowBlankValues`, `pruneEmptyWorkRows`, `manualLinkedRows` 실제 이동. DOM/state 의존 없는 기존 함수 본문과 변경 방식 유지. |
| 입력행마다 외부 후보 엔진의 저장소 읽기 | `input.js`의 supplied-snapshot matching | 호출자가 제공한 상품·선택 자료를 입력 처리 1회에 준비한다. 상품 ID 색인·매핑/이력 색인·동일 질의 결과를 그 처리 안에서 재사용한다. 입력 모듈은 DB·네트워크를 읽지 않는다. |

## 매칭 계약과 한계

- 본체는 현재 검증된 `state.products`와 회사·기준정보 revision을 전달한다. `analyzeSingleOrderDocument`는 `input.matchingContext`, 재매칭은 4번째 인자로 받는다.
- `createInputMatchingContext({ products, mappings, history, companyId, revision })`와 `generateInputProductCandidates(query, context)`는 이미 준비된 자료만 사용한다. history는 owner가 회사·고객 범위를 해석한 품목 행이어야 한다. 다른 회사라고 표시된 행은 후보에 포함하지 않는다.
- 기존 후보 계산의 정규화, 고객별/원본별/공통 매핑 점수 `1 / 0.98 / 0.96`, 이력 점수, 상품 정확일치 `0.94`, fuzzy 계산, 같은 점수의 원본 순서, 상위 8개 및 `0.94` 확정 임계값을 유지했다. 새로운 동일명 후보 판단 정책은 추가하지 않았다.
- 현재 owner에는 상품매칭사전·주문이력의 소비자용 Snapshot 계약이 없어 본체에서 그 자료를 자동으로 가져오지 않는다. 기존 소유 저장소의 `PRODUCT_MAPPINGS`, 주문·주문행은 삭제하거나 수정하지 않는다. mappings/history 입력은 계산 호환용으로 지원하며 별도 승인된 읽기 결과가 준비된 경우에만 공급할 수 있다.
- 본체의 기존 최종 `enrichRowFromUnifiedCatalog` 재판정은 유지한다. 단위 시험은 supplied fixture의 후보 계산 동등성을 입증하며 모든 실제 회사의 숨은 사전·이력 사용 효과까지 같다고 주장하지 않는다.
- Snapshot에 없는 상품 ID는 매핑이나 과거 행에서 새로 확정하지 않는다. 기준정보가 없으면 원문·문서 키·수량을 보존한 미매칭 입력을 반환한다. 단위 환산 규칙이나 새로운 가격 계산은 추가하지 않았다.
- `hasEnteredValue`는 본체의 finite-number/Boolean 의미를 유지한다. mapped-row 계산에 원래 존재했던 같은 이름의 내부 trim 판정과 서로 다른 의미이므로 억지로 합치지 않았다.

## 검증

1. 변경 전 기존 입력·복구·출력 테스트 15개 통과: `baseline-tests-input.json`.
2. 작은 파일 구조 통합 직후 동일 15개 통과: `structural-input-tests.json`. 이 단계에서 계산식 변경 없음.
3. 본체 행 규칙 이동과 로컬 입력 통합 후 기존 15개와 새 독립 입력 경계 테스트 1개 통과: `integrated-input-tests.json`.
4. 새 `test-smartinput-input-boundary.mjs`는 원본 추출기 결과 비교, 기존 후보 scorer의 fixture 실행 결과 비교, 원본 해시·문서/행 키 보존, IndexedDB·fetch 접근 차단 중 입력 지속, 회사 범위·없는 ID·0/음수/공백·행 정리 동작을 검증한다.
5. 기존 구조 경로만 강제하던 독립 복구 테스트의 파서 검사는 root가 새 소유 경계와 동작 보존에 맞게 갱신했다. 선택 로딩 테스트와 CI 연결도 root 담당이다.

실제 브라우저 전후 시간·저장소 접근 횟수는 별도 성능 담당 증거를 사용한다. Node 테스트 프로세스 시간은 앱 성능 개선율이 아니다.
