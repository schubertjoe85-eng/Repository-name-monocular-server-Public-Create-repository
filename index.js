import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Jimp from "jimp";
import { CONTROL_CONFIG, buildWishImagePrompt } from "./renderDirector.js";

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
    input: [
      { role: "system", content: ARCHITECTURAL_DIRECTOR },
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
    if (!imageBase64) return res.status(400).json({ error: "Please upload an image to render." });
    const finalPrompt = prompt + ". Photorealistic architectural visualization, faithful to the supplied structure. Natural daylight, honest materials, physically correct light. Do not add, move, or invent windows, doors, rooflines, or structural elements.";
    const ctrl = imageBase64.startsWith("data:") ? imageBase64 : "data:image/png;base64," + imageBase64;
    const falRes = await fetch("https://fal.run/fal-ai/z-image/turbo/controlnet", {
      method: "POST",
      headers: { Authorization: "Key " + process.env.FAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ prompt: finalPrompt, image_url: ctrl }, CONTROL_CONFIG))
    });
    const data = await falRes.json();
    if (!falRes.ok) { console.error("Fal error:", data); return res.status(500).json({ error: "Render failed.", detail: JSON.stringify(data) }); }
    const outUrl = data.images && data.images[0] ? data.images[0].url : null;
    if (!outUrl) return res.status(500).json({ error: "No image returned." });
    const imgResp = await fetch(outUrl);
    const arrBuf = await imgResp.arrayBuffer();
    const b64 = Buffer.from(arrBuf).toString("base64");
    res.json({ ok: true, imageBase64: b64 });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({ error: "Render failed.", detail: error.message });
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
    const { prompt, imageBase64, images, seconds, size } = req.body;
    const imageList = (Array.isArray(images) && images.length) ? images : (imageBase64 ? [imageBase64] : []);
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: "video",
      uploadedImages: imageList
    });

    const preserveList = (brief.mustPreserve || []).map(function(x) { return "- " + x; }).join("\n");

    const videoPrompt = "Create an architectural video for thedoss.\n\nScene:\n" + brief.cleanPrompt + "\n\nCamera:\nSlow cinematic architectural dolly/orbit.\nStable lens.\nNo warping.\nNo melting.\nNo changing the building shape.\n\nMaterials:\n" + brief.materials + "\n\nSite:\n" + brief.siteContext + "\n\nLighting:\n" + brief.lighting + "\n\nMust preserve:\n" + preserveList + "\n\nAvoid:\n" + brief.negativePrompt;

    let referenceBlob = null;
    let renderedAnchor = null;
    try {
      const fp = buildFinalImagePrompt(brief);
      const src = imageList[0] || null;
      const rContent = [{ type: "input_text", text: fp }];
      if (src) rContent.push({ type: "input_image", image_url: src.startsWith("data:") ? src : "data:image/png;base64," + src });
      const rTool = { type: "image_generation", quality: "high", size: "1536x1024" };
      const rResp = await openai.responses.create({ model: "gpt-5.5", input: [{ role: "user", content: rContent }], tools: [src ? Object.assign({}, rTool, { input_fidelity: "high" }) : rTool] });
      const rCall = rResp.output.find(function(i) { return i.type === "image_generation_call"; });
      if (rCall && rCall.result) renderedAnchor = "data:image/png;base64," + rCall.result;
    } catch (e) {
      console.error("Pre-video render failed:", e.message);
    }
    const anchorImage = renderedAnchor || imageList[0] || null;
    if (anchorImage) {
      try {
        const raw = anchorImage.startsWith("data:")
          ? anchorImage.split(",")[1]
          : anchorImage;
        const inputBuffer = Buffer.from(raw, "base64");
        const image = await Jimp.read(inputBuffer);
        image.contain(1280, 720);
        const outBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        referenceBlob = new Blob([outBuffer], { type: "image/jpeg" });
      } catch (imgErr) {
      }
    }

    const form = new FormData();
    form.append("model", "sora-2");
    form.append("prompt", videoPrompt);
    form.append("size", "1280x720");
    form.append("seconds", seconds || "8");
    if (referenceBlob) {
      form.append("input_reference", referenceBlob, "reference.jpg");
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY
      },
      body: form
    });

    const video = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("Video error:", video);
      return res.status(500).json({ error: "Video failed.", detail: video.error ? video.error.message : JSON.stringify(video) });
    }

    res.json({ ok: true, brief, video });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ error: "Video failed.", detail: error.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/videos/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY
      }
    });

    const video = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(500).json({ error: "Could not get video status.", detail: video.error ? video.error.message : JSON.stringify(video) });
    }

    res.json({ ok: true, video });
  } catch (error) {
    console.error("Video status error:", error);
    res.status(500).json({ error: "Could not get video status.", detail: error.message });
  }
});

app.get("/api/video/:id/content", async (req, res) => {
  try {
    const id = req.params.id;
    if (videoCache.id !== id || !videoCache.buffer) {
      const openaiResponse = await fetch("https://api.openai.com/v1/videos/" + id + "/content", {
        headers: {
          Authorization: "Bearer " + process.env.OPENAI_API_KEY
        }
      });

      if (!openaiResponse.ok) {
        return res.status(500).json({ error: "Could not fetch video content." });
      }

      videoCache = { id: id, buffer: Buffer.from(await openaiResponse.arrayBuffer()) };
    }

    const buffer = videoCache.buffer;
    const total = buffer.length;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunk = buffer.slice(start, end + 1);
      res.writeHead(206, {
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Content-Length": chunk.length,
        "Content-Type": "video/mp4"
      });
      res.end(chunk);
    } else {
      res.writeHead(200, {
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4"
      });
      res.end(buffer);
    }
  } catch (error) {
    console.error("Video content error:", error);
    res.status(500).json({ error: "Could not fetch video content.", detail: error.message });
  }
});


app.listen(PORT, () => {
  console.log("thedoss server running on port " + PORT);
  console.log("Architectural Director brain active.");
});
