(function (global) {
  "use strict";

  var fixedAreas = Object.freeze(["appHeader", "targetTabs", "workTools", "table"]);
  var applications = Object.freeze({
    "master-lookup": Object.freeze({
      status: "pilot",
      strategy: "fixed-layout",
      supportedAreas: fixedAreas,
      exceptions: Object.freeze([])
    }),
    "item-manager": Object.freeze({
      status: "pilot",
      strategy: "fixed-layout",
      supportedAreas: fixedAreas,
      exceptions: Object.freeze([])
    }),
    merchops: Object.freeze({
      status: "planned", strategy: "registered-exception", supportedAreas: Object.freeze([]),
      exceptions: Object.freeze([Object.freeze({
        id: "rollout-after-foundation",
        reason: "기초등록에서 고정 골격과 중앙 기준 폭을 먼저 검증한다.",
        excludedItems: Object.freeze(["appHeader", "workModes", "workTools", "table"]),
        alternativeUi: "기존 가격·행사 작업표와 F7/F8/F9 실행 체계를 유지한다.",
        regressionChecks: Object.freeze(["masterApply", "excelOutput", "outputDetail", "functionKeys"]),
        revisitWhen: "기초등록 고정 레이아웃 운영 검증 통과"
      })])
    }),
    dataops: Object.freeze({
      status: "planned", strategy: "registered-exception", supportedAreas: Object.freeze([]),
      exceptions: Object.freeze([Object.freeze({
        id: "rollout-after-merchops",
        reason: "LOT·재고·원가 표는 선행 앱의 고정 레이아웃 적용 결과를 확인한 뒤 전환한다.",
        excludedItems: Object.freeze(["appHeader", "workTools", "table"]),
        alternativeUi: "기존 자체 환경설정과 검증표를 유지한다.",
        regressionChecks: Object.freeze(["lot", "inventory", "cost", "closing"]),
        revisitWhen: "MerchOps 적용 검증 통과"
      })])
    }),
    orderq: Object.freeze({
      status: "planned", strategy: "registered-exception", supportedAreas: Object.freeze([]),
      exceptions: Object.freeze([Object.freeze({
        id: "rollout-after-dataops",
        reason: "주문·구매·출고 단계별 작업대는 DataOps 다음 순서로 전환한다.",
        excludedItems: Object.freeze(["appHeader", "targetTabs", "workTools", "table"]),
        alternativeUi: "기존 ORDER Q 작업대와 저장·출력·복구 UI를 유지한다.",
        regressionChecks: Object.freeze(["save", "output", "functionKeys", "recovery"]),
        revisitWhen: "DataOps 적용 검증 통과"
      })])
    }),
    "smart-parser": Object.freeze({
      status: "planned", strategy: "registered-exception", supportedAreas: Object.freeze([]),
      exceptions: Object.freeze([Object.freeze({
        id: "rollout-after-orderq",
        reason: "원본·파싱·마스터 비교 구조는 ORDER Q 다음 순서로 전환한다.",
        excludedItems: Object.freeze(["appHeader", "workModes", "workTools", "comparison"]),
        alternativeUi: "기존 원본·파싱·마스터 검토 화면을 유지한다.",
        regressionChecks: Object.freeze(["parsing", "matching", "masterApply"]),
        revisitWhen: "ORDER Q 적용 검증 통과"
      })])
    })
  });

  global.NEXUS_APP_UI = Object.freeze({
    version: "NEXUS_APP_UI_V2",
    layout: Object.freeze({
      contentMaxWidth: "1440px",
      contentGutter: "24px",
      fixed: true
    }),
    applications: applications,
    getApplication: function (appId) {
      return applications[String(appId || "")] || null;
    }
  });
})(window);
