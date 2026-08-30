# SmartInput 기준정보 Snapshot UX v1

- 작업 ID: `NEXUS-SI-REFDATA-UX-20260830-01`
- 격리 기준 SHA: `dcd962a64c6a7fa80d60d4f0578ebdc4a5de2ef4`
- 선행 계약: PR #440, `ONEAPP_PRODUCT_SNAPSHOT_V1`, `ONEAPP_CUSTOMER_SNAPSHOT_V1`, `ONEAPP_REFERENCE_CHANGE_REQUEST_V1`
- 공식 상품 소유 앱: `Master.html` / `master-lookup`
- 공식 거래처 소유 앱: `customer-master/index.html` / `customer-master`

## 구현 경계

SmartInput은 상품·거래처 원본의 읽기 전용 소비자다. 상품은 `ONEAPP_PRODUCT_MASTER_READ_ADAPTER`, 거래처는 `ONEAPP_CUSTOMER_MASTER_READ_ADAPTER`를 먼저 호출한다. owner Adapter가 실패할 때만 기존 물리 저장소를 검증 가능한 `readonly` transaction으로 읽으며 상태 화면에 fallback 출처를 표시한다. ORDER Q 상품 이력은 과거 전표 보조자료로만 남고 마스터 자동확정에는 사용하지 않는다. `ItemMaster.html`은 정적 호환 경로일 뿐 owner가 아니다.

기존 SmartInput DB는 version 3과 Store 목록을 유지한다. 마지막 적용 Snapshot과 보류 Snapshot은 기존 `settings` Store의 `reference:product`, `reference:customer` record에 저장한다. 기존 초안·설정·전달 localStorage 키, 3분할 UI, 공통헤더·앱 헤더, 직접·Excel·붙여넣기·OCR·음성 입력과 주문·구매·판매·견적 저장·전달 계약은 바꾸지 않는다.

## 적용과 데이터 보존

앱 진입은 SmartInput 로컬 Snapshot을 먼저 표시하고 최신 revision을 백그라운드에서 확인한다. 새 revision이 활성 작업 중 발견되면 `STALE`로 보류하며 기본값은 다음 작업부터 적용이다. 관리자가 현재 작업 적용을 선택하면 상품·거래처별 revision과 added/removed/changed diff를 먼저 표시한다. 적용 과정은 원문, mode별 초안, 작업행, 행 선택, 현재 셀 상태와 `editedFields`를 유지한다. 제거된 상품 선택은 값을 삭제하지 않고 `STALE_SELECTION` 확인 상태로 전환한다.

상품 자동확정은 다음 두 경우뿐이다.

1. 품목코드 정확 일치 후보가 정확히 1개다.
2. 품명, secondaryName 또는 승인 별칭 정확 일치 후보가 정확히 1개다.

유사검색은 후보가 1개여도 자동확정하지 않는다. 복수 후보와 함께 명시적 선택 UI를 사용한다. 후보 없음은 행과 입력을 보존한 `미등록 상품`이며 기준정보 로드 실패와 별도 상태다. 미등록 상품·거래처 경로는 owner 앱을 새 탭으로 열고 공개 변경요청 Adapter로 CREATE 요청을 접수한다. SmartInput은 owner master Store에 직접 쓰지 않으며 요청 실패나 사용자 취소도 현재 작업을 변경하지 않는다.

## 상태와 장애 격리

상단 앱 상태의 compact details에 상품·거래처별 `READY / EMPTY / ERROR / STALE`, 출처, 건수, revision, 마지막 확인시각과 도메인별 다시 불러오기를 제공한다. `EMPTY`는 확인된 0건, `ERROR`는 로드 실패, 검색 결과 0건은 현재 검색 조건 결과다. 도메인별 다시 불러오기는 작업표 전체를 렌더링하지 않는다. 서버·인증·글로벌 Runtime은 새 선행조건이 아니며 기준정보 장애 중에도 수동 입력, 작업표 편집과 로컬 초안 저장은 계속한다.

## 검증과 롤백

- 단위/계약: `scripts/test-smartinput-reference-data-ux.mjs`
- 실제 브라우저와 핵심 회귀: `scripts/test-smartinput-browser-e2e.mjs`
- 기존 파서·OCR·clipboard·다중 전표·독립 복구 및 전체 `repository-validation` workflow
- 운영 검증: Pages 배포 SHA와 merge SHA 일치, 변경 자산 HTTP 200 및 raw GitHub SHA-256 일치, SmartInput light/dark·주요 viewport·console/runtime 읽기 전용 점검

롤백은 이 작업의 merge commit을 revert한다. DB version과 Store를 변경하지 않았으므로 migration 역실행이 필요 없다. 구버전은 `settings` Store의 알 수 없는 `reference:*` record를 무시하며 owner master·변경요청 inbox·기존 초안과 전달 기록은 삭제하지 않는다.
