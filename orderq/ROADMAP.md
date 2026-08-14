# ORDER Q vNext 개발 로드맵

Version: 0.7.0
Date: 2026-08-14

## 기본 원칙

- 기존 `orderops/` 및 루트 `orderops_list.html` 소스는 변경하지 않는다.
- 신규 ORDER Q는 `/orderq/` 경로에서 독립 구축한다.
- 주문 데이터의 중심키는 `customerId`, `orderId`, `orderItemId`다.
- 원문/파서 예상/매칭 결과/관리자 확정/업무 반영값을 구분한다.
- 매칭실패가 있어도 매칭완료 상품의 처리를 막지 않는다.
- 주문 수정·취소는 삭제가 아니라 Revision/Event로 보존한다.
- 로컬은 IndexedDB, 클라우드는 Sync Adapter를 거쳐 연결하고 추후 Server API/PostgreSQL로 교체 가능하게 한다.

## 1단계 — 독립 기반 + 수기 주문 Vertical Slice [완료]

목표: 새로운 URL에서 공통 주문원장이 실제 동작하는 최소 완성 흐름을 만든다.

- `/orderq/index.html` 신규 주문현황
- `/orderq/input.html` 신규 수기 주문서
- IndexedDB `oneapp-orderq-vnext` 구축
- Customer / Order / OrderItem / Event / Mapping / SyncQueue 스키마 생성
- Order Intake Engine 구축
- 신규 주문 저장
- 주문서 재접속 및 수정 저장
- 취소 처리
- `revision` 기반 동시수정 충돌 차단
- 매칭완료/매칭실패 상품을 같은 주문에 함께 저장
- 매칭실패 때문에 주문 전체 저장을 차단하지 않음
- 클라우드 동기화를 위한 `syncQueue` 적재
- v0.4.2: 공통 상품 마스터 검색·후보 선택·기본정보 자동입력, 직접입력 미매칭 저장
- v0.4.3: 거래처 우선 포커스, 출하창고·거래유형 기본값 복구, 전표/상품 메모 구분, 6자리 카테고리 코드순 후보, 출고가 단가 자동입력
- v0.4.4: 빈 수기주문 행은 매칭 상태를 숨기고 상품 식별값 입력 후에만 매칭 결과 표시
- v0.4.5: 수기주문 화면 폭을 1,100px로 제한하고 상품 정보·주문 입력·확인 묶음으로 고정 배분하며 선택 열·체크박스를 축소
- v0.4.6: 박스당수량·단위 공식명칭, 수량·단가·수정가능 합계, 선택형 부가세 열, 품목코드 전용 검색, Enter 입력 동선·자동 행추가, 코드·품명·단위 정렬 적용
- v0.4.7: 단가 셀 ▲▼·키보드 화살표로 마스터 판매단가 항목 순환, 단가 항목명 동시 표시, 직접입력 구분과 `priceType` 저장 적용
- v0.4.8: 단가명을 행에서 헤더 드롭다운으로 이동, 판매가를 기본값으로 추가하고 행사가 우선·출고가 대체 규칙 및 전체 단가열 전환 적용
- v0.4.9: 주문표 열 끝선 드래그 너비 조정·명시적 저장·다음 접속 복원, 일자 일(day) 자동 선택과 위·아래 화살표 하루 증감 적용
- v0.6.0: 주문서 입력→주문현황 전표관리→ORDER Q 운영관리로 화면 책임 분리, 관리자 주문번호 자동발급, 주문·관리자·운영상태 분리, 전표 담당자와 변경이력, 저장 전표 자동 펼침, 일반 인쇄·카카오톡 PNG 복사, 쇼핑몰 결과값 보존 적용
- v0.6.1: 직접입력 주문은 관리자상태 `확인`, ORDER IN·Excel·쇼핑몰·외부연동 주문은 `미확인`을 초기값으로 적용

완료조건: 같은 브라우저에서 신규 주문 → 목록 확인 → 주문서 재접속 → 수정 → 충돌 검증 → 취소가 동작한다.

## 2단계 — Google Sheet Cloud Sync [완료]

- 기존 ONEAPP 공통 Cloud URL을 사용하는 ORDER Q vNext Cloud Adapter 분리
- 목적별 시트 자동 생성
- ORDER / ORDER_ITEM / ORDER_EVENT
- CUSTOMER_MASTER / CUSTOMER_ALIAS_MAPPING
- PRODUCT_MAPPING / UNIT_MAPPING / MAPPING_EVENT
- SYNC_META
- `ONEAPP_ORDERQ_SYNC_V1` 증분 Push/Pull 계약
- 각 브라우저 Device ID + 서버 Sequence Cursor
- `queueId` 기반 재전송 중복방지
- `orderId + revision + baseRevision` 기반 기기간 충돌 검증
- 먼저 저장된 revision 우선, 후 저장 자동 덮어쓰기/자동 병합 금지
- 클라우드 장애/미설정 시 로컬 저장 유지 + SyncQueue 재시도
- 충돌 시 로컬 입력 보존, 클라우드 최신본 확인/적용 후 재입력
- 1단계 기존 로컬 Customer/Alias/Event를 최초 동기화 때 SyncQueue로 보강
- 서버 전환을 고려한 `orderq-cloud-adapter.js` 계약 고정

완료조건: Apps Script에 `code.gs`와 `orderq-cloud.gs`를 같은 배포본으로 반영한 후 A/B 기기에서 주문 생성 → 수신 → 동시수정 → 먼저 저장 성공 → 후 저장 충돌 차단 → 최신본 적용을 실제 운영 URL에서 검증한다.

## 3단계 — 카카오/일반 텍스트 SmartParser [구현]

- `/orderq/parser.html` 카카오/일반 텍스트 입력·관리자 확정 화면
- 카카오 발신자/시간/여러 줄 메시지 Context 보존
- 주문/변경/취소/공지/정보/응답/판정불가를 상품 파싱보다 먼저 판정
- Customer Alias 정확일치 및 유사 후보 제시
- 품명/규격/속성/수량/원단위 역할 분리
- 거래처 매핑 → 거래처 주문이력 → 출처 매핑 → 공통 매핑 → 마스터 후보 순 탐색
- 높은 신뢰도만 자동매칭하고 낮은 신뢰도는 정상적인 매칭실패로 보존
- 원문과 관리자 확정값 분리, 확정 표현을 Product Mapping으로 선택 저장
- `sourceMessageKey` 고유 인덱스로 동일 메시지 중복 주문 차단
- 신규 주문은 기존 Order Intake Engine으로 처리
- 부분 변경·취소 메시지는 행 단위 병합 명세 전까지 자동 반영하지 않고 수기 검수 대기로 보존
- 주문 등록 후 기존 Cloud Sync를 통해 다른 기기로 전달

완료조건: 명세 fixture 회귀검사, 실제 브라우저 원문 분석·부분처리·중복차단·주문현황 반영, 운영 URL 배포를 검증한다.

## 4단계 선행 — 기초데이터 이력수집·주문↔판매 연결 [구현]

- `/orderq/collector.html` 독립 이력수집 작업공간
- 주문·판매·구매·재고·거래처원장 Excel 구조 우선 판별
- 카카오/일반 텍스트 과거 이력 수집(운영 주문 미생성)
- 파일 SHA-256, 행 지문, 원본행, 수집 배치, 감사·롤백
- 판매일 기준 전 영업일 주문과 당일 운영마감 전 추가주문 후보
- 부분·합산·지연·음수 판매를 보존하는 다대다 `allocatedQuantity` 연결
- 실제 판매 연결을 SmartParser 근거 후보로 축적하고 3개 날짜 이상 무충돌 후보를 관리자 확정 대상으로 승격
- ORDER Q Cloud 접근토큰과 주문 bundle 복구 transaction log

## 4단계 후속 — 매칭실패 집중 검수

- 매칭실패 집계
- 원문/대화 Context 유지
- 실패 항목 터치 → 후보/최근거래/마스터 검색
- 관리자 한 번 선택으로 매칭 완료
- 필요 시 `[계속 적용]` 짧은 확인
- 동일/유사 실패건 적용범위 표시 후 일괄 적용
- 거래처 별칭·상품 표현 사전 누적

## 5단계 — 주문서 이미지 OCR

- 텍스트형 주문 이미지 OCR
- 이미지 원본 보존
- 행/영역 구조화
- OCR 결과를 3단계 SmartParser Core에 전달
- OCR 오독 → 관리자 수정 → 별칭/매핑사전 누적

## 6단계 — ERP 거래처원장 / Transaction Intelligence

- ERP 판매현황은 거래처원장 기준 별도 구축
- 매핑DB와 ERP 원장을 Customer ID/Product ID로 연결
- 거래처별 최근성/빈도/반복상품/단위/상품군 Profile 생성
- 신규 거래처는 출처/유사군/공통정보를 보조 근거로 사용
- KPI: 거래처 자동식별률, 상품 1차 매칭률, 매칭실패율, 관리자 수정률, 주문서 자동완성률
