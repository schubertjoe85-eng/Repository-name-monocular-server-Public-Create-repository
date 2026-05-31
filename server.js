import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function buildMonocularPrompt(userPrompt) {
  return `
You are Monocular, a strict architectural rendering engine.

Your task is to create a realistic architectural visualisation.

You must improve the image without redesigning the project.

Hard rules:
- Preserve the uploaded building geometry.
- Preserve roof shape, wall positions, proportions and massing.
- Preserve window and door locations where visible.
- Do not add extra floors.
- Do not invent random buildings.
- Do not create fantasy shapes.
- Do not turn the image into a cartoon, painting or abstract artwork.
- Do not ignore the uploaded image.
- Do not change the design language unless the user specifically asks.
- Keep the result realistic, professional, buildable and suitable for a client presentation.

Allowed improvements:
- Better materials.
- Better light.
- Better shadows.
- Better landscaping.
- Better sky and atmosphere.
- Better architectural presentation.
- Cleaner realism.
- More refined rendering quality.

If the uploaded image is a sketch, read it as an architectural sketch.
If the uploaded image is a model/photo, preserve it as the design source.

User brief:
${userPrompt || "Create a realistic architectural render from the uploaded image."}
`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Monocular Server",
    status: "running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
  });
});

app.post("/render", async (req, res) => {
  try {
    const { prompt, imageBase64 } = req.body || {};

    const finalPrompt = buildMonocularPrompt(prompt);

    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: finalPrompt,
      size: "1024x1024",
    });

    const imageBase64Out = response?.data?.[0]?.b64_json;

    if (!imageBase64Out) {
      return res.status(500).json({
        ok: false,
        error: "No image returned from OpenAI",
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
      error: error.message || "Render failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Monocular server running on port ${PORT}`);
});