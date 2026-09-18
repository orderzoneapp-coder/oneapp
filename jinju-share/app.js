const KAKAO_JAVASCRIPT_KEY = "31819c608fec2cefa895dc08095a991a";
const KAKAO_TEMPLATE_ID = 137289;
const IMAGE_URL =
  "https://oneapp.orderz.co.kr/jinju-share/share-card-800x600.png";

const shareButton = document.querySelector("#kakao-share");
const status = document.querySelector("#status");

function setStatus(message) {
  status.textContent = message;
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
  window.Kakao.Share.sendCustom({
    templateId: KAKAO_TEMPLATE_ID,
    templateArgs: {
      IMAGE_URL,
    },
  });
});

window.addEventListener("load", initializeKakao);
