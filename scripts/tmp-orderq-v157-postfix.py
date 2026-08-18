from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML_FILES = [ROOT / "orderops_list.html", ROOT / "orderops" / "list.html"]
TEST_FILE = ROOT / "scripts" / "test-shipping-management.mjs"


def exact(text, old, new, label, expected=1):
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} matches, got {count}")
    return text.replace(old, new)


for path in HTML_FILES:
    text = path.read_text(encoding="utf-8")

    restore_old = '''        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.sortSettings = Object.create(null);
        saveSortSettings();
        state.columnFilters = Object.create(null);'''
    restore_new = '''        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.sortSettings = loadSortSettings();
        state.columnFilters = Object.create(null);'''
    # restoreLocalRecord has this exact reset block once after the main patch.
    text = exact(text, restore_old, restore_new, f"{path.name}: restore saved sort")

    reset_old = '''      function resetResultViewFilters() {
        state.searchQuery = "";
        state.shortageFocus = false;
        state.specificationFilters.clear();
        state.warehouseFilters.clear();
        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.sortSettings = Object.create(null);
        saveSortSettings();
        state.columnFilters = Object.create(null);'''
    reset_new = '''      function resetResultViewFilters(options = {}) {
        state.searchQuery = "";
        state.shortageFocus = false;
        state.specificationFilters.clear();
        state.warehouseFilters.clear();
        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        if (!options.keepSort) {
          state.sortSettings = Object.create(null);
          saveSortSettings();
        }
        state.columnFilters = Object.create(null);'''
    text = exact(text, reset_old, reset_new, f"{path.name}: reset sort policy")

    text = exact(
        text,
        '''        state.workspace = candidateWorkspace;
        state.activePreview = "validation";
        resetResultViewFilters();
        renderResults();''',
        '''        state.workspace = candidateWorkspace;
        state.activePreview = "validation";
        resetResultViewFilters({ keepSort: true });
        renderResults();''',
        f"{path.name}: replacement analysis keeps sort",
    )
    text = exact(
        text,
        '''          state.workspace = await analyzeCurrentInputs();
          state.activePreview = "validation";
          resetResultViewFilters();
          renderResults();''',
        '''          state.workspace = await analyzeCurrentInputs();
          state.activePreview = "validation";
          resetResultViewFilters({ keepSort: true });
          renderResults();''',
        f"{path.name}: analysis keeps sort",
    )

    path.write_text(text, encoding="utf-8")
    print(f"postfixed: {path.relative_to(ROOT)}")


test = TEST_FILE.read_text(encoding="utf-8")
test = exact(
    test,
    'assert.equal(engine.ENGINE_VERSION, "3.19.0");',
    'assert.equal(engine.ENGINE_VERSION, "3.20.0");',
    "engine version test",
)
TEST_FILE.write_text(test, encoding="utf-8")
print("postfixed: scripts/test-shipping-management.mjs")
