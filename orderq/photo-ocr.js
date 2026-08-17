const photoFiles = [];

function fileInput() { return document.querySelector('#photoInput'); }
function candidates() { return document.querySelector('#photoCandidates'); }

window.addEventListener('DOMContentLoaded', () => {
  const input = fileInput();
  const list = candidates();
  if (!input || !list) return;

  input.addEventListener('change', event => {
    for (const file of event.target.files || []) photoFiles.push(file);
  });

  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-photo-analyze]');
    if (!button) return;
    if (button.dataset.ocrReady === '1') {
      delete button.dataset.ocrReady;
      return;
    }
    const index = Number(button.dataset.photoAnalyze);
    const textarea = list.querySelector(`[data-photo-text="${index}"]`);
    if (!textarea || textarea.value.trim()) return;
    const file = photoFiles[index];
    if (!file) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '사진 문자 추출 중…';
    try {
      if (!window.Tesseract?.recognize) throw new Error('OCR 엔진을 불러오지 못했습니다.');
      const result = await window.Tesseract.recognize(file, 'kor+eng');
      const text = String(result?.data?.text || '').trim();
      if (!text) throw new Error('사진에서 주문 문자를 찾지 못했습니다.');
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      button.dataset.ocrReady = '1';
      button.disabled = false;
      button.textContent = '추출 완료 · 주문 후보 만들기';
      button.click();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      textarea.placeholder = `${error.message || error} 직접 확인한 주문 내용을 입력해 주세요.`;
      textarea.focus();
    }
  }, true);
});
