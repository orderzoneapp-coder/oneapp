# SmartInput Source Preparation UI

- 외부 파일 파싱·원본 열 매핑은 좌측 원본입력 패널에서 수행한다.
- 저장 양식과 정확히 일치한 Excel(`TEMPLATE_APPLIED`)은 파일을 읽는 순간 중앙 작업표까지 자동 projection된다. 추가 적용 버튼은 숨기고 `자동 반영 완료`로 표시한다.
- 저장 양식이 없는 신규 Excel(`NEW_TEMPLATE`)에서 열이 `RECOMMENDED`이면 targetFieldId가 있어도 확정된 `MAPPED`로 취급하지 않는다. `매핑 확정 반영`으로 사용자가 승인해야 `MAPPED + reviewed:true`가 된다.
- 사용자가 원본 열 연결을 직접 바꾼 경우에는 `매핑 변경 반영`으로 중앙 작업표를 다시 반영한다.
- 중앙 작업표 항목명의 상시 검색 아이콘은 표시하지 않고, 필터 도구는 항목명 hover/focus 시 노출한다.
- 기존 `input-template-mapper`와 전표 저장 계약은 유지한다.
