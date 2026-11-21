// Local face detection for the camera check.
// Tiny Face Detector (face-api, MIT) on TensorFlow.js. The model ships inside
// the extension (vendor/face-api, ~1.5 MB); no image leaves the computer.
// Loaded lazily on the first camera start, so the panel opens just as fast.

const LIB = new URL("../vendor/face-api/face-api.esm.js", import.meta.url).href;
const MODEL_DIR = new URL("../vendor/face-api/model/", import.meta.url).href;
const MANIFEST = "tiny_face_detector_model-weights_manifest.json";
// Fast pass first; a face under ~12% of the frame width (sitting far back)
// is only found at the larger size, so that runs only when the first misses.
const INPUT_SIZES = [224, 416];
const MIN_SCORE = 0.5;

let api = null;
let state = "idle"; // idle | loading | ready | unavailable
let loading = null;

export const faceDetectorState = () => state;

export function loadFaceDetector() {
  if (loading) return loading;
  state = "loading";
  loading = (async () => {
    try {
      api = await import(LIB);
      // WebGL first; the CPU backend is slow but still fine at 2 detections/s.
      // The WASM backend is never chosen: extension pages do not need it.
      try {
        await api.tf.setBackend("webgl");
      } catch {
        await api.tf.setBackend("cpu");
      }
      await api.tf.ready();
      api.nets.tinyFaceDetector.loadFromWeightMap(await loadWeights());
      state = "ready";
    } catch (err) {
      console.warn("[setup-check] face detector unavailable:", err);
      state = "unavailable";
    }
  })();
  return loading;
}

// face-api's own loadFromUri() rewrites the URL and only understands http(s),
// so it breaks on chrome-extension:// URLs. Fetch the files and decode them here.
async function loadWeights() {
  const get = async (name) => {
    const res = await fetch(MODEL_DIR + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res;
  };
  const manifest = await (await get(MANIFEST)).json();
  const parts = await Promise.all(
    manifest.flatMap((group) => group.paths).map(async (path) => (await get(path)).arrayBuffer())
  );
  const bytes = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return api.tf.io.decodeWeights(bytes.buffer, manifest.flatMap((group) => group.weights));
}

// Returns the most confident face as fractions of the image (0..1),
// null when there is none, or undefined when the detector is not ready.
export async function findFace(canvas) {
  if (state !== "ready") return undefined;
  let det = null;
  for (const inputSize of INPUT_SIZES) {
    det = await api.detectSingleFace(
      canvas,
      new api.TinyFaceDetectorOptions({ inputSize, scoreThreshold: MIN_SCORE })
    );
    if (det) break;
  }
  if (!det) return null;
  const { x, y, width, height } = det.box;
  const W = canvas.width;
  const H = canvas.height;
  // Boxes can run past the edge when the head is cut off: keep that signal.
  return { x: x / W, y: y / H, w: width / W, h: height / H, score: det.score };
}
