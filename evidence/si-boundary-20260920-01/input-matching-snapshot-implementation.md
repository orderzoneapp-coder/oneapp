# 기존 입력 별칭·이력 보존과 독립 입력 경계

- 계약: `orderq-input-matching-snapshot`, `ONEAPP_ORDERQ_INPUT_MATCHING_SNAPSHOT_V1`. owner `orderq-vnext` → consumer `smart-input`.
- `orderq/input-matching-read-adapter.js`는 명시적 전체 기준정보 갱신 때만 호출한다. 기존 DB를 버전 없이 열고 신규 DB 생성/upgrade는 중단한다. 상품·상품별칭·주문·주문행 4개 store를 하나의 readonly transaction으로 읽어 기존 매칭에 필요한 필드만 발행한다. 신규 DB schema, owner engine, 원장 쓰기는 없다.
- 주문행은 같은 회사의 부모 주문을 통해 고객으로 연결한다. 회사가 없는 legacy 상품/별칭/주문은 기존 기본 회사 ONEAPP에서만 사용할 수 있다. 회사가 명시된 주문의 회사 없는 자식행은 부모 회사에 귀속하며, 회사가 명시된 불일치 자식행은 제외한다. 기존 자료를 다른 회사로 재귀속하지 않는다.
- 기존 후보 점수·순서·고객/수집원/공통 별칭 우선순위·주문 취소를 포함한 과거 이력 계산을 보존한다. 수량·가격·원문 메시지는 snapshot에 복제하지 않는다. 최종 공통 상품 기준 재판정도 유지한다.
- `smartinput/input-matching-snapshot.js`는 회사·사용자별 SmartInput settings cache, schema/hash 검증, request 최신성 확인, 동일 scope write 직렬화, 실패 시 기존 cache 보존을 담당한다. 읽기 실패를 EMPTY로 바꾸지 않는다. EMPTY는 정상적으로 확인한 빈 자료다.
- 초기 진입과 일반 분석은 자신의 cache만 읽는다. owner adapter는 정적 import하지 않는다. 최초 snapshot이 없는 프로필은 기존 별칭·이력이 미준비임을 입력 영역과 기준정보 popup에 표시하며 원문 입력을 계속 허용한다. 기존 결과 보존을 위한 최초 준비는 전체 기준정보 새로고침으로 명시적으로 수행한다.
- 전체 기준정보 6-domain generation과 입력 매칭 snapshot은 별도 저장 결과다. 하나만 성공하면 부분 성공을 알리고 현재 행을 바꾸지 않는다. 오류가 나면 마지막 정상 snapshot을 사용한다.
- LIVE_SOURCE 배치의 `inputMatchingRevision`에 분석 당시 회사·사용자·snapshot hash·활성 상품 revision을 기록한다. 동일 matchingContext 객체를 배치와 실제 분석에 사용한다. 원문 contentHash는 별도로 보존한다. 기존 createBatch/normalizeModeDraft의 확장 메타데이터 보존 계약을 사용하므로 DB migration은 없다.
- 새 snapshot 준비만으로 기존 행을 자동 재분석하지 않는다. 같은 원문의 명시 분석은 매칭 revision이 바뀐 경우 재실행하고 기존 editedFields 보존 경로를 사용한다. 준비 전에 만든 행에는 준비 완료 후에도 재분석 안내가 남으며, 새 기준으로 분석하면 사라진다.

직접 Node 검증은 `input-matching-snapshot-tests.json`에 기록했다. 5개 관련 스크립트가 통과했다. 신규 검사는 실제 기존 candidate generator와 후보 점수/순서를 대조하고 실제 최종 `enrichRowFromUnifiedCatalog`까지 별칭 입력의 코드·상품명·규격·원문 수량·단위 보존을 확인한다. 회사·사용자 불일치, hash 훼손, ERROR/EMPTY 구별, owner DB 접근 불가 중 cache 입력, stale refresh, 첫 준비와 같은 원문 재분석/복구 메타데이터/안내 유지도 포함한다. 브라우저 및 운영 검증 증거는 root 담당 기록을 따른다.
