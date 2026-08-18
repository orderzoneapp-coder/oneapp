# ORDER IN Stage 5 — Clipboard·사진 OCR 통합 개발명세

기준: Stage 1~4 승인 HEAD

상위: [아키텍처](./ORDER_IN_ORDER_Q_INPUT_ARCHITECTURE_SPEC.md) · [로드맵](./ORDER_IN_ORDER_Q_IMPLEMENTATION_ROADMAP.md)

## A. 목적

ORDER IN 한 진입점에서 텍스트 붙여넣기, 이미지 붙여넣기, 파일선택을 구분하고, 사진 주문은 OCR 후보→관리자 수정→기존 3단계 Intake로 처리한다.

## B. 선행조건

- 다전표 텍스트 흐름 승인
- 이미지 저장 용량·브라우저 quota·개인정보 보존정책 결정
- Tesseract load 실패/오프라인/저신뢰 실제 fixture 확보

## C. 허용범위

- Clipboard item MIME routing
- 이미지 file/paste/drag capture
- 명시적 OCR 시작·취소·재시도
- OCR text·confidence·source image evidence 저장
- OCR 결과를 Stage 4 segmentation 입력으로 연결
- 원문 이미지와 추출 텍스트 병렬 확인 UI

## D. 금지범위

- 사진 분석만으로 주문 자동확정
- 모든 필기체 100% 자동처리를 완료조건으로 설정
- browser clipboard 상시 감시
- Collector 과거자료 기능 삭제
- 외부 OCR 서버 신규 도입·원본 무단 업로드
- Mapping 자동학습

## E. 실제 소스 분석

- `photo-ocr.js`는 `photoFiles`, `photoPanelVisible`, `recognizePhoto()`를 소유하고 paste를 `#photoCollector`가 보일 때만 받으며 Tesseract를 호출한다.
- `photo-bulk-actions.js`는 Collector의 사진 batch/decorator이고 collector review module을 동적 로드한다.
- 현 Clipboard와 OCR은 Collector 맥락에 묶여 있고 ORDER IN IntakeSession/source part 계약을 사용하지 않는다.
- Stage 5는 OCR engine만 안전하게 공통화하되 과거 collector 경로를 즉시 삭제하지 않는다.

## F. Before → After

| Before | After |
|---|---|
| 사진 기능이 Collector에 결합 | ORDER IN 입력 종류로 진입 |
| 붙여넣기 맥락 의존 | MIME별 명시 routing |
| OCR 결과와 주문 후보 경계 약함 | OCR 후보→관리자 수정→주문자료 확정 |
| source image provenance 약함 | source part/hash/size/type/OCR evidence 보존 |

## G. 데이터 계약

`IntakeSourcePart` 이미지 필드:

- `sourcePartType=IMAGE`, `mimeType`, `byteLength`, `rawFingerprint`
- `binaryBase64`와 `byteLength`를 IndexedDB에 로컬 저장하며 중앙 Sheet에는 전송하지 않음
- `ocrStatus=NOT_STARTED|RUNNING|COMPLETED|FAILED|CANCELLED`
- `ocrEngine`, `ocrEngineVersion`, `ocrLanguage`, `ocrStartedAt`, `ocrCompletedAt`
- `ocrText`, `ocrConfidence`, `ocrBlocks[]`, 오류 code

OCR text는 확정 주문이 아니며 `IntakeDocument` 생성 후에도 source evidence로 불변 보존한다. 편집된 추출 text는 별도 event/payload로 남겨 원 OCR을 덮지 않는다. JSON backup/restore는 `mimeType + binaryBase64 + byteLength + contentHash`까지 검증한다.

## H. 함수·API 상세

신규 `orderq/intake-clipboard.js`:

- `classifyClipboardItems(items)` — TEXT/IMAGE/UNSUPPORTED
- `captureClipboardIntoSession({sessionId, items, actor})`
- `captureFilesIntoSession({sessionId, files, actor})`

신규/공통 `orderq/ocr-engine.js`:

- `recognizeImageSourcePart({blob, language, signal, onProgress})`
- 반환: engine metadata, raw text, confidence, blocks

`intake-engine.js` 확장:

- `startOcr(command)`, `cancelOcr(command)`, `acceptOcrText(command)`
- `analyzeCapturedSources(command)` — accepted text만 parser/segmentation으로 전달

`photo-ocr.js`는 collector가 공통 engine을 소비하도록 최소 adapter화할 수 있으나 collector 저장·확정 계약은 바꾸지 않는다.

## I. 파일별 변경명세

신규:

- `orderq/intake-clipboard.js`
- `orderq/ocr-engine.js`
- `scripts/test-orderq-stage5-clipboard-ocr.mjs`
- `scripts/test-orderq-stage5-browser.html`

수정:

- `orderq/intake-engine.js`, `intake-repository.js` — source part/OCR command
- `orderq/intake-workbench.js`, `.css`, `parser.html` — 통합 capture UI
- `orderq/photo-ocr.js` — 공통 engine adapter(필요한 경우만)
- `orderq/orderq-v7-repository.js` — base64 원본 backup 검증 보강
- workflow — Stage 5 테스트

## J. UI 계약

첫 화면은 `여기에 주문내용 또는 사진을 붙여넣으세요`와 `[파일 선택]`. 입력 후 유형별 chip을 표시한다. 이미지는 썸네일·크기·상태와 `[사진에서 주문내용 추출]` 버튼을 제공한다. OCR 진행률과 취소를 표시하며, 완료 후 원본 옆에 편집 가능한 추출 text를 보여준다. Primary는 `[추출 내용으로 주문 확인]`이다. OCR 완료만으로 `주문자료 수집` 또는 Matcher를 실행하지 않는다.

## K. 상태전이

source part: `CAPTURED → OCR_RUNNING → OCR_COMPLETED → ACCEPTED`, 실패 시 `OCR_FAILED`, 취소 시 `OCR_CANCELLED`. accepted 후 Stage 4/3 document 상태를 따른다. OCR 재실행은 이전 OCR evidence를 event로 보존하고 새 revision을 만든다.

## L. 오류·충돌·롤백

- 지원하지 않는 MIME: `ORDERQ_INTAKE_CLIPBOARD_TYPE_UNSUPPORTED`
- size/quota 초과: 저장 전 차단, 기존 session 불변
- Tesseract load/network 실패: 원 이미지 유지, 수동 text 입력 가능
- OCR cancel: partial text를 확정값으로 사용하지 않음
- 동일 image part 재시도: 같은 raw fingerprint와 occurrence 내 중복 source part 방지
- backup base64/hash/byteLength mismatch: restore 전체 rollback

## M. Given / When / Then 계약 테스트

1. Given text clipboard, When paste, Then TEXT source part와 OCR 0.
2. Given image clipboard/file, Then IMAGE source part byte/hash 보존.
3. Given mixed clipboard, Then 사용자 선택/명시 순서로 source parts 보존.
4. Given OCR success, Then 후보 text만 생성되고 ORDER 0.
5. Given OCR text 수정·수락, Then 원 OCR 불변, 수정 event와 document 생성.
6. Given 저신뢰/오인 행, When 관리자 수정, Then 수정값으로 final ORDER.
7. Given OCR cancel/failure, Then 원이미지 보존·partial order 0.
8. Given 2개 사진에 여러 전표, Then Stage 4 key/coverage 계약 통과.
9. Given backup/restore, Then binaryBase64/contentHash/byteLength/OCR evidence canonical 일치.
10. Given quota 초과, Then Store·event·order 증가 0.

## N. 회귀 테스트

- `scripts/test-orderq-stage5-clipboard-ocr.mjs`
- Stage 1~4 테스트
- `scripts/test-orderq-smartparser.mjs`
- `scripts/test-orderq-history-collector.mjs`
- `scripts/test-orderq-collector-contracts.mjs`
- client safety/repository validation/diff check
- 실제 Chromium paste/file/OCR/cancel/offline/backup console 0

## O. 완료증거

- MIME routing matrix
- source image SHA/size/base64와 JSON backup round-trip
- OCR 원문/수정문/event 비교
- 주문 자동생성 0 및 관리자 확정 후 생성 count
- failure/cancel/quota DB digest
- 여러 사진 다전표 A/B key 수렴

## P. 다음 Stage Gate

Stage 6은 사진·텍스트 모두 같은 Intake flow를 사용하고, OCR 후보가 확정자료와 분리되며, 원본/Blob backup/실패복구가 승인된 뒤에만 착수한다.

## Q. 결정사항·중단조건

- 사진 입력은 이번 범위에서 유지한다.
- 관리자 수정은 필수 경계이며 자동 주문확정은 금지한다.
- 저장 quota가 운영 예상량을 감당하지 못하면 원본 보존기간/외부 object storage를 별도 승인받고 임의 업로드하지 않는다.

## Codex 5.3 착수 명령

```text
[개발][ORDER IN][STAGE 5 CLIPBOARD OCR] 승인 Stage 1~4 main에서 전용 branch/worktree를 만들고 ORDER_IN_STAGE5_CLIPBOARD_OCR_SPEC.md와 상위 문서를 읽어라. ORDER IN의 text/image/file capture, 명시적 OCR, 원본·OCR·수정 evidence, 기존 다전표 flow 연결만 구현한다. OCR 자동확정·외부 무단업로드·Mapping write·Collector 삭제·다른 document type은 금지한다. MIME, quota, cancel/failure, Blob backup, 실제 Chromium 사진→관리자 수정→주문 증거로 검증 요청하고 승인 전 병합·Stage 6·배포를 보류하라.
```
