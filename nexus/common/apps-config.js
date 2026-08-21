(() => {
  const base = 'https://oneapp.orderz.co.kr';
  window.NEXUS_APPS = Object.freeze([
    { id:'orderq', name:'출고관리', brand:'ORDER Q', url:`${base}/orderops_list.html` },
    { id:'dataops', name:'검증·정산', brand:'DataOps', url:`${base}/DataOps.html` },
    { id:'merchops', name:'시세관리', brand:'MerchOps', url:`${base}/MerchOps.html` },
    { id:'orderin', name:'주문입력', brand:'ORDER IN', url:`${base}/SmartParser.html` },
    { id:'master', name:'기초등록', brand:'MASTER', url:`${base}/Master.html` }
  ]);
})();
