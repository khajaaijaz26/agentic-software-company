import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {z} from "zod";

export const ArtifactManifestSchema = z.object({
  schema: z.union([
    z.literal("software-agent.artifact-manifest/v1"),
    z.literal("agent-company.artifact-manifest/v1"),
  ]).transform(() => "software-agent.artifact-manifest/v1" as const),
  artifact_id: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size_bytes: z.number().int().nonnegative(),
  media_type: z.string(),
  logical_name: z.string(),
  producer: z.string(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]),
  created_at: z.iso.datetime(),
  source_revision: z.string().optional(),
});

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export class ArtifactStore {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async put(
    bytes: Uint8Array,
    metadata: {
      readonly logicalName: string;
      readonly mediaType: string;
      readonly producer: string;
      readonly classification?: ArtifactManifest["classification"];
      readonly sourceRevision?: string;
    },
  ): Promise<ArtifactManifest> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(digest);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    try {
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") !== digest) {
        throw new Error(`artifact integrity mismatch at ${target}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, {mode: 0o600, flag: "wx"});
      await rename(temporary, target);
    }
    const artifactId = manifestId(digest, metadata);
    const manifestPath = this.manifestPath(artifactId);
    try {
      return validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), artifactId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const manifest: ArtifactManifest = {
      schema: "software-agent.artifact-manifest/v1",
      artifact_id: artifactId,
      sha256: digest,
      size_bytes: bytes.byteLength,
      media_type: metadata.mediaType,
      logical_name: metadata.logicalName,
      producer: metadata.producer,
      classification: metadata.classification ?? "internal",
      created_at: new Date().toISOString(),
      ...(metadata.sourceRevision === undefined ? {} : {source_revision: metadata.sourceRevision}),
    };
    await mkdir(dirname(manifestPath), {recursive: true, mode: 0o700});
    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {encoding: "utf8", mode: 0o600, flag: "wx"});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), artifactId);
    }
    return manifest;
  }

  public async getManifest(artifactId: string): Promise<ArtifactManifest> {
    return validateManifest(JSON.parse(await readFile(this.manifestPath(artifactId), "utf8")), artifactId);
  }

  public async list(): Promise<readonly ArtifactManifest[]> {
    const directory = join(this.#root, "manifests");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
      const artifactId = name.slice(0, -".json".length);
      return validateManifest(JSON.parse(await readFile(join(directory, name), "utf8")), artifactId);
    }));
    return Object.freeze(manifests);
  }

  public async read(sha256: string): Promise<Uint8Array> {
    const bytes = await readFile(this.pathFor(sha256));
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error(`artifact ${sha256} failed integrity verification`);
    }
    return bytes;
  }

  public async verify(sha256: string): Promise<boolean> {
    try {
      const target = this.pathFor(sha256);
      const details = await stat(target);
      if (!details.isFile()) {
        return false;
      }
      await this.read(sha256);
      return true;
    } catch {
      return false;
    }
  }

  public pathFor(sha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error("artifact digest must be 64 lowercase hexadecimal characters");
    }
    return join(this.#root, "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  private manifestPath(artifactId: string): string {
    if (!/^art_[a-f0-9]{20}_[a-f0-9]{12}$/u.test(artifactId)) throw new Error("invalid artifact ID");
    return join(this.#root, "manifests", `${artifactId}.json`);
  }
}

function manifestId(
  digest: string,
  metadata: {
    readonly logicalName: string;
    readonly mediaType: string;
    readonly producer: string;
    readonly classification?: ArtifactManifest["classification"];
    readonly sourceRevision?: string;
  },
): string {
  const metadataDigest = createHash("sha256").update(JSON.stringify({
    digest,
    logicalName: metadata.logicalName,
    mediaType: metadata.mediaType,
    producer: metadata.producer,
    classification: metadata.classification ?? "internal",
    sourceRevision: metadata.sourceRevision ?? null,
  })).digest("hex");
  return `art_${digest.slice(0, 20)}_${metadataDigest.slice(0, 12)}`;
}

function validateManifest(value: unknown, expectedId: string): ArtifactManifest {
  const manifest = ArtifactManifestSchema.parse(value);
  const derivedId = manifestId(manifest.sha256, {
    logicalName: manifest.logical_name,
    mediaType: manifest.media_type,
    producer: manifest.producer,
    classification: manifest.classification,
    ...(manifest.source_revision === undefined ? {} : {sourceRevision: manifest.source_revision}),
  });
  if (manifest.artifact_id !== expectedId || derivedId !== expectedId) {
    throw new Error(`artifact manifest ${expectedId} failed integrity verification`);
  }
  return manifest;
}
