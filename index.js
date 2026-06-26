app.post("/api/video", async (req, res) => {
  try {
    const { prompt, imageBase64, images } = req.body;
    const imageList = (Array.isArray(images) && images.length) ? images : (imageBase64 ? [imageBase64] : []);
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
    if (!imageList.length) return res.status(400).json({ error: "Please upload an image." });

    const src = imageList[0];
    const imageUrl = src.startsWith("data:") ? src : "data:image/png;base64," + src;
    const motion = prompt + ". Slow cinematic camera move. Keep the building unchanged. Realistic architectural walkthrough.";

    const r = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06",
      },
      body: JSON.stringify({
        model: "gen4_turbo",
        promptImage: imageUrl,
        promptText: motion,
        ratio: "1280:720",
        duration: 5,
      }),
    });

    const data = await r.json();
    if (!r.ok || !data.id) {
      console.error("Runway submit error:", data);
      return res.status(500).json({ error: "Video failed.", detail: JSON.stringify(data) });
    }
    res.json({ ok: true, video: { id: data.id } });
  } catch (error) {
    console.error("Video error:", error);
    res.status(500).json({ error: "Video failed.", detail: error.message });
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const data = await r.json();
    const status = data.status === "SUCCEEDED" ? "completed" : data.status === "FAILED" ? "failed" : "in_progress";
    res.json({ ok: true, video: { status } });
  } catch (error) {
    res.status(500).json({ error: "Status failed.", detail: error.message });
  }
});

app.get("/api/video/:id/url", async (req, res) => {
  try {
    const r = await fetch("https://api.dev.runwayml.com/v1/tasks/" + req.params.id, {
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const data = await r.json();
    const url = data.output && data.output[0] ? data.output[0] : null;
    if (!url) return res.status(404).json({ error: "No video URL yet." });
    res.json({ ok: true, url });
  } catch (error) {
    res.status(500).json({ error: "URL fetch failed.", detail: error.message });
  }
});
