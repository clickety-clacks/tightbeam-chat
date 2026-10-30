import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MessageAttachments,
  type ImageAttachmentReference,
  type ReadImageAttachment,
} from '../src/MessageAttachments';

let createObjectUrlDescriptor: PropertyDescriptor | undefined;
let revokeObjectUrlDescriptor: PropertyDescriptor | undefined;
let revokeObjectUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview'),
  });
  revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl,
  });
});

afterEach(() => {
  cleanup();
  if (createObjectUrlDescriptor) {
    Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL');
  }
  if (revokeObjectUrlDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
});

describe('message image attachments', () => {
  it('renders inline image bytes without exposing image attachment JSON', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
    const src = 'data:image/png;base64,' + data;
    render(<MessageAttachments attachments={[
      { type: 'image', mimeType: 'image/png', filename: 'photo.png', data },
    ]} />);

    expect(screen.getByRole('img', { name: 'Image: photo.png' }).getAttribute('src')).toBe(src);
    expect(screen.queryByText(/"mimeType"/)).toBeNull();
    expect(screen.queryByText(/attachment details/)).toBeNull();
  });

  it('opens the full-size image and restores focus when the dialog closes', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
    render(<MessageAttachments attachments={[
      { mimeType: 'image/png', filename: 'portrait.png', dataUrl: src },
    ]} />);

    const enlarge = screen.getByRole('button', { name: 'Enlarge Image: portrait.png' });
    fireEvent.click(enlarge);
    const dialog = screen.getByRole('dialog', { name: 'Image: portrait.png' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(src);
    const close = screen.getByRole('button', { name: 'Close image preview' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(enlarge);
  });

  it('shows a broken-image fallback instead of leaving a broken image element', async () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
    render(<MessageAttachments attachments={[
      { mimeType: 'image/png', filename: 'broken.png', dataUrl: src },
    ]} />);

    fireEvent.error(screen.getByRole('img', { name: 'Image: broken.png' }));
    expect(await screen.findByRole('img', {
      name: 'Image: broken.png; preview unavailable',
    })).toBeTruthy();
    expect(screen.queryByText(/"assetId"/)).toBeNull();
  });

  it('loads a canonical reference through the supplied reader and keeps preview geometry reserved', async () => {
    const reference: ImageAttachmentReference = {
      assetId: 'asset-1', mimeType: 'image/webp', filename: 'camera.webp', size: 42,
    };
    let signal: AbortSignal | undefined;
    let finishRead: ((blob: Blob) => void) | undefined;
    let readCount = 0;
    let receivedReference: ImageAttachmentReference | undefined;
    const readAttachment: ReadImageAttachment = (value, requestSignal) => {
      readCount += 1;
      receivedReference = value;
      signal = requestSignal;
      return new Promise<Blob>(resolve => { finishRead = resolve; });
    };
    const { container, unmount } = render(
      <MessageAttachments attachments={[reference]} readAttachment={readAttachment} />,
    );

    const loading = screen.getByRole('status', { name: 'Loading Image: camera.webp' });
    expect(loading.className).toContain('tb-chat-image-frame');
    await waitFor(() => expect(readCount).toBe(1));

    await act(async () => {
      finishRead?.(new Blob(['image bytes'], { type: 'image/webp' }));
    });
    const image = await screen.findByRole('img', { name: 'Image: camera.webp' });
    expect(image.getAttribute('src')).toBe('blob:preview');
    expect(image.className).toContain('tb-chat-image-preview');
    expect(receivedReference).toEqual(reference);
    expect(container.querySelector('.tb-chat-image-frame')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Enlarge Image: camera.webp' }));
    expect(screen.getByRole('dialog', { name: 'Image: camera.webp' })).toBeTruthy();

    unmount();
    expect(signal?.aborted).toBe(true);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview');
  });

  it('shows a retry action after a reference read fails', async () => {
    const reference: ImageAttachmentReference = {
      assetId: 'asset-2', mimeType: 'image/jpeg', filename: 'retry.jpg', size: 64,
    };
    let reads = 0;
    const readAttachment: ReadImageAttachment = async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary read failure');
      return new Blob(['image bytes'], { type: 'image/jpeg' });
    };
    render(<MessageAttachments attachments={[reference]} readAttachment={readAttachment} />);

    expect(await screen.findByRole('img', {
      name: 'Image: retry.jpg; preview unavailable',
    })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry image preview' }));

    expect(await screen.findByRole('img', { name: 'Image: retry.jpg' })).toBeTruthy();
    expect(reads).toBe(2);
  });

  it('keeps metadata-only images identifiable and non-image details readable', () => {
    render(<MessageAttachments attachments={[
      { assetId: 'asset-3', mimeType: 'image/webp', filename: 'stored.webp', size: 42 },
      { filename: 'notes.txt', size: 12 },
    ]} />);

    expect(screen.getByRole('img', {
      name: 'Image: stored.webp; preview unavailable',
    })).toBeTruthy();
    expect(screen.getByText(/"notes.txt"/)).toBeTruthy();
    expect(screen.queryByText(/"assetId"/)).toBeNull();
  });
});
