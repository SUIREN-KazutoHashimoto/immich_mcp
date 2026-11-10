export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, any>;
export interface Operation {
  operationId: string; method: string; path: string; tag: string;
  definition: Schema; parameters: Schema[]; auth: Schema; override?: Schema;
}
export interface Registry {
  version: string; commit: string; sha256: string;
  authContexts: Schema;
  operations: Operation[]; schemas: Record<string, Schema>; secretRules: Schema[];
}
export interface ApiCall {
  operation_id: string; path?: Record<string, any>; query?: Record<string, any>;
  headers?: Record<string, any>; content_type?: string; body?: any;
  files?: Record<string, { file_ref: string }>;
  secret_bindings?: { location: string; pointer: string; secret_ref: string }[];
  result_mode?: "auto" | "inline" | "reference"; execution_mode?: "auto" | "sync" | "async";
}
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
