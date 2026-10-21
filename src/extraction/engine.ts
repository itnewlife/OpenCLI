import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { ArgumentError } from '../errors.js';
import { EDITABLE_SELECTOR } from './snapshot.js';
import { matchesType, parseRule, parseSchema, parseSnapshot } from './validation.js';
import type { ExtractionResult, ExtractionRule, FieldEvidence, FieldSchema, Scalar } from './types.js';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pathMatches(pathname: string, prefix: string): boolean {
  return prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function numberFrom(value: string): number | null {
  const plain = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(plain)) return null;
  const result = Number(plain);
  return Number.isFinite(result) ? result : null;
}

function convert(raw: string, field: FieldSchema): Scalar | undefined {
  const value: Scalar | undefined = field.type === 'string' ? raw
    : field.type === 'boolean' ? raw === 'true' ? true : raw === 'false' ? false : undefined
    : numberFrom(raw) ?? undefined;
  if (value === undefined || !matchesType(value, field)) return undefined;
  if (typeof value === 'number' && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) return undefined;
  if (field.enum && !field.enum.includes(value)) return undefined;
  return value;
}

function templateStructure(elements: Element[]): string {
  const positions = new Map(elements.map((element, index) => [element, index]));
  return elements.map(el => `${positions.get(el.parentElement!) ?? -1}:${el.tagName.toLowerCase()}[${Array.from(el.attributes).map(a => a.name).sort().join(',')}]`).join('\n');
}

function templateRegions(dom: Document, selectors?: string[]): Element[] | null {
  if (!selectors) return [];
  const roots: Element[] = [];
  try {
    for (const selector of selectors) {
      const matches = Array.from(dom.querySelectorAll(selector));
      if (matches.length !== 1) return null;
      const root = matches[0];
      if (roots.some(existing => existing === root || existing.contains(root) || root.contains(existing))) return null;
      roots.push(root);
    }
  } catch { return null; }
  return roots;
}

const TEXT_TAGS = new Set(['div', 'p', 'span', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'small', 'sub', 'sup', 'mark', 'blockquote', 'q', 'code', 'pre', 'ul', 'ol', 'li', 'a']);

function ownerPath(root: Element, owner: Element): string {
  const chain: Element[] = [];
  let current: Element | null = root;
  while (current && current !== owner) {
    chain.unshift(current);
    current = current.parentElement;
  }
  chain.unshift(owner);
  return templateStructure(chain);
}

function textTemplateRegions(dom: Document, declarations: NonNullable<ExtractionRule['template']>['textRegions']): { roots: Element[]; owners: Element[]; structure: string } | null {
  const roots: Element[] = [];
  const owners: Element[] = [];
  const structure: string[] = [];
  try {
    for (const declaration of declarations ?? []) {
      const matches = Array.from(dom.querySelectorAll(declaration.selector));
      const containers = Array.from(dom.querySelectorAll(declaration.within));
      if (matches.length !== 1 || containers.length !== 1) return null;
      const root = matches[0];
      const owner = containers[0];
      if (root === owner || !owner.contains(root)) return null;
      const descendants = [root, ...Array.from(root.querySelectorAll('*'))];
      if (descendants.some(node => !TEXT_TAGS.has(node.tagName.toLowerCase()) || node.matches(EDITABLE_SELECTOR) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true')) return null;
      roots.push(root);
      owners.push(owner);
      structure.push(`${declaration.selector}\nwithin:${declaration.within}\n${ownerPath(root, owner)}`);
    }
  } catch { return null; }
  return { roots, owners, structure: structure.join('\n--text-region--\n') };
}

function distinctRegions(roots: Element[]): boolean {
  return roots.every((root, index) => roots.slice(0, index).every(existing => existing !== root && !existing.contains(root) && !root.contains(existing)));
}

function inRegions(node: Element, roots: Element[]): boolean {
  return roots.some(root => root === node || root.contains(node));
}

function jsonObjects(document: Document, regions: Element[]): unknown[] {
  const result: unknown[] = [];
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    if (regions.length && !inRegions(node, regions)) continue;
    try {
      const value: unknown = JSON.parse(node.textContent ?? '');
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        result.push(entry);
        if (entry && typeof entry === 'object' && '@graph' in entry && Array.isArray(entry['@graph'])) result.push(...entry['@graph']);
      }
    } catch { /* Malformed structured data is not an observed field. */ }
  }
  return result;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractWithRule(snapshotInput: unknown, schemaInput: unknown, ruleInput: unknown): ExtractionResult {
  const snapshot = parseSnapshot(snapshotInput);
  const schema = parseSchema(schemaInput);
  const rule = parseRule(ruleInput, schema);
  const { document } = parseHTML(snapshot.html);
  const dom = document as unknown as Document;
  const elements = Array.from(dom.querySelectorAll('*'));
  if (elements.length > 20_000) throw new ArgumentError('Snapshot exceeds the 20,000 element extraction limit');
  const structuralRegions = templateRegions(dom, rule.template?.selectors);
  const textRegions = textTemplateRegions(dom, rule.template?.textRegions);
  const sharedOwner = !textRegions?.owners.length || (textRegions.owners.every(owner => owner === textRegions.owners[0])
    && structuralRegions?.every(root => textRegions.owners[0].contains(root)));
  const regions = structuralRegions && textRegions && sharedOwner && distinctRegions([...structuralRegions, ...textRegions.roots])
    ? [...structuralRegions, ...textRegions.roots] : null;
  const structuralIdentity = structuralRegions?.length
    ? structuralRegions.map((root, index) => `${rule.template!.selectors[index]}\n${templateStructure([root, ...Array.from(root.querySelectorAll('*'))])}`).join('\n--region--\n')
    : templateStructure(elements);
  const anchoredIdentity = textRegions?.owners.length && structuralRegions
    ? structuralRegions.map(root => ownerPath(root, textRegions.owners[0])).join('\n--owner-path--\n') : '';
  const structure = rule.template?.textRegions
    ? `${structuralIdentity}\n--text-regions-v1--\n${textRegions?.structure ?? 'invalid'}\n${anchoredIdentity}`
    : structuralIdentity;
  const result: ExtractionResult = {
    status: 'verified', url: snapshot.url, observedAt: snapshot.observedAt,
    contentHash: digest(snapshot.html), templateHash: digest(structure),
    data: Object.create(null), evidence: Object.create(null), issues: [],
  };
  const url = new URL(snapshot.url);
  if (url.origin !== rule.scope.origin || !pathMatches(url.pathname, rule.scope.pathPrefix)) {
    result.status = 'invalid';
    result.issues.push({ field: '*', code: 'scope', message: 'Page does not match the rule origin and path scope' });
    return result;
  }
  if (regions === null) {
    result.status = 'invalid';
    result.issues.push({ field: '*', code: 'template', message: 'Template region selectors must each match one distinct, non-overlapping element' });
    return result;
  }
  const structured = jsonObjects(dom, regions);
  for (const [name, field] of Object.entries(schema.properties)) {
    const source = rule.fields[name];
    const locator = !source ? '' : source.source === 'dom'
      ? `${source.selector}${source.read === 'attribute' ? `@${source.attribute}` : ':text'}` : `jsonld:${source.path}`;
    const evidence: FieldEvidence = { value: null, raw: null, locator, matches: 0, status: 'missing' };
    result.data[name] = null;
    result.evidence[name] = evidence;
    let values: unknown[] = [];
    let sourceInvalid = false;
    if (source?.source === 'dom') {
      try {
        const nodes = Array.from(dom.querySelectorAll(source.selector));
        const unsafe = `script, style, form, input, textarea, select, ${EDITABLE_SELECTOR}`;
        const flexible = textRegions!.roots;
        if (nodes.some(node => flexible.some(root => root === node || root.contains(node))
          && (!flexible.includes(node) || field.type !== 'string' || source.read !== 'text'))) {
          sourceInvalid = true;
          result.issues.push({ field: name, code: 'template', message: `${name}: text regions only support a string text read of the complete declared container` });
        } else if (regions.length && nodes.some(node => !inRegions(node, regions))) {
          sourceInvalid = true;
          result.issues.push({ field: name, code: 'template', message: `${name}: source lies outside the validated template regions` });
        } else if (nodes.some(node => node.closest(unsafe) || node.querySelector(unsafe))) {
          sourceInvalid = true;
        } else {
          values = nodes.map(node => source.read === 'text' ? node.textContent : node.getAttribute(source.attribute!));
        }
      } catch { sourceInvalid = true; }
    } else if (source?.source === 'jsonld') {
      values = structured.map(entry => readPath(entry, source.path)).filter(v => v !== undefined && v !== null);
    }
    evidence.matches = values.length;
    if (sourceInvalid) evidence.status = 'invalid';
    else if (values.length > 1) evidence.status = 'ambiguous';
    else if (values.length === 1 && values[0] !== null && values[0] !== undefined) {
      const rawValue = values[0];
      if (!['string', 'number', 'boolean'].includes(typeof rawValue)) evidence.status = 'invalid';
      else {
        const raw = String(rawValue).replace(/\s+/g, ' ').trim();
        if (raw) {
          evidence.raw = raw;
          if (raw.length > 20_000) evidence.status = 'invalid';
          else {
            const value = convert(raw, field);
            if (value === undefined) evidence.status = 'invalid';
            else {
              evidence.value = value;
              evidence.status = 'observed';
              result.data[name] = value;
            }
          }
        }
      }
    }
    if (evidence.status !== 'observed') {
      if (evidence.status !== 'missing' || schema.required.includes(name)) {
        result.issues.push({ field: name, code: evidence.status, message: `${name}: ${evidence.status} source evidence` });
        result.status = 'invalid';
      } else if (result.status !== 'invalid') result.status = 'partial';
    }
  }
  return result;
}
