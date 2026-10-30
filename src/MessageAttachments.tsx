import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './messageAttachments.css';

export interface ImageAttachmentReference {
  readonly assetId: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly size: number;
}

export type ReadImageAttachment = (
  reference: ImageAttachmentReference,
  signal: AbortSignal,
) => Promise<Blob>;

interface ImageAttachment {
  readonly src?: string;
  readonly reference?: ImageAttachmentReference;
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

function imageAttachment(value: unknown): ImageAttachment | undefined {
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
  const isImage = item.type === 'image' || Boolean(declaredType || dataType);
  if (!isImage) return undefined;

  let src: string | undefined;
  if (dataUrlMatch && dataType && dataType === mediaType &&
      dataUrlMatch[2].length > 0 && dataUrlMatch[2].length % 4 === 0) {
    src = directDataUrl;
  } else if (typeof item.data === 'string' && mediaType && item.data.length > 0 &&
      item.data.length % 4 === 0 &&
      /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(item.data)) {
    src = 'data:' + mediaType + ';base64,' + item.data;
  }

  const rawAssetId = typeof item.assetId === 'string' ? item.assetId : '';
  const assetId = rawAssetId.trim() ? rawAssetId : '';
  const referenceMimeType = imageMimeType(item.mimeType);
  const referenceFilename = typeof item.filename === 'string' ? item.filename : undefined;
  const size = item.size;
  const reference = assetId && referenceMimeType && referenceFilename !== undefined &&
      typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
    ? {
      assetId,
      mimeType: item.mimeType as string,
      filename: referenceFilename,
      size,
    }
    : undefined;

  return {
    src,
    reference,
    alt: filename ? 'Image: ' + filename : 'Image attachment',
    filename,
  };
}

function InlineImagePreview({ src, alt, onImageError }: {
  readonly src: string;
  readonly alt: string;
  readonly onImageError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  const fail = useCallback(() => {
    setOpen(false);
    onImageError?.();
  }, [onImageError]);

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
    <button ref={trigger} type="button" className="tb-chat-image-preview-trigger tb-chat-image-frame"
      aria-label={'Enlarge ' + alt} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <img className="tb-chat-image-preview" src={src} alt={alt} loading="lazy" decoding="async"
        onError={fail} />
    </button>
    {open && typeof document !== 'undefined' && createPortal(
      <div className="tb-chat-image-overlay" role="dialog" aria-modal="true"
        aria-labelledby={titleId} onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
        <h2 id={titleId} className="tb-chat-image-dialog-title">{alt}</h2>
        <button ref={closeButton} type="button" className="tb-chat-image-close"
          aria-label="Close image preview" onClick={close}>×</button>
        <img className="tb-chat-image-full" src={src} alt={alt} onError={fail} />
      </div>, document.body,
    )}
  </>;
}

function ImageUnavailable({ alt, onRetry }: {
  readonly alt: string;
  readonly onRetry?: () => void;
}) {
  return <div className="tb-chat-image-state">
    <div className="tb-chat-image-frame tb-chat-image-unavailable" role="img"
      aria-label={alt + '; preview unavailable'}>
      <span aria-hidden="true">▧</span>
      <span>Preview unavailable</span>
    </div>
    {onRetry && <button type="button" className="tb-chat-image-retry" onClick={onRetry}>
      Retry image preview
    </button>}
  </div>;
}

function ImageLoading({ alt }: { readonly alt: string }) {
  return <div className="tb-chat-image-frame tb-chat-image-loading" role="status"
    aria-label={'Loading ' + alt} aria-busy="true">
    Loading image preview…
  </div>;
}

function ReferencedImagePreview({ attachment, readAttachment }: {
  readonly attachment: ImageAttachment;
  readonly readAttachment?: ReadImageAttachment;
}) {
  const reference = attachment.reference!;
  const referenceKey = JSON.stringify([
    reference.assetId, reference.mimeType, reference.filename, reference.size,
  ]);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'unavailable'>('loading');
  const [objectUrl, setObjectUrl] = useState<string>();
  const [loadedReferenceKey, setLoadedReferenceKey] = useState<string>();

  useEffect(() => {
    if (!readAttachment) {
      setObjectUrl(undefined);
      setPhase('unavailable');
      return;
    }

    const controller = new AbortController();
    let active = true;
    setObjectUrl(undefined);
    setLoadedReferenceKey(undefined);
    setPhase('loading');

    void Promise.resolve()
      .then(() => readAttachment(reference, controller.signal))
      .then((blob) => {
        if (!active) return;
        const url = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        setObjectUrl(url);
        setLoadedReferenceKey(referenceKey);
        setPhase('ready');
      })
      .catch(() => {
        if (active) setPhase('failed');
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, readAttachment, referenceKey]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const retry = useCallback(() => {
    setPhase('loading');
    setObjectUrl(undefined);
    setLoadedReferenceKey(undefined);
    setAttempt(value => value + 1);
  }, []);
  const imageFailed = useCallback(() => {
    setPhase('failed');
    setObjectUrl(undefined);
    setLoadedReferenceKey(undefined);
  }, []);

  if (phase === 'loading') return <ImageLoading alt={attachment.alt} />;
  if (phase !== 'ready' || !objectUrl || loadedReferenceKey !== referenceKey) {
    return <ImageUnavailable alt={attachment.alt}
      onRetry={phase === 'failed' && readAttachment ? retry : undefined} />;
  }

  return <InlineImagePreview src={objectUrl} alt={attachment.alt} onImageError={imageFailed} />;
}

function InlineImageAttachment({ attachment }: { readonly attachment: ImageAttachment }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!attachment.src || failedSrc === attachment.src) {
    return <ImageUnavailable alt={attachment.alt} />;
  }
  return <InlineImagePreview src={attachment.src} alt={attachment.alt}
    onImageError={() => setFailedSrc(attachment.src)} />;
}

function ImageAttachmentView({ attachment, readAttachment }: {
  readonly attachment: ImageAttachment;
  readonly readAttachment?: ReadImageAttachment;
}) {
  return <figure className="tb-chat-image-attachment">
    {attachment.src
      ? <InlineImageAttachment attachment={attachment} />
      : attachment.reference
        ? <ReferencedImagePreview attachment={attachment} readAttachment={readAttachment} />
        : <ImageUnavailable alt={attachment.alt} />}
    {attachment.filename && <figcaption>{attachment.filename}</figcaption>}
  </figure>;
}

export function MessageAttachments({ attachments, readAttachment }: {
  readonly attachments?: readonly unknown[];
  readonly readAttachment?: ReadImageAttachment;
}) {
  if (!attachments?.length) return null;

  const images: Array<{ readonly key: number; readonly attachment: ImageAttachment }> = [];
  const otherAttachments: unknown[] = [];
  attachments.forEach((value, index) => {
    const image = imageAttachment(value);
    if (image) images.push({ key: index, attachment: image });
    else otherAttachments.push(value);
  });

  return <>
    {images.length > 0 && <div className="tb-chat-image-attachments">
      {images.map(({ key, attachment }) => <ImageAttachmentView key={key}
        attachment={attachment} readAttachment={readAttachment} />)}
    </div>}
    {otherAttachments.length > 0 && <details className="tb-chat-attachments">
      <summary>{otherAttachments.length} attachment {otherAttachments.length === 1 ? 'detail' : 'details'}</summary>
      <pre>{JSON.stringify(otherAttachments, null, 2)}</pre>
    </details>}
  </>;
}
