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

const ARCHITECTURAL_DIRECTOR = `
You are the Architectural Director brain for an app called thedoss.

Your job is to refine user render requests before image or video generation.

Rules:
- Preserve the uploaded drawing/model/building unless the user clearly asks to change it.
- Do not invent major design changes.
- Improve realism, materials, lighting, context and camera.
- Keep architecture believable and buildable.
- If the request is vague, make a professional architectural assumption.
- If a user asks for a wild style, keep the building geometry controlled.
- Never let the render go rogue.

Return ONLY valid JSON with this exact structure:

{
  "mode": "image",
  "cleanPrompt": "",
  "negativePrompt": "",
  "camera": "",
  "materials": "",
  "siteContext": "",
  "lighting": "",
  "mustPreserve": [],
  "warnings": []
}
`;

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
      text: `
User request:
${userPrompt}

Requested mode:
${renderMode}

Current project memory:
${JSON.stringify(projectMemory, null, 2)}

Create a strict architectural render brief.
`
    }
  ];

  if (uploadedImageBase64) {
    content.push({
      type: "input_image",
      image_url: uploadedImageBase64.startsWith("data:")
        ? uploadedImageBase64
        : `data:image/png;base64,${uploadedImageBase64}`
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
  return `
ARCHITECTURAL RENDER BRIEF

${brief.cleanPrompt}

Camera:
${brief.camera}

Materials:
${brief.materials}

Site context:
${brief.siteContext}

Lighting:
${brief.lighting}

Must preserve:
${brief.mustPreserve?.map(x => `- ${x}`).join("\n")}

Avoid:
${brief.negativePrompt}

Global quality rules:
Photorealistic architectural visualisation.
Believable scale.
Realistic shadows.
Correct perspective.
No warped geometry.
No random extra doors or windows.
No fantasy elements unless explicitly requested.
Preserve the supplied design intent.
`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "thedoss server",
    brain: "Architectural Director active"
  });
});

app.post("/api/memory", (req, res) => {
  projectMemory = {
    ...projectMemory,
    ...req.body
  };

  res.json({
    ok: true,
    projectMemory
  });
});

app.get("/api/memory", (req, res) => {
  res.json({
    ok: true,
    projectMemory
  });
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

    res.json({
      ok: true,
      brief
    });
  } catch (error) {
    console.error("Brain error:", error);
    res.status(500).json({
      error: "Brain failed.",
      detail: error.message
    });
  }
});

app.post("/api/render", async (req, res) => {
  try {
    const { prompt, imageBase64 } = req.body;

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
                    : `data:image/png;base64,${imageBase64}`
                }]
              : [])
          ]
        }
      ],
      tools: [{ type: "image_generation" }]
    });

    const imageCall = response.output.find(
      item => item.type === "image_generation_call"
    );

    res.json({
      ok: true,
      brief,
      imageBase64: imageCall?.result || null
    });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({
      error: "Render failed.",
      detail: error.message
    });
  }
});

app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: "video",
      uploadedImageBase64: imageBase64
    });

    const videoPrompt = `
Create an architectural video for thedoss.

Scene:
${brief.cleanPrompt}

Camera:
Slow cinematic architectural dolly/orbit.
Stable lens.
No warping.
No melting.
No changing the building shape.

Materials:
${brief.materials}

Site:
${brief.siteContext}

Lighting:
${brief.lighting}

Must preserve:
${brief.mustPreserve?.map(x => `- ${x}`).join("\n")}

Avoid:
${brief.negativePrompt}
`;

    const video = await openai.videos.create({
      model: "sora-2",
      prompt: videoPrompt,
      size: "1280x720",
      seconds: "8"
    });

    res.json({
      ok: true,
      brief,
      video
    });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({
      error: "Video failed.",
      detail: error.message
    });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const video = await openai.videos.retrieve(req.params.id);

    res.json({
      ok: true,
      video
    });
  } catch (error) {
    console.error("Video status error:", error);
    res.status(500).json({
      error: "Could not get video status.",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`thedoss server running on port ${PORT}`);
  console.log("Architectural Director brain active.");
});npm start
<link rel="icon" href="/favicon.ico" />

<link rel="apple-touch-icon" href="/apple-touch-icon.png" />

<link rel="manifest" href="/site.webmanifest" />

<meta name="theme-color" content="#000000" />