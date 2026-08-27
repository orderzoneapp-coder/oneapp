import { recognizeBusinessCertificate, certificateFieldLabels } from './company-certificate.js?v=1.0.0';

const PROFILE_FIELDS = Object.freeze({
  basic: [
    ['companyName','회사명','text',true],['companyNameEn','회사명(영문)','text'],['businessNumber','사업자등록번호','business',true],['representativeName','대표자','text',true],
    ['establishedDate','설립일자','date'],['openingDate','개업일자','date'],['taxationType','과세유형','text'],['closingCycle','결산월','number'],
    ['businessTypes','업태','array',false,true],['businessItems','종목','array',false,true]
  ],
  contact: [
    ['companyPhone','회사 전화','tel'],['homePhone','자택 전화','tel'],['email','이메일','email'],['mobile','휴대전화','tel'],['fax','팩스','tel'],['homepage','홈페이지','url'],['taxInvoiceEmail','전자세금계산서 전용 Email','email']
  ],
  address: [
    ['address1','주소1','address',false,true],['address2','주소2','address',false,true],['addressEn','영문 주소','textarea',false,true]
  ],
  certificate: [
    ['jointBusinessEnabled','공동사업자','boolean'],['unitTaxationEnabled','사업자단위과세 적용 여부','boolean'],['certificateIssueReason','발급사유','text'],['certificateIssuedDate','발급일','date'],['taxOfficeName','관할세무서','text']
  ]
});
const VIEW_FIELDS = Object.freeze({
  basic: [['companyName','회사명'],['companyNameEn','회사명(영문)'],['businessNumber','사업자등록번호'],['representativeName','대표자'],['establishedDate','설립일자'],['openingDate','개업일자'],['taxationType','과세유형'],['closingCycle','결산월'],['businessTypes','업태',true],['businessItems','종목',true]],
  contact: [['companyPhone','회사 전화'],['homePhone','자택 전화'],['email','이메일'],['mobile','휴대전화'],['fax','팩스'],['homepage','홈페이지'],['taxInvoiceEmail','전자세금계산서 전용 Email']],
  address: [['postalCode1','우편번호1'],['address1','주소1',true],['postalCode2','우편번호2'],['address2','주소2',true],['addressEn','영문 주소',true]],
  certificate: [['jointBusinessEnabled','공동사업자'],['unitTaxationEnabled','사업자단위과세 적용 여부'],['certificateIssueReason','발급사유'],['certificateIssuedDate','발급일'],['taxOfficeName','관할세무서']]
});
const text = value => String(value ?? '').trim();
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const display = value => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '미등록';
  if (value === true) return '여';
  if (value === false) return '부';
  return value === null || value === undefined || value === '' ? '미등록' : String(value);
};
const formatBusinessNumber = value => {
  const digits = text(value).replace(/\D/g,'');
  return /^\d{10}$/.test(digits) ? `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}` : display(value);
};
const elements = Object.fromEntries(['companyNotice','companyView','companyForm','editButton','certificateButton','basicView','contactView','addressView','certificateView','periodView','periodAddButton','profileMeta','cancelButton','saveButton','periodDialog','periodForm','periodDeleteButton','certificateDialog','certificateDropzone','certificateFile','certificateCamera','ocrProgress','ocrReview','ocrFields','ocrRetryButton','ocrConfirmButton'].map(id => [id, document.getElementById(id)]));
let session = null;
let profile = null;
let accountingPeriods = [];
let dirty = false;
let saving = false;
let ocrResult = null;

function isAdmin() { return session?.user?.role === 'OWNER_MASTER'; }
function notice(message, level = 'normal') { elements.companyNotice.textContent = message; elements.companyNotice.dataset.level = level; }
function setBusy(value) { saving = value; elements.companyForm.setAttribute('aria-busy', String(value)); elements.saveButton.disabled = value; }

function fieldMarkup(definition) {
  const [field, label, type, required, wide] = definition;
  const classes = `field${wide ? ' wide' : ''}`;
  const requiredAttribute = required ? ' required' : '';
  if (type === 'boolean') return `<label class="${classes}"><span>${label}</span><select data-field="${field}"><option value="">미표기</option><option value="true">여</option><option value="false">부</option></select></label>`;
  if (type === 'array') return `<label class="${classes}"><span>${label}</span><textarea data-field="${field}" placeholder="쉼표 또는 줄바꿈으로 구분"${requiredAttribute}></textarea></label>`;
  if (type === 'textarea') return `<label class="${classes}"><span>${label}</span><textarea data-field="${field}"></textarea></label>`;
  if (type === 'address') {
    const suffix = field === 'address1' ? '1' : '2';
    return `<label class="${classes}"><span>${label}</span><div class="address-control"><input data-field="postalCode${suffix}" inputmode="numeric" maxlength="5" placeholder="우편번호"><input data-field="${field}"${requiredAttribute}><button class="button secondary" type="button" data-address-search="${suffix}">주소 검색</button></div></label>`;
  }
  const htmlType = type === 'business' ? 'text' : type;
  const extras = type === 'business' ? ' inputmode="numeric" maxlength="12"' : type === 'number' ? ' min="1" max="12"' : '';
  return `<label class="${classes}"><span>${label}</span><input data-field="${field}" type="${htmlType}"${extras}${requiredAttribute}></label>`;
}

function installFields() {
  Object.entries(PROFILE_FIELDS).forEach(([section, fields]) => { document.getElementById(`${section}Fields`).innerHTML = fields.map(fieldMarkup).join(''); });
}

function viewMarkup(fields) {
  return fields.map(([field,label,wide]) => {
    const value = field === 'businessNumber' ? formatBusinessNumber(profile?.[field]) : display(profile?.[field]);
    const missing = value === '미등록';
    return `<div class="${wide ? 'wide' : ''}"><dt>${escapeHtml(label)}</dt><dd class="${missing ? 'missing' : ''}">${escapeHtml(value)}</dd></div>`;
  }).join('');
}

function renderView() {
  elements.basicView.innerHTML = viewMarkup(VIEW_FIELDS.basic);
  elements.contactView.innerHTML = viewMarkup(VIEW_FIELDS.contact);
  elements.addressView.innerHTML = viewMarkup(VIEW_FIELDS.address);
  elements.certificateView.innerHTML = viewMarkup(VIEW_FIELDS.certificate);
  renderPeriods();
  elements.profileMeta.textContent = profile ? `revision ${profile.revision} · ${profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('ko-KR') : '수정 시각 없음'} · ${profile.updatedBy || '수정자 없음'}` : '';
}

function renderPeriods() {
  if (!accountingPeriods.length) { elements.periodView.innerHTML = '<div class="empty-state">등록된 회계기수가 없습니다.</div>'; return; }
  elements.periodView.innerHTML = accountingPeriods.map(period => `<article class="period-card"><strong>${period.periodNumber}기</strong><span>${escapeHtml(period.startDate)} ~ ${escapeHtml(period.endDate)} · ${period.enabled ? '사용' : '미사용'}</span>${isAdmin() ? `<button type="button" data-period-id="${escapeHtml(period.periodId)}">수정</button>` : ''}</article>`).join('');
}

function writeForm(source) {
  document.querySelectorAll('[data-field]').forEach(input => {
    const field = input.dataset.field;
    const value = source?.[field];
    if (input.tagName === 'SELECT') input.value = value === true ? 'true' : value === false ? 'false' : '';
    else if (Array.isArray(value)) input.value = value.join(', ');
    else input.value = value ?? '';
  });
  dirty = false;
}

function readForm() {
  const changes = {};
  document.querySelectorAll('[data-field]').forEach(input => {
    const field = input.dataset.field;
    if (input.tagName === 'SELECT') changes[field] = input.value === '' ? null : input.value === 'true';
    else if (['businessTypes','businessItems'].includes(field)) changes[field] = input.value.trim() ? input.value.split(/[,\n]/).map(text).filter(Boolean) : null;
    else changes[field] = input.value.trim() || null;
  });
  return changes;
}

function showView() {
  elements.companyForm.hidden = true; elements.companyView.hidden = false; dirty = false;
  const url = new URL(location.href); url.searchParams.set('mode','view'); history.replaceState(null,'',url);
}

function showEdit(seed = profile) {
  if (!isAdmin()) return;
  writeForm(seed || {});
  elements.companyView.hidden = true; elements.companyForm.hidden = false;
  const url = new URL(location.href); url.searchParams.set('mode','edit'); history.replaceState(null,'',url);
}

async function loadCompany() {
  notice('회사정보를 불러오고 있습니다.');
  const data = await window.ONEAPP_AUTH.gateway('company.profile_read', {});
  profile = data.profile || null;
  accountingPeriods = Array.isArray(data.accountingPeriods) ? data.accountingPeriods : [];
  elements.editButton.textContent = profile ? '회사정보 수정' : '회사정보 등록';
  elements.editButton.hidden = !isAdmin(); elements.certificateButton.hidden = !isAdmin(); elements.periodAddButton.hidden = !isAdmin();
  renderView();
  if (!profile) notice(isAdmin() ? '회사정보가 아직 없습니다. 등록하거나 사업자등록증을 인식해 시작하세요.' : '등록된 회사정보가 없습니다. 관리자에게 등록을 요청하세요.');
  else notice('서버에서 최신 회사정보를 확인했습니다.', 'success');
  if (new URLSearchParams(location.search).get('mode') === 'edit' && isAdmin()) showEdit(); else showView();
}

async function saveProfile(event) {
  event.preventDefault();
  if (!isAdmin() || saving || !elements.companyForm.reportValidity()) return;
  const changes = readForm();
  const beforeBusiness = text(profile?.businessNumber).replace(/\D/g,'');
  const nextBusiness = text(changes.businessNumber).replace(/\D/g,'');
  if (beforeBusiness && nextBusiness !== beforeBusiness && !window.confirm('사업자등록번호를 변경하시겠습니까? 감사이력에 기록됩니다.')) return;
  setBusy(true); notice('회사정보를 저장하고 있습니다.');
  try {
    const result = await window.ONEAPP_AUTH.gateway('company.profile_write', { expectedRevision: Number(profile?.revision || 0), changes });
    profile = result.profile; dirty = false; renderView(); showView(); notice('회사정보를 저장했습니다.', 'success');
  } catch (error) {
    if (error.message === 'COMPANY_REVISION_CONFLICT') await loadCompany();
    notice(error.message === 'COMPANY_REVISION_CONFLICT' ? '다른 사용자가 먼저 수정했습니다. 최신 내용을 불러왔습니다.' : `저장하지 못했습니다: ${error.message}`, 'error');
  } finally { setBusy(false); }
}

function openAddressSearch(suffix) {
  if (!window.daum?.Postcode) { notice('주소검색 서비스를 불러오지 못했습니다.', 'error'); return; }
  new window.daum.Postcode({ oncomplete(data) {
    const postal = document.querySelector(`[data-field="postalCode${suffix}"]`);
    const address = document.querySelector(`[data-field="address${suffix}"]`);
    postal.value = data.zonecode || ''; address.value = data.roadAddress || data.jibunAddress || ''; address.focus(); dirty = true;
  }}).open();
}

function openPeriod(period = null) {
  if (!isAdmin()) return;
  document.getElementById('periodId').value = period?.periodId || '';
  document.getElementById('periodRevision').value = String(period?.revision || 0);
  document.getElementById('periodNumber').value = period?.periodNumber || '';
  document.getElementById('periodStartDate').value = period?.startDate || '';
  document.getElementById('periodEndDate').value = period?.endDate || '';
  document.getElementById('periodEnabled').checked = period?.enabled !== false;
  elements.periodDeleteButton.hidden = !period;
  elements.periodDialog.showModal();
}

function periodPayload() {
  return {
    periodId: document.getElementById('periodId').value,
    revision: Number(document.getElementById('periodRevision').value || 0),
    periodNumber: Number(document.getElementById('periodNumber').value),
    startDate: document.getElementById('periodStartDate').value,
    endDate: document.getElementById('periodEndDate').value,
    enabled: document.getElementById('periodEnabled').checked
  };
}

async function savePeriod(operation, event) {
  event?.preventDefault();
  if (!isAdmin() || saving || (operation === 'UPSERT' && !elements.periodForm.reportValidity())) return;
  const period = periodPayload();
  if (operation === 'UPSERT') {
    if (period.startDate > period.endDate) { notice('회계기수 시작일은 종료일보다 늦을 수 없습니다.', 'error'); return; }
    if (accountingPeriods.some(row => row.periodId !== period.periodId && period.startDate <= row.endDate && period.endDate >= row.startDate)) { notice('기존 회계기수와 기간이 겹칩니다.', 'error'); return; }
  }
  setBusy(true);
  try {
    const result = await window.ONEAPP_AUTH.gateway('company.accounting_period_write', { expectedRevision: Number(profile?.revision || 0), operation, period });
    profile.revision = result.profileRevision; accountingPeriods = result.accountingPeriods; renderView(); elements.periodDialog.close(); notice('회계기수를 저장했습니다.', 'success');
    await loadCompany();
  } catch (error) { notice(`회계기수를 저장하지 못했습니다: ${error.message}`, 'error'); }
  finally { setBusy(false); }
}

function resetOcr() {
  ocrResult = null; elements.ocrReview.hidden = true; elements.ocrRetryButton.hidden = true; elements.ocrConfirmButton.hidden = true;
  elements.ocrProgress.hidden = true; elements.certificateDropzone.hidden = false; elements.certificateFile.value = ''; elements.certificateCamera.value = '';
}

function renderOcr(result) {
  const priority = ['businessNumber','companyName','representativeName','openingDate','address1','businessTypes','businessItems'];
  const fields = Object.keys(result.extractedFields).sort((a,b) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)));
  elements.ocrFields.innerHTML = fields.map(field => {
    const score = Number(result.fieldConfidence[field] || 0);
    return `<div class="ocr-field ${score < .7 ? 'low' : ''}"><span>${escapeHtml(certificateFieldLabels[field] || field)}</span><strong>${escapeHtml(display(result.extractedFields[field]))}</strong><small>${score < .7 ? '낮은 신뢰도 · 직접 확인 필요' : `신뢰도 ${Math.round(score * 100)}%`}</small></div>`;
  }).join('');
  elements.certificateDropzone.hidden = true; elements.ocrProgress.hidden = true; elements.ocrReview.hidden = false; elements.ocrRetryButton.hidden = false; elements.ocrConfirmButton.hidden = false;
}

async function processCertificate(file) {
  if (!file) return;
  elements.certificateDropzone.hidden = true; elements.ocrProgress.hidden = false; elements.ocrProgress.querySelector('span').textContent = '문서 형식을 확인하고 있습니다.';
  elements.ocrProgress.querySelector('progress').value = 0;
  try {
    const local = await recognizeBusinessCertificate(file, { Tesseract: window.Tesseract, onProgress({status,progress}) { elements.ocrProgress.querySelector('span').textContent = `문서를 인식하고 있습니다: ${status}`; elements.ocrProgress.querySelector('progress').value = progress; } });
    ocrResult = await window.ONEAPP_AUTH.gateway('company.certificate_extract', { extraction: local });
    renderOcr(ocrResult);
  } catch (error) { resetOcr(); notice(`사업자등록증을 인식하지 못했습니다: ${error.message}`, 'error'); }
}

function confirmOcr() {
  if (!ocrResult || !isAdmin()) return;
  const seeded = Object.assign({}, profile || {}, clone(ocrResult.extractedFields));
  elements.certificateDialog.close(); showEdit(seeded); dirty = true; notice('인식 결과를 입력했습니다. 원본과 대조한 뒤 저장하세요.');
}

function bind() {
  elements.editButton.addEventListener('click', () => showEdit());
  elements.cancelButton.addEventListener('click', () => { if (!dirty || window.confirm('저장하지 않은 변경을 취소하시겠습니까?')) { writeForm(profile || {}); showView(); } });
  elements.companyForm.addEventListener('submit', saveProfile);
  elements.companyForm.addEventListener('input', () => { dirty = true; });
  elements.companyForm.addEventListener('click', event => { const button = event.target.closest('[data-address-search]'); if (button) openAddressSearch(button.dataset.addressSearch); });
  elements.periodAddButton.addEventListener('click', () => openPeriod());
  elements.periodView.addEventListener('click', event => { const button = event.target.closest('[data-period-id]'); if (button) openPeriod(accountingPeriods.find(period => period.periodId === button.dataset.periodId)); });
  elements.periodForm.addEventListener('submit', event => savePeriod('UPSERT', event));
  elements.periodDeleteButton.addEventListener('click', event => { if (window.confirm('이 회계기수를 삭제하시겠습니까?')) savePeriod('DELETE', event); });
  document.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  elements.certificateButton.addEventListener('click', () => { resetOcr(); elements.certificateDialog.showModal(); });
  elements.certificateFile.addEventListener('change', () => processCertificate(elements.certificateFile.files[0]));
  elements.certificateCamera.addEventListener('change', () => processCertificate(elements.certificateCamera.files[0]));
  elements.ocrRetryButton.addEventListener('click', resetOcr); elements.ocrConfirmButton.addEventListener('click', confirmOcr);
  ['dragenter','dragover'].forEach(type => elements.certificateDropzone.addEventListener(type, event => { event.preventDefault(); elements.certificateDropzone.classList.add('is-dragging'); }));
  ['dragleave','drop'].forEach(type => elements.certificateDropzone.addEventListener(type, event => { event.preventDefault(); elements.certificateDropzone.classList.remove('is-dragging'); if (type === 'drop') processCertificate(event.dataTransfer.files[0]); }));
  document.addEventListener('paste', event => { if (!elements.certificateDialog.open) return; const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) processCertificate(file); });
  window.addEventListener('beforeunload', event => { if (!dirty) return; event.preventDefault(); event.returnValue = ''; });
  window.addEventListener('nexus:before-navigate', event => { if (dirty && !window.confirm('저장하지 않은 변경이 있습니다. 이동하시겠습니까?')) event.preventDefault(); });
}

installFields(); bind();
window.ONEAPP_AUTH.ready.then(async currentSession => {
  session = currentSession;
  if (!session) return;
  try { await loadCompany(); }
  catch (error) { notice(`회사정보를 불러오지 못했습니다: ${error.message}`, 'error'); elements.companyView.hidden = false; }
});
