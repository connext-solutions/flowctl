import { z } from 'zod';
import { ConfigError, NAME_PATTERN } from '../foundation/index.js';
import { OperationSchema, type Operation, type SpecRef } from './schema.js';

/** Which operations to return; a provider may ignore filters it cannot apply. */
export interface SpecQuery {
  ids?: string[];
}

/**
 * A read-only source of business operations (ADR 0023): markdown, Gherkin, a test-case sheet, issues, or a
 * private plugin. A provider never calls a model.
 *
 * @remarks Every return value is untrusted: core validates `operations` with {@link OperationSchema} and treats a
 *   failing or missing `signatures` as "no signature set" (ADR 0023 Amendment 2026-11-02).
 */
export interface SpecProvider {
  /** The registered name; it must pass `NAME_PATTERN` and is every operation's `location.provider`. */
  readonly name: string;
  operations(query?: SpecQuery): Promise<unknown[]>;
  /** The verbatim text a `ref` points at and the provider revision, or `null` when it no longer exists. */
  resolve(ref: SpecRef): Promise<{ quote: string; revision: string } | null>;
  /** The raw `.sig` bytes of the document a `signatureRef` names, or `null` when it has none. */
  signatures?(
    signatureRef: string,
  ): Promise<{ bytes: Uint8Array; revision: string } | null>;
}

/** The largest signature set read from a provider (ADR 0023 Amendment 2026-11-02, rule 2). */
export const MAX_SIGNATURE_BYTES = 1024 * 1024;

const Resolved = z
  .object({ quote: z.string(), revision: z.string().min(1) })
  .strict()
  .nullable();

/**
 * The providers a host application registered, by name. Registration is explicit: core never scans packages or
 * `node_modules` for providers (ADR 0023 rule 3); the CLI registers the kinds it knows, a private build adds its
 * own by calling {@link register}.
 *
 * @example
 *   const specs = new SpecRegistry();
 *   specs.register(markdownProvider(root));
 *   const ops = await specs.operations('markdown');
 */
export class SpecRegistry {
  private readonly providers = new Map<string, SpecProvider>();

  /** @throws {ConfigError} for a name that is not a flowctl name or is already registered. */
  register(provider: SpecProvider): void {
    if (!NAME_PATTERN.test(provider.name))
      throw new ConfigError(
        `spec provider name "${provider.name}" must use lowercase letters, digits and dashes`,
      );
    if (this.providers.has(provider.name))
      throw new ConfigError(
        `spec provider "${provider.name}" is already registered`,
      );
    this.providers.set(provider.name, provider);
  }

  /** Registered provider names, in registration order. */
  names(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * The provider's operations, validated.
   *
   * @throws {ConfigError} for an unregistered provider, an operation that fails the schema, or an operation whose
   *   `location.provider` is another provider.
   */
  async operations(name: string, query?: SpecQuery): Promise<Operation[]> {
    const p = this.get(name);
    const raw = await p.operations(query);
    return raw.map((item, i) => {
      const parsed = OperationSchema.safeParse(item);
      if (!parsed.success)
        throw new ConfigError(
          `spec provider "${name}" returned an invalid operation at index ${i}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      if (parsed.data.location.provider !== name)
        throw new ConfigError(
          `spec provider "${name}" returned an operation located in "${parsed.data.location.provider}"`,
        );
      return parsed.data;
    });
  }

  /**
   * The verbatim text `ref` points at, validated, or `null`.
   *
   * @throws {ConfigError} for an unregistered provider or a malformed answer.
   */
  async resolve(
    name: string,
    ref: SpecRef,
  ): Promise<{ quote: string; revision: string } | null> {
    const parsed = Resolved.safeParse(await this.get(name).resolve(ref));
    if (!parsed.success)
      throw new ConfigError(
        `spec provider "${name}" returned a malformed resolution`,
      );
    return parsed.data;
  }

  /**
   * The signature set for `signatureRef`, or `null`. A provider without the method, a thrown error, a malformed
   * answer or more than {@link MAX_SIGNATURE_BYTES} all mean "unsigned", never "signed"; nothing is retried.
   *
   * @throws {ConfigError} for an unregistered provider.
   */
  async signatures(
    name: string,
    signatureRef: string,
  ): Promise<{ bytes: Uint8Array; revision: string } | null> {
    const p = this.get(name);
    if (p.signatures === undefined) return null;
    const got = await p.signatures(signatureRef).catch(() => null);
    if (
      got === null ||
      !(got.bytes instanceof Uint8Array) ||
      typeof got.revision !== 'string' ||
      got.bytes.byteLength > MAX_SIGNATURE_BYTES
    )
      return null;
    return got;
  }

  private get(name: string): SpecProvider {
    const p = this.providers.get(name);
    if (p === undefined)
      throw new ConfigError(
        `no spec provider "${name}" is registered (registered: ${this.names().join(', ') || 'none'})`,
      );
    return p;
  }
}
