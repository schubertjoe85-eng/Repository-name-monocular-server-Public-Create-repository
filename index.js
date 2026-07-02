<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monocular</title>
</head>
<body style="margin:0;background:#050505;color:white;font-family:-apple-system,Arial;text-align:center;padding:30px;">
  <img src="/assets/logo.png" style="width:90px;height:90px;border-radius:18px;margin-bottom:6px;">
  <h1 style="font-size:32px;letter-spacing:2px;margin:10px 0 4px;">MONOCULAR</h1>
  <p style="color:#aaa;font-size:14px;margin-bottom:30px;">Rational Architectural Visualisation</p>

  <div style="max-width:540px;margin:0 auto;">
    <div id="mainApp">

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <span id="emailDisplay" style="color:#666;font-size:12px;"></span>
        <span id="creditsDisplay" style="color:#aaa;font-weight:900;font-size:13px;letter-spacing:1px;"></span>
      </div>

      <div id="emailCapture" style="display:none;margin-bottom:18px;padding:18px;background:#111;border-radius:18px;border:1px solid #2a2a2a;">
        <p style="color:#fff;font-weight:900;font-size:13px;letter-spacing:1px;margin-top:0;">SAVE YOUR RENDER + GET MORE</p>
        <p style="color:#aaa;font-size:13px;margin-bottom:14px;">Enter your email to download this render and buy more credits.</p>
        <input id="emailInput" type="email" placeholder="you@example.com" style="width:100%;padding:14px;border-radius:14px;border:1px solid #333;background:#050505;color:white;font-size:15px;box-sizing:border-box;margin-bottom:12px;">
        <button onclick="setEmail()" style="width:100%;padding:14px;border-radius:14px;border:0;background:#2E4D3A;color:white;font-size:14px;font-weight:900;letter-spacing:1px;">CONTINUE</button>
      </div>

      <div id="buyCredits" style="display:none;margin-bottom:18px;padding:18px;background:#111;border-radius:18px;border:1px solid #2a2a2a;">
        <p style="color:#fff;font-weight:900;font-size:13px;letter-spacing:1px;margin-top:0;">BUY RENDER CREDITS</p>
        <button onclick="buy(1)"  style="width:100%;margin-bottom:10px;padding:14px;border-radius:14px;border:0;background:#222;color:white;font-weight:900;letter-spacing:1px;font-size:13px;">1 RENDER — $2.00</button>
        <button onclick="buy(10)" style="width:100%;margin-bottom:10px;padding:14px;border-radius:14px;border:0;background:#222;color:white;font-weight:900;letter-spacing:1px;font-size:13px;">10 RENDERS — $12.00</button>
        <button onclick="buy(30)" style="width:100%;padding:14px;border-radius:14px;border:0;background:#2E4D3A;color:white;font-weight:900;letter-spacing:1px;font-size:13px;">30 RENDERS — $29.00</button>
      </div>

      <div style="display:flex;background:#111;border-radius:14px;padding:4px;margin-bottom:18px;border:1px solid #2a2a2a;">
        <button id="tabImageBtn" onclick="setTab('image')" style="flex:1;padding:10px;border-radius:10px;border:0;background:#2E4D3A;color:#fff;font-weight:900;letter-spacing:1px;font-size:12px;">IMAGE</button>
        <button id="tabVideoBtn" onclick="setTab('video')" style="flex:1;padding:10px;border-radius:10px;border:0;background:transparent;color:#888;font-weight:900;letter-spacing:1px;font-size:12px;">3D VIDEO</button>
      </div>

      <div style="background:#111;border:1px solid #2a2a2a;border-radius:24px;padding:18px;">

        <label for="file" id="uploadLabel" style="display:block;background:#222;padding:16px;border-radius:16px;font-weight:900;letter-spacing:1px;font-size:13px;margin-bottom:16px;cursor:pointer;">IMPORT IMAGE</label>
        <input id="file" type="file" accept="image/*" style="display:none;">
        <img id="preview" style="display:none;width:100%;max-height:360px;object-fit:cover;border-radius:18px;margin-bottom:16px;">

        <div id="extraImagesRow" style="display:none;flex-wrap:wrap;gap:8px;margin-bottom:16px;justify-content:flex-start;"></div>

        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <button id="modeRenderBtn"   onclick="setMode('render')"   style="flex:1;padding:10px;border-radius:10px;border:1px solid #333;background:#2E4D3A;color:#fff;font-weight:900;letter-spacing:1px;font-size:11px;">EXTERIOR</button>
          <button id="modeInteriorBtn" onclick="setMode('interior')" style="flex:1;padding:10px;border-radius:10px;border:1px solid #333;background:#1a1a1a;color:#888;font-weight:900;letter-spacing:1px;font-size:11px;">INTERIOR</button>
        </div>

        <textarea id="prompt" placeholder="Describe the render direction..." style="width:100%;min-height:110px;border-radius:16px;padding:14px;font-size:15px;box-sizing:border-box;background:#050505;color:white;border:1px solid #333;"></textarea>

        <div id="imageActions">
          <button onclick="renderImage()" style="width:100%;margin-top:16px;padding:16px;border-radius:16px;border:0;background:#2E4D3A;color:white;font-size:14px;font-weight:900;letter-spacing:1px;">RENDER</button>
        </div>

        <div id="videoActions" style="display:none;">
          <label for="extraFile" style="display:block;background:#222;padding:14px;border-radius:16px;font-weight:900;letter-spacing:1px;font-size:12px;margin-top:16px;cursor:pointer;">ADD ANGLE (UP TO 3)</label>
          <input id="extraFile" type="file" accept="image/*" style="display:none;">
          <button onclick="renderVideo()" style="width:100%;margin-top:16px;padding:16px;border-radius:16px;border:0;background:#2E4D3A;color:white;font-size:14px;font-weight:900;letter-spacing:1px;">GENERATE VIDEO</button>
        </div>

        <p id="msg" style="color:#ddd;margin-top:14px;min-height:20px;"></p>

        <img id="result" style="display:none;width:100%;border-radius:18px;margin-top:16px;">
        <a id="downloadLink" download="monocular-render.png" style="display:none;width:100%;margin-top:10px;padding:14px;border-radius:14px;background:#222;color:white;font-weight:900;letter-spacing:1px;font-size:13px;text-decoration:none;box-sizing:border-box;">DOWNLOAD IMAGE</a>

        <video id="resultVideo" controls style="display:none;width:100%;border-radius:18px;margin-top:16px;"></video>
      </div>
    </div>
  </div>

<script>
const API_URL = "https://monocular-server.onrender.com";
const PAYMENT_LINKS = {
  1:  "https://buy.stripe.com/8x2cN4bEkaGW0EEdaz43S01",
  10: "https://buy.stripe.com/7sYfZgcIo2aq9bab2r43S00",
  30: "https://buy.stripe.com/fZuaEW4bS8yO9ba6Mb43S02"
};

let imageBase64    = "";
let extraImages    = [];
let currentTab     = "image";
let currentMode    = "render";
let userEmail      = localStorage.getItem("monocular_email") || "";
let freeRenderUsed = localStorage.getItem("monocular_free_used") === "true";
let lastResultDataUrl = null;
let videoPollInterval = null;

window.addEventListener("load", function () {
  const params    = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");
  if (sessionId) {
    handleCheckoutSuccess(sessionId);
  } else {
    initApp();
  }
});

function initApp() {
  if (userEmail) {
    document.getElementById("emailDisplay").innerText = userEmail;
    refreshCredits();
  } else if (freeRenderUsed) {
    document.getElementById("creditsDisplay").innerText = "";
    document.getElementById("emailCapture").style.display = "block";
  } else {
    document.getElementById("creditsDisplay").innerText = "1 FREE RENDER";
  }
}

function setEmail() {
  const val = document.getElementById("emailInput").value.trim();
  if (!val || !val.includes("@")) { alert("Enter a valid email."); return; }
  userEmail = val;
  localStorage.setItem("monocular_email", userEmail);
  document.getElementById("emailDisplay").innerText = userEmail;
  document.getElementById("emailCapture").style.display = "none";
  if (lastResultDataUrl) showDownload(lastResultDataUrl);
  refreshCredits();
}

async function handleCheckoutSuccess(sessionId) {
  try {
    const r    = await fetch(API_URL + "/api/checkout-success", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const data = await r.json();
    if (data.ok && data.email) {
      userEmail = data.email;
      localStorage.setItem("monocular_email", userEmail);
      window.history.replaceState({}, document.title, window.location.pathname);
      document.getElementById("emailDisplay").innerText = userEmail;
      document.getElementById("emailCapture").style.display = "none";
      refreshCredits();
    }
  } catch (err) { console.error("Checkout verification failed", err); }
}

async function refreshCredits() {
  if (!userEmail) return;
  try {
    const r    = await fetch(API_URL + "/api/credits/" + encodeURIComponent(userEmail));
    const data = await r.json();
    const bal  = data.ok ? data.balance : 0;
    document.getElementById("creditsDisplay").innerText = bal + " CREDIT" + (bal === 1 ? "" : "S");
    document.getElementById("buyCredits").style.display = bal > 0 ? "none" : "block";
  } catch {
    document.getElementById("creditsDisplay").innerText = "—";
  }
}

async function checkAndUseCredit() {
  const r    = await fetch(API_URL + "/api/use-credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail })
  });
  const data = await r.json();
  if (data.ok) {
    const bal = data.balance;
    document.getElementById("creditsDisplay").innerText = bal + " CREDIT" + (bal === 1 ? "" : "S");
    document.getElementById("buyCredits").style.display = bal === 0 ? "block" : "none";
  }
  return data;
}

function buy(pack) {
  const link = PAYMENT_LINKS[pack];
  window.location.href = link
    + "?prefilled_email="     + encodeURIComponent(userEmail)
    + "&client_reference_id=" + encodeURIComponent(userEmail);
}

function setTab(tab) {
  currentTab = tab;
  document.getElementById("tabImageBtn").style.background  = tab === "image" ? "#2E4D3A" : "transparent";
  document.getElementById("tabImageBtn").style.color       = tab === "image" ? "#fff"    : "#888";
  document.getElementById("tabVideoBtn").style.background  = tab === "video" ? "#2E4D3A" : "transparent";
  document.getElementById("tabVideoBtn").style.color       = tab === "video" ? "#fff"    : "#888";
  document.getElementById("imageActions").style.display    = tab === "image" ? "block"   : "none";
  document.getElementById("videoActions").style.display    = tab === "video" ? "block"   : "none";
  document.getElementById("extraImagesRow").style.display  = (tab === "video" && extraImages.length) ? "flex" : "none";
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById("modeRenderBtn").style.background   = mode === "render"   ? "#2E4D3A" : "#1a1a1a";
  document.getElementById("modeRenderBtn").style.color        = mode === "render"   ? "#fff"    : "#888";
  document.getElementById("modeInteriorBtn").style.background = mode === "interior" ? "#2E4D3A" : "#1a1a1a";
  document.getElementById("modeInteriorBtn").style.color      = mode === "interior" ? "#fff"    : "#888";
}

function showDownload(dataUrl) {
  const link = document.getElementById("downloadLink");
  link.href  = dataUrl;
  link.style.display = "block";
}

document.getElementById("file").addEventListener("change", function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    const dataUrl = reader.result;
    imageBase64   = dataUrl.split(",")[1];
    const preview = document.getElementById("preview");
    preview.src           = dataUrl;
    preview.style.display = "block";
    document.getElementById("uploadLabel").innerText = "IMAGE LOADED — TAP TO CHANGE";
    document.getElementById("msg").innerText = "";
  };
  reader.readAsDataURL(file);
});

document.getElementById("extraFile").addEventListener("change", function (e) {
  const file = e.target.files[0];
  if (!file) return;
  if (extraImages.length >= 2) { document.getElementById("msg").innerText = "Up to 3 images total."; return; }
  const reader = new FileReader();
  reader.onload = function () {
    const dataUrl = reader.result;
    extraImages.push(dataUrl.split(",")[1]);
    const row   = document.getElementById("extraImagesRow");
    const thumb = document.createElement("img");
    thumb.src           = dataUrl;
    thumb.style.cssText = "width:64px;height:64px;border-radius:10px;object-fit:cover;";
    row.appendChild(thumb);
    row.style.display = "flex";
    document.getElementById("msg").innerText = "Added angle " + (extraImages.length + 1) + ".";
  };
  reader.readAsDataURL(file);
});

async function renderImage() {
  const prompt = document.getElementById("prompt").value.trim();
  const msg    = document.getElementById("msg");
  const result = document.getElementById("result");

  if (!imageBase64) { msg.innerText = "Upload an image first."; return; }

  if (freeRenderUsed && !userEmail) {
    document.getElementById("emailCapture").style.display = "block";
    msg.innerText = "Enter your email to continue.";
    return;
  }

  result.style.display = "none";
  document.getElementById("downloadLink").style.display = "none";
  document.getElementById("resultVideo").style.display  = "none";
  lastResultDataUrl = null;

  try {
    if (userEmail) {
      msg.innerText = "Checking credits...";
      const creditData = await checkAndUseCredit();
      if (!creditData.ok) {
        msg.innerText = creditData.error || "No credits remaining. Buy more below.";
        document.getElementById("buyCredits").style.display = "block";
        return;
      }
    }

    msg.innerText = "Rendering…";

    const r    = await fetch(API_URL + "/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, imageBase64, mode: currentMode })
    });
    const data = await r.json();

    if (data.ok && data.image) {
      result.src           = data.image;
      result.style.display = "block";
      lastResultDataUrl    = data.image;

      if (!freeRenderUsed && !userEmail) {
        freeRenderUsed = true;
        localStorage.setItem("monocular_free_used", "true");
        document.getElementById("creditsDisplay").innerText   = "";
        document.getElementById("emailCapture").style.display = "block";
        msg.innerText = "Render complete. Enter your email to download.";
      } else {
        msg.innerText = "Render complete.";
        showDownload(data.image);
      }
    } else {
      msg.innerText = data.error || "Render failed. Please try again.";
    }
  } catch (err) {
    console.error(err);
    msg.innerText = "Server connection failed.";
  }
}

async function renderVideo() {
  const prompt      = document.getElementById("prompt").value.trim();
  const msg         = document.getElementById("msg");
  const resultVideo = document.getElementById("resultVideo");

  if (!imageBase64) { msg.innerText = "Upload an image first."; return; }

  if (!userEmail) {
    document.getElementById("emailCapture").style.display = "block";
    msg.innerText = "Enter your email to generate video.";
    return;
  }

  resultVideo.style.display = "none";
  document.getElementById("result").style.display       = "none";
  document.getElementById("downloadLink").style.display = "none";

  try {
    msg.innerText = "Checking credits...";
    const creditData = await checkAndUseCredit();
    if (!creditData.ok) {
      msg.innerText = creditData.error || "No credits remaining. Buy more below.";
      return;
    }

    msg.innerText = "Submitting video job…";
    const images = [imageBase64, ...extraImages].filter(Boolean);

    const r    = await fetch(API_URL + "/api/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, imageBase64, images, mode: currentMode })
    });
    const data = await r.json();

    if (!data.ok || !data.video?.id) {
      msg.innerText = data.error || "Video request failed.";
      return;
    }
    pollVideo(data.video.id);
  } catch (err) {
    console.error(err);
    msg.innerText = "Server connection failed.";
  }
}

function pollVideo(videoId) {
  const msg = document.getElementById("msg");
  if (videoPollInterval) clearInterval(videoPollInterval);
  videoPollInterval = setInterval(async function () {
    try {
      const r    = await fetch(API_URL + "/api/video/" + videoId);
      const data = await r.json();
      if (!data.ok) {
        clearInterval(videoPollInterval);
        msg.innerText = data.error || "Video status check failed.";
        return;
      }
      const status = data.video?.status;
      msg.innerText = "Status: " + (status || "processing") + "…";
      if (status === "completed" || status === "succeeded") {
        clearInterval(videoPollInterval);
        msg.innerText = "Finalising video…";
        setTimeout(async function () {
          try {
            const ur  = await fetch(API_URL + "/api/video/" + videoId + "/url");
            const ud  = await ur.json();
            const vid = document.getElementById("resultVideo");
            vid.src           = (ud.ok && ud.url) ? ud.url : API_URL + "/api/video/" + videoId + "/content";
            vid.style.display = "block";
            msg.innerText = "Video complete.";
          } catch {
            const vid = document.getElementById("resultVideo");
            vid.src           = API_URL + "/api/video/" + videoId + "/content";
            vid.style.display = "block";
            msg.innerText = "Video complete.";
          }
        }, 3000);
      } else if (status === "failed" || status === "error") {
        clearInterval(videoPollInterval);
        msg.innerText = "Video generation failed.";
      }
    } catch { /* keep polling */ }
  }, 4000);
}
</script>
</body>
</html>
