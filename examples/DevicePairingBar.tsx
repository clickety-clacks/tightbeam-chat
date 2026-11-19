import { useId, useState, type FormEvent } from 'react';
import type { PairOutcome } from './devicePairing';

export type BrowserDeviceState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'check-failed'; readonly message: string }
  | { readonly kind: 'unpaired'; readonly notice?: DeviceNotice }
  | { readonly kind: 'paired'; readonly deviceId: string; readonly userId?: string; readonly scope?: string;
      readonly verified: boolean; readonly notice?: DeviceNotice }
  /** The bridge cleared a dead credential during this page's life. Sends stay off the service path until the human chooses. */
  | { readonly kind: 'revoked'; readonly deviceId: string; readonly notice: DeviceNotice };

export interface DeviceNotice {
  readonly reason: string;
  readonly message?: string;
}

/** A form check made in the page before anything is sent. */
interface FormProblem extends DeviceNotice {
  readonly local?: true;
}

const CLAIMED_NAME_LIMIT = 64;
const DEAD_CREDENTIAL_REASONS = new Set(['token_revoked', 'auth_failed', 'device_not_approved', 'user_removed', 'not_paired']);

/** Human text for each pairing and credential outcome; unknown reasons are shown verbatim. */
export function deviceNoticeText(notice: DeviceNotice): string {
  const detail = notice.message ? ` ${notice.message}` : '';
  switch (notice.reason) {
    case 'pairing_code_invalid':
      return `Code not accepted (pairing_code_invalid).${detail}`;
    case 'pairing_code_required':
      return `Pairing needs a one-time code (pairing_code_required). Issue a code in Clawline and enter it here.${detail}`;
    case 'already_paired':
      return `This device is already paired (already_paired). Chat does not pair again automatically.${detail}`;
    case 'rate_limited':
      return `Too many pairing attempts (rate_limited). Try again shortly.${detail}`;
    case 'paired':
      return 'This browser is now paired.';
    case 'forgotten':
      return 'This browser forgot its device. Revoke the device in Clawline if you no longer trust it.';
    default:
      if (DEAD_CREDENTIAL_REASONS.has(notice.reason)) {
        const cause = notice.reason === 'token_revoked' ? '' : ` (${notice.reason})`;
        return `This browser's device credential is no longer accepted (token_revoked)${cause}. ` +
          'Messages are not sent with it. Pair this browser again with a new code from Clawline.';
      }
      return `Pairing did not complete (${notice.reason}).${detail}`;
  }
}

function shortDeviceId(deviceId: string): string {
  return `${deviceId.slice(0, 13)}…${deviceId.slice(-4)}`;
}

/** The visible "Pair this browser" control and this browser's paired state. */
export function DevicePairingBar({ state, onPair, onForget, onRetry, onUseService }: {
  readonly state: BrowserDeviceState;
  readonly onPair: (name: string, code: string) => Promise<PairOutcome>;
  readonly onForget: () => Promise<void>;
  readonly onRetry: () => void;
  readonly onUseService: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Chat in this browser');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<FormProblem>();
  const nameId = useId();
  const codeId = useId();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmedName = name.trim();
    const trimmedCode = code.trim();
    if (!trimmedName) {
      setFormError({ reason: 'name_required', message: 'Enter a name for this browser.', local: true });
      return;
    }
    if (!trimmedCode) {
      setFormError({ reason: 'code_required', message: 'Enter the pairing code issued in Clawline.', local: true });
      return;
    }
    if (trimmedName.length + 1 + trimmedCode.length > CLAIMED_NAME_LIMIT) {
      setFormError({ reason: 'name_too_long', local: true,
        message: `Use a shorter name; the name and code together must fit in ${CLAIMED_NAME_LIMIT} characters.` });
      return;
    }
    setBusy(true);
    setFormError(undefined);
    try {
      const outcome = await onPair(trimmedName, trimmedCode);
      if (outcome.success) {
        setOpen(false);
        setCode('');
      } else {
        setFormError({ reason: outcome.reason, ...(outcome.message ? { message: outcome.message } : {}) });
      }
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (busy) return;
    setBusy(true);
    try { await onForget(); }
    catch { setFormError({ reason: 'forget_failed', message: 'This browser could not forget its device. Try again.', local: true }); }
    finally { setBusy(false); }
  };

  const notice = state.kind === 'unpaired' || state.kind === 'paired' || state.kind === 'revoked' ? state.notice : undefined;
  const canPair = state.kind === 'unpaired' || state.kind === 'revoked';
  const noticeIsError = notice && !['paired', 'forgotten'].includes(notice.reason);

  return <section className="chat-device-bar" aria-label="Browser device" data-device-state={state.kind}>
    <div className="chat-device-bar-row">
      {state.kind === 'checking' && <p role="status">Checking this browser's pairing…</p>}
      {state.kind === 'check-failed' && <>
        <p role="alert">{state.message} Chat waits until it is known, so nothing is sent with the wrong credential.</p>
        <button type="button" onClick={onRetry}>Check again</button>
      </>}
      {state.kind === 'unpaired' && <p role="status">This browser is not paired. Messages use Chat's service connection.</p>}
      {state.kind === 'revoked' && <p role="status">Sending is paused for this browser's former device.</p>}
      {canPair && <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); setFormError(undefined); }}>
        Pair this browser
      </button>}
      {state.kind === 'revoked' && <button type="button" onClick={onUseService}>Send with Chat's service connection</button>}
      {state.kind === 'paired' && <>
        <p role="status">
          This browser is paired as its own device <span title={state.deviceId}>{shortDeviceId(state.deviceId)}</span>
          {state.scope ? ` (${state.scope})` : ''}{state.verified ? '' : ', not verified because the Gateway did not answer'}.
          {' '}Your messages and /tightbeam commands are sent with it.
        </p>
        <button type="button" disabled={busy} onClick={() => void forget()}>Forget this browser</button>
      </>}
    </div>
    {notice && <p className={noticeIsError ? 'chat-device-bar-error' : 'chat-device-bar-note'}
      role={noticeIsError ? 'alert' : 'status'} data-device-notice={notice.reason}>{deviceNoticeText(notice)}</p>}
    {canPair && open && <form className="chat-device-bar-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={nameId}>Name for this browser</label>
      <input id={nameId} type="text" autoComplete="off" value={name} maxLength={CLAIMED_NAME_LIMIT}
        onChange={(event) => setName(event.currentTarget.value)} />
      <label htmlFor={codeId}>Pairing code from Clawline</label>
      <input id={codeId} type="text" autoComplete="one-time-code" spellCheck={false} placeholder="TB-XXXX-XXXX-XXXX"
        value={code} onChange={(event) => setCode(event.currentTarget.value)} />
      <button type="submit" disabled={busy}>{busy ? 'Pairing…' : 'Pair'}</button>
    </form>}
    {formError && <p className="chat-device-bar-error" role="alert" data-device-notice={formError.reason}>
      {formError.local ? formError.message : deviceNoticeText(formError)}
    </p>}
  </section>;
}
