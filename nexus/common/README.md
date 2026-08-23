# NEXUS 공통헤더 계약

각 앱은 `apps-config.js`, `nexus-top.js`를 불러온 뒤 앱 ID를 선언한다.

```html
<nexus-top app-id="dataops"></nexus-top>
```

## 상단 메뉴 설정

스마트입력은 브랜드 바로 뒤의 고정 위치를 사용하지만 공통헤더 설정의 `상단 메뉴` 목록에 표시되며 노출 여부를 변경할 수 있다. 업무군 메뉴의 순서·노출 설정과 개별 앱의 즐겨찾기·숨김 설정은 서로 독립적이다. 숨긴 스마트입력 화면에 직접 진입하면 현재 위치로만 임시 표시된다.

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
