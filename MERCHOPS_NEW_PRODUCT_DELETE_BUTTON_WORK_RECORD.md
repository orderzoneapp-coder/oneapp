# MO-20260904-01 신규상품 삭제 버튼

- 분류: 빠른 처리
- 사용자 지시: "일단 상품삭제 버튼먼저 만들어 실행해"
- 기준 저장소: `https://github.com/orderzoneapp-coder/oneapp.git`
- 기준 SHA: `13b7738c766a8201c716691ec708804c22f06b5c`
- 작업 브랜치: `codex/merchops-new-product-delete-20260904`
- 작업 경로: `C:\Users\USER\Documents\ChatGPT\검증 PM\work\oneapp-merchops-new-product-delete-20260904`
- 확인 문서: `AGENTS.md` v2.3.4, `APP_ARCHITECTURE.md`, `app-manifest.json`, `roles/PM.md`, `roles/DEVELOPER.md`

## 목적과 범위

- Excel 불러오기 후 미등록 상품 검토 화면에서 `상품 삭제`를 즉시 실행할 수 있게 한다.
- 선택 행이 있으면 선택 행만, 없으면 현재 표시된 미등록 상품 전체를 현재 MerchOps 작업에서 제거한다.
- 미등록 상품이 모두 제거되면 신규등록용 양식을 자동 종료하고 남은 기존상품 업무 화면으로 복귀한다.
- 제거 행은 기존 세션 제외목록에 보존해 사용자가 복구할 수 있게 한다.

## 변경 금지

- 상품 master, Product Snapshot, 원본 Excel, 변경요청 Inbox와 다른 앱의 데이터를 삭제하지 않는다.
- 상품 소유권, F7/F8/F9, 저장소 schema와 Adapter 계약을 변경하지 않는다.
- 기존 일반 `제외` 동작을 제거하거나 의미를 바꾸지 않는다.

## 완료 조건

1. 신규등록용 하위 작업줄에 `상품 삭제` 버튼이 표시된다.
2. 삭제 전 대상 수와 영향 범위를 확인한다.
3. 현재 작업행만 제거되고 원본 Excel·상품 master는 불변이다.
4. 남은 미등록 상품이 0건이면 기존 업무 화면으로 자동 복귀한다.
5. 관련 MerchOps 회귀검사와 저장소 검증이 통과한다.
