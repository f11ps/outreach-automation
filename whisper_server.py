#!/usr/bin/env python3
# ════════════════════════════════════════════════════════════════════════════
# whisper_server.py — Persistent audio-transcription worker for reCAPTCHA audio
#                      challenges (speech-to-text via OpenAI Whisper).
#
# PURPOSE / ROLE IN THE PIPELINE:
#   reCAPTCHA v2's "I'm not a robot" checkbox sometimes falls back to an
#   image challenge, but it also always offers an *audio* challenge option
#   (the little headphone icon) which is much easier to automate than image
#   grids: Google reads out a short string of words/numbers as an MP3, and
#   whoever types that string back into the response box passes the check.
#   This script is the piece that turns that MP3 audio into text so
#   captcha/recaptcha.js can type the result into the challenge's answer box.
#
# HOW IT WORKS (high level):
#   1. On startup, it monkey-patches Python's SSL module so certificate
#      verification is disabled (works around cert issues when Whisper/pydub
#      download or open files on this machine), then loads the small/fast
#      "tiny" Whisper model into memory once (loading is the slow part, so
#      it's done a single time at process start, not per-request).
#   2. It optionally imports `pydub` — if present, incoming MP3 files can be
#      converted to WAV before being handed to Whisper (some Whisper/ffmpeg
#      setups are happier with WAV input).
#   3. `transcribe(audio_path)` runs the actual Whisper transcription: it
#      converts mp3 -> wav if pydub is available, calls `model.transcribe`,
#      then lower-cases the result and strips everything except letters,
#      digits and spaces (reCAPTCHA answers are just alphanumeric words, so
#      punctuation from Whisper's output would only cause mismatches).
#   4. The script never exits on its own — it sits in an infinite loop
#      reading lines from stdin. This makes it a persistent "worker
#      process" (NOT a network/HTTP server: there is no socket, no port,
#      no HTTP framework). Each line of stdin is expected to be a filesystem
#      path to a downloaded audio file. For each line it transcribes the
#      file (or prints an empty line if the path doesn't exist) and writes
#      exactly one line of plain text to stdout, flushing immediately so
#      the caller sees the result right away.
#
# HOW / BY WHAT IT'S INVOKED:
#   It is not run directly by a human and it is not an HTTP server that
#   something connects to over a port. Instead, captcha/recaptcha.js spawns
#   it as a long-lived OS child process:
#       spawn(python, ['whisper_server.py'], { stdio: ['pipe','pipe','pipe'] })
#   and keeps that single process alive for the lifetime of the Node
#   program (see `getWhisper()` in recaptcha.js), reusing it across many
#   reCAPTCHA solves so the (slow) model-loading step only happens once.
#   Node writes an audio file path to the child's stdin followed by '\n',
#   and reads the corresponding transcribed-text line back from the
#   child's stdout. Progress/status/error messages are written to stderr
#   (prefixed with emoji) purely for logging — they are not part of the
#   request/response protocol.
#
# SETUP / DEPENDENCY NOTES:
#   - Requires Python 3 with the `openai-whisper` package installed
#     (`pip install openai-whisper`), which in turn depends on `ffmpeg`
#     being available on PATH for audio decoding.
#   - `pydub` is optional; if missing, mp3 files are passed to Whisper as-is
#     instead of being pre-converted to wav.
#   - Uses the "tiny" Whisper model for speed (lower accuracy than larger
#     models, but audio CAPTCHA phrases are short/simple so it's normally
#     sufficient, and speed matters since this blocks the form-fill flow).
# ════════════════════════════════════════════════════════════════════════════

import sys, re, os, ssl

# Fix SSL cert verification on this system
ssl._create_default_https_context = ssl._create_unverified_context

sys.stderr.write("🔄 Loading Whisper tiny model...\n")
sys.stderr.flush()

# Load the Whisper "tiny" model once at process startup. This is the
# expensive part (can take a few seconds), which is exactly why this file
# is run as a persistent worker process instead of being invoked fresh
# for every single CAPTCHA — restarting it per-request would re-pay this
# cost every time.
try:
    import whisper
    model = whisper.load_model("tiny")
    sys.stderr.write("✅ Whisper model loaded\n")
    sys.stderr.flush()
except Exception as e:
    # If the model can't load, there's nothing useful this process can do,
    # so exit immediately — the Node side will see the process die and
    # treat every pending/future transcribe request as failed.
    sys.stderr.write(f"❌ Whisper load failed: {e}\n")
    sys.stderr.flush()
    sys.exit(1)

# pydub (ffmpeg wrapper) is optional — only used to pre-convert mp3 -> wav.
try:
    from pydub import AudioSegment
    HAS_PYDUB = True
except ImportError:
    HAS_PYDUB = False

def transcribe(audio_path):
    """Transcribe a single audio file on disk and return cleaned text.

    Converts mp3 -> wav via pydub when available (some Whisper/ffmpeg
    combinations handle wav more reliably), runs Whisper in English with
    fp16 disabled (fp16 requires a CUDA GPU; running in fp32 keeps this
    working on CPU-only machines), then strips the transcription down to
    just lowercase letters/digits/spaces since that's the character set
    reCAPTCHA audio-answer boxes expect — any stray punctuation Whisper
    might emit would cause an otherwise-correct answer to be rejected.
    """
    try:
        wav = audio_path
        if audio_path.endswith('.mp3') and HAS_PYDUB:
            wav = audio_path.replace('.mp3', '.wav')
            AudioSegment.from_mp3(audio_path).export(wav, format='wav')
        result = model.transcribe(wav, language='en', fp16=False)
        text = re.sub(r'[^a-z0-9 ]+', '', result['text'].lower()).strip()
        return text
    except Exception as e:
        sys.stderr.write(f"⚠️ Transcribe error: {e}\n")
        sys.stderr.flush()
        return ''

# Main loop — read path from stdin, write result to stdout
# This is the request/response protocol: the parent Node.js process
# (captcha/recaptcha.js) writes one audio file path per line to this
# script's stdin; this loop blocks on `for line in sys.stdin` until a line
# arrives, transcribes that file, and writes exactly one line back to
# stdout (flushed immediately so the parent isn't left waiting on a
# buffered pipe). The loop runs forever, keeping the model resident in
# memory so repeated CAPTCHA solves are fast after the first one.
for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    if not os.path.exists(path):
        # Audio file wasn't downloaded/found — respond with an empty line
        # rather than raising, so the caller's read-loop protocol never
        # gets out of sync (one line in always yields exactly one line out).
        print('', flush=True)
        continue
    result = transcribe(path)
    print(result, flush=True)
