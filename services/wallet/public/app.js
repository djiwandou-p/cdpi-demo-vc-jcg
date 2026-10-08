// Thin wallet web UI logic (no framework, no build step — plain ES module).
//
// Design: Components -> Wallet Service -> Web UI (thin). The UI talks ONLY to
// the same-origin wallet BFF and carries the `sid` session cookie automatically
// (fetch with credentials: 'same-origin').
//
// Key behaviours:
//   - Paste and scan feed ONE normalization path: both just set the same input
//     string, then the normal submit runs (mirrors design Property 4,
//     paste/scan equivalence, at the UI layer).
//   - QR scanning is a progressive enhancement. The jsQR decoder is loaded from
//     a pinned CDN only when the user asks to scan; if the camera or the library
//     is unavailable we fall back / inform the user and paste still works.
//   - On an invalid-offer 400 the stored-credential panel is left UNCHANGED
//     (Req 2.5): we only touch the confirmation panel on a successful offer.

// Pinned CDN URL for the QR decoder (image/camera -> decoded string). Pinned to
// an exact version so behaviour is reproducible; loaded lazily on first scan.
const JSQR_CDN_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Set a status line's text and visual state.
 * @param {HTMLElement} node
 * @param {string} message
 * @param {'' | 'error' | 'success'} [kind]
 */
function setStatus(node, message, kind = '') {
  node.textContent = message;
  node.classList.remove('error', 'success');
  if (kind) {
    node.classList.add(kind);
  }
}

// ---------------------------------------------------------------------------
// BFF client — all requests are same-origin and send the sid cookie.
// ---------------------------------------------------------------------------

/**
 * POST JSON to the BFF. On a non-2xx response, read the JSON error envelope
 * ({ success:false, error:{ step, message, code? } }) and throw an Error whose
 * message is "step: message" so callers can surface attribution.
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @returns {Promise<any>}
 */
async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', // send the sid session cookie
    body: JSON.stringify(body),
  });

  const payload = await readJsonSafe(res);

  if (!res.ok) {
    const error = payload && payload.error ? payload.error : undefined;
    const step = error && error.step ? String(error.step) : 'error';
    const message =
      error && error.message
        ? String(error.message)
        : `Request failed with status ${res.status}.`;
    const err = new Error(message);
    // Attach the step so callers can show "step: message".
    /** @type {any} */ (err).step = step;
    throw err;
  }

  return payload;
}

/**
 * GET JSON from the BFF (same-origin, with cookie). Returns { status, body }.
 * @param {string} path
 */
async function getJson(path) {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  const body = await readJsonSafe(res);
  return { status: res.status, ok: res.ok, body };
}

/** Parse a JSON response body, tolerating empty / non-JSON bodies. */
async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Section 1 — Hold a credential
// ---------------------------------------------------------------------------

const offerForm = /** @type {HTMLFormElement} */ (el('offer-form'));
const offerInput = /** @type {HTMLTextAreaElement} */ (el('offer-input'));
const offerStatus = el('offer-status');
const acceptBtn = /** @type {HTMLButtonElement} */ (el('accept-offer-btn'));
const credentialPanel = el('credential-panel');

/**
 * Accept the pasted/scanned offer: POST /wallet/offer, then on success refresh
 * the stored-credential confirmation panel from GET /wallet/credential.
 */
async function submitOffer() {
  const offer = offerInput.value.trim();
  if (!offer) {
    setStatus(offerStatus, 'Enter or scan a credential offer first.', 'error');
    offerInput.focus();
    return;
  }

  acceptBtn.disabled = true;
  setStatus(offerStatus, 'Accepting offer and running issuance\u2026');

  try {
    const result = await postJson('/wallet/offer', { offer });
    setStatus(
      offerStatus,
      `Credential stored (${result.vct || 'credential'}).`,
      'success',
    );
    // Only on success do we refresh the confirmation panel. An invalid offer
    // takes the catch branch below and leaves this panel untouched (Req 2.5).
    await refreshStoredCredential();
  } catch (err) {
    // Invalid-offer (400) and issuance errors (502) both land here. We surface
    // "step: message" and DO NOT modify the stored-credential panel.
    const step = /** @type {any} */ (err).step;
    const prefix = step ? `${step}: ` : '';
    setStatus(offerStatus, `${prefix}${errMessage(err)}`, 'error');
  } finally {
    acceptBtn.disabled = false;
  }
}

/**
 * Refresh the stored-credential confirmation panel from GET /wallet/credential.
 * 200 -> show vct + format + "stored"; 404 -> hide (no credential yet).
 */
async function refreshStoredCredential() {
  const { status, ok, body } = await getJson('/wallet/credential');
  if (ok && body && body.stored) {
    el('credential-vct').textContent = body.vct || '\u2014';
    el('credential-format').textContent = body.format || '\u2014';
    credentialPanel.hidden = false;
  } else if (status === 404) {
    // No credential stored for this session — keep the panel hidden.
    credentialPanel.hidden = true;
  }
}

offerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitOffer();
});

// Wire the offer scan button (QR -> decoded string -> same textarea/flow).
wireScan({
  triggerBtn: /** @type {HTMLButtonElement} */ (el('offer-scan-btn')),
  fileInput: /** @type {HTMLInputElement} */ (el('offer-scan-file')),
  targetInput: offerInput,
  statusNode: offerStatus,
});

// ---------------------------------------------------------------------------
// Section 2 — Present a credential
// ---------------------------------------------------------------------------

const presentForm = /** @type {HTMLFormElement} */ (el('present-form'));
const presentInput = /** @type {HTMLTextAreaElement} */ (el('present-input'));
const presentStatus = el('present-status');
const presentBtn = /** @type {HTMLButtonElement} */ (el('present-btn'));
const resultPanel = el('result-panel');
const resultSummary = el('result-summary');
const resultClaimsWrap = el('result-claims-wrap');
const resultClaims = el('result-claims');

/**
 * Submit the presentation request: POST /wallet/present, then render the
 * VerificationResult (success + disclosedClaims, or failure step + message).
 */
async function submitPresentation() {
  const request = presentInput.value.trim();
  if (!request) {
    setStatus(presentStatus, 'Enter or scan a presentation request first.', 'error');
    presentInput.focus();
    return;
  }

  presentBtn.disabled = true;
  setStatus(presentStatus, 'Building presentation and submitting\u2026');

  try {
    // /wallet/present returns 200 with the VerificationResult even for a
    // verify-step failure, so a successful fetch still may carry success:false.
    const result = await postJson('/wallet/present', { request });
    renderVerificationResult(result);
  } catch (err) {
    // Non-2xx (e.g. no stored credential, bad request) — surface step + message.
    const step = /** @type {any} */ (err).step;
    const prefix = step ? `${step}: ` : '';
    setStatus(presentStatus, `${prefix}${errMessage(err)}`, 'error');
    resultPanel.hidden = true;
  } finally {
    presentBtn.disabled = false;
  }
}

/**
 * Render a VerificationResult into the result panel.
 * @param {{ success?: boolean, disclosedClaims?: Record<string, unknown>, error?: { step?: string, message?: string } }} result
 */
function renderVerificationResult(result) {
  resultPanel.hidden = false;
  resultPanel.classList.remove('result-ok', 'result-fail');

  if (result && result.success) {
    setStatus(presentStatus, 'Presentation verified.', 'success');
    resultPanel.classList.add('result-ok');
    resultSummary.textContent = '\u2714 Verified. Only the requested claims were disclosed.';
    renderClaims(result.disclosedClaims);
  } else {
    const step = result && result.error ? result.error.step : undefined;
    const message = result && result.error ? result.error.message : 'Verification failed.';
    setStatus(presentStatus, 'Presentation failed verification.', 'error');
    resultPanel.classList.add('result-fail');
    resultSummary.textContent = `\u2717 ${step ? step + ': ' : ''}${message || 'Verification failed.'}`;
    // No claims to show on failure.
    resultClaimsWrap.hidden = true;
    resultClaims.replaceChildren();
  }
}

/**
 * Render disclosed claims as a definition list. For the demo this should show
 * degree + institution and NOT grades (selective disclosure).
 * @param {Record<string, unknown> | undefined} claims
 */
function renderClaims(claims) {
  resultClaims.replaceChildren();
  const entries = claims ? Object.entries(claims) : [];
  if (entries.length === 0) {
    resultClaimsWrap.hidden = true;
    return;
  }
  for (const [key, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    resultClaims.append(dt, dd);
  }
  resultClaimsWrap.hidden = false;
}

presentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitPresentation();
});

// Wire the presentation scan button (QR -> decoded string -> same textarea/flow).
wireScan({
  triggerBtn: /** @type {HTMLButtonElement} */ (el('present-scan-btn')),
  fileInput: /** @type {HTMLInputElement} */ (el('present-scan-file')),
  targetInput: presentInput,
  statusNode: presentStatus,
});

// ---------------------------------------------------------------------------
// QR scanning (progressive enhancement)
// ---------------------------------------------------------------------------

// Lazily-loaded reference to the jsQR decode function (loaded on first scan).
let jsQrPromise = null;

/**
 * Load the pinned jsQR library on demand. Resolves to the global `jsQR`
 * function, or rejects if the CDN is unreachable (so scan degrades to paste).
 * @returns {Promise<(data: Uint8ClampedArray, w: number, h: number) => ({ data: string } | null)>}
 */
function loadJsQr() {
  if (window.jsQR) {
    return Promise.resolve(window.jsQR);
  }
  if (!jsQrPromise) {
    jsQrPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = JSQR_CDN_URL;
      script.async = true;
      script.onload = () =>
        window.jsQR
          ? resolve(window.jsQR)
          : reject(new Error('QR library loaded but unavailable.'));
      script.onerror = () => reject(new Error('Could not load the QR scanning library.'));
      document.head.appendChild(script);
    });
  }
  return jsQrPromise;
}

/**
 * Wire a "Scan QR" button + hidden file input to decode a QR image into the
 * given target textarea. Decoding runs client-side; the decoded string flows
 * through the SAME normalization/submit path as pasted text. Image upload
 * (with `capture=environment`) covers both camera capture on mobile and file
 * selection on desktop, keeping the implementation dependency-light.
 *
 * @param {{
 *   triggerBtn: HTMLButtonElement,
 *   fileInput: HTMLInputElement,
 *   targetInput: HTMLTextAreaElement,
 *   statusNode: HTMLElement,
 * }} opts
 */
function wireScan({ triggerBtn, fileInput, targetInput, statusNode }) {
  // The button simply opens the image picker / camera. If the browser cannot
  // decode we tell the user to paste instead — paste always works.
  triggerBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    // Reset so selecting the same file again re-triggers 'change'.
    fileInput.value = '';
    if (!file) {
      return;
    }

    setStatus(statusNode, 'Decoding QR code\u2026');
    try {
      const decoded = await decodeQrFromImageFile(file);
      if (!decoded) {
        setStatus(
          statusNode,
          'No QR code found in that image. You can paste the value instead.',
          'error',
        );
        return;
      }
      // Feed the SAME input the paste path uses, then clear the status.
      targetInput.value = decoded;
      targetInput.focus();
      setStatus(statusNode, 'QR decoded. Review the value, then submit.', 'success');
    } catch (err) {
      // Library/CDN unavailable or decode failure — graceful fallback to paste.
      setStatus(
        statusNode,
        `Scan unavailable (${errMessage(err)}). Please paste the value instead.`,
        'error',
      );
    }
  });
}

/**
 * Decode a QR code from an image File using jsQR + an offscreen canvas.
 * @param {File} file
 * @returns {Promise<string | null>} the decoded string, or null if none found.
 */
async function decodeQrFromImageFile(file) {
  const jsQR = await loadJsQr();
  const bitmap = await loadImageBitmap(file);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas is unavailable in this browser.');
  }
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const result = jsQR(imageData.data, imageData.width, imageData.height);
  return result ? result.data : null;
}

/**
 * Load a File into something drawable on a canvas. Prefers createImageBitmap
 * (fast, decodes off the main thread) and falls back to an <img> element.
 * @param {File} file
 * @returns {Promise<ImageBitmap | HTMLImageElement>}
 */
async function loadImageBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path below
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the selected image.'));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** @param {unknown} err */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// On load, reflect any already-stored credential (e.g. after a page refresh in
// the same session) so the confirmation panel is accurate.
void refreshStoredCredential().catch(() => {
  /* ignore — nothing stored yet or backend not reachable at load time */
});
