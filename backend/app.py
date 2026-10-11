"""
Flask backend for Ultimate AI Presenter.

- Keeps the Gemini API key on the server (never in the browser).
- Asks Gemini for rich slides: title, bullet points, a takeaway and an image search phrase.
- Finds a matching image for every slide (Pexels if a key is set, else Wikimedia Commons,
  else an AI-generated image via Pollinations).
"""

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# --- Config (all overridable with environment variables) ---------------------
API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")  # check AI Studio for the current model name
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")  # optional, free at pexels.com/api

# Origins are scheme + host only, no path. Add your GitHub Pages origin in production.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5500,http://127.0.0.1:5500",
    ).split(",")
    if o.strip()
]
CORS(app, origins=ALLOWED_ORIGINS)

VALID_THEMES = {"retro", "educational", "creative"}
MAX_TOPIC_LENGTH = 500
MIN_SLIDES, MAX_SLIDES, DEFAULT_SLIDES = 3, 12, 7
USER_AGENT = "UltimateAIPresenter/1.0 (https://github.com/Kajal-Gupta-R)"

BASE_SYSTEM_PROMPT = f"""You are a presentation-generation AI. The user gives you a topic.
Create a complete, informative slide deck about it.

Rules:
- If the user states a number of slides, use it (between {MIN_SLIDES} and {MAX_SLIDES}). Otherwise create {DEFAULT_SLIDES} slides.
- Slide 1 introduces the topic and why it matters. The last slide summarizes the key points.
- Every slide has 4 to 5 bullet points. Each bullet starts with a short key term (1-3 words) followed by a colon, then one
  concrete sentence of at most 22 words: a real fact, example, number or mechanism. No vague filler.
- Every slide has a "takeaway": one short sentence that captures the slide's main point.
- Every slide has an "image_query": 2 to 4 words naming something concrete and photographable that fits the slide
  (for example "neural network diagram", "solar panel field"). Avoid abstract words like "concept" or "success".
- Plain text only. No markdown, no HTML tags, no emojis unless the style instruction asks for them.
"""

THEME_INSTRUCTIONS = {
    "retro": "Style: retro-futuristic, like a 1980s computer terminal. Sharp, technical language.",
    "educational": "Style: educational and minimalist. Clear, concise language suited to a classroom or professional setting.",
    "creative": "Style: creative and funky. Playful language and bright ideas; a few emojis are welcome in titles.",
}

JSON_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "bullets": {"type": "ARRAY", "items": {"type": "STRING"}},
            "takeaway": {"type": "STRING"},
            "image_query": {"type": "STRING"},
        },
        "required": ["title", "bullets", "takeaway", "image_query"],
    },
}


# --- Image lookup -------------------------------------------------------------
def pexels_image(query):
    if not PEXELS_API_KEY:
        return None
    r = requests.get(
        "https://api.pexels.com/v1/search",
        params={"query": query, "per_page": 1, "orientation": "landscape"},
        headers={"Authorization": PEXELS_API_KEY, "User-Agent": USER_AGENT},
        timeout=8,
    )
    r.raise_for_status()
    photos = r.json().get("photos", [])
    if not photos:
        return None
    return {"url": photos[0]["src"]["large"], "credit": f"Photo: {photos[0].get('photographer', 'Pexels')} / Pexels"}


def commons_image(query):
    r = requests.get(
        "https://commons.wikimedia.org/w/api.php",
        params={
            "action": "query",
            "generator": "search",
            "gsrsearch": f"{query} filetype:bitmap",
            "gsrnamespace": 6,
            "gsrlimit": 8,
            "prop": "imageinfo",
            "iiprop": "url|mime|size",
            "iiurlwidth": 900,
            "format": "json",
        },
        headers={"User-Agent": USER_AGENT},
        timeout=8,
    )
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages", {})
    for page in sorted(pages.values(), key=lambda p: p.get("index", 0)):
        info = (page.get("imageinfo") or [{}])[0]
        if info.get("mime") in ("image/jpeg", "image/png") and info.get("width", 0) >= 600:
            return {"url": info.get("thumburl") or info.get("url"), "credit": "Image: Wikimedia Commons"}
    return None


def generated_image(query):
    # URL-based AI image: nothing is fetched here, the browser loads it directly.
    prompt = quote(f"{query}, clean illustration, high quality")
    return {
        "url": f"https://image.pollinations.ai/prompt/{prompt}?width=900&height=675&nologo=true",
        "credit": "AI-generated image",
    }


def find_image(query):
    """Try each image source in order; never raise, a slide without an image is fine."""
    if not query:
        return None
    for source in (pexels_image, commons_image):
        try:
            found = source(query)
            if found:
                return found
        except Exception as exc:  # network error, rate limit, bad JSON...
            app.logger.warning("%s failed for %r: %s", source.__name__, query, exc)
    return generated_image(query)


# --- Helpers ------------------------------------------------------------------
def clean_slides(raw):
    """Normalise whatever Gemini returned into a safe, predictable structure."""
    if not isinstance(raw, list):
        return []
    slides = []
    for item in raw[:MAX_SLIDES]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        bullets = [str(b).strip() for b in item.get("bullets", []) if str(b).strip()]
        if not title or not bullets:
            continue
        slides.append(
            {
                "title": title,
                "bullets": bullets[:6],
                "takeaway": str(item.get("takeaway", "")).strip(),
                "image_query": str(item.get("image_query", "")).strip(),
            }
        )
    return slides


def api_error(message, status, detail=None):
    body = {"error": message}
    if detail:
        body["detail"] = detail
    return jsonify(body), status


# --- Routes -------------------------------------------------------------------
@app.route("/api/generate", methods=["POST"])
def generate_slides():
    if not API_KEY:
        return api_error("The server is missing GEMINI_API_KEY. Add it to backend/.env or your host's environment settings.", 500)

    data = request.get_json(silent=True) or {}
    topic = str(data.get("topic", "")).strip()
    theme = data.get("theme", "retro")

    if not topic:
        return api_error("Topic cannot be empty.", 400)
    if len(topic) > MAX_TOPIC_LENGTH:
        return api_error(f"Topic is too long (max {MAX_TOPIC_LENGTH} characters).", 400)
    if theme not in VALID_THEMES:
        theme = "retro"

    payload = {
        "systemInstruction": {"parts": [{"text": f"{THEME_INSTRUCTIONS[theme]}\n\n{BASE_SYSTEM_PROMPT}"}]},
        "contents": [{"parts": [{"text": topic}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": JSON_SCHEMA,
            "temperature": 0.7,
        },
    }

    try:
        response = requests.post(
            API_URL,
            json=payload,
            headers={"x-goog-api-key": API_KEY, "Content-Type": "application/json"},  # header keeps the key out of URLs/logs
            timeout=60,
        )
    except requests.exceptions.Timeout:
        return api_error("The AI took too long to respond. Please try again.", 504)
    except requests.exceptions.RequestException as exc:
        app.logger.error("Gemini request failed: %s", exc)
        return api_error("Could not reach the Gemini API.", 502)

    if response.status_code != 200:
        app.logger.error("Gemini API error %s: %s", response.status_code, response.text[:500])
        hint = "Check the model name and API key." if response.status_code in (400, 403, 404) else "Please try again shortly."
        return api_error(f"Gemini API error ({response.status_code}). {hint}", 502)

    try:
        text = response.json()["candidates"][0]["content"]["parts"][0]["text"]
        slides = clean_slides(json.loads(text))
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        app.logger.error("Could not parse Gemini response: %s", exc)
        return api_error("The AI returned an unexpected response. Please try again.", 502)

    if not slides:
        return api_error("The AI did not return usable slides. Try rephrasing your topic.", 502)

    # Look up images in parallel so total time stays close to a single request
    with ThreadPoolExecutor(max_workers=6) as pool:
        images = list(pool.map(lambda s: find_image(s["image_query"]), slides))
    for slide, image in zip(slides, images):
        slide["image"] = image["url"] if image else None
        slide["image_credit"] = image["credit"] if image else None

    return jsonify({"slides": slides}), 200


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok", "api_key_configured": bool(API_KEY), "model": MODEL_NAME}), 200


@app.errorhandler(404)
def not_found(_):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def internal_error(_):
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    print(f"Ultimate AI Presenter backend on http://localhost:{port} (model: {MODEL_NAME}, key configured: {bool(API_KEY)})")
    app.run(debug=False, host="0.0.0.0" if os.getenv("PORT") else "localhost", port=port)
