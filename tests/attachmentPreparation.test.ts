import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAttachmentInputs } from '../src/attachmentPreparation';
import type { AttachmentInput } from '../src/types';

function item(filename: string, type: string, data = 'source pixels'): AttachmentInput {
  return { id: filename, filename, bytes: new NodeBlob([Uint8Array.from(data, char => char.charCodeAt(0))], { type }) as Blob };
}

function encoder(width = 4000, height = 3000, size = (w: number, h: number) => Math.ceil(w * h / 4)) {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width, height, close }));
  vi.stubGlobal('createImageBitmap', decode);
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    callback(new NodeBlob([new Uint8Array(size(this.width, this.height))], { type }) as Blob);
  });
  return { close, decode, draw, encode };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared image preparation', () => {
  it('keeps documents and SVG byte objects, names and types unchanged', async () => {
    const platform = encoder();
    const inputs = [item('guide.pdf', 'application/pdf'), item('art.svg', 'image/svg+xml', '<svg/>'),
      item('vector', '', '<?xml version="1.0"?><svg/>'), item('data.bin', 'application/octet-stream')];
    const prepared = await prepareAttachmentInputs(inputs, new AbortController().signal);
    expect(prepared).toEqual(inputs);
    prepared.forEach((output, index) => expect(output.bytes).toBe(inputs[index].bytes));
    expect(platform.decode).not.toHaveBeenCalled();
  });

  it.each([
    ['portrait.HEIC', 'image/heic', 'source', 'portrait.jpg', 'image/jpeg'],
    ['photo.heif', '', 'source', 'photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg', 'source', 'photo.jpeg', 'image/jpeg'],
    ['capture.png', 'image/png', 'source', 'capture.png', 'image/png'],
    ['animation.gif', 'image/gif', 'GIF89a', 'animation.png', 'image/png'],
    ['animation.webp', 'image/webp', 'RIFF0000WEBP', 'animation.png', 'image/png'],
    ['scan.tiff', '', 'source', 'scan.png', 'image/png'],
    ['scan.bmp', '', 'source', 'scan.png', 'image/png'],
    ['hidden.dat', '', '\x89PNG\r\n\x1a\n', 'hidden.dat', 'image/png'],
    ['', 'image/heic', 'source', 'image.jpg', 'image/jpeg'],
  ])('prepares %s as a still JPEG/PNG with its required name', async (name, type, data, outputName, outputType) => {
    const platform = encoder();
    const input = item(name, type, data);
    const [output] = await prepareAttachmentInputs([input], new AbortController().signal);
    expect(output).toMatchObject({ filename: outputName });
    expect(output.bytes.type).toBe(outputType);
    expect(output.bytes).not.toBe(input.bytes);
    expect(platform.decode).toHaveBeenCalledWith(input.bytes, { imageOrientation: 'from-image' });
    expect(platform.draw.mock.calls[0].slice(1)).toEqual([0, 0, 1536, 1152]);
    expect(output.bytes.size).toBeLessThanOrEqual(1024 * 1024);
    expect(platform.close).toHaveBeenCalledOnce();
  });

  it('reuses the exact prepared preview bytes instead of encoding them again for submission', async () => {
    const platform = encoder();
    const signal = new AbortController().signal;
    const preview = await prepareAttachmentInputs([item('camera.heic', 'image/heic')], signal);
    const submission = await prepareAttachmentInputs(preview, signal);
    expect(submission[0].bytes).toBe(preview[0].bytes);
    expect(submission[0].filename).toBe(preview[0].filename);
    expect(platform.decode).toHaveBeenCalledOnce();
    expect(platform.encode).toHaveBeenCalledOnce();
    expect(Object.isFrozen(submission)).toBe(true);
  });

  it('sizes all images together to recorded request and upload budgets without dropping items', async () => {
    encoder();
    const inputs = [item('one.png', 'image/png'), item('two.png', 'image/png'), item('notes.pdf', 'application/pdf')];
    const prepared = await prepareAttachmentInputs(inputs, new AbortController().signal,
      { maxInlineImageTotalBytes: 40_000, maxAttachmentBytes: 25_000, maxTotalBytes: 35_000 });
    expect(prepared).toHaveLength(3);
    expect(prepared.reduce((n, output) => n + output.bytes.size, 0)).toBeLessThanOrEqual(35_000);
    expect(prepared[2].bytes).toBe(inputs[2].bytes);
  });

  it('does not invent an image count rejection or treat residual route overflow as failure', async () => {
    encoder(1, 1, () => 100);
    const inputs = Array.from({ length: 20 }, (_, i) => item(`${i}.png`, 'image/png'));
    const prepared = await prepareAttachmentInputs(inputs, new AbortController().signal, { maxInlineImageTotalBytes: 10 });
    expect(prepared).toHaveLength(20);
    expect(prepared.every(output => output.bytes.type === 'image/png')).toBe(true);
  });

  it('names an undecodable image and its position instead of treating it as a generic file', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
    vi.stubGlobal('Image', class { src = ''; decode = async () => { throw new Error('unsupported'); }; });
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: revoke });
    await expect(prepareAttachmentInputs([item('notes.pdf', 'application/pdf'), item('portrait.HEIC', '')],
      new AbortController().signal)).rejects.toMatchObject({ code: 'image-unreadable', attachmentIndex: 1,
        message: 'Cannot read portrait.HEIC in its image format on this device.' });
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('uses the client image decoder when bitmap decoding is unavailable', async () => {
    const platform = encoder();
    platform.decode.mockRejectedValue(new Error('unsupported bitmap decoder'));
    const decode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 120; naturalHeight = 240; decode = decode; });
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:camera', revokeObjectURL: revoke });
    const [output] = await prepareAttachmentInputs([item('camera.heic', 'image/heic')], new AbortController().signal);
    expect(output.bytes.type).toBe('image/jpeg');
    expect(decode).toHaveBeenCalledOnce();
    expect(platform.draw.mock.calls[0].slice(1)).toEqual([0, 0, 120, 240]);
    expect(revoke).toHaveBeenCalledWith('blob:camera');
  });

  it('cancels preparation without leaking the decoded bitmap or returning uploadable output', async () => {
    const controller = new AbortController();
    const platform = encoder();
    platform.decode.mockImplementation(async () => {
      controller.abort(); return { width: 12, height: 12, close: platform.close };
    });
    await expect(prepareAttachmentInputs([item('photo.png', 'image/png')], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(platform.close).toHaveBeenCalledOnce();
    expect(platform.encode).not.toHaveBeenCalled();
  });
});
