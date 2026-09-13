from pathlib import Path

p = Path('scripts/test-merchops-f8-xlsx-e2e.mjs')
s = p.read_text()
def sub(a, b):
    global s
    assert s.count(a) == 1, (a[:100], s.count(a))
    s = s.replace(a, b, 1)

sub('const makeContext = (scenarioName) => {', '''const embeddedCoreStart = html.indexOf("(function initOneAppCore(global) {");
const embeddedCoreEnd = html.indexOf("})(window);", embeddedCoreStart);
assert.ok(embeddedCoreStart >= 0 && embeddedCoreEnd > embeddedCoreStart);
const embeddedCore = html.slice(embeddedCoreStart, embeddedCoreEnd + "})(window);".length);
const ERP11 = ["품목코드", "입고가", "0", "출고가", "0", "입고B", "n", "도매A", "n", "도매B", "n"];
let reopenedCount = 0;
const makeContext = (scenarioName, coreMode = "external") => {''')
sub('vm.runInContext(coreSource, context, { filename: "coreEngine.js" });', 'vm.runInContext(coreMode === "embedded" ? embeddedCore : coreSource, context, { filename: `${coreMode}-core.js` });')
sub('const runF8Scenario = async ({ name, rows, masterProducts = {}, snapshotRows = null, aggregateTransform = null, noInboundActionQueue = { action: "", codes: [] } }) => {\n  const { context, realXlsx, writtenFiles } = makeContext(name);', '''const runF8Scenario = async ({ name, rows, masterProducts = {}, snapshotRows = null, aggregateTransform = null, noInboundActionQueue = { action: "", codes: [] }, coreMode = "external", prepare = null }) => {
  const { context, realXlsx, writtenFiles } = makeContext(name, coreMode);''')
sub('  await context.__runQuickF8();', '''  if (prepare) await prepare(context);
  const beforeExport = JSON.stringify({ rows, masterProducts, managed: context.data.managedItems });
  await context.__runQuickF8();
  assert.equal(JSON.stringify({ rows, masterProducts, managed: context.data.managedItems }), beforeExport, "F8 must not mutate working rows, source, or master");''')
sub('  return { context, reopened, writtenFile, toasts, alerts };', '''  if (reopened?.Sheets["ERP업데이트"]) {
    const erpSheet = reopened.Sheets["ERP업데이트"];
    const erp = realXlsx.utils.sheet_to_json(erpSheet, { header: 1, raw: true, defval: "" });
    assert.deepEqual(Array.from(erp[0]), ERP11, `${name}: approved ERP headers`);
    assert.ok(erp.every(row => row.length === 11), `${name}: every ERP row must have exactly 11 fields`);
    assert.equal(realXlsx.utils.decode_range(erpSheet["!ref"]).e.c, 10, `${name}: ERP sheet must end at K`);
    assert.ok(Object.keys(erpSheet).filter(key => !key.startsWith("!")).every(key => realXlsx.utils.decode_cell(key).c < 11), `${name}: no hidden trailing ERP cells`);
    reopenedCount++;
    if (process.env.MERCHOPS_F8_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.MERCHOPS_F8_EVIDENCE_DIR, { recursive: true });
      fs.copyFileSync(writtenFile, path.join(process.env.MERCHOPS_F8_EVIDENCE_DIR, path.basename(writtenFile)));
    }
  }
  return { context, reopened, writtenFile, toasts, alerts };''')
sub('  assert.equal(estimateErp[1][11], "", "missing final-transmission must stay blank instead of copying inbound price");', '''  assert.equal(estimateErp[1].length, 11, "final-transmission is excluded by the approved ERP11 contract");
  assert.equal(estimateErp[1][3], 13000, "ERP outbound must remain normal, not promotional");
  assert.equal(estimateShop[1][3], 12000, "shop outbound must retain promo precedence");''')
sub('''  assert.equal(transmissionErp[1][11], 0, "explicit zero final-transmission must survive F8 XLSX generation");
  assert.equal(transmissionErp[2][11], "", "explicit blank final-transmission must survive F8 XLSX generation");
  assert.equal(transmissionErp[3][11], "", "missing final-transmission must survive F8 XLSX generation without fallback");''', '''  assert.ok(transmissionErp.every(row => row.length === 11), "final-transmission is excluded for zero, blank, and missing input without changing the input");
  assert.deepEqual(Array.from(transmissionErp.slice(1), row => row[1]), [9000, 9000, 9000], "removing trailing fields must preserve inbound prices");''')
sub('try {\n  // 대표 Lot 기준:', 'try {\n\n' + Path('.github/merchops-f8-cases.txt').read_text() + '  // 대표 Lot 기준:')
sub('  console.log("MerchOps Quick F8 inventory aggregation, blocking diagnostics, role regressions, and real XLSX reopen checks passed.");', '  console.log(`MerchOps Quick F8: ${reopenedCount} real XLSX reopens passed (ERP11, market, subdivision, inventory, source preservation).`);')
p.write_text(s)

p = Path('scripts/test-merchops-master-reference-isolation.mjs')
s = p.read_text()
lines = s.splitlines(keepends=True)
old = [line for line in lines if line.startswith('assert.') and 'finalTransmission = getBestNumByAliases' in line]
assert len(old) == 2
replacement = 'assert.doesNotMatch(merchSource.slice(f8Start, f8End), /finalTransmission|erpBasicFlag|subErpBasicFlag|erpRow\\[11\\]|erpRow\\[15\\]/, "approved ERP11 omits trailing output fields in every normal/subdivision path");\n'
s = s.replace(old[0], replacement).replace(old[1], '')
p.write_text(s)
for name in ['test-oneapp-parser-wh-20260802-01.mjs', 'test-merchops-common-excel-routing.mjs', 'test-merchops-promo-catalog-compare.mjs', 'test-merchops-master-theme-filter-layout.mjs']:
    p = Path('scripts') / name
    s = p.read_text()
    assert r'v2\.1\.196_F8ShopSaleStock' in s
    s = s.replace(r'v2\.1\.196_F8ShopSaleStock', r'v2\.1\.197_F8MarketERP11').replace('must use v2.1.196', 'must use v2.1.197')
    p.write_text(s)
p = Path('scripts/test-merchops-shared-storage.mjs')
s = p.read_text()
a = '  assert.match(files[name], /<script src="coreEngine\\.js"><\\/script>/, `${name} must load the shared storage engine`);'
b = '''  const coreScript = name === "MerchOps.html"
    ? /<script src="coreEngine\\.js\\?v=20260913-f8-market-erp11"><\\/script>/
    : /<script src="coreEngine\\.js"><\\/script>/;
  assert.match(files[name], coreScript, `${name} must load the shared storage engine`);'''
assert s.count(a) == 1
p.write_text(s.replace(a, b))
print('Updated seven existing regression scripts; unrelated checks retained')
