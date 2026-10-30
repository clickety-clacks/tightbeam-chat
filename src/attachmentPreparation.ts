import { AttachmentPreparationError, type AttachmentInput, type AttachmentCapabilities } from './types';

// These are encoding targets, not upload quotas or claims about an agent route.
const longestEdge = 1536;
const encodedTarget = 1024 * 1024;
const converted = new WeakSet<Blob>();

async function head(blob: Blob, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const part = blob.slice(0, 512);
  if (part.arrayBuffer) return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener('abort', abort, { once: true });
    reader.onloadend = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (reader.error) reject(reader.error);
      else resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.readAsArrayBuffer(part);
  });
}

async function imageFormat(input: AttachmentInput, signal: AbortSignal): Promise<string | undefined> {
  const bytes = await head(input.bytes, signal);
  const text = String.fromCharCode(...bytes);
  const type = input.bytes.type.toLowerCase().split(';')[0];
  const extension = input.filename.split('.').pop()?.toLowerCase();
  // SVG is a document even when acquired through an image input.
  if (type === 'image/svg+xml' || extension === 'svg' || /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text)) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (text.startsWith('\x89PNG\r\n\x1a\n')) return 'png';
  if (/^GIF8[79]a/.test(text)) return 'gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'webp';
  if (text.startsWith('II*\0') || text.startsWith('MM\0*')) return 'tiff';
  if (text.startsWith('BM')) return 'bmp';
  if (text.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(text.slice(8))) return 'heic';
  const named = extension === 'jpg' ? 'jpeg' : extension === 'heif' ? 'heic' : extension;
  if (named && ['jpeg', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'heic'].includes(named)) return named;
  if (type.startsWith('image/')) return type.slice(6).replace('jpg', 'jpeg').replace('heif', 'heic');
  return undefined;
}

async function decode(bytes: Blob, signal: AbortSignal): Promise<{
  source: CanvasImageSource; width: number; height: number; close(): void;
}> {
  signal.throwIfAborted();
  if (typeof createImageBitmap === 'function') {
    try {
      // Bake EXIF orientation into the pixels; the canvas output has no camera orientation tag.
      const bitmap = await createImageBitmap(bytes, { imageOrientation: 'from-image' });
      if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch (error) {
      if (signal.aborted) throw error;
      // Some clients support a format in <img> but not createImageBitmap.
    }
  }
  const url = URL.createObjectURL(bytes);
  const image = new Image();
  const abort = () => { image.src = ''; };
  signal.addEventListener('abort', abort, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight,
      close: () => { image.src = ''; URL.revokeObjectURL(url); } };
  } catch (error) {
    image.src = ''; URL.revokeObjectURL(url); throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function convert(input: AttachmentInput, format: string, target: number, signal: AbortSignal): Promise<AttachmentInput> {
  if (converted.has(input.bytes) && input.bytes.size <= target) return input;
  const bitmap = await decode(input.bytes, signal);
  const canvas = document.createElement('canvas');
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('Image has no pixels.');
    const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    const type = format === 'jpeg' || format === 'heic' ? 'image/jpeg' : 'image/png';
    let bytes: Blob;
    do {
      signal.throwIfAborted();
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image conversion is unavailable.');
      context.drawImage(bitmap.source, 0, 0, width, height);
      bytes = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        value => value?.size ? resolve(value) : reject(new Error('Image encoding failed.')), type, 0.85));
      signal.throwIfAborted();
      if (bytes.type !== 'image/jpeg' && bytes.type !== 'image/png') throw new Error('Image encoding failed.');
      if (bytes.size <= target || (width === 1 && height === 1)) break;
      const smaller = Math.min(0.8, Math.sqrt(target / bytes.size) * 0.9);
      width = Math.max(1, Math.floor(width * smaller));
      height = Math.max(1, Math.floor(height * smaller));
    } while (true);
    const outputFormat = bytes.type === 'image/jpeg' ? 'jpeg' : 'png';
    const extension = outputFormat === 'jpeg' ? 'jpg' : 'png';
    const name = input.filename || 'image';
    const filename = format === outputFormat && input.filename ? input.filename
      : name.replace(/\.[^.]+$/, '') + '.' + extension;
    converted.add(bytes);
    return Object.freeze({ id: input.id, filename, bytes });
  } finally {
    bitmap.close(); canvas.width = 0; canvas.height = 0;
  }
}

/** Shared acquisition/submission preparation. Preview and submit these returned blobs unchanged. */
export async function prepareAttachmentInputs(inputs: readonly AttachmentInput[], signal: AbortSignal,
  targets: AttachmentCapabilities = {}): Promise<readonly AttachmentInput[]> {
  const captured = inputs.map(input => Object.freeze({ id: input.id, filename: input.filename, bytes: input.bytes }));
  const formats: (string | undefined)[] = [];
  for (let index = 0; index < captured.length; index++) {
    try { formats.push(await imageFormat(captured[index], signal)); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new AttachmentPreparationError(index, 'image-unreadable', `Cannot read ${captured[index].filename || 'image'} on this device.`);
    }
  }
  const count = formats.filter(Boolean).length;
  const valid = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : Infinity;
  const documentBytes = captured.reduce((size, input, index) => size + (formats[index] ? 0 : input.bytes.size), 0);
  const target = Math.max(1, Math.floor(Math.min(encodedTarget, valid(targets.maxInlineImageBytes),
    valid(targets.maxAttachmentBytes), valid(targets.maxInlineImageTotalBytes) / Math.max(1, count),
    (valid(targets.maxTotalBytes) - documentBytes) / Math.max(1, count))));
  const result: AttachmentInput[] = [];
  for (let index = 0; index < captured.length; index++) {
    signal.throwIfAborted();
    const input = captured[index];
    try {
      result.push(formats[index] ? await convert(input, formats[index]!, target, signal) : input);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AttachmentPreparationError(index, 'image-unreadable',
        `Cannot read ${input.filename || 'image'} in its image format on this device.`);
    }
  }
  return Object.freeze(result);
}
