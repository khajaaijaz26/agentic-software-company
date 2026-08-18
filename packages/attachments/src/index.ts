import {createHash} from "node:crypto";
import {lstat, readdir, readFile, realpath} from "node:fs/promises";
import {basename, extname, isAbsolute, relative, resolve, sep} from "node:path";
import {z} from "zod";
import {ArtifactManifestSchema, type ArtifactManifest, type ArtifactStore} from "../../artifact-store/src/index.js";

export const AttachmentFindingSchema = z.object({
  scanner: z.enum(["malware", "secret", "pii", "type", "prompt-injection"]),
  severity: z.enum(["info", "warning", "block"]),
  code: z.string(),
  summary: z.string(),
});

export const AttachmentReceiptSchema = z.object({
  schema: z.literal("agent-company.attachment/v1"),
  attachment_id: z.string(),
  source: z.object({kind: z.enum(["file", "folder", "stdin", "clipboard", "url"]), display_name: z.string()}),
  state: z.enum(["READY", "QUARANTINED", "BLOCKED", "FAILED"]),
  artifact: ArtifactManifestSchema.optional(),
  children: z.array(ArtifactManifestSchema).default([]),
  findings: z.array(AttachmentFindingSchema),
  transfer_count: z.literal(0),
  created_at: z.iso.datetime(),
});

export type AttachmentReceipt = z.infer<typeof AttachmentReceiptSchema>;
export type AttachmentFinding = z.infer<typeof AttachmentFindingSchema>;

export interface AttachmentPolicy {
  readonly allowedRoots: readonly string[];
  readonly maxFileBytes: number;
  readonly maxFolderBytes: number;
  readonly maxFolderFiles: number;
}

const DEFAULT_POLICY: AttachmentPolicy = {
  allowedRoots: [process.cwd()],
  maxFileBytes: 100 * 1024 * 1024,
  maxFolderBytes: 500 * 1024 * 1024,
  maxFolderFiles: 10_000,
};

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["github-token", /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{16,}\b/u],
  ["supabase-token", /\bsbp_[A-Za-z0-9]{16,}\b/u],
  ["generic-secret", /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu],
];

export class AttachmentService {
  readonly #store: ArtifactStore;
  readonly #policy: AttachmentPolicy;

  public constructor(store: ArtifactStore, policy: Partial<AttachmentPolicy> = {}) {
    this.#store = store;
    this.#policy = {...DEFAULT_POLICY, ...policy};
  }

  public async ingestFile(path: string): Promise<AttachmentReceipt> {
    const safePath = await this.#safePath(path);
    const details = await lstat(safePath);
    if (!details.isFile()) {
      throw new AttachmentError("ATTACHMENT_NOT_FILE", `${path} is not a regular file`);
    }
    if (details.size > this.#policy.maxFileBytes) {
      throw new AttachmentError("ATTACHMENT_TOO_LARGE", `${path} exceeds ${this.#policy.maxFileBytes} bytes`);
    }
    const bytes = await readFile(safePath);
    return this.ingestBytes(bytes, basename(safePath), "file");
  }

  public async ingestBytes(
    bytes: Uint8Array,
    displayName: string,
    kind: "file" | "stdin" | "clipboard" = "stdin",
  ): Promise<AttachmentReceipt> {
    if (bytes.byteLength > this.#policy.maxFileBytes) {
      throw new AttachmentError("ATTACHMENT_TOO_LARGE", `${displayName} exceeds ${this.#policy.maxFileBytes} bytes`);
    }
    const mediaType = detectMediaType(bytes, displayName);
    const findings = scan(bytes, mediaType);
    const state = deriveState(findings);
    const artifact = await this.#store.put(bytes, {
      logicalName: displayName,
      mediaType,
      producer: "attachment-ingest",
      classification: findings.some((finding) => finding.scanner === "pii" || finding.scanner === "secret")
        ? "confidential"
        : "internal",
    });
    return AttachmentReceiptSchema.parse({
      schema: "agent-company.attachment/v1",
      attachment_id: `att_${artifact.sha256.slice(0, 20)}`,
      source: {kind, display_name: displayName},
      state,
      artifact,
      children: [],
      findings,
      transfer_count: 0,
      created_at: new Date().toISOString(),
    });
  }

  public async ingestDirectory(path: string): Promise<AttachmentReceipt> {
    const root = await this.#safePath(path);
    const details = await lstat(root);
    if (!details.isDirectory()) {
      throw new AttachmentError("ATTACHMENT_NOT_DIRECTORY", `${path} is not a directory`);
    }
    const files = await walk(root, this.#policy.maxFolderFiles);
    const children: ArtifactManifest[] = [];
    const findings: AttachmentFinding[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const fileDetails = await lstat(file);
      totalBytes += fileDetails.size;
      if (totalBytes > this.#policy.maxFolderBytes) {
        throw new AttachmentError("ATTACHMENT_FOLDER_TOO_LARGE", `${path} exceeds ${this.#policy.maxFolderBytes} bytes`);
      }
      if (fileDetails.size > this.#policy.maxFileBytes) {
        findings.push({
          scanner: "type",
          severity: "block",
          code: "FILE_LIMIT_EXCEEDED",
          summary: `${relative(root, file)} exceeds the per-file limit`,
        });
        continue;
      }
      const bytes = await readFile(file);
      const mediaType = detectMediaType(bytes, file);
      const itemFindings = scan(bytes, mediaType).map((finding) => ({
        ...finding,
        summary: `${relative(root, file)}: ${finding.summary}`,
      }));
      findings.push(...itemFindings);
      children.push(await this.#store.put(bytes, {
        logicalName: relative(root, file).replaceAll(sep, "/"),
        mediaType,
        producer: "attachment-folder-ingest",
        classification: itemFindings.some((finding) => finding.scanner === "pii" || finding.scanner === "secret")
          ? "confidential"
          : "internal",
      }));
    }
    const manifestBytes = Buffer.from(JSON.stringify(children.map((child) => ({
      path: child.logical_name,
      sha256: child.sha256,
      size_bytes: child.size_bytes,
      media_type: child.media_type,
    })).sort((left, right) => left.path.localeCompare(right.path))));
    const artifact = await this.#store.put(manifestBytes, {
      logicalName: `${basename(root)}.attachment-manifest.json`,
      mediaType: "application/vnd.agent-company.folder-manifest+json",
      producer: "attachment-folder-ingest",
    });
    return AttachmentReceiptSchema.parse({
      schema: "agent-company.attachment/v1",
      attachment_id: `att_${artifact.sha256.slice(0, 20)}`,
      source: {kind: "folder", display_name: basename(root)},
      state: deriveState(findings),
      artifact,
      children,
      findings,
      transfer_count: 0,
      created_at: new Date().toISOString(),
    });
  }

  async #safePath(path: string): Promise<string> {
    const candidate = resolve(isAbsolute(path) ? path : resolve(process.cwd(), path));
    const actual = await realpath(candidate);
    for (const root of this.#policy.allowedRoots) {
      const actualRoot = await realpath(resolve(root));
      const distance = relative(actualRoot, actual);
      if (distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance))) {
        return actual;
      }
    }
    throw new AttachmentError("ATTACHMENT_OUTSIDE_ALLOWED_ROOT", `${path} is outside configured attachment roots`);
  }
}

export class AttachmentError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function scan(bytes: Uint8Array, mediaType: string): AttachmentFinding[] {
  const findings: AttachmentFinding[] = [];
  const text = isTextual(mediaType) ? Buffer.from(bytes).toString("utf8") : "";
  if (Buffer.from(bytes).includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"))) {
    findings.push({scanner: "malware", severity: "block", code: "EICAR_TEST_SIGNATURE", summary: "malware test signature detected"});
  }
  for (const [code, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({scanner: "secret", severity: "block", code: code.toUpperCase().replaceAll("-", "_"), summary: `${code} pattern detected`});
    }
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/u.test(text)) {
    findings.push({scanner: "pii", severity: "warning", code: "US_SSN_PATTERN", summary: "possible US social-security number detected"});
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text)) {
    findings.push({scanner: "pii", severity: "warning", code: "EMAIL_ADDRESS", summary: "email address detected"});
  }
  if (/(?:ignore|override|disregard).{0,80}(?:system|developer|previous).{0,40}(?:prompt|instructions)/isu.test(text)) {
    findings.push({scanner: "prompt-injection", severity: "warning", code: "INSTRUCTION_OVERRIDE_PATTERN", summary: "untrusted instruction-override language detected"});
  }
  if (mediaType === "application/octet-stream") {
    findings.push({scanner: "type", severity: "info", code: "OPAQUE_BINARY", summary: "content type is opaque; no text projection is allowed"});
  }
  return findings;
}

function deriveState(findings: readonly AttachmentFinding[]): AttachmentReceipt["state"] {
  if (findings.some((finding) => finding.scanner === "malware" && finding.severity === "block")) {
    return "QUARANTINED";
  }
  if (findings.some((finding) => finding.severity === "block")) {
    return "BLOCKED";
  }
  return "READY";
}

function detectMediaType(bytes: Uint8Array, name: string): string {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return extname(name).toLowerCase() === ".docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/zip";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const extension = extname(name).toLowerCase();
  if ([".md", ".txt", ".log"].includes(extension)) return "text/plain";
  if ([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"].includes(extension)) return "text/x-source";
  if (extension === ".json") return "application/json";
  if ([".yaml", ".yml"].includes(extension)) return "application/yaml";
  if (extension === ".svg") return "image/svg+xml";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0) ? "application/octet-stream" : "text/plain";
}

function isTextual(mediaType: string): boolean {
  return mediaType.startsWith("text/") || ["application/json", "application/yaml", "image/svg+xml"].includes(mediaType);
}

async function walk(root: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if ([".git", ".agent-company", "node_modules", "__pycache__"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile()) result.push(path);
      if (result.length > limit) {
        throw new AttachmentError("ATTACHMENT_FILE_COUNT_EXCEEDED", `folder contains more than ${limit} files`);
      }
    }
  }
  return result.sort();
}

export function receiptDigest(receipt: AttachmentReceipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}
