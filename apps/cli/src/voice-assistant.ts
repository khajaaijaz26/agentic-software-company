import {loadUserProviderConfig, resolvePlatformPaths, type PlatformPaths} from "../../../packages/config/src/index.js";
import type {FetchLike} from "../../../packages/model-gateway/src/index.js";
import {
  EnvironmentCredentialBackend,
  SecretBackendBroker,
  createPlatformCredentialBackend,
  parseSecretReference,
  type CredentialBackend,
} from "../../../packages/secret-broker/src/index.js";
import {
  OpenAiVoiceAssistant,
  VOICE_ASSISTANT_NAME,
  type OpenAiVoiceAssistantOptions,
  type PcmRecorderFactory,
  type VoiceAssistant,
  type VoicePlaybackResult,
  type VoiceRecordingSession,
  type WavAudioPlayer,
} from "../../../packages/voice-input/src/index.js";

export interface ConfiguredVoiceAssistantOptions {
  readonly platformPaths?: PlatformPaths;
  readonly credentialBackend?: CredentialBackend;
  readonly offline?: boolean;
  readonly fetch?: FetchLike;
  readonly recorderFactory?: PcmRecorderFactory;
  readonly player?: WavAudioPlayer;
}

/**
 * Resolves the current OpenAI credential only when voice is explicitly used.
 * This keeps microphone and speech support dormant during ordinary CLI work.
 */
export class ConfiguredVoiceAssistant implements VoiceAssistant {
  public readonly name = VOICE_ASSISTANT_NAME;
  readonly #credentialBackend: CredentialBackend;
  readonly #fetch: FetchLike | undefined;
  readonly #offline: boolean;
  readonly #platformPaths: PlatformPaths;
  readonly #player: WavAudioPlayer | undefined;
  readonly #recorderFactory: PcmRecorderFactory | undefined;

  public constructor(options: ConfiguredVoiceAssistantOptions = {}) {
    this.#platformPaths = options.platformPaths ?? resolvePlatformPaths();
    this.#credentialBackend = options.credentialBackend ?? createPlatformCredentialBackend();
    this.#offline = options.offline === true;
    this.#fetch = options.fetch;
    this.#recorderFactory = options.recorderFactory;
    this.#player = options.player;
  }

  public async start(signal: AbortSignal): Promise<VoiceRecordingSession> {
    return await (await this.#resolve()).start(signal);
  }

  public async speak(text: string, signal: AbortSignal): Promise<VoicePlaybackResult> {
    return await (await this.#resolve()).speak(text, signal);
  }

  async #resolve(): Promise<OpenAiVoiceAssistant> {
    if (this.#offline) {
      throw new Error("Nova voice is unavailable in --offline mode because transcription and speech use OpenAI. Relaunch without --offline to use /voice.");
    }
    const provider = (await loadUserProviderConfig(this.#platformPaths)).providers.openai;
    if (!provider?.enabled) {
      throw new Error("Nova voice needs an OpenAI connection. Type /setup or /api connect openai, then try /voice again.");
    }
    const backends = this.#credentialBackend.scheme === "env"
      ? [this.#credentialBackend]
      : [new EnvironmentCredentialBackend(process.env, false), this.#credentialBackend];
    const options: OpenAiVoiceAssistantOptions = {
      secretBroker: new SecretBackendBroker(backends),
      credential: parseSecretReference(provider.credential),
      ...(this.#fetch === undefined ? {} : {fetch: this.#fetch}),
      ...(this.#recorderFactory === undefined ? {} : {recorderFactory: this.#recorderFactory}),
      ...(this.#player === undefined ? {} : {player: this.#player}),
    };
    return new OpenAiVoiceAssistant(options);
  }
}
