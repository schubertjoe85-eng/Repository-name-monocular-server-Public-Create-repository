// renderDirector.js
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
- Do not add, remove, move, resize, or improve any structural element.
- If a detail is ambiguous in the drawing, keep it neutral and restrained
  rather than inventing a confident guess. Restraint is the correct default.

THEN, ARTICULATION (this is where the wish becomes visible):
- Read the design intent — its character, its aspiration, the kind of life
  it imagines. Render THAT through light, shadow, material truth, weather,
  time of day, atmosphere, context.
- Choose a lighting condition that flatters the design intent. Low raking
  morning light for mass and texture. Overcast for calm material honesty.
  Dusk for warmth and interior glow. Justify it briefly.
- Specify materials the way an architect would: named, honest, tactile.
  Concrete with board-mark texture. Oxidised steel. Oiled oak. Never generic.
- Place the building truthfully in its site and scale. People and planting
  are for scale and life only — never to obscure the architecture.
- For Australian projects: favour warm golden-hour light, native planting,
  and honest material weathering. Avoid sterile European-style renders.

QUALITY STANDARD:
- Ultra photorealistic, magazine quality. Think Houses magazine or Architectural Review.
- Physically accurate shadows, ambient occlusion, and reflections.
- High dynamic range lighting — no blown-out sky, no crushed shadows.
- Crisp, high-resolution material textures with correct scale.
- Believable scale and correct one-point or two-point perspective.
- Sharp focus on the building, natural depth of field in background.
- No warped geometry, no melted edges, no duplicated structural elements.

VOICE:
- Precise architectural language. No marketing adjectives, no "stunning."
- Specific over vague. Every clause should be checkable against the drawing.

Return ONLY valid JSON, no prose, with exactly these keys:
{
  "cleanPrompt":    string,
  "materials":      string,
  "lighting":       string,
  "siteContext":    string,
  "camera":         string,
  "mustPreserve":   string[],
  "negativePrompt": string
}
`.trim();

export const CONTROL_CONFIG = {
  preprocess: "canny",
  control_scale: 0.97,
  control_start: 0.0,
  control_end: 0.99,
  num_inference_steps: 8,
  image_size: "square_hd",
  output_format: "png",
};

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
  "cartoon style",
  "fantasy architecture",
  "oversaturated colours",
  "HDR tone mapping artefacts",
].join(", ");

export function buildWishImagePrompt(brief) {
  const preserve = (brief.mustPreserve || [])
    .map((x) => "- " + x)
    .join("\n");

  return [
    "Ultra photorealistic architectural render of the EXACT building in the source image. Reproduce it faithfully — add only realistic materials, light and surroundings. Do not redesign, restyle, reinterpret, or add features. Keep all structure, proportions, rooflines and openings identical to the source. Magazine quality. Houses magazine standard.",
    "",
    "The building, exactly as drawn:",
    brief.cleanPrompt,
    "",
    "Camera:",
    brief.camera || "Eye-level, slight upward tilt, two-point perspective.",
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
    "light, honest materials. Articulate the design intent through light and",
    "atmosphere only — never by changing the form.",
    "",
    "Do not produce: " + (brief.negativePrompt || "") + ", " + NEGATIVE + ".",
  ].join("\n");
}
