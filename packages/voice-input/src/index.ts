import {spawn} from "node:child_process";
import {mkdtemp, rmdir, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {
  openProviderResponse,
  providerHttpLimits,
  readBoundedJson,
} from "../../model-gateway/src/http.js";
import type {FetchLike} from "../../model-gateway/src/types.js";
import {sanitizeTerminal} from "../../observability/src/index.js";
import type {SecretBroker, SecretReference} from "../../secret-broker/src/index.js";

export const VOICE_ASSISTANT_NAME = "Nova";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
export const MAX_VOICE_RECORDING_MS = 120_000;
export const VOICE_TEST_TONE_DURATION_MS = 700;

const FRAME_LENGTH = 512;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_SPEECH_BYTES = 16 * 1024 * 1024;
const MAX_SPOKEN_CHARACTERS = 4_096;

export interface VoiceUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly seconds?: number;
}

export interface VoiceTranscript {
  readonly text: string;
  readonly durationMs: number;
  readonly providerId: "openai";
  readonly modelId: string;
  readonly usage: VoiceUsage;
}

export interface VoicePlaybackResult {
  readonly providerId: "openai";
  readonly modelId: string;
  readonly voice: string;
}

export interface VoiceRecordingSession {
  readonly deviceName: string;
  readonly sampleRate: number;
  readonly startedAt: number;
  readonly maxDurationMs: number;
  stopAndTranscribe(signal: AbortSignal): Promise<VoiceTranscript>;
  cancel(): Promise<void>;
}

export interface VoiceAssistant {
  readonly name: string;
  start(signal: AbortSignal): Promise<VoiceRecordingSession>;
  speak(text: string, signal: AbortSignal): Promise<VoicePlaybackResult>;
}

export interface PcmRecorder {
  readonly isRecording: boolean;
  readonly sampleRate: number;
  start(): void;
  stop(): void;
  read(): Promise<Int16Array>;
  getSelectedDevice(): string;
  release(): void;
}

export interface PcmRecorderFactory {
  create(frameLength: number, deviceIndex: number, bufferedFramesCount: number): Promise<PcmRecorder>;
}

export interface WavAudioPlayer {
  play(wav: Uint8Array, signal: AbortSignal): Promise<void>;
}

export interface OpenAiVoiceAssistantOptions {
  readonly secretBroker: SecretBroker;
  readonly credential: SecretReference;
  readonly fetch?: FetchLike;
  readonly recorderFactory?: PcmRecorderFactory;
  readonly player?: WavAudioPlayer;
  readonly deviceIndex?: number;
  readonly transcriptionModel?: string;
  readonly speechModel?: string;
  readonly speechVoice?: string;
  readonly maxRecordingMs?: number;
  readonly now?: () => number;
}

export class VoiceCapabilityError extends Error {
  public constructor(
    public readonly code: "VOICE_CANCELED" | "VOICE_MICROPHONE_UNAVAILABLE" | "VOICE_PLAYBACK_UNAVAILABLE" | "VOICE_PROTOCOL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "VoiceCapabilityError";
  }
}

export class OpenAiVoiceAssistant implements VoiceAssistant {
  public readonly name = VOICE_ASSISTANT_NAME;
  readonly #credential: SecretReference;
  readonly #deviceIndex: number;
  readonly #fetch: FetchLike;
  readonly #maxRecordingMs: number;
  readonly #now: () => number;
  readonly #player: WavAudioPlayer;
  readonly #recorderFactory: PcmRecorderFactory;
  readonly #secretBroker: SecretBroker;
  readonly #speechModel: string;
  readonly #speechVoice: string;
  readonly #transcriptionModel: string;

  public constructor(options: OpenAiVoiceAssistantOptions) {
    this.#secretBroker = options.secretBroker;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#recorderFactory = options.recorderFactory ?? new PvRecorderFactory();
    this.#player = options.player ?? new SystemWavAudioPlayer();
    this.#deviceIndex = boundedInteger(options.deviceIndex ?? -1, -1, 1_024, "voice device index");
    this.#maxRecordingMs = boundedInteger(options.maxRecordingMs ?? MAX_VOICE_RECORDING_MS, 1_000, MAX_VOICE_RECORDING_MS, "voice recording limit");
    this.#transcriptionModel = cleanIdentifier(options.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL, "transcription model");
    this.#speechModel = cleanIdentifier(options.speechModel ?? DEFAULT_SPEECH_MODEL, "speech model");
    this.#speechVoice = cleanIdentifier(options.speechVoice ?? "nova", "speech voice");
    this.#now = options.now ?? Date.now;
  }

  public async start(signal: AbortSignal): Promise<VoiceRecordingSession> {
    assertNotCanceled(signal);
    let recorder: PcmRecorder;
    try {
      recorder = await this.#recorderFactory.create(FRAME_LENGTH, this.#deviceIndex, 100);
    } catch (error) {
      if (signal.aborted) throw canceled();
      throw new VoiceCapabilityError(
        "VOICE_MICROPHONE_UNAVAILABLE",
        `Nova could not open the microphone: ${boundedErrorMessage(error)}`,
      );
    }
    try {
      assertNotCanceled(signal);
      recorder.start();
    } catch (error) {
      recorder.release();
      if (signal.aborted) throw canceled();
      throw new VoiceCapabilityError(
        "VOICE_MICROPHONE_UNAVAILABLE",
        `Nova could not open the microphone: ${boundedErrorMessage(error)}`,
      );
    }
    const startedAt = this.#now();
    try {
      return new BufferedVoiceRecording({
        recorder,
        startedAt,
        maxDurationMs: this.#maxRecordingMs,
        now: this.#now,
        transcribe: async (wav, durationMs, transcriptionSignal) => await this.#transcribe(wav, durationMs, transcriptionSignal),
      });
    } catch (error) {
      try {
        if (recorder.isRecording) recorder.stop();
      } finally {
        recorder.release();
      }
      throw error;
    }
  }

  public async speak(text: string, signal: AbortSignal): Promise<VoicePlaybackResult> {
    assertNotCanceled(signal);
    const input = cleanSpeechText(text);
    if (input === "") throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "Nova cannot speak an empty reply");
    const lease = await this.#secretBroker.resolve(this.#credential, "Software Agent Nova speech", 120);
    try {
      const body = JSON.stringify({
        model: this.#speechModel,
        input,
        voice: this.#speechVoice,
        instructions: "Speak clearly, warmly, and concisely as Nova, the Software Agent voice assistant.",
        response_format: "wav",
      });
      const handle = await openProviderResponse({
        providerId: "openai",
        url: new URL("https://api.openai.com/v1/audio/speech"),
        fetch: this.#fetch,
        init: {
          method: "POST",
          headers: {authorization: `Bearer ${lease.value}`, "content-type": "application/json"},
          body,
        },
        signal,
        limits: providerHttpLimits({timeoutMs: 90_000, maxRequestBytes: 64 * 1024, maxResponseBytes: MAX_SPEECH_BYTES}),
      });
      try {
        const wav = await readBoundedBytes(handle.response, MAX_SPEECH_BYTES, handle.signal);
        try {
          await this.#player.play(wav, signal);
        } finally {
          wav.fill(0);
        }
      } finally {
        handle.close();
      }
      return {providerId: "openai", modelId: this.#speechModel, voice: this.#speechVoice};
    } finally {
      lease.value = "";
    }
  }

  async #transcribe(wav: Uint8Array, durationMs: number, signal: AbortSignal): Promise<VoiceTranscript> {
    assertNotCanceled(signal);
    if (wav.byteLength > MAX_SPEECH_BYTES) {
      throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "The recording exceeded Nova's upload size limit");
    }
    const lease = await this.#secretBroker.resolve(this.#credential, "Software Agent Nova transcription", 120);
    try {
      const form = new FormData();
      form.set("file", new Blob([wav], {type: "audio/wav"}), "software-agent-voice.wav");
      form.set("model", this.#transcriptionModel);
      form.set("response_format", "json");
      const handle = await openProviderResponse({
        providerId: "openai",
        url: new URL("https://api.openai.com/v1/audio/transcriptions"),
        fetch: this.#fetch,
        init: {method: "POST", headers: {authorization: `Bearer ${lease.value}`}, body: form},
        signal,
        limits: providerHttpLimits({
          timeoutMs: 90_000,
          maxRequestBytes: MAX_SPEECH_BYTES,
          maxResponseBytes: MAX_TRANSCRIPT_BYTES,
        }),
      });
      try {
        const payload = await readBoundedJson("openai", handle.response, MAX_TRANSCRIPT_BYTES);
        const text = typeof payload.text === "string" ? sanitizeTerminal(payload.text.trim(), 8_192) : "";
        if (text === "") throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "OpenAI returned an empty voice transcript");
        return {
          text,
          durationMs,
          providerId: "openai",
          modelId: this.#transcriptionModel,
          usage: parseVoiceUsage(payload.usage),
        };
      } finally {
        handle.close();
      }
    } finally {
      lease.value = "";
    }
  }
}

class BufferedVoiceRecording implements VoiceRecordingSession {
  public readonly deviceName: string;
  public readonly maxDurationMs: number;
  public readonly sampleRate: number;
  public readonly startedAt: number;
  readonly #frames: Int16Array[] = [];
  readonly #maxSamples: number;
  readonly #now: () => number;
  readonly #recorder: PcmRecorder;
  readonly #transcribe: (wav: Uint8Array, durationMs: number, signal: AbortSignal) => Promise<VoiceTranscript>;
  readonly #capture: Promise<void>;
  #capturing = true;
  #released = false;
  #sampleCount = 0;
  #terminalError: unknown;

  public constructor(options: {
    readonly recorder: PcmRecorder;
    readonly startedAt: number;
    readonly maxDurationMs: number;
    readonly now: () => number;
    readonly transcribe: (wav: Uint8Array, durationMs: number, signal: AbortSignal) => Promise<VoiceTranscript>;
  }) {
    this.#recorder = options.recorder;
    this.startedAt = options.startedAt;
    this.maxDurationMs = options.maxDurationMs;
    this.#now = options.now;
    this.#transcribe = options.transcribe;
    this.sampleRate = boundedInteger(this.#recorder.sampleRate, 8_000, 192_000, "microphone sample rate");
    this.deviceName = sanitizeTerminal(this.#recorder.getSelectedDevice() || "Default microphone", 160);
    this.#maxSamples = Math.floor(this.sampleRate * this.maxDurationMs / 1_000);
    this.#capture = this.#captureFrames();
  }

  public async stopAndTranscribe(signal: AbortSignal): Promise<VoiceTranscript> {
    await this.#finishCapture();
    let wav: Uint8Array | undefined;
    try {
      assertNotCanceled(signal);
      if (this.#terminalError !== undefined) {
        throw new VoiceCapabilityError("VOICE_MICROPHONE_UNAVAILABLE", `Microphone recording failed: ${boundedErrorMessage(this.#terminalError)}`);
      }
      if (this.#sampleCount < Math.min(this.sampleRate / 4, this.#maxSamples)) {
        throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "The recording was too short. Try /voice again and speak before pressing Enter.");
      }
      wav = pcm16FramesToWav(this.#frames, this.sampleRate, this.#sampleCount);
      const durationMs = Math.min(this.maxDurationMs, Math.max(0, this.#now() - this.startedAt));
      return await this.#transcribe(wav, durationMs, signal);
    } finally {
      wav?.fill(0);
      this.#eraseFrames();
    }
  }

  public async cancel(): Promise<void> {
    await this.#finishCapture();
    this.#eraseFrames();
  }

  async #captureFrames(): Promise<void> {
    try {
      while (this.#capturing && this.#sampleCount < this.#maxSamples) {
        const frame = await this.#recorder.read();
        const remaining = this.#maxSamples - this.#sampleCount;
        const accepted = frame.length <= remaining ? frame : frame.slice(0, remaining);
        if (accepted !== frame) frame.fill(0);
        this.#frames.push(accepted);
        this.#sampleCount += accepted.length;
        if (this.#sampleCount >= this.#maxSamples) this.#stopRecorder();
      }
    } catch (error) {
      if (this.#capturing) this.#terminalError = error;
    } finally {
      this.#capturing = false;
    }
  }

  async #finishCapture(): Promise<void> {
    this.#stopRecorder();
    await this.#capture;
    if (!this.#released) {
      this.#released = true;
      try {
        this.#recorder.release();
      } catch (error) {
        this.#terminalError ??= error;
      }
    }
  }

  #stopRecorder(): void {
    this.#capturing = false;
    if (!this.#recorder.isRecording) return;
    try {
      this.#recorder.stop();
    } catch (error) {
      this.#terminalError ??= error;
    }
  }

  #eraseFrames(): void {
    for (const frame of this.#frames) frame.fill(0);
    this.#frames.length = 0;
    this.#sampleCount = 0;
  }
}

export class PvRecorderFactory implements PcmRecorderFactory {
  public async create(frameLength: number, deviceIndex: number, bufferedFramesCount: number): Promise<PcmRecorder> {
    const {PvRecorder} = await import("@picovoice/pvrecorder-node");
    const devices = PvRecorder.getAvailableDevices();
    if (devices.length === 0) {
      throw new VoiceCapabilityError(
        "VOICE_MICROPHONE_UNAVAILABLE",
        microphoneRecoveryMessage(),
      );
    }
    return new PvRecorder(frameLength, deviceIndex, bufferedFramesCount);
  }
}

/** Lists input endpoints without opening or recording from the microphone. */
export async function listVoiceInputDevices(): Promise<readonly string[]> {
  const {PvRecorder} = await import("@picovoice/pvrecorder-node");
  return PvRecorder.getAvailableDevices().map((device) => sanitizeTerminal(device, 160));
}

/** Generates a short local-only tone used to verify the operating-system speaker path. */
export function createVoiceTestTone(
  durationMs = VOICE_TEST_TONE_DURATION_MS,
  sampleRate = 16_000,
  frequencyHz = 523.25,
): Uint8Array {
  boundedInteger(durationMs, 100, 2_000, "voice test tone duration");
  boundedInteger(sampleRate, 8_000, 48_000, "voice test tone sample rate");
  if (!Number.isFinite(frequencyHz) || frequencyHz < 100 || frequencyHz > 2_000) {
    throw new Error("voice test tone frequency must be from 100 to 2000 Hz");
  }
  const samples = new Int16Array(Math.floor(sampleRate * durationMs / 1_000));
  for (let index = 0; index < samples.length; index += 1) {
    const envelope = Math.min(1, index / 240, (samples.length - index) / 240);
    samples[index] = Math.round(Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) * 14_000 * envelope);
  }
  try {
    return pcm16FramesToWav([samples], sampleRate);
  } finally {
    samples.fill(0);
  }
}

export class SystemWavAudioPlayer implements WavAudioPlayer {
  public async play(wav: Uint8Array, signal: AbortSignal): Promise<void> {
    assertNotCanceled(signal);
    const directory = await mkdtemp(join(tmpdir(), "software-agent-voice-"));
    const file = join(directory, "nova.wav");
    try {
      await writeFile(file, wav, {mode: 0o600});
      if (process.platform === "win32") {
        await runAudioCommand("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$player = [System.Media.SoundPlayer]::new($args[0]); try { $player.PlaySync() } finally { $player.Dispose() }",
          file,
        ], signal);
        return;
      }
      if (process.platform === "darwin") {
        await runAudioCommand("afplay", [file], signal);
        return;
      }
      const errors: string[] = [];
      for (const candidate of ["aplay", "paplay", "ffplay"] as const) {
        const args = candidate === "ffplay" ? ["-nodisp", "-autoexit", "-loglevel", "quiet", file] : [file];
        try {
          await runAudioCommand(candidate, args, signal);
          return;
        } catch (error) {
          errors.push(`${candidate}: ${boundedErrorMessage(error)}`);
        }
      }
      throw new VoiceCapabilityError("VOICE_PLAYBACK_UNAVAILABLE", `No supported audio player was available (${errors.join("; ")})`);
    } finally {
      await unlink(file).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }
}

export function pcm16FramesToWav(frames: readonly Int16Array[], sampleRate: number, sampleCount?: number): Uint8Array {
  const count = sampleCount ?? frames.reduce((total, frame) => total + frame.length, 0);
  boundedInteger(sampleRate, 8_000, 192_000, "WAV sample rate");
  boundedInteger(count, 0, sampleRate * MAX_VOICE_RECORDING_MS / 1_000, "WAV sample count");
  const dataBytes = count * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  let remaining = count;
  for (const frame of frames) {
    const accepted = Math.min(frame.length, remaining);
    for (let index = 0; index < accepted; index += 1) {
      output.writeInt16LE(frame[index] ?? 0, offset);
      offset += 2;
    }
    remaining -= accepted;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "recorded sample count did not match the captured frames");
  return output;
}

async function readBoundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "OpenAI returned an empty speech response");
  const reader: ReadableStreamDefaultReader<Uint8Array> = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let complete = false;
    while (!complete) {
      assertNotCanceled(signal);
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        continue;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "OpenAI speech response exceeded its size limit");
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new VoiceCapabilityError("VOICE_PROTOCOL_ERROR", "OpenAI returned an empty speech response");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return result;
}

function runAudioCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(canceled());
      return;
    }
    const child = spawn(command, [...args], {stdio: "ignore", windowsHide: true, shell: false});
    const cancel = () => { child.kill(); };
    signal.addEventListener("abort", cancel, {once: true});
    child.once("error", (error) => {
      signal.removeEventListener("abort", cancel);
      reject(signal.aborted ? canceled() : new VoiceCapabilityError("VOICE_PLAYBACK_UNAVAILABLE", `Could not start ${command}: ${boundedErrorMessage(error)}`));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(canceled());
      else if (code === 0) resolve();
      else reject(new VoiceCapabilityError("VOICE_PLAYBACK_UNAVAILABLE", `${command} exited with code ${String(code)}`));
    });
  });
}

function parseVoiceUsage(value: unknown): VoiceUsage {
  if (!isRecord(value)) return {};
  const inputTokens = optionalNonNegativeInteger(value.input_tokens);
  const outputTokens = optionalNonNegativeInteger(value.output_tokens);
  const totalTokens = optionalNonNegativeInteger(value.total_tokens);
  const seconds = typeof value.seconds === "number" && Number.isFinite(value.seconds) && value.seconds >= 0 ? value.seconds : undefined;
  return {
    ...(inputTokens === undefined ? {} : {inputTokens}),
    ...(outputTokens === undefined ? {} : {outputTokens}),
    ...(totalTokens === undefined ? {} : {totalTokens}),
    ...(seconds === undefined ? {} : {seconds}),
  };
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanIdentifier(value: string, label: string): string {
  const clean = value.trim();
  if (clean === "" || clean.length > 256 || !/^[A-Za-z0-9._-]+$/u.test(clean)) throw new Error(`${label} is invalid`);
  return clean;
}

function cleanSpeechText(value: string): string {
  return sanitizeTerminal(value.trim(), MAX_SPOKEN_CHARACTERS).replace(/\s+/gu, " ").trim();
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw canceled();
}

function canceled(): VoiceCapabilityError {
  return new VoiceCapabilityError("VOICE_CANCELED", "Nova voice input was canceled");
}

function boundedErrorMessage(error: unknown): string {
  return sanitizeTerminal(error instanceof Error ? error.message : String(error), 240);
}

function microphoneRecoveryMessage(): string {
  if (process.platform === "win32") {
    return "No Windows microphone input is visible. Connect or enable a microphone, then open Settings > Privacy & security > Microphone and allow desktop apps. Run 'software-agent voice doctor' to check again.";
  }
  if (process.platform === "darwin") {
    return "No microphone input is visible. Connect or enable a microphone, allow your terminal under System Settings > Privacy & Security > Microphone, then run 'software-agent voice doctor'.";
  }
  return "No microphone input is visible. Connect or enable an input device, check its recording permission, then run 'software-agent voice doctor'.";
}
