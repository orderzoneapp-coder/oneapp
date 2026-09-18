const KAKAO_JAVASCRIPT_KEY = "31819c608fec2cefa895dc08095a991a";
const KAKAO_TEMPLATE_ID = 137289;
const IMAGE_URL =
  "https://oneapp.orderz.co.kr/jinju-share/share-card-800x600.png";
const OPEN_CHAT_URL = "https://open.kakao.com/o/g3qd97Ni";
const PAGE_URL = "https://oneapp.orderz.co.kr/jinju-share/";
const COPY_TEXT = [
  "진주중앙청과 전송판매",
  "",
  "닉네임은 중도매인번호로 부탁합니다.",
  "※ 확인되지 않는 이름은 추방될 수 있습니다.",
  "",
  `오픈채팅 입장: ${OPEN_CHAT_URL}`,
  `공유 페이지: ${PAGE_URL}`,
].join("\n");

const shareButton = document.querySelector("#kakao-share");
const copyButton = document.querySelector("#copy-card");
const status = document.querySelector("#status");

function setStatus(message, tone = "error") {
  status.textContent = message;
  status.dataset.tone = tone;
}

async function copyText() {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(COPY_TEXT);
    return;
  }

  const field = document.createElement("textarea");
  field.value = COPY_TEXT;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();

  if (!copied) throw new Error("clipboard unavailable");
}

async function copyCard() {
  setStatus("");

  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      const response = await fetch(IMAGE_URL);
      if (!response.ok) throw new Error("image unavailable");

      const image = await response.blob();
      const html = [
        `<p><strong>진주중앙청과 전송판매</strong></p>`,
        `<img src="${IMAGE_URL}" alt="진주중앙청과 전송판매" width="800" height="600">`,
        `<p>닉네임은 중도매인번호로 부탁합니다.<br>`,
        `※ 확인되지 않는 이름은 추방될 수 있습니다.</p>`,
        `<p><a href="${OPEN_CHAT_URL}">오픈채팅 입장</a></p>`,
      ].join("");

      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": image,
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([COPY_TEXT], { type: "text/plain" }),
        }),
      ]);
      setStatus(
        "카드 이미지와 전달 문구를 복사했습니다. 채팅방에 붙여넣어 주세요.",
        "success",
      );
      return;
    }

    await copyText();
    setStatus("카드 전달 문구와 링크를 복사했습니다.", "success");
  } catch {
    try {
      await copyText();
      setStatus("카드 전달 문구와 링크를 복사했습니다.", "success");
    } catch {
      setStatus("복사할 수 없습니다. 브라우저의 클립보드 권한을 확인해 주세요.");
    }
  }
}

function initializeKakao() {
  if (!window.Kakao) {
    setStatus("카카오 SDK를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return false;
  }

  if (!window.Kakao.isInitialized()) {
    window.Kakao.init(KAKAO_JAVASCRIPT_KEY);
  }

  return true;
}

shareButton.addEventListener("click", () => {
  if (!initializeKakao()) return;

  setStatus("");
  try {
    window.Kakao.Share.sendCustom({
      templateId: KAKAO_TEMPLATE_ID,
      templateArgs: {
        IMAGE_URL,
      },
    });
    setStatus("공유할 대상을 선택해 주세요.", "success");
  } catch {
    setStatus("카카오톡 공유창을 열지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
});

copyButton.addEventListener("click", copyCard);

window.addEventListener("load", initializeKakao);
