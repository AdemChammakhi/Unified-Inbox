/**
 * compressImage.js — shrink a screenshot before it travels inside a ticket.
 *
 * The Better Call Fedi wire contract stores screenshots as base64 *inside* the
 * ticket document — there is no storage bucket, and MongoDB caps a document at
 * 16MB. The contract asks for at most ~1280px on the longest side and JPEG at
 * ~80% quality (≈300KB, ≈400KB once base64-encoded), so we do that work here
 * rather than shipping a 4MB phone screenshot straight into the database.
 */

const MAX_EDGE = 1280;
const QUALITY = 0.8;
/** Contract target: ~300KB raw per image. */
const TARGET_BYTES = 300 * 1024;

/**
 * @param {File} file
 * @returns {Promise<{dataUrl: string, bytes: number, name: string}>}
 */
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Only image files can be attached"));
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));

      const ctx = canvas.getContext("2d");
      // JPEG has no alpha — paint white so transparent PNGs don't go black
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Step the quality down if the first pass is still heavy
      let quality = QUALITY;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      while (rawBytes(dataUrl) > TARGET_BYTES && quality > 0.45) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }

      resolve({ dataUrl, bytes: rawBytes(dataUrl), name: file.name });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image"));
    };

    img.src = url;
  });
}

/** Approximate decoded size of a data: URL's base64 payload. */
function rawBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.round((base64.length * 3) / 4);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
