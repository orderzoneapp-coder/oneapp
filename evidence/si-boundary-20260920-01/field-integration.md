# SmartInput 기준정보·설정 역할 통합 근거

- 작업 ID: SI-BOUNDARY-20260920-01
- 기준 소스: 21eaf44d50883c68f6c40a6eca9d368df1eff09f
- 대상 명세: docs/SI-BOUNDARY-20260920-01.md (v1.5)
- 변경: field-definition-contract.js와 settings-input-order.js의 실제 구현을 field-registry.js에 흡수하고 두 구파일을 삭제했다. 기존 순수 export 전체를 유지했다.
- 판정: 아래 정적·Node 회귀 통과. 실제 화면·브라우저 저장·성능·배포 결과는 전체 통합 보고서에서 별도 판정한다.

## 통합 대응표

| 기존 파일·함수 | 최종 소유 위치 | 소비자·로딩 | 유지·삭제 | 확인 근거 |
|---|---|---|---|---|
| field-definition-contract.js의 schema, mode·scope·status·owner 상수, CORE_FIELD_DEFINITIONS, CUSTOM_FIELD_DEFINITIONS, 내부 field builder | field-registry.js:11~116 | SmartInput과 같은 field registry의 초기 정적 import, 필드·매핑 검사 | 실제 상수·함수 흡수, 구파일 삭제 | seed 2,178개/검토필요 63개/전표별 수량·가격, 사용자정의 문자·숫자 각 10개 보존 |
| validateFieldDefinition, validateFieldCatalog, defaultCompanyVoucherFieldSettings, normalizeCompanyVoucherFieldSettings, effectiveFieldDefinitions, coreFieldByProjection | field-registry.js:118~228 | SmartInput core projection·양식 후보·회사별 필드 설정, stage3 workspace browser fixture | export 이름·입력·출력 유지 | 전표/ACTIVE/mappable/core 필터, 필수필드 보존, 원본 매핑·저장 양식 ID, 기존 전체 export 합집합 검사 |
| settings-input-order.js의 SETTINGS_FIELD_GROUPS, settingsFieldGroupId, sortSettingsFields | field-registry.js:231~253 | SmartInput 설정 화면 정적 import, settings-ux 검사 | 안정 그룹·그룹 안 순서 유지, 구파일 삭제 | 품목/수량·단가·금액/메모 그룹 및 미정 그룹 처리 회귀 |
| parseSettingsInputOrder, reorderSettingsInputOrder, compactSettingsInputOrder, settingsInputOrderPreview | field-registry.js:255~335 | 설정 화면·입력 이동 순서, settings-ux 검사 | 실제 함수 본문 그대로 흡수 | 0·공란·음수·소수·범위, 중복 위치 삽입·순서 압축·편집불가 필드·미리보기 회귀 |
| 기존 field-registry의 회사·actor 해석, seed·registry Promise, 읽기·설정 저장 | 같은 파일:337 이후 | SmartInput 및 reference-refresh-controller | 저장·캐시·회사/전표/세대 키와 변경무효화 본문 유지 | 기준 본문 전체 동일성 및 6영역 세대 계약 회귀 |

## 의미·소비자·실행 경계

- 이름이 같던 text helper의 의미가 달라 합치지 않았다. 정의 계약의 NFKC+trim은 `fieldDefinitionText`로 이름만 바꿨고, registry의 회사·actor 해석은 기존 trim만 유지했다. 예를 들어 정의 설정의 ` Ｃ００１ `은 `C001`로 정규화하되 세션 회사와 actor의 전각 원문은 보존하는 회귀를 추가했다.
- 회사별 필드 설정의 저장 API·Revision 증가·필수필드 보존·원본 seed는 변경하지 않았다. 대용량 `field-catalog-seed.v2.json`은 기존 별도 자산으로 유지했다.
- 전체 활성 소비자 조사에서 다른 앱의 소비자는 없었다. SmartInput의 세 import와 reference-refresh-controller의 한 import는 동일 `field-registry.js?v=0.3.0` URL을 사용해 registry·seed 캐시를 중복 생성하지 않는다.
- reference-refresh-controller는 import 버전 한 곳만 변경했다. 기준정보 조회·갱신·6영역 세대 원자성의 실행 본문은 수정하지 않았다.
- 기존 세 파일은 이미 SmartInput의 초기 graph에 들어 있었다. 새 fetch·DB 읽기·갱신 호출·초기화는 추가하지 않았으며, 문서 필드 정의와 설정 순서의 순수 처리만 기존 registry에 옮겼다. 파일 감소를 실측 성능 개선으로 보고하지 않는다.
- 기존 테스트 세 파일의 import와 stage3 workspace browser fixture의 필드 import를 전환했다. 별도 호환 wrapper와 중복 구현을 남기지 않았다.

## 검증

| 검사 | 결과 |
|---|---|
| `node --check smartinput/field-registry.js` | 통과 |
| `node scripts/test-smartinput-field-settings-v2.mjs` | core·전표 필터, 필수필드·회사 설정 정규화·검토필요 격리, helper 의미 구분 회귀 통과 |
| `node scripts/test-smartinput-initial-input-mapping.mjs` | 실제 UI 매핑 대상·가격/메모 분리·원본·registry 중복 제거·저장 양식 ID 통과 |
| `node scripts/test-smartinput-settings-ux.mjs` | 필드 선택·안정 그룹·입력 순서·편집불가·설정 UI 계약 통과 |
| `node scripts/test-smartinput-reference-generation-v1.mjs` | 6영역 불변 세대·원자 활성화 계약 통과 |
| 함수 본문·export 대조 | 정의 helper의 이름 변경 외 정의 본문 동일, 설정 순서·기존 registry 본문 동일, 전체 public export 합집합 보존 |
| `git diff --check` | 통과 |

명령 결과는 `field-tests.json`에 보존했다. 브라우저의 회사별 IndexedDB 실제 저장이나 호스트 실행까지 이 Node 검사의 통과로 확대하지 않는다. 사용자 데이터 변경, Git stage·commit·배포는 이 담당 범위에서 수행하지 않았다.

소스 복구 시 구파일과 소비자 import를 기준 버전으로 함께 되돌리며 DB·사용자 필드 설정·기준정보 세대·확정 이력은 삭제하거나 복원하지 않는다.