const MINUTE = 60_000;
const DAY = 86_400_000;

/** How long, in the largest units a reader needs: "3 h 12 min", "1 day 18 h", "9 days". */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}${days < 3 && hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** The clock time, with its day when that is not today. */
export function clockText(at: number, now: number): string {
  const date = new Date(at);
  const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  const day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short',
    ...(Math.abs(at - now) > 300 * DAY ? { year: 'numeric' as const } : {}) });
  return `${day}, ${clock}`;
}

export const agoText = (at: number, now: number): string => `${durationText(now - at)} ago`;
export const untilText = (at: number, now: number): string => at > now ? `in ${durationText(at - now)}` : `${durationText(now - at)} ago`;
