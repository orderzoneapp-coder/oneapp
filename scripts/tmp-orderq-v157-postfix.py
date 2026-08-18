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

    # Normal result refreshes keep saved sort state. The explicit F2 reset clears it separately.
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
    reset_new = '''      function resetResultViewFilters() {
        state.searchQuery = "";
        state.shortageFocus = false;
        state.specificationFilters.clear();
        state.warehouseFilters.clear();
        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.columnFilters = Object.create(null);'''
    text = exact(text, reset_old, reset_new, f"{path.name}: preserve sort on normal refresh")

    # Recovery must reload the user's saved sorting rather than erase it.
    restore_old = '''        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.sortSettings = Object.create(null);
        saveSortSettings();
        state.columnFilters = Object.create(null);'''
    restore_new = '''        state.managerFilters.clear();
        state.managerAssignmentCustomer = "";
        state.sortSettings = loadSortSettings();
        state.columnFilters = Object.create(null);'''
    text = exact(text, restore_old, restore_new, f"{path.name}: restore saved sort")

    # F2 / explicit result-filter reset remains the intentional way to clear sorting.
    filter_reset_old = '''      function runResultFilterReset() {
        if (!state.workspace) return;
        resetResultViewFilters();'''
    filter_reset_new = '''      function runResultFilterReset() {
        if (!state.workspace) return;
        state.sortSettings = Object.create(null);
        saveSortSettings();
        resetResultViewFilters();'''
    text = exact(text, filter_reset_old, filter_reset_new, f"{path.name}: explicit F2 clears sort")

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
