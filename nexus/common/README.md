# NEXUS 공통헤더 계약

모든 업무 앱은 공통헤더보다 먼저 인증 설정과 클라이언트를 동기 로드한다. 인증 클라이언트는 화면이 그려지기 전에 세션을 확인하고, 비로그인 사용자를 `/nexus/`로 돌려보내며, `ONEAPP_AUTH.gateway(operationId, payload)`로 등록된 업무만 NEXUS 게이트웨이에 POST한다.

```html
<script src="/nexus/common/nexus-auth-config.js"></script>
<script src="/nexus/common/nexus-auth.js"></script>
<script src="/nexus/common/apps-config.js"></script>
<script src="/nexus/common/nexus-top.js"></script>
```

로그인 세션은 현재 탭의 `sessionStorage` 키 `oneapp.nexus.auth.session.v1`에만 둔다. Foundation·DataOps·ORDER Q·Shipping 자격증명은 브라우저 저장소·프롬프트·업무 화면에 두지 않는다. Gateway는 operation registry에서 upstream action, 보안 경계, READ/WRITE 자격증명과 허용 payload 필드를 고정한다. 브라우저가 URL·raw action·actor·사용자·앱·request ID·자격증명을 선택할 수 없다.

V2 앱은 `window.fetch` 가로채기를 사용하지 않는다. V1 `nexus_proxy`는 서버 호환 경로로만 남고 감사에는 `LEGACY_V1`으로 기록된다. `foundation.replace_all`은 `foundation.write`와 `foundation.replace`가 모두 있어야 하며, 비활성 A/B 슬롯의 Master·History·Config를 전부 검산한 뒤 active pointer를 전환한다. 중간 실패 시 기존 활성 슬롯은 그대로 유지된다.

`OWNER_MASTER`만 사용자·서비스·감사·회사정보 관리 권한을 가진다. `FULL_ACCESS`는 모든 업무 권한을 뜻하지만 `admin.company`를 포함한 관리자 권한은 포함하지 않는다. 메뉴 숨김은 보조 표시이고 실제 허용/거부는 게이트웨이에서 다시 판정한다.

인증 후 각 앱은 앱 ID를 선언한다.

```html
<nexus-top app-id="dataops"></nexus-top>
```

## 상단 메뉴 구조

공통헤더는 데스크톱에서 64px 한 줄, 680px 이하 모바일에서 104px 두 줄을 사용한다. 모바일은 첫 줄에 브랜드·공통 동작을, 둘째 줄에 가로 스크롤 가능한 업무 탭을 둔다.

```text
기준정보 · 가격·시세 │ 스마트입력 · 주문·출고 · 재고·정산
```

`기준정보·가격·시세`는 기준·관리 영역이고, `스마트입력·주문·출고·재고·정산`은 운영 흐름이다. 두 영역은 얇은 구분선으로만 나눈다.

스마트입력은 운영 흐름의 고정 시작 위치를 사용하지만 공통헤더 설정의 `상단 메뉴` 목록에 표시되며 노출 여부를 변경할 수 있다. 업무군 메뉴의 순서·노출 설정과 개별 앱의 즐겨찾기·숨김 설정은 서로 독립적이다. 숨긴 스마트입력 화면에 직접 진입하면 현재 위치로만 임시 표시된다.

인증된 사용자 이름 버튼은 계정 패널을 열어 `업무 홈`을 제공한다. 보호된 회사정보 수정 경로는 OWNER_MASTER의 마스터 관리 화면에서만 동적으로 추가하며 일반 사용자 DOM에는 만들지 않는다. 로그아웃은 계정 패널과 분리된 기존 버튼으로 유지한다.

## 상단 탭 버튼

5개 탭은 44px 그룹 안에 높이 38px, 최소 너비 96px, 간격 4px, 모서리 8px의 텍스트 버튼으로 표시한다. 글자는 13px/600이고 색상·배경 전환은 150ms이다. 현재 `<nexus-top app-id="...">`에 해당하는 탭은 저채도 배경과 글자색으로만 구분하며 하단 선택선은 사용하지 않는다. 이동 보호 이벤트가 허용한 탭 선택은 화면 이동 전에 즉시 선택 배경으로 바뀌며, 이동이 실패하거나 뒤로가기로 현재 문서가 복원되면 현재 `app-id` 기준 상태로 되돌린다. 모바일은 모든 탭을 높이 44px 터치 대상으로 유지하고 가로 스크롤한다. 기존 `aria-current="page"`, 탭 순서·숨김 설정과 현재 위치 임시 표시는 유지한다.

## 앱별 로고

앱별 공통헤더 로고 저장공간은 `/nexus/assets/brand/apps/` 아래에 둔다. 일반모드와 다크모드 경로는 `apps-config.js`의 `logo.light`, `logo.dark`로 등록한다. 로고가 없거나 파일 로드에 실패하면 탭 명칭을 표시한다.

## 화면 모드

공통헤더 화면 모드는 `일반(light)`과 `다크(dark)`만 제공한다. 화면 모드 스위치는 설정 서랍 안에 두지 않고 공통헤더 탭 바깥에 해·달 아이콘과 함께 항상 표시한다. 사용자가 선택한 값은 `oneapp.nexus.v1.colorMode`에 저장되어 모든 앱에 적용된다. 이전 `system` 저장값과 잘못된 값은 `light`로 자동 전환한다. 운영체제 화면 모드는 읽거나 감시하지 않는다.

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

이동이 허용되면 외부 이미지에 의존하지 않는 NEXUS 전환 화면을 즉시 표시한다. 전환 화면은 이동을 시작한 시점의 일반·다크 화면 모드를 함께 보관해 목적지 첫 화면까지 같은 밝기를 유지한다. 기본 소비자는 전체 `load` 뒤 전환 화면을 제거한다. 인증·권한 확인과 앱 셸 준비를 별도로 관리하는 소비자는 `<html data-nexus-app-id="..." data-nexus-ready-strategy="app">`를 선언하고 최소 상호작용 가능 시점에 `nexus:app-ready`를 발생시켜 제거한다. 뒤로가기 복원과 12초 안전 해제를 지원하며 새 탭·보조키 이동에는 개입하지 않는다. 전환 상태는 현재 탭의 `sessionStorage` 키 `oneapp.nexus.v1.navigation`에만 임시 보관한다.

`ONEAPP_AUTH.ready`는 서버 세션과 현재 앱 context가 모두 유효한 뒤에만 완료된다. 만료된 context나 과거 권한으로 데이터 셸을 먼저 공개하는 우회 promise는 두지 않는다. 대신 인증 클라이언트가 5분 context 만료 90초 전에 active tab에서 전체 client bundle을 백그라운드 갱신하고, `pageshow`·가시성 복귀·공통헤더 링크 hover/focus에서도 freshness를 확인한다. BroadcastChannel은 갱신 사실만 알리고 세션 토큰을 다른 탭에 복제하지 않는다. 수신 탭은 자기 탭의 session token으로 `refreshIfNeeded()`를 실행하며 이미 유효한 요청과 중복 네트워크 요청은 합친다. 로그아웃·세션 회수·권한 거부는 기존처럼 캐시와 예약 갱신을 즉시 제거하고 `nexus:app-ready`보다 먼저 차단한다.

```js
window.addEventListener('nexus:before-navigate', (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  openLeaveDialog(event.detail.url);
});

await window.ONEAPP_AUTH.ready;
window.dispatchEvent(new CustomEvent('nexus:app-ready', {
  detail: { appId: 'master', phase: 'interactive' }
}));
```

## 공개 회사정보 Footer

공통 `nexus-auth.js` bootstrap은 공개 로그인 화면을 제외한 모든 보호 업무화면에서 `nexus-company-footer.js` 한 자산만 불러온다. 이 자산이 배포 기본 Snapshot, 현재 사용자 범위의 마지막 정상 local Snapshot, background revision 확인과 `<nexus-company-footer>` 렌더를 함께 소유한다. 개별 HTML과 앱 코드는 회사 값을 복사하지 않는다.

공개 Snapshot은 `NEXUS_COMPANY_PUBLIC_FOOTER_V1`이며 `companyName`, `businessNumber`, `representativeName`, `companyPhone`, `businessAddress`, `homepage`, `revision` 7개 키만 허용한다. user/schema/company scope는 Snapshot 바깥 저장 envelope와 key에 둔다. 회사전화와 홈페이지가 공란이면 해당 항목을 그리지 않는다. 보호된 회사 레코드, 회계기수, OCR·사업자등록증, 감사정보, 개업일자, 과세유형, 업태·종목, 자택전화, 개인 모바일과 이메일은 저장하거나 렌더하지 않는다.

Footer는 인증이나 네트워크를 기다리지 않고 마지막 정상 Snapshot 또는 배포 기본 Snapshot으로 먼저 렌더한다. 그 뒤 현재 `knownRevision`을 포함한 `company.public_profile_read`를 탭 단위로 중복 억제해 호출한다. 같은 revision은 Snapshot 없이 확인 결과만 받고, 서버 revision이 더 낮으면 무시하며, 더 높을 때만 local Snapshot 저장과 화면 갱신을 한 단위로 수행한다. 실패하면 기존 Footer를 유지하며 인증 게이트나 `nexus:app-ready`를 지연시키지 않는다. Footer는 fixed/sticky bar가 아닌 document flow의 마지막 요소이며 짧은 화면에서만 flex minimum-height로 페이지 하단에 놓인다.

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
