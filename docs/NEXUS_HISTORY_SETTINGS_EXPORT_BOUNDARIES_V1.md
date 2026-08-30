# NEXUS History · Settings · Export 역할 경계 이관 기록 v1.0

- 작업 ID: `DEC-021-HISTORY-SETTINGS-EXPORT-20260831`
- 상태: 구현·로컬 검증 완료, `main` 병합 후 GitHub Pages 운영 검증 대상
- 결정 기준: 사용자 제공 개발명세 `FINAL`, DEC-021
- 착수 기준: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md` v2.1.15, `app-manifest.json` v1.3.4
- 실행 기준 커밋: `e6edac94fd419abe25d1cab81df57e418704ab8e`
- 변경 후 아키텍처/manifest: v2.1.16 / v1.3.5

## 개발 목적

History, Settings, Export가 편의상 공유 저장소를 직접 읽고 쓰던 구조를 해소한다. 각 화면의 업무 목적은 유지하되 데이터 원본의 소유권을 분명히 하고, 비소유 화면은 Snapshot 읽기·설정 전용 쓰기·파일 출력만 수행한다.

## 확정 역할

| 화면 | 허용 역할 | 금지 역할 | 소유 화면 이동 |
|---|---|---|---|
| History | 변경이력 Snapshot 조회, 메모리 병합, 현재 필터 결과 JSON/CSV 출력 | 변경이력·상품 원본 쓰기 | 없음 |
| Settings | 허용된 설정 키의 개별 저장, JSON/Cloud 설정 백업·원자 복원 | 상품 마스터, 변경이력, 파서 사전, 판매정지 상태 직접 변경 | 상품은 `Master.html`, 파서·정지는 `SmartParser.html` |
| Export | `merch_export_draft` 검토, 상품 Snapshot 참조, Excel/이미지 출력 | 상품 마스터·변경이력·revision 쓰기 | 초안 생성은 `MerchOps.html` |

## 계약과 안전장치

- 변경이력은 `ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1`의 `READY / EMPTY / ERROR / NOT_AVAILABLE` 상태로 읽는다. 클라우드 결과는 메모리에서만 합친다.
- Settings는 `ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1` 허용 목록만 저장한다. 전체 검증 후 preimage를 확보하고 쓰기 실패·사후검증 실패 시 자동 롤백한다.
- Settings Cloud 업로드는 read-before-write 병합으로 외부 최상위/중첩 필드를 보존한다. 알 수 없는 로컬 복원 키와 손상된 소유 설정은 거부한다.
- `parserDict_v870`, `parserCatalogWarehouseMap_v1`은 Settings UI 편집 대상이 아니라 백업·재해복구용 opaque payload로만 왕복한다.
- Export는 기존 IndexedDB만 읽고 없으면 새 DB를 만들지 않는다. 쓰기는 출력용 임시 키 `ONEAPP_IMAGE_DATA_TEMP`만 허용한다.
- `merch_export_draft` 배열 형상은 바꾸지 않았다. `merch_export_draft_meta`는 선택적 sidecar로 Product Snapshot revision과 초안 fingerprint를 기록한다.
- F9와 화면 버튼은 동일한 output-only handler를 사용한다. F10 이미지 출력 계약은 유지한다.
- Apps Script action과 서버 스키마 변경, 데이터 마이그레이션은 없다.

## 사용자 흐름 변경

- Settings에서 상품 엑셀 적용·복원·판매상태·파서 창고 매핑을 직접 처리하지 않는다. 화면의 소유 앱 이동 버튼을 사용한다.
- Export의 F9는 더 이상 상품을 적용하지 않고 검토한 Excel만 만든다. 상품 반영은 MerchOps F7 또는 상품관리에서 먼저 완료한다.
- Export 상단에 Product Snapshot 정상·비어 있음·읽기 실패·버전 차이 상태가 표시된다. 버전 차이가 있어도 기존 초안은 유지되고 출력만 가능하다.
- History의 JSON/CSV는 전체 데이터가 아니라 화면에 실제 표시된 필터 결과를 그대로 내보낸다.

## 로컬 검증 증적

- 전용 역할 계약: `scripts/test-history-settings-export-owner-boundaries.mjs` 통과
- 저장소 검증: `scripts/validate-repository.mjs` 24개 검사 통과, 경고 0
- MerchOps: `scripts/test-merchops-all.mjs` 16개 스크립트 통과
- SmartParser: `scripts/test-smartparser-all.mjs` 7개 스크립트 통과
- Master add/update: 필수 35개 시나리오 통과
- Export working XLSX: zero/false/blank 보존 및 master/baseline fallback 금지 통과
- 실제 브라우저 독립 실행: History, Settings, Export 모두 렌더링 및 console error 0
- 신규 저장소 상태: Export 빈 화면 정상 렌더링, 출력 전용 안내 표시, console error 0
- Settings 상품관리 소유 화면 버튼: `Master.html` 이동 확인

## 배포 및 롤백

- 배포: 변경 PR을 `main`에 병합하면 기존 GitHub Pages workflow를 사용한다.
- 운영 검증: 배포된 세 HTML과 관련 adapter의 byte SHA-256을 병합 커밋 파일과 비교하고, 세 URL의 렌더링·콘솔 오류를 재확인한다.
- 롤백: 병합 PR을 revert하여 실행 기준 이전 역할로 복귀한다. 서버 action·스키마·마이그레이션이 없으므로 별도 데이터 롤백은 필요하지 않다.
