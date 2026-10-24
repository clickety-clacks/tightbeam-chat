import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
const componentCss = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8');
const siteCss = readFileSync(resolve(process.cwd(), 'examples/site.css'), 'utf8');
const hostComposerCss = readFileSync(resolve(process.cwd(), 'examples/hostComposer.css'), 'utf8');
const servedStyles = [componentCss, siteCss, hostComposerCss];

type Rgb = readonly [number, number, number];
type Color = { readonly rgb: Rgb; readonly alpha: number };

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--tb-chat-([\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}

function tokenBlocks(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const lightBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1];
  const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1];
  if (!lightBlock || !darkBlock) throw new Error('Theme must define root tokens for both system appearances.');
  return { light: declarations(lightBlock), dark: declarations(darkBlock) };
}

function parseColor(value: string): Color {
  const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) {
    return { rgb: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb,
      alpha: 1 };
  }
  const rgba = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0|1|0?\.\d+)\s*\)$/i);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  throw new Error(`Unsupported theme color value: ${value}`);
}

function composite(foreground: Color, background: Color): Color {
  const rgb = foreground.rgb.map((channel, index) => Math.round(
    channel * foreground.alpha + background.rgb[index] * (1 - foreground.alpha))) as unknown as Rgb;
  return { rgb, alpha: 1 };
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

const expectedLight: Record<string, string> = {
  background: '#F1EEE9', text: '#31302D', muted: '#5C5854', border: '#DEDAD3',
  surface: '#E4E0DB', human: '#DBDBD5', 'control-fill': 'rgba(60,45,30,0.07)',
  accent: '#526657', 'on-accent': '#F3F0EA', ok: '#4E6547', caution: '#73592A',
  danger: '#A63A2A', idle: '#5C5854', shadow: '#31302D',
};

const expectedDark: Record<string, string> = {
  background: '#161514', text: '#DDD9D1', muted: '#9E9992', border: '#2C2A27',
  surface: '#201F1D', human: '#2A2C29', 'control-fill': 'rgba(240,230,215,0.10)',
  accent: '#A5BAA9', 'on-accent': '#19211B', ok: '#A5BC9C', caution: '#D8BE84',
  danger: '#EE8B75', idle: '#9E9992', shadow: '#000000',
};

describe('Nordic theme', () => {
  it('defines one exact light/dark palette and follows system appearance', () => {
    const { light, dark } = tokenBlocks(themeCss);
    expect(light).toEqual(expectedLight);
    expect(dark).toEqual(expectedDark);
    expect(themeCss).toContain('color-scheme: light dark;');
    expect(themeCss).toContain('@media (prefers-color-scheme: dark)');
  });

  it('keeps every specified text pairing at or above 4.5:1 after surface compositing', () => {
    const { light, dark } = tokenBlocks(themeCss);
    for (const [variant, tokens] of Object.entries({ light, dark })) {
      const background = parseColor(tokens.background);
      const text = parseColor(tokens.text);
      const muted = parseColor(tokens.muted);
      const surface = parseColor(tokens.surface);
      const human = parseColor(tokens.human);
      const controlFill = parseColor(tokens['control-fill']);
      const danger = parseColor(tokens.danger);
      const accent = parseColor(tokens.accent);
      const onAccent = parseColor(tokens['on-accent']);
      const worstCodeSurface = composite({ ...text, alpha: 0.09 }, human);
      const textOnControlOverHuman = composite(controlFill, human);
      const dangerOnControlOverBackground = composite(controlFill, background);
      const pairings: Array<[string, Color, Color]> = [
        ['text on background', text, background],
        ['text on agent surface', text, surface],
        ['text on human surface', text, human],
        ['text on worst code surface', text, worstCodeSurface],
        ['text on control fill over human surface', text, textOnControlOverHuman],
        ['muted on background', muted, background],
        ['muted on agent surface', muted, surface],
        ['muted on human surface', muted, human],
        ['danger on background', danger, background],
        ['danger on control fill over background', danger, dangerOnControlOverBackground],
        ['disabled Retry label on human surface', muted, human],
        ['disabled page button label on background', muted, background],
        ['send arrow on accent', onAccent, accent],
      ];

      for (const [name, foreground, actualBackground] of pairings) {
        expect(contrast(foreground, actualBackground), `${variant}: ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps disabled text fully opaque and uses the shared palette on every served surface', () => {
    expect(componentCss).toMatch(/\.tb-chat button:disabled\s*\{\s*cursor:\s*default;\s*\}/);
    expect(componentCss).toMatch(/\.tb-chat-send-actions button:disabled,[\s\S]*?background:\s*transparent;\s*color:\s*var\(--tb-chat-muted\);/);
    expect(componentCss).not.toMatch(/\.tb-chat-(?:send-actions|notice|history-error|status-popup)[^{]*:disabled\s*\{[^}]*opacity\s*:/);
    expect(hostComposerCss).toMatch(/\.host-composer-actions button:disabled\s*\{\s*cursor:\s*default;\s*background:\s*transparent;\s*color:\s*var\(--tb-chat-muted\);\s*\}/);
    expect(hostComposerCss).not.toMatch(/\.host-composer-actions button:disabled\s*\{[^}]*opacity\s*:/);
    expect(componentCss).toContain('color: var(--tb-chat-text);');
    expect(componentCss).toContain('color: var(--tb-chat-danger);');
    expect(siteCss).toContain('color: var(--tb-chat-muted);');
    expect(hostComposerCss).toContain('background: var(--tb-chat-surface);');
  });

  it('keeps color literals inside the single theme definition', () => {
    const colorLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-[\w-]+)?|outline(?:-[\w-]+)?|box-shadow|text-shadow)\s*:\s*(?:white|black|red|green|blue|gray|grey|orange|purple|yellow|pink|brown|navy|teal|silver|maroon)\b/im;
    expect(componentCss).toContain("@import './theme.css';");
    expect(siteCss).toContain("@import '../src/theme.css';");
    for (const [index, css] of servedStyles.entries()) {
      expect(css, `served stylesheet ${index + 1}`).not.toMatch(colorLiteral);
    }
    expect(themeCss.match(/#[\da-f]{6}\b/gi) ?? []).toHaveLength(26);
  });
});
