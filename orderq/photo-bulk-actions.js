const excludedPhotoIndexes = new Set();

function photoList() { return document.querySelector('#photoCandidates'); }
function bulkCreateButton() { return document.querySelector('#photoBulkCreateBtn'); }
function clearAllButton() { return document.querySelector('#photoClearAllBtn'); }
function bulkStatus() { return document.querySelector('#photoBulkStatus'); }

function photoIndex(card) {
  const textarea = card?.querySelector('[data-photo-text]');
  return textarea ? Number(textarea.dataset.photoText) : -1;
}

function activePhotoCards() {
  return [...(photoList()?.querySelectorAll('.photo-draft') || [])]
    .filter(card => !excludedPhotoIndexes.has(photoIndex(card)) && !card.dataset.bulkSubmitted);
}

function ensureEmptyState() {
  const list = photoList();
  if (!list || activePhotoCards().length) return;
  if (!list.querySelector('.empty-card')) {
    list.innerHTML = '<div class="empty-card">사진을 선택하거나 복사한 이미지를 Ctrl+V로 붙여넣으세요.</div>';
  }
}

function updateBulkState() {
  const cards = activePhotoCards();
  const clearAll = clearAllButton();
  const create = bulkCreateButton();
  const status = bulkStatus();
  if (clearAll) clearAll.disabled = cards.length === 0;
  if (!create || !status) return;
  if (!cards.length) {
    create.disabled = true;
    status.textContent = '남아 있는 사진이 없습니다.';
    return;
  }
  const running = cards.some(card => card.querySelector('[data-photo-analyze]')?.disabled);
  const empty = cards.some(card => !card.querySelector('[data-photo-text]')?.value.trim());
  create.disabled = running || empty;
  if (running) status.textContent = `사진 ${cards.length}장 OCR 처리 중입니다.`;
  else if (empty) status.textContent = '내용이 비어 있는 사진은 직접 입력하거나 비워 주세요.';
  else status.textContent = `사진 ${cards.length}장의 내용을 한 번에 주문 후보로 만듭니다.`;
}

function clearPhotoCard(card) {
  const index = photoIndex(card);
  if (index >= 0) excludedPhotoIndexes.add(index);
  card.remove();
  ensureEmptyState();
  updateBulkState();
}

function decoratePhotoCards() {
  const list = photoList();
  if (!list) return;
  for (const card of [...list.querySelectorAll('.photo-draft')]) {
    const index = photoIndex(card);
    if (excludedPhotoIndexes.has(index)) {
      card.remove();
      continue;
    }
    const technicalButton = card.querySelector('[data-photo-analyze]');
    if (technicalButton) technicalButton.classList.add('photo-item-candidate-hidden');
    if (!card.querySelector('.photo-card-toolbar')) {
      const title = card.querySelector(':scope > strong');
      const toolbar = document.createElement('div');
      toolbar.className = 'photo-card-toolbar';
      if (title) {
        card.insertBefore(toolbar, title);
        toolbar.appendChild(title);
      } else {
        card.prepend(toolbar);
      }
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn danger photo-card-clear';
      clear.textContent = '이 사진 비우기';
      clear.addEventListener('click', () => clearPhotoCard(card));
      toolbar.appendChild(clear);
    }
  }
  ensureEmptyState();
  updateBulkState();
}

window.addEventListener('DOMContentLoaded', () => {
  const list = photoList();
  const input = document.querySelector('#photoInput');
  const clearAll = clearAllButton();
  const create = bulkCreateButton();
  if (!list || !input || !clearAll || !create) return;

  const observer = new MutationObserver(() => queueMicrotask(decoratePhotoCards));
  observer.observe(list, { childList: true, subtree: true });
  list.addEventListener('input', updateBulkState);
  input.addEventListener('change', () => setTimeout(decoratePhotoCards, 0));

  clearAll.addEventListener('click', () => {
    for (const card of activePhotoCards()) {
      const index = photoIndex(card);
      if (index >= 0) excludedPhotoIndexes.add(index);
    }
    list.innerHTML = '<div class="empty-card">사진을 선택하거나 복사한 이미지를 Ctrl+V로 붙여넣으세요.</div>';
    input.value = '';
    updateBulkState();
  });

  create.addEventListener('click', () => {
    const cards = activePhotoCards();
    if (!cards.length) return;
    if (cards.some(card => card.querySelector('[data-photo-analyze]')?.disabled)) return;
    if (cards.some(card => !card.querySelector('[data-photo-text]')?.value.trim())) return;

    create.disabled = true;
    if (bulkStatus()) bulkStatus().textContent = `사진 ${cards.length}장의 주문 후보를 만드는 중입니다.`;
    for (const card of cards) {
      const index = photoIndex(card);
      const button = card.querySelector('[data-photo-analyze]');
      if (!button) continue;
      card.dataset.bulkSubmitted = '1';
      button.click();
      if (index >= 0) excludedPhotoIndexes.add(index);
    }
    setTimeout(() => {
      cards.forEach(card => card.remove());
      ensureEmptyState();
      updateBulkState();
    }, 80);
  });

  decoratePhotoCards();
});
