# Ultimate AI Presenter

Type a topic, pick a theme, and get a full slide deck with bullet points and matching images. Then present it **hands-free**: raise your right hand to go to the next slide, your left hand to go back.

**Live demo:** https://kajal-gupta-r.github.io/AI-Presenter/
<!-- Add a screenshot or GIF here: ![Demo](docs/demo.gif) -->

## What it does

- **AI-generated decks.** Gemini writes each slide with a title, 4-5 bullet points (a key term plus one concrete fact), and a one-line takeaway.
- **Images for every slide.** Each slide gets a search phrase from the AI, and the backend finds a matching image (Pexels, then Wikimedia Commons, then an AI-generated fallback).
- **Gesture control.** TensorFlow.js MoveNet tracks your wrists and elbows in the webcam feed, entirely in the browser. No video leaves your machine.
- **Three themes.** Retro-futuristic, educational and creative. The theme changes both the visual style and the tone of the generated text.
- **Keyboard and button controls** as a backup (arrow keys, Prev/Next).

## How it works

```
Browser (GitHub Pages)                      Backend (Render, Flask)
 topic + theme  ───────────────────────►   /api/generate
                                              ├─ Gemini → slides as JSON (title, bullets, takeaway, image_query)
                                              ├─ validate and clean the JSON
                                              └─ look up one image per slide (in parallel)
 render slides  ◄───────────────────────   { slides: [...] }
 MoveNet (webcam) → wrist above elbow → next / previous slide
```

The Gemini API key lives only on the backend. The frontend never sees it, and slide text is rendered with DOM nodes (not `innerHTML`), so AI output can't inject markup.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | HTML, CSS (theme variables), vanilla JavaScript, Tailwind CDN |
| Gesture AI | TensorFlow.js, MoveNet (pose-detection) |
| Backend | Python, Flask, Flask-CORS, Gunicorn |
| AI | Google Gemini API (structured JSON output) |
| Images | Pexels API (optional), Wikimedia Commons API, Pollinations |
| Deploy | GitHub Pages (via GitHub Actions) + Render |

## Run it locally

```bash
# 1. Backend
cd backend
python -m venv venv
venv\Scripts\activate          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # then put your GEMINI_API_KEY in .env
python app.py                  # http://localhost:5000

# 2. Frontend (new terminal)
cd frontend
python -m http.server 8080     # open http://localhost:8080
```

Get a Gemini key from [Google AI Studio](https://aistudio.google.com/). Optionally add a free [Pexels](https://www.pexels.com/api/) key for better photos.

## Deploy

1. **Backend on Render:** New Web Service from this repo, root directory `backend`, build `pip install -r requirements.txt`, start `gunicorn app:app --timeout 120`. Add environment variables `GEMINI_API_KEY` and `ALLOWED_ORIGINS=https://kajal-gupta-r.github.io`.
2. **Connect the frontend:** set `PRODUCTION_BACKEND` at the top of `frontend/script.js` to your Render URL.
3. **Frontend on GitHub Pages:** in the repo, go to Settings → Pages → Source: **GitHub Actions**. Every push to `main` redeploys via `.github/workflows/deploy.yml`.

Render's free tier sleeps when idle, so the first request after a break can take up to a minute.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Gemini access |
| `GEMINI_MODEL` | No | Override the model (default `gemini-2.5-flash`) |
| `PEXELS_API_KEY` | No | Higher-quality slide photos |
| `ALLOWED_ORIGINS` | In production | Comma-separated origins allowed to call the API |

## Known limitations

- Image relevance depends on the search phrase, so some slides may get a loosely related picture.
- Gesture detection works best with good lighting and your upper body in frame.
- Camera access needs HTTPS or `localhost`.

## Ideas for next steps

- Export the deck to PowerPoint or PDF
- Let users edit a slide's text or swap its image
- Speaker notes and a presenter timer
- More gestures (e.g. both hands up to pause)

---
Built by [Kajal Gupta R](https://github.com/Kajal-Gupta-R)
