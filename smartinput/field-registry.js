import {
  loadCompanyVoucherFieldSettings,
  loadFieldDefinitions,
  loadSettingValue,
  replaceFieldCatalogGeneration,
  saveCompanyVoucherFieldSettings,
  saveSettingValue
} from './smartinput-data-store.js?v=0.6.0';
import {
  CORE_FIELD_DEFINITIONS,
  CUSTOM_FIELD_DEFINITIONS,
  defaultCompanyVoucherFieldSettings,
  effectiveFieldDefinitions,
  normalizeCompanyVoucherFieldSettings,
  validateFieldCatalog
} from './field-definition-contract.js?v=0.1.0';

export const FIELD_SEED_META_KEY = 'fieldCatalogSeed:v2';
export const DEFAULT_COMPANY_ID = 'ONEAPP';

const text = value => String(value ?? '').trim();

export function resolveSmartInputCompanyId(bundle = null) {
  if (bundle?.session?.companyId) return text(bundle.session.companyId);
  if (bundle?.session?.user?.companyId) return text(bundle.session.user.companyId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.companyId || stored?.session?.user?.companyId) || DEFAULT_COMPANY_ID;
  } catch {
    return DEFAULT_COMPANY_ID;
  }
}

export function resolveSmartInputActor(bundle = null) {
  if (bundle?.session?.user?.loginId) return text(bundle.session.user.loginId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.user?.loginId) || 'SMART_INPUT_ADMIN';
  } catch {
    return 'SMART_INPUT_ADMIN';
  }
}

export async function fetchStaticFieldCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('SMARTINPUT_FIELD_CATALOG_FETCH_UNAVAILABLE');
  const response = await fetchImpl('./field-catalog-seed.v2.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`SMARTINPUT_FIELD_CATALOG_HTTP_${response.status}`);
  return validateFieldCatalog(await response.json());
}

export async function ensureFieldCatalogSeed({ fetchImpl = globalThis.fetch, force = false } = {}) {
  const metadata = await loadSettingValue(FIELD_SEED_META_KEY);
  if (!force && metadata?.generationId && metadata?.definitionCount === 2178) {
    const definitions = await loadFieldDefinitions(metadata.generationId);
    if (definitions.length === metadata.definitionCount) return { metadata, definitions, changed: false };
  }
  const catalog = await fetchStaticFieldCatalog(fetchImpl);
  const definitions = await replaceFieldCatalogGeneration(catalog);
  const nextMetadata = {
    schemaVersion: catalog.schemaVersion,
    generationId: catalog.generationId,
    sourceFile: catalog.sourceFile,
    sourceSha256: catalog.sourceSha256,
    definitionCount: catalog.definitionCount,
    occurrenceCount: catalog.occurrenceCount,
    reviewRequiredCount: catalog.reviewRequiredCount,
    modeCounts: catalog.modeCounts,
    appliedAt: new Date().toISOString()
  };
  await saveSettingValue(FIELD_SEED_META_KEY, nextMetadata);
  return { metadata: nextMetadata, definitions, changed: true };
}

export async function loadVoucherFieldRegistry({ companyId = DEFAULT_COMPANY_ID, voucherMode, actor = '', fetchImpl = globalThis.fetch } = {}) {
  const seeded = await ensureFieldCatalogSeed({ fetchImpl });
  const catalog = seeded.definitions.filter(field => field.voucherModes?.includes(voucherMode));
  let settings = await loadCompanyVoucherFieldSettings(companyId, voucherMode);
  if (!settings.length) {
    settings = defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor);
    await saveCompanyVoucherFieldSettings(settings);
  } else {
    settings = normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings, actor, catalog);
  }
  return {
    companyId,
    voucherMode,
    catalogGenerationId: seeded.metadata.generationId,
    coreDefinitions: CORE_FIELD_DEFINITIONS.filter(field => field.voucherModes.includes(voucherMode)),
    customDefinitions: CUSTOM_FIELD_DEFINITIONS,
    catalog,
    settings,
    enabled: effectiveFieldDefinitions({ catalog, settings, voucherMode }),
    mappingCandidates: effectiveFieldDefinitions({ catalog, settings, voucherMode, mappableOnly: true })
  };
}

export async function updateVoucherFieldSettings({ companyId = DEFAULT_COMPANY_ID, voucherMode, settings, actor = '', definitions = [] } = {}) {
  const normalized = normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings, actor, definitions).map(row => ({
    ...row,
    settingRevision: Number(row.settingRevision || 0) + 1,
    updatedBy: text(actor),
    updatedAt: new Date().toISOString()
  }));
  await saveCompanyVoucherFieldSettings(normalized);
  return normalized;
}
