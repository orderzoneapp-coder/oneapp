# SmartInput 3단계 실행 기록

기준: main 732e2922, PR #599 기존 head 1d245129, 최신 단일 명세 v3.2의 3단계(v2.3). 사용자 승인: “3.4단계 이어서 배포까지”, “계속 진행해”. 4단계는 #599 반영 후 #600으로 순차 통합한다.

## 구현
- 재확보한 native 검증 소스와 실제 앱 진입점을 연결했다. 독립 견적서 ownedRows/ID/F8 유지, 단일 선택 목록, 순서 독립 Excel, 선택 대상만 저장, 마지막 회차 제외 결과/필터, 견적별 미저장 작업 V2 journal 보존.
- `estimate-workspace.js`는 대상 선택·매칭 검토·CAS·재시도와 마스터 intent를 조정한다. `estimate-migration.js`는 기존 v5 자료의 고정 백업과 보고서 동등성 검증을 담당한다.
- `product-master-command-adapter.js`와 `coreEngine.js`는 기존 owner 경계에서 허용된 가격 필드와 durable receipt를 원자적으로 반영한다. 인증/회사 불확실성은 마스터만 차단한다.
- DB 버전 5와 기존 stores를 유지한다. v6/조합 저장/연동 원본 연쇄 업데이트 기록은 폐기한다.

## 검증과 배포 판정
- 로컬: 선택/CSV/초기화 후 마지막 제외 결과, native IDB abort/CAS, 백업·같은 ID 전환·재실행 후 편집 보존, owner 응답 소실 후 동일 명령 receipt 복구를 직접 검사했다.
- 삭제된 연동 탭·생성·연쇄 변경과 파괴적 F8 복구를 요구하던 browser assertions만 새 사용자 정책 검사로 교체했다. 나머지 공통 업무/입력/모바일/보고서 검사는 유지한다.
- 명령: repository-validation.yml의 Node 명령과 `node scripts/test-smartinput-stage3-{plans,f8-baseline,storage-browser,workspace-browser,owner-browser,migration-browser}.mjs` 각각 실행. 최종 PR head·CI·배포 SHA는 실행 완료 후 이 기록에 추가한다.
- 개발자 채팅은 GitHub 쓰기 불가를 보고했고 후속 patch가 도착하지 않아 승인 범위 내 로컬 실행으로 이어갔다. 모델 설정 또는 독립 PM 검증 통과로 보고하지 않는다. 본 검사는 구현 담당자의 자체 검증이다.

## 보존/복구
아키텍처의 3단계 호환 복구 경로를 따른다. 운영 사용자 DB를 자동 전환하거나 테스트용으로 변경하지 않는다. 기존 전환은 관리자 백업·회사 확인 후 실행한다. 업무검수는 사용자 담당이며 실제 저장/배포 상태와 구분한다.
