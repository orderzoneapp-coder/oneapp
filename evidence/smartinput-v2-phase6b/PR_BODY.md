## 목적

UI Gate U1에서 승인된 A안에 따라 기존 `orderops/list.html` 결과 영역 안에서만 Phase 6A 미매칭 Read Model과 impact preview를 소비합니다.

PM 재검증 지시에 따라 최신 main `b126b298a18671942a70d8ae2ae53d1b25234fcb` 위로 단일 커밋을 rebase하고, 공통 다크 헤더·아이보리 Light 토큰·SmartInput 셀 위계와 최신 OrderOps manager colors·다크 표 대비·인쇄 원점을 보존한 기준에서 전체 검증을 다시 수행했습니다.

## 변경

- 기존 필터 줄에 `미매칭` 조회 상태 추가
- 기존 결과 영역 하단에 최대 200건 단위 이전·다음과 현재/전체 page 표시
- 검색·정렬·열조건의 현재 page 범위 명시, page ERROR 동일 page 재시도와 stale 응답 차단
- 같은 `#previewTable`에서 목록 → 원전표 추적 → 명시적 후보 선택 → read-only 영향 미리보기 전환
- 정확 코드/품명 참고 후보 구분 및 `자동확정 아님` 표시
- 공식재고 null을 `— · 미반영`으로 표시하고 입력수량 0과 분리
- 회사 범위, READY/EMPTY/ERROR, 링크 무결성, checkpoint 영향 상태 표시
- 기존 화면 상태의 진입/종료 보존
- manifest/아키텍처의 실제 소비관계와 rollback 최소 갱신

새 화면·전역 탭·독립 패널·팝업·라우트·메인 action·재매칭 command·공식 write·DB migration·Store는 추가하지 않았습니다. SmartInput 제품 UI는 변경하지 않았습니다.

## 검증

- repository validator 24/24, warning 0
- 단계 0~6A 전체 계약 회귀 PASS
- official write boundary/core, rematch boundary, independent recovery, client safety PASS
- 최신 OrderOps manager colors·다크 표 대비·인쇄 원점 browser E2E와 shipping cloud failure-injection PASS
- OrderOps 실제 101-order/279-inventory 회귀 PASS
- SmartInput 실제 Chrome 전체 E2E PASS
- 6B Chrome E2E: 코드/품명/0·양·음수/구매·판매/복수·손상 링크/회사 격리/EMPTY/ERROR/후보 선택/checkpoint 상태 PASS
- 201건 fixture의 2페이지 행 접근, 경계·재시도·stale 응답·상세 복귀 page 보존 PASS
- 기존 버튼·소스 탭·단축키·정상 클릭 수·desktop 측정치 동일
- light/dark/390px screenshot 및 내부 가로 스크롤/포커스 PASS; 6B documentScrollWidth는 최신 main baseline보다 증가하지 않음
- 외부 mutating request 0, fixture server write 0, production ORDER Q IndexedDB write 0
- 제품 UI raw ORDER Q Store 접근 0, 후보 선택 전 impact 호출 0
- `git diff --check` PASS

상세 증거: `evidence/smartinput-v2-phase6b/README.md`, `browser-evidence.json`, `screenshots/`

## Rollback

이 PR을 revert하면 `orderops` UI consumer와 manifest 소비자 등록만 제거됩니다. Phase 6A owner Read Adapter/Model과 기존 ORDER Q DB v7 자료는 그대로 유지됩니다.
