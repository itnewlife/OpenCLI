import { ArgumentError } from '../errors.js';
import type { ExtractionRule, ExtractionSchema, FieldSchema, PageSnapshot, Scalar, ScalarType } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_FIELDS = 64;
export const MAX_HTML_BYTES = 2_000_000;

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArgumentError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) || FORBIDDEN_KEYS.has(key)) throw new ArgumentError(`Unsupported ${label} key: ${key}`);
  }
}

export function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ArgumentError(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export function httpUrl(value: unknown): URL {
  const input = text(value, 'URL', 8192);
  let url: URL;
  try { url = new URL(input); } catch { throw new ArgumentError('Expected an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ArgumentError('Expected an HTTP(S) URL without credentials');
  return url;
}

export function parseSchema(value: unknown): ExtractionSchema {
  const root = object(value, 'schema');
  keys(root, ['type', 'properties', 'required', 'additionalProperties'], 'schema');
  if (root.type !== 'object' || root.additionalProperties !== false) throw new ArgumentError('Schema must have type object and additionalProperties false');
  const properties = object(root.properties, 'schema.properties');
  const names = Object.keys(properties);
  if (!names.length || names.length > MAX_FIELDS) throw new ArgumentError(`Schema needs 1-${MAX_FIELDS} fields`);
  if (root.required !== undefined && (!Array.isArray(root.required) || root.required.some(k => typeof k !== 'string' || !names.includes(k)))) {
    throw new ArgumentError('schema.required must list existing fields');
  }
  const parsed: Record<string, FieldSchema> = Object.create(null);
  for (const name of names) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || FORBIDDEN_KEYS.has(name)) throw new ArgumentError(`Invalid field name: ${name}`);
    const field = object(properties[name], `field ${name}`);
    keys(field, ['type', 'description', 'enum', 'minimum', 'maximum'], `field ${name}`);
    const types = Array.isArray(field.type) ? field.type : [field.type];
    const nonNull = types.filter(t => t !== 'null');
    if (nonNull.length !== 1 || !['string', 'number', 'integer', 'boolean'].includes(String(nonNull[0])) || types.length > 2 || new Set(types).size !== types.length) {
      throw new ArgumentError(`Field ${name} needs one scalar type, optionally combined with null`);
    }
    const type = nonNull[0] as ScalarType;
    const result: FieldSchema = { type, nullable: types.includes('null') };
    if (field.description !== undefined) result.description = text(field.description, `${name}.description`, 1000);
    for (const constraint of ['minimum', 'maximum'] as const) {
      if (field[constraint] !== undefined) {
        if (!['number', 'integer'].includes(type) || typeof field[constraint] !== 'number' || !Number.isFinite(field[constraint])) throw new ArgumentError(`Invalid ${name}.${constraint}`);
        result[constraint] = field[constraint];
      }
    }
    if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) throw new ArgumentError(`Invalid range for ${name}`);
    if (field.enum !== undefined) {
      if (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 100 || field.enum.some(v => !matchesType(v, result))) throw new ArgumentError(`Invalid enum for ${name}`);
      result.enum = field.enum as Scalar[];
    }
    parsed[name] = result;
  }
  return { properties: parsed, required: [...new Set((root.required ?? []) as string[])] };
}

export function matchesType(value: unknown, schema: FieldSchema): boolean {
  if (value === null) return schema.nullable;
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value));
  return typeof value === schema.type;
}

export function parseRule(value: unknown, schema: ExtractionSchema): ExtractionRule {
  const root = object(value, 'rule');
  keys(root, ['version', 'scope', 'template', 'fields'], 'rule');
  if (root.version !== 1) throw new ArgumentError('Unsupported extraction rule version');
  const scope = object(root.scope, 'rule.scope');
  keys(scope, ['origin', 'pathPrefix'], 'rule.scope');
  const origin = httpUrl(scope.origin);
  if (origin.href !== `${origin.origin}/`) throw new ArgumentError('Rule origin must contain only scheme, host and optional port');
  const pathPrefix = text(scope.pathPrefix, 'rule.scope.pathPrefix', 1024);
  if (!pathPrefix.startsWith('/') || /[?#]/.test(pathPrefix) || pathPrefix.includes('\\') || pathPrefix.startsWith('//') || new URL(pathPrefix, origin.origin).pathname !== pathPrefix) throw new ArgumentError('Rule pathPrefix must be a normalized absolute URL path');
  let template: ExtractionRule['template'];
  if (root.template !== undefined) {
    const input = object(root.template, 'rule.template');
    keys(input, ['selectors', 'textRegions'], 'rule.template');
    if (!Array.isArray(input.selectors) || input.selectors.length < 1 || input.selectors.length > 8) throw new ArgumentError('Template needs 1-8 unique region selectors');
    const selectors = input.selectors.map(value => text(value, 'template selector', 512));
    if (new Set(selectors).size !== selectors.length || selectors.some(selector => /:has\(/i.test(selector))) throw new ArgumentError('Template selectors must be unique and cannot use :has');
    let textRegions: NonNullable<ExtractionRule['template']>['textRegions'];
    if (input.textRegions !== undefined) {
      if (!Array.isArray(input.textRegions) || !input.textRegions.length || input.textRegions.length + selectors.length > 8) throw new ArgumentError('Template needs at most 8 combined structural and text regions');
      textRegions = input.textRegions.map(value => {
        const region = object(value, 'template text region');
        keys(region, ['selector', 'within'], 'template text region');
        const selector = text(region.selector, 'text region selector', 512);
        const within = text(region.within, 'text region owner selector', 512);
        if (/:has\(/i.test(selector) || /:has\(/i.test(within) || selector === within) throw new ArgumentError('Text regions need distinct supported selectors for content and owner');
        return { selector, within };
      });
      const combined = [...selectors, ...textRegions.map(region => region.selector)];
      if (new Set(combined).size !== combined.length) throw new ArgumentError('Template region selectors must be unique');
    }
    template = { selectors, ...(textRegions ? { textRegions } : {}) };
  }
  const sources = object(root.fields, 'rule.fields');
  const names = Object.keys(sources);
  if (!names.length || names.some(k => !(k in schema.properties))) throw new ArgumentError('Rule fields must be a non-empty subset of schema properties');
  if (schema.required.some(k => !(k in sources))) throw new ArgumentError('Rule must define a source for every required field');
  const fields: ExtractionRule['fields'] = Object.create(null);
  for (const name of names) {
    const source = object(sources[name], `source ${name}`);
    if (source.source === 'dom') {
      keys(source, ['source', 'selector', 'read', 'attribute'], `source ${name}`);
      const selector = text(source.selector, `${name}.selector`, 512);
      if (selector.includes(':has(')) throw new ArgumentError(':has selectors are not supported');
      if (source.read !== 'text' && source.read !== 'attribute') throw new ArgumentError(`Invalid read mode for ${name}`);
      if (source.read === 'attribute') {
        const attribute = text(source.attribute, `${name}.attribute`, 128);
        if (!/^(?:content|href|src|datetime|title|alt|itemprop|data-[a-z0-9_-]+|aria-[a-z0-9_-]+)$/.test(attribute)) throw new ArgumentError(`Unsupported source attribute: ${attribute}`);
        fields[name] = { source: 'dom', selector, read: 'attribute', attribute };
      } else {
        if (source.attribute !== undefined) throw new ArgumentError('Text sources cannot specify an attribute');
        fields[name] = { source: 'dom', selector, read: 'text' };
      }
    } else if (source.source === 'jsonld') {
      keys(source, ['source', 'path'], `source ${name}`);
      const path = text(source.path, `${name}.path`, 512);
      if (!/^[a-zA-Z@_][a-zA-Z0-9@_-]*(?:\.(?:[a-zA-Z@_][a-zA-Z0-9@_-]*|\d+))*$/.test(path) || path.split('.').some(k => FORBIDDEN_KEYS.has(k))) throw new ArgumentError(`Invalid JSON-LD path for ${name}`);
      fields[name] = { source: 'jsonld', path };
    } else throw new ArgumentError(`Unsupported source for ${name}`);
  }
  return { version: 1, scope: { origin: origin.origin, pathPrefix }, ...(template ? { template } : {}), fields };
}

export function parseSnapshot(value: unknown): PageSnapshot {
  const root = object(value, 'snapshot');
  keys(root, ['version', 'url', 'title', 'observedAt', 'html'], 'snapshot');
  if (root.version !== 1) throw new ArgumentError('Unsupported snapshot version');
  const url = httpUrl(root.url).href;
  const title = typeof root.title === 'string' && root.title.length <= 4096 ? root.title : '';
  if (typeof root.observedAt !== 'string' || !Number.isFinite(Date.parse(root.observedAt))) throw new ArgumentError('Snapshot needs a valid observedAt timestamp');
  if (typeof root.html !== 'string' || !root.html.trim() || Buffer.byteLength(root.html) > MAX_HTML_BYTES) throw new ArgumentError(`Snapshot HTML must contain at most ${MAX_HTML_BYTES} bytes`);
  return { version: 1, url, title, observedAt: root.observedAt, html: root.html };
}
