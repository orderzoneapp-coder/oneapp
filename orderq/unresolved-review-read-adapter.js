import { getProductSnapshotResult } from '../reference-data/product-master-read-adapter.js?v=1.0.0';
import { readOfficialUnresolvedReviewSources } from './unresolved-review-repository.js?v=0.1.0';
import {
  buildUnresolvedReviewReadModel,
  previewUnresolvedRematchImpact,
  UNRESOLVED_REVIEW_READ_MODEL_SCHEMA,
  UNRESOLVED_REVIEW_STATUS,
  UNRESOLVED_REMATCH_IMPACT_SCHEMA
} from './unresolved-review-read-model.js?v=0.1.0';

export const UNRESOLVED_REVIEW_READ_ADAPTER_VERSION = 'ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_ADAPTER_V1';

const exactText = value => String(value ?? '').trim();
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function requiredCompanyId(value) {
  const companyId = exactText(value);
  if (!companyId) throw new Error('ORDERQ_UNRESOLVED_REVIEW_COMPANY_REQUIRED');
  return companyId;
}

function productIdOf(row = {}) {
  return exactText(row.productId || row.masterProductId);
}

function productCodeOf(row = {}) {
  return exactText(row.itemCode || row.productCode || row['코드'] || row['품목코드']
    || row.raw?.['코드'] || row.raw?.['품목코드']);
}

function activeProduct(row = {}) {
  return row.active !== false
    && !['INACTIVE', 'DELETED'].includes(exactText(row.status || 'ACTIVE').toUpperCase())
    && exactText(row.productIdentityType).toUpperCase() !== 'TEMPORARY';
}

function productInCompanyScope(row = {}, companyId) {
  const rowCompanyId = exactText(row.companyId);
  return !rowCompanyId || rowCompanyId === companyId;
}

function errorResult({ code, message, companyId = '', schemaVersion = UNRESOLVED_REVIEW_READ_MODEL_SCHEMA, source }) {
  return deepFreeze({
    schemaVersion,
    adapterVersion: UNRESOLVED_REVIEW_READ_ADAPTER_VERSION,
    ownerAppId: 'orderq-vnext',
    companyId,
    status: UNRESOLVED_REVIEW_STATUS.ERROR,
    count: null,
    items: [],
    impacts: [],
    source,
    error: {
      code: exactText(code) || 'ORDERQ_UNRESOLVED_REVIEW_READ_FAILED',
      message,
      retryable: true
    }
  });
}

function ownerError(error, companyId, schemaVersion = UNRESOLVED_REVIEW_READ_MODEL_SCHEMA) {
  return errorResult({
    code: error?.code || error?.message,
    message: 'ORDER Q 미매칭 검수 자료를 읽지 못했습니다.',
    companyId,
    schemaVersion,
    source: 'ORDER_Q_OWNER_REPOSITORY'
  });
}

function productError(error, companyId, schemaVersion = UNRESOLVED_REMATCH_IMPACT_SCHEMA) {
  return errorResult({
    code: error?.code || error?.message || 'PRODUCT_SNAPSHOT_READ_FAILED',
    message: '현재 상품 Snapshot을 읽지 못해 재매칭 영향을 미리 계산할 수 없습니다.',
    companyId,
    schemaVersion,
    source: 'PRODUCT_MASTER_READ_ADAPTER'
  });
}

function candidateReference(productResult) {
  if (!productResult || productResult.status === 'ERROR') {
    return {
      status: 'ERROR',
      snapshotId: null,
      error: clone(productResult?.error || {
        code: 'PRODUCT_SNAPSHOT_READ_FAILED',
        message: '상품 기준정보 Snapshot을 읽지 못했습니다.',
        retryable: true
      })
    };
  }
  return {
    status: productResult.status,
    snapshotId: productResult.snapshot?.snapshotId || null,
    revision: productResult.snapshot?.revision ?? null,
    error: null
  };
}

function selectedProductFromSnapshot(productResult, companyId, selectedProductId) {
  if (!productResult || productResult.status === 'ERROR') {
    const error = new Error(productResult?.error?.code || 'PRODUCT_SNAPSHOT_READ_FAILED');
    error.code = productResult?.error?.code || 'PRODUCT_SNAPSHOT_READ_FAILED';
    throw error;
  }
  const productId = exactText(selectedProductId);
  if (!productId) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_ID_REQUIRED');
  const matches = (productResult.snapshot?.data?.products || []).filter(row => productInCompanyScope(row, companyId)
    && activeProduct(row)
    && productIdOf(row) === productId);
  if (matches.length !== 1) throw new Error(matches.length
    ? 'ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_ID_AMBIGUOUS'
    : 'ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_NOT_FOUND');
  if (!productCodeOf(matches[0])) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_CODE_REQUIRED');
  return matches[0];
}

export function createUnresolvedReviewReadAdapter({
  readOwnerSources = readOfficialUnresolvedReviewSources,
  readProductSnapshot = getProductSnapshotResult
} = {}) {
  if (typeof readOwnerSources !== 'function') throw new Error('ORDERQ_UNRESOLVED_REVIEW_SOURCE_READER_REQUIRED');
  if (typeof readProductSnapshot !== 'function') throw new Error('ORDERQ_UNRESOLVED_REVIEW_PRODUCT_READER_REQUIRED');

  async function getReviewResult(options = {}) {
    let companyId = '';
    try {
      companyId = requiredCompanyId(options.companyId);
      const source = await readOwnerSources({ companyId, includeCheckpoints: false });
      let productResult;
      try {
        productResult = await readProductSnapshot();
      } catch (error) {
        productResult = { status: 'ERROR', snapshot: null, error: { code: error?.code || error?.message } };
      }
      const model = buildUnresolvedReviewReadModel({
        companyId,
        source,
        productSnapshot: productResult?.snapshot || null,
        query: options,
        generatedAt: options.generatedAt
      });
      return deepFreeze({
        ...model,
        adapterVersion: UNRESOLVED_REVIEW_READ_ADAPTER_VERSION,
        count: model.page.totalItems,
        source: {
          owner: 'ORDER_Q_OWNER_REPOSITORY',
          ownerDatabaseState: source.ownerDatabaseState || 'READY',
          readAt: source.readAt || null
        },
        candidateReference: candidateReference(productResult),
        error: null
      });
    } catch (error) {
      return ownerError(error, companyId);
    }
  }

  async function getReview(options = {}) {
    const result = await getReviewResult(options);
    if (result.status === UNRESOLVED_REVIEW_STATUS.ERROR) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      error.retryable = result.error.retryable;
      throw error;
    }
    return result;
  }

  async function previewRematchImpactResult(options = {}) {
    let companyId = '';
    try {
      companyId = requiredCompanyId(options.companyId);
      const unresolvedProductId = exactText(options.unresolvedProductId);
      if (!unresolvedProductId) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_ID_REQUIRED');
      let source;
      try {
        source = await readOwnerSources({ companyId, unresolvedProductId, includeCheckpoints: true });
      } catch (error) {
        return ownerError(error, companyId, UNRESOLVED_REMATCH_IMPACT_SCHEMA);
      }
      let productResult;
      try {
        productResult = await readProductSnapshot();
      } catch (error) {
        return productError(error, companyId);
      }
      if (productResult?.status === 'ERROR') return productError(productResult.error, companyId);
      const selectedProduct = selectedProductFromSnapshot(productResult, companyId, options.selectedProductId);
      const preview = previewUnresolvedRematchImpact({
        companyId,
        unresolvedProductId,
        selectedProduct,
        source,
        generatedAt: options.generatedAt
      });
      return deepFreeze({
        ...preview,
        adapterVersion: UNRESOLVED_REVIEW_READ_ADAPTER_VERSION,
        count: preview.summary.affectedEffectCount,
        source: {
          owner: 'ORDER_Q_OWNER_REPOSITORY',
          ownerDatabaseState: source.ownerDatabaseState || 'READY',
          readAt: source.readAt || null
        },
        candidateReference: candidateReference(productResult),
        error: null
      });
    } catch (error) {
      if (exactText(error?.message).startsWith('PRODUCT_')
        || exactText(error?.message).startsWith('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_')) {
        return productError(error, companyId);
      }
      return ownerError(error, companyId, UNRESOLVED_REMATCH_IMPACT_SCHEMA);
    }
  }

  async function previewRematchImpact(options = {}) {
    const result = await previewRematchImpactResult(options);
    if (result.status === UNRESOLVED_REVIEW_STATUS.ERROR) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      error.retryable = result.error.retryable;
      throw error;
    }
    return result;
  }

  return deepFreeze({
    version: UNRESOLVED_REVIEW_READ_ADAPTER_VERSION,
    schemaVersion: UNRESOLVED_REVIEW_READ_MODEL_SCHEMA,
    impactSchemaVersion: UNRESOLVED_REMATCH_IMPACT_SCHEMA,
    ownerAppId: 'orderq-vnext',
    readOnly: true,
    getReview,
    getReviewResult,
    previewRematchImpact,
    previewRematchImpactResult
  });
}

export const unresolvedReviewReadAdapter = createUnresolvedReviewReadAdapter();

globalThis.ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_ADAPTER = unresolvedReviewReadAdapter;
globalThis.ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_ADAPTER_V1 = unresolvedReviewReadAdapter;
