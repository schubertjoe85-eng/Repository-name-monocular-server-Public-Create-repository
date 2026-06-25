import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Jimp from "jimp";
import { CONTROL_CONFIG, buildWishImagePrompt, SYSTEM_PROMPT } from "./renderDirector.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;

let videoCache = { id: null, buffer: null };

let projectMemory = {
  appName: "thedoss",
  buildingType: "",
  location: "",
  preferredStyle: "realistic Australian architectural visualisation",
  preserve: [
    "original building massing",
    "drawn roof form",
    "window and door locations",
    "overall proportions",
    "site logic",
    "structural believability"
  ],
  avoid: [
    "random design changes",
    "fantasy architecture",
    "extra buildings",
    "warped geometry",
    "wrong openings",
    "cartoon style unless requested"
  ]
};

const ARCHITECTURAL_DIRECTOR = "You are the Architectural Director brain for an app called thedoss. Your job is to refine user render requests before image or video generation. Rules: Preserve the uploaded drawing/model/building unless the user clearly asks to change it. Do not invent major design changes. Improve realism, materials, lighting, context and camera. Keep architecture believable and buildable. If the request is vague, make a professional architectural assumption. If a user asks for a wild style, keep the building geometry controlled. Never let the render go rogue. Return ONLY valid JSON with this exact structure: { \"mode\": \"image\", \"cleanPrompt\": \"\", \"negativePrompt\": \"\", \"camera\": \"\", \"materials\": \"\", \"siteContext\": \"\", \"lighting\": \"\", \"mustPreserve\": [], \"warnings\": [] }";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Brain did not return JSON.");
    return JSON.parse(match[0]);
  }
}

async function buildBrain({ userPrompt, renderMode = "image", uploadedImageBase64, uploadedImages }) {
  const content = [
    {
      type: "input_text",
      text: "User request:\n" + userPrompt + "\n\nRequested mode:\n" + renderMode + "\n\nCurrent project memory:\n" + JSON.stringify(projectMemory, null, 2) + "\n\nCreate a strict architectural render brief."
    }
  ];

  const brainImages = (Array.isArray(uploadedImages) && uploadedImages.length)
    ? uploadedImages
    : (uploadedImageBase64 ? [uploadedImageBase64] : []);
  for (const img of brainImages) {
    content.push({
      type: "input_image",
      image_url: img.startsWith("data:") ? img : "data:image/png;base64," + img
    });
  }

  const response = await openai.responses.create({
    model: "gpt-5.5",
    max_output_tokens: 1500,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content }
    ]
  });

  return safeJsonParse(response.output_text);
}

function buildFinalImagePrompt(brief) {
  const preserveList = (brief.mustPreserve || []).map(function(x) { return "- " + x; }).join("\n");
  return "ARCHITECTURAL RENDER BRIEF\n\n" + brief.cleanPrompt + "\n\nCamera:\n" + brief.camera + "\n\nMaterials:\n" + brief.materials + "\n\nSite context:\n" + brief.siteContext + "\n\nLighting:\n" + brief.lighting + "\n\nMust preserve:\n" + preserveList + "\n\nAvoid:\n" + brief.negativePrompt + "\n\nGlobal quality rules:\nUltra photorealistic architectural visualisation, magazine quality.\nBelievable scale and correct one-point/two-point perspective.\nSharp focus on the building, natural depth of field in the background.\nPhysically accurate shadows, ambient occlusion, and reflections.\nHigh dynamic range lighting (no blown-out sky, no crushed shadows).\nCrisp, high-resolution material textures.\nNo warped geometry, no melted edges, no duplicated structural elements.\nNo random extra doors or windows.\nNo fantasy elements unless explicitly requested.\nPreserve the supplied design intent exactly.";
}

app.get("/", (req, res) => {
  res.json({ ok: true, app: "thedoss server", brain: "Architectural Director active" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/api/memory", (req, res) => {
  projectMemory = { ...projectMemory, ...req.body };
  res.json({ ok: true, projectMemory });
});

app.get("/api/memory", (req, res) => {
  res.json({ ok: true, projectMemory });
});

app.post("/api/brain", async (req, res) => {
  try {
    const { prompt, mode, imageBase64 } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }
    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: mode || "image",
      uploadedImageBase64: imageBase64
    });
    res.json({ ok: true, brief });
  } catch (error) {
    console.error("Brain error:", error);
    res.status(500).json({ error: "Brain failed.", detail: error.message });
  }
});

app.post("/api/render", async (req, res) => {
  try {
    const { prompt, imageBase64 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });

    // Try the brain, but NEVER let it break the render.
    let finalPrompt = prompt + ". Photorealistic architectural visualization, faithful to the supplied design. Real materials, natural daylight, accurate proportions. Do not redesign, restyle, or invent elements not present.";
    let brief = null;
    try {
      brief = await buildBrain({ userPrompt: prompt, renderMode: "image", uploadedImageBase64: imageBase64 });
      if (brief && brief.cleanPrompt) {
        finalPrompt = buildFinalImagePrompt(brief);
      }
    } catch (brainErr) {
      console.error("Brain skipped:", brainErr.message);
    }

    const inputPayload = [{ role: "user", content: [
      { type: "input_text", text: finalPrompt },
      ...(imageBase64 ? [{ type: "input_image", image_url: imageBase64.startsWith("data:") ? imageBase64 : "data:image/png;base64," + imageBase64 }] : [])
    ] }];

    const baseTool = { type: "image_generation", quality: "high", size: "1024x1024" };

    let response;
    try {
      const tool = imageBase64 ? Object.assign({}, baseTool, { input_fidelity: "high" }) : baseTool;
      response = await openai.responses.create({ model: "gpt-5.5", input: inputPayload, tools: [tool] });
    } catch (genErr) {
      console.error("Gen retry without fidelity:", genErr.message);
      response = await openai.responses.create({ model: "gpt-5.5", input: inputPayload, tools: [baseTool] });
    }

    const imageCall = response.output.find(function(item) { return item.type === "image_generation_call"; });
    if (!imageCall || !imageCall.result) {
      return res.status(500).json({ error: "No image generated. Please try again." });
    }

    return res.json({ ok: true, brief: brief, imageBase64: imageCall.result });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ error: "Render failed.", detail: error.message });
  }
});

app.post("/api/render-v2", async (req, res) => {
  try {
    const { prompt, imageBase64, imageUrl, controlScale, preprocess } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
    let finalPrompt = prompt;
    try {
      const brief = await buildBrain({ userPrompt: prompt, renderMode: "image", uploadedImageBase64: imageBase64 });
      finalPrompt = buildWishImagePrompt(brief);
    } catch (brainErr) {
      console.error("Brain unavailable, using raw prompt:", brainErr.message);
    }
    let ctrl = imageUrl || null;
    if (!ctrl && imageBase64) ctrl = imageBase64.startsWith("data:") ? imageBase64 : "data:image/png;base64," + imageBase64;
    if (!ctrl) return res.status(400).json({ error: "Missing image." });
    const falRes = await fetch("https://fal.run/fal-ai/z-image/turbo/controlnet", {
      method: "POST",
      headers: { Authorization: "Key " + process.env.FAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ prompt: finalPrompt, image_url: ctrl }, CONTROL_CONFIG, { preprocess: preprocess || CONTROL_CONFIG.preprocess, control_scale: typeof controlScale === "number" ? controlScale : CONTROL_CONFIG.control_scale }))
    });
    const data = await falRes.json();
    if (!falRes.ok) { console.error("Fal error:", data); return res.status(500).json({ error: "Fal render failed.", detail: JSON.stringify(data) }); }
    const outUrl = data.images && data.images[0] ? data.images[0].url : null;
    res.json({ ok: true, imageUrl: outUrl });
  } catch (error) {
    console.error("Render-v2 error:", error);
    res.status(500).json({ error: "Render-v2 failed.", detail: error.message });
  }
});

app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images } = req.body;
    const imageList = (Array.isArray(images) && images.length) ? images : (imageBase64 ? [imageBase64] : []);
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ error: "Please upload an image." });
    const src = imageList[0];
    const imageUrl = src.startsWith("data:") ? src : "data:image/png;base64," + src;
    const motion = prompt + ". Keep the building structure unchanged; realistic cinematic motion.";
    const r = await fetch("https://queue.fal.run/fal-ai/wan-i2v", {
      method: "POST",
      headers: { Authorization: "Key " + process.env.FAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: motion, image_url: imageUrl, resolution: "480p" })
    });
    const data = await r.json();
    if (!r.ok || !data.request_id) { console.error("Wan submit error:", data); return res.status(500).json({ error: "Video failed.", detail: JSON.stringify(data) }); }
    res.json({ ok: true, video: { id: data.request_id } });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ error: "Video failed.", detail: error.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const r = await fetch("https://queue.fal.run/fal-ai/wan-i2v/requests/" + req.params.id + "/status", {
      headers: { Authorization: "Key " + process.env.FAL_KEY }
    });
    const data = await r.json();
    const done = data.status === "COMPLETED";
    res.json({ ok: true, video: { status: done ? "completed" : "in_progress" } });
  } catch (error) {
    res.status(500).json({ error: "Status failed.", detail: error.message });
  }
});

app.get("/api/video/:id/content", async (req, res) => {
  try {
    const rr = await fetch("https://queue.fal.run/fal-ai/wan-i2v/requests/" + req.params.id, {
      headers: { Authorization: "Key " + process.env.FAL_KEY }
    });
    const result = await rr.json();
    const url = result.video ? result.video.url : null;
    if (!url) return res.status(404).json({ error: "No video URL yet." });
    return res.redirect(302, url);
  } catch (error) {
    res.status(500).json({ error: "Content failed.", detail: error.message });
  }
});

app.get("/api/video/:id/url", async (req, res) => {
  try {
    const rr = await fetch("https://queue.fal.run/fal-ai/wan-i2v/requests/" + req.params.id, {
      headers: { Authorization: "Key " + process.env.FAL_KEY }
    });
    const result = await rr.json();
    const url = result.video ? result.video.url : null;
    if (!url) return res.status(404).json({ error: "No video URL yet." });
    res.json({ ok: true, url: url });
  } catch (error) {
    res.status(500).json({ error: "URL fetch failed.", detail: error.message });
  }
});

const SELF_URL = "https://monocular-server.onrender.com/health";
setInterval(function () {
  fetch(SELF_URL).then(function () {}).catch(function () {});
}, 600000);

app.listen(PORT, () => {
  console.log("thedoss server running on port " + PORT);
  console.log("Architectural Director brain active.");
});
