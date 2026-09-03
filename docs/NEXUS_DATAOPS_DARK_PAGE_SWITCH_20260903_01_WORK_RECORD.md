# NEXUS-DATAOPS-DARK-PAGE-SWITCH-20260903-01 작업 기록

- 분류: 빠른 처리 화면모드 결함 수정
- 사용자 승인 원문: `수정 업데이트해`
- 기준 `origin/main`: `ab0f6020ea98cf1c14160c1cfa1745fbe9116dbb`
- 브랜치: `codex/dataops-dark-page-switch-a11y-20260903`
- worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-darkmode-soft-surfaces-20260902`
- 시작 상태: clean
- 적용 규범: `AGENTS.md` v2.3.4
- 적용 아키텍처: `APP_ARCHITECTURE.md` v2.1.30
- 적용 Manifest: `app-manifest.json` v1.3.9
- 역할 규범: `roles/DEVELOPER.md`

## 목적과 경계

DataOps의 고정 `bg-[#f8fafc]` 페이지 wrapper 3개가 다크모드의 graphite 배경을 덮는 결함을 수정한다. 공통 화면모드 스위치는 외부 클릭 영역을 44×44px로 확장하되 기존 42×28px track과 해·달 아이콘 배치를 유지하고, 접근성 이름을 `다크모드`로 고정한다. DataOps 작업판·테이블·버튼·업무 흐름과 SmartInput 개별 디자인, 데이터·저장·계산 계약은 변경하지 않는다.

## 구현

- DataOps 전용 exact selector가 고정 Tailwind 배경을 공통 `--nexus-ui-page-bg`로 치환한다.
- 공통 스위치 외부 hit target은 44×44px, 내부 track은 42×28px로 분리했다.
- 스위치 `aria-label`은 상태와 무관하게 `다크모드`로 고정하고, `aria-checked`는 현재 상태, `title`은 다음 동작을 표현한다.
- 실제 브라우저에서 native button의 Enter·Space가 각각 정확히 한 번 전환됨을 확인했으므로 별도 `keydown` 코드는 추가하지 않았다.
- 공통 자산 cache-bust는 `nexus-ui.css` 1.3.5, `nexus-ui-app-themes.css` 1.3.9, `nexus-ui.js` 1.4.2로 갱신했다.

## 검증

- NEXUS common UI recovery contracts: 18개 페이지 통과
- NEXUS basic login/home contracts: 16개 업무 앱 통과
- DataOps complete contract suite: 24/24 통과
- Phase 6B approved-base UI 정적·브라우저 검증: 통과, SmartInput 승인 화면 해시 변경 없음
- repository validation: 24개 검사, 경고 0건
- 실제 브라우저 E2E: DataOps light ivory / dark graphite wrapper 3개 일치, 직접 해·달 버튼과 중앙 스위치 마우스 전환, Enter·Space 단일 전환, 44×44 hit target, 42×28 track, focus outline, 새로고침 유지, 1920/1440/390 화면 폭, console/runtime error 0건 통과
- `node --check`: 공통 런타임 및 변경 테스트 통과
- `git diff --check`: 통과

## 롤백

병합 전에는 이 브랜치를 폐기한다. 병합 후에는 해당 merge commit을 `git revert`하여 DataOps 배경 selector, 공통 스위치 계약, 캐시 버전과 회귀 테스트를 함께 되돌린다. 사용자 데이터 생성·변경·삭제는 없다.
