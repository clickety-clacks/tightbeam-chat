import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './messageAttachments.css';

interface ImageAttachment {
  readonly src?: string;
  readonly alt: string;
  readonly filename?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function imageMimeType(value: unknown): string | undefined {
  return typeof value === 'string' && /^image\/[a-z0-9.+-]+$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

function inlineImageAttachment(value: unknown): ImageAttachment | undefined {
  const item = objectRecord(value);
  if (!item) return undefined;

  const filename = typeof item.filename === 'string' && item.filename.trim()
    ? item.filename
    : typeof item.name === 'string' && item.name.trim() ? item.name : undefined;
  const directDataUrl = typeof item.dataUrl === 'string' ? item.dataUrl
    : typeof item.src === 'string' ? item.src : undefined;
  const dataUrlMatch = directDataUrl?.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i);
  const declaredType = imageMimeType(item.mimeType) ?? imageMimeType(item.mediaType);
  const dataType = dataUrlMatch ? imageMimeType(dataUrlMatch[1]) : undefined;
  const mediaType = declaredType ?? dataType;
  if (!mediaType || (dataType && dataType !== mediaType)) return undefined;

  let src: string | undefined;
  if (dataUrlMatch && dataUrlMatch[2].length > 0 && dataUrlMatch[2].length % 4 === 0) {
    src = directDataUrl;
  } else if (typeof item.data === 'string' && item.data.length > 0 &&
      item.data.length % 4 === 0 && /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(item.data)) {
    src = `data:${mediaType};base64,${item.data}`;
  }

  return { src, alt: filename ? `Image: ${filename}` : 'Image attachment', filename };
}

function InlineImagePreview({ src, alt }: { readonly src: string; readonly alt: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (open) closeButton.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', handleDialogKey);
    return () => document.removeEventListener('keydown', handleDialogKey);
  }, [close, open]);

  return <>
    <button ref={trigger} type="button" className="tb-chat-image-preview-trigger"
      aria-label={`Enlarge ${alt}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <img className="tb-chat-image-preview" src={src} alt={alt} loading="lazy" decoding="async" />
    </button>
    {open && typeof document !== 'undefined' && createPortal(
      <div className="tb-chat-image-overlay" role="dialog" aria-modal="true"
        aria-labelledby={titleId} onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
        <h2 id={titleId} className="tb-chat-image-dialog-title">{alt}</h2>
        <button ref={closeButton} type="button" className="tb-chat-image-close"
          aria-label="Close image preview" onClick={close}>×</button>
        <img className="tb-chat-image-full" src={src} alt={alt} />
      </div>, document.body,
    )}
  </>;
}

function ImageAttachmentView({ attachment }: { readonly attachment: ImageAttachment }) {
  return <figure className="tb-chat-image-attachment">
    {attachment.src
      ? <InlineImagePreview src={attachment.src} alt={attachment.alt} />
      : <div className="tb-chat-image-unavailable" role="img" aria-label={`${attachment.alt}; preview unavailable`}>
        <span aria-hidden="true">▧</span><span>Preview unavailable</span>
      </div>}
    {attachment.filename && <figcaption>{attachment.filename}</figcaption>}
  </figure>;
}

export function MessageAttachments({ attachments }: { readonly attachments?: readonly unknown[] }) {
  if (!attachments?.length) return null;

  const images: Array<{ readonly key: number; readonly attachment: ImageAttachment }> = [];
  const otherAttachments: unknown[] = [];
  attachments.forEach((value, index) => {
    const image = inlineImageAttachment(value);
    if (image) images.push({ key: index, attachment: image });
    else {
      const item = objectRecord(value);
      if (item && (imageMimeType(item.mimeType) || imageMimeType(item.mediaType))) {
        const filename = typeof item.filename === 'string' && item.filename.trim() ? item.filename
          : typeof item.name === 'string' && item.name.trim() ? item.name : undefined;
        images.push({ key: index, attachment: { alt: filename ? `Image: ${filename}` : 'Image attachment', filename } });
      } else otherAttachments.push(value);
    }
  });

  return <>
    {images.length > 0 && <div className="tb-chat-image-attachments">
      {images.map(({ key, attachment }) => <ImageAttachmentView key={key} attachment={attachment} />)}
    </div>}
    {otherAttachments.length > 0 && <details className="tb-chat-attachments">
      <summary>{otherAttachments.length} attachment {otherAttachments.length === 1 ? 'detail' : 'details'}</summary>
      <pre>{JSON.stringify(otherAttachments, null, 2)}</pre>
    </details>}
  </>;
}
