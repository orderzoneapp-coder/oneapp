# ORDER IN Stage 4 — 다전표 분리·편집 개발명세

기준: Stage 1~3 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

하나의 원문에 여러 거래처·여러 주문이 포함된 실제 입력을 자동 분리하고, 관리자가 전표 분할·병합·행 이동·거래처 변경 후 각 전표를 독립 주문으로 확정하게 한다.

## B. 선행조건

- Stage 3 단일전표 전 과정과 원자 commit 승인
- 결정형 automatic/split/merge key 계약 승인
- 다전표 익명 fixture: 명확 분리, 모호 경계, 동일 품목 반복 포함

## C. 허용범위

- 텍스트 원문의 자동 segment proposal
- 전표 카드 목록과 선택 전표 3단계 검토
- `전표 나누기`, `전표 합치기`, `행 이동`, `거래처 변경`
- 전표별 독립 검증·확정·재시도·실패 격리
- 분할·병합 event와 lineage 보존

## D. 금지범위

- OCR/이미지/파일 Clipboard
- mapping 학습 write
- 전체 batch 일괄 성공을 강제하는 거대 transaction
- 확정 주문의 분할·병합
- Purchase/Sales/Quote Adapter
- Collector 기능 이동

## E. 실제 소스 분석

현 `smartparser/source-parser.js`·`smartparser/parser-orchestrator.js`는 한 message를 한 parse result로 다루고 customer resolver도 sender/source 단위다. `parser-ui.js`는 문서 목록·lineage·전표별 상태가 없다. Stage 3 engine은 단일 document를 전제로 하므로 분리 알고리즘과 편집 command는 별도 모듈이어야 한다.

## F. Before → After

| Before | After |
|---|---|
| 복수 주문 원문은 오분류 또는 수동 재입력 | 자동분리 후보 + 관리자 편집 |
| 원문 전체에 customer 하나 | document별 customer evidence |
| source key 하나 | occurrence 아래 결정형 document/line key 여러 개 |
| 전체 진행상태 하나 | 전표별 EXTRACT/MATCH/READY/COMMITTED |

## G. 데이터 계약

- `segmentVersion`, `segmentStrategy`, `sourceRanges[]`, `segmentFingerprint`를 document에 저장한다.
- document lineage: `parentDocumentIds[]`, `operationType=AUTO|SPLIT|MERGE|MOVE`, `supersededByDocumentIds[]`.
- split로 교체된 document는 `EXCLUDED`+reason, merge source는 `MERGED`로 남긴다. 둘 다 삭제하지 않고 최종 주문으로 commit할 수 없다.
- 행 이동은 새 target `sourceLineKey`를 결정형으로 만들고 source line을 `MOVED`로 남긴다.
- 같은 논리 split boundary/merge set은 PC·순서와 무관하게 같은 key다.
- batch는 session 집계일 뿐 ORDER 생성 원자 단위가 아니다. 전표별 결과를 보존한다.

## H. 함수·API 상세

신규 `orderq/intake-segmentation.js`:

- `proposeDocumentSegments({sourceText, parsedLines, customerHints})`
- `canonicalizeSegmentBoundary(boundary)`
- `validateSegmentCoverage(sourceParts, documents)` — 중복·유실 source range 검증

`intake-engine.js` 확장:

- `applyAutomaticSegments(command)`
- `splitIntakeDocument({documentId, expectedRevision, boundary, actor})`
- `mergeIntakeDocuments({documentIds, expectedRevisions, actor})`
- `moveIntakeLine({lineId, fromDocumentId, toDocumentId, expectedRevisions})`
- `changeDocumentCustomer(command)`
- `commitReadyDocuments({sessionId, documentIds, idempotencyByDocument})`

각 편집 command는 관련 documents/lines/events를 한 transaction에서 변경하고 coverage invariant를 재검사한다. `commitReadyDocuments`는 document별 command를 순차/격리 실행하여 `{successes, duplicates, failures}`를 반환한다.

## I. 파일별 변경명세

신규:

- `orderq/intake-segmentation.js`
- `scripts/test-orderq-stage4-multi-document.mjs`
- `scripts/test-orderq-stage4-browser.html`

수정:

- `orderq/intake-engine.js`, `intake-repository.js` — 편집 command/lineage
- `orderq/intake-workbench.js`, `.css`, `parser.html` — 전표 목록·편집 UI
- `orderq/smartparser/parser-orchestrator.js`, `smartparser/customer-resolver.js` — segment별 evidence 반환
- `orderq/intake-identity.js` — 승인된 split/merge key helper 사용
- workflow — Stage 4 테스트

## J. UI 계약

좌측은 전표 카드(`거래처`, `행수`, `확인 필요`, `상태`), 우측은 선택 전표의 3단계다. 주요 편집은 업무용어로 `[전표 나누기] [선택 전표 합치기] [다른 전표로 이동] [거래처 변경]`이다. source key/revision은 상세정보에만 표시한다. 일부 전표 실패 시 성공·실패를 분리해 다음 행동을 제공한다.

## K. 상태전이

- auto document: `EXTRACTION_REVIEW`
- split source: `EXCLUDED`, merge source: `MERGED`, children/target: `EXTRACTION_REVIEW`
- line move/customer change: affected documents를 최소 `EXTRACTION_REVIEW` 또는 `MATCH_REVIEW`로 되돌리고 상위 확인 무효화
- 각 document: Stage 3 상태전이 독립 적용
- session COMMITTED는 active documents가 모두 COMMITTED 또는 명시적 EXCLUDED/MERGED일 때만

## L. 오류·충돌·롤백

- source range overlap/gap: `ORDERQ_INTAKE_SEGMENT_COVERAGE_INVALID`
- committed/superseded document 편집: `ORDERQ_INTAKE_DOCUMENT_EDIT_FORBIDDEN`
- 다른 session 문서 merge: 거부
- stale revision: 관련 편집 전체 rollback
- split 후 빈 document/line: 거부
- batch commit 중 한 document 실패: 그 document만 불변, 다른 성공 결과는 보존
- 동일 document final key에 상이 payload: conflict

## M. Given / When / Then 계약 테스트

1. Given 거래처 3개 원문, When auto segment, Then document 3개와 source range 100% coverage.
2. Given A/B 동일 원문 occurrence, When auto segment, Then document key 집합 동일.
3. Given 같은 boundary split retry, Then child/event 무증가.
4. Given merge input 순서 반대, Then merge key 동일.
5. Given line move, Then 원문 lineage 유실 0, 두 document confirmation 무효.
6. Given customer change, Then 해당 document matching만 재검토.
7. Given stale concurrent split, Then conflict와 전체 Store digest 불변.
8. Given 3 ready documents 중 1 payload conflict, When commit, Then 2 success/1 failure 격리.
9. Given committed document, When split, Then 거부되고 ORDER 불변.
10. Given 원문 동일·다른 occurrence, Then 전표 key와 주문은 서로 다름.

## N. 회귀 테스트

- `scripts/test-orderq-stage4-multi-document.mjs`
- Stage 1~3 신규 테스트
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-orderq-order-workflow.mjs`
- `scripts/test-orderq-vnext-cloud-contract.mjs`
- client safety/repository validation/diff check
- 실제 Chromium split/merge/move/partial failure/A-B key convergence

## O. 완료증거

- source offset coverage·lineage graph JSON
- A/B key set digest
- 편집 전후 document/line/event canonical bundle
- stale/failure rollback digest
- 3문서 부분성공 최종 ORDER/Queue count
- 실제 UI·console 0

## P. 다음 Stage Gate

Stage 5는 텍스트 다전표가 결정형으로 수렴하고, source 유실·중복 0, 편집 rollback, 전표별 commit 격리가 승인된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- 자동 분리는 후보이며 관리자 편집을 허용한다.
- 이미 확정된 주문을 Intake 분할로 수정하지 않는다.
- 자동분리 confidence가 낮아도 원문을 버리지 않고 한 전표 후보+확인필요로 보존한다.
- 거대 batch transaction으로 성공 전표까지 되돌리지 않는다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 4 MULTI DOCUMENT] 승인 Stage 1~3 main에서 전용 branch/worktree를 만들고 ORDER_IN_STAGE4_MULTI_DOCUMENT_SPEC.md 및 상위 문서를 읽어라. 텍스트 다전표 자동분리 후보, 전표 나누기/합치기/행 이동/거래처 변경, 결정형 identity·lineage, 전표별 독립 commit만 구현한다. OCR·Mapping write·다른 document type·Collector·확정주문 수정은 금지한다. source coverage, A/B key 수렴, stale rollback, 부분성공 Chromium 증거로 검증 요청하고 승인 전 병합·Stage 5·배포를 보류하라.
```
