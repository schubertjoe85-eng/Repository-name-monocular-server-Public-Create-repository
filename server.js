import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildPrompt(userPrompt, mode) {
  const base = `
You are Monocular, an architectural visualisation tool.

The uploaded image is the source design. Keep the building recognisable.
Do not invent a different building.

Preserve:
- overall massing
- roof form
- floor count
- window and door positions
- main proportions
- facade rhythm

Improve:
- materials
- lighting
- shadows
- landscape
- sky
- realism
- presentation quality

Do not add text, labels, extra storeys, fantasy forms, or random buildings.
`;

  if (mode === "elevation") {
    return `${base}

MODE: ELEVATION
Create a clean architectural elevation.
Use an orthographic front-facing view.
No perspective distortion.
Keep the building geometry as close as possible.

User brief:
${userPrompt || "Create a clean architectural elevation."}`;
  }

  if (mode === "site") {
    return `${base}

MODE: SITE PLACEMENT
Place this building into the requested location.
Keep the building itself unchanged.
Only adapt landscape, light, vegetation, sky and ground conditions.

User brief:
${userPrompt || "Place this building into a realistic site context."}`;
  }

  return `${base}

MODE: REALISTIC RENDER
Create a realistic architectural render.
Keep the building geometry close to the source.
Improve the visualisation without redesigning it.

User brief:
${userPrompt || "Create a realistic architectural render."}`;
}

app.get("/", (req, res) => {
  res.json({ ok: true, name: "Monocular Server", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/render", async (req, res) => {
  try {
    const { prompt, imageBase64, mode = "render" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({
        ok: false,
        error: "Upload an image first.",
      });
    }

    const finalPrompt = buildPrompt(prompt, mode);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    const imageFile = await OpenAI.toFile(imageBuffer, "source.png", {
      type: "image/png",
    });

    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: imageFile,
      prompt: finalPrompt,
      size: "1024x1024",
    });

    const imageBase64Out = response?.data?.[0]?.b64_json;

    if (!imageBase64Out) {
      return res.status(500).json({
        ok: false,
        error: "No image returned from OpenAI.",
      });
    }

    return res.json({
      ok: true,
      image: `data:image/png;base64,${imageBase64Out}`,
    });
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Render failed.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Monocular server running on port ${PORT}`);
});