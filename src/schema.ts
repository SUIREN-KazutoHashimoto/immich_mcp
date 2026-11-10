import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { Schema } from "./types.js";
import { BridgeError } from "./types.js";

export function convertSchema(schema: Schema, schemas: Record<string, Schema>): Schema {
  const defs: Record<string, Schema> = Object.create(null);
  const visit = (s: any): any => {
    if (Array.isArray(s)) return s.map(visit);
    if (!s || typeof s !== "object") return s;
    const out: Schema = {};
    for (const [k,v] of Object.entries(s)) {
      if (k === "nullable") continue;
      if (k === "$ref") {
        if (typeof v !== "string" || !v.startsWith("#/components/schemas/")) throw Error("Unsupported schema reference");
        const name = v.slice("#/components/schemas/".length);
        if (!Object.hasOwn(schemas, name)) throw Error("Missing schema: " + name);
        if (!Object.hasOwn(defs, name)) { defs[name] = {}; defs[name] = visit(schemas[name]); }
        out.$ref = "#/$defs/" + name;
      } else if (["properties", "patternProperties", "$defs"].includes(k)) {
        out[k] = Object.fromEntries(Object.entries(v as object).map(([key,val])=>[key, visit(val)]));
      } else if (["items","additionalProperties","allOf","oneOf","anyOf","not"].includes(k)) out[k] = visit(v);
      else out[k] = v;
    }
    for(const [exclusive,inclusive] of [["exclusiveMinimum","minimum"],["exclusiveMaximum","maximum"]] as const){
      if(typeof s[exclusive]==="boolean"){
        delete out[exclusive];
        if(s[exclusive]===true&&typeof s[inclusive]==="number"){out[exclusive]=s[inclusive];delete out[inclusive];}
      }
    }
    return s.nullable ? { anyOf: [out, {type:"null"}] } : out;
  };
  const converted = visit(schema);
  return { ...converted, $defs: defs };
}
export type Validator = (value: unknown) => void;
interface CacheLimits { maxEntries?: number; maxSchemaBytes?: number; }
interface CacheEntry { check: Validator; schemaBytes: number; }

// Each compiler owns only one converted schema. A shared Ajv keeps code-generation
// scope references even after removeSchema, so evicting its cache is insufficient.
function compile(schema: Schema): Validator {
  const compiler = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, $data: false });
  (addFormats as any)(compiler);
  const validate = compiler.compile(schema);
  return (value: unknown) => {
    if (!validate(value)) throw new BridgeError("invalid_input", "Input does not match upstream schema");
  };
}

export class SchemaValidatorCache {
  private readonly entries = new Map<string, CacheEntry>();
  readonly maxEntries: number;
  readonly maxSchemaBytes: number;
  private schemaBytes = 0;
  private compilations = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private uncached = 0;

  constructor(limits: CacheLimits = {}) {
    this.maxEntries = limits.maxEntries ?? 256;
    this.maxSchemaBytes = limits.maxSchemaBytes ?? 8 * 1024 * 1024;
    for (const value of [this.maxEntries, this.maxSchemaBytes])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid schema cache limit");
  }

  validator(schema: Schema, schemas: Record<string, Schema>): Validator {
    const converted = convertSchema(schema, schemas);
    let key: string | undefined;
    try {
      key = JSON.stringify(converted, function (this: Record<string, unknown>, name: string, value: unknown) {
        const kind = typeof value;
        if (["undefined", "function", "symbol", "bigint"].includes(kind)
          || (kind === "number" && !Number.isFinite(value))
          || this[name] !== value) throw new Error("Non-JSON schema value");
        if (value !== null && kind === "object") {
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
            throw new Error("Non-JSON schema object");
        }
        return value;
      });
    } catch { /* Non-JSON annotations are never cached or silently transformed. */ }
    if (key !== undefined) {
      const found = this.entries.get(key);
      if (found) {
        this.entries.delete(key);
        this.entries.set(key, found);
        this.hits++;
        return found.check;
      }
    }
    this.misses++;
    this.compilations++;
    // Snapshot nested enum/default/annotation objects as well as reachable refs.
    // Later caller mutations must not change a previously cached validator.
    const check = compile(key !== undefined ? JSON.parse(key) : converted);
    const size = key === undefined ? 0 : Buffer.byteLength(key);
    if (key === undefined || size > this.maxSchemaBytes) {
      this.uncached++;
      return check;
    }
    while (this.entries.size >= this.maxEntries || this.schemaBytes + size > this.maxSchemaBytes) {
      const oldest = this.entries.entries().next().value!;
      this.entries.delete(oldest[0]);
      this.schemaBytes -= oldest[1].schemaBytes;
      this.evictions++;
    }
    this.entries.set(key, { check, schemaBytes: size });
    this.schemaBytes += size;
    return check;
  }

  stats() {
    return {
      entries: this.entries.size, schemaBytes: this.schemaBytes,
      maxEntries: this.maxEntries, maxSchemaBytes: this.maxSchemaBytes,
      compilations: this.compilations, hits: this.hits, misses: this.misses,
      evictions: this.evictions, uncached: this.uncached,
    };
  }
}

const validationCache = new SchemaValidatorCache();
export function validator(schema: Schema, schemas: Record<string, Schema>): Validator {
  return validationCache.validator(schema, schemas);
}
export function schemaValidationStats() { return validationCache.stats(); }
export function assertSafeNumbers(value: any): void {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
    throw new BridgeError("unsafe_number", "Number cannot be represented safely");
  if (Array.isArray(value)) value.forEach(assertSafeNumbers);
  else if (value && typeof value === "object") Object.values(value).forEach(assertSafeNumbers);
}
