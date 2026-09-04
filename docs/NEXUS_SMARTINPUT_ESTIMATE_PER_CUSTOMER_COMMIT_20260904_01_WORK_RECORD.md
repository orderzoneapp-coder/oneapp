# NEXUS-SI-ESTIMATE-PER-CUSTOMER-COMMIT-20260904-01 작업 기록

## 기준과 보호 범위

- 작업일: 2026-09-04 (Asia/Seoul)
- 출발 기준: `origin/main` `355ff5ce879b5d3b2eadef1d0b068e4db0d28102` (PR #508 merge)
- 최종 검증 기준: `origin/main` `54edac787a308cfe6c094655b7c33edf7e2d5aa3` (작업 중 병합된 PR #509 포함)
- 브랜치: `codex/smartinput-estimate-per-customer-commit-20260904`
- 전용 worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-estimate-per-customer-commit-20260904`
- 저장 프로젝트 checkout과 PR #508 worktree는 수정·정리·reset하지 않는다.
- DB schema/store/key/index/version/migration/reset, ORDER Q/공식전표 V2, 기준정보 소유권, 공통 Runtime/Cloud gate는 변경하지 않는다.
- 기존 전체 업로드 rows와 원본 evidence는 저장 성공 뒤에도 검토용으로 유지한다.

## 규범과 현행 구현 조사

- 루트 `AGENTS.md` v2.3.4, `roles/DEVELOPER.md`, `APP_ARCHITECTURE.md`, `app-manifest.json` schema 1.3.9, `smartinput/README.md`, `orderq/ARCHITECTURE.md`를 기준으로 owner·write·검증·rollback 경계를 확인했다.
- 작업 중 전진한 main의 `APP_ARCHITECTURE.md`와 `app-manifest.json` diff를 다시 확인했다. 변경은 MerchOps의 관리자 명시 신규상품 owner-command 등록 경계이며 SmartInput의 저장·소유권 계약은 바뀌지 않았다. 전용 브랜치는 충돌 없이 최신 main에 rebase했다.
- PR #508 구현은 모든 거래처 target을 하나의 `commitEstimateBundle({upserts, expectedPreimages})` 호출에 넣고, 어느 한 그룹의 문제도 전체 실행을 차단한다.
- 기존 repository의 한 번의 bundle commit은 그 호출 안에서 원자성을 보장하므로, 이번 변경은 repository를 바꾸지 않고 거래처마다 `upserts 1개`로 순차 호출한다.
- `normalizeModeDraft`는 알 수 없는 draft 필드를 보존하므로 진행 메타데이터는 현재 견적 mode draft의 additive 필드로 둘 수 있다. 새 Store나 schema migration은 필요하지 않다.

## 목표 계약

1. 저장 원자 단위는 거래처 한 곳의 견적서 전체다. 한 품목행이라도 문제이면 그 거래처 그룹은 0-write로 `확인 필요`에 남긴다.
2. 정상 그룹은 다른 문제 그룹과 무관하게 순차 저장한다. stale 또는 put 실패는 해당 그룹만 `저장 실패`가 되고 다음 정상 그룹 처리는 계속한다.
3. popup에서만 실행하며 파일 적용 직후 자동 저장하지 않는다. 기존 저장 버튼·단축키·전체 레이아웃은 유지한다.
4. exact customerId → exact customerCode → exact normalized customerName 유일 일치만 사전선택한다. 작업자는 기존 개별 견적 선택, 명시적 신규 생성과 이름 확인, 이번 작업 제외를 선택한다.
5. 그룹 상태는 `저장 가능`, `확인 필요`, `변경 없음`, `저장 완료`, `저장 실패`, `이번 작업 제외`로 관리한다. 완료·변경 없음·제외는 같은 fingerprint와 target 결정에서 재실행하지 않는다.
6. 파일 fingerprint, 거래처 group fingerprint, target 결정과 상태를 현재 estimate draft 안에 최소 메타데이터로 저장한다. 해당 그룹의 rows/evidence/target 결정이 바뀔 때만 그 그룹 상태를 무효화한다.
7. target과 동일한 rows·그룹 source evidence이면 `변경 없음`으로 처리하여 `updatedAt`도 쓰지 않는다.
8. 거래처-only 행은 해당 거래처 그룹 전체를 보류한다. item-only 행은 별도 `거래처 미확인 전표`로 보류하되 정상 그룹을 막지 않는다. 거래처·품목 모두 없는 푸터/장식행은 무시한다.
9. 상품 판정 `SIMILAR`, `UNRESOLVED`, `MATCH_FAILED` 또는 미확정 review 행은 해당 그룹 전체를 보류한다. 0·음수·선택 항목 빈값은 기존 유효값 계약을 유지한다.
10. 대상 record identity/title/created/sort/customer/link metadata를 보존하며, 각 target draft에는 그 거래처 rows와 분할 source evidence만 저장한다.

## 검증 계획

- 먼저 10개 거래처·277행 상당 합성 fixture에 문제 그룹과 정상 그룹을 섞어 기존 전역 차단/전역 transaction 계약이 실패함을 재현한다.
- 순수 계약: 그룹 독립 판정, exact 매칭, 신규/제외/중복 해결, fingerprint 무효화, unchanged, evidence 분할, 0/음수/빈칸 보존.
- 저장 원자성: A 성공, B 0-write, C 성공; A stale/put 실패 뒤 C 계속; B 수정 재시도 때 A/C 재저장 없음.
- 브라우저: 1920/1440/390 light/dark, 확인 필요 우선/전체 보기, focus/scroll/Escape/cancel 0-write, 새로고침 progress 복구, 전체 업로드 유지, console/runtime 0.
- 전체 SmartInput scripts, full Chromium E2E, repository validator 24/24·0 warnings, client safety, JavaScript syntax, diff check, Phase 6B를 실행한다.

## 복구 경계

- 실패한 거래처의 한 번의 bundle commit은 기존 repository transaction으로 0-write를 보장한다. 이미 성공한 다른 거래처는 의도대로 유지한다.
- 성공 preimage는 영구 undo 이력으로 저장되지 않는다. 새 Store/schema를 추가하지 않으며 성공한 사용자 데이터의 자동 영구 undo는 제공하지 않는다.
- 코드 rollback은 이 단일 목적 PR의 merge commit revert다. 사용자 데이터 복구가 필요하면 적용 전 원본/별도 백업을 사용해야 한다.

## 구현 결과

- `estimate-bulk-update.js`에 거래처별 분류 문제, 상품 review 차단, exact 대상 결정, 분할 evidence 검증, 동일내용 비교, 파일/그룹/결정 fingerprint, 진행상태 reconcile을 DOM과 분리된 순수 경계로 구현했다.
- item-only 행은 `UNASSIGNED:<rowId>` 보류 전표가 되고, customer-only 행은 같은 거래처 그룹의 문제로 귀속된다. 전역 오류가 정상 거래처를 막지 않는다.
- popup은 거래처별 `저장 가능/확인 필요/변경 없음/저장 완료/저장 실패/이번 작업 제외`, 품목수, 기존→신규 품목수, 첫 문제 행·사유를 표시한다. 기존 개별 견적, 명시적 신규+이름, 제외를 선택하고 저장 가능 전표 체크박스로 순차 실행한다.
- 각 실행은 기존 `commitEstimateBundle({upserts:[record], expectedPreimages:[target]})`를 한 거래처씩 호출한다. catch는 해당 그룹의 실패만 기록하고 다음 그룹을 계속 처리한다.
- 진행 메타데이터 `ONEAPP_SMARTINPUT_ESTIMATE_BULK_PROGRESS_V1`은 현재 estimate mode draft에만 저장한다. target draft를 만들 때 제거하므로 개별 견적과 원본 evidence에 전체 진행상태가 섞이지 않는다.
- 새로고침 매핑 복구가 상품 ID와 `MATCHED`만 보존하고 review/identity를 되돌리던 기존 불일치를 함께 바로잡아, 확인 완료 상품의 `reviewStatus`, `productIdentityStatus`, `matchSource`도 같은 product-edit 경계에서 보존한다.
- 자산 토큰은 `smartinput.js?v=0.11.20`, `smartinput.css?v=0.9.5`, 순수 bulk module import는 `v=0.2.0`으로 갱신했다. 신규 UI는 기존 popup/status 안에만 추가했으며 테이블 열·기존 버튼·단축키·전체 레이아웃은 바꾸지 않았다.

## 검증 결과

- 실패 재현: 신규 순수 테스트가 구현 전 `createEstimateBulkProgress` export 부재로 RED였고, 구현 후 GREEN이다.
- 순수 계약: 10거래처·277행 + item-only 보류 fixture, SIMILAR/미확정 review/customer-only/대상 ambiguity/working-copy/source evidence 문제, READY/PENDING 분리, 0·음수·내부 빈칸, 신규/제외, unchanged, fingerprint 무효화와 완료 복구 PASS.
- 집중 Chromium: 1920/1440/390 light/dark, 첫 문제 focus, viewport/scroll, Escape 0 estimate-write, 중복/미해결이 다른 정상 전표를 막지 않음, 명시 신규 이름/제외 UI, 문제 중심/전체 보기 PASS.
- 원자성: A stale은 A만 0-write/실패, 정상 C는 계속 저장; A 재시도에서 C `updatedAt` 불변. B put 강제 실패는 B만 0-write이며 A/C 불변, 재시도는 B만 저장 PASS.
- 새로고침: A/C 완료와 B 확인 필요 진행상태를 복구하고, B 상품 확인으로 B group fingerprint만 무효화되어 READY가 되는 것을 확인했다.
- 거래처별 저장 draft의 sourceMatrix/sourceCellMatrix/signature/headerSignature는 해당 거래처 header+rows만 포함하고 셀 주소를 보존했다. 전체 업로드 표는 A/B/C 모두 유지했다.
- 전체 비브라우저 `scripts/test-smartinput*.mjs` 35개 PASS, 전체 브라우저 SmartInput 9개 PASS, full SmartInput Chromium/F3/입력양식/연동 원본/설정/공식 revision 회귀 PASS.
- repository validator 24/24·0 warnings, client safety, 변경 JavaScript syntax, Phase 6B 승인 해시, `git diff --check` PASS.
- 테스트는 합성 격리 IndexedDB/localStorage와 임시 프로필만 사용했고 운영 데이터 write는 0이다.

## 남은 위험과 한계

- 성공한 거래처 전표는 다른 실패 전표 때문에 자동 rollback되지 않는 것이 이번 사용자 계약이다. 따라서 전체 파일을 한 시점으로 되돌리는 영구 undo는 없다.
- 완료 판정은 같은 파일·그룹·target 결정 fingerprint에 묶인다. 행/evidence 또는 target 결정이 바뀌면 해당 그룹만 다시 검증되며, 의도적인 재적용은 그 변경을 통해 명시해야 한다.
- 운영 master identity의 없음/복수, linked working copy, 안전하지 않은 evidence는 계속 fail-closed하며 작업자가 해당 전표만 확인해야 한다.
