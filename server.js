const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const { OpenAI } = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================================
   OPENAI
========================================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================================
   HEALTH ROUTES
========================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Monocular server is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
});

/* =========================================
   FILE UPLOADS
========================================= */

const upload = multer({
  dest: "uploads/"
});

/* =========================================
   AI RENDER ROUTE
========================================= */

app.post("/render", upload.single("image"), async (req, res) => {
  try {

    const prompt = req.body.prompt;

    if (!req.file) {
      return res.status(400).json({
        error: "No image uploaded"
      });
    }

    const imagePath = req.file.path;

    const imageBuffer = fs.readFileSync(imagePath);

    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: imageBuffer,
      prompt: prompt,
      size: "1024x1024"
    });

    fs.unlinkSync(imagePath);

    if (!response.data || !response.data[0]) {
      return res.status(500).json({
        error: "No image returned from OpenAI"
      });
    }

    res.json({
      image: response.data[0].b64_json
    });

  } catch (err) {

    console.log("OPENAI ERROR:", err);

    res.status(500).json({
      error: err.message || "Render failed"
    });
  }
});

/* =========================================
   START SERVER
========================================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});