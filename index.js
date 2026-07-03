import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import Jimp from "jimp";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Free render tracking (server-side, by IP).
// In-memory: resets on Render restart.
const freeRendersByIp = {};
const FREE_RENDER_LIMIT = 1;

function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// Free render guard, shared by /render and /render-nb.
// Skipped when the caller identifies as a web credits user (email)
// or an iOS subscriber (subscriptionActive === true from the app).
// Returns true if the request may proceed, false if it was blocked.
function passesFreeRenderGuard(req, res, email, subscriptionActive) {
  if (email || subscriptionActive === true) return true;
  const ip = getClientIp(req);
  const used = freeRendersByIp[ip] || 0;
  if (used >= FREE_RENDER_LIMIT) {
    res.status(402).json({
      ok: false,
      error: "Free render used. Enter your email and buy credits to continue.",
    });
    return false;
  }
  freeRendersByIp[ip] = used + 1;
  return true;
}

// Runway rejects images with width/height outside 0.5–2.0.
// Center-crop just enough to bring the image inside that range.
// Returns a PNG buffer, untouched if already valid.
async function clampAspectRatio(imageBuffer) {
  const img = await Jimp.read(imageBuffer);
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const ratio = w / h;

  if (ratio >= 0.5 && ratio <= 2.0) {
    return imageBuffer;
  }

  if (ratio < 0.5) {
    // Too tall — trim top and bottom.
    const newH = Math.floor(w / 0.5);
    const y = Math.floor((h - newH) / 2);
    img.crop(0, y, w, newH);
  } else {
    // Too wide — trim left and right.
    const newW = Math.floor(h * 2.0);
    const x = Math.floor((w - newW) / 2);
    img.crop(x, 0, newW, h);
  }

  console.log("Cropped image for Runway: " + w + "x" + h + " -> " + img.bitmap.width + "x" + img.bitmap.height);
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

// ── Render engines ──────────────────────────────────────────────────────────
// /render is a two-pass pipeline:
//   Pass 1 — gpt-image-1: faithful geometry render (the building).
//   Pass 2 — Nano Banana Pro: backdrop-only edit at 2K (sky, landscape, context).
//            Geometry is locked. If this pass fails, the Pass 1 render is used.
// /render-nb remains the pure single-pass Nano Banana route.

async function renderWithNanoBanana(finalPrompt, imageBase64) {
  const base64Data = imageBase64.startsWith("data:")
    ? imageBase64.split(",")[1]
    : imageBase64;

  const geminiRes = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: finalPrompt },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: base64Data,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            imageSize: "2K",
          },
        },
      }),
    }
  );

  const data = await geminiRes.json();

  if (!geminiRes.ok) {
    throw new Error(data?.error?.message || "Nano Banana render failed.");
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  const imgData = imagePart?.inlineData?.data || imagePart?.inline_data?.data;

  if (!imgData) {
    throw new Error("No image returned by Nano Banana.");
  }

  return "data:image/png;base64," + imgData;
}

async function renderWithOpenAI(finalPrompt, imageBase64) {
  const base64Data = imageBase64.startsWith("data:")
    ? imageBase64.split(",")[1]
    : imageBase64;
  const imageBuffer = Buffer.from(base64Data, "base64");
  const imageFile = await OpenAI.toFile(imageBuffer, "source.png", { type: "image/png" });

  const response = await openai.images.edit({
    model: "gpt-image-1",
    image: imageFile,
    prompt: finalPrompt,
    size: "1024x1024",
  });

  const imageBase64Out = response?.data?.[0]?.b64_json;
  if (!imageBase64Out) {
    throw new Error("No image returned by OpenAI.");
  }

  return "data:image/png;base64," + imageBase64Out;
}

// Pass 2 — Nano Banana backdrop-only edit.
// Takes the finished gpt-image-1 render and replaces ONLY the backdrop.
// The building is locked. Also upscales the result to 2K.
function buildBackdropPrompt(userPrompt) {
  return [
    "You are editing an EXISTING architectural render. This is an EDIT, not a new image.",
    "",
    "Replace ONLY the sky, landscaping, ground plane and surrounding context.",
    "Make the backdrop photorealistic: real-estate photography quality, natural",
    "Australian light, native planting at correct scale, believable suburban or",
    "rural Australian setting as appropriate to the building.",
    "",
    "THE BUILDING IS LOCKED. Preserve it pixel-faithfully:",
    "- Exact geometry, massing, roofline and floor count",
    "- Exact window and door positions, sizes and proportions",
    "- Exact materials, colours and detailing",
    "- Exact footprint and camera perspective",
    "",
    "Do NOT redesign, restyle, extend or decorate the building.",
    "Do NOT add structures, objects or vegetation attached to or in front of the building.",
    "Do NOT add text, labels, people, vehicles or fantasy elements.",
    "No stylised, painterly or inventive treatment — faithful photorealism only.",
    "",
    "Backdrop direction from the user (apply to the setting ONLY, never the building): " +
      (userPrompt || "A natural, truthful setting appropriate to the design."),
  ].join("\n");
}

async function nanoBackdropPass(renderedImage, userPrompt) {
  const backdropPrompt = buildBackdropPrompt(userPrompt);
  return await renderWithNanoBanana(backdropPrompt, renderedImage);
}

function buildPrompt(userPrompt, mode) {
  if (mode === "interior") {
    return [
      "IMPORTANT: This is an INTERIOR SPACE. You are looking INSIDE a building.",
      "There is NO exterior view. Treat this as a high-end interior design photograph shot inside the room.",
      "",
      "Preserve EXACTLY: room shape, ceiling height and form, floor area, wall positions,",
      "window and door positions as seen from inside, furniture layout and scale.",
      "",
      "Enhance with restraint: interior lighting quality (pendant lights, recessed lighting,",
      "natural light through windows casting correct shadows), material finishes on floors,",
      "walls and ceiling (named and honest — polished concrete, oiled timber, honed stone),",
      "furniture quality and soft furnishings, plants and curated accessories.",
      "",
      "Lighting: warm, layered interior light. Correct shadows from each light source.",
      "Natural light from windows should feel directional and physically correct.",
      "",
      "Quality standard: ultra photorealistic, Houses magazine interior photography.",
      "Physically accurate reflections on floors. Correct perspective — no fisheye.",
      "Sharp focus on the space. No blown highlights. Rich shadow detail.",
      "",
      "Do NOT show any building exterior, facade, landscape or sky.",
      "Do NOT redesign the room, add walls, change the ceiling, or move the windows.",
      "Do NOT add furniture not present in the source image.",
      "",
      "User brief: " + (userPrompt || "Create a photorealistic interior architectural render."),
    ].join("\n");
  }

  return [
    "Ultra photorealistic architectural visualisation. Magazine quality. Houses magazine standard.",
    "",
    "Preserve the building design EXACTLY as supplied:",
    "- All massing, rooflines, and floor counts unchanged",
    "- All window and door positions, sizes, and proportions unchanged",
    "- All structural rhythm and material zones unchanged",
    "- Footprint and site relationship unchanged",
    "",
    "Enhance with restraint:",
    "- Realistic named materials (board-marked concrete, oiled timber, colorbond steel)",
    "- Warm Australian golden-hour lighting, physically accurate shadows",
    "- Native Australian planting at correct scale, never obscuring the building",
    "- Truthful site context — suburban or rural Australian setting as appropriate",
    "",
    "Quality: physically accurate shadows and ambient occlusion, correct perspective,",
    "high dynamic range (no blown sky, no crushed shadows), crisp material textures.",
    "",
    "Do NOT redesign, restyle, add windows, change the roofline, or invent elements.",
    "Do NOT add text, labels, extra storeys, fantasy forms, or random buildings.",
    "",
    "User brief: " + (userPrompt || "Create a realistic architectural render."),
  ].join("\n");
}

app.get("/", (req, res) => {
  res.json({ ok: true, name: "Monocular Server", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.get("/privacy.html", (req, res) => {
  res.redirect(301, "https://monocular-opal.vercel.app/privacy.html");
});

app.get("/terms.html", (req, res) => {
  res.redirect(301, "https://monocular-opal.vercel.app/terms.html");
});

app.post("/api/checkout-success", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId." });

    const { data: existing } = await supabase
      .from("stripe_sessions")
      .select("session_id")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (existing) return res.json({ ok: true, alreadyProcessed: true });

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });
    if (session.payment_status !== "paid") {
      return res.status(400).json({ ok: false, error: "Payment not completed." });
    }

    const email = session.customer_details?.email || session.customer_email;
    if (!email) return res.status(400).json({ ok: false, error: "No email on session." });

    const amountTotal = session.amount_total;
    let creditsToAdd = 0;
    if (amountTotal === 200) creditsToAdd = 1;
    else if (amountTotal === 1200) creditsToAdd = 10;
    else if (amountTotal === 2900) creditsToAdd = 30;

    if (creditsToAdd === 0) {
      return res.status(400).json({ ok: false, error: "Unrecognised purchase amount." });
    }

    const { data: existingCredits } = await supabase
      .from("credits")
      .select("balance")
      .eq("email", email)
      .maybeSingle();

    const newBalance = (existingCredits?.balance || 0) + creditsToAdd;

    await supabase.from("credits").upsert({
      email,
      balance: newBalance,
      updated_at: new Date().toISOString(),
    });

    await supabase.from("stripe_sessions").insert({
      session_id: sessionId,
      email,
      credits_added: creditsToAdd,
    });

    res.json({ ok: true, email, creditsAdded: creditsToAdd, balance: newBalance });
  } catch (error) {
    console.error("Checkout success error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/credits/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { data, error } = await supabase
      .from("credits")
      .select("balance")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    res.json({ ok: true, balance: data?.balance || 0 });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/use-credit", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: "Missing email." });

    const { data, error } = await supabase
      .from("credits")
      .select("balance")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;

    const balance = data?.balance || 0;
    if (balance <= 0) {
      return res.status(402).json({ ok: false, error: "No credits remaining." });
    }

    const newBalance = balance - 1;
    await supabase
      .from("credits")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("email", email);

    res.json({ ok: true, balance: newBalance });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ── Render v1 — two-pass pipeline ───────────────────────────────────────────
// Pass 1: gpt-image-1 (faithful geometry). Pass 2: Nano Banana backdrop @ 2K.
// Interior mode: single pass (gpt-image-1 only — no backdrop to replace).
// If the backdrop pass fails, the Pass 1 render is returned untouched.
app.post("/render", async (req, res) => {
  req.setTimeout(180000);
  res.setTimeout(180000);
  try {
    const { prompt, imageBase64, mode = "render", email, subscriptionActive } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Upload an image first." });
    }

    // Server-side free render guard.
    // Skipped for web credits users (email) and iOS subscribers (subscriptionActive).
    if (!passesFreeRenderGuard(req, res, email, subscriptionActive)) return;

    const finalPrompt = buildPrompt(prompt, mode);

    // Pass 1 — geometry render with gpt-image-1.
    const baseRender = await renderWithOpenAI(finalPrompt, imageBase64);

    // Interior renders have no backdrop — return the Pass 1 render.
    if (mode === "interior") {
      return res.json({ ok: true, image: baseRender });
    }

    // Pass 2 — Nano Banana backdrop-only edit at 2K.
    // Failsafe: any error here returns the Pass 1 render instead.
    let image = baseRender;
    try {
      image = await nanoBackdropPass(baseRender, prompt);
    } catch (backdropError) {
      console.error("Backdrop pass failed, returning base render:", backdropError.message);
    }

    return res.json({ ok: true, image });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

// ── Render v2 — pure Nano Banana Pro (single pass) ──────────────────────────
app.post("/render-nb", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  try {
    const { prompt, imageBase64, mode = "render", email, subscriptionActive } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Upload an image first." });
    }

    // Same free render guard as /render — shares the same IP counter.
    // Skipped for web credits users (email) and iOS subscribers (subscriptionActive).
    if (!passesFreeRenderGuard(req, res, email, subscriptionActive)) return;

    const finalPrompt = buildPrompt(prompt, mode);
    const image = await renderWithNanoBanana(finalPrompt, imageBase64);

    return res.json({ ok: true, image });
  } catch (error) {
    console.error("Nano Banana render error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images, mode = "render" } = req.body;
    const imageList = Array.isArray(images) && images.length ? images : imageBase64 ? [imageBase64] : [];
    if (!prompt) return res.status(400).json({ ok: false, error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ ok: false, error: "Please upload an image." });

    const src = imageList[0];
    const base64Data = src.startsWith("data:") ? src.split(",")[1] : src;
    let imageBuffer = Buffer.from(base64Data, "base64");

    // Runway requires width/height between 0.5 and 2.0 — crop if needed.
    try {
      imageBuffer = await clampAspectRatio(imageBuffer);
    } catch (cropError) {
      console.error("Aspect ratio clamp failed, using original image:", cropError.message);
    }

    const uploadInit = await fetch("https://api.dev.runwayml.com/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06",
      },
      body: JSON.stringify({
        type: "ephemeral",
        contentType: "image/png",
        contentLength: imageBuffer.length,
        filename: "source.png",
      }),
    });
    const uploadData = await uploadInit.json();

    if (!uploadInit.ok || !uploadData.runwayUri) {
      console.error("Runway upload init failed:", JSON.stringify(uploadData));
      return res.status(500).json({ ok: false, error: "Upload init failed." });
    }

    if (uploadData.fields) {
      const formData = new FormData();
      Object.entries(uploadData.fields).forEach(([key, value]) => {
        formData.append(key, value);
      });
      formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "source.png");
      await fetch(uploadData.uploadUrl, { method: "POST", body: formData });
    } else {
      await fetch(uploadData.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: imageBuffer,
      });
    }

    const runwayUri = uploadData.runwayUri;

    const isInterior = mode === "interior";
    const motion = isInterior
      ? String(prompt) + ". Smooth cinematic walkthrough panning across the room with a gentle forward drift. Keep the room unchanged. Realistic architectural interior walkthrough."
      : String(prompt) + ". Smooth cinematic orbit around the building, wide to close, gentle push in. Keep the building unchanged. Realistic architectural exterior walkthrough.";

    const r = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06",
      },
      body: JSON.stringify({
        model: "gen4.5",
        promptImage: runwayUri,
        promptText: motion,
        ratio: "960:960",
        duration: 10,
      }),
    });
    const data = await r.json();
    console.log("Runway video response:", JSON.stringify(data));

    if (!r.ok || !data.id) {
      console.error("Runway error:", JSON.stringify(data));
      return res.status(500).json({ ok: false, error: "Video failed." });
    }
    res.json({ ok: true, video: { id: data.id } });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ ok: false, error: error.message || "Video failed." });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const data = await r.json();
    const status =
      data.status === "SUCCEEDED" ? "completed" : data.status === "FAILED" ? "failed" : "in_progress";
    res.json({ ok: true, video: { status } });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Status failed." });
  }
});

app.get("/api/video/:id/url", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const data = await r.json();
    const url = data.output && data.output[0] ? data.output[0] : null;
    if (!url) return res.status(404).json({ ok: false, error: "No video URL yet." });
    res.json({ ok: true, url });
  } catch (error) {
    res.status(500).json({ ok: false, error: "URL fetch failed." });
  }
});

app.get("/api/video/:id/content", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const data = await r.json();
    const url = data.output && data.output[0] ? data.output[0] : null;
    if (!url) return res.status(404).json({ ok: false, error: "No video URL yet." });
    return res.redirect(302, url);
  } catch (error) {
    res.status(500).json({ ok: false, error: "Content failed." });
  }
});

const SELF_URL = "https://monocular-server.onrender.com/health";
setInterval(function () {
  fetch(SELF_URL).then(function () {}).catch(function () {});
}, 600000);

app.listen(PORT, () => {
  console.log("Monocular server running on port " + PORT);
});
