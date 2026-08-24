# 앱별 공통헤더 로고 저장 규칙

공통헤더 탭 로고는 앱 역할별 폴더에 저장한다.

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

로고가 제작되면 `nexus/common/apps-config.js`의 해당 `logo.light`, `logo.dark` 경로를 등록한다. 경로가 없거나 파일 로드에 실패하면 공통헤더는 탭 명칭을 표시한다.
