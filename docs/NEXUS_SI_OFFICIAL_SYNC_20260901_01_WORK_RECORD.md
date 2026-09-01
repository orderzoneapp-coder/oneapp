# SmartInput 공식 전표 백그라운드 동기화 V1 작업기록

- 작업일: 2026-09-01
- 기준 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md` v2.1.18, `orderq/ARCHITECTURE.md` v0.7.1, `app-manifest.json` v1.3.7
- 기준 `origin/main`: `ef6f60bc8e7599eaf56356573553abb0e2bf415d`
- 브랜치: `codex/smartinput-official-sync-v1`
- 워크트리: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-official-sync-v1`
- 시작 상태: clean, 사용자 작업 변경 없음

## 현재 상태와 목표 상태

현재 구매·판매 공식 전표는 IndexedDB의 전표·재고·채권·채무를 한 transaction으로 확정하지만 `syncQueue`에는 `WAITING_SERVER_CONTRACT`로만 남는다. 기존 `ONEAPP_ORDERQ_SYNC_V1` 서버와 구버전 클라이언트가 신규 전표 entity를 해석하지 못하기 때문이다.

목표는 로컬 확정 속도와 독립 실행을 유지하면서 공식 전표 명령과 미매칭 상품 재고해결 명령을 회사별로 백그라운드 동기화하는 것이다. 서버는 전표별 현재 Revision과 최초 상품 매칭을 검사하며, 충돌 시 어느 쪽도 자동 덮어쓰지 않는다.

## 확정 범위

- 기존 주문 동기화와 별도인 `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1` Push/Pull 계약
- 회사별 서버 분리, 회사별 독립 Pull cursor
- 공식 전표 command ID 멱등성, immutable payload, 전표 Revision optimistic lock
- 미매칭 상품은 동일 시스템 ID당 최초 확정 상품만 허용
- 긴 전표 payload의 Google Sheet 셀 제한 대응
- 원격 명령을 전표·재고·채권·채무·Revision에 한 로컬 transaction으로 적용
- 기존 `WAITING_SERVER_CONTRACT` 행의 무손실 재사용
- SmartInput 저장 완료 후 비차단 백그라운드 Push/Pull 및 앱 진입 후 Pull

## 금지·보존 범위

- 직접입력·Excel·검색·초안·로컬 확정은 서버 응답을 기다리지 않는다.
- 기존 `ONEAPP_ORDERQ_SYNC_V1`의 sheet, cursor와 구버전 동작을 바꾸지 않는다.
- 서버 변경이 활성 작업본을 자동 덮어쓰지 않는다.
- 충돌을 자동 병합하거나 최신 시각만으로 승자를 정하지 않는다.
- 기준정보 원본, 기존 ERP 코드와 재고실사 정책은 변경하지 않는다.

## 완료조건

- 동일 command 재전송은 한 번만 반영된다.
- 두 기기가 같은 전표 Revision을 수정하면 첫 서버 반영만 성공하고 나머지는 충돌로 보존된다.
- 회사 A의 Pull에서 회사 B 전표가 노출되지 않는다.
- 원격 구매·판매 명령이 로컬 전표·재고·채권·채무를 동일 결과로 만든다.
- 서버가 없거나 구버전이어도 로컬 전표 확정은 성공하고 대기행은 유지된다.
- 관련 회귀, Apps Script 모의 실행, 브라우저 E2E, 저장소 CI를 통과한다.

## 배포 경계

GitHub Pages와 저장소 소스 병합은 Apps Script 운영 배포를 대신하지 않는다. 서버 소스 반영 후에도 bound Apps Script Web App 새 버전 배포와 실제 회사 A/B 기기 검증 전까지 운영 권위는 로컬이며, 클라이언트는 실패한 백그라운드 전송을 대기 상태로 유지한다.

## 구현 결과

- 서버: 기존 `ONEAPP_ORDERQ_SYNC_V1`과 분리된 `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1` Push/Pull 및 전용 4개 Sheet를 추가했다.
- 서버 저장: command/resolution JSON을 SHA-256으로 검증하고 40,000자 단위 최대 100개 셀로 분할한다.
- 서버 충돌: 회사·전표별 head는 `expectedRevision`, 미매칭 상품 head는 최초 `productId`를 기준으로 경쟁 쓰기를 거절한다.
- 서버 복구: payload 또는 head 저장 후 meta 기록이 끊긴 경우 다음 요청이 head의 meta를 먼저 복구한 뒤 다음 Revision을 처리한다.
- 클라이언트: 기존 `WAITING_SERVER_CONTRACT`를 재작성하지 않고 새 서버 계약으로 전송하며 성공은 `ACKED`, 경쟁 쓰기는 `CONFLICT`로 기록한다.
- 원격 적용: 공식 command를 다시 계산해 projection digest를 확인한 뒤 전표·행·재고효과·채권/채무·Revision·command receipt를 한 transaction으로 저장한다.
- 회사 분리: Push/Pull 요청, 서버 저장 복합키·meta와 local cursor가 모두 `companyId`를 기준으로 분리된다. 다른 회사가 같은 원시 command ID를 사용해도 별도 전표로 저장되며 queue ID의 회사 간 재사용은 거절한다.
- UX: SmartInput 저장은 서버 응답을 기다리지 않는다. 앱 준비 후와 공식 전표 저장 직후 background sync를 예약하고 충돌만 비차단 경고한다.
- 관리 화면: 일반 주문 충돌과 공식 전표 충돌을 분리해 공식 충돌에 주문 `최신본 적용` 동작이 잘못 노출되지 않도록 했다.

## 검증 기록

- `scripts/test-orderq-cloud-atomicity.mjs`: token, command 재전송, entity 재전송, 같은 Revision 경쟁, 85,000자 payload, 상품 최초 매칭, 회사별 Pull 및 동일 entity ID 격리 통과
- `scripts/test-orderq-vnext-cloud-contract.mjs`: 별도 schema/action/sheet/cursor/클라이언트 적용 경계 통과
- `scripts/test-orderq-official-voucher-mvp-core.mjs`: 금액·Revision·재고·AR/AP·미매칭 규칙 통과
- `scripts/test-orderq-inventory-rematch-boundary.mjs`: 실사 경계 통과
- `scripts/test-smartinput-browser-e2e.mjs`: 기존 대기행 Push/ACK, 회사 전달, 원격 공식전표 원자 복제, 원격 미매칭 재고해결 멱등성 통과
- `scripts/validate-repository.mjs`: manifest·파일·계약 검증 통과
- SmartInput·ORDER Q 관련 회귀검사 26종과 desktop/mobile 보호 브라우저 E2E 통과

## Rollback

- 클라이언트 연결을 되돌려도 IndexedDB v7과 `WAITING_SERVER_CONTRACT`/`ACKED`/`CONFLICT` 행은 삭제하지 않는다.
- Apps Script는 새 action을 호출하지 않는 구버전과 호환된다. 서버 rollback 시 신규 action이 실패해도 로컬 확정과 기존 주문 동기화는 유지된다.
- 운영 Apps Script 배포 전에는 GitHub Pages만 병합돼도 서버 동기화 완료로 판정하지 않는다.
