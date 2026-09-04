# NEXUS-SI-ESTIMATE-BULK-UPDATE-20260904-01 작업 기록

## 기준과 범위

- 작업일: 2026-09-04 (Asia/Seoul)
- 기준: `origin/main` `5c10113442890a78b03435ee3f990eedd389fe13`
- 브랜치: `codex/smartinput-estimate-bulk-update-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-estimate-bulk-update-20260904`
- 저장 프로젝트 checkout은 수정·정리·reset하지 않았다.
- DB schema/store/key/index/migration/reset, ORDER Q/공식전표 V2, 기준정보 소유권, 공통 Runtime/Cloud gate는 변경하지 않았다.

## 원본 파일 읽기 전용 확인

- 파일: `C:\Users\USER\Desktop\견적서현황.xlsx`
- 시트: `견적서현황내역`, 사용 범위 `A1:W280`
- 1행 보고서 제목, 2행 필드명, 실제 품목행 277개, 정규화한 정확한 거래처명 그룹 10개를 확인했다.
- 그룹 행 수는 `72, 51, 32, 25, 22, 20, 18, 18, 12, 7`이다.
- 마지막 280행은 거래처·품목 식별값 없이 날짜/시간만 있는 푸터로 확인되어 장식행 무시 계약에 해당한다.
- 실제 품목행에는 customer-only/item-only 행이 없었다. 숫자 0 셀 486개를 확인했고 실제 파일에는 음수 값이 없었다.
- 원본 workbook은 열기/조회만 했고 저장·변환·내보내기·수정하지 않았다. CI와 브라우저 테스트에는 합성 fixture만 사용했다.

## 구현 계약

1. 견적서 모드에서 적용된 입력 양식이 있고 현재 working rows가 둘 이상의 거래처 그룹이면 기존 `저장`이 `전체 견적서 업데이트` 확인창을 연다. 단일 거래처 저장과 연동견적 흐름은 기존 경로를 유지한다.
2. 그룹 key는 행별 `customerId > customerCode > NFKC·trim·공백축약·소문자화한 정확한 customerName` 우선순위다. 일자·창고는 분할 key가 아니다.
3. 거래처와 품목 식별값이 모두 없는 행은 무시한다. 거래처만 또는 품목만 있는 행은 전체 적용을 차단한다. 그룹 간 동일 품목코드는 중복 제거하지 않는다.
4. 기존 개별 견적서는 exact ID, exact code, exact normalized name 순으로 찾는다. fuzzy와 첫 후보 자동선택은 없고, 유일 일치만 사전선택한다. 작업자는 모든 개별 견적서 중 다른 대상을 선택할 수 있다. 없음·복수·연동 대상·중복 대상은 fail-closed한다.
5. 확인창은 전체/연결/미해결/미대상, 원본 거래처, 새 품목수, 대상, 기존→신규 품목수, exact/작업자/충돌 상태와 전체교체·미대상 불변 문구를 표시한다. Escape/취소는 write 0이다.
6. 대상 record는 기존 객체를 바탕으로 `estimateId`, `catalogName`, `createdAt`, `sortOrder`, 거래처 master header와 기타 연결 메타데이터를 보존한다. rows, rowCount, amount, previousPrices, 새 baseline, updatedAt, 저장 delivery 상태만 갱신한다. 제목은 바꾸지 않는다.
7. 각 target draft의 `inputMapping`은 원본 필드명 행과 해당 거래처 working rows만 포함한다. `sourceMatrix`, `sourceCellMatrix`, `workingRows`, editJournal은 대상 행만 압축하고 원래 셀 address/rowIndex, headers, mappings, signature/headerSignature, file fingerprint를 보존한다. 매칭할 working row나 source evidence가 없으면 저장하지 않는다.
8. 모든 target은 단 한 번의 `commitEstimateBundle({upserts, expectedPreimages})`로 교체한다. 대상 자체 또는 대상 ID를 참조하는 연동견적에 persisted draft와 다른 working copy가 있으면 적용 전에 차단한다. 성공 후에만 `state.estimates`와 목록을 갱신한다.
9. 성공 후 전체 업로드 working rows와 원본 보기는 유지하되 특정 개별 견적서에 잘못 귀속되지 않도록 현재 `catalogRecordId`와 비교가격 bookkeeping만 비운다. 미대상·연동 record는 변경하지 않는다.

## 원자성·복구 경계

- IndexedDB 경로는 기존 `estimates` 한 transaction을 사용한다. 두 번째 put 강제 실패에서 transaction abort 후 모든 대상 preimage가 유지됨을 브라우저로 확인했다.
- stale expected preimage는 put 전에 전체 차단한다. stale target을 주입했을 때 다른 target도 변경되지 않았다.
- localStorage fallback은 기존 `commitEstimateBundle`의 in-memory bundle 작성 후 단일 `setItem` 경로를 그대로 사용하며, 강제 write 실패에서 기존 JSON이 유지되는 회귀를 통과했다.
- `expectedPreimages`는 optimistic concurrency/rollback 검증 입력이며 성공 후 영구 undo 이력으로 저장되지 않는다. 기존 계약에 성공한 전체교체를 되돌리는 영구 undo가 없어 새 Store/schema를 추가하지 않았다. 성공한 사용자 데이터는 코드 revert만으로 되돌아오지 않으며 별도 원본 또는 백업으로 복구해야 한다.
- 코드 rollback은 이 단일 목적 PR의 merge commit revert다.

## 검증

- 신규 순수 계약: 10그룹·277행, 푸터, partial row 차단, ID/code/name exact 우선순위, fuzzy/첫 후보 금지, 복수/수동/중복/연동 대상, 0/음수/빈값, evidence 분할, record 보존, working-copy 충돌 PASS.
- 신규 Chromium: 1920/1440/390 light/dark, focus, viewport/scroll, Escape 0-write, 대상 변경, 미해결/중복 disabled, 두 번째 IDB put rollback, stale preimage, 재시도 성공, 현재 업로드 유지, console/runtime 0 PASS.
- 전체 `scripts/test-smartinput*.mjs` 비브라우저 회귀 PASS.
- 기존 input-template, F3 input-list search, linked-source dialog, settings, full SmartInput Chromium E2E PASS.
- Phase 6B, table-view 전환, mapped-row sync, 빈 행/내부 빈 셀/0/음수, 주문서번호 파생, 연동 원본 수정, 공식 저장 경계 PASS.
- repository validator 24/24, warning 0; client safety; 변경 JavaScript syntax; `git diff --check` PASS.

## 남은 위험

- 10개 실제 target 견적서의 exact identity 품질은 운영 데이터에 의존한다. 없음·복수는 UI에서 수동 선택을 요구하고 자동 신규 생성하지 않는다.
- 거래처별 source evidence가 안전하게 분할되지 않는 입력 경로는 의도적으로 전체 적용을 거부한다.
- 성공 후 영구 데이터 undo는 기존 제품 계약에 없으므로 PM/운영자는 적용 전 대상과 품목수를 최종 확인해야 한다.
