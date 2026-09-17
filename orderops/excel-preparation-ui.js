/* ORDER Q only: pending Excel settings never become the active work until apply succeeds. */
(function (root) {
  "use strict";
  const TEMPLATE_KEY = "oneapp.orderops.excel-templates.v1";
  const TEMPLATE_SCHEMA = "orderops-excel-templates/v1";
  const KIND_NAMES = { orders: "주문서", purchases: "구매", sales: "판매", inventory: "재고" };
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function mount(options) {
    const doc = options.document || root.document;
    const helper = root.OrderOpsExcelPreparation;
    if (!helper || !doc.getElementById("prepDropZone")) return null;
    const ids = ["KindButtons", "DropZone", "FileButton", "FileList", "FileDetails", "MappingDetails", "FileName", "KindSelect", "TemplateName", "SheetSelect", "HeaderRow", "StartRow", "EndRow", "SourcePreview", "ColumnMappings", "MappingStatus", "SaveTemplateButton", "ApplyButton", "PreviewTabs"];
    const el = Object.fromEntries(ids.map((name) => [name, doc.getElementById(`prep${name}`)]));
    const cache = new WeakMap();
    const attempts = new WeakMap();
    const records = [];
    let selectedId = "";
    let selectedKind = "orders";
    let serial = 0;
    let applying = false;
    let templates = [];
    try {
      const stored = JSON.parse(root.localStorage.getItem(TEMPLATE_KEY) || "null");
      if (stored?.schemaVersion === TEMPLATE_SCHEMA && Array.isArray(stored.items)) templates = stored.items;
    } catch (_) { /* A corrupt preference never clears work or prevents file input. */ }
    const busy = () => applying || options.isBusy();
    const selected = () => records.find((item) => item.id === selectedId);
    const draftOf = (record) => record?.drafts?.[record.sheetName];
    const messageOf = (errors) => (errors || []).map((error) => error.message || error.code).join(" · ");
    const fail = (message) => { throw new Error(message); };

    async function read(file) {
      if (!cache.has(file)) {
        const pending = (async () => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const fileHash = await options.sha256(bytes);
          const workbook = root.XLSX.read(bytes, { type: "array", cellDates: false, cellNF: true, cellText: true });
          if (!workbook.SheetNames.length) fail("Excel에 읽을 수 있는 시트가 없습니다.");
          const sheets = Object.fromEntries(workbook.SheetNames.map((name) => [name, {
            rawMatrix: root.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }),
            displayMatrix: root.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true }),
          }]));
          return { workbook, sheets, fileHash };
        })();
        cache.set(file, pending);
        pending.catch(() => cache.delete(file));
      }
      return cache.get(file);
    }

    function makeRecord(file, kind) {
      const prior = attempts.get(file)?.get(kind);
      const record = { id: `excel-${++serial}`, kind, file, fileName: file.name, sheetName: "", drafts: prior ? copy(prior.drafts) : Object.create(null), status: "reading", error: "", dirty: false, context: prior?.context || null, parsed: null, templateName: "" };
      if (!attempts.has(file)) attempts.set(file, new Map());
      attempts.get(file).set(kind, record);
      return record;
    }

    function remember(record) {
      if (!records.includes(record)) {
        // A new candidate never erases another file's unresolved mapping work.
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index].file === record.file && records[index].kind === record.kind && records[index].status !== "applied") records.splice(index, 1);
        }
        records.push(record);
      }
      selectedId = record.id;
      selectedKind = record.kind;
      render();
    }

    function nativeParse(record, sheetName, matrices) {
      try {
        const parsed = options.parseSheet({ workbook: record.context.workbook, fileName: record.fileName, fileHash: record.context.fileHash,
          sheetName, kind: record.kind, rawMatrix: matrices.rawMatrix, displayMatrix: matrices.displayMatrix, columnMappings: matrices.columns,
          headerRowIndex: matrices.sourceMetadata ? matrices.sourceMetadata.headerRow - 1 : undefined });
        const draft = helper.createDraft({ kind: record.kind, sheetName, ...matrices, parsed, headerAliases: options.getMappings()?.[record.kind]?.columns || {} });
        const validation = helper.validateDraft({ ...matrices, draft });
        if (!validation.ok) parsed.errors = [...(parsed.errors || []), ...validation.errors];
        return parsed;
      } catch (error) {
        return { kind: record.kind, fileName: record.fileName, fileHash: record.context.fileHash, sheetName,
          headerRowIndex: 0, rows: [], rowCount: 0, missingColumns: ["필수 항목"], errors: [{ message: error.message }] };
      }
    }

    function mappedParse(record, draft) {
      const matrices = record.context.sheets[draft.sheetName];
      const transformed = helper.applyDraft({ ...matrices, draft });
      if (!transformed.ok) fail(messageOf(transformed.errors));
      const parsed = nativeParse(record, draft.sheetName, transformed);
      // Parser projections may rename headers; the source matrix remains independently recoverable.
      parsed.intakeMapping = { schemaVersion: "orderops-intake-mapping/v1", draft: copy(draft), sourceMetadata: copy(transformed.sourceMetadata || {}),
        originalRawMatrix: copy(matrices.rawMatrix), originalDisplayMatrix: copy(matrices.displayMatrix) };
      return parsed;
    }

    async function parse(file, kind, { probe = false, sheetName: fixedSheet } = {}) {
      const record = makeRecord(file, kind);
      if (!probe) remember(record);
      try {
        record.context = await read(file);
        const candidates = [];
        for (const sheetName of fixedSheet ? [fixedSheet] : record.context.workbook.SheetNames) {
          const matrices = record.context.sheets[sheetName];
          let parsed;
          try { parsed = nativeParse(record, sheetName, matrices); }
          catch (error) { parsed = { kind, fileName: file.name, fileHash: record.context.fileHash, sheetName, headerRowIndex: 0, rows: [], rowCount: 0, missingColumns: ["필수 항목"], errors: [{ message: error.message }] }; }
          let draft = helper.createDraft({ kind, sheetName, ...matrices, parsed, headerAliases: options.getMappings()?.[kind]?.columns || {} });
          record.sheetName = sheetName;
          record.drafts[sheetName] = draft;
          const matches = templates.map((template) => ({ template, match: helper.matchTemplate({ template, kind, sheetName, ...matrices, parsed }) })).filter((item) => item.match.ok);
          if (matches.length > 1) fail("같은 항목 구조의 양식이 둘 이상입니다. 사용할 매핑을 확인하세요.");
          if (matches.length === 1) {
            draft = matches[0].match.draft;
            parsed = mappedParse(record, draft);
            record.templateName = matches[0].template.name;
          }
          record.drafts[sheetName] = draft;
          candidates.push({ parsed, sheetName, score: (parsed.missingColumns?.length || 0) * 1000 + (parsed.errors?.length || 0) * 100 + (parsed.rowCount > 0 ? 0 : 10),
            alias: options.sheetAliasScore(sheetName, options.getMappings()?.[kind]?.sheetAliases) });
        }
        candidates.sort((left, right) => left.score - right.score || right.alias - left.alias);
        const first = candidates[0];
        record.sheetName = first.sheetName;
        record.parsed = first.parsed;
        record.status = "ready";
        const equal = candidates.filter((item) => item.score === 0 && item.alias === first.alias);
        if (first.score === 0 && equal.length > 1) fail("같은 종류로 사용할 수 있는 시트가 둘 이상입니다. 시트를 하나 선택하세요.");
        try { options.validate(kind, first.parsed); }
        catch (error) { record.status = "review"; record.error = error.message; }
        Object.defineProperty(first.parsed, "preparationRecord", { value: record, configurable: true, enumerable: false });
        if (!probe) render();
        return first.parsed;
      } catch (error) {
        record.status = "review";
        record.error = error.message;
        if (!record.sheetName && record.context) record.sheetName = record.context.workbook.SheetNames[0];
        if (!probe) { remember(record); el.FileDetails.open = true; el.MappingDetails.open = true; }
        throw error;
      }
    }

    async function retainCandidate(file, { kind, error } = {}) {
      const initialKind = helper.KINDS.includes(kind) ? kind : selectedKind;
      let record = [...records].reverse().find((item) => item.file === file && item.status !== "applied" && (!kind || item.kind === initialKind));
      record ||= attempts.get(file)?.get(initialKind);
      if (!record || record.status === "applied") record = makeRecord(file, initialKind);
      const reason = error?.message || (error ? String(error) : "자료 종류·시트·항목 연결을 확인하세요.");
      try {
        record.context ||= await read(file);
        record.sheetName ||= record.context.workbook.SheetNames[0];
        for (const sheetName of record.context.workbook.SheetNames) {
          if (record.drafts[sheetName]) continue;
          const matrices = record.context.sheets[sheetName];
          const parsed = nativeParse(record, sheetName, matrices);
          record.drafts[sheetName] = helper.createDraft({ kind: record.kind, sheetName, ...matrices, parsed,
            headerAliases: options.getMappings()?.[record.kind]?.columns || {} });
          if (sheetName === record.sheetName && !record.parsed) record.parsed = parsed;
        }
        record.error = reason;
      } catch (readError) {
        record.error = error ? `${reason} · ${readError.message}` : readError.message;
      }
      record.status = "review";
      remember(record);
      el.FileDetails.open = true;
      el.MappingDetails.open = true;
      return record;
    }

    function markApplied(byKind) {
      for (const [kind, parsed] of byKind) {
        const record = parsed.preparationRecord;
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index].kind === kind && records[index] !== record && records[index].status === "applied") records.splice(index, 1);
        }
        if (record) {
          record.status = "applied";
          record.error = "";
          record.dirty = false;
          record.parsed = parsed;
          remember(record);
        }
      }
      render();
    }

    function markFailed(kind, error) {
      const record = [...records].reverse().find((item) => item.kind === kind && item.status !== "applied");
      if (record) {
        record.status = "review";
        record.error = error.message || String(error);
        selectedId = record.id;
        el.FileDetails.open = true;
        el.MappingDetails.open = true;
      }
      render();
    }

    function renderFields(record) {
      const draft = draftOf(record);
      el.FileName.textContent = record?.fileName || "파일을 불러오면 여기에 표시됩니다.";
      el.KindSelect.value = record?.kind || selectedKind;
      el.TemplateName.value = record?.templateName || "";
      el.SheetSelect.innerHTML = record?.context ? record.context.workbook.SheetNames.map((name) => `<option value="${html(name)}">${html(name)}</option>`).join("") : "<option value=''>시트 없음</option>";
      el.SheetSelect.value = record?.sheetName || "";
      for (const [control, key] of [["HeaderRow", "headerRow"], ["StartRow", "startRow"], ["EndRow", "endRow"]]) el[control].value = draft?.[key] ?? "";
      const matrices = record?.context?.sheets[record.sheetName];
      const rows = matrices?.displayMatrix?.slice(Math.max(0, (draft?.headerRow || 1) - 1), Math.max(0, (draft?.headerRow || 1) - 1) + 6) || [];
      el.SourcePreview.innerHTML = rows.length ? `<table aria-label="원본 미리보기"><tbody>${rows.map((cells, index) => `<tr><th scope="row">${(draft?.headerRow || 1) + index}</th>${cells.map((value) => `<td>${html(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "원본 미리보기";
      const fields = helper.FIELDS[record?.kind || selectedKind] || [];
      const fieldNames = fields.map((field) => typeof field === "string" ? field : field.value || field.canonical || field.id);
      el.ColumnMappings.innerHTML = draft ? draft.columns.map((column) => {
        const choices = [...new Set([...fieldNames, ...(record.kind === "inventory" ? [helper.WAREHOUSE_TARGET] : []), ...(column.target ? [column.target] : [])])];
        return `<label class="prep-column-row"><span class="prep-column-source">${column.sourceIndex + 1}. ${html(column.sourceHeader || "(공란)")}</span><select data-prep-column="${column.sourceIndex}" aria-label="${column.sourceIndex + 1}열 ${html(column.sourceHeader)} 연결"><option value="">제외</option>${choices.map((field) => `<option value="${html(field)}"${column.enabled !== false && column.target === field ? " selected" : ""}>${html(helper.FIELD_LABELS[field] || field)}</option>`).join("")}</select></label>`;
      }).join("") : "파일을 선택하세요.";
      const status = record ? record.error || (record.dirty ? "수정한 매핑을 자료에 반영하세요." : record.status === "applied" ? `반영 완료 · ${record.parsed?.rowCount || 0}건` : record.status === "reading" ? "파일 읽는 중…" : "항목 연결을 확인하세요.") : "정상 매핑 자료는 불러오면 바로 표시됩니다.";
      el.MappingStatus.textContent = status;
      el.MappingStatus.dataset.state = record?.status || "empty";
      el.ApplyButton.disabled = busy() || !draft || (record.status === "applied" && !record.dirty);
      el.SaveTemplateButton.disabled = busy() || !draft;
      ["KindSelect", "TemplateName", "SheetSelect", "HeaderRow", "StartRow", "EndRow"].forEach((name) => { el[name].disabled = busy() || !record?.context; });
      el.ColumnMappings.querySelectorAll("select").forEach((node) => { node.disabled = busy(); });
    }

    function render() {
      el.KindButtons.querySelectorAll("[data-prep-kind]").forEach((button) => {
        const active = button.dataset.prepKind === selectedKind;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
        button.disabled = busy();
      });
      el.FileButton.disabled = busy();
      el.DropZone.setAttribute("aria-busy", String(busy()));
      const work = options.getWorkspace?.();
      const appliedKinds = new Set(records.filter((record) => record.status === "applied").map((record) => record.kind));
      const restored = work ? Object.entries(KIND_NAMES).flatMap(([kind, label]) => {
        const source = work.sourceFiles?.[kind] || work.orderOpsInputs?.[kind];
        return source && !appliedKinds.has(kind) ? [`<div class="prep-file-item" data-state="applied" data-prep-restored-kind="${kind}"><span class="prep-file-name">${html(source.fileName)}<span class="prep-file-status">${label} · 복구 ${source.rowCount ?? source.rows?.length ?? work[kind]?.length ?? 0}건</span></span></div>`] : [];
      }) : [];
      const pendingAndApplied = records.map((record) => `<div class="prep-file-item${record.id === selectedId ? " is-selected" : ""}" data-state="${record.status}"><button type="button" class="prep-file-name" data-prep-file="${record.id}">${html(record.fileName)}<span class="prep-file-status">${KIND_NAMES[record.kind]} · ${record.status === "applied" ? `반영 ${record.parsed?.rowCount || 0}건` : record.status === "reading" ? "읽는 중" : "확인 필요"}</span></button><button type="button" class="prep-file-remove" data-prep-remove="${record.id}" aria-label="${html(record.fileName)} ${record.status === "applied" ? "자료 해제" : "후보 제거"}"${busy() ? " disabled" : ""}>×</button></div>`);
      el.FileList.innerHTML = [...restored, ...pendingAndApplied].join("") || "<p class='prep-empty'>불러온 파일이 없습니다.</p>";
      if (restored.length) el.FileList.innerHTML += "<p class='prep-empty'>저장된 작업을 함께 표시합니다. 원본을 바꾸려면 파일을 불러오세요.</p>";
      renderFields(selected());
    }

    function editDraft(callback) {
      if (busy()) return;
      const record = editableRecord();
      const draft = draftOf(record);
      if (!record || !draft) return;
      callback(draft, record);
      record.dirty = true;
      record.error = "";
      render();
    }

    function editableRecord() {
      const record = selected();
      if (!record || record.status !== "applied") return record;
      const pending = { ...record, id: `excel-${++serial}`, drafts: copy(record.drafts), status: "review", dirty: true };
      records.push(pending);
      selectedId = pending.id;
      return pending;
    }

    el.KindButtons.addEventListener("click", (event) => {
      const button = event.target.closest("[data-prep-kind]");
      if (!button || busy()) return;
      selectedKind = button.dataset.prepKind;
      const record = [...records].reverse().find((item) => item.kind === selectedKind);
      selectedId = record?.id || "";
      render();
    });
    const pick = () => { if (!busy()) doc.getElementById(`${selectedKind}Input`).click(); };
    el.FileButton.addEventListener("click", (event) => { event.stopPropagation(); pick(); });
    el.DropZone.addEventListener("click", (event) => { if (!event.target.closest("button")) pick(); });
    el.DropZone.addEventListener("keydown", (event) => { if (event.target === el.DropZone && ["Enter", " "].includes(event.key)) { event.preventDefault(); pick(); } });
    for (const type of ["dragenter", "dragover"]) el.DropZone.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation(); el.DropZone.classList.add("is-dragging"); });
    el.DropZone.addEventListener("dragleave", () => el.DropZone.classList.remove("is-dragging"));
    el.DropZone.addEventListener("drop", (event) => {
      event.preventDefault(); event.stopPropagation(); el.DropZone.classList.remove("is-dragging");
      if (busy()) return;
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length === 1) options.onFile(selectedKind, files[0]);
      else options.onBundle(files);
    });
    el.FileList.addEventListener("click", async (event) => {
      if (busy()) return;
      const remove = event.target.closest("[data-prep-remove]");
      const button = event.target.closest("[data-prep-file]");
      if (remove) {
        const record = records.find((item) => item.id === remove.dataset.prepRemove);
        if (!record) return;
        if (record.status === "applied") {
          if (!root.confirm(`${record.fileName}의 ${KIND_NAMES[record.kind]} 자료를 현재 작업에서 해제할까요? 원본 파일과 기존 복구 이력은 유지됩니다.`)) return;
          try { applying = true; render(); await options.removeKind(record.kind); }
          catch (error) { options.toast(error.message, true); return; }
          finally { applying = false; options.onSettled?.(); render(); }
        }
        records.splice(records.indexOf(record), 1);
        if (selectedId === record.id) selectedId = records.at(-1)?.id || "";
        render();
      } else if (button) {
        selectedId = button.dataset.prepFile;
        selectedKind = selected().kind;
        render();
      }
    });
    el.SheetSelect.addEventListener("change", () => {
      if (busy()) return;
      const record = editableRecord();
      if (!record) return;
      record.sheetName = el.SheetSelect.value;
      if (!record.drafts[record.sheetName]) {
        const matrices = record.context.sheets[record.sheetName];
        record.drafts[record.sheetName] = helper.createDraft({ kind: record.kind, sheetName: record.sheetName, ...matrices,
          parsed: nativeParse(record, record.sheetName, matrices), headerAliases: options.getMappings()?.[record.kind]?.columns || {} });
      }
      record.dirty = true; record.error = "";
      render();
    });
    el.KindSelect.addEventListener("change", () => {
      if (busy()) return;
      const record = editableRecord();
      if (!record?.context) return;
      record.kind = el.KindSelect.value;
      selectedKind = record.kind;
      for (const sheetName of record.context.workbook.SheetNames) {
        const matrices = record.context.sheets[sheetName];
        record.drafts[sheetName] = helper.createDraft({ kind: record.kind, sheetName, ...matrices, parsed: nativeParse(record, sheetName, matrices), headerAliases: options.getMappings()?.[record.kind]?.columns || {} });
      }
      record.dirty = true; record.error = "";
      render();
    });
    el.TemplateName.addEventListener("input", () => { const record = selected(); if (record) record.templateName = el.TemplateName.value; });
    el.HeaderRow.addEventListener("change", () => {
      const value = Number(el.HeaderRow.value);
      const record = selected();
      if (!record || busy()) return;
      if (!Number.isInteger(value) || value < 1 || value > record.context.sheets[record.sheetName].rawMatrix.length) {
        options.toast("항목명 행은 원본 안의 정수 행 번호로 입력하세요. 기존 설정은 유지됩니다.", true);
        render();
        return;
      }
      editDraft((draft, record) => {
        const matrices = record.context.sheets[record.sheetName];
        record.drafts[record.sheetName] = helper.createDraft({ kind: record.kind, sheetName: record.sheetName, ...matrices, parsed: { headerRowIndex: value - 1 }, headerAliases: options.getMappings()?.[record.kind]?.columns || {} });
      });
    });
    for (const [control, key] of [["StartRow", "startRow"], ["EndRow", "endRow"]]) el[control].addEventListener("change", () => { const value = Number(el[control].value); editDraft((draft) => { draft[key] = value; }); });
    el.ColumnMappings.addEventListener("change", (event) => {
      if (!event.target.matches("[data-prep-column]")) return;
      const index = Number(event.target.dataset.prepColumn), target = event.target.value;
      editDraft((draft) => { const column = draft.columns.find((item) => item.sourceIndex === index); column.target = target; column.enabled = target !== ""; });
    });
    el.SaveTemplateButton.addEventListener("click", () => {
      if (busy()) return;
      const record = selected();
      if (!draftOf(record)) return;
      const result = helper.createTemplate({ name: record.templateName, draft: draftOf(record) });
      if (!result.ok) { options.toast(messageOf(result.errors), true); return; }
      const next = templates.filter((template) => !(template.kind === result.template.kind && template.name === result.template.name));
      next.push(result.template);
      try {
        root.localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ schemaVersion: TEMPLATE_SCHEMA, items: next }));
        templates = next;
        options.toast("매핑을 저장했습니다. 다음 파일부터 같은 양식을 사용할 수 있습니다.");
      } catch (_) { options.toast("매핑을 저장하지 못했습니다. 이전 설정과 현재 작업은 유지됩니다.", true); }
    });
    el.ApplyButton.addEventListener("click", async () => {
      if (busy()) return;
      const record = selected();
      if (!draftOf(record)) return;
      applying = true; render();
      try {
        const parsed = mappedParse(record, draftOf(record));
        options.validate(record.kind, parsed);
        Object.defineProperty(parsed, "preparationRecord", { value: record, configurable: true, enumerable: false });
        const candidates = new Map([[record.kind, parsed]]);
        await options.applyCandidates(candidates, { preferredKind: record.kind });
        markApplied(candidates);
        options.toast("자료를 반영했습니다.");
      } catch (error) { record.error = error.message; record.status = "review"; options.toast(`${error.message} · 기존 작업은 유지됩니다.`, true); }
      finally { applying = false; options.onSettled?.(); render(); }
    });
    el.PreviewTabs?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-preview]");
      if (button) options.preview(button.dataset.preview);
    });
    render();
    return { parse, read, retainCandidate, refresh: render, markApplied, markFailed, isBusy: () => applying, rememberParsed(parsed) { if (parsed?.preparationRecord) remember(parsed.preparationRecord); },
      clear() { records.length = 0; selectedId = ""; render(); } };
  }
  root.OrderOpsExcelPreparationUI = Object.freeze({ mount });
})(typeof globalThis !== "undefined" ? globalThis : window);
