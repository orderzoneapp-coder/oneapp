(function (global) {
  'use strict';

  const EXPECTED_DEPLOYMENT = Object.freeze({ deploymentId: '', deploymentVersion: '', gitCommit: '' });
  const CAPABILITY = 'DATAOPS_CLOSE_V1';
  const ACTIONS = Object.freeze(['dataops_close_ping', 'dataops_close_context', 'dataops_close_seal', 'dataops_close_prepare', 'dataops_close_write_chunks', 'dataops_close_commit', 'dataops_close_abort']);
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
  function requireCredential(value, kind = 'DATAOPS') {
    const credential = { token: text(value?.token), actorId: text(value?.actorId), deviceId: text(value?.deviceId || value?.device), environment: text(value?.environment), scope: { companyId: text(value?.scope?.companyId) } };
    if (!credential.token || !credential.actorId || !credential.scope.companyId) throw new Error('DATAOPS_CLOSE_ACCESS_DENIED');
    if (kind === 'ORDERQ' && (!credential.deviceId || !credential.environment)) throw new Error('DATAOPS_CLOSE_ORDERQ_ACCESS_DENIED');
    return Object.freeze(credential);
  }
  async function defaultPost({ url, dataOpsCredential }, action, body = {}) {
    if (!ACTIONS.includes(action)) throw new Error('DATAOPS_CLOSE_ACTION_FORBIDDEN');
    const response = await global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...body, ...dataOpsCredential, scope: dataOpsCredential.scope }) });
    const json = await response.json();
    if (!response.ok || json?.status !== 'success' || json.action !== action) throw new Error(text(json?.message) || 'DATAOPS_CLOSE_REQUEST_FAILED');
    return json.data;
  }
  function createOrderQReadAdapter({ url, orderQCredential }) {
    const allowed = Object.freeze(['situation_orderq_begin', 'situation_orderq_page', 'situation_orderq_head']);
    async function read(action, body = {}) {
      if (!allowed.includes(action)) throw new Error('DATAOPS_CLOSE_ORDERQ_ACTION_FORBIDDEN');
      const response = await global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', cache: 'no-store',
        body: JSON.stringify({ action, token: orderQCredential.token, schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1', ...body,
          actorId: orderQCredential.actorId, device: orderQCredential.deviceId, environment: orderQCredential.environment, scope: orderQCredential.scope }) });
      const json = await response.json(), keys = json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json).sort() : [];
      if (!response.ok || JSON.stringify(keys) !== JSON.stringify(['action', 'data', 'status']) || json.status !== 'success' || json.action !== action || !json.data || typeof json.data !== 'object' || Array.isArray(json.data)) throw new Error('DATAOPS_CLOSE_ORDERQ_READ_FAILED');
      return json.data;
    }
    return Object.freeze({
      begin: request => read('situation_orderq_begin', request),
      page: request => read('situation_orderq_page', request),
      head: request => read('situation_orderq_head', request)
    });
  }
  async function defaultLoadFrozenSources(context) {
    const [{ beginDataOpsFrozenRead, readDataOpsFrozenPages, confirmDataOpsFrozenHead }, { readOrderQFrozenSnapshot }] = await Promise.all([
      import('../orderq/dataops-situation-read-adapter.js?v=0.1.0'),
      import('../orderq/situation-orchestrator.js?v=0.1.0')
    ]);
    const dataOpsBegin = await beginDataOpsFrozenRead({ url: context.url, credential: context.dataOpsCredential, businessDate: context.businessDate });
    const dataOpsPages = await readDataOpsFrozenPages({ url: context.url, credential: context.dataOpsCredential }, dataOpsBegin);
    const orderq = await readOrderQFrozenSnapshot({ adapter: context.orderQAdapter, dataOps: dataOpsBegin, businessDate: context.businessDate, windowKey: `DAY:${context.businessDate}`, closeContext:context.authoritativeContext,closeSeriesId:context.closeSeriesId });
    const dataOpsHead = await confirmDataOpsFrozenHead({ url: context.url, credential: context.dataOpsCredential }, dataOpsBegin);
    return { dataops: { session: dataOpsBegin, pages: dataOpsPages, head: dataOpsHead, rows: dataOpsPages.flatMap(page => page.rows || []) }, orderq };
  }
  async function defaultReview({ sources, businessDate, closeSeriesId, companyId, authoritativeContext }) {
    const { buildAuthoritativeCloseReview } = await import('../orderq/dataops-close-product-bridge.js?v=0.1.0');
    return buildAuthoritativeCloseReview({ sources, businessDate, closeSeriesId, companyId, authoritativeContext });
  }
  function chunks(kind, value) {
    const source = canonicalJson(value), result = [];
    for (let offset = 0, chunkIndex = 0; offset < source.length; offset += 40000, chunkIndex += 1) result.push({ kind, chunkIndex, content: source.slice(offset, offset + 40000) });
    return result.length ? result : [{ kind, chunkIndex: 0, content: 'null' }];
  }
  function initialState(expected) { return Object.freeze({ phase: 'IDLE', releaseEnabled: released(expected), busy: false, reviewed: false, reviewReason: '', openingBaselineRequired: false, openingBaselineApproved: false, actionType: '', availableActions: [], issues: [], report: null, receipt: null, error: '' }); }

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
      const dataOpsCredential = requireCredential(input.dataOpsCredential, 'DATAOPS'), orderQCredential = requireCredential(input.orderQCredential, 'ORDERQ');
      if (dataOpsCredential.actorId !== orderQCredential.actorId || canonicalJson(dataOpsCredential.scope) !== canonicalJson(orderQCredential.scope)) throw new Error('DATAOPS_CLOSE_AUTHORITY_SCOPE_MISMATCH');
      connection = { url: text(input.url), dataOpsCredential, orderQCredential };
      if (!connection.url) throw new Error('DATAOPS_CLOSE_URL_REQUIRED');
      connection.orderQAdapter = createOrderQReadAdapter(connection);
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
        const { closeSeriesIdentity } = await import('../orderq/dataops-close-core.js?v=0.2.0');
        const closeSeriesId = await closeSeriesIdentity(connection.dataOpsCredential.scope.companyId, businessDate, 'KRW');
        const authoritativeContext = await post(connection, 'dataops_close_context', { closeSeriesId, companyId: connection.dataOpsCredential.scope.companyId, closeBusinessDate: businessDate });
        const sources = await loadFrozenSources({ ...context, ...connection, businessDate,closeSeriesId,authoritativeContext });
        const closeSnapshotA = canonical({ businessDate, scope: connection.dataOpsCredential.scope, contextDigest: authoritativeContext.contextDigest, dataops: { session: sources.dataops.session, head: sources.dataops.head, rows: sources.dataops.rows }, orderq: { session: sources.orderq.session, head: sources.orderq.head, entities: sources.orderq.entities || [] } });
        const sourceADigest = await sha256(closeSnapshotA), capabilityDigest = await sha256({ expected, actions: ACTIONS });
        const seal = await post(connection, 'dataops_close_seal', { closeSeriesId, closeSnapshotA, sourceADigest, capabilityDigest,
          orderqReadRequest: { readSessionId: sources.orderq.session.readSessionId, tokenDigest: sources.orderq.session.tokenDigest }, dataopsReadTokenDigest: sources.dataops.session.tokenDigest });
        const review = await buildReview({ productData, sources, businessDate, closeSeriesId, companyId: connection.dataOpsCredential.scope.companyId, seal, authoritativeContext });
        const hasEffective=Number(authoritativeContext.series?.currentEffectiveRevision||0)>0,availableActions=hasEffective?['CORRECT_CLOSE','REVERSE_CLOSE']:['POST_CLOSE'],actionType=hasEffective?'CORRECT_CLOSE':'POST_CLOSE';
        draft = { businessDate, productData, sources, closeSeriesId, closeSnapshotA, sourceADigest, capabilityDigest, seal, review, authoritativeContext, actionType };
        return publish({ busy: false, phase: 'REVIEW', issues: review.issues || [], report: {...(review.report||{}),seriesHeadRevision:Number(authoritativeContext.series?.seriesHeadRevision||0),currentEffectiveRevision:Number(authoritativeContext.series?.currentEffectiveRevision||0)}, openingBaselineRequired:Boolean(review.openingBaselineRequired),openingBaselineApproved:false,actionType, availableActions, reviewed: false });
      } catch (error) { return fail(error); }
    }
    function markReviewed(value = true) {
      if (state.phase !== 'REVIEW') throw new Error('DATAOPS_CLOSE_REVIEW_REQUIRED');
      return publish({ reviewed: Boolean(value) });
    }
    function selectAction(actionType) { if (!draft || state.phase !== 'REVIEW' || !state.availableActions.includes(actionType)) throw new Error('CLOSE_ACTION_INVALID'); draft.actionType=actionType; return publish({ actionType, reviewed:false }); }
    function approveOpeningBaseline(value=true) { if(!draft||state.phase!=='REVIEW'||!state.openingBaselineRequired)throw new Error('CLOSE_OPENING_BASE_NOT_REQUIRED');return publish({openingBaselineApproved:Boolean(value),reviewed:false}); }
    function setReviewReason(value = '') { if (state.phase !== 'REVIEW') throw new Error('DATAOPS_CLOSE_REVIEW_REQUIRED'); return publish({ reviewReason: text(value), reviewed: false }); }
    async function confirm() {
      if (!draft || state.phase !== 'REVIEW' || !state.reviewed || !text(state.reviewReason) || (state.openingBaselineRequired&&!state.openingBaselineApproved)) throw new Error('DATAOPS_CLOSE_REVIEW_REQUIRED');
      publish({ busy: true, error: '', phase: 'COMMITTING' });
      try {
        if (options.verifyFresh) await options.verifyFresh(draft);
        const commandId = draft.commandId||(draft.commandId=`CLOSE-CMD-${randomId()}`), stageId = draft.stageId||(draft.stageId=`CLOSE-STAGE-${randomId()}`);
        const freshVerification={orderqHeadDigest:draft.seal.orderqHeadDigestAtSeal,dataopsHeadDigest:draft.seal.dataopsHeadDigestAtSeal,capabilityDigest:draft.capabilityDigest,orderqDeployment:draft.seal.orderqDeployment,dataopsDeployment:draft.seal.dataopsDeployment};
        const bridge = await import('../orderq/dataops-close-product-bridge.js?v=0.1.0'),finalizeClose=options.finalizeClose||bridge.finalizeAuthoritativeClose;
        const finalized=draft.finalized||(draft.finalized=await finalizeClose({review:draft.review,sourceSealReceipt:draft.seal,sourceADigest:draft.sourceADigest,actorId:connection.dataOpsCredential.actorId,reviewReason:state.reviewReason,commandId,idempotencyKey:commandId,freshVerification,actionType:draft.actionType,targetRevision:draft.actionType==='REVERSE_CLOSE'?Number(draft.authoritativeContext.series?.currentEffectiveRevision||0):null,openingBaselineApproved:state.openingBaselineApproved}));
        const resultB=finalized.resultSnapshot,resultBDigest=resultB.resultBDigest,issueDecisionDigest=finalized.decisionDigest;
        const sealedVerification = { orderqHeadDigest: draft.seal.orderqHeadDigestAtSeal, dataopsHeadDigest: draft.seal.dataopsHeadDigestAtSeal, capabilityDigest: draft.capabilityDigest, issueDecisionDigest, resultBDigest };
        const staged=[];for(const [kind,value] of [['A',draft.closeSnapshotA],['B',resultB],['ISSUES',draft.review.issues||[]],['DECISIONS',finalized.decisions],['AUDIT',resultB.auditEvents||[]],['REPORT',finalized.reportManifest],['BASELINES',finalized.approvedOpeningBaselines||[]]]){const prepared=await Promise.all(chunks(kind,value).map(async chunk=>({chunkIndex:chunk.chunkIndex,content:chunk.content,chunkDigest:await sha256(chunk.content)})));staged.push({kind,value,chunks:prepared});}
        const stageManifest=[];for(const item of staged)stageManifest.push({kind:item.kind,chunkCount:item.chunks.length,totalBytes:item.chunks.reduce((sum,row)=>sum+new TextEncoder().encode(row.content).length,0),payloadDigest:await sha256(item.value),chunkDigests:item.chunks.map(row=>row.chunkDigest)});
        const series=draft.authoritativeContext.series||{};
        const revisionCore={...finalized.intentPlan.revision};delete revisionCore.finalReceiptFingerprint;
        const intentCore = { ...revisionCore, companyId:connection.dataOpsCredential.scope.companyId,closeBusinessDate:draft.businessDate,closeSeriesId: draft.closeSeriesId, closeRevisionId: finalized.intentPlan.revision.closeRevisionId, revision: finalized.intentPlan.revision.revision, actionType: draft.actionType, expectedSeriesHeadRevision: Number(series.seriesHeadRevision||0), expectedEffectiveRevision:Number(series.currentEffectiveRevision||0),targetRevision: draft.actionType==='REVERSE_CLOSE'?Number(series.currentEffectiveRevision||0):0,previousEffectiveRevision:Number(series.previousEffectiveRevision||0),previousEffectiveRevisionId:text(series.previousEffectiveRevisionId),currentEffectiveRevisionId:finalized.intentPlan.series.currentEffectiveRevisionId||'',closeCloudDeployment:expected,commandId, idempotencyKey: commandId, stageId, sourceSealId:draft.seal.sourceSealId,sourceSealReceiptFingerprint:draft.seal.receiptFingerprint, sourceADigest: draft.sourceADigest, resultBDigest, issueDecisionDigest, reportDigest:finalized.reportManifest.fileDigest, stageManifest, sealedVerification };
        const fingerprint = await sha256(intentCore), finalReceiptFingerprint = await sha256({ ...intentCore, fingerprint });
        const intent = { ...intentCore, fingerprint, finalReceiptFingerprint };
        let receipt=draft.committedReceipt;if(!receipt){await post(connection, 'dataops_close_prepare', { intent });for(const item of staged)await post(connection,'dataops_close_write_chunks',{stageId,commandId,kind:item.kind,chunks:item.chunks});receipt=await post(connection, 'dataops_close_commit', { intent });draft.committedReceipt=receipt;}
        finalized.bundle.revision.finalReceiptFingerprint=receipt.finalReceiptFingerprint||finalized.bundle.revision.finalReceiptFingerprint;
        await (options.persistProjection||bridge.persistOfficialCloseProjection)(finalized.bundle);
        draft = null;
        return publish({ busy: false, phase: 'COMMITTED', receipt, reviewed: true });
      } catch (error) { publish({ phase: 'REVIEW' }); return fail(error); }
    }
    return Object.freeze({ state: () => state, subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); }, connect, start, selectAction, approveOpeningBaseline, setReviewReason, markReviewed, confirm });
  }

  const operator = createDataOpsCloseOperator();
  global.DATAOPS_CLOSE_UI_MODULE = Object.freeze({ EXPECTED_DEPLOYMENT, ACTIONS, evaluateCapability, createOrderQReadAdapter, createDataOpsCloseOperator, operator });
})(typeof window !== 'undefined' ? window : globalThis);
