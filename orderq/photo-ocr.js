const photoFiles = [];

function fileInput() { return document.querySelector('#photoInput'); }
function candidates() { return document.querySelector('#photoCandidates'); }
function photoPanelVisible() {
  const panel = document.querySelector('#photoCollector');
  return Boolean(panel && !panel.classList.contains('hidden'));
}
function addFiles(files) {
  const images = [...files].filter(file => String(file.type || '').startsWith('image/'));
  const startIndex = photoFiles.length;
  for (const file of images) photoFiles.push(file);
  return { images, startIndex };
}
function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function recognizePhoto(index) {
  const list = candidates();
  const file = photoFiles[index];
  if (!list || !file) return;
  await nextFrame();
  const textarea = list.querySelector(`[data-photo-text="${index}"]`);
  const button = list.querySelector(`[data-photo-analyze="${index}"]`);
  if (!textarea || !button || textarea.value.trim()) return;

  const original = button.textContent;
  button.disabled = true;
  button.textContent = '사진 문자 자동 추출 중…';
  textarea.placeholder = '사진에서 주문 문자를 자동 추출하고 있습니다…';
  try {
    if (!window.Tesseract?.recognize) throw new Error('OCR 엔진을 불러오지 못했습니다.');
    const result = await window.Tesseract.recognize(file, 'kor+eng');
    const text = String(result?.data?.text || '').replace(/\r/g, '').trim();
    if (!text) throw new Error('사진에서 주문 문자를 찾지 못했습니다.');
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.disabled = false;
    button.textContent = '추출 완료 · 주문 후보 만들기';
    textarea.placeholder = '자동 추출된 주문내용을 확인·수정한 뒤 주문 후보를 만드세요.';
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    textarea.placeholder = `${error.message || error} 직접 확인한 주문 내용을 입력해 주세요.`;
  }
}
async function recognizeAdded(startIndex, count) {
  for (let offset = 0; offset < count; offset += 1) {
    await recognizePhoto(startIndex + offset);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const input = fileInput();
  const list = candidates();
  if (!input || !list) return;

  // collector-ui의 change 핸들러는 렌더링 후 input.value를 비운다.
  // 캡처 단계에서 먼저 FileList를 확보해야 OCR 쪽에서 실제 이미지가 사라지지 않는다.
  input.addEventListener('change', event => {
    const { images, startIndex } = addFiles(event.target.files || []);
    if (images.length) recognizeAdded(startIndex, images.length);
  }, true);

  document.addEventListener('paste', event => {
    if (!photoPanelVisible()) return;
    const files = [...(event.clipboardData?.items || [])]
      .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-photo-analyze]');
    if (!button) return;
    const index = Number(button.dataset.photoAnalyze);
    const textarea = list.querySelector(`[data-photo-text="${index}"]`);
    if (!textarea) return;
    if (textarea.value.trim()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    await recognizePhoto(index);
  }, true);
});
