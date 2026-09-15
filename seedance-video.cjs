// seedance-video.js
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const MODEL = 'seedance2_5';

const RATIOS = {
  '480p':  { landscape: '854:480',   portrait: '480:854'  },
  '720p':  { landscape: '1280:720',  portrait: '720:1280' },
  '1080p': { landscape: '1920:1080', portrait: '1080:1920' },
};

function pickRatio(resolution = '720p', orientation = 'landscape') {
  const tier = RATIOS[resolution] || RATIOS['720p'];
  return tier[orientation] || tier.landscape;
}

const CREDITS_PER_SECOND = { '480p': 20, '720p': 30, '1080p': 68 };
const MIN_CREDITS_PER_GENERATION = 80;
const MAX_CREDITS_PER_JOB = 400;

function estimateCredits(seconds, resolution = '720p') {
  const rate = CREDITS_PER_SECOND[resolution] ?? CREDITS_PER_SECOND['720p'];
  return Math.max(MIN_CREDITS_PER_GENERATION, Math.ceil(seconds * rate));
}

function clampDuration(seconds) {
  const n = Math.round(Number(seconds) || 10);
  return Math.min(30, Math.max(4, n));
}

function buildPromptImage(referenceUris) {
  if (!referenceUris.length) throw new Error('at least one reference image required');
  if (referenceUris.length > 30) throw new Error('max 30 image references');
  return referenceUris.map((uri) => ({ uri }));
}

// Runway's promptImage[].uri must be a real fetchable URL (an uploaded
// ephemeral URI, or a public http(s) URL) — a raw base64 data: URI there is
// silently unusable, which is what was happening before this existed: the
// task would sit un-processable until the poll loop's own timeout fired.
async function resolveReferenceUri(ref, apiKey) {
  if (!ref.startsWith('data:')) return ref;
  const match = ref.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new Error('unsupported data URI reference');
  const [, contentType, base64] = match;
  return uploadEphemeral(Buffer.from(base64, 'base64'), contentType, apiKey);
}

async function uploadEphemeral(buffer, contentType, apiKey) {
  const res = await fetch(RUNWAY_BASE + '/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'X-Runway-Version': RUNWAY_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'ephemeral',
      contentType,
      contentLength: buffer.length,
      filename: 'reference.' + (contentType.split('/')[1] || 'png'),
    }),
  });
  if (!res.ok) throw new Error('upload init failed: ' + res.status);
  const uploadData = await res.json();
  if (!uploadData.runwayUri) throw new Error('upload init returned no runwayUri');
  if (uploadData.fields) {
    const formData = new FormData();
    Object.entries(uploadData.fields).forEach(([key, value]) => formData.append(key, value));
    formData.append('file', new Blob([buffer], { type: contentType }), 'reference');
    const post = await fetch(uploadData.uploadUrl, { method: 'POST', body: formData });
    if (!post.ok) throw new Error('upload POST failed: ' + post.status);
  } else {
    const put = await fetch(uploadData.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });
    if (!put.ok) throw new Error('upload PUT failed: ' + put.status);
  }
  return uploadData.runwayUri;
}

async function startSeedanceVideo({
  referenceUris,
  promptText,
  seconds = 10,
  resolution = '720p',
  orientation = 'landscape',
  apiKey = process.env.RUNWAY_API_KEY,
}) {
  const duration = clampDuration(seconds);
  const cost = estimateCredits(duration, resolution);
  if (cost > MAX_CREDITS_PER_JOB) {
    throw new Error('refusing job: ~' + cost + ' credits exceeds cap ' + MAX_CREDITS_PER_JOB);
  }
  const resolvedUris = await Promise.all(
    referenceUris.map((ref) => resolveReferenceUri(ref, apiKey))
  );
  const body = {
    model: MODEL,
    promptImage: buildPromptImage(resolvedUris),
    promptText,
    duration,
    ratio: pickRatio(resolution, orientation),
  };
  const res = await fetch(RUNWAY_BASE + '/image_to_video', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'X-Runway-Version': RUNWAY_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('seedance start failed: ' + res.status + ' ' + text);
  }
  const { id } = await res.json();
  return { taskId: id, estimatedCredits: cost, duration, ratio: body.ratio };
}

async function pollTask(taskId, opts) {
  const o = opts || {};
  const apiKey = o.apiKey || process.env.RUNWAY_API_KEY;
  const timeoutMs = o.timeoutMs || 15 * 60 * 1000;
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(RUNWAY_BASE + '/tasks/' + taskId, {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'X-Runway-Version': RUNWAY_VERSION,
      },
    });
    if (!res.ok) throw new Error('poll failed: ' + res.status);
    const task = await res.json();
    if (task.status === 'SUCCEEDED') return task.output && task.output[0];
    if (task.status === 'FAILED') {
      throw new Error('task failed: ' + (task.failure || task.failureCode || 'unknown'));
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15000);
  }
  throw new Error('task ' + taskId + ' timed out');
}

async function renderWalkthrough({
  angleUris,
  promptText,
  seconds = 10,
  resolution = '720p',
  orientation = 'landscape',
  apiKey = process.env.RUNWAY_API_KEY,
}) {
  const started = await startSeedanceVideo({
    referenceUris: angleUris,
    promptText,
    seconds,
    resolution,
    orientation,
    apiKey,
  });
  const videoUrl = await pollTask(started.taskId, { apiKey });
  return {
    videoUrl,
    taskId: started.taskId,
    estimatedCredits: started.estimatedCredits,
    duration: started.duration,
    ratio: started.ratio,
  };
}

module.exports = {
  MODEL,
  RATIOS,
  pickRatio,
  estimateCredits,
  clampDuration,
  buildPromptImage,
  uploadEphemeral,
  startSeedanceVideo,
  pollTask,
  renderWalkthrough,
};
