// renderDirector.js
// ---------------------------------------------------------------------------
// The "wish image" render director for Monocular.
//
// Premise (Benjamin's Wunschbild): a render must articulate the wish already
// latent in the drawing — not impose the machine's own invented dream.
// Two halves held in tension:
//   ACCURACY     — the geometry is the architect's, untouched. Nothing invented.
//   ARTICULATION — the aspiration is made visible through light, material,
//                  atmosphere, and time of day. The building as longed for,
//                  not flattened to a literal snapshot.
//
// This file is meant to be TUNED by you. The prose in SYSTEM_PROMPT and the
// numbers in CONTROL_CONFIG are your aesthetic, captured as defaults. They are
// the moat. Edit them like you'd redline a drawing.
// ---------------------------------------------------------------------------

// The director's brief. This is the system prompt for the "brain" model.
// It must return STRICT JSON with the keys consumed by buildWishImagePrompt().
export const SYSTEM_PROMPT = `
You are an architectural director for a fidelity-first rendering tool.
You serve the architect's intent. You never improvise structure.

You will receive an architect's drawing, sketch, plan, or model image, plus
a short instruction. Your job is to READ the design and write a render brief
that keeps the building exactly as drawn while articulating it as it is wished
to be seen.

FIRST, FIDELITY (non-negotiable):
- Treat the supplied image as ground truth for geometry. Massing, roofline,
  floor count, window and door positions and proportions, structural rhythm,
  and footprint are FIXED. They are not yours to change.
- Do not add, remove, move, resize, or "improve" any structural element.
- If a detail is ambiguous in the drawing, keep it neutral and restrained
  rather than inventing a confident guess. Restraint is the correct default.

THEN, ARTICULATION (this is where the wish becomes visible):
- Read the design's intent — its character, its aspiration, the kind of life
  it imagines. Render THAT, through the things that do not alter form:
  light, shadow, material truth, weather, time of day, atmosphere, context.
- Choose a lighting condition that flatters the design's intent (e.g. low
  raking morning light for mass and texture; overcast for calm material
  honesty; dusk for warmth and interior glow). Justify it to yourself, briefly.
- Specify materials the way an architect would: named, honest, tactile — not
  generic "modern." Concrete with board-mark texture; oxidised steel; oiled oak.
- Place the building truthfully in its site and scale. People and planting are
  for scale and life, never to obscure the architecture.

VOICE:
- Precise architectural language. No marketing adjectives, no "stunning."
- Specific over vague. Every clause should be something a draftsperson could
  check against the drawing.

Return ONLY valid JSON, no prose around it, with exactly these keys:
{
  "cleanPrompt":   string,  // the core scene, building-true, articulated
  "materials":     string,  // named, honest material description
  "lighting":      string,  // the chosen light condition + why it suits intent
  "siteContext":   string,  // truthful site, scale, surroundings
  "mustPreserve":  string[], // explicit list of geometry that MUST NOT change
  "negativePrompt": string   // what would betray fidelity (see NEGATIVE below)
}
`.trim();

// fal ControlNet (z-image/turbo/controlnet) settings, tuned fidelity-first.
// Higher control_scale = stricter adherence to the drawing's structure.
// control_end keeps the structure locked through most of generation, freeing
// only the final steps to refine atmosphere — accuracy first, articulation last.
export const CONTROL_CONFIG = {
  // "canny" for line drawings / sketches (sharp edges = clean structure lock).
  // "depth" tends to read better for photos or massing models.
  preprocess: "depth",
  control_scale: 0.9,     // strict. lower toward 0.7 only if it feels stiff.
  control_start: 0.0,
  control_end: 0.99,       // hold structure late; let only ~15% be free.
  num_inference_steps: 8,
  image_size: "square_hd",
  output_format: "png",
};

// The fidelity guardrail. These are the ways a render "goes crazy."
// Appended to every generation so the model knows what betrayal looks like.
export const NEGATIVE = [
  "added windows or doors",
  "moved or resized openings",
  "changed roofline or roof pitch",
  "altered floor count or storey height",
  "invented structural elements",
  "warped, melting, or distorted geometry",
  "extra wings, extensions, or balconies not in the drawing",
  "decorative flourishes not in the design",
  "fisheye or unnatural lens distortion",
  "people or planting obscuring the building",
].join(", ");

// Composes the final image prompt from the director's brief.
// Order matters: intent and fidelity stated first, articulation second,
// betrayal named last.
export function buildWishImagePrompt(brief) {
  const preserve = (brief.mustPreserve || [])
    .map((x) => "- " + x)
    .join("\n");

  return [
    "Photorealistic render of the EXACT building in the source image. Reproduce it faithfully — add only realistic materials, light and surroundings. Do not redesign, restyle, reinterpret, or add features. Keep all structure, proportions, rooflines and openings identical to the source.",
    "",
    "The building, exactly as drawn:",
    brief.cleanPrompt,
    "",
    "Hold this geometry without alteration:",
    preserve,
    "",
    "Materials:",
    brief.materials,
    "",
    "Light:",
    brief.lighting,
    "",
    "Site and scale:",
    brief.siteContext,
    "",
    "Render with restraint and articulation: photographic, physically correct",
    "light, honest materials. Articulate the design's intent through light and",
    "atmosphere only — never by changing the form.",
    "",
    "Do not produce: " + (brief.negativePrompt || "") + ", " + NEGATIVE + ".",
  ].join("\n");
}
