const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 4242;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://monocular-frontend.vercel.app";

app.use(cors({
  origin: "*",
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
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "monocular-server",
    message: "Backend running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "monocular-server",
    status: "healthy"
  });
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId } = req.body;

    if (!priceId) {
      return res.status(400).json({
        ok: false,
        error: "Missing Stripe priceId"
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],

      success_url: `${FRONTEND_URL}/?paid=true`,
      cancel_url: `${FRONTEND_URL}/?cancelled=true`
    });

    res.json({
      ok: true,
      url: session.url
    });

  } catch (error) {
    console.error("Stripe error:", error);

    res.status(500).json({
      ok: false,
      error: "Stripe checkout failed",
      details: error.message
    });
  }
});

app.post("/render", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No image uploaded"
      });
    }

    // TEMP render response.
    // This confirms payment -> frontend -> backend upload works.
    res.json({
      ok: true,
      message: "Image received by backend. Render engine ready to connect.",
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error("Render error:", error);

    res.status(500).json({
      ok: false,
      error: "Render failed",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`MONOCULAR backend running on port ${PORT}`);
});