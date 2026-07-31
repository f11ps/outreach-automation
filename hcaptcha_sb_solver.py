# ════════════════════════════════════════════════════════════════════════════
# hcaptcha_sb_solver.py — SeleniumBase-CDP-driven hCaptcha checkbox solver.
#
# PURPOSE / ROLE IN THE PIPELINE:
#   This is the script that actually solves hCaptcha in the live pipeline
#   today (see the note in explained/hcaptcha_cnn_solver.py — the CNN
#   tile-classifier approach is defined in captcha/hcaptcha.js but currently
#   unused). Instead of visually classifying and clicking individual image
#   tiles, this script opens its own separate Chrome browser (via
#   SeleniumBase's CDP-mode `sb_cdp.Chrome`) pointed at the target page,
#   clicks the hCaptcha "I'm not a robot"-style checkbox using a *real*
#   CDP-dispatched mouse event (so the click is flagged `isTrusted: true`,
#   unlike a plain Selenium/JS click which sites can detect and reject),
#   and then polls the page's DOM until hCaptcha's own JS fills in a
#   passed response token — handing that token back to the caller instead
#   of trying to solve any image challenge at all. This sidesteps the
#   image-grid challenge entirely in the common case where a trusted click
#   is enough to pass hCaptcha's risk check.
#
# HOW IT WORKS (high level):
#   1. `solve_hcaptcha(url)` launches a fresh SeleniumBase CDP Chrome
#      session navigated to `url`, waits 8s for the page/widget to settle.
#   2. It searches a prioritized list of CSS selectors to locate the
#      hCaptcha checkbox iframe (covers several ways sites embed hCaptcha:
#      by src containing "checkbox", by iframe title, by generic
#      "hcaptcha" src, or by the `.h-captcha`/`h-captcha` wrapper element).
#   3. Once found, it scrolls the iframe into view and issues
#      `iframe_el.mouse_click()` — SeleniumBase's CDP-based click that uses
#      `Input.dispatchMouseEvent`, producing a genuinely trusted click event
#      rather than a synthetic DOM event. Falls back to a normal `.click()`
#      if the CDP click throws.
#   4. It then polls (up to 45 iterations x 2s sleep = 90s total) evaluating
#      JS in the page to read the hCaptcha response value, checking both
#      the standard `[name='h-captcha-response']` field and a
#      `data-hcaptcha-response` attribute some integrations use. Every 10
#      iterations (~20s) without a token it re-clicks the checkbox in case
#      the first click didn't register or a fresh render replaced the
#      widget.
#   5. Once a token of length > 10 is read, it returns it immediately.
#      If 90s elapses with no token, it gives up and returns an empty
#      string. The `finally` block always tries to stop/close the CDP
#      browser session it opened, regardless of success/failure.
#   6. The bottom of the file is the persistent worker loop: it reads a URL
#      per line from stdin, solves it, and writes the resulting token (or
#      an empty string on failure) as a single line to stdout.
#
# PROTOCOL:
#   stdin:  one target page URL per line.
#   stdout: one line per input — either the solved hCaptcha response token,
#           or an empty line if solving failed/timed out.
#   (Same persistent stdio worker-process pattern as whisper_server.py and
#   hcaptcha_cnn_solver.py — not an HTTP server, no port/socket involved.)
#
# HOW / BY WHAT IT'S INVOKED:
#   Spawned as a child process by captcha/hcaptcha.js's `getSbProc()`:
#       spawn(PYTHON, [SB_PY], { stdio: ['pipe','pipe','pipe'] })
#   where SB_PY resolves to this file. The exported `solveHcaptcha(driver)`
#   function in hcaptcha.js grabs the *current* page URL from its existing
#   Selenium `driver`, writes that URL (plus newline) to this process's
#   stdin via `sbSolve(url)`, and awaits the token line written back on
#   stdout (with a 120s timeout on the JS side, slightly longer than this
#   script's own internal 90s solve timeout, giving headroom for browser
#   startup). Once hcaptcha.js has the token string, it does NOT use the
#   SeleniumBase-controlled browser any further — it injects the token
#   directly into the *original* Selenium-driven page's hidden
#   `h-captcha-response` field via `driver.executeScript(...)` and fires
#   input/change events, so the original form-filling browser session ends
#   up "solved" even though the actual click/token-fetch happened in this
#   script's separate, throwaway browser instance.
#
# SETUP / DEPENDENCY NOTES:
#   - Requires the `seleniumbase` package (`pip install seleniumbase`),
#     specifically its `sb_cdp` CDP-mode Chrome driver.
#   - Requires a real display/X server (or Xvfb) — `DISPLAY` defaults to
#     `:0` if not already set in the environment, since headless mode is
#     more easily fingerprinted/blocked by CAPTCHA anti-bot checks than a
#     real (or virtual) display with CDP-level trusted input events.
#   - Needs Chrome/Chromium installed and reachable by SeleniumBase.
# ════════════════════════════════════════════════════════════════════════════

"""
SeleniumBase CDP hCaptcha solver.
Uses find_element + mouse_click (CDP isTrusted=true events).
Protocol: reads URL from stdin, writes token to stdout
"""
import sys, os

sys.stderr.write("🔄 Starting hCaptcha CDP solver...\n")
sys.stderr.flush()

# Ensure a DISPLAY is set (e.g. Xvfb on a headless Linux box) since this
# script drives a real, non-headless browser window for more convincing
# (trusted) input events.
os.environ.setdefault('DISPLAY', ':0')

from seleniumbase import sb_cdp

def solve_hcaptcha(url: str) -> str:
    """Open a fresh CDP-controlled Chrome session at `url`, find and
    trusted-click the hCaptcha checkbox, then poll for the resulting
    response token. Returns the token string, or '' on failure/timeout.
    Always tears down the browser session before returning."""
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en")
        sb.sleep(8)

        # Find hCaptcha checkbox iframe
        # Try selectors from most-specific to most-generic until one matches.
        iframe_el = None
        for sel in [
            'iframe[src*="hcaptcha"][src*="checkbox"]',
            'iframe[title*="hCaptcha"]',
            'iframe[src*="hcaptcha"]',
            '.h-captcha iframe',
            'h-captcha iframe',
        ]:
            try:
                if sb.is_element_present(sel):
                    iframe_el = sb.find_element(sel)
                    sys.stderr.write(f"✅ Found hCaptcha iframe: {sel}\n")
                    sys.stderr.flush()
                    break
            except: pass

        if not iframe_el:
            sys.stderr.write("❌ hCaptcha iframe not found\n")
            sys.stderr.flush()
            return ""

        # Scroll into view and click
        try:
            iframe_el.scroll_into_view()
            sb.sleep(1)
        except: pass

        sys.stderr.write("🖱️ Clicking hCaptcha checkbox via CDP...\n")
        sys.stderr.flush()

        # mouse_click uses CDP Input.dispatchMouseEvent (isTrusted=true)
        # This is the key trick: a plain Selenium/JS-triggered click sets
        # isTrusted=false on the resulting event, which anti-bot scripts
        # can detect and use to silently fail the check. Dispatching the
        # click at the CDP/OS-input level produces a trusted event instead.
        try:
            iframe_el.mouse_click()
            sys.stderr.write("✅ mouse_click done\n")
            sys.stderr.flush()
        except Exception as e:
            # Fall back to a regular click if the CDP mouse event path
            # throws for some reason (e.g. element became stale).
            sys.stderr.write(f"⚠️ mouse_click: {e} — trying click()\n")
            sys.stderr.flush()
            try:
                iframe_el.click()
            except Exception as e2:
                sys.stderr.write(f"⚠️ click: {e2}\n")
                sys.stderr.flush()

        # Wait for token up to 90s
        sys.stderr.write("⏳ Waiting for hCaptcha token...\n")
        sys.stderr.flush()

        # Poll loop: 45 iterations * 2s sleep = 90s max wait. Every 10
        # iterations (~20s) without success, re-click the checkbox in case
        # the widget reset or the first click was swallowed.
        for i in range(45):
            sb.sleep(2)
            try:
                # Evaluate JS in the page to read the hidden hCaptcha
                # response value directly out of the DOM once hCaptcha's
                # own script has populated it after a passed check.
                token = sb.loop.run_until_complete(sb.page.evaluate("""
                    () => {
                        var el = document.querySelector("[name='h-captcha-response']");
                        if (el && el.value && el.value.length > 10) return el.value;
                        // Also check data-hcaptcha-response attribute
                        var widget = document.querySelector('[data-hcaptcha-response]');
                        if (widget) {
                            var r = widget.getAttribute('data-hcaptcha-response');
                            if (r && r.length > 10) return r;
                        }
                        return '';
                    }
                """))
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass

            # Re-click every 20s
            if i > 0 and i % 10 == 0:
                try:
                    iframe_el.mouse_click()
                    sys.stderr.write("🔄 Re-clicked hCaptcha\n")
                    sys.stderr.flush()
                except: pass

        sys.stderr.write("❌ Token not obtained after 90s\n")
        sys.stderr.flush()
        return ""

    except Exception as e:
        sys.stderr.write(f"❌ Error: {e}\n")
        sys.stderr.flush()
        return ""
    finally:
        # Always try to tear down the throwaway CDP browser session,
        # regardless of whether solving succeeded, failed, or errored.
        if sb:
            try: sb.driver.stop()
            except: pass

sys.stderr.write("✅ hCaptcha CDP solver ready\n")
sys.stderr.flush()

# Main loop — persistent worker process reading one target URL per line
# from stdin (written by captcha/hcaptcha.js's sbSolve()) and writing back
# exactly one line (the token, or blank on failure) per input line.
for line in sys.stdin:
    url = line.strip()
    if not url:
        print("", flush=True)
        continue
    sys.stderr.write(f"🌐 Solving for: {url}\n")
    sys.stderr.flush()
    token = solve_hcaptcha(url)
    print(token, flush=True)
