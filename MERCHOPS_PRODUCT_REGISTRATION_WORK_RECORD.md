# MO-20260904-02 MerchOps 신규상품 실제 등록

## 착수 기준

- 사용자 확정: MerchOps 미등록 상품 화면에서 `PENDING 변경요청`으로 멈추지 않고 실제 상품등록까지 진행한다.
- 실행 지시: `업데이트 진행해`
- 기준 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 `origin/main`: `355ff5ce879b5d3b2eadef1d0b068e4db0d28102`
- 작업 브랜치: `codex/merchops-product-registration-20260904`
- 작업 경로: `C:\Users\USER\Documents\ChatGPT\검증 PM\work\oneapp-merchops-product-registration-20260904`
- 착수 상태: clean

## 확인 문서와 현재 사실

- `AGENTS.md` v2.3.4
- `roles/DEVELOPER.md`
- `APP_ARCHITECTURE.md`
- `app-manifest.json`
- 현재 미등록 상품의 `PENDING 변경요청`은 owner inbox 접수만 수행하며 상품 master에는 반영하지 않는다.
- 현재 Master inbox는 읽기 전용이므로 MerchOps 업무가 실제 등록 완료로 이어지지 않는다.
- 기존 상품 F7 변경은 `ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1`만 사용하며 raw master 쓰기는 차단되어 있다.

## 현재 상태와 목표 상태

- 현재: 미등록 상품은 필수값을 입력해도 PENDING 요청만 생성되고 등록 화면에 남는다.
- 목표: 사용자가 선택한 미등록 상품을 명시적으로 확인하면 상품 owner command가 master·revision·history를 원자적으로 저장하고, 성공한 상품을 현재 작업 Snapshot에 반영하여 Excel 재업로드 없이 기존 업무를 계속한다.

## 적용 정책과 경계

- 실행 방식: 사용자 명시 등록은 `LOCAL_OPERATION`의 owner command 확정으로 처리한다.
- MerchOps는 `master_products`, master snapshot/revision, history를 직접 쓰지 않는다.
- 실제 쓰기는 `master-lookup` 소유의 versioned product command adapter 내부에서만 수행한다.
- 작업 시작 Product Snapshot revision/id/hash를 모두 검사하고 충돌 시 저장하지 않는다.
- 선택 상품 묶음은 전건 사전검증 후 하나의 master commit으로 저장한다.
- 상품 master 등록 필드는 코드·품목명·규격·단위·입고가·구매처·창고·기본·과세로 제한한다.
- 수량과 기준일자는 현재 Excel 작업값으로 보존하고 상품 master에는 등록하지 않는다.
- 상품, revision, history, 보호 대상 연결상태와 최종 검산 중 하나라도 실패하면 등록 전체를 rollback한다.
- 원본 Excel, 현재 작업행, 현재 작업값과 삭제 복구목록은 변경하거나 삭제하지 않는다.
- 기존 SmartParser 등 자동 분석의 PENDING 제안 흐름은 유지한다.

## UI/UX 계약 확인

- 기존 NEXUS 공통 테마·공통 헤더·반응형 툴바 구조를 그대로 사용한다.
- 신규 화면이나 별도 디자인 체계를 만들지 않고 기존 미등록 상품 툴바의 실행 버튼 문구·상태만 실제 동작에 맞게 바꾼다.
- 일반/다크/좁은 화면의 기존 클래스와 배치를 보존하며 처리 중에는 등록 버튼을 비활성화한다.

## 완료 조건

1. 등록 버튼이 `선택 상품 등록`으로 표시되고 PENDING이 실제 등록으로 오인되지 않는다.
2. 필수값 누락·중복코드·Snapshot 충돌은 master 변경 없이 이해 가능한 오류로 종료한다.
3. 성공 시 선택 상품이 상품 master와 공식 history에 한 번만 기록된다.
4. 같은 operation ID 재시도는 중복 상품과 중복 history를 만들지 않는다.
5. 일부 저장이나 후검산 실패는 master와 history를 원복한다.
6. 등록된 행은 현재 Product Snapshot에 명시적으로 반영되고, 남은 미등록 상품이 없으면 기존 업무 화면으로 자동 복귀한다.
7. 삭제 기능, F7/F8/F9, 다른 앱의 PENDING 제안과 원본 Excel 값은 회귀하지 않는다.

## 검증 계획

- owner command 단위 테스트: 성공, 배치 원자성, 중복, 멱등 재시도, stale Snapshot, history 실패 rollback, 최종 검산 실패 rollback, 연결상태 보존.
- MerchOps 구조 테스트: 직접 writer 0건, 등록 command 연결, 등록 필드 제한, 버튼/문구, 수량·기준일자 master 제외, 자동 복귀.
- 기존 MerchOps owner-boundary, 공통 Excel routing, reference-data contract 및 관련 회귀 테스트.

## Rollback

- 본 작업 commit을 되돌리면 MerchOps는 기존 `PENDING 변경요청` 흐름과 v2.1.194 삭제 기능으로 복귀한다.
- 이미 성공한 상품 master와 append-only history는 자동 삭제하지 않으며 상품관리에서 별도 관리자 판단으로 처리한다.

## 구현 결과

- MerchOps `PENDING 변경요청` 버튼을 `선택 상품 등록`으로 교체하고 사용자 확인 후 실제 owner command를 호출하도록 연결했다.
- `MERCHOPS_PRODUCT_REGISTRATION_V1` 명령은 허용 필드·필수값·중복·Snapshot·operation ID를 검증하고 선택 묶음을 한 번에 commit한다.
- 성공 Snapshot을 현재 작업에 명시적으로 반영하고 등록행은 작업표에 유지하며 미등록 0건이면 기존 업무 화면으로 복귀한다.
- 공통 history 정규화에서 operation ID/hash와 감사 메타데이터를 보존하고 저장 직후 메타데이터까지 검산한다.
- 기존 숫자형 revision도 owner 저장 경계의 원본 타입으로 비교하도록 보완했다.

## 검증 결과

- `scripts/test-merchops-all.mjs`: 16개 전체 통과.
- `scripts/test-reference-data-browser-e2e.mjs`: 실제 IndexedDB 숫자형 revision의 최초 등록 `APPLIED`, 동일 명령 재시도 `DUPLICATE`, master/history 검산 통과.
- `scripts/validate-repository.mjs`: 24개 검사, 경고 0건.
- `git diff --check`: 오류 없음(LF/CRLF 안내만 존재).
