// ---------------------------------------------------------------------------
// Ultimate AI Presenter - frontend
// The Gemini key lives ONLY on the backend. This file never sees it.
// ---------------------------------------------------------------------------

// Local dev talks to Flask on :5000; the deployed site talks to your Render URL.
const PRODUCTION_BACKEND = "https://YOUR-ACTUAL-URL.onrender.com"; // <-- change after deploying the backend
const BACKEND_URL = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://localhost:5000"
  : PRODUCTION_BACKEND;

const REQUEST_TIMEOUT_MS = 90000; // free hosting can take a while to wake up
const GESTURE_COOLDOWN_MS = 1500;

// --- STATE ---
let slides = [];
let currentSlide = 0;
let currentTheme = "retro";

// Gesture AI state
let detector = null;
let webcamStream = null;
let isSettingUpCamera = false;
let isGestureCooldown = false;
let detectionRunId = 0; // lets old detection loops stop themselves
const previousWristPositions = {};

// --- DOM ---
const $ = (id) => document.getElementById(id);
const inputView = $("input-view");
const presentationView = $("presentation-view");
const gestureHelp = $("gesture-help");
const gestureHelpToggle = $("gesture-help-toggle");
const topicInput = $("topic-input");
const generateBtn = $("generate-btn");
const generateBtnText = $("generate-btn-text");
const loadingSpinner = $("loading-spinner");
const statusMessage = $("status-message");
const slideContainer = $("slide-container");
const slideContent = $("slide-content");
const slideCounter = $("slide-counter");
const prevBtn = $("prev-btn");
const nextBtn = $("next-btn");
const backBtn = $("back-btn");
const webcamVideo = $("webcam");
const themeRadios = document.querySelectorAll('input[name="theme"]');

// --- HELPERS ---
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

// --- THEME ---
function applyTheme(themeName) {
  document.body.dataset.theme = themeName;
  currentTheme = themeName;
}

// --- VIEWS ---
function showInputView() {
  inputView.classList.remove("hidden");
  inputView.classList.add("flex");
  presentationView.classList.add("hidden");
  presentationView.classList.remove("flex");
  gestureHelp.style.display = "none";
  gestureHelpToggle.setAttribute("aria-expanded", "false");
  stopWebcamAI();
}

function showPresentationView() {
  inputView.classList.add("hidden");
  inputView.classList.remove("flex");
  presentationView.classList.remove("hidden");
  presentationView.classList.add("flex");
  gestureHelp.style.display = "none";
  setupWebcamAI();
}

// --- SLIDE RENDERING (built with DOM nodes, so AI text can never inject HTML) ---
function buildBullet(text) {
  // "Key term: explanation" -> bold key term (only if the colon is early in the line)
  const li = document.createElement("li");
  const colon = text.indexOf(":");
  if (colon > 0 && colon <= 45) {
    li.append(el("strong", null, text.slice(0, colon + 1)), " " + text.slice(colon + 1).trim());
  } else {
    li.textContent = text;
  }
  return li;
}

function updateSlideContent() {
  if (slides.length === 0) return;
  const slide = slides[currentSlide];

  const grid = el("div", "slide-grid" + (slide.image ? "" : " no-image"));

  const textCol = el("div", "slide-text");
  textCol.append(el("h1", null, slide.title));
  const list = el("ul");
  slide.bullets.forEach((b) => list.append(buildBullet(b)));
  textCol.append(list);
  if (slide.takeaway) textCol.append(el("p", "takeaway", slide.takeaway));
  grid.append(textCol);

  if (slide.image) {
    const figure = el("figure", "slide-figure");
    const img = document.createElement("img");
    img.src = slide.image;
    img.alt = slide.image_query || slide.title;
    img.referrerPolicy = "no-referrer";
    // If an image fails to load, collapse to a full-width text slide instead of a broken icon
    img.onerror = () => {
      figure.remove();
      grid.classList.add("no-image");
    };
    figure.append(img);
    if (slide.image_credit) figure.append(el("figcaption", null, slide.image_credit));
    grid.append(figure);
  }

  slideContent.replaceChildren(grid);

  slideContainer.classList.remove("slide-anim");
  void slideContainer.offsetWidth; // restart the animation
  slideContainer.classList.add("slide-anim");

  slideCounter.textContent = `Slide ${currentSlide + 1} / ${slides.length}`;
  updateButtonState();
}

function updateButtonState() {
  prevBtn.disabled = currentSlide === 0;
  nextBtn.disabled = currentSlide === slides.length - 1;
}

function nextSlide() {
  if (currentSlide >= slides.length - 1) return;
  currentSlide++;
  updateSlideContent();
}

function prevSlide() {
  if (currentSlide <= 0) return;
  currentSlide--;
  updateSlideContent();
}

// --- BACKEND CALL ---
function setLoading(loading) {
  generateBtn.disabled = loading;
  generateBtnText.textContent = loading ? "Generating..." : "Generate & Present";
  loadingSpinner.classList.toggle("hidden", !loading);
  if (loading) setStatus("");
}

async function requestSlides(topic, theme) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Free hosting sleeps when idle - tell the user why it's slow instead of looking frozen
  const slowHint = setTimeout(
    () => setStatus("Writing slides and finding images. The first request can take up to a minute if the server was asleep."),
    6000
  );
  try {
    const res = await fetch(`${BACKEND_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, theme }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
    if (!Array.isArray(data.slides) || data.slides.length === 0) {
      throw new Error("The server did not return any slides.");
    }
    return data.slides;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("The request timed out. Please try again.");
    if (err instanceof TypeError) throw new Error("Could not reach the server. Is the backend running?");
    throw err;
  } finally {
    clearTimeout(timeout);
    clearTimeout(slowHint);
  }
}

async function handleGenerate() {
  const topic = topicInput.value.trim();
  if (!topic) {
    setStatus("Please enter a topic.", true);
    return;
  }

  const theme = document.querySelector('input[name="theme"]:checked').value;
  applyTheme(theme);
  setLoading(true);

  try {
    slides = await requestSlides(topic, theme);
    currentSlide = 0;
    slides.forEach((s) => { if (s.image) new Image().src = s.image; }); // warm the cache
    updateSlideContent();
    showPresentationView();
  } catch (err) {
    console.error("Error generating slides:", err);
    setStatus(`${err.message}`, true);
  } finally {
    setLoading(false);
  }
}

// --- GESTURE CONTROL (TensorFlow.js MoveNet) ---
async function setupWebcamAI() {
  if (detector || isSettingUpCamera) return;
  isSettingUpCamera = true;
  try {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      webcamVideo.style.display = "";
      webcamVideo.srcObject = webcamStream;
      await new Promise((resolve) => {
        webcamVideo.onloadedmetadata = () => { webcamVideo.play(); resolve(); };
      });
    } catch (err) {
      console.warn("Camera unavailable - buttons and arrow keys still work:", err);
      webcamVideo.style.display = "none";
      return;
    }

    // The user may have left the presentation while the camera was starting
    if (presentationView.classList.contains("hidden")) { stopWebcamAI(); return; }

    try {
      detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      });
    } catch (err) {
      console.error("Error loading MoveNet model:", err);
      return;
    }
    runDetectionLoop(++detectionRunId);
  } finally {
    isSettingUpCamera = false;
  }
}

function stopWebcamAI() {
  detectionRunId++; // invalidates any running loop
  if (webcamStream) {
    webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
  }
  webcamVideo.srcObject = null;
  if (detector) {
    detector.dispose();
    detector = null;
  }
  delete previousWristPositions.left;
  delete previousWristPositions.right;
}

async function runDetectionLoop(runId) {
  if (!detector || runId !== detectionRunId) return;
  try {
    const poses = await detector.estimatePoses(webcamVideo, { flipHorizontal: false });
    if (runId !== detectionRunId) return;
    if (poses && poses.length > 0 && poses[0].keypoints) handleGesture(poses[0].keypoints);
  } catch (err) {
    console.error("Error during pose estimation:", err);
  }
  requestAnimationFrame(() => runDetectionLoop(runId));
}

function handleGesture(keypoints) {
  const get = (name) => keypoints.find((kp) => kp.name === name);
  const rightWrist = get("right_wrist"), rightElbow = get("right_elbow");
  const leftWrist = get("left_wrist"), leftElbow = get("left_elbow");
  const MIN_SCORE = 0.25;
  const visible = (w, e) => w && e && w.score >= MIN_SCORE && e.score >= MIN_SCORE;

  const rightVisible = visible(rightWrist, rightElbow);
  const leftVisible = visible(leftWrist, leftElbow);
  const rightMovedUp = rightVisible && previousWristPositions.right && previousWristPositions.right.y - rightWrist.y > 18;
  const leftMovedUp = leftVisible && previousWristPositions.left && previousWristPositions.left.y - leftWrist.y > 18;
  const rightRaised = rightVisible && rightWrist.y < rightElbow.y - 12;
  const leftRaised = leftVisible && leftWrist.y < leftElbow.y - 12;

  if (rightVisible) previousWristPositions.right = rightWrist;
  if (leftVisible) previousWristPositions.left = leftWrist;
  if (isGestureCooldown) return;

  let detected = false;
  if (rightRaised || rightMovedUp) { nextSlide(); detected = true; }
  else if (leftRaised || leftMovedUp) { prevSlide(); detected = true; }
  if (!detected) return;

  isGestureCooldown = true;
  const styles = getComputedStyle(document.body);
  const accent = styles.getPropertyValue("--color-accent").trim();
  const border = styles.getPropertyValue("--color-border").trim();
  webcamVideo.style.borderColor = accent;
  webcamVideo.style.borderWidth = "4px";
  setTimeout(() => {
    isGestureCooldown = false;
    webcamVideo.style.borderColor = border;
    webcamVideo.style.borderWidth = "1px";
  }, GESTURE_COOLDOWN_MS);
}

// --- EVENTS ---
generateBtn.addEventListener("click", handleGenerate);
prevBtn.addEventListener("click", prevSlide);
nextBtn.addEventListener("click", nextSlide);
backBtn.addEventListener("click", showInputView);

gestureHelpToggle.addEventListener("click", () => {
  const open = gestureHelp.style.display === "block";
  gestureHelp.style.display = open ? "none" : "block";
  gestureHelpToggle.setAttribute("aria-expanded", String(!open));
});

themeRadios.forEach((radio) => radio.addEventListener("change", (e) => applyTheme(e.target.value)));

document.addEventListener("keydown", (e) => {
  if (presentationView.classList.contains("hidden")) return;
  if (e.key === "ArrowRight") nextSlide();
  if (e.key === "ArrowLeft") prevSlide();
});

topicInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate();
});

// --- INIT ---
applyTheme("retro");
showInputView();
