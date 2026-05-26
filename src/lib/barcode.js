/**
 * Server-side UPC-A / EAN-13 barcode rendering for Checklane tag batches.
 */

const bwipjs = require('bwip-js');

function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/** UPC-A check digit from the first 11 data digits. */
function upcCheckDigit(elevenDigits) {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const d = Number(elevenDigits[i]);
    sum += (i % 2 === 0) ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** EAN-13 check digit from the first 12 data digits. */
function ean13CheckDigit(twelveDigits) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = Number(twelveDigits[i]);
    sum += (i % 2 === 0) ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function bufferToDataUrl(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function renderSymbology(bcid, text) {
  const buffer = await bwipjs.toBuffer({
    bcid,
    text,
    scale: 4,
    height: 14,
    includetext: false,
    backgroundcolor: 'FFFFFF',
    paddingwidth: 10,
    paddingheight: 8,
  });
  return {
    symbology: bcid === 'upca' ? 'UPC-A' : 'EAN-13',
    text,
    buffer,
    dataUrl: bufferToDataUrl(buffer),
  };
}

/**
 * Validate a UPC string and classify symbology without rendering.
 * @returns {{ valid: boolean, reason?: string, normalized?: string, symbology?: string, displayDigits?: string, ean13Fallback?: string }}
 */
function validateUpc(rawUpc) {
  const raw = String(rawUpc || '').trim();
  const digits = digitsOnly(raw);

  if (!digits.length) {
    return { valid: false, reason: 'empty or non-numeric' };
  }
  if (raw.replace(/\s/g, '') !== digits && /[^\d\s]/.test(raw)) {
    return { valid: false, reason: 'non-numeric characters', raw };
  }

  if (digits.length === 11) {
    const check = upcCheckDigit(digits);
    const upc12 = digits + String(check);
    return {
      valid: true,
      symbology: 'UPC-A',
      normalized: upc12,
      displayDigits: upc12,
      ean13Fallback: `0${upc12}`,
    };
  }

  if (digits.length === 12) {
    const expected = upcCheckDigit(digits.slice(0, 11));
    if (Number(digits[11]) !== expected) {
      return { valid: false, reason: 'bad UPC-A check digit', raw: digits };
    }
    return {
      valid: true,
      symbology: 'UPC-A',
      normalized: digits,
      displayDigits: digits,
      ean13Fallback: `0${digits}`,
    };
  }

  if (digits.length === 13) {
    const expected = ean13CheckDigit(digits.slice(0, 12));
    if (Number(digits[12]) !== expected) {
      return { valid: false, reason: 'bad EAN-13 check digit', raw: digits };
    }
    return {
      valid: true,
      symbology: 'EAN-13',
      normalized: digits,
      displayDigits: digits,
    };
  }

  return { valid: false, reason: `invalid length (${digits.length} digits)`, raw: digits };
}

/**
 * Render barcode PNG(s) for a UPC string.
 * @returns {Promise<{ valid: boolean, reason?: string, raw?: string, displayDigits?: string, primary?: object, fallback?: object }>}
 */
async function generateBarcode(rawUpc) {
  const validation = validateUpc(rawUpc);
  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      raw: validation.raw || String(rawUpc || ''),
    };
  }

  try {
    if (validation.symbology === 'UPC-A') {
      const primary = await renderSymbology('upca', validation.normalized);
      let fallback;
      if (validation.ean13Fallback) {
        fallback = await renderSymbology('ean13', validation.ean13Fallback);
      }
      return {
        valid: true,
        displayDigits: validation.displayDigits,
        primary,
        fallback,
      };
    }

    const primary = await renderSymbology('ean13', validation.normalized);
    return {
      valid: true,
      displayDigits: validation.displayDigits,
      primary,
    };
  } catch (err) {
    return {
      valid: false,
      reason: err.message || 'barcode render failed',
      raw: validation.raw || String(rawUpc || ''),
    };
  }
}

module.exports = {
  digitsOnly,
  validateUpc,
  generateBarcode,
  upcCheckDigit,
  ean13CheckDigit,
};
