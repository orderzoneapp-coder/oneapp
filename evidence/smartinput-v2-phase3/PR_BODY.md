## 작업

- NEXUS-SI-V2-03: SmartInput 공식 쓰기 경계의 숫자 변환 전 preflight, 확정 행 Snapshot, 회사/판매그룹 범위 ID V2
- Gateway/Repository 이중 검사: 회사, 명령 형식, identity version, commandId=idempotencyKey, payload, expected Revision, 문서/행/그룹 범위
- 구매/판매 V2 feature gate 독립/default-off; 기존 V1 경로와 UI 비활성 상태 유지

## 검증

- G3-P: `evidence/smartinput-v2-phase3/G3-P.md`
- G3-S: `evidence/smartinput-v2-phase3/G3-S.md`
- 전체 기록: `evidence/smartinput-v2-phase3/README.md`
- 순수 계약, 단계 1/2 baseline, SmartInput 관련 회귀, 저장소 validator, client safety PASS
- 격리 실제 브라우저: 직접입력/Excel 붙여넣기/작업본 복구/구매/판매/일반/다크/모바일 PASS
- 구매·판매 동일 retry 효과 1회, 변경 payload/Revision/identity/company 충돌 차단, 각각 transaction rollback 후 부분 효과 0
- DOM/단축키 동일, 구매·판매 클릭 수 각각 6→6, 실제 외부 변경 요청 0, console error 0

## 범위 통제

- HTML/CSS/버튼/단축키 변경 없음
- 단계 4 재고·미매칭·거래처/채권채무 정책, 단계 5 실사 선택, 단계 7 수정·취소 미구현
- Cloud/Apps Script/운영 데이터/V1 migration/단위환산/Pilot 변경 없음

## Rollback

- V2 gate 기본 OFF 유지 후 이 PR의 commit을 revert한다.
- DB version/migration/운영 데이터 변경이 없어 데이터 복구 작업은 없다.

Draft 제출입니다. PM 승인 전 Ready 전환·병합·배포·Pilot 활성화를 금지합니다.
