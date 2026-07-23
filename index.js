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
        "Photorealistic architectural visualisation footage of the client's exact",
        "building design on a seamless neutral background. Every frame contains",
        "exactly three elements: the building, with identical silhouette, storey",
        "count, roof form, window positions, and materials in every frame; a plain",
        "clear daytime sky; and a flat neutral ground plane. Camera: one slow,",
        "steady push-in toward the building with slight parallax, holding the",
        "source viewpoint so only the surfaces visible in the source frame ever",
        "appear. Soft, even, neutral daylight throughout.",
        brief,
      ].join(" ")
    );
  }

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

app.get("/desktop/balance", requireApiToken, async (req, res) => {
  try {
    const email = req.desktopUser.user_id;
    const balance = await getCreditBalance(email);
    res.json({ ok: true, balance, email });
  } catch (error) {
    console.error("Desktop balance error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/desktop/render/start", requireApiToken, async (req, res) => {
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
    console.error("Runway video start failed:", JSON.stringify(startData));
    throw new Error("Video task failed to start.");
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

app.post("/desktop/video/start", requireApiToken, async (req, res) => {
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
async function runMultiAngleVideo(images, prompt, mode, ratio) {
  const perClipSeconds = images.length >= 3 ? 4 : images.length === 2 ? 5 : 10;
  const motion = buildVideoPrompt(prompt, mode);

  const clipUrls = [];
  for (const img of images) {
    const base64Data = img.startsWith("data:") ? img.split(",")[1] : img;
    const url = await runRunwayVideoTask(motion, base64Data, ratio, perClipSeconds);
    clipUrls.push(url);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monocular-video-"));
  try {
    const localPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const p = path.join(tmpDir, "angle" + i + ".mp4");
      await downloadToFile(clipUrls[i], p);
      localPaths.push(p);
    }

    const outPath = path.join(tmpDir, "merged.mp4");
    if (localPaths.length === 1) {
      fs.copyFileSync(localPaths[0], outPath);
    } else {
      await concatMp4Files(localPaths, outPath);
    }

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
});import express from "express";
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
    // Director model. GPT-5.6 superseded 5.5; Terra is the balanced tier
    // (the recommended starting point for workloads previously on 5.5).
    // Swap to "gpt-5.6" (routes to Sol, ~2x cost) if Terra's template
    // adherence or geometry analysis proves weaker on real captures.
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
// model_capture anti-hallucination architecture (July 2026 rewrite):
// The old approach fought hallucination with long negative ban lists. Two
// problems: (1) image models weight nouns as content — a revised_prompt that
// says "no trees, no lake" can literally summon trees and a lake; (2) long
// prompts drift into scene-writing. The rewrite flips both:
//   - SCENE CONTRACT: a whitelist. The output contains exactly three
//     elements (building / plain sky / neutral ground). Anything not on the
//     list doesn't exist, rather than being individually banned.
//   - POSITIVE-ONLY tool prompt: the director keeps the ban list in its own
//     head; the prompt it writes for the image model may only state what IS
//     in the scene, never what isn't.
//   - SHORT, TEMPLATED tool prompt: fixed parts, tight word cap, so there
//     is no room for the director to write cinema.
//   - "Product shot" framing: "photograph of a building" invites an invented
//     site; "architectural visualisation on a seamless neutral background"
//     doesn't.
//
// model_capture scale-anchoring (July 2026, second rewrite):
// The image model has no metric understanding — scale is inferred from
// visual cues, and a clay capture on a blank backdrop has almost none.
// Left unanchored, the model defaults to "generic building" proportions,
// typically inflating domestic buildings toward something grander. Fixes:
//   - SCALE DATUM (STEP 1 item 3): the director derives real metre
//     dimensions from the geometry itself, using doors (~2.1m) and storeys
//     (~2.7–3.0m) as rulers, and states height/width and the aspect ratio.
//   - PROPORTION LOCK (in the scene contract): height-to-width ratio,
//     opening-to-wall proportions, and material coursing (brick courses,
//     cladding board widths) must agree with the datum — wrong-scale
//     coursing is the main way renders silently imply a bigger building.
//   - DIRECTOR RULES now carry the datum into the tool prompt: the
//     five-part template includes the scale facts as POSITIVE statements
//     (metre dimensions + a standard-sized element as an in-prompt ruler,
//     e.g. 'standard 2.1m entry door', 'standard-format brick coursing').
//     Never phrased negatively — 'not monumental' summons monumental.
//   - Ambiguous scale resolves to standard Australian residential
//     dimensions rather than the model's generic-building prior.
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
// July 2026: model_capture rewritten POSITIVE-ONLY. Runway, like the image
// model, weights nouns as content — "do not add trees, water, roads" is a
// prompt full of trees, water, and roads. The rewrite never names an
// unwanted object; instead it states the complete scene as a whitelist
// (building / plain sky / neutral ground) so everything else is excluded by
// omission.
//
// Fixes:
//   - model_capture: NO orbit. Slow push-in with slight parallax only, so the
//     camera never has to reveal geometry the capture doesn't show. Scene
//     stated as a three-element whitelist; no negative phrases at all.
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
        "Photorealistic architectural visualisation footage of the client's exact",
        "building design on a seamless neutral background. Every frame contains",
        "exactly three elements: the building, with identical silhouette, storey",
        "count, roof form, window positions, and materials in every frame; a plain",
        "clear daytime sky; and a flat neutral ground plane. Camera: one slow,",
        "steady push-in toward the building with slight parallax, holding the",
        "source viewpoint so only the surfaces visible in the source frame ever",
        "appear. Soft, even, neutral daylight throughout.",
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
  // done — return the result and free the memory immediately rather than
  // waiting for the TTL sweep (images are multi-megabyte strings).
  // Video jobs carry a `video` URL instead of a base64 `image`; return
  // whichever this job produced so the desktop bench can poll one endpoint
  // for both stills and video.
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
// Auth: x-monocular-token header → api_tokens table (user_id = email).
// Renders spend credits (1 per still, 5/10 per video), refunded on failure.
// Polling reuses the existing GET /render/status/:jobId.
// ═════════════════════════════════════════════════════════════

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

// Real CAD dimensions from ArchiCAD → exact scale grounding for the director.
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

// GET /desktop/balance — returns the token owner's current credit balance.
// The desktop bench calls this on save and when the credits pill is tapped.
app.get("/desktop/balance", requireApiToken, async (req, res) => {
  try {
    const email = req.desktopUser.user_id;
    const balance = await getCreditBalance(email);
    res.json({ ok: true, balance, email });
  } catch (error) {
    console.error("Desktop balance error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /desktop/render/start
// Body: { imageBase64, prompt, mode?, dimensions?: { widthM, depthM, heightM, storeys } }
// Returns: { ok, jobId } — poll GET /render/status/:jobId as usual.
app.post("/desktop/render/start", requireApiToken, async (req, res) => {
  try {
    const { prompt, imageBase64, mode = "model_capture", dimensions } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Missing imageBase64." });
    }

    const email = req.desktopUser.user_id;

    // Desktop renders are credit-only (no free tier, no subscription flag).
    const balance = await getCreditBalance(email);
    if (balance <= 0) {
      return res.status(402).json({ ok: false, error: "No credits on " + email + ". Top up to render." });
    }

    // Deduct one credit up front; refunded below if the render fails.
    const { error: deductErr } = await supabase
      .from("credits")
      .update({ balance: balance - 1, updated_at: new Date().toISOString() })
      .eq("email", email);
    if (deductErr) {
      console.error("Desktop credit deduct failed:", deductErr);
      return res.status(500).json({ ok: false, error: "Credit deduction failed." });
    }

    // Append the exact CAD measurements to the user brief.
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
        // Refund the credit on failure.
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

// ── Desktop video job runner ─────────────────────────────────────────────────
// Mirrors runRender for the async job store, but drives Runway end to end:
// upload the source frame, start an image_to_video task, then poll Runway
// server-side until the task finishes and resolve the output URL. Runway
// polling happens here (not in the client) so the desktop bench polls one
// endpoint — GET /render/status/:jobId — for both stills and video.
//
// FIX (July 2026): the Runway image_to_video start call was missing the
// `duration` field entirely — only `ratio` was ever passed. That leaves
// Runway to reject or default the task in a way that yields no `id`,
// which runDesktopVideo throws as "Video task failed to start." This is
// the direct cause of "video failed to start" on the desktop bench.
// `duration` is now threaded through from the caller (5 or 10, matching
// the credit cost) and included in the request body below.
async function runDesktopVideo(motion, base64Data, ratio, duration) {
  const imageBuffer = Buffer.from(base64Data, "base64");

  // 1. Init an ephemeral upload.
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

  // 2. Push the bytes to the signed URL (form-POST or PUT, per the init).
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

  // 3. Start the video task. Duration is fixed by the caller (5 or 10s);
  //    ratio is 1280:720 (landscape) or 720:1280 (portrait) from the bench.
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
    console.error("Runway video start failed:", JSON.stringify(startData));
    throw new Error("Video task failed to start.");
  }
  const taskId = startData.id;

  // 4. Poll Runway until the task resolves. Cap the wait well under the
  //    job TTL so a stuck task can't pin memory forever.
  const deadline = Date.now() + 8 * 60 * 1000; // 8 minutes
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
    // PENDING / RUNNING / THROTTLED → keep waiting.
  }
  throw new Error("Video timed out waiting on Runway.");
}

// POST /desktop/video/start
// Body: { imageBase64, prompt, mode?, dimensions?, duration?: 5|10,
//         ratio?: "1280:720"|"720:1280" }
// Same token auth + credit gate + refund pattern as the stills endpoint.
// Costs match the bench: 5s → 5 credits, 10s → 10 credits.
// Returns: { ok, jobId } — poll GET /render/status/:jobId; a finished video
// job returns { status: "done", video: <url> }.
app.post("/desktop/video/start", requireApiToken, async (req, res) => {
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

    // Normalise inputs — the cost and the Runway request depend on them.
    const seconds = Number(duration) === 10 ? 10 : 5;
    const cost = seconds; // 5s → 5 credits, 10s → 10 credits
    const safeRatio = ratio === "720:1280" ? "720:1280" : "1280:720";

    const email = req.desktopUser.user_id;

    const balance = await getCreditBalance(email);
    if (balance < cost) {
      return res.status(402).json({
        ok: false,
        error: "Not enough credits on " + email + " — a " + seconds + "s video costs " + cost + ".",
      });
    }

    // Deduct up front; refunded in full if the video fails.
    const { error: deductErr } = await supabase
      .from("credits")
      .update({ balance: balance - cost, updated_at: new Date().toISOString() })
      .eq("email", email);
    if (deductErr) {
      console.error("Desktop video credit deduct failed:", deductErr);
      return res.status(500).json({ ok: false, error: "Credit deduction failed." });
    }

    // Fold the exact CAD measurements into the brief as positive scale facts,
    // exactly as the stills path does.
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

    runDesktopVideo(motion, base64Data, safeRatio, seconds)
      .then((video) => {
        renderJobs[jobId] = { status: "done", video, createdAt: Date.now() };
      })
      .catch(async (error) => {
        console.error("Desktop video job " + jobId + " failed:", error);
        // Refund the full cost on failure.
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
//   "model_capture" — push-in only (no orbit), scene stated as a positive
//                     three-element whitelist (building / plain sky / neutral
//                     ground); unwanted objects excluded by never naming them
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

// ── Keep-alive pings ─────────────────────────────────────────────────────────
// 1. Render (free tier spins down idle services): ping our own /health every
//    10 minutes so the server stays awake.
// 2. Supabase (free tier pauses projects with no activity for ~1 week): run a
//    trivial query every 12 hours so the project registers activity. The
//    service_role key bypasses RLS, so this works with no policies on the
//    table. Depends on ping #1 keeping this process alive.
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

pingSupabase(); // fire once at startup (covers frequent restarts)
setInterval(pingSupabase, 1000 * 60 * 60 * 12); // then every 12 hours

app.listen(PORT, () => {
  console.log("Monocular server running on port " + PORT);
});
