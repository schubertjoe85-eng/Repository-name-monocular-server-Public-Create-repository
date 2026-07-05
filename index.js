import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Free render tracking (server-side) ───────────────────────────────────────
// Keyed by identity: the email/user ID when supplied, otherwise the client IP.
// In-memory: resets on Render restart. Good enough as a soft guard;
// move to Supabase later if abuse becomes a problem.
const freeRenders = {};
const FREE_RENDER_LIMIT = 1;

function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// A stable identity for the free-render guard. iOS sends the RevenueCat app
// user ID in the email field; web sends a real email (or nothing for guests).
function getIdentity(req, email) {
  return email ? "id:" + email : "ip:" + getClientIp(req);
}

// Look up the credit balance for an email. Returns 0 on any failure.
async function getCreditBalance(email) {
  if (!email) return 0;
  try {
    const { data } = await supabase
      .from("credits")
      .select("balance")
      .eq("email", email)
      .maybeSingle();
    return data?.balance || 0;
  } catch (e) {
    return 0;
  }
}

// ── Prompt builder ───────────────────────────────────────────────────────────
// Engine: GPT-5.5 (the "director") orchestrating gpt-image-2 via the
// image_generation tool. The director rewrites our instructions into its own
// revised_prompt before the image model runs — and left unconstrained it
// rewrites them as a cinematic scene description (sunset, lakes, bushland).
// So this prompt constrains BOTH layers: what the final image must preserve,
// AND what the director is allowed to write in its tool call. The director's
// prompt must be a fidelity instruction, never a scene description.
function buildPrompt(userPrompt, mode) {
  if (mode === "interior") {
    return [
      "You are an architectural visualisation engine. Your job is to convert the attached",
      "interior image into a photograph of that EXACT room — as if the room has been built",
      "and professionally photographed. You are a camera, not a designer.",
      "This is an INTERIOR SPACE viewed from inside. Show no exterior, facade, or sky.",
      "",
      "STEP 1 — ANALYSE the attached image before generating. Establish precisely:",
      "1. ROOM TYPE: what kind of room this is (living room, bedroom, indoor pool hall, etc.)",
      "2. CAMERA: position, height, lens angle, tilt, and how much of the room is in frame",
      "3. CONTENTS: every window, door, and piece of furniture — count, position, scale",
      "4. MATERIALS: the visible floor, wall, and ceiling finishes",
      "",
      "STEP 2 — EDIT the attached image into a photorealistic photograph that preserves",
      "every fact from your analysis:",
      "- IDENTICAL camera position, angle, and framing — never reframe or pull back",
      "- Same room shape, wall positions, floor area, ceiling height and form",
      "- Every window and door: same count, same positions, same sizes",
      "- Furniture: same pieces, same positions, same scale — nothing added, nothing removed",
      "",
      "DIRECTOR RULES — how you must write your prompt for the image generation tool:",
      "- Your tool prompt is a FIDELITY INSTRUCTION, never a scene description.",
      "- It must restate as fixed facts: the room type, camera position/angle/framing,",
      "  and the contents inventory from your analysis.",
      "- It must instruct: photorealistic materials and lighting only; change nothing else.",
      "- It must NOT contain atmospheric or lifestyle language: no 'cozy', 'inviting',",
      "  'sun-drenched', 'designer', no described decor, styling, or mood not present",
      "  in the source or named in the user brief.",
      "- Default lighting: neutral daylight consistent with the source. Never invent",
      "  dramatic lighting.",
      "",
      "ONLY these may be improved:",
      "- Rendering quality of surfaces already present (the timber floor becomes convincing",
      "  timber; the plasterboard wall becomes convincing plasterboard — same material)",
      "- Lighting realism: natural light through the existing windows, existing light",
      "  fittings switched on, physically correct shadows",
      "- Photographic quality: sharp focus, honest exposure — at the SAME camera position",
      "",
      "STRICTLY FORBIDDEN unless visible in the source image or named in the user brief:",
      "- Changing the camera position, angle, lens, or framing",
      "- New furniture, rugs, artwork, mirrors, or plants",
      "- Pendant lights, chandeliers, LED strip lighting, downlight arrays",
      "- Fireplaces, ceiling features, exposed beams, skylights",
      "- Material changes (do not swap carpet for timber, paint for stone, etc.)",
      "- People, animals, text, labels, watermarks",
      "",
      "IF ANYTHING IS AMBIGUOUS in the source, choose the PLAIN, CONVENTIONAL reading —",
      "an ordinary Australian home interior. Never resolve ambiguity with a striking or",
      "designer feature.",
      "",
      "The user brief may only adjust atmosphere, time of day, and material finish quality.",
      "It never changes the room's geometry, contents, or the camera.",
      "User brief: " + (userPrompt || "Photorealistic interior photograph of this exact room."),
    ].join("\n");
  }

  // default: exterior render
  return [
    "You are an architectural visualisation engine. Your job is to convert the attached",
    "architectural image into a photograph of that EXACT building — as if it has been",
    "built and professionally photographed. You are a camera, not a designer.",
    "",
    "STEP 1 — ANALYSE the attached image before generating. Establish precisely:",
    "1. BUILDING TYPOLOGY: what type of building this is (high-rise residential tower,",
    "   detached house, pool house, office building, etc.). Be exact — a tower must",
    "   NEVER be rendered as a house, and a house must NEVER be rendered as a tower.",
    "2. STOREY COUNT: count the visible levels carefully — balcony levels, window rows.",
    "   The output must contain exactly this many storeys.",
    "3. CAMERA: position, height, lens angle, and tilt. If the source looks steeply",
    "   upward from street level, so does the output. Note the crop: if the building",
    "   fills the frame with the top or base cut off, the output is framed identically.",
    "4. MASSING: every cantilever, setback, twist, and offset in the stacking of",
    "   volumes, in vertical order.",
    "5. VISIBLE SURROUNDINGS AND SKY: only what the source actually shows. Note the",
    "   sky treatment (blank, white, sketchy wash, blue) and whether any ground,",
    "   street, or neighbouring building is visible.",
    "",
    "STEP 2 — EDIT the attached image into a photorealistic photograph that preserves",
    "every fact from your analysis:",
    "- IDENTICAL building typology and storey count",
    "- IDENTICAL camera position, angle, and framing — never reframe to a standard",
    "  eye-level shot, never zoom out to show more than the source shows",
    "- Same massing, footprint, roof form and pitch",
    "- Every window and door: same count, same positions, same sizes, same proportions",
    "- Every balcony, terrace, and planter: same count, same levels, same positions",
    "- Facade composition and material zones exactly where the source places them",
    "",
    "DIRECTOR RULES — how you must write your prompt for the image generation tool:",
    "- Your tool prompt is a FIDELITY INSTRUCTION, never a scene description.",
    "- It must restate as fixed facts: the typology, the exact storey count, the",
    "  camera angle and crop, and the massing from your analysis.",
    "- It must instruct: photorealistic materials, physically correct daylight,",
    "  same framing; change nothing else.",
    "- It must NOT contain scenic, atmospheric, or lifestyle language. Banned from",
    "  your tool prompt unless present in the source or named in the user brief:",
    "  'golden hour', 'sunset', 'sunrise', 'dusk', 'nestled', 'surrounded by',",
    "  'set in', 'overlooking', and ANY description of landscape, vegetation,",
    "  water, terrain, or setting.",
    "- LIGHTING DEFAULT: neutral clear daytime consistent with the source sky.",
    "  NEVER default to sunset or golden hour.",
    "- SKY AND BACKGROUND DEFAULT: match the source. If the source sky is blank,",
    "  white, or a loose wash, render a plain clear daytime sky and nothing else.",
    "",
    "ONLY these may be improved:",
    "- Rendering quality of materials already present (the brick becomes convincing brick;",
    "  the cladding becomes convincing cladding — same material, photographed better)",
    "- Lighting realism: neutral natural daylight, physically correct shadows",
    "- Photographic quality: sharp focus, high dynamic range — at the SAME camera angle",
    "",
    "SITE CONTEXT: Reproduce only the surroundings the source image actually shows,",
    "in the same positions. If the source shows little or no site, keep the surroundings",
    "minimal and neutral — plain ground plane or sky consistent with the source framing.",
    "Never invent a setting. If the user brief names a setting (e.g. inner-city, CBD,",
    "coastal), follow the brief; otherwise invent nothing.",
    "",
    "STRICTLY FORBIDDEN unless visible in the source image or named in the user brief:",
    "- Changing the building typology (tower to house, house to tower, etc.)",
    "- Reducing or increasing the number of storeys",
    "- Changing the camera position, angle, lens, or framing",
    "- Zooming out, recentring, or recomposing the shot",
    "- Sunset, sunrise, golden-hour, or dusk lighting",
    "- Lakes, rivers, ponds, billabongs, or any water body",
    "- Trees, bushland, gardens, or landscaping of any kind",
    "- Invented site context: driveways, fences, streetscapes, hills, or",
    "  neighbouring buildings not present in the source",
    "- Solar panels, green roofs, roof gardens, roof decks",
    "- LED strips, feature lighting, uplighting, illuminated signage",
    "- Louvres, screens, shutters, pergolas, awnings",
    "- Pools, water features, fire pits, sculptures, flagpoles",
    "- Extra windows, doors, skylights, dormers, chimneys, balconies, or storeys",
    "- Cars, people, animals, text, labels, watermarks",
    "",
    "IF ANYTHING IS AMBIGUOUS in the source, choose the PLAIN, CONVENTIONAL reading.",
    "Never resolve ambiguity with a striking or designer feature. A plain wall stays",
    "plain. An empty foreground stays empty. A blank sky stays a plain daytime sky.",
    "",
    "The user brief may adjust time of day, season, weather, and material finish",
    "quality, and may name a setting. It never changes the building's typology,",
    "geometry, storey count, or the camera.",
    "User brief: " + (userPrompt || "Photorealistic photograph of this exact building."),
  ].join("\n");
}

// ── Basic routes ─────────────────────────────────────────────────────────────
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

// ── Stripe / credits ─────────────────────────────────────────────────────────
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

// ── Render ───────────────────────────────────────────────────────────────────
// Engine: Responses API — GPT-5.5 orchestrating gpt-image-2 via the
// image_generation tool with action:"edit". The director's revised_prompt and
// the incoming user brief are both logged so drift can be traced to its
// source: frontend style strings vs director embellishment.
app.post("/render", async (req, res) => {
  req.setTimeout(180000);
  res.setTimeout(180000);
  try {
    const {
      prompt,
      imageBase64,
      mode = "render",
      email,
      subscriptionActive = false,
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Upload an image first." });
    }

    // Trace exactly what the frontend sends — if renders keep drifting to a
    // house style the app didn't ask for, this line reveals whether the app
    // is appending style presets to the brief.
    console.log("User brief received:", JSON.stringify(prompt), "mode:", mode);

    // ── Access check ─────────────────────────────────────────────────────────
    // 1. iOS subscribers (RevenueCat entitlement) render freely.
    // 2. Web users with a credit balance render freely here — the web
    //    frontend deducts via /api/use-credit as before.
    // 3. Everyone else gets FREE_RENDER_LIMIT free renders, tracked by
    //    email/user ID when supplied, otherwise by IP.
    if (!subscriptionActive) {
      const balance = await getCreditBalance(email);
      if (balance <= 0) {
        const identity = getIdentity(req, email);
        const used = freeRenders[identity] || 0;
        if (used >= FREE_RENDER_LIMIT) {
          return res.status(402).json({
            ok: false,
            error: "Free render used. Subscribe or buy credits to continue.",
          });
        }
        freeRenders[identity] = used + 1;
      }
    }

    const finalPrompt = buildPrompt(prompt, mode);
    const base64Data = imageBase64.startsWith("data:")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const response = await openai.responses.create({
      model: "gpt-5.5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: finalPrompt },
            {
              type: "input_image",
              image_url: "data:image/png;base64," + base64Data,
            },
          ],
        },
      ],
      tools: [
        {
          type: "image_generation",
          action: "edit",
          quality: "high",
          size: "auto",
        },
      ],
    });

    const imageCall = (response.output || []).find(
      (o) => o.type === "image_generation_call"
    );

    if (imageCall?.revised_prompt) {
      console.log("Revised prompt:", imageCall.revised_prompt);
    }

    const imageBase64Out = imageCall?.result;
    if (!imageBase64Out) {
      // Surface the model's text response (moderation reason, refusal, etc.)
      // instead of a generic failure so the client can show something useful.
      const detail = response.output_text || "No image returned.";
      console.error("Render produced no image:", detail);
      return res.status(500).json({ ok: false, error: detail });
    }

    return res.json({ ok: true, image: "data:image/png;base64," + imageBase64Out });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

// ── Video (Runway) ───────────────────────────────────────────────────────────
app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images, mode = "render", email, subscriptionActive = false } = req.body;
    const imageList = Array.isArray(images) && images.length ? images : imageBase64 ? [imageBase64] : [];
    if (!prompt) return res.status(400).json({ ok: false, error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ ok: false, error: "Please upload an image." });

    // ── Access check ─────────────────────────────────────────────────────────
    // Video is never free: iOS subscribers or web users with credits only.
    if (!subscriptionActive) {
      const balance = await getCreditBalance(email);
      if (balance <= 0) {
        return res.status(402).json({
          ok: false,
          error: "Video generation requires a subscription or credits.",
        });
      }
    }

    const src = imageList[0];
    const base64Data = src.startsWith("data:") ? src.split(",")[1] : src;
    const imageBuffer = Buffer.from(base64Data, "base64");

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

// ── Keep-alive ping (Render free tier) ───────────────────────────────────────
const SELF_URL = "https://monocular-server.onrender.com/health";
setInterval(function () {
  fetch(SELF_URL).then(function () {}).catch(function () {});
}, 600000);

app.listen(PORT, () => {
  console.log("Monocular server running on port " + PORT);
});
