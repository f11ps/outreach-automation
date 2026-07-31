#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
# hcaptcha_cnn_solver.py — Persistent CNN-based image-tile classifier for
#                           hCaptcha's "click all images with a <X>" challenge.
#
# PURPOSE / ROLE IN THE PIPELINE:
#   hCaptcha's image challenge shows a 3x3 (or 3x4) grid of photo tiles and a
#   text prompt like "Please click each image containing a bicycle". This
#   script is a standalone image classifier that, given the prompt label and
#   the tile images, decides which tile indices should be clicked. It does
#   NOT drive the browser itself — it purely answers "which tiles match?" —
#   the browser automation (finding the grid, clicking those specific tiles,
#   clicking Verify, looping through rounds) lives in captcha/hcaptcha.js.
#
#   NOTE ON CURRENT USAGE: captcha/hcaptcha.js defines a `cnnClassify()`
#   helper that spawns and talks to this script, but as of the current
#   hcaptcha.js, `cnnClassify()` is never actually called — the exported
#   `solveHcaptcha()` flow instead delegates the entire hCaptcha solve
#   (checkbox click + image challenge, if any) to hcaptcha_sb_solver.py via
#   SeleniumBase CDP, which grabs a solved response token directly rather
#   than classifying/clicking tiles itself. This script's tile-classification
#   approach appears to be an earlier/alternative strategy that the code
#   still contains the plumbing for (process spawn/read-loop code in
#   hcaptcha.js), but it is not on the live code path today.
#
# HOW IT WORKS (high level):
#   1. On startup it loads a pretrained MobileNetV3-Small ImageNet
#      classifier (torchvision), and wraps it in `_FeatureExtractor` which
#      runs the conv/pooling backbone plus the first classifier Linear+
#      activation layer, giving a 1024-d embedding per image instead of a
#      1000-way class prediction.
#   2. It precomputes normalized "class prototype" vectors from the
#      original classifier's final Linear layer weights — one prototype
#      row per one of the 1000 ImageNet classes — so an input image's
#      cosine similarity to each prototype can be used as a cheap
#      zero-shot-ish classification score (features . prototype) instead of
#      running the full original classifier head.
#   3. `LABEL_KEYWORDS` maps common hCaptcha prompt categories (e.g.
#      "bicycle", "bus", "traffic light") to lists of related ImageNet class
#      names, since ImageNet's 1000 classes don't line up 1:1 with hCaptcha's
#      prompt vocabulary (e.g. hCaptcha says "car", ImageNet has "sports
#      car", "convertible", "limousine", "cab", etc). `_get_class_indices()`
#      resolves a raw prompt label into the relevant subset of the 1000
#      ImageNet class indices to score against.
#   4. For each tile image, `extract_features_multicrop()` runs 5 crops
#      (full image + 4 corner-biased 75% crops) through the feature
#      extractor and averages their embeddings — this makes the match more
#      robust to the target object being off-center or the tile containing
#      background clutter around the edges.
#   5. `classify_tile()` computes cosine similarity between a tile's
#      averaged embedding and each candidate class prototype, and returns
#      the best-matching class + its score.
#   6. `solve()` scores every tile in the challenge, then keeps only the
#      tiles whose score is within `RELATIVE_MARGIN` (0.04) of the best
#      score (and above an absolute floor `ABSOLUTE_MIN`), on the theory
#      that the actual matching tiles for a given prompt cluster tightly
#      near the top score while non-matching tiles score much lower. If no
#      tile clears the absolute floor, it falls back to just returning the
#      single highest-scoring tile so something is always selected.
#   7. `solve_urls()` / `fetch_url()` support the case where hCaptcha tile
#      images are referenced by URL rather than embedded as base64 — it
#      downloads each URL (spoofing a Chrome User-Agent and hCaptcha
#      Referer) and re-uses the same `solve()` path.
#
# PROTOCOL (stdin/stdout, line-delimited JSON):
#   Input:  {"task": "<label>", "images": ["<base64_png>", ...]}
#        or {"task": "<label>", "urls":   ["<url>", ...]}
#   Output: {"indices": [0, 2, 5], "label": "<matched_label>"}
#           {"indices": [], "error": "<msg>"}
#   Like whisper_server.py, this is a persistent worker process communicating
#   over stdio, not an HTTP server — one JSON request per line in, one JSON
#   response per line out, looped forever.
#
# HOW / BY WHAT IT'S INVOKED:
#   Spawned as a child process by captcha/hcaptcha.js:
#       spawn(PYTHON, [SOLVER_PY], { stdio: ['pipe', 'pipe', 'pipe'] })
#   (SOLVER_PY = path to this file). hcaptcha.js's `cnnClassify()` writes a
#   JSON request line to the child's stdin and resolves a pending Promise
#   when a corresponding JSON line comes back on stdout — but see the note
#   above: this helper currently has no caller in `solveHcaptcha()`, so in
#   the live pipeline this process would only ever be spawned if some other
#   (currently absent) code path invoked `cnnClassify()`.
#
# SETUP / DEPENDENCY NOTES:
#   - Requires PyTorch + torchvision (`torch`, `torchvision`), NumPy, and
#     Pillow (`PIL`) for image decoding.
#   - Uses CUDA automatically if available (`torch.cuda.is_available()`),
#     otherwise falls back to CPU.
#   - Downloads/expects the torchvision MobileNetV3-Small ImageNet1K
#     pretrained weights (via `models.MobileNet_V3_Small_Weights`) —
#     first run may need network access to fetch these weights unless
#     they're already cached locally.
# ════════════════════════════════════════════════════════════════════════════

"""
hcaptcha_cnn_solver.py — Persistent CNN-based hCaptcha solver server.

Protocol (stdin/stdout, line-delimited JSON):
  Input:  {"task": "<label>", "images": ["<base64_png>", ...]}
       or {"task": "<label>", "urls":   ["<url>", ...]}
  Output: {"indices": [0, 2, 5], "label": "<matched_label>"}
          {"indices": [], "error": "<msg>"}
"""

import sys, json, base64, io, re, os
import torch
import torch.nn.functional as F
import torchvision.transforms as T
import torchvision.models as models
import numpy as np
from PIL import Image

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
import warnings; warnings.filterwarnings('ignore')

# Prefer GPU if one is available and CUDA-enabled torch is installed.
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

sys.stderr.write(f'🔄 Loading CNN model (device={DEVICE})...\n')
sys.stderr.flush()

# Load pretrained MobileNetV3-Small (ImageNet-1K weights) once at startup —
# same "pay the load cost once, then serve many requests" pattern as
# whisper_server.py's model loading.
_weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
_model   = models.mobilenet_v3_small(weights=_weights)
_model.eval().to(DEVICE)

class _FeatureExtractor(torch.nn.Module):
    """Wraps the MobileNetV3 backbone to expose the penultimate embedding
    (post conv features + avgpool + first classifier Linear+activation)
    instead of the final 1000-way class logits, so images can be compared
    to class *prototype* vectors via cosine similarity rather than only
    getting a single argmax class prediction."""
    def __init__(self, m):
        super().__init__()
        self.features   = m.features
        self.avgpool    = m.avgpool
        self.linear     = m.classifier[0]
        self.activation = m.classifier[1]
    def forward(self, x):
        x = self.features(x)
        x = self.avgpool(x)
        x = x.flatten(1)
        x = self.linear(x)
        x = self.activation(x)
        return x

_feature_model = _FeatureExtractor(_model)
_feature_model.eval().to(DEVICE)

# The human-readable ImageNet class names (1000 of them) that ship with the
# torchvision pretrained weights metadata.
_IMAGENET_CLASSES = _weights.meta['categories']

# Standard ImageNet preprocessing: resize to the model's expected input
# size and normalize using ImageNet's channel mean/std.
_preprocess = T.Compose([
    T.Resize((224, 224)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

sys.stderr.write('✅ CNN model loaded\n')
sys.stderr.flush()

# Maps a normalized hCaptcha prompt keyword (e.g. "bicycle") to the list of
# specific ImageNet class names that should count as a match for it. This
# bridges the gap between hCaptcha's everyday-object vocabulary and
# ImageNet's much more granular/specific class taxonomy (e.g. hCaptcha says
# "dog", ImageNet only has specific breeds like "husky", "poodle", etc).
LABEL_KEYWORDS = {
    'bicycle':       ['bicycle','bike','mountain bike','tricycle'],
    'bus':           ['bus','minibus','trolleybus','school bus'],
    'car':           ['car','sports car','convertible','limousine','racer','cab'],
    'motorcycle':    ['motorcycle','moped','motor scooter'],
    'truck':         ['truck','pickup','moving van','garbage truck','fire engine'],
    'boat':          ['boat','canoe','kayak','gondola','catamaran','speedboat'],
    'airplane':      ['airplane','airliner','warplane','jet'],
    'train':         ['train','locomotive','electric locomotive','freight car'],
    'traffic light': ['traffic light'],
    'fire hydrant':  ['fire hydrant'],
    'stop sign':     ['stop sign'],
    'bench':         ['park bench'],
    'bird':          ['bird','hen','cock','duck','goose','penguin','parrot','macaw',
                      'toucan','flamingo','hummingbird','robin','jay','magpie','crow',
                      'vulture','eagle','owl','peacock','ostrich'],
    'cat':           ['cat','tabby','tiger cat','persian cat','siamese cat',
                      'egyptian cat','cougar','lynx','leopard','lion','tiger','cheetah'],
    'dog':           ['dog','puppy','husky','poodle','bulldog','beagle',
                      'labrador retriever','golden retriever','german shepherd',
                      'dalmatian','chihuahua','dachshund','boxer','collie'],
    'horse':         ['horse','sorrel','zebra'],
    'sheep':         ['sheep','ram','bighorn'],
    'cow':           ['cow','ox','bison','water buffalo'],
    'elephant':      ['elephant','african elephant','indian elephant'],
    'bear':          ['bear','brown bear','polar bear','black bear'],
    'zebra':         ['zebra'],
    'giraffe':       ['giraffe'],
    'backpack':      ['backpack','bag'],
    'umbrella':      ['umbrella'],
    'bottle':        ['bottle','wine bottle','beer bottle','water bottle'],
    'cup':           ['cup','coffee mug'],
    'bowl':          ['mixing bowl','soup bowl'],
    'banana':        ['banana'],
    'apple':         ['granny smith'],
    'pizza':         ['pizza'],
    'donut':         ['doughnut'],
    'cake':          ['chocolate cake','birthday cake'],
    'chair':         ['folding chair','rocking chair','barber chair'],
    'couch':         ['studio couch'],
    'bed':           ['bed'],
    'toilet':        ['toilet seat'],
    'tv':            ['television','monitor','screen'],
    'laptop':        ['laptop','notebook'],
    'cell phone':    ['cell phone','mobile phone','smartphone'],
    'book':          ['book jacket'],
    'clock':         ['wall clock','analog clock','digital clock'],
    'vase':          ['vase'],
    'teddy bear':    ['teddy bear'],
    'toothbrush':    ['toothbrush'],
    'vehicle':       ['car','truck','bus','motorcycle','bicycle','van','ambulance','fire engine'],
    'animal':        ['dog','cat','bird','horse','cow','sheep','elephant','bear','zebra','giraffe'],
    'person':        ['person'],
    'bridge':        ['viaduct','suspension bridge','steel arch bridge'],
    'building':      ['church','castle','palace','monastery','barn'],
    'tree':          ['tree','palm','fig'],
    'flower':        ['daisy','sunflower','rose hip','lotus'],
    'mountain':      ['alp','cliff','valley'],
    'water':         ['lake','seashore','coral reef'],
    'road':          ['street sign','traffic light'],
}

def _get_class_indices(label: str) -> list:
    """Resolve an hCaptcha prompt label string into a list of ImageNet class
    indices worth scoring against, using a few fallback strategies:
      1. Exact/substring match of the whole label against LABEL_KEYWORDS keys.
      2. If that fails, split the label into words and try each word.
      3. If that also fails, use the individual (>=3 char) words themselves
         as the "keywords" and substring-match them directly against
         ImageNet class names.
      4. If literally nothing matches, fall back to scoring against *all*
         1000 classes (so the tile still gets a best-effort class/score
         instead of the function silently returning nothing to compare).
    """
    label_lower = label.lower().strip()
    keywords = None
    for key, kws in LABEL_KEYWORDS.items():
        if key in label_lower or label_lower in key:
            keywords = kws
            break
    if keywords is None:
        words = re.split(r'\W+', label_lower)
        for word in words:
            if len(word) < 3: continue
            for key, kws in LABEL_KEYWORDS.items():
                if word in key or key in word:
                    keywords = kws
                    break
            if keywords: break
    if keywords is None:
        keywords = [w for w in re.split(r'\W+', label_lower) if len(w) >= 3]
    if not keywords:
        return list(range(len(_IMAGENET_CLASSES)))
    indices = []
    for i, cls_name in enumerate(_IMAGENET_CLASSES):
        cls_lower = cls_name.lower()
        if any(kw in cls_lower or cls_lower in kw for kw in keywords):
            indices.append(i)
    return indices if indices else list(range(len(_IMAGENET_CLASSES)))

sys.stderr.write('🔄 Precomputing class prototypes...\n')
sys.stderr.flush()

# Grab the final classifier layer's weight matrix (1000 x feature_dim) and
# L2-normalize each row. Each row acts as a "prototype" direction for that
# ImageNet class in embedding space; normalizing means a dot product with a
# normalized image embedding becomes a cosine similarity score.
with torch.no_grad():
    _classifier_weights = _model.classifier[-1].weight.data
    _classifier_weights = F.normalize(_classifier_weights, dim=1)

sys.stderr.write('✅ Prototypes ready\n')
sys.stderr.flush()

def extract_features(pil_img):
    """Preprocess a single PIL image and run it through the feature
    extractor, returning an L2-normalized embedding vector."""
    tensor = _preprocess(pil_img.convert('RGB')).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        feats = _feature_model(tensor)
        feats = F.normalize(feats, dim=1)
    return feats.squeeze(0)

def classify_tile(feats, class_indices):
    """Given an image embedding and a candidate subset of class indices,
    return the (class_index, cosine_similarity_score) of the best match
    among just that subset (not all 1000 classes) — restricting to the
    prompt-relevant subset avoids false positives from unrelated classes
    that happen to embed nearby."""
    if not class_indices:
        class_indices = list(range(len(_IMAGENET_CLASSES)))
    subset = _classifier_weights[class_indices]
    sims   = torch.mv(subset, feats)
    best_i = int(sims.argmax().item())
    score  = float(sims[best_i].item())
    return class_indices[best_i], score

def extract_features_multicrop(pil_img):
    """Average embeddings over 5 crops (full image + 4 overlapping 75%
    corner-biased crops) to make the match more robust to the target
    object not filling the whole tile / being off to one side, then
    re-normalize the averaged vector so it's still a unit vector for
    cosine-similarity scoring."""
    w, h = pil_img.size
    crops = [
        pil_img,
        pil_img.crop((0, 0, w*3//4, h*3//4)),
        pil_img.crop((w//4, 0, w, h*3//4)),
        pil_img.crop((0, h//4, w*3//4, h)),
        pil_img.crop((w//4, h//4, w, h)),
    ]
    feats_list = [extract_features(c) for c in crops]
    avg = torch.stack(feats_list).mean(0)
    return F.normalize(avg, dim=0)

# How close (in cosine-similarity score) a tile must be to the single best
# tile's score to also be considered a "match" and get selected.
RELATIVE_MARGIN = 0.04
# Absolute floor: a tile scoring below this is never considered a genuine
# match even if it happens to be the least-bad among a fully-mismatched set.
ABSOLUTE_MIN    = -0.05

def solve(task_label: str, image_b64_list: list) -> list:
    """Score every base64-encoded tile image against the prompt label's
    candidate ImageNet classes, then select the subset of tile indices
    that scored within RELATIVE_MARGIN of the best score (i.e. cluster near
    the top), falling back to just the single best tile if none clear the
    absolute floor. Returns the list of tile indices to click."""
    if not image_b64_list:
        return []
    class_indices = _get_class_indices(task_label)
    sys.stderr.write(f'   🎯 Label: "{task_label}" → {len(class_indices)} candidate classes\n')
    sys.stderr.flush()
    scores = []
    for i, b64 in enumerate(image_b64_list):
        try:
            img_bytes = base64.b64decode(b64)
            pil_img   = Image.open(io.BytesIO(img_bytes)).convert('RGB')
            feats     = extract_features_multicrop(pil_img)
            cls_idx, score = classify_tile(feats, class_indices)
            cls_name  = _IMAGENET_CLASSES[cls_idx]
            scores.append((i, score, cls_name))
            sys.stderr.write(f'   Tile {i}: score={score:.4f} → {cls_name}\n')
        except Exception as e:
            # Bad/corrupt tile image — record a very low score so it's
            # excluded, but keep going for the rest of the tiles.
            sys.stderr.write(f'   Tile {i} error: {e}\n')
            scores.append((i, -999.0, 'error'))
    sys.stderr.flush()
    if not scores:
        return []
    valid = [(i, s, n) for i, s, n in scores if s > ABSOLUTE_MIN]
    if not valid:
        # Nothing cleared the floor — just pick the least-bad tile so the
        # caller always gets at least one index rather than an empty click.
        scores.sort(key=lambda x: x[1], reverse=True)
        return [scores[0][0]] if scores else []
    max_score = max(s for _, s, _ in valid)
    threshold = max_score - RELATIVE_MARGIN
    selected  = [i for i, s, _ in valid if s >= threshold]
    sys.stderr.write(f'   ✅ Selected {len(selected)}/{len(image_b64_list)} tiles (threshold={threshold:.4f})\n')
    sys.stderr.flush()
    return selected

import urllib.request

def fetch_url(url: str):
    """Download a tile image by URL, spoofing a normal Chrome User-Agent
    and the hCaptcha asset host as Referer (some CDNs reject requests that
    don't look like they came from a browser tab that loaded the widget)."""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
            'Referer': 'https://newassets.hcaptcha.com/',
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()
    except Exception as e:
        sys.stderr.write(f'   fetch error: {e}\n')
        sys.stderr.flush()
        return None

def solve_urls(task_label: str, urls: list) -> list:
    """Same as solve(), but for the URL-list request variant: download each
    tile image first, base64-encode it, then delegate to solve(). A failed
    download becomes an empty-string placeholder so tile *positions* stay
    aligned with the original urls list (solve() will just score that tile
    very low / error out on it)."""
    b64_list = []
    for url in urls:
        data = fetch_url(url)
        if data:
            b64_list.append(base64.b64encode(data).decode())
        else:
            b64_list.append('')
    return solve(task_label, b64_list)

sys.stderr.write('✅ hCaptcha CNN solver ready\n')
sys.stderr.flush()

# Main request loop: one JSON object per stdin line in, one JSON object per
# stdout line out — mirrors whisper_server.py's stdio worker-process
# pattern but with a JSON payload instead of a raw file path/text line.
for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        req    = json.loads(raw_line)
        label  = req.get('task', '')
        urls   = req.get('urls', [])
        images = req.get('images', [])
        # Prefer URLs if provided (Python does the fetching itself);
        # otherwise fall back to already-base64-encoded images.
        if urls:
            indices = solve_urls(label, urls)
        else:
            indices = solve(label, images)
        print(json.dumps({'indices': indices, 'label': label}), flush=True)
    except Exception as e:
        # Malformed request or unexpected failure — respond with an error
        # object rather than crashing the process, so the persistent
        # worker keeps running for subsequent requests.
        print(json.dumps({'indices': [], 'error': str(e)}), flush=True)
