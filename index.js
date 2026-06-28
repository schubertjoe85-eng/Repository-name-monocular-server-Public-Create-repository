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

let projectMemory = {
  appName: "Monocular",
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
      text: "User request:\n" + userPrompt + "\n\nRequested mode:\n" + renderMode + "\n\nCurrent project memory:\n" + JSON.stringify(projectMemory, null, 2) + "\n\nCreate a strict architectural render brief. Return ONLY valid JSON."
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
  return [
    "ARCHITECTURAL RENDER BRIEF — Ultra photorealistic, magazine quality. Houses magazine standard.",
    "",
    brief.cleanPrompt,
    "",
    "Camera:",
    brief.camera || "Eye-level, slight upward tilt, two-point perspective.",
    "",
    "Materials:",
    brief.materials,
    "",
    "Site context:",
    brief.siteContext,
    "",
    "Lighting:",
    brief.lighting,
    "",
    "Must preserve exactly:",
    preserveList,
    "",
    "Do not produce:",
    brief.negativePrompt,
    "",
    "Global quality rules:",
    "Ultra photorealistic architectural visualisation, magazine quality.",
    "Believable scale and correct one-point/two-point perspective.",
    "Sharp focus on the building, natural depth of field in the background.",
    "Physically accurate shadows, ambient occlusion, and reflections.",
    "High dynamic range lighting — no blown-out sky, no crushed shadows.",
    "Crisp, high-resolution material textures at correct scale.",
    "No warped geometry, no melted edges, no duplicated structural elements.",
    "No random extra doors or windows.",
    "No fantasy elements unless explicitly requested.",
    "Preserve the supplied design intent exactly.",
  ].join("\n");
}

app.get("/", (req, res) => {
  res.json({ ok: true, app: "Monocular Server", status: "running" });
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
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
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

    let finalPrompt = prompt + ". Ultra photorealistic architectural visualization, magazine quality. Faithful to the supplied design. Real materials, natural daylight, accurate proportions. Do not redesign, restyle, or invent elements not present.";
    let brief = null;
    try {
      brief = await buildBrain({ userPrompt: prompt, renderMode: "image", uploadedImageBase64: imageBase64 });
      if (brief && brief.cleanPrompt) finalPrompt = buildFinalImagePrompt(brief);
    } catch (brainErr) {
      console.error("Brain skipped:", brainErr.message);
    }

    const inputPayload = [{ role: "user", content: [
      { type: "input_text", text: finalPrompt },
      ...(imageBase64 ? [{ type: "input_image", image_url: imageBase64.startsWith("data:") ? imageBase64 : "data:image/png;base64," + imageBase64 }] : [])
    ] }];

    const baseTool = { type: "image_generation", quality: "high", size: "1536x1024" };

    let response;
    try {
      const tool = imageBase64 ? Object.assign({}, baseTool, { input_fidelity: "high" }) : baseTool;
      response = await openai.responses.create({ model: "gpt-5.5", input: inputPayload, tools: [tool] });
    } catch (genErr) {
      console.error("Gen retry without fidelity:", genErr.message);
      response = await openai.responses.create({ model: "gpt-5.5", input: inputPayload, tools: [baseTool] });
    }

    const imageCall = response.output.find(function(item) { return item.type === "image_generation_call"; });
    if (!imageCall || !imageCall.result) return res.status(500).json({ error: "No image generated. Please try again." });

    return res.json({ ok: true, brief: brief, imageBase64: imageCall.result });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ error: "Render failed.", detail: error.message });
  }
});

app.post("/render", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  try {
    const { prompt, imageBase64, mode = "render" } = req.body || {};
    if (!imageBase64) return res.status(400).json({ ok: false, error: "Upload an image first." });

    const isInterior = mode === "interior";
    const finalPrompt = isInterior
      ? [
          "IMPORTANT: This is an INTERIOR SPACE. You are looking INSIDE a building.",
          "There is NO exterior view. Treat this as a high-end interior design photograph shot inside the room.",
          "",
          "Preserve EXACTLY: room shape, ceiling height and form, floor area, wall positions,",
          "window and door positions as seen from inside, furniture layout and scale.",
          "",
          "Enhance with restraint: interior lighting quality (pendant lights, recessed lighting,",
          "natural light through windows casting correct shadows), material finishes on floors",
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
          "User brief: " + (prompt || "Create a photorealistic interior architectural render."),
        ].join("\n")
      : [
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
          "",
          "User brief: " + (prompt || "Create a realistic architectural render."),
        ].join("\n");

    const imageBuffer = Buffer.from(imageBase64, "base64");
    const imageFile = await OpenAI.toFile(imageBuffer, "source.png", { type: "image/png" });

    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: imageFile,
      prompt: finalPrompt,
      size: "1024x1024",
    });

    const imageBase64Out = response?.data?.[0]?.b64_json;
    if (!imageBase64Out) return res.status(500).json({ ok: false, error: "No image returned." });

    return res.json({ ok: true, image: "data:image/png;base64," + imageBase64Out });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
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
    if (!falRes.ok) return res.status(500).json({ error: "Fal render failed.", detail: JSON.stringify(data) });
    const outUrl = data.images && data.images[0] ? data.images[0].url : null;
    res.json({ ok: true, imageUrl: outUrl });
  } catch (error) {
    res.status(500).json({ error: "Render-v2 failed.", detail: error.message });
  }
});

app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images, mode = "render" } = req.body;
    const imageList = (Array.isArray(images) && images.length) ? images : (imageBase64 ? [imageBase64] : []);
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ error: "Please upload an image." });

    const src = imageList[0];
    const base64Data = src.startsWith("data:") ? src.split(",")[1] : src;
    const imageBuffer = Buffer.from(base64Data, "base64");

    // Step 1: Get a Runway upload URL
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
    console.log("FULL uploadData:", JSON.stringify(uploadData));

    if (!uploadInit.ok || !uploadData.runwayUri) {
      console.error("Runway upload init failed:", JSON.stringify(uploadData));
      return res.status(500).json({ error: "Upload init failed.", detail: JSON.stringify(uploadData) });
    }

    // Step 2: Upload the image
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

    // Step 3: Submit video job
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
        model: "gen4_turbo",
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
      return res.status(500).json({ error: "Video failed.", detail: JSON.stringify(data) });
    }
    res.json({ ok: true, video: { id: data.id } });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ error: "Video failed.", detail: error.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: { Authorization: "Bearer " + process.env.RUNWAY_API_KEY, "X-Runway-Version": "2024-11-06" },
    });
    const data = await r.json();
    const status = data.status === "SUCCEEDED" ? "completed" : data.status === "FAILED" ? "failed" : "in_progress";
    res.json({ ok: true, video: { status } });
  } catch (error) {
    res.status(500).json({ error: "Status failed." });
  }
});

app.get("/api/video/:id/url", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: { Authorization: "Bearer " + process.env.RUNWAY_API_KEY, "X-Runway-Version": "2024-11-06" },
    });
    const data = await r.json();
    const url = data.output && data.output[0] ? data.output[0] : null;
    if (!url) return res.status(404).json({ error: "No video URL yet." });
    res.json({ ok: true, url });
  } catch (error) {
    res.status(500).json({ error: "URL fetch failed." });
  }
});

app.get("/api/video/:id/content", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: { Authorization: "Bearer " + process.env.RUNWAY_API_KEY, "X-Runway-Version": "2024-11-06" },
    });
    const data = await r.json();
    const url = data.output && data.output[0] ? data.output[0] : null;
    if (!url) return res.status(404).json({ error: "No video URL yet." });
    return res.redirect(302, url);
  } catch (error) {
    res.status(500).json({ error: "Content failed." });
  }
});

const SELF_URL = "https://monocular-server.onrender.com/health";
setInterval(function () {
  fetch(SELF_URL).then(function () {}).catch(function () {});
}, 600000);

app.listen(PORT, () => {
  console.log("Monocular server running on port " + PORT);
  console.log("Architectural Director brain active.");
});
