# NEXUS 공통헤더 계약

모든 업무 앱은 공통헤더보다 먼저 인증 설정과 클라이언트를 동기 로드한다. 인증 클라이언트는 화면이 그려지기 전에 세션을 확인하고, 비로그인 사용자를 `/nexus/`로 돌려보내며, 허용된 Apps Script 업무 요청만 NEXUS 게이트웨이로 전달한다.

```html
<script src="/nexus/common/nexus-auth-config.js"></script>
<script src="/nexus/common/nexus-auth.js"></script>
<script src="/nexus/common/apps-config.js"></script>
<script src="/nexus/common/nexus-top.js"></script>
```

로그인 세션은 현재 탭의 `sessionStorage` 키 `oneapp.nexus.auth.session.v1`에만 둔다. V1 읽기/쓰기, V2 게시, 마감, ORDER Q, Shipping 토큰은 브라우저 저장소·프롬프트·업무 화면에 두지 않는다. 마스터가 `nexus/admin/index.html`에서 한 번 등록하면 Apps Script `ScriptProperties`에만 저장되고, 게이트웨이가 서버에서 권한별로 선택한다.

`OWNER_MASTER`만 사용자·서비스·감사 관리 권한을 가진다. `FULL_ACCESS`는 모든 업무 권한을 뜻하지만 관리자 권한은 포함하지 않는다. 메뉴 숨김은 보조 표시이고 실제 허용/거부는 게이트웨이에서 다시 판정한다.

인증 후 각 앱은 앱 ID를 선언한다.

```html
<nexus-top app-id="dataops"></nexus-top>
```

## 상단 메뉴 구조

공통헤더는 한 줄에서 다음 순서를 사용한다.

```text
기준정보 · 가격·시세 │ 스마트입력 · 주문·출고 · 재고·정산
```

`기준정보·가격·시세`는 기준·관리 영역이고, `스마트입력·주문·출고·재고·정산`은 운영 흐름이다. 두 영역은 얇은 구분선으로만 나눈다.

스마트입력은 운영 흐름의 고정 시작 위치를 사용하지만 공통헤더 설정의 `상단 메뉴` 목록에 표시되며 노출 여부를 변경할 수 있다. 업무군 메뉴의 순서·노출 설정과 개별 앱의 즐겨찾기·숨김 설정은 서로 독립적이다. 숨긴 스마트입력 화면에 직접 진입하면 현재 위치로만 임시 표시된다.

## 상단 탭 버튼

5개 탭은 `/nexus/assets/navigation-tabs/`의 `active`·`inactive` PNG를 사용한다. 현재 `<nexus-top app-id="...">`에 해당하는 탭만 활성 이미지를 표시하고 나머지는 비활성 이미지를 표시한다. 이동 보호 이벤트가 허용한 탭 선택은 화면 이동 전에 즉시 활성 이미지로 바뀌며, 이동이 실패하거나 뒤로가기로 현재 문서가 복원되면 현재 `app-id` 기준 상태로 되돌린다. 이미지 10개는 헤더 초기화 때 미리 로드한다. 기존 `aria-current="page"`, 하단 선택선, 탭 순서·숨김 설정과 모바일 현재 탭 노출 계약은 유지한다.

## 앱별 로고

앱별 공통헤더 로고 저장공간은 `/nexus/assets/brand/apps/` 아래에 둔다. 일반모드와 다크모드 경로는 `apps-config.js`의 `logo.light`, `logo.dark`로 등록한다. 로고가 없거나 파일 로드에 실패하면 탭 명칭을 표시한다.

## 화면 모드

공통헤더 화면 모드는 `일반(light)`과 `다크(dark)`만 제공한다. 사용자가 선택한 값은 `oneapp.nexus.v1.colorMode`에 저장되어 모든 앱에 적용된다. 이전 `system` 저장값과 잘못된 값은 `light`로 자동 전환한다. 운영체제 화면 모드는 읽거나 감시하지 않는다.

각 앱은 첫 스타일과 본문 렌더보다 먼저 `nexus-theme-init.js`를 동기 실행한다. 이 초기화 스크립트가 저장값을 읽어 루트의 `data-nexus-theme="light|dark"`와 `color-scheme`을 지정하므로 저장된 다크모드 앞에 밝은 로딩·오류·빈 화면이 먼저 표시되면 안 된다.

```html
<head>
  <script src="/nexus/common/nexus-theme-init.js"></script>
  <link rel="stylesheet" href="/nexus/common/oneapp-design-tokens.css">
  <!-- application styles and runtime follow -->
</head>
```

`data-nexus-theme`와 `nexus-theme-change`가 애플리케이션의 유일한 테마 입력이다. 애플리케이션은 저장키를 직접 읽거나 별도 테마값을 저장하지 않는다. 기존 공통헤더 스타일 호환용 `data-nexus-color-mode` alias는 같은 `light|dark` 값으로 유지하지만 신규 애플리케이션 계약으로 사용하지 않는다.

```js
window.addEventListener('nexus-theme-change', (event) => {
  // 기존 필드 theme/colorMode는 항상 같은 light 또는 dark 값이다.
  // source는 추가 정보이며 기존 소비자는 무시할 수 있다.
  const { theme, colorMode, source } = event.detail;
});
```

테마 전환은 루트 속성과 CSS 변수만 변경한다. 화면 reload, 업무 데이터 재조회, 애플리케이션 root 재생성 또는 검색·필터·선택·편집·스크롤·저장·동기화 상태 초기화를 수행하지 않는다.

`oneapp-design-tokens.css`는 화면·패널·표·입력·선택·포커스·상태의 의미 기반 `--nexus-*` 변수를 제공한다. 기존 Master 계열의 `--oneapp-*` 변수는 호환 alias로 유지한다. 성공·주의·오류 foreground/background 조합은 일반·다크 모두 기본 글자 대비 `4.5:1` 이상이어야 한다. 가격 상승·하락, 역마진, 재고 부족, 주문 충돌과 대사 차이는 공통 오류 변수와 별도 업무 변수로 사용한다.

앱별 호환 스타일은 해당 앱 root와 `[data-nexus-theme="dark"]` 아래로 범위를 제한한다. 전역 Tailwind 팔레트 교체, `nexus-master-theme.css`의 대상 앱 확대와 광범위한 `!important` 사용은 금지한다. Excel·ERP·인쇄·카카오 이미지 컨테이너는 화면 테마를 소비하지 않고 기존 밝은 출력 계약을 유지한다.

## 현재 앱 상태

공통헤더는 현재 페이지의 앱 ID와 일치하는 상태만 실시간으로 반영한다. 동시에 여러 작업이 있으면 `오류 > 주의 > 진행 > 정상` 순서로 대표 상태를 선택한다.

```js
window.NEXUS_TOP.reportStatus({
  appId: 'dataops',
  taskId: 'inventory-save-42',
  level: 'progress', // normal | progress | warning | error
  message: '재고 스냅샷을 저장하고 있습니다.'
});

window.NEXUS_TOP.clearStatus('inventory-save-42', 'dataops');
```

작업 성공·실패는 시작 때 사용한 `taskId`로 전달한다. 다른 앱의 마지막 상태는 과거 확인 기록으로만 표시하며 실시간 상태로 간주하지 않는다.

## 앱 이동 보호

다른 앱으로 이동하기 전에 취소 가능한 `nexus:before-navigate` 이벤트를 발생시킨다. 미저장 내용을 보유한 앱은 이벤트를 취소하고 자체 저장·폐기 확인 절차를 실행한다.

이동이 허용되면 외부 이미지에 의존하지 않는 NEXUS 전환 화면을 즉시 표시한다. 전환 화면은 이동을 시작한 시점의 일반·다크 화면 모드를 함께 보관해 목적지 첫 화면까지 같은 밝기를 유지한다. 이동 대상 이름과 진행 상태를 보여 주고, 다음 앱의 이미지·스타일을 포함한 전체 로드가 끝난 뒤 전환 화면을 제거한다. 뒤로가기 복원과 12초 안전 해제를 지원하며 새 탭·보조키 이동에는 개입하지 않는다. 전환 상태는 현재 탭의 `sessionStorage` 키 `oneapp.nexus.v1.navigation`에만 임시 보관한다.

```js
window.addEventListener('nexus:before-navigate', (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  openLeaveDialog(event.detail.url);
});
```

## 전역 오류

현재 앱 상태와 구분해야 하는 NEXUS 공통 장애만 별도 전역 오류로 전달한다.

```js
window.NEXUS_TOP.reportGlobalError({ id: 'preferences', message: '공통 설정 서버에 연결할 수 없습니다.' });
window.NEXUS_TOP.clearGlobalError('preferences');
```

## 앱 공통 고정 UI

지원 앱은 `nexus-app-ui.css`와 `nexus-ui-contract.js`를 불러온다. 공통헤더는 전체 폭을 사용하고 앱 작업영역은 `--nexus-content-max-width` 안에서 중앙 정렬하는 하나의 고정 레이아웃을 사용한다.

```html
<link rel="stylesheet" href="/nexus/common/nexus-app-ui.css">
<script src="/nexus/common/nexus-ui-contract.js"></script>
```

기초등록 운영 적용 상태와 후속 앱 예외는 [`NEXUS_APP_UI_CONTRACT.md`](./NEXUS_APP_UI_CONTRACT.md)에 기록한다.
