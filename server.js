import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import OpenAI, { toFile } from "openai";
import Stripe from "stripe";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "120mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "https://monocular-opal.vercel.app";
const USERS_FILE = "./users.json";

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUser(userId) {
  const users = readUsers();
  return users[userId] || null;
}

function saveUser(userId, data) {
  const users = readUsers();
  users[userId] = data;
  writeUsers(users);
}

function hasAccess(user) {
  if (!user) return false;
  if (user.subscriptionActive) return true;
  if (user.trialEndsAt && Date.now() < user.trialEndsAt) return true;
  return false;
}

async function dataUrlToFile(dataUrl) {
  const match = String(dataUrl).match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error("Invalid uploaded image");

  const buffer = Buffer.from(match[2], "base64");
  return toFile(buffer, "monocular-upload.png", { type: match[1] });
}

app.get("/", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/status", (req, res) => {
  const { userId } = req.body;
  const user = getUser(userId);

  res.json({
    hasAccess: hasAccess(user),
    trialEndsAt: user?.trialEndsAt || null,
    subscriptionActive: !!user?.subscriptionActive,
  });
});

app.post("/start-trial", (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const existing = getUser(userId);

  if (existing?.trialStarted) {
    return res.json({
      success: true,
      trialEndsAt: existing.trialEndsAt,
      alreadyStarted: true,
    });
  }

  const trialEndsAt = Date.now() + 3 * 24 * 60 * 60 * 1000;

  saveUser(userId, {
    trialStarted: true,
    trialEndsAt,
    subscriptionActive: false,
  });

  res.json({ success: true, trialEndsAt });
});

app.post("/create-subscription", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: process.env.STRIPE_MONTHLY_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: { userId },
      success_url: `${FRONTEND_URL}?subscribed=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: FRONTEND_URL,
    });

    res.json({ url: checkout.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/verify-subscription", async (req, res) => {
  try {
    const { userId, sessionId } = req.body;

    if (!userId || !sessionId) {
      return res.status(400).json({ error: "Missing userId or sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Subscription payment not complete" });
    }

    const existing = getUser(userId) || {};

    saveUser(userId, {
      ...existing,
      subscriptionActive: true,
    });

    res.json({ success: true, subscriptionActive: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/render", async (req, res) => {
  try {
    const { userId, selectedImage, prompt } = req.body;

    const user = getUser(userId);

    if (!hasAccess(user)) {
      return res.status(403).json({
        error: "Start your 3-day free trial or subscribe to render.",
      });
    }

    if (!selectedImage) {
      return res.status(400).json({ error: "Upload an image first." });
    }

    const imageFile = await dataUrlToFile(selectedImage);

    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: imageFile,
      prompt:
        prompt ||
        "Create a realistic architectural render from this uploaded drawing. Preserve the building form, roof, windows, doors, and camera angle.",
      size: "1024x1024",
    });

    const base64 = result.data?.[0]?.b64_json;

    if (!base64) {
      return res.status(500).json({ error: "OpenAI returned no image." });
    }

    res.json({
      success: true,
      image: `data:image/png;base64,${base64}`,
    });
  } catch (err) {
    console.error("RENDER ERROR:", err);
    res.status(500).json({ error: err.message || "Render failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MONOCULAR server running on port ${PORT}`);
});