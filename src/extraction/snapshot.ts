import { parseHTML } from 'linkedom';
import { ArgumentError } from '../errors.js';
import { MAX_HTML_BYTES, parseSnapshot } from './validation.js';
import type { PageSnapshot } from './types.js';

export const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false" i])';
const REMOVED_SELECTOR = `script:not([type="application/ld+json"]),style,noscript,template,iframe,form,input,textarea,select,${EDITABLE_SELECTOR}`;

export const SNAPSHOT_EXPRESSION = `(() => {
  const root = document.documentElement.cloneNode(true);
  if (root.matches(${JSON.stringify(EDITABLE_SELECTOR)})) throw new Error('Editable documents cannot be captured');
  root.querySelectorAll(${JSON.stringify(REMOVED_SELECTOR)}).forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(a => {
      if (/^on/i.test(a.name) || /^(nonce|value)$/i.test(a.name) || /(token|secret|password|authorization|cookie|session)/i.test(a.name)) el.removeAttribute(a.name);
    });
  });
  const html = root.outerHTML;
  if (html.length > ${MAX_HTML_BYTES}) throw new Error('Page exceeds the extraction snapshot size limit');
  return {version:1,url:location.href,title:document.title,observedAt:new Date().toISOString(),html};
})()`;

export function sanitizeSnapshot(input: unknown): PageSnapshot {
  const snapshot = parseSnapshot(input);
  const { document } = parseHTML(snapshot.html);
  const dom = document as unknown as Document;
  if (dom.documentElement?.matches(EDITABLE_SELECTOR)) throw new ArgumentError('Editable documents cannot be captured');
  dom.querySelectorAll(REMOVED_SELECTOR).forEach(node => node.remove());
  dom.querySelectorAll('*').forEach(el => {
    for (const attribute of Array.from(el.attributes)) {
      if (/^on/i.test(attribute.name) || /^(nonce|value)$/i.test(attribute.name) || /(token|secret|password|authorization|cookie|session)/i.test(attribute.name)) el.removeAttribute(attribute.name);
    }
  });
  const html = document.toString();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new ArgumentError('Page exceeds the extraction snapshot size limit');
  return { ...snapshot, html };
}
