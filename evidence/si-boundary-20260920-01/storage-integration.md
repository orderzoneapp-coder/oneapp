# SmartInput 저장·복구 역할 통합 근거

- 작업 ID: SI-BOUNDARY-20260920-01
- 기준: 21eaf44d50883c68f6c40a6eca9d368df1eff09f
- 대상 명세: docs/SI-BOUNDARY-20260920-01.md (v1.5)
- 범위: 자동저장 journal·저장 조정과 견적 조회 캐시를 기존 smartinput-data-store.js에 실제 흡수했다. DB·데이터·권한·계산 규칙은 변경하지 않았다.
- 상태: 저장 영역 소스 통합과 아래 Node 회귀 통과. 전체 앱·브라우저·성능·배포 판정은 해당 통합 보고서에서 별도 확인한다.

## 실제 통합 대응표

| 기존 파일·함수 | 최종 위치·소유 | 소비자·로딩 | 유지·삭제 | 검증 근거 |
|---|---|---|---|---|
| draft-save-coordinator.js: AUTOSAVE_JOURNAL_SCHEMA, createAutosaveDocumentKey, createAutosavePatch, applyAutosavePatch | smartinput-data-store.js:6~73, 자동저장 journal 규칙 | SmartInput 초기 import와 자동저장·복구 검사 | 구현 본문 그대로 흡수, 구파일 삭제 | journal 패치·복구·compaction 검사 및 기준 함수 본문 동일성 |
| draft-save-coordinator.js: recoverAutosaveDocuments, createDraftSaveCoordinator 및 내부 보조 | smartinput-data-store.js:75~239, 문서별 저장 순서·flush | SmartInput 초기 import, browser-e2e의 journal 복구 조회, 저장 동시성 검사 | 구현 본문 그대로 흡수, 구파일 삭제 | 진행 중 후속 commit 대기, flush 시작 이후 편집, 실패 재시도, 다른 문서, 오래된 ACK 등 6개 경합 검사 |
| estimate-read-cache.js: ESTIMATE_SUMMARY_SCHEMA, ESTIMATE_SUMMARY_PREFIX, READ_STATE, estimateSummaryKey, projectEstimateSummary | smartinput-data-store.js:244~293, 목록 projection | 동일 datastore의 견적 writer·목록 조회, Node 읽기 검사 | 구현 본문 그대로 흡수, 구파일 삭제 | 원본 미변경, 본문·사진 제외, 미확정 회사·Revision, ID·회사 키 구분 |
| estimate-read-cache.js: estimateReadKey, createEstimateReadCache 및 내부 보조 | smartinput-data-store.js:295~433, 불변 읽기 캐시 | datastore의 기존 단일 cache instance, Node 읽기 검사 | 구현 본문 그대로 흡수, 구파일 삭제 | 읽기 상태·dedupe·timeout·취소·늦은 결과·Revision·회사·선택범위·LRU 등 기존 23개 검사 |
| smartinput-data-store.js의 Repository 본문 | 같은 파일:435 이후 | SmartInput, field-registry, reference-generation-repository, reference-refresh-controller | DB v5·store·저장키·journal·CAS·transaction·복구 정책 유지 | 첫 import 제거 외 Repository 본문 기준 동일성, 견적 묶음 원자성·rollback 및 6영역 세대 계약 검사 |

## 로딩·소비자 전환

- smartinput-data-store.js가 두 작은 파일을 import하던/별도로 사용하던 경로를 없앴고, 이 범위의 추적 파일은 2개 줄었다. 업무 기능이나 선택 로딩 범위를 새로 추가하지 않았다.
- SmartInput의 기존 datastore import와 journal import는 같은 `smartinput-data-store.js?v=0.15.0` URL을 사용한다. main의 import 전환은 본체 담당자가 수행했다.
- field-registry.js, reference-generation-repository.js, reference-refresh-controller.js의 datastore import를 기존 0.7.0에서 0.15.0으로 맞췄다. browser-e2e의 journal 조회도 같은 버전을 사용한다.
- 기존 `estimateReadCache` 인스턴스·`smartinput-read-invalidation-v1` BroadcastChannel과 다른 탭 무효화는 유지했다. 새로운 캐시 인스턴스나 저장소 초기화는 추가하지 않았다.
- 두 구파일의 활성 import는 남기지 않았다. Node 전용 검사 세 파일은 import 경로만 바꿨고, Stage 4 CI의 감시 경로를 실제 소유 파일로 바꿨다. 역사적 evidence·과거 문서 내용은 당시 상태의 기록으로 유지한다.
- 모듈 합치기로 줄어든 파일 수를 속도 개선으로 판정하지 않는다. 실제 브라우저 전후 수치는 전체 성능 보고서에서 판정한다.

## 실행한 검증

| 검사 | 결과 |
|---|---|
| `node --check smartinput/smartinput-data-store.js` | 통과 |
| `node scripts/test-smartinput-draft-save-coordinator.mjs` | journal·자동저장 통과, 포함된 save-races 6/6 통과 |
| `node scripts/test-smartinput-save-races.mjs` | 저장 순서·flush·실패 재시도·ACK 경합 6/6 통과 |
| `node scripts/test-smartinput-lazy-read.mjs` | 캐시 회귀 23/23 통과 |
| `node scripts/test-smartinput-estimate-bundle-atomicity.mjs` | 기존값·missing 조건·묶음 rollback 통과 |
| `node scripts/test-smartinput-reference-generation-v1.mjs` | 6영역 불변 세대·원자 활성화 계약 통과 |
| 기준 모듈 전체 본문 비교 | 줄바꿈을 정규화한 journal·cache·Repository 본문이 기준과 동일 |
| `git diff --check` | 통과 |

실행 결과는 `storage-tests.json`에 보존했다. Node의 기존 MODULE_TYPELESS_PACKAGE_JSON 경고는 관찰됐으며, 이를 이유로 범위 밖 package 설정을 바꾸지 않았다. 위 검사는 앱 실행·실제 IndexedDB 브라우저 transaction·호스트 이동 검증을 대신하지 않는다.

## 복구 경계

소스 복구 시 이 변경의 삭제 파일·기존 import·캐시 버전을 함께 복원한다. 기준 커밋의 해당 파일이 복구 원본이며 사용자 DB·저장 자료·확정 Revision·접수기록을 삭제하거나 되돌리지 않는다. 기존 독립 견적 reader와 DB v5 및 읽기 전용 복구 정책은 보존한다. 이 담당 범위에서 Git stage·commit·배포와 사용자 데이터 변경은 수행하지 않았다.