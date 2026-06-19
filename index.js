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
Ultra photorealistic architectural visualisation, magazine quality.
Believable scale and correct one-point/two-point perspective.
Sharp focus on the building, natural depth of field in the background.
Physically accurate shadows, ambient occlusion, and reflections.
High dynamic range lighting (no blown-out sky, no crushed shadows).
Crisp, high-resolution material textures (timber grain, render, glass, stone).
No warped geometry, no melted edges, no duplicated structural elements.
No random extra doors or windows.
No fantasy elements unless explicitly requested.
Preserve the supplied design intent exactly.
`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "thedoss server",
    brain: "Architectural Director active"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
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

    const brief = await

