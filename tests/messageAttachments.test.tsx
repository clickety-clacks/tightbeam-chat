import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageAttachments } from '../src/MessageAttachments';

afterEach(cleanup);

describe('message image attachments', () => {
  it('renders inline image bytes without exposing the raw attachment JSON', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
    const src = `data:image/png;base64,${data}`;
    render(<MessageAttachments attachments={[
      { mediaType: 'image/png', filename: 'photo.png', data },
    ]} />);

    expect(screen.getByRole('img', { name: 'Image: photo.png' }).getAttribute('src')).toBe(src);
    expect(screen.queryByText(/\"mediaType\"/)).toBeNull();
    expect(screen.queryByText(/attachment details/)).toBeNull();
  });

  it('opens the full-size image from the thumbnail and closes with Escape, restoring focus', () => {
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

  it('keeps metadata-only images identifiable and non-image details readable', () => {
    render(<MessageAttachments attachments={[
      { assetId: 'asset-1', mimeType: 'image/webp', filename: 'stored.webp', size: 42 },
      { filename: 'notes.txt', size: 12 },
    ]} />);

    expect(screen.getByRole('img', { name: 'Image: stored.webp; preview unavailable' })).toBeTruthy();
    expect(screen.getByText(/\"notes.txt\"/)).toBeTruthy();
    expect(screen.queryByText(/\"assetId\"/)).toBeNull();
  });
});
