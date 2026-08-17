export const DISPATCH_STATUS_LABEL = Object.freeze({
  DRAFT: '검토 중',
  RELEASED: '출고 준비',
  READY_TO_CONFIRM: '확정 대기',
  CONFIRMED: '출고 완료',
  REVERSED: '출고 취소'
});

export const PURCHASE_STATUS_LABEL = Object.freeze({
  DRAFT: '검토 중',
  CONFIRMED: '입고 완료',
  REVERSED: '구매 취소'
});

export const ERP_STATUS_LABEL = Object.freeze({
  NOT_READY: '자료 준비 전',
  READY: 'ERP 자료 준비',
  EXPORTED: '파일 생성 완료',
  POSTED: 'ERP 반영 확인',
  RECONCILED: '대사 완료',
  CORRECTION_REQUIRED: 'ERP 수정 필요',
  REVIEW_REQUIRED: '관리자 확인 필요'
});

export const ACTION_CODE_LABEL = Object.freeze({
  READY: '검토 완료',
  STOCK_SHORTAGE: '재고 부족 확인',
  NEGATIVE_STOCK: '음수재고 확인',
  SUBSTITUTE_APPROVAL_REQUIRED: '대체상품 승인 필요',
  OVER_DISPATCH_APPROVAL_REQUIRED: '초과출고 승인 필요',
  MEASURE_PENDING: '실제 계량 필요',
  CUSTOMER_NOTICE_PENDING: '고객 안내 확인 필요'
});

export const dispatchStatusLabel = value => DISPATCH_STATUS_LABEL[value] || String(value || '');
export const purchaseStatusLabel = value => PURCHASE_STATUS_LABEL[value] || String(value || '');
export const erpStatusLabel = value => ERP_STATUS_LABEL[value] || String(value || '');
export const actionCodeLabel = value => ACTION_CODE_LABEL[value] || String(value || '').replaceAll('_', ' ');
