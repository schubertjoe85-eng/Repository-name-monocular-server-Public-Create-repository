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
MONOCULAR ARCHITECTURAL MODE

PRIMARY RULE:
The uploaded image is the design authority.
Do not redesign the building.

Preserve:
- massing
- proportions
- roof form
- window positions
- door positions
- facade composition
- floor count
- main geometry
- original architectural intent

You may improve:
- realistic materials
- natural lighting
- shadows
- landscaping
- sky and atmosphere
- render quality
- professional architectural presentation

Do not:
- invent a different building
- add extra floors
- change the roof
- move windows or doors
- create fantasy shapes
- turn it into a cartoon
- ignore the source image

The output must look like the uploaded project rendered by a professional architectural visualiser.

If uncertain, preserve the original geometry.

User instructions:
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

    if (!imageBase64) {
      return res.status(400).json({
        ok: false,
        error: "No source image supplied",
      });
    }

    const finalPrompt = buildMonocularPrompt(prompt);

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