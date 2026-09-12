# SmartInput 3단계 기초 개발 기록 — 2026-09-13

## 기준과 승인

- 사용자 지시: “3단계 개발명세이다 검증하고 문제없으면 개발 진행해”.
- 요청 범위: 3A 일반 견적서 전환·선택 업데이트 + 3B 선택적 마스터 적용. 실제 업무 테스트는 사용자 담당.
- 첨부 명세: `SmartInput 최적화 3단계 개발명세` v2.0 (2026-09-13, 465줄). 명세 조사 main `686a768aaf9e04db77f26dd690ce2cfd421adb1a`.
- 개발 기준 main: `f90d5be0fe7f0941e147c28b04f427455355ebd7`. #596 저장 경합 수정과 앱 0.11.59, #595/#597 출고관리 변경을 보존한다.
- 이 PR은 **기초 개발 중인 draft**다. 3A·3B의 전체 구현/완료 판정/운영 배포가 아니다. 기존 entry point가 새 모듈을 import하지 않으므로 운영 동작은 바뀌지 않는다.

## 명세 검증 보완

1. v2.0 §10에 전체 immutable master command를 `estimateOperationsV1`에 **owner 발행 전에 영속 저장**하고 transaction 완료를 확인하는 조건을 명시한다. 이 조건은 이전 단일 명세 §9.4에 있었으며 `{enabled, selectedFields}` 저장만으로 대체하지 않는다.
2. 재접속/응답 유실/중복 실행은 같은 commandId와 payloadHash의 결과를 먼저 조회한다. 조회 실패는 미적용이 아니다. intent 저장 실패 때 owner를 호출하지 않는다.
3. master `UNCHANGED`도 같은 논리 작업의 terminal receipt로 보존해야 한다. master 값/revision/업무 이력을 증가시키지 않으며, 다른 앱의 이후 변경을 과거 명령 재실행 이유로 사용하지 않는다.
4. 회사/작업자 문자열 검사는 권한 확인이 아니다. 실제 session·회사 귀속·상품 정체성·출처·CAS 검증은 owner에서 별도로 수행해야 한다.

## 이번 구현

- `smartinput/independent-estimate.js`: 일반/연동의 순수 전환 후보, 안정 ownedRowId/displayGroup, 기존 ID·값·원문·수기/거래처 전체행 보존, 선택 허용목록, 정확 코드/조건 키, 공란/0/명시 clear, 확정 매핑 범위, 필드별 충돌 및 3-way work rebase 계획.
- 전환 결과는 CANDIDATE_READY와 requiresOutputVerification=true다. 이전값/ID/hash가 있다는 이유만으로 데이터 전환을 commit하거나 UI에 채택하면 안 된다.
- `smartinput/estimate-master-apply.js`: 네 허용 필드의 불변 명령 구성과 dependency-injected 사전 보존/발행/결과 조회/후속 이력 발행 재개. 실제 owner API 및 datastore와는 아직 연결하지 않는다.
- 신규 테스트: 계획/주입 23건, 기존 실제 F8 함수와 후보의 shopData/erpData/estimateUploadData/confirmData 비교 3건.
- 읽기 전용 전용 CI job으로 신규 검사만 등록한다. 기존 필수 repository CI는 변경하지 않는다.

## 직접 검증과 한계

격리된 main Git archive(703개 항목)의 중요 소스 blob을 원격과 대조했다. Node 22.16.0에서 아래를 직접 실행해 통과했다.

```text
node scripts/test-smartinput-stage3-plans.mjs               # 23/23
node scripts/test-smartinput-stage3-f8-baseline.mjs         # 3/3
node scripts/test-smartinput-estimate-f8.mjs
node scripts/test-smartinput-draft-save-coordinator.mjs     # 기존 + 저장 경합 6/6
node scripts/validate-repository.mjs                       # 24/24
```

이 검사는 실제 IDB 다중 transaction·탭 종료·v5/v6 migration·실제 session 권한·실제 UI 흐름의 검증이 아니다. 신규 F8 검사는 후보 ownedRows를 기존 출력 함수에 전달한 배열 비교이며, 운영 F8 호출 경로가 이미 전환됐다는 의미가 아니다. 개발자 자체 검증을 독립 PM 승인으로 표시하지 않는다.

## 미완료 — 병합/활성화 전 필요

- 3A: datastore v6, source 고정 snapshot·백업 및 내보내기, migration/선택 CAS+summary+mapping+receipt, 중단 재개, v6 호환 rollback.
- 3A: 실제 owner/template로부터 키를 준비하는 연결, 새 확정 매핑의 영속 저장, 기존 custom field 계약, workingCopies/baselines V2 journal, 선택·조합·저장·삭제·정보 변경 UI 및 실제 F8/조회 연결.
- 3B: 실제 컨텍스트/owner capability, Core의 좁은 transaction/CAS/receipt/canonical history 확장, UNCHANGED 영수증과 publication 재개, 실제 IDB 실패/응답 유실 검사, 결과 UI.
- 명세의 필수 데이터 보존/실패/복구 통합 사례를 통과하기 전 이 draft를 완료·병합·배포하지 않는다. 운영 데이터·공식 전표·마스터·설정은 변경하지 않았다.
