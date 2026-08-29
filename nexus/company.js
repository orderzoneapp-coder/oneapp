import {
  callCompanyGateway,
  isCompanyAdministrator,
  readSessionBundle,
  refreshSession,
} from './company-transport.js?v=1.0.0';

const SNAPSHOT_KEY = 'oneapp.nexus.company.snapshot.v1';
const FIELD_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'basic', title: '기본정보', fields: Object.freeze([
      ['companyName', '회사명', 'text', true], ['companyNameEn', '회사명(영문)', 'text'],
      ['businessNumber', '사업자등록번호', 'business', true], ['representativeName', '대표자', 'text', true],
      ['establishedDate', '설립일자', 'date'], ['openingDate', '개업일자', 'date'],
      ['taxationType', '과세유형', 'text'], ['closingCycle', '결산월', 'number'],
      ['businessTypes', '업태', 'array', false, true], ['businessItems', '종목', 'array', false, true],
    ]),
  }),
  Object.freeze({
    id: 'contact', title: '연락처', fields: Object.freeze([
      ['companyPhone', '회사 전화', 'tel'], ['homePhone', '자택 전화', 'tel'], ['email', '이메일', 'email'],
      ['mobile', '휴대전화', 'tel'], ['fax', '팩스', 'tel'], ['homepage', '홈페이지', 'url'],
      ['taxInvoiceEmail', '전자세금계산서 전용 Email', 'email'],
    ]),
  }),
  Object.freeze({
    id: 'address', title: '주소', fields: Object.freeze([
      ['postalCode1', '우편번호1', 'postal'], ['address1', '주소1', 'address', false, true],
      ['postalCode2', '우편번호2', 'postal'], ['address2', '주소2', 'address', false, true],
      ['addressEn', '영문 주소', 'textarea', false, true],
    ]),
  }),
  Object.freeze({
    id: 'certificate', title: '사업자등록 세부정보', fields: Object.freeze([
      ['jointBusinessEnabled', '공동사업자', 'boolean'], ['unitTaxationEnabled', '사업자단위과세 적용 여부', 'boolean'],
      ['certificateIssueReason', '발급사유', 'text'], ['certificateIssuedDate', '발급일', 'date'],
      ['taxOfficeName', '관할세무서', 'text'],
    ]),
  }),
]);

const text = (value) => String(value ?? '').trim();
const elements = Object.fromEntries([
  'companyPageNotice', 'companyView', 'companyDetails', 'accountingPeriods', 'companyMeta', 'companyRevision',
  'editCompanyButton', 'companyForm', 'companyFields', 'cancelCompanyButton', 'saveCompanyButton',
].map((id) => [id, document.getElementById(id)]));

let sessionBundle = readSessionBundle();
let currentSession = sessionBundle?.session || null;
let profile = null;
let periods = [];
let dirty = false;
let saving = false;

const display = (value) => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '미등록';
  if (value === true) return '여';
  if (value === false) return '부';
  return value === null || value === undefined || value === '' ? '미등록' : String(value);
};

const formatBusinessNumber = (value) => {
  const digits = text(value).replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : display(value);
};

const setNotice = (message, level = 'normal') => {
  elements.companyPageNotice.textContent = message;
  elements.companyPageNotice.dataset.level = level;
};

const setBusy = (value) => {
  saving = value;
  elements.companyForm.setAttribute('aria-busy', String(value));
  elements.saveCompanyButton.disabled = value;
};

const createDetailSection = (section) => {
  const article = document.createElement('section');
  article.className = 'company-panel';
  const heading = document.createElement('div');
  heading.className = 'company-panel-title';
  const title = document.createElement('h2');
  title.textContent = section.title;
  heading.appendChild(title);
  const list = document.createElement('dl');
  list.className = 'company-detail-grid';
  section.fields.forEach(([field, label, , , wide]) => {
    const row = document.createElement('div');
    if (wide) row.className = 'wide';
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = field === 'businessNumber' ? formatBusinessNumber(profile?.[field]) : display(profile?.[field]);
    if (detail.textContent === '미등록') detail.className = 'missing';
    row.append(term, detail);
    list.appendChild(row);
  });
  article.append(heading, list);
  return article;
};

const renderView = () => {
  elements.companyDetails.replaceChildren(...FIELD_SECTIONS.map(createDetailSection));
  if (periods.length) {
    elements.accountingPeriods.replaceChildren(...periods.map((period) => {
      const row = document.createElement('div');
      row.className = 'company-period';
      const name = document.createElement('strong');
      const range = document.createElement('span');
      name.textContent = `${period.periodNumber}기`;
      range.textContent = `${period.startDate} ~ ${period.endDate} · ${period.enabled ? '사용' : '미사용'}`;
      row.append(name, range);
      return row;
    }));
  } else {
    const empty = document.createElement('p');
    empty.className = 'company-empty';
    empty.textContent = '등록된 회계기수가 없습니다.';
    elements.accountingPeriods.replaceChildren(empty);
  }
  elements.companyRevision.textContent = `revision ${Number(profile?.revision || 0)}`;
  elements.companyMeta.textContent = profile
    ? `서버 수정: ${profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('ko-KR') : '기록 없음'} · ${profile.updatedBy || '수정자 기록 없음'}`
    : '';
};

const createField = ([field, label, type, required, wide]) => {
  const wrapper = document.createElement('label');
  wrapper.className = `company-field${wide ? ' wide' : ''}`;
  const caption = document.createElement('span');
  caption.textContent = label;
  let control;
  if (type === 'boolean') {
    control = document.createElement('select');
    [['', '미표기'], ['true', '여'], ['false', '부']].forEach(([value, optionLabel]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = optionLabel;
      control.appendChild(option);
    });
  } else if (type === 'array' || type === 'textarea') {
    control = document.createElement('textarea');
    if (type === 'array') control.placeholder = '쉼표 또는 줄바꿈으로 구분';
  } else {
    control = document.createElement('input');
    control.type = ['business', 'postal'].includes(type) ? 'text' : type;
    if (type === 'business') { control.inputMode = 'numeric'; control.maxLength = 12; }
    if (type === 'postal') { control.inputMode = 'numeric'; control.maxLength = 5; }
    if (type === 'number') { control.min = '1'; control.max = '12'; }
  }
  control.dataset.field = field;
  control.required = Boolean(required);
  wrapper.append(caption, control);
  if (type === 'address') {
    const suffix = field.endsWith('1') ? '1' : '2';
    const button = document.createElement('button');
    button.className = 'company-address-button';
    button.type = 'button';
    button.dataset.addressSearch = suffix;
    button.textContent = '주소 검색';
    wrapper.appendChild(button);
  }
  return wrapper;
};

const buildForm = () => {
  const sections = FIELD_SECTIONS.map((section) => {
    const article = document.createElement('section');
    article.className = 'company-panel';
    const heading = document.createElement('div');
    heading.className = 'company-panel-title';
    const title = document.createElement('h2');
    title.textContent = section.title;
    heading.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'company-field-grid';
    grid.append(...section.fields.map(createField));
    article.append(heading, grid);
    return article;
  });
  elements.companyFields.replaceChildren(...sections);
};

const setFormValues = () => {
  document.querySelectorAll('[data-field]').forEach((control) => {
    const value = profile?.[control.dataset.field];
    if (control.tagName === 'SELECT') control.value = value === true ? 'true' : value === false ? 'false' : '';
    else if (Array.isArray(value)) control.value = value.join(', ');
    else control.value = value ?? '';
  });
  dirty = false;
};

const fieldValue = (control) => {
  if (control.tagName === 'SELECT') return control.value === '' ? null : control.value === 'true';
  if (['businessTypes', 'businessItems'].includes(control.dataset.field)) {
    const values = control.value.split(/[,\n]/).map(text).filter(Boolean);
    return values.length ? [...new Set(values)] : null;
  }
  return text(control.value) || null;
};

const collectChanges = () => {
  const changes = {};
  document.querySelectorAll('[data-field]').forEach((control) => {
    const field = control.dataset.field;
    let value = fieldValue(control);
    let current = profile?.[field] ?? null;
    if (field === 'businessNumber') {
      value = value ? text(value).replace(/\D/g, '') : null;
      current = current ? text(current).replace(/\D/g, '') : null;
    }
    if (JSON.stringify(value) !== JSON.stringify(current)) changes[field] = value;
  });
  return changes;
};

const showView = () => {
  elements.companyForm.hidden = true;
  elements.companyView.hidden = false;
  dirty = false;
};

const showEdit = () => {
  if (!isCompanyAdministrator(currentSession) || !profile) return;
  setFormValues();
  elements.companyView.hidden = true;
  elements.companyForm.hidden = false;
};

const savePublicSnapshot = (snapshot) => {
  if (!snapshot?.companyName || !Number.isInteger(Number(snapshot.revision))) return;
  try { sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ snapshot, cachedAt: new Date().toISOString() })); } catch {}
};

const loadCompany = async () => {
  setNotice('서버 회사정보와 revision을 확인하고 있습니다.');
  const result = await callCompanyGateway({
    appId: 'company', operationId: 'company.profile_read', sessionToken: sessionBundle.token, payload: {},
  });
  if (!result?.profile || !Number.isInteger(Number(result.profile.revision))) {
    throw new Error('COMPANY_PROFILE_NOT_READY');
  }
  profile = result.profile;
  periods = Array.isArray(result.accountingPeriods) ? result.accountingPeriods : [];
  renderView();
  elements.editCompanyButton.hidden = false;
  showView();
  setNotice(`서버 revision ${profile.revision}을 확인했습니다.`, 'success');
  if (new URLSearchParams(location.search).get('mode') === 'edit') showEdit();
};

const saveCompany = async (event) => {
  event.preventDefault();
  if (saving || !isCompanyAdministrator(currentSession) || !elements.companyForm.reportValidity()) return;
  const changes = collectChanges();
  if (!Object.keys(changes).length) {
    showView();
    setNotice('변경된 값이 없어 서버에 쓰지 않았습니다.', 'success');
    return;
  }
  setBusy(true);
  setNotice('관리자 권한과 revision을 확인하여 저장하고 있습니다.');
  let savedRevision = null;
  try {
    const result = await callCompanyGateway({
      appId: 'company',
      operationId: 'company.profile_write',
      sessionToken: sessionBundle.token,
      payload: { expectedRevision: Number(profile.revision), changes },
    });
    profile = result.profile;
    savedRevision = Number(profile.revision);
    savePublicSnapshot(result.publicSnapshot);
    renderView();
    showView();
  } catch (error) {
    if (error.message === 'COMPANY_REVISION_CONFLICT') {
      try {
        await loadCompany();
        setNotice('다른 관리자가 먼저 저장했습니다. 최신 값을 다시 불러왔습니다.', 'error');
      } catch (reloadError) {
        setNotice(`revision 충돌 후 최신 값을 불러오지 못했습니다: ${reloadError.message}`, 'error');
      }
    } else {
      setNotice(`저장하지 못했습니다: ${error.message}`, 'error');
    }
    setBusy(false);
    return;
  }
  try {
    await loadCompany();
    setNotice(`revision ${profile.revision}로 저장하고 서버 재조회를 완료했습니다.`, 'success');
  } catch (error) {
    setNotice(`revision ${savedRevision} 저장은 완료됐지만 재조회에 실패했습니다. 다시 저장하지 말고 새로고침하세요: ${error.message}`, 'error');
  }
  setBusy(false);
};

const loadAddressSearch = () => {
  if (window.daum?.Postcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById('companyPostcodeApi');
    if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
    const script = document.createElement('script');
    script.id = 'companyPostcodeApi';
    script.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

const openAddressSearch = async (suffix) => {
  try {
    await loadAddressSearch();
    if (!window.daum?.Postcode) throw new Error('ADDRESS_SEARCH_UNAVAILABLE');
    new window.daum.Postcode({ oncomplete(data) {
      const postal = document.querySelector(`[data-field="postalCode${suffix}"]`);
      const address = document.querySelector(`[data-field="address${suffix}"]`);
      postal.value = data.zonecode || '';
      address.value = data.roadAddress || data.jibunAddress || '';
      dirty = true;
      address.focus();
    } }).open();
  } catch {
    setNotice('주소검색 서비스를 불러오지 못했습니다. 우편번호와 주소를 직접 입력하세요.', 'error');
  }
};

const bind = () => {
  elements.editCompanyButton.addEventListener('click', showEdit);
  elements.cancelCompanyButton.addEventListener('click', () => {
    if (!dirty || window.confirm('저장하지 않은 변경을 취소하시겠습니까?')) showView();
  });
  elements.companyForm.addEventListener('submit', saveCompany);
  elements.companyForm.addEventListener('input', () => { dirty = true; });
  elements.companyForm.addEventListener('click', (event) => {
    const button = event.target.closest('[data-address-search]');
    if (button) openAddressSearch(button.dataset.addressSearch);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
};

const start = async () => {
  buildForm();
  bind();
  if (!sessionBundle) {
    setNotice('로그인이 필요합니다. NEXUS 홈에서 로그인하세요.', 'error');
    return;
  }
  if (!isCompanyAdministrator(currentSession)) {
    setNotice('회사정보 수정 권한이 없습니다. 일반 사용자는 NEXUS 홈의 읽기 전용 카드를 이용하세요.', 'error');
    return;
  }
  try {
    currentSession = await refreshSession(sessionBundle.token);
    sessionBundle = { ...sessionBundle, session: currentSession };
    if (!isCompanyAdministrator(currentSession)) {
      setNotice('최신 Session에 회사정보 수정 권한이 없습니다.', 'error');
      return;
    }
    await loadCompany();
  } catch (error) {
    setNotice(`회사정보를 불러오지 못했습니다: ${error.message}`, 'error');
  }
};

start();
