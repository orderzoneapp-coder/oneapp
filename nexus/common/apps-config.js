(() => {
  const base = 'https://oneapp.orderz.co.kr';
  const freezeRecords = (records) => Object.freeze(records.map((record) => Object.freeze(record)));

  /**
   * Header navigation is intentionally defined at the work-group level.
   * Individual applications are listed separately in NEXUS_APPS so a user's
   * app preferences can never change the work-group navigation contract.
   */
  window.NEXUS_GROUPS = freezeRecords([
    { id: 'shipping', name: '출고관리', url: `${base}/orders.html` },
    { id: 'inventory', name: '재고관리', url: `${base}/DataOps.html` },
    { id: 'pricing', name: '시세관리', url: `${base}/MerchOps.html` },
    { id: 'foundation', name: '기초등록', url: `${base}/Master.html` },
  ]);

  window.NEXUS_APPS = freezeRecords([
    { id: 'smart-input', groupId: 'shipping', name: '스마트입력', description: '주문·구매·판매 통합입력', url: `${base}/smartinput/`, lifecycle: 'operational', access: 'allowed' },
    { id: 'orderq', groupId: 'shipping', name: 'ORDER Q', description: '출고 작업', url: `${base}/orders.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'orderops', groupId: 'shipping', name: 'OrderOps', description: '출고 운영', url: `${base}/orderops/list.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'orderin', groupId: 'shipping', name: 'ORDER IN', description: '주문 직접입력', url: `${base}/orderq/input.html`, lifecycle: 'development', access: 'allowed' },
    { id: 'dataops', groupId: 'inventory', name: 'DataOps', description: '재고 검증', url: `${base}/DataOps.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'merchops', groupId: 'pricing', name: 'MerchOps', description: '시세·가격 작업', url: `${base}/MerchOps.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'smart-parser', groupId: 'pricing', name: 'Smart Parser', description: '문서 파싱', url: `${base}/SmartParser.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'master', groupId: 'foundation', name: '기초등록', description: '상품·거래처 기초정보 조회·관리', url: `${base}/Master.html`, lifecycle: 'operational', access: 'allowed' },
    { id: 'item-manager', groupId: 'foundation', name: '상품 등록', description: '상품 단건 등록·수정', url: `${base}/Item_manager.html`, lifecycle: 'operational', access: 'allowed', defaultHidden: true },
    { id: 'customer-manager', groupId: 'foundation', name: '거래처 관리', description: '거래처 조회·등록·수정', url: `${base}/Master.html?view=customers`, lifecycle: 'operational', access: 'allowed' },
  ]);

  window.NEXUS_GLOBAL_ACTIONS = freezeRecords([
    { id: 'smart-input', appId: 'smart-input', name: '스마트입력', url: `${base}/smartinput/` },
  ]);

  // Existing entry-point IDs remain valid while each page moves to canonical IDs.
  window.NEXUS_APP_ALIASES = Object.freeze({
    'master-lookup': 'master',
    itemmanager: 'item-manager',
    smartparser: 'smart-parser',
    'smart-parser': 'smart-parser',
    'orderq-vnext': 'orderin',
  });
})();
