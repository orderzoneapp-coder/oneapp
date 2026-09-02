# NEXUS-SI-V2-06B 검증 증거

## 기준과 사전 확인

- 갱신 기준 `origin/main`: `b126b298a18671942a70d8ae2ae53d1b25234fcb` (PM 지정 SHA와 일치)
- 최초 구현 기준: `79cf742f5ff4afb5174337dadee552e14948c0a6`; 두 차례 main 전진 후 최종 갱신 기준으로 단일 커밋을 rebase했다.
- 브랜치: `codex/nexus-si-v2-06b-unresolved-review-ui`
- 독립 worktree: `C:\Users\USER\Documents\GitHub\oneapp-nexus-si-v2-06b-unresolved-review-ui`
- 원본 `C:\Users\USER\Documents\GitHub\oneapp` main checkout의 수정·미추적 파일은 확인만 했고 수정·정리·reset하지 않았다.

착수 전에 다음 기준을 직접 읽었다.

| 기준 | 착수 시 버전/상태 | 이 작업의 목표 |
| --- | --- | --- |
| `AGENTS.md` | 2.3.4, 2026-08-30 | 사용자 승인 단일 목적·독립 worktree·검증·Draft PR 경계 준수 |
| `roles/DEVELOPER.md` | 별도 버전 표기 없음 | 승인 범위만 구현하고 병합·배포하지 않음 |
| `APP_ARCHITECTURE.md` | 2.1.27 | 실제 6B 소비관계와 rollback만 2.1.28로 최소 반영 |
| `app-manifest.json` 및 내장 schema/policy | 1.3.8 | 기존 schema를 바꾸지 않고 `orderops` 소비자 등록과 contract rollback만 반영 |
| `orderq/ARCHITECTURE.md` | 0.8.7 / 6A | U1 A 승인 소비관계를 0.8.8 / 6B로 반영 |
| `orderops/list.html` 제품 표시 | ORDER Q v1.55 | 공개 상호작용 버전과 기존 정상 계약을 v1.55로 유지 |
| 상위 개발명세 파일명 v2.0 | 내부 문서버전 2.1 | 검수·영향 미리보기만, write/command 금지 |
| 개발로드맵 파일명 v1.0 | 내부 문서버전 1.1 | 6B 단일 목적, 6C/7/Pilot/Cloud 제외 |
| 개발이슈 처리기록 | 6A merge와 U1 A 승인, 6B 착수 기록 | 승인 위치·금지사항 유지 |

규범 충돌은 없었다. 최초 착수 기준 `79cf742f...` 뒤 PR #486의 `47de9102...`, 이어 OrderOps manager colors/print 보완이 포함된 `b126b298...`로 main이 전진했다. PM 지시에 따라 같은 단일 6B commit을 최종 기준 위로 rebase했으며 충돌은 없었다. 최신 main의 공통 다크 헤더·아이보리 Light 토큰·셀 위계, 공통 CSS `v1.3.5`, manager 행 가장자리·라벨·집계 배지 색상, 다크 표 대비와 인쇄 원점을 그대로 보존한 상태에서 전후 비교와 전체 회귀를 다시 수행했다.

## 구현 결과

- 현재: 6A owner Read Model/Adapter는 있었지만 제품 UI 소비자가 없었다.
- 목표: `orderops/list.html`의 기존 `#resultsPanel`/`#previewTable`와 검색·정렬·열 조건 렌더러 안에서만 `미매칭` 상태를 소비한다.
- 회사 범위는 NEXUS 세션의 `companyId`를 필수 전달하고, 세션이 없는 기존 독립 실행 호환은 기존 SmartInput과 같은 `ONEAPP` 기본 회사 범위를 사용한다.
- 제품 UI 모듈은 `unresolved-review-read-adapter.js`만 import한다. raw Repository·Store·DB handle을 열지 않는다.
- 상세는 확정 당시 상품정보, 창고, 업무일자, 입력/부호수량, 공식재고 `— · 미반영`, 미반영 부호수량, 문서/행/Revision ID, 검증된 기존 전표 추적 URL과 링크 무결성을 표시한다.
- 후보는 정확 코드와 품명 참고를 분리하고 모두 `자동확정 아님`으로 표시한다. 선택 전 impact 호출은 0회다.
- 명시적 radio 선택 뒤에만 read-only impact를 호출하고 `APPLY_READY`/`DECISION_REQUIRED`/`REVIEW_REQUIRED`를 쉬운 한국어와 원 enum으로 함께 표시한다.
- `EMPTY`는 `미매칭 자료 없음`, `ERROR`는 `조회 실패 · 재시도 필요`로 분리한다.
- 6A의 최대 200건 page 계약을 그대로 사용해 현재/전체 페이지와 이전·다음을 제공한다. 검색·정렬·열조건은 `현재 페이지 자료에만 적용`됨을 화면에 명시한다.
- 페이지 이동 중 요청 page를 표시하며 ERROR 재시도는 같은 page를 다시 요청한다. 목록→상세→목록은 현재 page를 보존하고 종료·재진입 또는 더 최신 요청 뒤의 stale 응답은 폐기한다.
- 새 상위 화면·전역 탭·독립 패널·팝업·라우트·메인 작업 버튼·적용/확정 action은 없다. SmartInput HTML/CSS/제품 JS는 content-identical이다.

사용자 단계와 클릭 수:

1. 기존 주문·재고 파일을 선택하고 `출고분석`을 실행한다. 기존 정상 흐름은 기준/변경 후 모두 3클릭이다.
2. 기존 결과 필터 줄의 `미매칭`을 누른다. 목록 진입 +1클릭이다.
3. 행의 `원전표·후보 보기`를 누른다. 상세 +1클릭이다.
4. 후보 radio를 명시적으로 누른다. read-only 영향 미리보기 +1클릭이다.
5. `미매칭 닫기`, 기존 F5/F6/F7 또는 기존 소스 카드를 사용하면 원래 검색값·규격 선택·스크롤·활성 화면·포커스·출력 버튼 상태가 복원된다.

201건 이상이면 같은 결과 영역 하단의 `이전`·`다음`으로 이동한다. 201건 fixture에서는 1페이지 200건과 2페이지 1건을 표시하며 201번째 행의 상세까지 접근한다.

## 검증 결과

- repository validator: 24 checks, 0 warnings
- 단계 0~6A: baseline, official write boundary/core, V2 3/4/5, rematch boundary, 6A Read Model/adversarial, 6A UI unchanged 모두 PASS
- independent recovery, client safety, OrderOps operations regression 모두 PASS
- 최신 OrderOps manager colors·다크 표 대비·인쇄 원점 실브라우저 E2E와 shipping cloud failure-injection PASS
- 실제 OrderOps 회귀: 실제 101-order/279-inventory 파일 PASS
- 실제 SmartInput Chrome 전체 E2E: desktop/light/dark/390px, 독립복구, 단계 5 dialog와 공식 저장 진입 회귀 PASS
- 6B 정적/실브라우저 E2E: 코드만·품명만·코드+품명, 0/양수/음수, 구매/판매, 복수 링크, 손상 링크, 회사 격리, EMPTY/ERROR, 후보 비자동확정, checkpoint 세 상태 PASS
- 201건 fixture: 1/2페이지 경계, 2페이지 ERROR와 동일 page 재시도, 201번째 행 접근, 상세→2페이지 복귀, 이전 page stale 응답 폐기 PASS
- 기준/변경 후 기존 button ID, 소스 role-tab, F2~F10 shortcut, desktop `sourceSelector`/`resultsPanel`/`previewTable` 측정치가 동일하다.
- 390px outer viewport(브라우저 scrollbar 제외 content 375px)에서 최신 main baseline `documentScrollWidth=1171` 대비 6B 비활성/목록/상세는 모두 `375`로 증가하지 않았다. 결과 패널은 357px이고 목록 내부 표는 353px/980px, 상세 표 내부 가로 스크롤과 후보 키보드 포커스는 `true`다.
- `git diff --check` PASS.

격리 증거는 [browser-evidence.json](./browser-evidence.json)에 있다.

- warm 로컬 결과 표시 전 review Adapter 호출 0, impact 호출 0, ORDER Q DB open 0
- 제품 UI의 ORDER Q DB open 0, ORDER Q `readwrite` transaction 0
- 실제 외부 mutating request 0, fixture server write 0, production ORDER Q IndexedDB write 0
- impact 호출은 후보 선택 후 정확히 1회이며 모든 호출 `companyId=COMPANY-A`
- 다른 회사 표식과 raw 오류 detail의 DOM·로그 노출 0

시각 증거:

- [light](./screenshots/orderops-unresolved-review-light.png)
- [dark](./screenshots/orderops-unresolved-review-dark.png)
- [390px](./screenshots/orderops-unresolved-review-mobile-390.png)
- [201번째 자료·2페이지](./screenshots/orderops-unresolved-review-page-2.png)

## 소유권, rollback, 남은 위험

- 데이터/Adapter 소유자: `orderq-vnext` / shipping-operations
- 제품 소비자: `orderops`; UI는 Read Adapter 결과만 소유하며 ORDER Q raw Store를 소유하지 않는다.
- rollback: `orderops/unresolved-review-ui.js`, `orderops/list.html`의 6B 상태 분기, manifest의 `orderops` 소비자 등록을 함께 revert한다. 6A owner 자산, 기존 ORDER Q DB v7 자료와 SmartInput 작업본은 유지한다.
- 6A 계약의 page 상한 200건은 유지하며 UI 이전·다음으로 모든 page에 접근한다. 검색·정렬·열조건은 전체 자료가 아닌 현재 page 범위이고 전역 검색 엔진은 추가하지 않았다.
- 공통 NEXUS 모바일 nav는 기존대로 자체 수평 rail을 사용한다. 6B 결과 패널은 viewport 안에 유지되고 긴 전표/Revision 표는 결과 영역 내부 가로 스크롤로만 이동한다.
- 이 작업은 재매칭 command, 적용/확정, DB schema/migration, Store 추가, Pilot/Cloud 활성화를 의도적으로 포함하지 않는다.
