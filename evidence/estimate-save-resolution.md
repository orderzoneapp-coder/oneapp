# SI-BOUNDARY-20260920-01 견적 연속 저장 실패 해소

격리된 새 Chrome 프로필과 합성 자료로 검증했다. 운영 자료·일반 사용자 프로필은 사용하지 않았다.

- **원인:** `saveEstimateDocument`가 준비 조회인 `await ensureEstimateBodies()` 다음에 `busy=true`를 설정했다. 첫 견적 갱신 직후 버튼이 잠깐 활성 상태여서 기존 E2E가 갱신 완료로 오판했다. 이어 초기화·두 행 입력을 진행한 후 두 번째 저장 시점에는 첫 저장이 진행 중이었다. 비활성화된 버튼의 `.click()`은 실행되지 않아 이름창 대기가 시간 초과했다.
- **변경 전 관측:** full 진단의 `full-after-in-place-estimate-save` 7,592ms, 초기화 직후 7,638ms, 두 번째 저장 전 7,881ms 모두 `busy=true`/버튼 `disabled=true`였다. 27,913ms 실패 시에는 이전 저장이 완료되어 `busy=false`였다. [원본 진단](si-boundary-20260920-01/deploy-full-browser-diagnostic.json)을 보존했다. 좁힌 검증에서도 클릭과 같은 JavaScript 실행 안에서 확인한 버튼 비활성화 assertion이 `false !== true`로 실패했다([변경 전 회귀](si-boundary-20260920-01/deploy-estimate-before-busy-fix.json)).
- **최소 수정:** 저장 준비 조회부터 최종 저장까지 `busy`와 `try/finally`를 적용했다. 진행 중 재호출과 견적 이름창 Enter 중복 제출을 차단했다. 준비 실패·스키마 거절·이름 충돌 취소에서도 진행 상태를 해제하며, 저장 도중 새 작업본으로 바뀌면 기존 저장 결과가 새 작업본을 덮어쓰지 않는 조건을 유지했다.
- **변경 후 실제 상태:** 전체 E2E의 갱신 완료 snapshot은 `busy=false`, 기존 견적 선택 1개이며 수량 1·단가 **1,750**이었다. 이는 저장 함수가 `loadEstimateForUpdate`로 저장 결과를 재조회한 후 적용한 작업본이다. 초기화 후 선택·catalogRecordId는 비었고, 두 번째 견적의 두 행은 **3×2,400 / 3×1,500**으로 유지됐다. 두 번째 이름창이 열린 뒤 저장을 확정하고 견적 카드 **2개** assertion을 통과했다. 별도 원시 IndexedDB 덤프를 수집한 것은 아니다.
- **검증:** `SMARTINPUT_ESTIMATE_ONLY=1` 좁은 브라우저 경로 PASS, `node scripts/test-smartinput-estimate-save-lifecycle.mjs` PASS, 전체 `node scripts/test-smartinput-browser-e2e.mjs` **PASS**. 새 lifecycle 검사는 준비 실패·덮어쓰기 취소·구형 스키마 거절·중복 실행·호스트 이동 전 idle 대기·새 작업본 보호·수량 0 보존을 확인한다.

전체 PASS 증거: [동작 결과](si-boundary-20260920-01/deploy-full-after-estimate-fix.json), [실제 상태·예외 결과](si-boundary-20260920-01/deploy-full-after-estimate-fix-diagnostic.json). 런타임 예외 및 console error는 모두 0개였다. 해당 실행의 main SHA-256은 `1d28dea979abf9e79c869e12149434f4256e5facc15008cb0e082a3f20d71147`이다. 이후 별칭 Snapshot 연결 변경은 이 저장 함수 밖에서 진행되므로, 이 결과를 이후 main 전체 해시를 재실측한 결과로 표현하지 않는다.
