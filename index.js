import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Free render tracking (server-side) ───────────────────────────────────────
const freeRenders = {};
const FREE_RENDER_LIMIT = 1;

function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function getIdentity(req, email) {
  return email ? "id:" + email : "ip:" + getClientIp(req);
}

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
// Also holds multi-angle video jobs (job.videoBuffer instead of job.image /
// job.video) — see MULTI-ANGLE VIDEO section below.
const renderJobs = {};
const JOB_TTL_MS = 30 * 60 * 1000;

setInterval(function () {
  const now = Date.now();
  for (const id of Object.keys(renderJobs)) {
    if (now - renderJobs[id].createdAt > JOB_TTL_MS) {
      delete renderJobs[id];
    }
  }
}, 5 * 60 * 1000);

async function runRender(finalPrompt, base64Data) {
  const response = await openai.responses.create({
    model: "gpt-5.6-terra",
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
    const detail = response.output_text || "No image returned.";
    throw new Error(detail);
  }

  return "data:image/png;base64," + imageBase64Out;
}

// ── Prompt builder ───────────────────────────────────────────────────────────
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
      "You are an architectural visualisation engine performing an IMAGE EDIT, not",
      "creating a new picture. The attached image is a screenshot of the client's OWN",
      "3D MODEL, captured from a model viewer. It is not a sketch, not a concept, and",
      "not a reference: it is dimensionally exact, authoritative geometry. Your only",
      "job is to change the SURFACE APPEARANCE from viewer clay to photorealistic",
      "materials. The composition, camera, silhouette, every edge, and the building's",
      "real-world scale stay exactly where they are. You are a camera, not a designer.",
      "Zero tolerance for geometric or proportional deviation.",
      "",
      "STEP 1 — ANALYSE the attached model capture before generating. Establish precisely:",
      "1. BUILDING TYPOLOGY: what type of building this model shows (detached house,",
      "   pool house, tower, etc.). Never change it.",
      "2. STOREY COUNT: count the levels in the model. The output contains exactly this many.",
      "3. SCALE DATUM: establish the building's real-world size from its own geometry.",
      "   Use the openings as rulers — an entry door is approximately 2.1m tall; a",
      "   residential storey is approximately 2.7–3.0m floor-to-floor. From these,",
      "   state the building's approximate overall height and width in metres, and",
      "   its height-to-width ratio. The output reads at exactly this size: a",
      "   single-storey domestic building reads as a modest domestic building a",
      "   person could walk up to, never as a monumental or civic-scaled structure.",
      "4. CAMERA: the viewer's camera position, height, angle, tilt, and crop. The output",
      "   is framed identically — never reframe, recentre, zoom, or pull back.",
      "5. GEOMETRY INVENTORY: every wall plane, roof plane and pitch, edge, cantilever,",
      "   setback, opening (window/door), and their exact positions, sizes, and",
      "   proportions — including each opening's size RELATIVE to its wall.",
      "6. SURFACE STATE: whether the model is untextured clay (uniform grey/white) or",
      "   carries textures.",
      "",
      "STEP 2 — SCENE CONTRACT. The output image contains EXACTLY three elements:",
      "1. THE BUILDING — the model's geometry, unchanged: identical typology, storey",
      "   count, massing, footprint, roof form and pitch; identical camera position,",
      "   angle, lens, and framing; the silhouette of the output overlays the silhouette",
      "   of the input exactly; every window and door at the same count, position, size,",
      "   and proportion — none added, removed, resized, merged, or moved.",
      "   PROPORTION LOCK: the building renders at the real-world scale established in",
      "   your SCALE DATUM. Its height-to-width ratio, storey heights, wall heights,",
      "   and every opening's size relative to its wall match the input exactly.",
      "   Material coursing must agree with that scale — brick courses, cladding board",
      "   widths, roof sheeting profiles, and door hardware are sized so the building",
      "   reads at its true metre dimensions, never larger and never smaller.",
      "2. SKY — a plain, clear, neutral daytime sky. Soft even light. Empty.",
      "3. GROUND — a flat, minimal, neutral ground plane consistent with the model's base.",
      "That is the entire scene. If something is not one of these three elements and is",
      "not named in the user brief, it does not exist in this image. The viewer's blank",
      "backdrop is a studio backdrop, not a site — there is no site.",
      "",
      "MATERIALS — the model surface carries NO material meaning:",
      "- If the model is untextured clay, the grey/white surface is a placeholder, not a",
      "  finish. Do NOT render a grey concrete or white rendered building by default.",
      "- Materials come from the user brief ONLY. If the brief names materials, apply",
      "  them to the exact geometry shown, coursed and sized to the SCALE DATUM.",
      "- If the brief names no materials, use plain, conventional Australian residential",
      "  materials (e.g. brick or standard cladding walls, Colorbond-style metal or tiled",
      "  roof) applied without changing any geometry, coursed to the SCALE DATUM.",
      "- If the model carries textures, treat them as the specified materials and render",
      "  them convincingly at the established scale.",
      "",
      "DIRECTOR RULES — how you must write your prompt for the image generation tool.",
      "Every word you write becomes the scene, so:",
      "- POSITIVE STATEMENTS ONLY. Your tool prompt must never contain a negative",
      "  instruction — never write 'no trees', 'do not add water', 'without",
      "  landscaping', or any 'no/not/never/without' phrase. The image model treats",
      "  every noun in the prompt as content to depict, so NAMING an unwanted object",
      "  can summon it. Enforce every exclusion by OMISSION: simply never mention it.",
      "  This applies to SCALE as well: never write 'not monumental', 'not oversized',",
      "  or 'no exaggeration' — state the building's true size as a positive fact",
      "  instead, and the wrong scale is excluded automatically.",
      "- KEEP IT SHORT: under 140 words. Length is where scene-writing creeps in.",
      "- Structure the tool prompt as exactly five parts, in this order, then stop:",
      "  (a) the edit instruction: edit this exact image, preserving the silhouette,",
      "      camera, framing, every opening, and all proportions precisely;",
      "  (b) the fixed facts from your analysis: typology, exact storey count, camera",
      "      angle and crop;",
      "  (c) the SCALE DATUM as positive facts: the building's approximate overall",
      "      height and width in metres, and its scale in plain words — e.g.",
      "      'a single-storey domestic pool house, approximately 3.2 metres tall and",
      "      8 metres wide, with a standard 2.1-metre entry door'. Always include at",
      "      least one standard-sized element already present in the geometry (an",
      "      entry door, a storey height) — a named standard-sized element acts as",
      "      a ruler inside the prompt.",
      "  (d) the materials to apply, per the material rules above, sized to the",
      "      stated dimensions — e.g. 'standard-format brick coursing',",
      "      'standard-width cladding boards';",
      "  (e) the environment, in these words: 'plain clear daytime sky, flat neutral",
      "      ground plane, soft even neutral daylight'.",
      "  Anything beyond these five parts is a defect.",
      "- Describe the output as a 'photorealistic architectural visualisation on a",
      "  seamless neutral background' — never as a 'photograph of a building', which",
      "  invites an invented site around it.",
      "- Scenic, atmospheric, and lifestyle language is banned from your tool prompt",
      "  unless the user brief names it: 'golden hour', 'sunset', 'dusk', 'nestled',",
      "  'surrounded by', 'set in', 'overlooking', and any description of landscape,",
      "  vegetation, water, terrain, weather, or setting. Grandeur language is banned",
      "  unconditionally: 'grand', 'imposing', 'striking', 'monumental', 'sweeping',",
      "  'expansive', 'soaring' — these words inflate the building's rendered scale.",
      "",
      "OUTPUT BANS — these govern the final image. Enforce them through the SCENE",
      "CONTRACT and by omission; never write them into your tool prompt as words.",
      "Banned unless named in the user brief:",
      "- Changing the building typology or storey count",
      "- Changing the building's scale or proportions: enlarging, heightening,",
      "  monumentalizing, or shrinking the structure; stretching or compressing its",
      "  height-to-width ratio; resizing openings relative to their walls; rendering",
      "  material coursing (brick, cladding, roofing) at a size that implies a",
      "  larger or smaller building than the SCALE DATUM",
      "- Changing the camera position, angle, lens, or framing; zooming out,",
      "  recentring, or recomposing the shot",
      "- Any deviation from the model's edges, planes, proportions, or silhouette",
      "- 'Improving', 'refining', or 'correcting' the design in any way",
      "- Sunset, sunrise, golden-hour, or dusk lighting",
      "- Water bodies, vegetation, landscaping, terrain, or invented site context of",
      "  any kind (driveways, fences, streets, hills, neighbouring buildings)",
      "- Solar panels, green roofs, roof gardens, roof decks",
      "- LED strips, feature lighting, uplighting, illuminated signage",
      "- Louvres, screens, shutters, pergolas, awnings",
      "- Pools, water features, fire pits, sculptures, flagpoles",
      "- Extra windows, doors, skylights, dormers, chimneys, balconies, or storeys",
      "- Cars, people, animals, text, labels, watermarks",
      "",
      "IF ANYTHING IS AMBIGUOUS, choose the PLAIN, CONVENTIONAL reading. If scale is",
      "ambiguous, read the building at standard Australian residential dimensions:",
      "2.1m doors, 2.4–2.7m ceilings, 2.7–3.0m floor-to-floor. A plain wall stays",
      "plain. The blank backdrop stays a plain daytime sky over neutral ground.",
      "Never resolve ambiguity with a striking or designer feature.",
      "",
      "The user brief may specify materials, time of day, season, weather, and may name",
      "a setting. It never changes the building's typology, geometry, storey count,",
      "scale, proportions, or the camera.",
      "User brief: " + (userPrompt || "Photorealistic visualisation of this exact building."),
    ].join("\n");
  }

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
const RUNWAY_PROMPT_MAX = 1000;

function clampVideoPrompt(text) {
  return text.length > RUNWAY_PROMPT_MAX ? text.slice(0, RUNWAY_PROMPT_MAX) : text;
}

function buildVideoPrompt(userPrompt, mode) {
  const brief = String(userPrompt || "").trim();

  const HOLD =
    "The building is fixed: identical silhouette, storey count, roof form, " +
    "wall planes, window and door positions and materials in every frame. " +
    "Do not add, remove or reshape any part of the structure.";

  if (mode === "interior") {
    return clampVideoPrompt([
      "Slow, smooth cinematic walkthrough of this exact room: gentle forward",
      "drift with a subtle pan.", HOLD,
      "Keep the existing furniture and materials. Light may shift naturally.",
      "Photorealistic architectural interior footage.", brief,
    ].join(" "));
  }

  if (mode === "model_capture") {
    return clampVideoPrompt([
      "Photorealistic architectural visualisation of the client's exact building.",
      HOLD,
      "Add only what surrounds it: natural daylight with moving shadows, sky and",
      "atmosphere, landscaping and planting, outdoor furniture, and people moving",
      "naturally through the scene.",
      "Camera: one slow steady move holding the source viewpoint. No cuts.", brief,
    ].join(" "));
  }

  return clampVideoPrompt([
    "Photorealistic architectural footage of this exact building.", HOLD,
    "Add only natural light, sky, planting, outdoor furniture and people.",
    "Camera: slow smooth arc with a gentle push-in, close to the original",
    "viewpoint. No cuts.", brief,
  ].join(" "));
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

    runRender(finalPrompt, base64Data)
      .then((image) => {
        renderJobs[jobId] = { status: "done", image, createdAt: Date.now() };
      })
      .catch((error) => {
        console.error("Render job " + jobId + " failed:", error);
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
  if (job.video) {
    const video = job.video;
    delete renderJobs[req.params.jobId];
    return res.json({ ok: true, status: "done", video });
  }
  const image = job.image;
  delete renderJobs[req.params.jobId];
  return res.json({ ok: true, status: "done", image });
});

// ═════════════════════════════════════════════════════════════
// DESKTOP / ARCHICAD PLUGIN API
// ═════════════════════════════════════════════════════════════

const RC_ENTITLEMENT = "Monocular Pro";
const rcCache = new Map();
const RC_CACHE_MS = 5 * 60 * 1000;

async function isRevenueCatPro(appUserId) {
  if (!appUserId || !process.env.REVENUECAT_SECRET_KEY) return false;
  const hit = rcCache.get(appUserId);
  if (hit && Date.now() - hit.at < RC_CACHE_MS) return hit.pro;
  try {
    const r = await fetch(
      "https://api.revenuecat.com/v1/subscribers/" + encodeURIComponent(appUserId),
      { headers: { Authorization: "Bearer " + process.env.REVENUECAT_SECRET_KEY } }
    );
    if (!r.ok) { console.error("RevenueCat lookup failed:", r.status); return false; }
    const data = await r.json();
    const ent = data && data.subscriber && data.subscriber.entitlements
      ? data.subscriber.entitlements[RC_ENTITLEMENT] : null;
    const pro = !!(ent && (ent.expires_date === null ||
      (ent.expires_date && new Date(ent.expires_date) > new Date())));
    rcCache.set(appUserId, { pro, at: Date.now() });
    return pro;
  } catch (e) {
    console.error("RevenueCat lookup error:", e.message);
    return false;
  }
}

async function desktopAuth(req, res, next) {
  try {
    const rcUserId = req.header("x-rc-user-id");
    if (rcUserId && await isRevenueCatPro(rcUserId)) {
      req.desktopUser = {
        user_id: "rc:" + rcUserId,
        label: "RevenueCat Pro",
        subscriptionActive: true,
      };
      return next();
    }
    // Not a live subscriber - fall through to credits rather than lock out.
    const token = req.header("x-monocular-token");
    if (!token) {
      return res.status(rcUserId ? 402 : 401).json({
        ok: false,
        error: rcUserId
          ? "No active subscription, and no API token to fall back on."
          : "Missing x-monocular-token header",
      });
    }
    const { data, error } = await supabase
      .from("api_tokens")
      .select("token, user_id, label")
      .eq("token", token)
      .single();
    if (error || !data) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }
    supabase.from("api_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token", token).then(() => {});
    req.desktopUser = { ...data, subscriptionActive: false };
    next();
  } catch (err) {
    console.error("desktopAuth error:", err);
    res.status(500).json({ ok: false, error: "Auth check failed" });
  }
}

async function requireApiToken(req, res, next) {
  try {
    const token = req.header("x-monocular-token");
    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing x-monocular-token header" });
    }
    const { data, error } = await supabase
      .from("api_tokens")
      .select("token, user_id, label")
      .eq("token", token)
      .single();
    if (error || !data) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }
    supabase
      .from("api_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token", token)
      .then(() => {});
    req.desktopUser = data;
    next();
  } catch (err) {
    console.error("requireApiToken error:", err);
    res.status(500).json({ ok: false, error: "Auth check failed" });
  }
}

function buildScaleDatumFromDimensions(dimensions) {
  if (!dimensions) return null;
  const { widthM, depthM, heightM, storeys } = dimensions;
  const parts = [];
  if (widthM && depthM) parts.push(`overall footprint ${widthM}m x ${depthM}m`);
  if (heightM) parts.push(`overall height ${heightM}m`);
  if (storeys) parts.push(`${storeys} storey${storeys > 1 ? "s" : ""}`);
  if (parts.length === 0) return null;
  return (
    "SCALE DATUM (measured directly from the CAD model — exact, not estimated): " +
    parts.join(", ") +
    ". A standard door is 2.1m tall. All proportions in the output must match these measurements."
  );
}

app.get("/desktop/balance", desktopAuth, async (req, res) => {
  try {
    const email = req.desktopUser.user_id;
    const balance = await getCreditBalance(email);
    res.json({ ok: true, balance, email });
  } catch (error) {
    console.error("Desktop balance error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/desktop/render/start", desktopAuth, async (req, res) => {
  try {
    const { prompt, imageBase64, mode = "model_capture", dimensions } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Missing imageBase64." });
    }

    const email = req.desktopUser.user_id;

    const balance = await getCreditBalance(email);
    if (balance <= 0) {
      return res.status(402).json({ ok: false, error: "No credits on " + email + ". Top up to render." });
    }

    const { error: deductErr } = await supabase
      .from("credits")
      .update({ balance: balance - 1, updated_at: new Date().toISOString() })
      .eq("email", email);
    if (deductErr) {
      console.error("Desktop credit deduct failed:", deductErr);
      return res.status(500).json({ ok: false, error: "Credit deduction failed." });
    }

    const scaleDatum = buildScaleDatumFromDimensions(dimensions);
    const briefWithScale = scaleDatum
      ? (prompt ? prompt + "\n\n" + scaleDatum : scaleDatum)
      : prompt;

    console.log("Desktop brief received:", JSON.stringify(briefWithScale), "mode:", mode, "user:", email);

    const finalPrompt = buildPrompt(briefWithScale, mode);
    const base64Data = imageBase64.startsWith("data:")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const jobId = crypto.randomUUID();
    renderJobs[jobId] = { status: "pending", createdAt: Date.now() };

    runRender(finalPrompt, base64Data)
      .then((image) => {
        renderJobs[jobId] = { status: "done", image, createdAt: Date.now() };
      })
      .catch(async (error) => {
        console.error("Desktop render job " + jobId + " failed:", error);
        try {
          const current = await getCreditBalance(email);
          await supabase
            .from("credits")
            .update({ balance: current + 1, updated_at: new Date().toISOString() })
            .eq("email", email);
        } catch (refundErr) {
          console.error("Credit refund failed for " + email + ":", refundErr);
        }
        renderJobs[jobId] = {
          status: "failed",
          error: error.message || "Render failed.",
          createdAt: Date.now(),
        };
      });

    return res.json({ ok: true, jobId, statusUrl: "/render/status/" + jobId });
  } catch (error) {
    console.error("Desktop render start error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

// ── Shared Runway video-task runner ──────────────────────────────────────────
// Uploads a single source frame, starts an image_to_video task, and polls
// Runway until it resolves. Used both by the desktop single-clip endpoint and
// by the multi-angle stitcher below (once per angle).
async function runRunwayVideoTask(motion, base64Data, ratio, duration) {
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
    throw new Error("Upload init failed.");
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

  const startRes = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
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
      ratio,
      duration,
    }),
  });
  const startData = await startRes.json();
  if (!startRes.ok || !startData.id) {
    const detail = JSON.stringify(startData);
    console.error("Runway video start failed:", startRes.status, detail);
    throw new Error(
      "Video task failed to start (Runway " + startRes.status + "): " + detail
    );
  }
  const taskId = startData.id;

  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch("https://api.dev.runwayml.com/v1/tasks/" + taskId, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const pollData = await pollRes.json();
    if (pollData.status === "SUCCEEDED") {
      const url = pollData.output && pollData.output[0] ? pollData.output[0] : null;
      if (!url) throw new Error("Video finished but no output URL.");
      return url;
    }
    if (pollData.status === "FAILED") {
      throw new Error(pollData.failure || "Runway reported the video task failed.");
    }
  }
  throw new Error("Video timed out waiting on Runway.");
}

app.post("/desktop/video/start", desktopAuth, async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mode = "model_capture",
      dimensions,
      duration = 5,
      ratio = "1280:720",
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Missing imageBase64." });
    }

    const seconds = Number(duration) === 10 ? 10 : 5;
    const cost = seconds;
    const safeRatio = ratio === "720:1280" ? "720:1280" : "1280:720";

    const email = req.desktopUser.user_id;

    const balance = await getCreditBalance(email);
    if (balance < cost) {
      return res.status(402).json({
        ok: false,
        error: "Not enough credits on " + email + " — a " + seconds + "s video costs " + cost + ".",
      });
    }

    const { error: deductErr } = await supabase
      .from("credits")
      .update({ balance: balance - cost, updated_at: new Date().toISOString() })
      .eq("email", email);
    if (deductErr) {
      console.error("Desktop video credit deduct failed:", deductErr);
      return res.status(500).json({ ok: false, error: "Credit deduction failed." });
    }

    const scaleDatum = buildScaleDatumFromDimensions(dimensions);
    const briefWithScale = scaleDatum
      ? (prompt ? prompt + "\n\n" + scaleDatum : scaleDatum)
      : prompt;

    const motion = buildVideoPrompt(briefWithScale, mode);
    console.log(
      "Desktop video brief (" + motion.length + " chars, " + seconds + "s " + safeRatio + ", mode: " + mode + ", user: " + email + ")"
    );

    const base64Data = imageBase64.startsWith("data:")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const jobId = crypto.randomUUID();
    renderJobs[jobId] = { status: "pending", createdAt: Date.now() };

    runRunwayVideoTask(motion, base64Data, safeRatio, seconds)
      .then((video) => {
        renderJobs[jobId] = { status: "done", video, createdAt: Date.now() };
      })
      .catch(async (error) => {
        console.error("Desktop video job " + jobId + " failed:", error);
        try {
          const current = await getCreditBalance(email);
          await supabase
            .from("credits")
            .update({ balance: current + cost, updated_at: new Date().toISOString() })
            .eq("email", email);
        } catch (refundErr) {
          console.error("Video credit refund failed for " + email + ":", refundErr);
        }
        renderJobs[jobId] = {
          status: "failed",
          error: error.message || "Video failed.",
          createdAt: Date.now(),
        };
      });

    return res.json({ ok: true, jobId, statusUrl: "/render/status/" + jobId });
  } catch (error) {
    console.error("Desktop video start error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Video failed." });
  }
});

// ── Render (legacy synchronous endpoint) ─────────────────────────────────────
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

// ── Video (Runway) — legacy single-image, synchronous-poll pattern ──────────
// Kept for older client builds. Only ever used images[0] — the new
// /api/video/multi endpoint below is what actually uses all 3 angles.
app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images, mode = "render", email, subscriptionActive = false } = req.body;
    const imageList = Array.isArray(images) && images.length ? images : imageBase64 ? [imageBase64] : [];
    if (!prompt) return res.status(400).json({ ok: false, error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ ok: false, error: "Please upload an image." });

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

// ═════════════════════════════════════════════════════════════
// MULTI-ANGLE VIDEO (up to 3 angles, stitched into one file)
// The App Store app already collects up to 3 angle images (the "ADD ANGLE"
// button) but the legacy /api/video endpoint above only ever used the
// first one. This is the real fix: one short Runway clip per angle, then
// ffmpeg concatenates them (stream copy, no re-encode — all clips share
// codec/params since they all come from the same Runway model) into a
// single mp4. Runway's own multi-image/keyframe input mode is still listed
// as "coming soon" as of writing, so per-angle clips + stitching is the
// only way to actually use more than one angle today.
//
// Requires `ffmpeg-static` in package.json (npm install ffmpeg-static).
// ═════════════════════════════════════════════════════════════

function downloadToFile(url, destPath) {
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => fs.promises.writeFile(destPath, Buffer.from(buf)));
}

function concatMp4Files(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + ".txt";
    const listContent = inputPaths
      .map((p) => "file '" + p.replace(/'/g, "'\\''") + "'")
      .join("\n");
    fs.writeFileSync(listPath, listContent);

    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      fs.unlink(listPath, () => {});
      if (code === 0) resolve();
      else reject(new Error("ffmpeg concat failed: " + stderr.slice(-500)));
    });
  });
}

// Generates one clip per angle (sequentially, to stay within Runway rate
// limits) then stitches them into a single mp4 Buffer. 1 image -> single
// clip, no concat needed. 2-3 images -> shorter per-clip duration so the
// combined video lands around 10-12s total.
import { createRequire } from "module";
const seedanceRequire = createRequire(import.meta.url);
const seedance = seedanceRequire("./seedance-video.cjs");

async function runMultiAngleVideo(images, prompt, mode, ratio, seconds = 10) {
  const motion = buildVideoPrompt(prompt, mode);
  const stillPrompt = buildPrompt(prompt, mode);

  const refs = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const rawBase64 = img.startsWith("data:") ? img.split(",")[1] : img;
    let seedBase64 = rawBase64;
    try {
      const still = await runRender(stillPrompt, rawBase64);
      seedBase64 = still.startsWith("data:") ? still.split(",")[1] : still;
      console.log("Angle " + i + ": still render OK, using as Seedance reference");
    } catch (e) {
      console.error("Angle " + i + ": still render failed, using raw capture:", e.message);
    }
    refs.push("data:image/png;base64," + seedBase64);
  }

  const orientation = String(ratio).startsWith("720:") ? "portrait" : "landscape";
  const out = await seedance.renderWalkthrough({
    angleUris: refs,
    promptText: motion,
    seconds,
    resolution: "720p",
    orientation,
  });
  console.log("Seedance: " + out.duration + "s, ~" + out.estimatedCredits + " Runway credits");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monocular-video-"));
  try {
    const outPath = path.join(tmpDir, "merged.mp4");
    await downloadToFile(out.videoUrl, outPath);
    return fs.readFileSync(outPath);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// POST /api/video/multi
// Body: { prompt, images: [base64...] (1-3), mode?, email, subscriptionActive?, ratio? }
// Access rule matches /api/video: never free, subscription or credits only.
app.post("/api/video/multi", async (req, res) => {
  try {
    const {
      prompt,
      images,
      mode = "render",
      email,
      subscriptionActive = false,
      ratio = "1280:720",
    } = req.body || {};

    const imageList = Array.isArray(images) ? images.filter(Boolean).slice(0, 3) : [];
    if (!imageList.length) {
      return res.status(400).json({ ok: false, error: "Please provide at least one image." });
    }

    if (!subscriptionActive) {
      const balance = await getCreditBalance(email);
      if (balance <= 0) {
        return res.status(402).json({
          ok: false,
          error: "Video generation requires a subscription or credits.",
        });
      }
    }

    console.log(
      "Multi-angle video: " + imageList.length + " angle(s), mode: " + mode + ", user: " + (email || "guest")
    );

    const jobId = crypto.randomUUID();
    renderJobs[jobId] = { status: "pending", createdAt: Date.now() };

    runMultiAngleVideo(imageList, prompt, mode, ratio)
      .then((videoBuffer) => {
        renderJobs[jobId] = { status: "done", videoBuffer, createdAt: Date.now() };
      })
      .catch((error) => {
        console.error("Multi-angle video job " + jobId + " failed:", error);
        renderJobs[jobId] = {
          status: "failed",
          error: error.message || "Video failed.",
          createdAt: Date.now(),
        };
      });

    res.json({ ok: true, jobId });
  } catch (error) {
    console.error("Multi-angle video start error:", error);
    res.status(500).json({ ok: false, error: error.message || "Video failed." });
  }
});

// GET /api/video/multi/status/:jobId — poll until status is "done", then
// fetch the file from the returned relative `url`.
app.get("/api/video/multi/status/:jobId", (req, res) => {
  const job = renderJobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ ok: false, status: "not_found", error: "Job not found." });
  }
  if (job.status === "pending") {
    return res.json({ ok: true, status: "pending" });
  }
  if (job.status === "failed") {
    return res.json({ ok: false, status: "failed", error: job.error });
  }
  return res.json({ ok: true, status: "done", url: "/api/video/multi/file/" + req.params.jobId });
});

// GET /api/video/multi/file/:jobId — streams the stitched mp4 once, then
// frees the buffer from memory.
app.get("/api/video/multi/file/:jobId", (req, res) => {
  const job = renderJobs[req.params.jobId];
  if (!job || !job.videoBuffer) {
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", "video/mp4");
  res.send(job.videoBuffer);
  delete renderJobs[req.params.jobId];
});

// ── Keep-alive pings ─────────────────────────────────────────────────────────
const SELF_URL = "https://monocular-server.onrender.com/health";
setInterval(function () {
  fetch(SELF_URL).then(function () {}).catch(function () {});
}, 600000);

function pingSupabase() {
  supabase
    .from("credits")
    .select("email")
    .limit(1)
    .then(function () {
      console.log("Supabase keep-alive ping OK");
    })
    .catch(function (e) {
      console.error("Supabase keep-alive ping failed:", e.message);
    });
}

pingSupabase();
setInterval(pingSupabase, 1000 * 60 * 60 * 12);

app.listen(PORT, () => {
  console.log("Monocular server running on port " + PORT);
});
