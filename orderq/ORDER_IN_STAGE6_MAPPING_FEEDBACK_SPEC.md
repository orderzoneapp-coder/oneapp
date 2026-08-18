# ORDER IN Stage 6 — Mapping Feedback·변경이력 개발명세

기준: Stage 1~5 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

관리자가 주문 검토 중 확정한 거래처·상품 매핑을 근거·버전·변경이력과 함께 학습시켜 다음 주문 후보 정확도를 높인다. 관리자 확정 전에는 mapping을 쓰지 않는다.

## B. 선행조건

- text/photo Intake review와 temp identity 승인
- 기존 mapping Store/index/Cloud payload와 candidate score 기준선 확보
- 실제 동의어·오매핑·Master 변경 fixture 승인

## C. 허용범위

- `[매칭 완료]` 시 관리자 확정과 추천값 차이에 따른 mapping 생성·수정·해제
- product/customer mapping evidence와 append-only event
- 후보 우선순위의 명시적 관리자 mapping 최우선 적용
- stale revision·충돌·A/B 수렴
- 확인필요 우선 검토 UI

## D. 금지범위

- 분석 후보·OCR 결과만으로 자동 학습
- 임시상품을 Master mapping으로 저장
- 과거 확정 주문 소급 재작성
- 자동 후보 하나를 무조건 확정
- Master 자체 상품정보 수정
- Collector 전체 mapping 재설계

## E. 실제 소스 분석

- `smartparser/candidate-generator.js`는 mapping/customer history/master를 조합하고 `useCount` bonus를 사용한다.
- `smartparser/matching-engine.js`는 후보 score와 판정을 수행한다.
- `smartparser/parser-repository.recordProductMapping()`은 productMappings upsert, mappingEvents append, syncQueue 2행을 만든다.
- 현재 parser UI는 행별 `remember mapping` 흐름이 있으나 Intake의 `MATCH_CONFIRMED`와 원자적으로 결합되지 않는다.
- M7 `mappingEvents`는 임시상품↔Master 연결 이력도 소유하므로 eventType/aggregateType을 구분해야 한다.

## F. Before → After

| Before | After |
|---|---|
| parser 행에서 mapping write 가능 | 관리자 `매칭 완료` 뒤 명시적 feedback |
| before/after·source evidence 불충분 | revision, actor/time/reason, before/after, source line 보존 |
| 임시상품과 미매칭 혼재 | TEMPORARY_CONFIRMED는 학습 제외 |
| 후보 우선순위 암묵적 | 관리자 mapping→source-specific code→history→Master 순서 고정 |

## G. 데이터 계약

기존 `productMappings`를 additive 확장:

- `mappingKind=TEXT_ALIAS|EXTERNAL_CODE`
- `sourceId`, `normalizedSourceText`, `sourceCode`, `productId`
- `status=ACTIVE|INACTIVE`, `revision`
- `confirmedBy`, `confirmedAt`, `reasonCode`, `reasonNote`
- `sourceIntakeSessionId`, `sourceDocumentId`, `sourceLineId`
- `normalizationVersion`, `fingerprintVersion`

`mappingEvents`는 `aggregateType=PRODUCT_MAPPING|CUSTOMER_MAPPING|TEMP_PRODUCT_LINK`를 구분하고 before/after snapshot을 append-only 저장한다. 숫자/문자열 `0` code를 공란과 구분한다. Cloud sync는 localOnly 정책과 현행 entity contract를 따른다.

## H. 함수·API 상세

`smartparser/parser-repository.js` 또는 신규 `mapping-feedback-repository.js`:

- `recordProductMappingDecision(command)` — expected revision, Master product 존재, source evidence 검증
- `deactivateProductMapping(command)`
- `recordCustomerMappingDecision(command)`
- `getActiveMappingCandidates(query)`
- `getMappingHistory(aggregateId)`

`intake-engine.confirmMatching()`은 먼저 모든 line/customer 확인을 검증하고 추천값과 최종 Grid 값을 비교한다. Master 상품으로 확정된 `ACCEPTED_AUTO` 또는 `CORRECTED` 행은 mapping decision을 자동 기록한다. `TEMPORARY`, `REMOVED`, `EXCLUDED`는 IntakeEvent만 남기고 productMappings를 만들지 않는다. Intake confirmation과 mapping writes가 같은 DB transaction에서 성공하거나 모두 rollback되어야 한다.

후보 우선순위:

1. 동일 source의 ACTIVE 관리자 mapping
2. 구조화 external code mapping
3. 승인 history/candidate
4. Master exact/normalized search
5. unresolved

## I. 파일별 변경명세

신규:

- `orderq/mapping-feedback-repository.js`(기존 repository에 안전히 넣기 어려운 경우)
- `scripts/test-orderq-stage6-mapping-feedback.mjs`
- `scripts/test-orderq-stage6-browser.html`

수정:

- `orderq/smartparser/candidate-generator.js`, `smartparser/matching-engine.js` — 명시 우선순위
- `orderq/smartparser/parser-repository.js` — compatibility wrapper/allowlist
- `orderq/intake-engine.js`, `intake-workbench.js` — confirmation과 feedback UI
- `orderq/orderq-sync-engine.js`, `orderq-cloud.gs` — 기존 mapping entity 선택필드 보존
- `orderq/product-line-common.js` — 후보 reason 표시 helper만
- workflow — Stage 6 테스트

## J. UI 계약

매칭 수정 화면은 `확인 필요`를 먼저 보여주고 후보 이유(`관리자가 이전에 연결`, `상품코드 일치`, `Master 검색 후보`)를 쉬운 말로 표시한다. 행별 `매핑저장` checkbox는 두지 않는다. `[매칭 완료]` 시 추천과 최종값의 차이를 시스템이 기록하고, 임시상품·삭제·제외는 학습하지 않는다. mapping 해제는 관리자 상세 화면에서 영향과 이력을 확인 후 실행한다.

## K. 상태전이

mapping: `없음 → ACTIVE → INACTIVE`; 동일 source identity를 다른 product로 바꾸면 이전 mapping INACTIVE event 후 새 revision ACTIVE. 물리 삭제·과거 event 수정 금지. Intake line은 mapping 저장 여부와 무관하게 관리자 확인으로 `CONFIRMED` 가능하다.

## L. 오류·충돌·롤백

- stale mapping revision: `ORDERQ_MAPPING_REVISION_CONFLICT`
- 같은 source identity의 active product 충돌: 자동 덮어쓰기 금지, 관리자 재확인
- 없는/비활성 Master target: 거부
- temp product mapping write: `ORDERQ_MAPPING_TEMPORARY_TARGET_FORBIDDEN`
- confirmation transaction mapping 중간 실패: Intake MATCH_CONFIRMED와 mapping/event/queue 모두 rollback
- Cloud same revision/different content: conflict 표면화

## M. Given / When / Then 계약 테스트

1. Given 미확정 후보, When 분석만 완료, Then mapping Store 증가 0.
2. Given Master 선택, When 매칭 완료, Then 별도 checkbox 없이 mapping/event/queue 각 계약 수만큼 생성.
3. Given 같은 표현 다음 주문, Then 관리자 mapping이 1순위이며 reason 표시.
4. Given 추천과 같은 Master를 확정, Then `ACCEPTED_AUTO` decision과 최신 관리자 확정 근거가 계약대로 기록된다.
5. Given TEMPORARY_CONFIRMED, Then mapping option/row 0.
6. Given A/B stale update, Then 한쪽 성공·한쪽 revision conflict·pull 수렴.
7. Given target Master 비활성, Then 확인 거부 또는 새 선택 요구.
8. Given mapping 중간 실패, Then Intake confirmation 포함 전체 rollback.
9. Given mapping 해제, Then 과거 주문 불변, 다음 후보에서 제외.
10. Given source code `'0'`/숫자 0/공란, Then 0은 동일 canonical code, 공란은 별도.

## N. 회귀 테스트

- `scripts/test-orderq-stage6-mapping-feedback.mjs`
- Stage 1~5 테스트
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-orderq-manual-master-search.mjs`
- `scripts/test-orderq-m7-common-products.mjs`
- `scripts/test-orderq-vnext-cloud-contract.mjs`
- client safety/repository validation/diff check
- 실제 Chromium next-order candidate/A-B conflict/temp exclusion

## O. 완료증거

- 후보 순위와 reason fixture 표
- mapping before/after/event/queue canonical JSON
- 분석만 했을 때 write 0
- temp exclusion UI/DB
- stale conflict·transaction rollback digest
- Cloud A/B 수렴

## P. 다음 Stage Gate

Stage 7은 관리자 확인 전 mapping write 0, 임시상품 학습 0, 변경이력·해제·충돌·Cloud 수렴이 승인된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- mapping은 편의를 위한 근거이지 Master 변경이 아니다.
- 사용자 확인과 학습 동의를 분리한다.
- 기존 mapping store로 external code를 안전히 구분할 수 없으면 Stage 7 전에 신규 schema 필요성을 별도 승인받는다.
- 회귀 테스트 파일은 구현 착수 시 `rg --files scripts`로 실제 이름을 확정하고 존재하지 않는 이름을 만들지 않는다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 6 MAPPING FEEDBACK] 승인 Stage 1~5 main에서 전용 branch/worktree를 만들고 ORDER_IN_STAGE6_MAPPING_FEEDBACK_SPEC.md 및 상위 문서를 읽어라. 관리자 매칭 완료 후 선택한 product/customer mapping feedback, before/after event, 우선순위, 해제, revision/Cloud 충돌만 구현한다. 분석만으로 자동학습, 임시상품 mapping, Master 수정, 과거주문 재작성은 금지한다. write-zero, next-order 후보, transaction rollback, A/B 수렴 실제 증거로 검증 요청하고 승인 전 병합·Stage 7·배포를 보류하라.
```
