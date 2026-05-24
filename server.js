const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: [
    "https://monocular-frontend.vercel.app",
    "https://monocular-frontend-xskd.vercel.app",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "monocular-server",
    message: "Backend is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "monocular-server",
    status: "healthy"
  });
});

// Render endpoint
app.post("/render", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No image uploaded"
      });
    }

    // TEMP TEST RESPONSE
    // This proves frontend -> backend upload is working.
    // AI rendering can be connected after this works.
    return res.json({
      ok: true,
      message: "Image received by backend",
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error("Render error:", error);

    return res.status(500).json({
      ok: false,
      error: "Render failed",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`MONOCULAR backend running on port ${PORT}`);
});