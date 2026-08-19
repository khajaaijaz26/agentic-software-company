import {describe, expect, it, vi} from "vitest";

import type {FetchLike} from "../../packages/model-gateway/src/index.js";
import type {CredentialBackend, SecretBroker, SecretLease, SecretReference} from "../../packages/secret-broker/src/index.js";
import {ConfiguredVoiceAssistant} from "../../apps/cli/src/voice-assistant.js";
import {
  OpenAiVoiceAssistant,
  pcm16FramesToWav,
  type PcmRecorder,
  type PcmRecorderFactory,
  type WavAudioPlayer,
} from "../../packages/voice-input/src/index.js";

class ControlledRecorder implements PcmRecorder {
  public isRecording = false;
  public readonly sampleRate = 8_000;
  public releaseCount = 0;
  public readonly firstFrame: Int16Array;
  readonly #waiting: Promise<void>;
  #readCount = 0;
  #resolveWaiting!: () => void;
  #resolveRead: ((value: Int16Array) => void) | null = null;

  public constructor(sampleCount = 2_048) {
    this.firstFrame = new Int16Array(sampleCount).fill(320);
    this.#waiting = new Promise((resolve) => { this.#resolveWaiting = resolve; });
  }

  public start(): void {
    this.isRecording = true;
  }

  public stop(): void {
    this.isRecording = false;
    this.#resolveRead?.(new Int16Array());
    this.#resolveRead = null;
  }

  public async read(): Promise<Int16Array> {
    this.#readCount += 1;
    if (this.#readCount === 1) return this.firstFrame;
    this.#resolveWaiting();
    return await new Promise((resolve) => { this.#resolveRead = resolve; });
  }

  public getSelectedDevice(): string {
    return "Test microphone";
  }

  public release(): void {
    this.releaseCount += 1;
  }

  public async waitUntilCapturing(): Promise<void> {
    await this.#waiting;
  }
}

class RecorderFactory implements PcmRecorderFactory {
  public constructor(public readonly recorder: ControlledRecorder) {}
  public create(): Promise<PcmRecorder> {
    return Promise.resolve(this.recorder);
  }
}

function secretBroker(lease: SecretLease): SecretBroker {
  return {
    resolve: vi.fn(() => Promise.resolve(lease)),
    list: vi.fn(() => Promise.resolve([])),
  };
}

describe("Nova voice input", () => {
  it("encodes bounded mono PCM as a standard 16-bit WAV", () => {
    const wav = Buffer.from(pcm16FramesToWav([new Int16Array([1, -2]), new Int16Array([3])], 16_000));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([1, -2, 3]);
  });

  it("records in memory, transcribes through the saved OpenAI credential, and erases the lease", async () => {
    const recorder = new ControlledRecorder();
    const lease: SecretLease = {
      reference: {scheme: "env", reference: "OPENAI_API_KEY"},
      value: "sk-voice-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let now = 1_000;
    const fetch: FetchLike = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-voice-test");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(Buffer.from(await (file as Blob).arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
      return new Response(JSON.stringify({
        text: "Ask the agents what they are working on.",
        usage: {input_tokens: 12, output_tokens: 7, total_tokens: 19},
      }), {status: 200, headers: {"content-type": "application/json"}});
    });
    const assistant = new OpenAiVoiceAssistant({
      secretBroker: secretBroker(lease),
      credential: lease.reference,
      recorderFactory: new RecorderFactory(recorder),
      player: {play: vi.fn()},
      fetch,
      maxRecordingMs: 1_000,
      now: () => now,
    });

    const session = await assistant.start(new AbortController().signal);
    expect(session.deviceName).toBe("Test microphone");
    await recorder.waitUntilCapturing();
    now = 1_700;
    const transcript = await session.stopAndTranscribe(new AbortController().signal);

    expect(transcript).toMatchObject({
      text: "Ask the agents what they are working on.",
      durationMs: 700,
      providerId: "openai",
      modelId: "gpt-4o-mini-transcribe",
      usage: {inputTokens: 12, outputTokens: 7, totalTokens: 19},
    });
    expect(recorder.releaseCount).toBe(1);
    expect(lease.value).toBe("");
  });

  it("creates an AI-generated Nova WAV reply and delegates playback without persisting audio", async () => {
    const credential: SecretReference = {scheme: "env", reference: "OPENAI_API_KEY"};
    const lease: SecretLease = {reference: credential, value: "sk-speech-test", expiresAt: new Date(Date.now() + 60_000).toISOString()};
    const played: Uint8Array[] = [];
    const player: WavAudioPlayer = {play: vi.fn((wav: Uint8Array) => { played.push(wav.slice()); return Promise.resolve(); })};
    const fetch: FetchLike = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/audio/speech");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-speech-test");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({model: "gpt-4o-mini-tts", voice: "nova", response_format: "wav"});
      expect(body.input).toBe("Master Orchestrator says: I am reviewing the plan.");
      return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3]), {status: 200, headers: {"content-type": "audio/wav"}});
    });
    const assistant = new OpenAiVoiceAssistant({
      secretBroker: secretBroker(lease),
      credential,
      recorderFactory: new RecorderFactory(new ControlledRecorder()),
      player,
      fetch,
    });

    await expect(assistant.speak("Master Orchestrator says: I am reviewing the plan.", new AbortController().signal)).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini-tts",
      voice: "nova",
    });
    expect(played).toHaveLength(1);
    expect([...played[0] ?? []]).toEqual([82, 73, 70, 70, 1, 2, 3]);
    expect(lease.value).toBe("");
  });

  it("erases captured microphone samples when transcription is rejected before upload", async () => {
    const recorder = new ControlledRecorder(1_000);
    const lease: SecretLease = {
      reference: {scheme: "env", reference: "OPENAI_API_KEY"},
      value: "sk-unused",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const assistant = new OpenAiVoiceAssistant({
      secretBroker: secretBroker(lease),
      credential: lease.reference,
      recorderFactory: new RecorderFactory(recorder),
      player: {play: vi.fn()},
      fetch: vi.fn(),
      maxRecordingMs: 1_000,
    });

    const session = await assistant.start(new AbortController().signal);
    await recorder.waitUntilCapturing();
    await expect(session.stopAndTranscribe(new AbortController().signal)).rejects.toThrow("recording was too short");

    expect(recorder.firstFrame.every((sample) => sample === 0)).toBe(true);
    expect(recorder.releaseCount).toBe(1);
    expect(lease.value).toBe("sk-unused");
  });

  it("fails closed before credential or microphone access in offline mode", async () => {
    const get = vi.fn(() => Promise.resolve("must-not-be-read"));
    const backend: CredentialBackend = {scheme: "env", get, list: () => Promise.resolve([])};
    const assistant = new ConfiguredVoiceAssistant({credentialBackend: backend, offline: true});

    await expect(assistant.start(new AbortController().signal)).rejects.toThrow("unavailable in --offline mode");
    expect(get).not.toHaveBeenCalled();
  });
});
