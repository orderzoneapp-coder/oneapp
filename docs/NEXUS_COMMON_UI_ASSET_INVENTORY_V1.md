# NEXUS 공통 UI 자산·결합 분류 v1.0

- 참고 태그: `backup/pre-m1-full-rollback-20260828-4960f24`
- 분류일: 2026-08-29

## 1. 재사용 허용

다음 두 파일은 투명 배경의 순수 브랜드 SVG이므로 바이트 단위로 재사용한다.

| 파일 | 용도 |
|---|---|
| `nexus/assets/brand/oneapp-nexus-light.svg` | 일반모드 NEXUS 로고 |
| `nexus/assets/brand/oneapp-nexus-dark.svg` | 다크모드 NEXUS 로고 |

## 2. 시각적 참고만 허용

다음 파일은 색상·간격·헤더 높이·모바일 배치·본문 토큰의 시각적 참고만 허용한다. 파일 자체는 복원하지 않는다.

- `nexus/common/nexus-top.css`
- `nexus/common/nexus-top-navigation.css`
- `nexus/common/oneapp-design-tokens.css`
- `nexus/common/nexus-operational-theme.css`
- `nexus/common/nexus-master-theme.css`
- `nexus/common/nexus-app-ui.css`
- `nexus/common/oneapp-components.css`
- `nexus/common/oneapp-layout.css`

## 3. 반입 금지

다음 파일은 인증·서버·상태·앱 준비 또는 이전 Runtime과 결합돼 있으므로 코드와 파일을 반입하지 않는다.

- `nexus/common/nexus-top.js`
- `nexus/common/apps-config.js`
- `nexus/common/nexus-auth-config.js`
- `nexus/common/nexus-auth.js`
- `nexus/common/nexus-auth.css`
- `nexus/common/nexus-company-footer.js`
- `nexus/common/nexus-ui-contract.js`
- 이전 NEXUS 앱 셸과 서버 파일 전체

## 4. 미사용 자산

다음 자산은 이번 한 줄 텍스트 네비게이션과 관련이 없으므로 복원하지 않는다.

- `nexus/assets/navigation-tabs/*.png`
- `nexus/assets/brand/apps/smart-input/*`
- `nexus/assets/nexus-favicon.png`
- 비어 있는 앱별 `.gitkeep`

## 5. 새 구현 원칙

- 헤더와 테마 JavaScript는 새로 작성한다.
- 정적 앱 목록만 포함한다.
- 테마 전용 저장키 외 브라우저 저장소를 읽지 않는다.
- 네트워크·인증·Gateway·업무 DB API를 포함하지 않는다.
- 앱별 HTML에는 정적 앱 ID와 공통 파일 연결만 추가한다.
