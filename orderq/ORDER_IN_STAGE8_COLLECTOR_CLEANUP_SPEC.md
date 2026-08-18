# ORDER IN Stage 8 — Collector 책임 정리 개발명세

기준: Stage 1~7 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

ORDER IN·ORDER Q 입력 경로가 완성된 뒤 Collector에서 현재 주문처리와 겹치는 진입점·용어를 제거하고, Collector를 과거 기초자료 수집·롤백·재계산 작업대로 명확히 한정한다.

## B. 선행조건

- Stage 3~7 실사용 경로 승인 및 navigation 존재
- Collector 실제 기능 inventory와 운영 사용 여부 확인
- 과거 판매/구매/주문/재고 fixture 및 기존 batch/rollback evidence 확보

## C. 허용범위

- Collector 상위 탭·문구·CTA·영향도 안내 정리
- 현재 주문 입력은 ORDER IN, 코드확정 구조화 주문은 ORDER Q Import로 연결
- 과거 KAKAO_HISTORY/Excel 수집, matcher evidence, 수집이력·rollback 유지
- 데이터유형별 요약·기간·샘플·필수누락 표시
- legacy 운영입력 UI의 안전한 redirect/deprecation 안내

## D. 금지범위

- Collector batch/import/rollback/fingerprint 핵심 알고리즘 변경
- 과거자료 삭제·자동 재수집·자동 rollback
- 수집이력 `복원` 신규 구현
- 재고현황 영향도를 판매/구매와 동일하게 표시
- ORDER IN/ORDER Q 기능 복제
- DataOps·MerchOps·Master 재설계

## E. 실제 소스 분석

- `collector-ui.js`는 Excel/text 분석, prepared/mismatch/work summary/snapshot, settings, rebuild, history rollback, fulfillment link, parser evidence를 한 화면에서 orchestration한다.
- `collector-smartparser-review.js`는 `KAKAO_HISTORY` 과거자료의 4단계 review와 `commitPreparedImportV2()`를 사용한다. 운영 ORDER IN이 생겨도 과거자료 계약 때문에 즉시 삭제할 수 없다.
- `collector-contracts.js`는 `FINGERPRINT_VERSION=2`, row fingerprint, commit/rollback/rebuild 계약을 가진다.
- `history-collector/history-repository.js`, `history-collector/collector-importer.js` 계열은 batch 이력·matcher link·evidence의 권위다.
- 현재 전역 KPI/연결표는 주문·판매·구매·재고를 한 화면에 섞어 주문자료가 없는데도 `미출고/EXCLUDED` 같은 결과를 오해하게 할 수 있다.

## F. Before → After

| Before | After |
|---|---|
| 현재 주문과 과거 기초자료 진입 혼재 | 운영 주문은 ORDER IN/Q, Collector는 기초자료 |
| 전역 KPI·matcher 결과 상시 노출 | 자료 탭별 요약, 준비조건 충족 때만 매칭분석 |
| `수집 대기`, `판별 100%`, SHA 전면 | `분석 완료·아직 저장되지 않음`, 자료유형, 기간, 건수, 이상, 영향 |
| 내부 status/technical detail 노출 | 기술정보 상세로 이동 |

## G. 데이터 계약

신규 DB/Store/업무 status 없음. 기존 batch/row fingerprint/rollback 계약을 그대로 사용한다.

자료별 영향 문구를 UI·계약 테스트로 고정한다.

- 판매현황: 과거 판매이력, 현재 재고·채권 영향 없음
- 구매현황: 과거 구매이력, 현재 재고·채무 영향 없음
- 주문현황: 과거 주문이력, 현재 운영 주문 생성 안 함
- 거래처원장: 과거 거래이력, 현재 잔액 확정 안 함
- 재고현황: 기초재고로 등록되어 ORDER Q 현재고 기준에 영향

일반 탭 상태는 `자료없음 → 분석완료·미수집 → 수집완료`; 매칭은 `분석대기 → 분석중 → 확인필요 → 분석완료`만 쓴다.

## H. 함수·API 상세

`collector-ui.js`를 역할별 view helper로 분리할 수 있다.

- `renderSourceTabSummary(sourceType, analysis)`
- `buildImportImpactMessage(sourceType)`
- `renderPreparedImportPreview({period, rowCount, customerCount, productCount, missing, samples, columnMappings})`
- `getMatchingReadiness(snapshot)` — order/sales 부족 이유와 이동 CTA
- `renderMatchingAnalysis(snapshot)` — readiness 충족 때만
- `renderCollectorHistory(batches)` — 조회/상세/rollback

기존 `analyzeExcelFile`, `analyzeHistoricalText`, `commitPreparedImportV2`, `rollbackImportBatchByContract`, `rebuildWhenReady` 호출 순서·payload는 바꾸지 않는다. ORDER IN/Import 이동은 navigation뿐이며 background migration을 실행하지 않는다.

## I. 파일별 변경명세

수정 후보:

- `orderq/collector.html` — 탭·업무문구·preview drawer·CTA
- `orderq/collector-ui.js` — 전역 렌더를 탭별 렌더로 분리
- `orderq/collector.css` — 목록·상태·상세정보
- `orderq/collector-smartparser-review.js` — `과거 주문자료` 맥락 명시
- `orderq/photo-bulk-actions.js`/`photo-ocr.js` — 현재 주문 CTA는 ORDER IN 안내, 과거 기능 유지
- `orderq/index.html`, `orderq/operations.html`, `orderq/parser.html`, `orderq/workflow-guide.js` — 역할 설명과 route
- `scripts/test-orderq-collector-contracts.mjs`
- `scripts/test-orderq-history-collector.mjs`
- 신규 `scripts/test-orderq-stage8-collector-cleanup.mjs`, browser fixture

core importer/repository는 표시용 summary에 꼭 필요한 read-only helper 외 수정 금지다.

## J. UI 계약

상위 탭:

`주문자료 | 판매현황 | 구매현황 | 기초재고 | 거래처원장 | 매칭분석 | 수집이력`.

분석 카드가 답해야 하는 다섯 질문:

1. 무슨 자료인가
2. 어느 기간인가
3. 얼마나 들어왔는가
4. 이상이 있는가
5. 확정하면 무엇에 영향을 주는가

행 예시: `구매현황 | 기초_구매.xlsx | 7/1~7/31 | 8,153행 | 필수항목 정상 | [내용 확인] [제외]`. 내용 확인은 거래처/상품 수, 누락, 샘플 5~10행, 열 mapping을 보여준다. SHA는 상세에만 둔다. 매칭 준비자료가 없으면 비활성 버튼 대신 해당 자료 수집 CTA를 표시한다.

## K. 상태전이

분석 후보는 DB 수집 전이며 `분석 완료·아직 저장되지 않음`. `[자료명 수집]` 성공 후만 `수집완료`. 사진/text 후보는 ORDER IN에서 관리자 확정 전 Matcher에 투입하지 않는다. rollback은 기존 batch를 ROLLED_BACK/비활성화하고 재계산하며 복원 상태는 추가하지 않는다.

## L. 오류·충돌·롤백

- 잘못된 파일: `[내용 확인] [해당 탭에서 열기] [제외]`; 임시보관 상태는 만들지 않는다.
- 동일 fileHash active batch: 기존 전체 duplicate skip 유지.
- 거래단위 fingerprint는 현 계약을 임의 변경하지 않는다. rowNo 포함으로 겹치는 재출력 탐지 한계는 별도 후속 분석으로 표시한다.
- 매칭 준비 부족: 오류가 아니라 `분석대기`와 이동 CTA.
- 기존 rollback 실패: transaction 불변·원 batch active 상태 유지.

## M. Given / When / Then 계약 테스트

1. Given 구매 8,153/판매 10,002/주문 0, Then 각 수집완료, 매칭은 `주문자료 없음·분석대기`; EXCLUDED/미출고/출고연결/파서사전 후보는 아예 렌더 0.
2. Given 구매 분석 전, Then 기간/행수/정상/영향문구와 내용 확인, DB batch 0.
3. Given 판매 확정, Then 과거 판매 store만 증가, 현재 Inventory/receivable 변화 0.
4. Given 구매 확정, Then 과거 구매 store만 증가, 현재 Inventory/payable 변화 0.
5. Given 재고현황 확정, Then Snapshot 영향 경고 후 현행 계약대로 기준 반영.
6. Given 주문·판매 모두 있음, Then 자동매칭 1회, 확인필요 우선.
7. Given 주문 없는 음수 판매, Then 판매 반품·취소에는 표시, 매칭결과에는 사용자 노출 0.
8. Given 동일 fileHash, Then duplicate skip 무증가.
9. Given batch rollback, Then 기존 contract 결과와 재계산 동일.
10. Given 현재 주문 사진 CTA, Then ORDER IN으로 이동하고 Collector import 자동실행 0.

## N. 회귀 테스트

- `scripts/test-orderq-stage8-collector-cleanup.mjs`
- `scripts/test-orderq-collector-contracts.mjs`
- `scripts/test-orderq-history-collector.mjs`
- `scripts/test-orderq-smartparser.mjs`
- Stage 1~7 테스트
- `scripts/test-orderq-user-flow.mjs`
- client safety/repository validation/diff check
- 실제 Chromium 탭별 30초 시나리오·8,153/10,002/0 fixture·rollback

## O. 완료증거

- URL/탭별 사용자 첫 행동과 Before/After 캡처
- 자료유형별 영향문구 DOM/contract
- 8,153+10,002+0 렌더·DB 증거
- contents preview sample/missing/mapping
- existing batch commit/duplicate/rollback canonical 비교
- ORDER IN/ORDER Q navigation과 자동 mutation 0

## P. 다음 Stage Gate

Stage 8은 본 로드맵의 마지막 구현단계다. 완료 후 운영 배포는 별도 승인으로 수행하며 다음을 요구한다: 전체 Stage 1~8 회귀, Collector 실제 기초자료 shadow, rollback drill, 사용자 가이드 갱신, 운영 backup, URL/권한/kill switch 확인.

## Q. 결정사항·중단조건

- Collector는 삭제하지 않고 기초자료 수집으로 정체성을 고정한다.
- `복원`은 이번 범위에 없다.
- 과거 KAKAO_HISTORY review는 운영 ORDER IN과 구분해 유지한다.
- core fingerprint 변경이 필요하면 UX 정리와 분리한 후속 설계/PR로 처리한다.
- 운영자료 자동 migration·삭제가 필요해지면 중단하고 사용자 승인을 받는다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 8 COLLECTOR CLEANUP] 승인 Stage 1~7 main에서 전용 branch/worktree를 만들고 ORDER_IN_STAGE8_COLLECTOR_CLEANUP_SPEC.md와 상위 문서를 읽어라. Collector를 과거 기초자료 수집·매칭·수집이력/rollback 작업대로 정리하고 현재 주문은 ORDER IN, code 확정 구조화 주문은 ORDER Q Import로 안내하라. 기존 importer/repository/fingerprint/rollback 알고리즘과 운영자료는 변경하지 않는다. 탭별 영향문구, 내용 확인, 준비조건 CTA, 8,153 구매+10,002 판매+주문0, duplicate/rollback 실제 증거로 검증 요청하고 승인 전 병합·운영배포를 보류하라.
```
