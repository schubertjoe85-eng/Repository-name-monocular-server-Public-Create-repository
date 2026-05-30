import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI, { toFile } from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OPENAI_API_KEY;
console.log("OPENAI KEY FOUND:", !!API_KEY);
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({
  apiKey: API_KEY,
});

app.get("/", (req, res) => {
  res.send("MONOCULAR SERVER LIVE");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "alive",
    time: new Date().toISOString(),
  });
});

function dataUrlToBuffer(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return Buffer.from(base64, "base64");
}

function buildPrompt(prompt = "") {
  return `
Create a realistic architectural render from the uploaded image.

User brief:
${prompt || "Refined architectural render with natural light."}

Rules:
- preserve the original building geometry
- preserve roof forms, proportions, openings and layout
- improve materials, light, landscape and atmosphere
- keep it realistic and buildable
- avoid fantasy shapes
- avoid random extra buildings
- avoid text, labels, signs or logos in the image
- make it feel like a grounded architectural visualisation
`;
}

async function handleRender(req, res) {
  console.log("🔥 RENDER HIT");
  console.log("BODY KEYS:", Object.keys(req.body || {}));

  try {
    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing OpenAI API key",
      });
    }

    const prompt = req.body?.prompt || "";
    const imageBase64 = req.body?.imageBase64 || req.body?.image || "";

    if (!imageBase64) {
      return res.status(400).json({
        ok: false,
        error: "No image supplied",
      });
    }

    const imageBuffer = dataUrlToBuffer(imageBase64);

    const imageFile = await toFile(imageBuffer, "input.png", {
      type: "image/png",
    });

    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: imageFile,
      prompt: buildPrompt(prompt),
      size: "1024x1024",
    });

    const output = result.data?.[0]?.b64_json;

    if (!output) {
      return res.status(500).json({
        ok: false,
        error: "No image returned from OpenAI",
      });
    }

    return res.json({
      ok: true,
      imageBase64: output,
      image: `data:image/png;base64,${output}`,
    });
  } catch (error) {
    console.error("🔥 Render error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Render failed",
    });
  }
}

app.post("/api/render", handleRender);
app.post("/render", handleRender);

app.post("/api/brain", async (req, res) => {
  return res.json({
    ok: true,
    analysis:
      "Monocular has received the drawing/image. The render should preserve the original building geometry, improve materiality, lighting, landscape context and realism, and avoid fantasy forms or random additions.",
  });
});

app.listen(PORT, () => {
  console.log(`MONOCULAR server running on port ${PORT}`);
});