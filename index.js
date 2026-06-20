import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;

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

async function buildBrain({ userPrompt, renderMode = "image", uploadedImageBase64 }) {
  const content = [
    {
      type: "input_text",
      text: "User request:\n" + userPrompt + "\n\nRequested mode:\n" + renderMode + "\n\nCurrent project memory:\n" + JSON.stringify(projectMemory, null, 2) + "\n\nCreate a strict architectural render brief."
    }
  ];

  if (uploadedImageBase64) {
    content.push({
      type: "input_image",
      image_url: uploadedImageBase64.startsWith("data:")
        ? uploadedImageBase64
        : "data:image/png;base64," + uploadedImageBase64
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
    const { prompt, imageBase64, quality, size } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: "image",
      uploadedImageBase64: imageBase64
    });

    const finalPrompt = buildFinalImagePrompt(brief);

    const response = await openai.responses.create({
      model: "gpt-5.5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: finalPrompt },
            ...(imageBase64
              ? [{
                  type: "input_image",
                  image_url: imageBase64.startsWith("data:")
                    ? imageBase64
                    : "data:image/png;base64," + imageBase64
                }]
              : [])
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          quality: quality || "high",
          size: size || "1536x1024"
        }
      ]
    });

    const imageCall = response.output.find(function(item) {
      return item.type === "image_generation_call";
    });

    res.json({ ok: true, brief, imageBase64: imageCall ? imageCall.result : null });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({ error: "Render failed.", detail: error.message });
  }
});

app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, seconds, size } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: "video",
      uploadedImageBase64: imageBase64
    });

    const preserveList = (brief.mustPreserve || []).map(function(x) { return "- " + x; }).join("\n");

    const videoPrompt = "Create an architectural video for thedoss.\n\nScene:\n" + brief.cleanPrompt + "\n\nCamera:\nSlow cinematic architectural dolly/orbit.\nStable lens.\nNo warping.\nNo melting.\nNo changing the building shape.\n\nMaterials:\n" + brief.materials + "\n\nSite:\n" + brief.siteContext + "\n\nLighting:\n" + brief.lighting + "\n\nMust preserve:\n" + preserveList + "\n\nAvoid:\n" + brief.negativePrompt;

    const form = new FormData();
    form.append("model", "sora-2");
    form.append("prompt", videoPrompt);
    form.append("size", size || "1280x720");
    form.append("seconds", seconds || "8");

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

app.listen(PORT, () => {
  console.log("thedoss server running on port " + PORT);
  console.log("Architectural Director brain active.");
});
