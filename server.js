import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OPENAI_API_KEY;

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

async function createRender(prompt = "") {
  if (!API_KEY) {
    throw new Error("Missing OpenAI API key");
  }

  const finalPrompt = `
Create a realistic architectural render.

User brief:
${prompt || "A refined modern architectural house with natural light."}

Rules:
- realistic architectural visualisation
- natural light
- believable materials
- no cartoon style
- no text or labels
- no fantasy shapes
- clean professional presentation
`;

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt: finalPrompt,
    size: "1024x1024",
  });

  const imageBase64 = response.data?.[0]?.b64_json;

  if (!imageBase64) {
    throw new Error("No image returned from OpenAI");
  }

  return imageBase64;
}

app.post("/render", async (req, res) => {
  try {
    const { prompt = "" } = req.body || {};
    const imageBase64 = await createRender(prompt);

    res.json({
      ok: true,
      image: `data:image/png;base64,${imageBase64}`,
      imageBase64,
    });
  } catch (error) {
    console.error("Render error:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Render failed",
    });
  }
});

app.post("/api/render", async (req, res) => {
  try {
    const { prompt = "" } = req.body || {};
    const imageBase64 = await createRender(prompt);

    res.json({
      ok: true,
      image: `data:image/png;base64,${imageBase64}`,
      imageBase64,
    });
  } catch (error) {
    console.error("API render error:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Render failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`MONOCULAR server running on port ${PORT}`);
});