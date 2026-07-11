import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import crypto from "crypto";

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

// ── Render job store (async job pattern) ─────────────────────────────────────
// Render's proxy kills HTTP requests at ~100 seconds, and high-fidelity
// renders regularly exceed that — the app sees "connection failed" while the
// server-side render is still running. The fix: POST /render/start returns a
// jobId immediately and runs the OpenAI call in the background; the app polls
// GET /render/status/:jobId until the image is ready. No single request ever
// runs long enough to hit the proxy timeout.
//
// In-memory: jobs are lost on Render restart. The client treats a missing
// jobId as a failed render and lets the user retry — same recovery story as
// the free-render map above.
const renderJobs = {};
const JOB_TTL_MS = 30 * 60 * 1000; // purge finished/stale jobs after 30 min

setInterval(function () {
  const now = Date.now();
  for (const id of Object.keys(renderJobs)) {
    if (now - renderJobs[id].createdAt > JOB_TTL_MS) {
      delete renderJobs[id];
    }
  }
}, 5 * 60 * 1000);

// The actual OpenAI render call, shared by the legacy synchronous endpoint
// and the background job runner.
async function runRender(finalPrompt, base64Data) {
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
    throw new Error(detail);
  }

  return "data:image/png;base64," + imageBase64Out;
}

// ── Prompt builder ───────────────────────────────────────────────────────────
// Engine: GPT-5.5 (the "director") orchestrating gpt-image-2 via the
// image_generation tool. The director rewrites our instructions into its own
// revised_prompt before the image model runs — and left unconstrained it
// rewrites them as a cinematic scene description (sunset, lakes, bushland).
// So this prompt constrains BOTH layers: what the final image must preserve,
// AND what the director is allowed to write in its tool call. The director's
// prompt must be a fidelity instruction, never a scene description.
//
// Modes:
//   "interior"      — interior photo/sketch input
//   "model_capture" — screenshot of the user's own 3D model from the in-app
//                     viewer (CAPTURE VIEW). Geometry is authoritative and
//                     exact; the clay surface carries no material meaning.
//   default         — exterior photo/sketch/CAD elevation input
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

  if (mode === "model_capture") {
    return [
      "You are an architectural visualisation engine. The attached image is a screenshot",
      "of the client's OWN 3D MODEL, captured from a model viewer. It is not a sketch,",
      "not a concept, and not a reference: it is dimensionally exact, authoritative",
      "geometry. Your job is to convert it into a photograph of that EXACT building as",
      "if it has been built and professionally photographed from this EXACT viewpoint.",
      "You are a camera, not a designer. Zero tolerance for geometric deviation.",
      "",
      "STEP 1 — ANALYSE the attached model capture before generating. Establish precisely:",
      "1. BUILDING TYPOLOGY: what type of building this model shows (detached house,",
      "   pool house, tower, etc.). Never change it.",
      "2. STOREY COUNT: count the levels in the model. The output contains exactly this many.",
      "3. CAMERA: the viewer's camera position, height, angle, tilt, and crop. The output",
      "   is framed identically — never reframe, recentre, zoom, or pull back.",
      "4. GEOMETRY INVENTORY: every wall plane, roof plane and pitch, edge, cantilever,",
      "   setback, opening (window/door), and their exact positions, sizes, and proportions.",
      "5. SURFACE STATE: whether the model is untextured clay (uniform grey/white) or",
      "   carries textures.",
      "",
      "STEP 2 — EDIT the attached capture into a photorealistic photograph that preserves",
      "every fact from your analysis:",
      "- IDENTICAL typology, storey count, massing, footprint, roof form and pitch",
      "- IDENTICAL camera position, angle, lens, and framing",
      "- Every edge and plane exactly where the model places it — the silhouette of the",
      "  output must overlay the silhouette of the input exactly",
      "- Every window and door: same count, same positions, same sizes, same proportions.",
      "  Do not add, remove, resize, merge, or reposition a single opening.",
      "",
      "MATERIALS — the model surface carries NO material meaning:",
      "- If the model is untextured clay, the grey/white surface is a placeholder, not a",
      "  finish. Do NOT render a grey concrete or white rendered building by default.",
      "- Materials come from the user brief ONLY. If the brief names materials, apply",
      "  them to the exact geometry shown.",
      "- If the brief names no materials, use plain, conventional Australian residential",
      "  materials (e.g. brick or standard cladding walls, Colorbond-style metal or tiled",
      "  roof) applied without changing any geometry.",
      "- If the model carries textures, treat them as the specified materials and render",
      "  them convincingly.",
      "",
      "DIRECTOR RULES — how you must write your prompt for the image generation tool:",
      "- Your tool prompt is a FIDELITY INSTRUCTION, never a scene description.",
      "- It must state that the source is the client's exact 3D model and that geometry",
      "  is fixed and non-negotiable.",
      "- It must restate as fixed facts: typology, exact storey count, camera angle and",
      "  crop, the massing, and the opening inventory from your analysis.",
      "- It must instruct: apply the brief's materials, physically correct neutral",
      "  daylight, same framing; change nothing else.",
      "- It must NOT contain scenic, atmospheric, or lifestyle language. Banned from",
      "  your tool prompt unless named in the user brief: 'golden hour', 'sunset',",
      "  'sunrise', 'dusk', 'nestled', 'surrounded by', 'set in', 'overlooking', and",
      "  ANY description of landscape, vegetation, water, terrain, or setting.",
      "- LIGHTING DEFAULT: neutral clear daytime. NEVER sunset or golden hour.",
      "- BACKGROUND DEFAULT: the viewer background is a blank studio backdrop, not a",
      "  site. Render a plain clear daytime sky and a minimal neutral ground plane",
      "  consistent with the model's base. Nothing else, unless the brief names a setting.",
      "",
      "ONLY these may be added or improved:",
      "- Photorealistic materials per the rules above, on the exact geometry shown",
      "- Lighting realism: neutral natural daylight, physically correct shadows",
      "- Photographic quality: sharp focus, high dynamic range — at the SAME camera angle",
      "",
      "STRICTLY FORBIDDEN unless named in the user brief:",
      "- Changing the building typology or storey count",
      "- Changing the camera position, angle, lens, or framing",
      "- Zooming out, recentring, or recomposing the shot",
      "- Any deviation from the model's edges, planes, proportions, or silhouette",
      "- 'Improving', 'refining', or 'correcting' the design in any way",
      "- Sunset, sunrise, golden-hour, or dusk lighting",
      "- Lakes, rivers, ponds, billabongs, or any water body",
      "- Trees, bushland, gardens, or landscaping of any kind",
      "- Invented site context: driveways, fences, streetscapes, hills, or",
      "  neighbouring buildings",
      "- Solar panels, green roofs, roof gardens, roof decks",
      "- LED strips, feature lighting, uplighting, illuminated signage",
      "- Louvres, screens, shutters, pergolas, awnings",
      "- Pools, water features, fire pits, sculptures, flagpoles",
      "- Extra windows, doors, skylights, dormers, chimneys, balconies, or storeys",
      "- Cars, people, animals, text, labels, watermarks",
      "",
      "IF ANYTHING IS AMBIGUOUS, choose the PLAIN, CONVENTIONAL reading. A plain wall",
      "stays plain. The blank backdrop stays a plain daytime sky. Never resolve",
      "ambiguity with a striking or designer feature.",
      "",
      "The user brief may specify materials, time of day, season, weather, and may name",
      "a setting. It never changes the building's typology, geometry, storey count, or",
      "the camera.",
      "User brief: " + (userPrompt || "Photorealistic photograph of this exact building."),
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

// ── Video prompt builder ─────────────────────────────────────────────────────
// Runway Gen-4.5 promptText is capped at 1000 characters and weights early
// tokens most heavily, so unlike the still-image prompt this must be short
// and lead with the fidelity constraints — the user brief goes LAST.
//
// The precision problem: the old inline motion strings ("orbit around the
// building, wide to close") actively invited Runway to invent the unseen
// sides of the building plus a whole site around it. This got dramatically
// worse with model captures, where the source is a single clay viewpoint on
// a blank backdrop — a full orbit forces pure hallucination.
//
// Fixes:
//   - model_capture: NO orbit. Slow push-in with slight parallax only, so the
//     camera never has to reveal geometry the capture doesn't show. Background
//     locked to plain sky / neutral ground; the standard no-invention list.
//   - default exterior: restrained arc that stays near the source viewpoint
//     instead of a wide-to-close orbit; same no-invention list.
//   - interior: unchanged walkthrough intent, but with explicit "room stays
//     unchanged" and no-addition constraints up front.
const RUNWAY_PROMPT_MAX = 1000;

function clampVideoPrompt(text) {
  return text.length > RUNWAY_PROMPT_MAX ? text.slice(0, RUNWAY_PROMPT_MAX) : text;
}

function buildVideoPrompt(userPrompt, mode) {
  const brief = String(userPrompt || "").trim();

  if (mode === "interior") {
    return clampVideoPrompt(
      [
        "Slow, smooth cinematic walkthrough of this exact room: gentle forward drift",
        "with a subtle pan. The room stays completely unchanged in every frame —",
        "same walls, windows, doors, furniture, and materials. Do not add furniture,",
        "decor, people, or new lighting effects. Keep the existing lighting.",
        "Photorealistic architectural interior footage.",
        brief,
      ].join(" ")
    );
  }

  if (mode === "model_capture") {
    return clampVideoPrompt(
      [
        "This is the client's exact building design. The geometry is final and stays",
        "identical in every frame: same silhouette, storey count, roof form, window",
        "positions, and materials. Camera: slow, steady push-in toward the building",
        "with slight parallax. Do not orbit, do not reveal sides of the building not",
        "visible in the source frame. The background stays exactly as shown — plain",
        "clear sky and neutral ground. Do not add trees, water, landscape, roads,",
        "fences, driveways, neighbouring buildings, cars, people, or any new objects.",
        "Neutral clear daylight, no sunset. Photorealistic architectural footage.",
        brief,
      ].join(" ")
    );
  }

  // default: exterior video
  return clampVideoPrompt(
    [
      "This exact building stays completely unchanged in every frame — same shape,",
      "storey count, roof, windows, and materials. Camera: slow, smooth arc with a",
      "gentle push-in, staying close to the original viewpoint. The surroundings",
      "stay exactly as shown in the source. Do not add trees, water, landscape,",
      "roads, neighbouring buildings, cars, people, or any new objects. Neutral",
      "clear daylight, no sunset. Photorealistic architectural footage.",
      brief,
    ].join(" ")
  );
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

// ── Render access check (shared) ─────────────────────────────────────────────
// 1. iOS subscribers (RevenueCat entitlement) render freely.
// 2. Web users with a credit balance render freely here — the web
//    frontend deducts via /api/use-credit as before.
// 3. Everyone else gets FREE_RENDER_LIMIT free renders, tracked by
//    email/user ID when supplied, otherwise by IP.
// Returns { allowed, usedFreeRender, identity } so the job runner can refund
// the free render if the render itself fails.
async function checkRenderAccess(req, email, subscriptionActive) {
  if (subscriptionActive) return { allowed: true, usedFreeRender: false, identity: null };

  const balance = await getCreditBalance(email);
  if (balance > 0) return { allowed: true, usedFreeRender: false, identity: null };

  const identity = getIdentity(req, email);
  const used = freeRenders[identity] || 0;
  if (used >= FREE_RENDER_LIMIT) {
    return { allowed: false, usedFreeRender: false, identity };
  }
  freeRenders[identity] = used + 1;
  return { allowed: true, usedFreeRender: true, identity };
}

// ── Render (async job pattern — use these endpoints) ─────────────────────────
// POST /render/start validates, checks access, kicks off the OpenAI call in
// the background, and returns a jobId within milliseconds. The client then
// polls GET /render/status/:jobId every few seconds. This avoids Render's
// ~100 second proxy timeout, which the legacy synchronous /render hits
// whenever a high-fidelity render runs long.
app.post("/render/start", async (req, res) => {
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

    console.log("User brief received:", JSON.stringify(prompt), "mode:", mode);

    const access = await checkRenderAccess(req, email, subscriptionActive);
    if (!access.allowed) {
      return res.status(402).json({
        ok: false,
        error: "Free render used. Subscribe or buy credits to continue.",
      });
    }

    const finalPrompt = buildPrompt(prompt, mode);
    const base64Data = imageBase64.startsWith("data:")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const jobId = crypto.randomUUID();
    renderJobs[jobId] = { status: "pending", createdAt: Date.now() };

    // Fire and forget — the job runs after this response is sent.
    runRender(finalPrompt, base64Data)
      .then((image) => {
        renderJobs[jobId] = { status: "done", image, createdAt: Date.now() };
      })
      .catch((error) => {
        console.error("Render job " + jobId + " failed:", error);
        // Refund the free render so a failed render doesn't burn the
        // user's only free attempt.
        if (access.usedFreeRender && access.identity) {
          freeRenders[access.identity] = Math.max(
            0,
            (freeRenders[access.identity] || 1) - 1
          );
        }
        renderJobs[jobId] = {
          status: "failed",
          error: error.message || "Render failed.",
          createdAt: Date.now(),
        };
      });

    return res.json({ ok: true, jobId });
  } catch (error) {
    console.error("Render start error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

app.get("/render/status/:jobId", (req, res) => {
  const job = renderJobs[req.params.jobId];
  if (!job) {
    // Unknown or expired job (server may have restarted mid-render).
    return res.status(404).json({
      ok: false,
      status: "not_found",
      error: "Render job not found. Please try again.",
    });
  }
  if (job.status === "pending") {
    return res.json({ ok: true, status: "pending" });
  }
  if (job.status === "failed") {
    return res.json({ ok: false, status: "failed", error: job.error });
  }
  // done — return the image and free the memory immediately rather than
  // waiting for the TTL sweep (images are multi-megabyte strings).
  const image = job.image;
  delete renderJobs[req.params.jobId];
  return res.json({ ok: true, status: "done", image });
});

// ── Render (legacy synchronous endpoint) ─────────────────────────────────────
// Kept for the shipped App Store build (1.0.x), which calls POST /render and
// waits for the image in one request. Subject to Render's ~100s proxy
// timeout on long renders — do not use in new client code. Retire once the
// job-pattern app build is fully adopted.
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

    console.log("User brief received:", JSON.stringify(prompt), "mode:", mode);

    const access = await checkRenderAccess(req, email, subscriptionActive);
    if (!access.allowed) {
      return res.status(402).json({
        ok: false,
        error: "Free render used. Subscribe or buy credits to continue.",
      });
    }

    const finalPrompt = buildPrompt(prompt, mode);
    const base64Data = imageBase64.startsWith("data:")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const image = await runRender(finalPrompt, base64Data);
    return res.json({ ok: true, image });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

// ── Video (Runway) ───────────────────────────────────────────────────────────
// Modes mirror the still-image pipeline:
//   "interior"      — walkthrough motion, room locked
//   "model_capture" — push-in only (no orbit), background locked to plain
//                     sky/ground, full no-invention list
//   default         — restrained arc near the source viewpoint, surroundings
//                     locked to the source
// The client must pass the SAME mode it used for the still render so the
// video prompt matches the source (especially model captures).
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

    const motion = buildVideoPrompt(prompt, mode);
    console.log("Video prompt (" + motion.length + " chars, mode: " + mode + "):", motion);

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
