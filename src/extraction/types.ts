export type Scalar = string | number | boolean | null;
export type ScalarType = 'string' | 'number' | 'integer' | 'boolean';

export interface FieldSchema {
  type: ScalarType;
  nullable: boolean;
  description?: string;
  enum?: Scalar[];
  minimum?: number;
  maximum?: number;
}

export interface ExtractionSchema {
  properties: Record<string, FieldSchema>;
  required: string[];
}

export interface DomSource {
  source: 'dom';
  selector: string;
  read: 'text' | 'attribute';
  attribute?: string;
}

export interface JsonLdSource {
  source: 'jsonld';
  path: string;
}

export interface ExtractionRule {
  version: 1;
  scope: { origin: string; pathPrefix: string };
  template?: { selectors: string[]; textRegions?: { selector: string; within: string }[] };
  fields: Record<string, DomSource | JsonLdSource>;
}

export interface PageSnapshot {
  version: 1;
  url: string;
  title: string;
  observedAt: string;
  html: string;
}

export interface FieldEvidence {
  value: Scalar;
  raw: string | null;
  locator: string;
  matches: number;
  status: 'observed' | 'missing' | 'invalid' | 'ambiguous';
}

export interface ExtractionIssue {
  field: string;
  code: 'missing' | 'invalid' | 'ambiguous' | 'scope' | 'template';
  message: string;
}

export interface ExtractionResult {
  status: 'verified' | 'partial' | 'invalid';
  url: string;
  observedAt: string;
  contentHash: string;
  templateHash: string;
  data: Record<string, Scalar>;
  evidence: Record<string, FieldEvidence>;
  issues: ExtractionIssue[];
}

export interface RuleEntry {
  version: 1;
  key: string;
  rule: ExtractionRule;
  templateHash: string;
  revision: number;
  createdAt: string;
}
