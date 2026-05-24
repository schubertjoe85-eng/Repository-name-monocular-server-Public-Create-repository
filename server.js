import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import OpenAI, { toFile } from 'openai';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '120mb' }));

const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://monocular-opal.vercel.app';

const CREDIT_FILE = './credits.json';
const OWNER_TEST_CODE = 'MONOCULAR-OWNER-TEST';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function readCredits() {
  try {
    if (!fs.existsSync(CREDIT_FILE)) return {};
    return JSON.parse(fs.readFileSync(CREDIT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCredits(data) {
  fs.writeFileSync(CREDIT_FILE, JSON.stringify(data, null, 2));
}

function getCredits(sessionId) {
  if (!sessionId) return 0;
  const data = readCredits();
  return data[sessionId]?.credits || 0;
}

function addCredits(sessionId, amount) {
  const data = readCredits();

  if (!data[sessionId]) {
    data[sessionId] = {
      credits: 0,
      usedStripeSessions: [],
    };
  }

  data[sessionId].credits += amount;
  writeCredits(data);

  return data[sessionId].credits;
}

function deductCredit(sessionId) {
  const data = readCredits();

  if (!data[sessionId] || data[sessionId].credits <= 0) {
    return false;
  }

  data[sessionId].credits -= 1;
  writeCredits(data);

  return true;
}

function hasUsedStripeSession(sessionId, stripeSessionId) {
  const data = readCredits();
  return data[sessionId]?.usedStripeSessions?.includes(stripeSessionId);
}

function markStripeSessionUsed(sessionId, stripeSessionId) {
  const data = readCredits();

  if (!data[sessionId]) {
    data[sessionId] = {
      credits: 0,
      usedStripeSessions: [],
    };
  }

  if (!data[sessionId].usedStripeSessions.includes(stripeSessionId)) {
    data[sessionId].usedStripeSessions.push(stripeSessionId);
  }

  writeCredits(data);
}

async function dataUrlToFile(dataUrl, fileName = 'monocular-input.png') {
  const match = String(dataUrl).match(/^data:(.+);base64,(.+)$/);

  if (!match) {
    throw new Error('Invalid uploaded image format.');
  }

  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  return toFile(buffer, fileName, {
    type: mimeType,
  });
}

function buildPrompt(prompt = '', fileName = '') {
  return `
You are MONOCULAR, a restrained architectural AI rendering engine.

Create a realistic architectural render from the uploaded drawing/image.

Preserve:
- the same building
- the same massing
- the same roof form
- the same walls
- the same window and door locations
- the same camera angle
- the same architectural intent

Improve:
- realism
- material quality
- natural lighting
- shadows
- landscape
- atmosphere
- presentation quality

Do not:
- redesign the building
- invent extra floors
- move doors or windows
- change the roof shape
- create fantasy architecture

User instructions:
${prompt || 'Create a realistic architectural render while preserving the design.'}

Source file:
${fileName || 'uploaded image'}
`;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    service: 'MONOCULAR server',
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
  });
});

app.get('/credits', (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Missing sessionId.',
      credits: 0,
    });
  }

  return res.json({
    success: true,
    credits: getCredits(String(sessionId)),
  });
});

app.get('/buy', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).send('STRIPE_SECRET_KEY missing on server.');
    }

    const { pack, sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).send('Missing sessionId.');
    }

    let priceId = '';
    let credits = 0;

    if (String(pack) === '1') {
      priceId = process.env.STRIPE_PRICE_1 || '';
      credits = 1;
    }

    if (String(pack) === '30') {
      priceId = process.env.STRIPE_PRICE_30 || '';
      credits = 30;
    }

    if (!priceId || credits === 0) {
      return res.status(500).send('Stripe price ID missing or invalid pack.');
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        monocularSessionId: String(sessionId),
        credits: String(credits),
      },
      success_url: `${FRONTEND_URL}?paid=true&stripe_session_id={CHECKOUT_SESSION_ID}&sessionId=${encodeURIComponent(
        String(sessionId)
      )}`,
      cancel_url: `${FRONTEND_URL}?cancelled=true`,
    });

    return res.redirect(303, checkout.url);
  } catch (error) {
    console.error('BUY ERROR:', error);

    return res.status(500).send(error.message || 'Stripe checkout failed.');
  }
});

app.get('/verify-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        success: false,
        error: 'STRIPE_SECRET_KEY missing on server.',
      });
    }

    const { stripe_session_id, sessionId } = req.query;

    if (!stripe_session_id || !sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing stripe_session_id or sessionId.',
      });
    }

    const localSessionId = String(sessionId);
    const stripeSessionId = String(stripe_session_id);

    if (hasUsedStripeSession(localSessionId, stripeSessionId)) {
      return res.json({
        success: true,
        credits: getCredits(localSessionId),
        message: 'Stripe session already verified.',
      });
    }

    const checkout = await stripe.checkout.sessions.retrieve(stripeSessionId);

    if (checkout.payment_status !== 'paid') {
      return res.status(402).json({
        success: false,
        error: 'Payment not completed.',
      });
    }

    const checkoutSessionId =
      checkout.metadata?.monocularSessionId || localSessionId;

    const creditsToAdd = Number(checkout.metadata?.credits || 0);

    if (!creditsToAdd) {
      return res.status(400).json({
        success: false,
        error: 'No credits found in Stripe session metadata.',
      });
    }

    addCredits(checkoutSessionId, creditsToAdd);
    markStripeSessionUsed(checkoutSessionId, stripeSessionId);

    return res.json({
      success: true,
      credits: getCredits(checkoutSessionId),
    });
  } catch (error) {
    console.error('VERIFY ERROR:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Payment verification failed.',
    });
  }
});

app.post('/render', async (req, res) => {
  try {
    const { selectedImage, prompt, fileName, sessionId } = req.body;
    const ownerCode = req.headers['x-monocular-access'];

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OPENAI_API_KEY missing on server.',
      });
    }

    if (!selectedImage) {
      return res.status(400).json({
        success: false,
        error: 'No uploaded image received.',
      });
    }

    if (!sessionId && ownerCode !== OWNER_TEST_CODE) {
      return res.status(401).json({
        success: false,
        error: 'No session found. Buy credits first.',
      });
    }

    const credits = getCredits(String(sessionId || 'owner'));

    const isOwnerTest = ownerCode === OWNER_TEST_CODE;

    if (credits <= 0 && !isOwnerTest) {
      return res.status(402).json({
        success: false,
        error: 'No render credits remaining. Please buy credits first.',
        credits: 0,
      });
    }

    console.log('MONOCULAR render request received');

    const imageFile = await dataUrlToFile(
      selectedImage,
      fileName || 'monocular-input.png'
    );

    const result = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      prompt: buildPrompt(prompt, fileName),
      size: '1024x1024',
    });

    const base64 = result.data?.[0]?.b64_json;

    if (!base64) {
      return res.status(500).json({
        success: false,
        error: 'OpenAI returned no image.',
      });
    }

    if (!isOwnerTest) {
      deductCredit(String(sessionId));
    }

    return res.json({
      success: true,
      image: `data:image/png;base64,${base64}`,
      credits: isOwnerTest ? credits : getCredits(String(sessionId)),
    });
  } catch (error) {
    console.error('RENDER ERROR:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Render failed.',
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MONOCULAR server running on port ${PORT}`);
});