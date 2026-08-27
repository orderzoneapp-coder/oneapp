# 앱별 브랜드 로고 저장 규칙

앱 역할별 브랜드 로고 저장공간은 다음 폴더를 유지한다.

```text
foundation/   기준정보
pricing/      가격·시세
smart-input/  스마트입력
shipping/     주문·출고
inventory/    재고·정산
```

각 폴더의 권장 파일명은 다음과 같다.

```text
logo-light.png  일반모드용
logo-dark.png   다크모드용
```

로고가 제작되면 `nexus/common/apps-config.js`의 해당 `logo.light`, `logo.dark` 경로에 등록할 수 있다. 공통헤더 v1.8의 상단 업무 탭은 로고 유무와 관계없이 항상 동일한 13px/600 텍스트 버튼을 사용하며, 이 저장공간은 전체 앱 목록과 후속 브랜드 소비자를 위해 보존한다.
