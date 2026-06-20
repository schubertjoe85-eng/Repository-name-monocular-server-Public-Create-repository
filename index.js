app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, seconds, size } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const brief = await buildBrain({
      userPrompt: prompt,
      renderMode: "video",
      uploadedImageBase64: imageBase64
    });

    const preserveList = (brief.mustPreserve || []).map(function(x) { return "- " + x; }).join("\n");

    const videoPrompt = "Create an architectural video for thedoss.\n\nScene:\n" + brief.cleanPrompt + "\n\nCamera:\nSlow cinematic architectural dolly/orbit.\nStable lens.\nNo warping.\nNo melting.\nNo changing the building shape.\n\nMaterials:\n" + brief.materials + "\n\nSite:\n" + brief.siteContext + "\n\nLighting:\n" + brief.lighting + "\n\nMust preserve:\n" + preserveList + "\n\nAvoid:\n" + brief.negativePrompt;

    const form = new FormData();
    form.append("model", "sora-2");
    form.append("prompt", videoPrompt);
    form.append("size", size || "1280x720");
    form.append("seconds", seconds || "8");

    const openaiResponse = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY
      },
      body: form
    });

    const video = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("Video error:", video);
      return res.status(500).json({ error: "Video failed.", detail: video.error ? video.error.message : JSON.stringify(video) });
    }

    res.json({ ok: true, brief, video });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ error: "Video failed.", detail: error.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/videos/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY
      }
    });

    const video = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(500).json({ error: "Could not get video status.", detail: video.error ? video.error.message : JSON.stringify(video) });
    }

    res.json({ ok: true, video });
  } catch (error) {
    console.error("Video status error:", error);
    res.status(500).json({ error: "Could not get video status.", detail: error.message });
  }
});
