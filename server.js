require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Database = require("better-sqlite3");
const Stripe = require("stripe");
const OpenAI = require("openai");
const ffmpeg = require("fluent-ffmpeg");

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const upload = multer({ dest: "uploads/" });
const db = new Database("operator.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  credits INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS renders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  image_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  movie_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

app.use(cors());
app.use("/renders", express.static(path.join(__dirname, "public/renders")));
app.use("/movies", express.static(path.join(__dirname, "public/movies")));
app.use(express.static("public"));

/*
========================
STRIPE WEBHOOK
========================
*/

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.metadata.userId;
      const plan = session.metadata.plan;
      const credits = Number(session.metadata.credits || 0);

      const existing = db
        .prepare("SELECT * FROM payments WHERE session_id = ?")
        .get(session.id);

      if (!existing && userId && credits > 0) {
        db.prepare(`
          INSERT OR IGNORE INTO users (id, credits)
          VALUES (?, 0)
        `).run(userId);

        db.prepare(`
          INSERT INTO payments (session_id, user_id, plan, credits)
          VALUES (?, ?, ?, ?)
        `).run(session.id, userId, plan, credits);

        db.prepare(`
          UPDATE users
          SET credits = credits + ?
          WHERE id = ?
        `).run(credits, userId);

        console.log(`Added ${credits} credits to ${userId}`);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json({ limit: "10mb" }));

/*
========================
HELPERS
========================
*/

function deleteFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function ensureUser(userId) {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, credits)
    VALUES (?, 0)
  `).run(userId);

  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function getModeInstruction(mode) {
  if (mode === "materials") {
    return `
MODE: MATERIALS ONLY.

Keep the building geometry almost exactly the same.

Only improve:
- materials
- realism
- lighting
- landscaping
- shadows
- sky
- presentation quality

Do NOT redesign the architecture.
`;
  }

  if (mode === "concept") {
    return `
MODE: CONCEPT UPGRADE.

You may slightly improve facade articulation and architectural character,
but the building must still clearly match the uploaded image.
`;
  }

  return `
MODE: SAFE RENDER.

Preserve the design closely.
Do not redesign the building.
Improve realism only.
`;
}

function buildArchitecturalPrompt(prompt, mode, movieInstruction = "") {
  return `
You are a professional architectural visualisation renderer.

${getModeInstruction(mode)}

${movieInstruction}

CRITICAL RULES:
- The uploaded image is the source of truth.
- Preserve the original building form.
- Preserve roof shape.
- Preserve window locations.
- Preserve door locations.
- Preserve proportions.
- Preserve facade rhythm.
- Preserve layout and geometry.
- Do NOT invent a different building.
- Do NOT add extra storeys.
- Do NOT create fantasy architecture.
- Do NOT dramatically redesign the project.
- The result must still look recognisably like the uploaded design.

WHAT YOU MAY IMPROVE:
- realism
- textures
- materials
- lighting
- shadows
- atmosphere
- landscaping
- rendering quality
- camera quality

STYLE:
- realistic architectural visualisation
- premium architecture magazine quality
- believable construction
- natural materials
- Australian architectural aesthetic
- professional client presentation

USER REQUEST:
${prompt}

FINAL OUTPUT:
Create a realistic architectural render that looks recognisably like the uploaded design, only improved and professionally visualised.
`;
}

async function generateImage(prompt, outputPath) {
  const result = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024"
  });

  const base64 = result.data[0].b64_json;

  fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
}

function createMovieFromFrames(frameDir, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(frameDir, "frame-%03d.png"))
      .inputFPS(1.5)
      .outputFPS(24)
      .videoCodec("libx264")
      .outputOptions([
        "-pix_fmt yuv420p",
        "-movflags +faststart"
      ])
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

/*
========================
HEALTH
========================
*/

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/*
========================
USER
========================
*/

app.post("/api/user", (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  const user = ensureUser(userId);

  res.json({
    userId: user.id,
    credits: user.credits
  });
});

/*
========================
STRIPE CHECKOUT
========================
*/

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { userId, plan } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    let priceId;
    let credits;

    if (plan === "starter") {
      priceId = process.env.PRICE_2;
      credits = 1;
    } else if (plan === "pro") {
      priceId = process.env.PRICE_29;
      credits = 20;
    } else {
      return res.status(400).json({ error: "Invalid plan" });
    }

    ensureUser(userId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/?paid=1`,
      cancel_url: `${BASE_URL}/?cancelled=1`,
      metadata: {
        userId,
        plan,
        credits: String(credits)
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout session failed" });
  }
});

/*
========================
NORMAL IMAGE RENDER
COST: 1 CREDIT
========================
*/

app.post("/api/render", upload.single("image"), async (req, res) => {
  const { userId, prompt, mode } = req.body;
  const file = req.file;

  if (!userId || !prompt || !file) {
    deleteFile(file?.path);
    return res.status(400).json({
      error: "Missing image, prompt or userId"
    });
  }

  const user = ensureUser(userId);

  if (!user || user.credits < 1) {
    deleteFile(file.path);
    return res.status(402).json({
      error: "Payment required",
      message: "Buy credits before rendering."
    });
  }

  try {
    db.prepare(`
      UPDATE users
      SET credits = credits - 1
      WHERE id = ?
      AND credits > 0
    `).run(userId);

    fs.mkdirSync(path.join(__dirname, "public/renders"), {
      recursive: true
    });

    const filename = `render-${Date.now()}.png`;
    const outputPath = path.join(__dirname, "public/renders", filename);

    const fullPrompt = buildArchitecturalPrompt(prompt, mode);

    await generateImage(fullPrompt, outputPath);

    const imageUrl = `/renders/${filename}`;

    db.prepare(`
      INSERT INTO renders (user_id, prompt, image_url)
      VALUES (?, ?, ?)
    `).run(userId, prompt, imageUrl);

    deleteFile(file.path);

    const updated = db
      .prepare("SELECT credits FROM users WHERE id = ?")
      .get(userId);

    res.json({
      ok: true,
      imageUrl,
      credits: updated.credits
    });
  } catch (err) {
    console.error("Render error:", err);

    db.prepare(`
      UPDATE users
      SET credits = credits + 1
      WHERE id = ?
    `).run(userId);

    deleteFile(file.path);

    res.status(500).json({
      error: "Render failed. Credit refunded."
    });
  }
});

/*
========================
MOVIE RENDER
COST: 5 CREDITS
========================
*/

app.post("/api/movie", upload.single("image"), async (req, res) => {
  const { userId, prompt, mode, movieStyle } = req.body;
  const file = req.file;

  const MOVIE_COST = 5;
  const FRAME_COUNT = 8;

  if (!userId || !prompt || !file) {
    deleteFile(file?.path);
    return res.status(400).json({
      error: "Missing image, prompt or userId"
    });
  }

  const user = ensureUser(userId);

  if (!user || user.credits < MOVIE_COST) {
    deleteFile(file.path);
    return res.status(402).json({
      error: "Payment required",
      message: `Movie rendering requires ${MOVIE_COST} credits.`
    });
  }

  const movieId = Date.now();
  const frameDir = path.join(__dirname, "public/movies", `movie-${movieId}-frames`);
  const movieFilename = `movie-${movieId}.mp4`;
  const movieOutputPath = path.join(__dirname, "public/movies", movieFilename);

  try {
    db.prepare(`
      UPDATE users
      SET credits = credits - ?
      WHERE id = ?
      AND credits >= ?
    `).run(MOVIE_COST, userId, MOVIE_COST);

    fs.mkdirSync(frameDir, { recursive: true });
    fs.mkdirSync(path.join(__dirname, "public/movies"), { recursive: true });

    let motion = "slow cinematic dolly forward";

    if (movieStyle === "orbit") {
      motion = "slow architectural orbit around the front corner";
    }

    if (movieStyle === "zoom") {
      motion = "slow cinematic zoom toward the building facade";
    }

    if (movieStyle === "walkthrough") {
      motion = "slow approach as if walking toward the building entry";
    }

    for (let i = 0; i < FRAME_COUNT; i++) {
      const progress = i + 1;

      const movieInstruction = `
MOVIE FRAME INSTRUCTION:
This is frame ${progress} of ${FRAME_COUNT} in a short architectural movie.
The motion should feel like: ${motion}.
Keep the building consistent across every frame.
Do not change the design between frames.
Only shift the camera slightly.
Make the sequence smooth and coherent.
`;

      const framePrompt = buildArchitecturalPrompt(prompt, mode, movieInstruction);

      const framePath = path.join(
        frameDir,
        `frame-${String(i + 1).padStart(3, "0")}.png`
      );

      await generateImage(framePrompt, framePath);
    }

    await createMovieFromFrames(frameDir, movieOutputPath);

    const movieUrl = `/movies/${movieFilename}`;

    db.prepare(`
      INSERT INTO movies (user_id, prompt, movie_url)
      VALUES (?, ?, ?)
    `).run(userId, prompt, movieUrl);

    deleteFile(file.path);

    const updated = db
      .prepare("SELECT credits FROM users WHERE id = ?")
      .get(userId);

    res.json({
      ok: true,
      movieUrl,
      credits: updated.credits
    });
  } catch (err) {
    console.error("Movie error:", err);

    db.prepare(`
      UPDATE users
      SET credits = credits + ?
      WHERE id = ?
    `).run(MOVIE_COST, userId);

    deleteFile(file.path);

    res.status(500).json({
      error: "Movie failed. Credits refunded."
    });
  }
});

/*
========================
GALLERY
========================
*/

app.get("/api/gallery", (req, res) => {
  const renders = db.prepare(`
    SELECT image_url, prompt, created_at
    FROM renders
    ORDER BY created_at DESC
    LIMIT 12
  `).all();

  res.json(renders);
});

/*
========================
MOVIE GALLERY
========================
*/

app.get("/api/movies", (req, res) => {
  const movies = db.prepare(`
    SELECT movie_url, prompt, created_at
    FROM movies
    ORDER BY created_at DESC
    LIMIT 12
  `).all();

  res.json(movies);
});

/*
========================
START SERVER
========================
*/

app.listen(PORT, () => {
  console.log(`OPERATOR running on ${BASE_URL}`);
});