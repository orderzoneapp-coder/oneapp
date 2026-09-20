# 쇼핑몰 원본 공개 계약 분리와 CI 경계 복원

PR #638 CI의 `test-orderq-shopping-actual-ledger-dedupe.mjs`가 SmartInput의 owner dedupe core 직접 import를 거부했다. 금지 검사를 유지하고 실제 경계를 수정했다.

- `orderq/shopping-order-source-adapter.js?v=0.1.0`에 기존 command adapter의 `isExactShoppingOrderSource`, `createShoppingOrderCandidates` 두 순수 함수를 실제 이동했다. schema와 17열 원본 계약을 함께 공개하며 repository·원장 I/O·command adapter를 import하지 않는다.
- 기존 command adapter는 같은 함수 객체를 import/export하여 기존 API를 유지한다. 기존 core, repository, 저장 규칙과 DB schema는 변경하지 않았다.
- SmartInput은 public source adapter만 정적으로 참조한다. 명시적 검사/저장은 기존 timeout을 가진 lazy command adapter 경로로 수행하며 URL을 `v=0.2.2`로 갱신했다. consumer URL `shopping-order-upload.js?v=0.1.3`의 main 연결은 root 담당이다.
- 기존 실제 원장 dedupe CI 검사는 수정하지 않았다. SmartInput 단위검사의 잘못된 core 직접 import 기대를 source adapter 소비와 core/repository 직접 import 금지로 바꾸고, command/source의 동일 함수 재사용도 검증했다.

직접 검증 결과:

| 검사 | 결과 |
|---|---|
| `test-orderq-shopping-actual-ledger-dedupe.mjs` | PASS; 기존 core 직접 참조 금지 포함 |
| `test-smartinput-shopping-order-upload.mjs` | PASS; owner 저장소 불가 중 순수 준비, 명시 연결, 기존 payload 및 실패 보존 포함 |
| `test-smartinput-shopping-order-upload-browser.mjs` | PASS; 실제 브라우저 신규 4+1 저장, 중복 5건 0-write, 미확정 격리, 17셀 원본·담당자 보존 |
| `test-orderq-shopping-actual-ledger-browser.mjs` | PASS; 실제 IndexedDB 원장 개수·원자 저장·미해소 ID 차단·중복 판정 회귀 |
| 수정 파일 `git diff --check` | PASS |

Node의 사용자 Desktop 실제 XLS 2개는 없어서 해당 선택적 파일 fixture는 SKIP이며 합성·실제 브라우저 검사는 통과했다. 브라우저는 임시 프로필에서 실행했고 외부 변경 요청과 브라우저 예외는 0건이다. 브라우저 결과는 `deploy-shopping-source-boundary-browser.json`, `deploy-shopping-source-owner-browser.json`에 보관했다.

직접 검증 시 생산 파일 SHA256:

- source adapter: `eb5ec41e2fbc9e8043fa6fae97d5df5063e5e9addd208b306a4039c2a4091a90`
- command adapter: `b6f07490bba350d43e31633cdf86679f9a8f9e61ac1f5d802290d3667e5f4882`
- consumer upload: `224841ffc8533806453c55a6e4f318397a018f9777531fb400485429858749ee`
