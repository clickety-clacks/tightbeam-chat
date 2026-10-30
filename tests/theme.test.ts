import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
const componentCss = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8');
const siteCss = readFileSync(resolve(process.cwd(), 'examples/site.css'), 'utf8');
const hostComposerCss = readFileSync(resolve(process.cwd(), 'examples/hostComposer.css'), 'utf8');
const componentSource = readFileSync(resolve(process.cwd(), 'src/TightbeamChat.tsx'), 'utf8');
const servedStyles = [componentCss, siteCss, hostComposerCss];

type Rgb = readonly [number, number, number];
type Color = { readonly rgb: Rgb; readonly alpha: number };
type Tokens = Record<string, string>;

function declarations(block: string): Tokens {
  return Object.fromEntries([...block.matchAll(/--tb-chat-([\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}

function tokenBlocks(css: string): { light: Tokens; dark: Tokens } {
  const lightBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1];
  const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1];
  if (!lightBlock || !darkBlock) throw new Error('Theme must define root tokens for both system appearances.');
  return { light: declarations(lightBlock), dark: declarations(darkBlock) };
}

function parseColor(value: string): Color {
  const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) {
    return {
      rgb: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb,
      alpha: 1,
    };
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: 1 };
  const rgba = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0|1|0?\.\d+)\s*\)$/i);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  throw new Error(`Unsupported theme color value: ${value}`);
}

function composite(foreground: Color, background: Color): Color {
  const rgb = foreground.rgb.map((channel, index) =>
    channel * foreground.alpha + background.rgb[index] * (1 - foreground.alpha)) as unknown as Rgb;
  return { rgb, alpha: 1 };
}

function mix(foreground: Color, background: Color, weight: number): Color {
  return {
    rgb: foreground.rgb.map((channel, index) => channel * weight + background.rgb[index] * (1 - weight)) as unknown as Rgb,
    alpha: 1,
  };
}

function luminance(color: Color): number {
  const linear = color.rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first: Color, second: Color): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenColor(tokens: Tokens, name: string): Color {
  const value = tokens[name];
  if (!value) throw new Error(`Missing theme token: ${name}`);
  return parseColor(value);
}

function rule(css: string, selector: string): string {
  const requestedSelectors = selector.split(',').map((candidate) => candidate.replace(/\s+/g, ' ').trim());
  const matches = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').some((candidate) =>
      requestedSelectors.includes(candidate.replace(/\s+/g, ' ').trim())));
  if (matches.length === 0) throw new Error(`Missing CSS rule for ${selector}`);
  return matches.map(([, , body]) => body).join('\n');
}

const expectedLight: Tokens = {
  background: '#F1EEE9', text: '#31302D', muted: '#5C5854', border: '#DEDAD3',
  'agent-surface': '#E6E1D8', 'human-surface': '#DCE3DA', code: '#E2DCD2',
  'syntax-keyword': '#693C8E', 'syntax-string': '#28623B', 'syntax-number': '#914A14',
  'syntax-comment': '#625C55', 'syntax-title': '#175C80',
  accent: '#526657', 'on-accent': '#F3F0EA', teak: '#7A5540', fjord: '#4D6470',
  'pill-purple': '#6B3CC0',
  ok: '#4E6547', caution: '#73592A', transition: '#6B6458', danger: '#A63A2A', idle: '#5C5854',
  placeholder: '#53504C', glass: 'rgba(250,246,238,0.74)',
  'glass-edge': 'rgba(60,45,30,0.10)', shadow: 'rgb(60,45,30)',
  'composer-shadow-alpha': '12%',
};

const expectedDark: Tokens = {
  background: '#161514', text: '#DDD9D1', muted: '#9E9992', border: '#2C2A27',
  'agent-surface': '#24221F', 'human-surface': '#26302A', code: '#1C1B19',
  'syntax-keyword': '#C9A6EF', 'syntax-string': '#9AD5A7', 'syntax-number': '#F0B66E',
  'syntax-comment': '#B6ADA2', 'syntax-title': '#8FCFF0',
  accent: '#A5BAA9', 'on-accent': '#19211B', teak: '#C9A891', fjord: '#9FB4BF',
  'pill-purple': '#C9B7F1',
  ok: '#A5BC9C', caution: '#D8BE84', transition: '#B0A18D', danger: '#EE8B75', idle: '#9E9992',
  placeholder: '#D2CDC6', glass: 'rgba(46,42,37,0.74)',
  'glass-edge': 'rgba(240,230,215,0.10)', shadow: '#000000',
  'composer-shadow-alpha': '35%',
};

describe('Nordic theme', () => {
  it('defines the exact light and dark palette selected by system appearance', () => {
    const { light, dark } = tokenBlocks(themeCss);
    expect(light).toEqual(expectedLight);
    expect(dark).toEqual(expectedDark);
    expect(themeCss).toContain('color-scheme: light dark;');
    expect(themeCss).toContain('@media (prefers-color-scheme: dark)');
  });

  it('meets every contract text-contrast pairing after compositing the glass over all transcript backdrops', () => {
    const { light, dark } = tokenBlocks(themeCss);
    const expectedPairs: Array<[string, string]> = [
      ['text', 'background'], ['text', 'agent-surface'], ['text', 'human-surface'], ['text', 'code'],
      ['muted', 'background'], ['muted', 'agent-surface'], ['muted', 'human-surface'],
      ['fjord', 'background'], ['fjord', 'agent-surface'], ['fjord', 'human-surface'], ['fjord', 'code'],
      ['teak', 'code'], ['caution', 'human-surface'], ['danger', 'human-surface'], ['danger', 'background'],
      ['syntax-keyword', 'code'], ['syntax-string', 'code'], ['syntax-number', 'code'],
      ['syntax-comment', 'code'], ['syntax-title', 'code'],
      ['on-accent', 'accent'], ['muted', 'background'],
    ];
    const backdrops = [
      'background', 'agent-surface', 'human-surface', 'code', 'border', 'text', 'muted',
      'accent', 'on-accent', 'teak', 'fjord', 'ok', 'caution', 'danger',
    ];

    for (const [variant, tokens] of Object.entries({ light, dark })) {
      for (const [foregroundName, backgroundName] of expectedPairs) {
        const ratio = contrast(tokenColor(tokens, foregroundName), tokenColor(tokens, backgroundName));
        expect(ratio, `${variant}: ${foregroundName} on ${backgroundName}`).toBeGreaterThanOrEqual(4.5);
      }

      const glass = tokenColor(tokens, 'glass');
      const text = tokenColor(tokens, 'text');
      const placeholder = tokenColor(tokens, 'placeholder');
      const textRatios = backdrops.map((name) => contrast(text, composite(glass, tokenColor(tokens, name))));
      const placeholderRatios = backdrops.map((name) => contrast(placeholder, composite(glass, tokenColor(tokens, name))));
      expect(Math.min(...textRatios), `${variant}: draft text on glass over every backdrop`).toBeGreaterThanOrEqual(4.5);
      expect(Math.min(...placeholderRatios), `${variant}: placeholder on glass over every backdrop`).toBeGreaterThanOrEqual(4.5);
      expect(Math.min(...textRatios)).toBeCloseTo(variant === 'light' ? 7.47 : 5.06, 1);
      expect(Math.min(...placeholderRatios)).toBeCloseTo(variant === 'light' ? 4.54 : 4.50, 1);
    }
  });

  it('maps approved transcript treatments and send states to their theme roles', () => {
    expect(rule(componentCss, '.tb-chat-bubble')).toContain('background: var(--tb-chat-agent-surface)');
    expect(rule(componentCss, '.tb-chat-bubble-human')).toContain('background: var(--tb-chat-human-surface)');
    expect(rule(componentCss, '.tb-chat-markdown blockquote')).toContain('border-inline-start: 3px solid var(--tb-chat-teak)');
    expect(rule(componentCss, '.tb-chat-markdown blockquote')).toContain('color: var(--tb-chat-muted)');
    expect(rule(componentCss, '.tb-chat-markdown a')).toContain('color: var(--tb-chat-fjord)');
    expect(rule(componentCss, '.tb-chat-markdown :not(pre) > code')).toContain('background: var(--tb-chat-code)');
    expect(rule(componentCss, '.tb-chat-markdown :not(pre) > code')).toContain('color: var(--tb-chat-teak)');
    expect(rule(componentCss, '.tb-chat-code-scroll')).toContain('background: var(--tb-chat-code)');
    expect(rule(componentCss, '.tb-chat-code-scroll code')).toContain('color: var(--tb-chat-text)');
    expect(rule(componentCss, '.tb-chat-markdown th')).toContain('background: var(--tb-chat-code)');
    expect(rule(componentCss, '.tb-chat-markdown th')).toContain('color: var(--tb-chat-text)');

    expect(componentSource).toContain('data-send-status={send.status}');
    expect(rule(componentCss, '.tb-chat-send-state[data-send-status="uncertain"]')).toContain('color: var(--tb-chat-caution)');
    expect(rule(componentCss, '.tb-chat-send-state[data-send-status="failed"]')).toContain('color: var(--tb-chat-danger)');
    expect(rule(componentCss, '.tb-chat-send-state')).toContain('color: var(--tb-chat-muted)');
    expect(rule(componentCss, '.tb-chat-send-reason')).toContain('color: inherit');
    expect(rule(componentCss, '.tb-chat-send-actions span')).toContain('color: var(--tb-chat-muted)');
  });

  it('keeps the floating latest-prompt miniature aligned with the human bubble color and three-line limit', () => {
    const { light, dark } = tokenBlocks(themeCss);
    expect(rule(componentCss, '.tb-chat-latest-user-prompt')).toContain('background: var(--tb-chat-human-surface)');
    expect(rule(componentCss, '.tb-chat-latest-user-prompt-jump')).toContain('font-size: .86rem');
    expect(rule(componentCss, '.tb-chat-latest-user-prompt-text')).toContain('-webkit-line-clamp: 3');
    expect(light['human-surface']).toBe(expectedLight['human-surface']);
    expect(dark['human-surface']).toBe(expectedDark['human-surface']);
  });

  it('uses glass for the composer and the approved treatments for pills, status, popup, and host composer', () => {
    const { light, dark } = tokenBlocks(themeCss);
    const shell = rule(componentCss, '.tb-chat-input-shell');
    expect(shell).toContain('border: var(--tb-chat-input-border-width) solid var(--tb-chat-glass-edge)');
    expect(shell).toContain('background: var(--tb-chat-glass)');
    expect(shell).toContain('backdrop-filter: blur(14px)');
    expect(shell).toContain('var(--tb-chat-composer-shadow-alpha)');
    expect(rule(componentCss, '.tb-chat-input-shell textarea::placeholder')).toContain('color: var(--tb-chat-placeholder)');
    expect(rule(componentCss, '.tb-chat-scroll-latest')).toContain('var(--tb-chat-shadow) 12%');
    expect(rule(componentCss, '.tb-chat-status-popup')).toContain('var(--tb-chat-shadow) 20%');

    const pills = rule(componentCss, '.tb-chat-send-actions button');
    expect(pills).toContain('background: transparent');
    expect(pills).toContain('color: var(--tb-chat-text)');
    expect(pills).toContain('border: 1px solid var(--tb-chat-border)');
    const primary = rule(componentCss, '.tb-chat-send-actions button:first-child:not(:disabled)');
    expect(primary).toContain('background: var(--tb-chat-accent)');
    expect(primary).toContain('border-color: var(--tb-chat-accent)');
    expect(primary).toContain('color: var(--tb-chat-on-accent)');
    const disabled = rule(componentCss, '.tb-chat-send-actions button:disabled');
    expect(disabled).toContain('background: transparent');
    expect(disabled).toContain('color: var(--tb-chat-muted)');
    expect(disabled).not.toContain('opacity:');

    const caption = rule(componentCss, '.tb-chat-caption');
    expect(caption).toContain('font-size: .78rem');
    expect(caption).toContain('text-align: start');
    expect(caption).toContain('background: transparent');
    expect(caption).toContain('border: 0');
    expect(caption).toContain('box-shadow: none');
    expect(rule(componentCss, '.tb-chat-caption::before')).toContain("content: '•'");
    expect(rule(componentCss, '.tb-chat-caption-neutral')).toContain('color: var(--tb-chat-muted)');
    expect(rule(componentCss, '.tb-chat-active-caption::before')).toContain('content: none');
    expect(rule(componentCss, '.tb-chat-active-caption')).toContain('text-align: center');
    expect(rule(componentCss, '.tb-chat-active-caption > .tb-chat-caption-body')).toContain('justify-content: center');
    expect(rule(componentCss, '.tb-chat-active-caption-icon')).toContain('color: var(--tb-chat-ok)');
    const activity = rule(componentCss, '.tb-chat-activity-line');
    expect(activity).toContain('white-space: nowrap');
    expect(activity).toContain('text-overflow: ellipsis');
    expect(rule(componentCss, '.tb-chat-activity-agent')).toContain('color: var(--tb-chat-fjord)');
    expect(rule(componentCss, '.tb-chat-activity-substrate')).toContain('color: var(--tb-chat-muted)');
    expect(rule(componentCss, '.tb-chat-activity-tool')).toContain('color: var(--tb-chat-muted)');
    expect(rule(componentCss, '.tb-chat-activity-tool-run-toggle')).toContain('color: var(--tb-chat-caution)');
    expect(rule(componentCss, '.tb-chat-activity-rail')).toContain('color: var(--tb-chat-caution)');
    const boundary = rule(componentCss, '.tb-chat-transition-marker');
    expect(boundary).toContain('color: var(--tb-chat-transition)');
    expect(boundary).toContain('background: color-mix(in srgb, var(--tb-chat-transition) 8%, var(--tb-chat-background))');
    expect(boundary).toContain('border-block: 1px solid');
    expect(boundary).toContain('font-size: .78rem');
    expect(boundary).toContain('width: calc(100% + var(--tb-chat-viewport-inline-padding) + var(--tb-chat-viewport-inline-padding))');
    expect(boundary).toContain('margin-inline: calc(0px - var(--tb-chat-viewport-inline-padding))');
    expect(rule(componentCss, '.tb-chat-transition-marker::before')).toContain('content: none');
    expect(rule(componentCss, '.tb-chat-caption-caution')).toContain('var(--tb-chat-caution) 94%');
    expect(rule(componentCss, '.tb-chat-caption-danger')).toContain('var(--tb-chat-danger) 94%');
    for (const [variant, tokens] of [['light', light], ['dark', dark]] as const) {
      const background = tokenColor(tokens, 'background');
      const activityColors = ['fjord', 'muted', 'teak', 'caution'].map(name => tokens[name]);
      expect(new Set(activityColors).size).toBe(activityColors.length);
      expect(tokens.caution).not.toBe(tokens.text);
      expect(tokens.transition).not.toBe(tokens.ok);
      for (const color of activityColors) expect(tokens.transition).not.toBe(color);
      const boundaryFill = mix(tokenColor(tokens, 'transition'), tokenColor(tokens, 'background'), .08);
      expect(contrast(tokenColor(tokens, 'transition'), boundaryFill), `${variant}: transition label on bar`)
        .toBeGreaterThanOrEqual(4.5);
      for (const role of ['caution', 'danger']) {
        expect(contrast(mix(tokenColor(tokens, role), background, .94), background), `${role} caption on its theme surface`)
          .toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokenColor(tokens, 'muted'), background), `${variant}: tool row secondary text`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokenColor(tokens, 'caution'), background), `${variant}: folded tool summary`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokenColor(tokens, 'transition'), background))
        .toBeLessThan(contrast(tokenColor(tokens, 'text'), background));
    }
    const captionAction = rule(componentCss, '.tb-chat-caption button');
    expect(captionAction).toContain('min-height: 2.75rem');
    expect(captionAction).toContain('background: transparent');
    expect(captionAction).toContain('border: 0');
    expect(captionAction).toContain('text-decoration: underline');
    expect(componentCss).not.toContain('.tb-chat-tool-controls');
    expect(rule(componentCss, '.tb-chat-tool-history-status')).toContain('display: flex');
    expect(rule(componentCss, '.tb-chat-transition')).not.toContain('border:');
    expect(rule(componentCss, '.tb-chat-status-ready')).toContain('background: var(--tb-chat-ok)');
    expect(rule(componentCss, '.tb-chat-status-loading, .tb-chat-status-stale')).toContain('background: var(--tb-chat-caution)');
    expect(rule(componentCss, '.tb-chat-status-error, .tb-chat-status-unauthorized, .tb-chat-status-unsupported')).toContain('background: var(--tb-chat-danger)');
    expect(rule(componentCss, '.tb-chat-status-popup')).toContain('background: var(--tb-chat-background)');
    expect(rule(componentCss, '.tb-chat-status-popup p')).toContain('color: var(--tb-chat-muted)');

    expect(rule(hostComposerCss, '.host-composer-panel')).toContain('background: var(--tb-chat-background)');
    expect(rule(hostComposerCss, '#host-composer-input')).toContain('background: var(--tb-chat-agent-surface)');
    const hostButtons = rule(hostComposerCss, '.host-composer-actions button');
    expect(hostButtons).toContain('background: transparent');
    expect(hostButtons).toContain('color: var(--tb-chat-text)');
    const hostDisabled = rule(hostComposerCss, '.host-composer-actions button:disabled');
    expect(hostDisabled).toContain('color: var(--tb-chat-muted)');
    expect(hostDisabled).not.toContain('opacity:');
  });

  it('keeps all served color literals in the shared definition and uses only the approved disabled send opacity', () => {
    const colorLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-[\w-]+)?|outline(?:-[\w-]+)?|box-shadow|text-shadow)\s*:\s*(?:white|black|red|green|blue|gray|grey|orange|purple|yellow|pink|brown|navy|teal|silver|maroon)\b/im;
    expect(componentCss).toContain("@import './theme.css';");
    expect(siteCss).toContain("@import '../src/theme.css';");
    for (const [index, css] of servedStyles.entries()) {
      expect(css, `served stylesheet ${index + 1}`).not.toMatch(colorLiteral);
    }
    const disabledTextRules = [...componentCss.matchAll(/([^{}]*:disabled[^{}]*)\{([^}]*)\}/g)]
      .filter(([, selector]) => !selector.includes('.tb-chat-send-button'));
    expect(disabledTextRules.length).toBeGreaterThan(0);
    expect(disabledTextRules.map(([, , declarations]) => declarations).join('\n')).not.toMatch(/opacity\s*:/);
    expect(themeCss).toContain('--tb-chat-shadow: #000000;');
    expect(themeCss).not.toContain('--tb-chat-text: #FFFFFF');
    expect(themeCss).not.toContain('--tb-chat-background: #000000');
  });
});
