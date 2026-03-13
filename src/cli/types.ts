export type OutputFormat = 'json' | 'text' | 'markdown' | 'ndjson';

export interface CommandDefinition {
  name: string;
  description: string;
  parameters: ParameterDefinition[];
  examples?: string[];
}

export interface ParameterDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
  default?: unknown;
}

export interface CliContext {
  outputFormat: OutputFormat;
  fields?: string[];
  quiet: boolean;
}
