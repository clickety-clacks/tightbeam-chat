import type { Element, ElementContent, Root } from 'hast';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight({
  bash,
  css,
  diff,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml,
});

const languageByFenceTag: Readonly<Record<string, string>> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  python: 'python',
  sql: 'sql',
  ts: 'typescript',
  typescript: 'typescript',
  html: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

function classNames(node: Element): string[] {
  const value = node.properties.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function languageFor(node: Element): string | undefined {
  for (const className of classNames(node)) {
    const tag = className.startsWith('language-') ? className.slice(9)
      : className.startsWith('lang-') ? className.slice(5) : undefined;
    if (!tag) continue;
    return languageByFenceTag[tag.toLowerCase()];
  }
  return undefined;
}

function textContent(node: Root | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' || node.type === 'root') {
    return node.children.map(child => textContent(child)).join('');
  }
  return '';
}

function highlightCode(node: Element): void {
  const language = languageFor(node);
  if (!language) return;

  const source = node.children.map(child => textContent(child)).join('');
  const highlighted = lowlight.highlight(language, source, { ignoreIllegals: true });
  const classes = classNames(node);
  if (!classes.includes('hljs')) classes.push('hljs');
  node.properties.className = classes;
  node.children = highlighted.children as ElementContent[];
}

function visit(node: Root | Element | ElementContent, parentTag?: string): void {
  if (node.type === 'text') return;
  if (node.type === 'element' && node.tagName === 'code' && parentTag === 'pre') {
    highlightCode(node);
  }

  if (node.type === 'root' || node.type === 'element') {
    const childParent = node.type === 'element' ? node.tagName : undefined;
    for (const child of node.children) {
      if (child.type === 'root' || child.type === 'element' || child.type === 'text') {
        visit(child, childParent);
      }
    }
  }
}

/** Color only explicitly tagged fenced blocks in the registered language subset. */
export function highlightRecognizedCode() {
  return (tree: Root): void => visit(tree);
}
