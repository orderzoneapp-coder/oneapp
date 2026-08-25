(function (global) {
  'use strict';

  const EXPECTED_DEPLOYMENT = Object.freeze({ deploymentId: '', deploymentVersion: '', gitCommit: '' });
  const CAPABILITY = 'DATAOPS_CLOSE_V1';
  const ACTIONS = Object.freeze(['dataops_close_ping', 'dataops_close_seal', 'dataops_close_prepare', 'dataops_close_write_chunks', 'dataops_close_commit', 'dataops_close_abort']);
  const text = value => String(value ?? '').trim();
  const canonical = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('DATAOPS_CLOSE_VALUE_INVALID');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[canonical(key)] = canonical(value[key]); return result; }, {});
    throw new Error('DATAOPS_CLOSE_VALUE_INVALID');
  };
  const canonicalJson = value => JSON.stringify(canonical(value));
  async function sha256(value) {
    const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const released = expected => ['deploymentId', 'deploymentVersion', 'gitCommit'].every(key => text(expected[key]));
  function evaluateCapability(ping, expected = EXPECTED_DEPLOYMENT) {
    return Boolean(released(expected) && text(ping?.deploymentId) === text(expected.deploymentId)
      && text(ping?.deploymentVersion) === text(expected.deploymentVersion) && text(ping?.gitCommit) === text(expected.gitCommit)
      && text(ping?.capabilityVersion) === CAPABILITY && JSON.stringify(ping?.actions || []) === JSON.stringify(ACTIONS));
  }
  function requireCredential(value) {
    const credential = { token: text(value?.token), actorId: text(value?.actorId), deviceId: text(value?.deviceId), environment: text(value?.environment), scope: { companyId: text(value?.scope?.companyId) } };
    if (!credential.token || !credential.actorId || !credential.scope.companyId) throw new Error('DATAOPS_CLOSE_ACCESS_DENIED');
    return Object.freeze(credential);
  }
  async function defaultPost({ url, credential }, action, body = {}) {
    if (!ACTIONS.includes(action)) throw new Error('DATAOPS_CLOSE_ACTION_FORBIDDEN');
    const response = await global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...body, ...credential, scope: credential.scope }) });
    const json = await response.json();
    if (!response.ok || json?.status !== 'success' || json.action !== action) throw new Error(text(json?.message) || 'DATAOPS_CLOSE_REQUEST_FAILED');
    return json.data;
  }
  async function defaultLoadFrozenSources(context) {
    const [{ beginDataOpsFrozenRead, readDataOpsFrozenPages, confirmDataOpsFrozenHead }, { readOrderQFrozenSnapshot }, { orderQSituationCloudAdapter }] = await Promise.all([
      import('../orderq/dataops-situation-read-adapter.js?v=0.1.0'),
      import('../orderq/situation-orchestrator.js?v=0.1.0'),
      import('../orderq/orderq-situation-cloud-adapter.js?v=0.1.1')
    ]);
    const dataOpsBegin = await beginDataOpsFrozenRead({ url: context.url, credential: context.credential, businessDate: context.businessDate });
    const dataOpsPages = await readDataOpsFrozenPages({ url: context.url, credential: context.credential }, dataOpsBegin);
    const orderq = await readOrderQFrozenSnapshot({ adapter: orderQSituationCloudAdapter, dataOps: dataOpsBegin, businessDate: context.businessDate, windowKey: `DAY:${context.businessDate}` });
    const dataOpsHead = await confirmDataOpsFrozenHead({ url: context.url, credential: context.credential }, dataOpsBegin);
    return { dataops: { session: dataOpsBegin, pages: dataOpsPages, head: dataOpsHead, rows: dataOpsPages.flatMap(page => page.rows || []) }, orderq };
  }
  function defaultReview({ productData, sources, businessDate }) {
    const issues = (productData || []).flatMap((row, index) => (Array.isArray(row?.이슈) ? row.이슈 : []).map((message, issueIndex) => ({ issueId: `UI-${index + 1}-${issueIndex + 1}`, severity: 'REVIEW', issueCode: 'DATAOPS_WORK_ROW_REVIEW', message: text(message) })));
    return { issues, report: { businessDate, inventoryRows: sources.dataops.rows.length, orderEntities: sources.orderq.entities?.length || 0, workRows: productData.length, issueCount: issues.length } };
  }
  function chunks(kind, value) {
    const source = canonicalJson(value), result = [];
    for (let offset = 0, chunkIndex = 0; offset < source.length; offset += 40000, chunkIndex += 1) result.push({ kind, chunkIndex, content: source.slice(offset, offset + 40000) });
    return result.length ? result : [{ kind, chunkIndex: 0, content: 'null' }];
  }
  function initialState(expected) { return Object.freeze({ phase: 'IDLE', releaseEnabled: released(expected), busy: false, reviewed: false, issues: [], report: null, receipt: null, error: '' }); }

  function createDataOpsCloseOperator(options = {}) {
    const expected = options.expectedDeployment || EXPECTED_DEPLOYMENT;
    const post = options.post || defaultPost;
    const loadFrozenSources = options.loadFrozenSources || defaultLoadFrozenSources;
    const buildReview = options.buildReview || defaultReview;
    const now = options.now || (() => new Date());
    const randomId = options.randomId || (() => global.crypto.randomUUID());
    let connection = null, draft = null, state = initialState(expected);
    const listeners = new Set();
    const publish = patch => { state = Object.freeze({ ...state, ...patch }); listeners.forEach(listener => listener(state)); return state; };
    const fail = error => { publish({ busy: false, error: text(error?.message || error) }); throw error; };
    async function connect(input = {}) {
      if (!released(expected)) throw new Error('DATAOPS_CLOSE_DEPLOYMENT_NOT_RELEASED');
      connection = { url: text(input.url), credential: requireCredential(input.credential) };
      if (!connection.url) throw new Error('DATAOPS_CLOSE_URL_REQUIRED');
      const ping = await post(connection, 'dataops_close_ping');
      if (!evaluateCapability(ping, expected)) { connection = null; throw new Error('DATAOPS_CLOSE_CAPABILITY_REQUIRED'); }
      return true;
    }
    async function start(context = {}) {
      if (!state.releaseEnabled) throw new Error('DATAOPS_CLOSE_DEPLOYMENT_NOT_RELEASED');
      if (!connection) throw new Error('DATAOPS_CLOSE_CONNECTION_REQUIRED');
      publish({ busy: true, error: '', phase: 'READING', reviewed: false, receipt: null });
      try {
        const businessDate = text(context.businessDate), productData = Array.isArray(context.productData) ? context.productData : [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !productData.length) throw new Error('DATAOPS_CLOSE_SOURCE_REQUIRED');
        const sources = await loadFrozenSources({ ...context, ...connection, businessDate });
        const scopeIdentity = canonicalJson(connection.credential.scope);
        const closeSeriesId = `CLOSE-${await sha256({ companyId: connection.credential.scope.companyId, businessDate, currency: 'KRW', scopeIdentity })}`;
        const closeSnapshotA = canonical({ businessDate, scope: connection.credential.scope, productData, dataops: { session: sources.dataops.session, head: sources.dataops.head, rows: sources.dataops.rows }, orderq: { session: sources.orderq.session, head: sources.orderq.head, entities: sources.orderq.entities || [] } });
        const sourceADigest = await sha256(closeSnapshotA), capabilityDigest = await sha256({ expected, actions: ACTIONS });
        const seal = await post(connection, 'dataops_close_seal', { closeSeriesId, closeSnapshotA, sourceADigest, capabilityDigest,
          orderqReadRequest: { readSessionId: sources.orderq.session.readSessionId, tokenDigest: sources.orderq.session.tokenDigest }, dataopsReadTokenDigest: sources.dataops.session.tokenDigest });
        const review = await buildReview({ productData, sources, businessDate, seal });
        draft = { businessDate, productData, sources, closeSeriesId, closeSnapshotA, sourceADigest, capabilityDigest, seal, review };
        return publish({ busy: false, phase: 'REVIEW', issues: review.issues || [], report: review.report || {}, reviewed: false });
      } catch (error) { return fail(error); }
    }
    function markReviewed(value = true) {
      if (state.phase !== 'REVIEW') throw new Error('DATAOPS_CLOSE_REVIEW_REQUIRED');
      return publish({ reviewed: Boolean(value) });
    }
    async function confirm() {
      if (!draft || state.phase !== 'REVIEW' || !state.reviewed) throw new Error('DATAOPS_CLOSE_REVIEW_REQUIRED');
      publish({ busy: true, error: '', phase: 'COMMITTING' });
      try {
        const confirmDataOps = options.confirmDataOpsHead || (async (_current, session) => {
          const { confirmDataOpsFrozenHead } = await import('../orderq/dataops-situation-read-adapter.js?v=0.1.0');
          return confirmDataOpsFrozenHead(connection, session);
        });
        const confirmOrderQ = options.confirmOrderQHead || (async (_current, session) => {
          const { orderQSituationCloudAdapter } = await import('../orderq/orderq-situation-cloud-adapter.js?v=0.1.1');
          const head = await orderQSituationCloudAdapter.head({ readSessionId: session.readSessionId, tokenDigest: session.tokenDigest });
          if (text(head.frozenTokenDigest) !== text(session.tokenDigest)) throw new Error('SITUATION_HEAD_CHANGED');
          return head;
        });
        const freshDataops = await confirmDataOps(draft.sources.dataops.head, draft.sources.dataops.session);
        const freshOrderq = await confirmOrderQ(draft.sources.orderq.head, draft.sources.orderq.session);
        if (text(freshDataops.currentHeadDigest || freshDataops.headDigest) !== text(draft.sources.dataops.head.currentHeadDigest || draft.sources.dataops.head.headDigest)
          || text(freshOrderq.currentHeadDigest || freshOrderq.headDigest) !== text(draft.sources.orderq.head.currentHeadDigest || draft.sources.orderq.head.headDigest)) throw new Error('CLOSE_SOURCE_CHANGED_AFTER_SEAL');
        const resultB = canonical({ report: draft.review.report || {}, issues: draft.review.issues || [] }), resultBDigest = await sha256(resultB), issueDecisionDigest = await sha256({ reviewed: true, issues: draft.review.issues || [] });
        const commandId = `CLOSE-CMD-${randomId()}`, stageId = `CLOSE-STAGE-${randomId()}`, closeRevisionId = `CR-${await sha256({ closeSeriesId: draft.closeSeriesId, sourceADigest: draft.sourceADigest, resultBDigest })}`;
        const sealedVerification = { orderqHeadDigest: text(freshOrderq.currentHeadDigest || freshOrderq.headDigest), dataopsHeadDigest: text(freshDataops.currentHeadDigest || freshDataops.headDigest), capabilityDigest: draft.capabilityDigest, issueDecisionDigest, resultBDigest };
        const intentCore = { closeSeriesId: draft.closeSeriesId, closeRevisionId, revision: 1, actionType: 'POST_CLOSE', expectedSeriesHeadRevision: 0, targetRevision: 0, commandId, idempotencyKey: commandId, stageId, sourceADigest: draft.sourceADigest, resultBDigest, issueDecisionDigest, sealedVerification };
        const fingerprint = await sha256(intentCore), finalReceiptFingerprint = await sha256({ ...intentCore, fingerprint });
        const intent = { ...intentCore, fingerprint, finalReceiptFingerprint, currentEffectiveRevisionId: closeRevisionId };
        await post(connection, 'dataops_close_prepare', { intent });
        for (const [kind, value] of [['A', draft.closeSnapshotA], ['B', resultB], ['ISSUES', draft.review.issues || []]]) {
          const prepared = await Promise.all(chunks(kind, value).map(async chunk => ({ chunkIndex: chunk.chunkIndex, content: chunk.content, chunkDigest: await sha256(chunk.content) })));
          await post(connection, 'dataops_close_write_chunks', { stageId, kind, chunks: prepared });
        }
        const receipt = await post(connection, 'dataops_close_commit', { intent, freshVerification: sealedVerification });
        draft = null;
        return publish({ busy: false, phase: 'COMMITTED', receipt, reviewed: true });
      } catch (error) { publish({ phase: 'REVIEW' }); return fail(error); }
    }
    return Object.freeze({ state: () => state, subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); }, connect, start, markReviewed, confirm });
  }

  const operator = createDataOpsCloseOperator();
  global.DATAOPS_CLOSE_UI_MODULE = Object.freeze({ EXPECTED_DEPLOYMENT, ACTIONS, evaluateCapability, createDataOpsCloseOperator, operator });
})(typeof window !== 'undefined' ? window : globalThis);
