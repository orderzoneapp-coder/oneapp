# NEXUS 주문·출고 파이프라인 v1.1 개발 기록

## 시작 기준

- 사용자 승인: 최종 개발명세서 v1.1 개발 진행
- 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 원격 SHA: `19722db04f8e3ec1f5748d593b89eccc6dd878b7`
- fetch 후 `origin/main`: `19722db04f8e3ec1f5748d593b89eccc6dd878b7`
- 작업 브랜치: `codex/order-shipment-pipeline-v1-1`
- 작업 HEAD: `19722db04f8e3ec1f5748d593b89eccc6dd878b7`
- worktree: `C:\Users\coms\Documents\Codex\2026-09-07\new-chat\work\oneapp-order-shipment-pipeline`
- 시작 상태: clean, 다른 작업 변경 없음

## 확인 문서와 계약

- `AGENTS.md` v2.3.4
- `roles/PM.md`
- `roles/DEVELOPER.md`
- `APP_ARCHITECTURE.md`의 공통 UI/UX 단일 계약과 ORDER Q smart file intake
- `app-manifest.json`의 `smart-input`, `orderq-vnext`, `orderops`, `shipping-purchase-plan`, ORDER Q owner 계약
- 사용자 확정 `NEXUS 주문·출고 파이프라인 최종 개발명세서 v1.1`

## 시작 상태와 목표 상태

- 현재: SmartInput 주문은 ORDER Q에 저장되지만 저장 주문 직접 링크, 담당자·입력채널·일반 주문 멱등 증거가 불완전하다.
- 현재: 주문조회는 `focus`를 사용하고 OrderOps 링크에 `orderId`를 보내지만 OrderOps는 이를 읽지 않는다.
- 현재: OrderOps는 주문현황·창고재고 Excel을 요구하며 실제 출고 결과와 판매이관 상태가 연결되지 않는다.
- 목표: SmartInput 주문별 링크 → 주문조회 `focus` → OrderOps ORDER Q Snapshot 직접입력 → OrderOps 소유 실제 출고 결과로 연결한다.
- 보존: 창고재고 Excel 필수, 기존 Excel 수동입력·출력·복구·Cloud revision, 기존 주문/판매이관 상태와 이벤트, 앱 ID와 권한 키.

## 적용 정책과 경계

- 기본 작업은 `LOCAL_OPERATION`, 기존 Cloud sync는 비차단 `BACKGROUND_SYNC`로 유지한다.
- ORDER Q와 OrderOps는 상대 원시 Store를 직접 쓰지 않고 versioned Adapter만 사용한다.
- 공식 출고 결과는 OrderOps 소유 별도 `ONEAPPShippingResultDB`에 저장한다.
- 기존 `ONEAPPShippingRecoveryDB`와 legacy DB를 변경·초기화하지 않는다.
- NEXUS 판매전표 직접 등록, ECOUNT API, 창고재고 자동연동, 출고 Cloud 동기화는 제외한다.
- 공통 UI는 기존 NEXUS 공통 자산과 의미 토큰을 사용하며 별도 테마 컨트롤러를 만들지 않는다.
- 일반/다크, 데스크톱/모바일, 출력의 밝은 배경과 상태 보존을 검증한다.

## 주문 수정·출고 확정 동시성 결정

- 서로 다른 IndexedDB 사이의 hard lock은 원자성을 보장하지 못하고 고아 잠금 위험이 있으므로 도입하지 않는다.
- 작업 시작 시 `orderRevision`과 Snapshot hash를 고정한다.
- 출고 확정 직전에 ORDER Q owner Read Adapter로 Revision과 hash를 재검사한다.
- 불일치 시 공식 출고 확정을 차단하고 활성 작업본은 보존한다.
- 출고 확정 후 주문이 바뀌면 Shipping Result Read Model에서 `REVIEW_REQUIRED`로 사후 검증한다.
- 확정 출고를 무효화하는 주문 상품·수량·취소 변경은 출고 정정 또는 역출고를 먼저 요구한다.

## 시작 시 충돌 여부

- 기준 소스와 사용자 확정 명세 사이에 개발을 차단하는 충돌 없음.
- 기존 `app-manifest.json`의 shipping recovery DB 설명이 실제 코드보다 오래된 문서 불일치이며, 승인 범위에서 정정한다.

## 구현 결과

### SmartInput → 주문조회

- SmartInput 저장 주문의 입력채널을 `SMART_INPUT`으로 유지하고 `ORDER_IN` 오분류를 제거했다.
- 담당자, `sourceDocumentKey`, `sourceLineKey`, 원문 fingerprint, intake 식별자와 custom/layout 증거를 주문 저장 과정에서 보존했다.
- 동일 source key·동일 payload는 기존 주문을 반환하고, 동일 key·변경 payload는 충돌로 차단한다.
- 다건 저장은 주문별 성공·실패를 분리해 부분 성공을 유지하며, 성공 결과에 공식 주문조회 링크 `?view=query&focus=...`를 제공한다.

### 주문조회 → 출고관리

- 공식 주문조회 파라미터는 `focus`로 유지하고 `orderId`는 호환 별칭으로 읽은 뒤 공식 URL로 정규화한다.
- ORDER Q 소유의 versioned 출고 후보 Read Model/Adapter를 추가했다. 전체 Store 공유 없이 point read와 상한 200건 목록만 제공한다.
- 출고관리의 `?orderId=...` 진입 시 ORDER Q 주문 snapshot을 직접 작업 입력으로 사용한다.
- 주문현황 Excel은 수동 fallback으로 유지하고, 창고재고 Excel은 출고 분석의 필수 입력으로 유지한다.

### 출고 작업·결과

- OrderOps 소유 `ONEAPPShippingResultDB`에 출고문서, 출고라인, 이벤트, command receipt를 저장한다.
- 출고대기·출고보류·부분출고·출고완료·출고취소·확인필요를 기존 주문/관리자/판매이관 상태와 분리된 축으로 제공한다.
- 요청상품·실출고상품, 대체출고 lineage, 출고수량, 부분출고/보류 사유를 보존한다.
- 확정·보류·역출고는 append-only 이벤트로 기록하고, command key 멱등성과 동시 확정 잔량을 동일 DB transaction 안에서 검증한다.
- 주문조회가 Shipping Result Read Adapter를 통해 출고 상태를 표시하며 OrderOps 원시 Store에 직접 접근하지 않는다.

### 공통 계약과 화면

- 사용자 표시는 `주문조회`, `출고관리`, `판매처리 검증`으로 명확화하되 앱 ID, route, storage key와 권한 키는 유지했다.
- `app-manifest.json`에 주문 출고 후보 계약, 출고 결과 계약, 데이터 소유권, 동시성, rollback 경계를 등록했다.
- 일반/다크 모드와 데스크톱/모바일 반응형 화면을 확인하고 모바일 SmartInput 검색 패널의 가로 overflow를 수정했다.
- NEXUS 판매전표 직접 등록, ECOUNT API, 창고재고 자동연동, 출고 Cloud 동기화는 구현하지 않았다.

## 동시성 검증 결과

- 출고 command 시작과 commit 직전에 ORDER Q revision/hash를 각각 확인한다.
- 주문이 변경된 작업본의 확정은 `SHIPMENT_ORDER_REVISION_CONFLICT`로 차단하며 작업자 입력은 보존한다.
- 같은 주문에 대한 동시 출고가 잔량을 초과하면 결과 DB transaction에서 `SHIPMENT_RESULT_CONFLICT`로 차단한다.
- 이미 확정된 출고 뒤 주문 revision/hash가 변경되면 조회 결과는 `REVIEW_REQUIRED`/`확인필요`가 된다.
- 역출고는 원 확정문서를 참조하는 보상 기록이며 중복 역출고를 차단한다.

## 검증 결과

- 비브라우저 자동검증: **122/122 PASS**
- 브라우저 자동검증: **23/23 PASS**
- 주문조회 출고대기 → 출고완료 → 주문변경 확인필요 → 역출고 출고취소 시나리오 PASS
- 동시 stale confirm 차단, 주문 revision 충돌 차단, 모바일/다크 화면, SmartInput 다건·부분 성공 PASS
- `app-manifest.json` JSON parse 및 contract ID 중복 검사 PASS (`schemaVersion 1.3.13`, 34 contracts)
- `git diff --check` PASS (Windows line-ending 안내만 존재)

## 배포 경계

- 이 기록 시점의 구현은 기능 브랜치에서 완료했다.
- PR 검토 전 `main` 직접 변경이나 배포는 수행하지 않는다.

## 최신 main 통합

- 최종 fetch에서 `origin/main`이 `a596cbbdc1f8df52ee2b7f8f0dcf094cc372a8ab`로 전진한 것을 확인했다.
- 기능 브랜치를 해당 SHA 위로 rebase했다.
- `nexus/index.html`과 로그인 홈 계약 테스트의 cache revision 충돌은 최신 로그인 유지 기능의 CSS/테스트 계약과 주문 파이프라인의 navigation runtime을 모두 보존해 해결했다.
- 통합 후 NEXUS 로그인·세션·회사정보 계약 테스트와 주문·출고 핵심/브라우저 동시성 테스트를 다시 실행해 모두 PASS를 확인했다.
