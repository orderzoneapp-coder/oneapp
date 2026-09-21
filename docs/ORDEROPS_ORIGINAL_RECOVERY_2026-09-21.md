# ORDER Q 원버전 복구 계약 — 2026-09-21

작업 ID: ORDERQ-ORIGINAL-RECOVERY-20260921-01
사용자 지정 운영 주소: https://oneapp.orderz.co.kr/orderops_list.html

## 승인과 범위

사용자는 개발기획안 v1.0에 대해 개발 진행 및 배포를 지시했다. 배포 후보의 부모는 SmartInput PR #641이 반영된 `209abc7248c809c7a4a48d5735d6e2eca74a8b8f`이다. 해당 SmartInput 변경을 그대로 보존한다. 저장소 전체 롤백은 하지 않는다.

업무 소스 변경은 루트 `orderops_list.html` 하나다. 나머지 변경은 두 회귀검사, 원버전 브라우저 CI, 기존 CI의 검사 대상 분리 및 본 계약 문서다. 앱 등록 ID·주소·권한·서비스·공통 저장 계약과 manifest는 변경하지 않는다.

원버전은 `13c83a23a330f3319ae67005f7ff0d67dfae4d54:orderops_list.html`을 복원하고 다음 두 모듈 주소만 고정한다.

- `/orderops/stable/20260917/orderFulfillmentEngine.js`
- `/orderops/stable/20260917/orderFulfillmentWorkbook.js`

복구 HTML SHA-256: `c677626e1dad60fe82305156fea1a8f9781b3dba5a1c0ed401201eb22ca7084a`.

고정 모듈은 위 과거 기준과 동일하며 수정하지 않는다. `/orderops/list.html`, 루트 최신 엔진·출력 모듈, 최신 Excel 준비 모듈, SmartInput, 공통 UI, 인증, 서버 및 업무 저장 자료는 변경하지 않는다. 기존 두 화면의 저장소 공유는 유지하며 데이터 격리나 이관으로 보고하지 않는다.

이 계약은 앞서 작성된 APP_ARCHITECTURE.md, app-manifest.json과 백업 복구 기록의 '최신 UI를 orderops_list.html에 유지'라는 당시 설명을 원버전 경로에 한해 대체한다. 기존 큰 문서나 앱 등록 구조를 다시 쓰지 않고 경로별 변경 이력을 이 문서에 명시한다.

## 업무 흐름과 검사

주문 Excel과 창고재고 Excel을 각각 선택한 뒤 출고분석 버튼 또는 Enter로 실행한다. 최신 매핑 패널의 양식 저장·적용은 실행 전제조건이 아니다. 잘못된 수량을 임의로 0으로 바꾸거나 검증을 해제하지 않는다. 파일 읽기 실패 시 기존 작업을 보존한다.

`test-orderops-original-recovery.mjs`는 실제 루트 HTML 및 두 고정 모듈 일치, 기준 계산 36개, 작업 보존 42개를 검사한다. 같은 스크립트의 `--modern`은 최신 UI HTML을 `67251bbb68b8cb12c1e70a88ae8cd326aa0807eb` 이력에서 임시 검사 폴더로 가져와 현재 최신 모듈 및 기존 검사를 실행한다. 최신 기능의 소스·검사를 삭제하거나 skip하지 않으며 별도 운영 페이지도 만들지 않는다. 이 격리 검사는 원버전 화면 성공을 대신하지 않는다.

`test-orderops-original-recovery-browser.py`는 수정하지 않은 후보 HTML을 Chromium에서 읽고 파일 입력 양쪽 순서, 버튼·Enter, 수량 7 편집, IndexedDB 저장, 새로고침·복구, XLSX 다운로드·재열기, 실패 보존, 160/30행 증감, 저장 설정 보존을 검사한다. 공개 CI는 합성 자료만 쓰고 외부 POST/PUT/PATCH/DELETE를 차단한다. 실제 사용자 Excel이나 인증 토큰은 커밋·업로드하지 않는다.

이전 로컬 검산은 실제 첨부 주문 115행·재고 297행, 수량 산술 통제값 324.5·2063, 미매칭 상품 21개, 샘플 잔량 6·4·4를 확인했다. 로컬 Chromium은 실행 환경 정책에 막혔으므로 그 결과를 브라우저 통과로 보고하지 않는다. PR 및 운영 검사 결과는 실제 실행 로그와 아티팩트로 판정한다.

## 배포와 되돌리기

해당 PR의 검사 통과 후 병합한다. Pages 배포 성공과 운영 HTML 일치를 별도로 확인한다. Pages 배포 뒤 read-only workflow를 `verify_live=true`로 실행하면 허용된 운영 주소에서 격리된 합성 자료로 같은 브라우저 검사를 수행한다. 사용자 브라우저·Cloud 자료는 접근하거나 초기화하지 않는다.

주문·재고 유실/중복/계산 오류, 기존 저장 구조 변경 필요, 지정 URL의 실행·복구·출력 실패가 확인되면 완료로 보고하지 않는다. 롤백은 해당 복구 커밋의 코드만 revert하며 데이터 삭제·과거화는 하지 않는다. 복구 전에도 문제가 있었으므로 코드 revert를 업무 정상화로 단정하지 않는다.

준비 브랜치 `chat/orderops-original-recovery-20260921`의 임시 bootstrap workflow는 이번 최종 변경에 포함하지 않는다. 최종 병합 SHA와 배포 상태는 PR 및 Pages 기록이 기준이며, 본 문서 생성 자체는 배포 완료 증거가 아니다.
