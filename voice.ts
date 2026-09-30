// The chat mic's on-device transcription: The Orchestrator registers the AI
// service `local` (model `apple`), and the host answers "ai.voice.transcribe"
// with Apple's own speech recognition instead of a cloud service. Pure policy
// here; host.ts does the I/O:
//
//   base64 audio → temp file → ffmpeg → 16 kHz mono WAV → Swift helper → text
//
// The helper is compiled once per source hash with /usr/bin/swiftc. It stays
// on-device: SpeechAnalyzer + SpeechTranscriber on macOS 26 (installing the
// locale's model through AssetInventory when missing), otherwise
// SFSpeechRecognizer with requiresOnDeviceRecognition. Its Info.plist is linked
// into the binary so TCC has a usage description to show.
import type { AiServiceErrorCode, AiVoiceTranscribeInput, AiVoiceTranscribeOutput } from "./contract";

/** The `<serviceId>/<model>` the owner selects: `local/apple`. */
export const VOICE_SERVICE_ID = "local";
export const VOICE_MODEL = "apple";
export const VOICE_DISPLAY_NAME = "On-device (Apple Speech)";
/** bb stops waiting for a transcript after 10 seconds. */
export const VOICE_TIMEOUT_MS = 10_000;

/** Decoded audio larger than this is refused (OpenAI's own cap, ~25 min of opus). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** A transcript longer than this is cut; a chat message has no use for more. */
export const MAX_TRANSCRIPT_CHARS = 100_000;

export type VoiceFailure = Extract<AiVoiceTranscribeOutput, { ok: false }>;

const failure = (code: AiServiceErrorCode, message: string): VoiceFailure => ({
  ok: false,
  code,
  message,
});

/** Decoded size of a base64 string, without decoding it. */
export function base64ByteLength(base64: string): number {
  const body = base64.replace(/\s+/g, "");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/** Why a request cannot be served at all; null when it can. */
export function voiceRequestProblem(
  input: Pick<AiVoiceTranscribeInput, "serviceId" | "model" | "audioBase64">,
): VoiceFailure | null {
  if (input.serviceId !== VOICE_SERVICE_ID) {
    return failure("request_failed", `The Orchestrator serves only "${VOICE_SERVICE_ID}", not "${input.serviceId}".`);
  }
  if (input.model !== VOICE_MODEL) {
    return failure(
      "request_failed",
      `"${VOICE_SERVICE_ID}/${input.model}" is not a model. Use ${VOICE_SERVICE_ID}/${VOICE_MODEL}.`,
    );
  }
  const bytes = base64ByteLength(input.audioBase64);
  if (bytes === 0) return failure("request_failed", "The recording is empty.");
  if (bytes > MAX_AUDIO_BYTES) {
    return failure(
      "request_failed",
      `The recording is ${Math.ceil(bytes / 1024 / 1024)} MB; on-device transcription takes at most ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
    );
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/x-caf": "caf",
};
const KNOWN_EXTENSIONS = new Set([...Object.values(EXTENSIONS), "oga", "aif", "mpga"]);

/**
 * The temp file's extension: from the MIME type (parameters such as
 * `;codecs=opus` ignored), else the filename's, else `bin` (ffmpeg probes the
 * content anyway). Never anything outside the known list, so a filename
 * cannot put a path or odd characters into the temp file's name.
 */
export function audioExtension(mimeType: string, filename: string): string {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  const fromMime = EXTENSIONS[mime];
  if (fromMime !== undefined) return fromMime;
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  const fromName = match?.[1]?.toLowerCase();
  return fromName !== undefined && KNOWN_EXTENSIONS.has(fromName) ? fromName : "bin";
}

/** Where ffmpeg is looked for, in order: Homebrew (Apple silicon, Intel), then PATH. */
export function ffmpegCandidates(pathEnv: string | undefined): string[] {
  const fromPath = (pathEnv ?? "")
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => `${dir.replace(/\/+$/, "")}/ffmpeg`);
  return [...new Set(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", ...fromPath])];
}

/** Any input ffmpeg can read → 16 kHz mono 16-bit PCM WAV, audio only. */
export function ffmpegArgs(input: string, output: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    output,
  ];
}

/** How a child process ended, as host.ts saw it. */
export type StepResult =
  | { kind: "ok"; stdout: string }
  /** The request's timeoutMs ran out, or core cancelled it. */
  | { kind: "timeout" }
  /** The executable was not there (ENOENT). */
  | { kind: "missing" }
  | { kind: "exit"; code: number | null; stderr: string };

const firstLines = (text: string) => text.trim().split("\n").slice(0, 3).join(" ").slice(0, 400);

export const FFMPEG_MISSING =
  "ffmpeg is not installed, and on-device transcription needs it to decode the recording. Run: brew install ffmpeg";

/** A failed ffmpeg step as the contract's error; null when it worked. */
export function ffmpegFailure(step: StepResult, timeoutMs: number, mimeType: string): VoiceFailure | null {
  switch (step.kind) {
    case "ok":
      return null;
    case "timeout":
      return timeoutFailure(timeoutMs);
    case "missing":
      return failure("service_unavailable", FFMPEG_MISSING);
    case "exit":
      return failure(
        "request_failed",
        `ffmpeg could not decode the recording (${mimeType || "no MIME type"}): ${firstLines(step.stderr) || `exit ${step.code}`}`,
      );
  }
}

export const timeoutFailure = (timeoutMs: number): VoiceFailure =>
  failure("timeout", `On-device transcription took longer than ${Math.round(timeoutMs / 1000)} s.`);

/** The helper's exit codes (HELPER_SOURCE's `fail` calls). */
export const HELPER_EXIT = { usage: 2, notAuthorized: 3, unavailable: 4, failed: 5 } as const;

export const SPEECH_PERMISSION =
  "Speech recognition is not allowed for The Orchestrator's transcriber. Turn it on in System Settings → Privacy & Security → Speech Recognition, then try the mic again.";

/**
 * The helper's result as the contract's output. An empty transcript (silence,
 * or nothing recognisable) is ok with empty text, not invalid_response: the
 * recording was heard and held no words, and a retry would hear the same.
 */
export function helperOutcome(step: StepResult, timeoutMs: number): AiVoiceTranscribeOutput {
  switch (step.kind) {
    case "ok":
      return { ok: true, model: VOICE_MODEL, text: transcriptFrom(step.stdout) };
    case "timeout":
      return timeoutFailure(timeoutMs);
    case "missing":
      return failure("service_unavailable", "The on-device transcriber is missing from its cache; try the mic again to rebuild it.");
    case "exit": {
      const detail = firstLines(step.stderr);
      if (step.code === HELPER_EXIT.notAuthorized) {
        return failure("service_unavailable", detail ? `${SPEECH_PERMISSION} (${detail})` : SPEECH_PERMISSION);
      }
      if (step.code === HELPER_EXIT.unavailable) {
        return failure(
          "service_unavailable",
          `Apple's on-device speech is not available: ${detail || "no model for this language"}. The first use downloads the speech model, so check the network and try again; or add English under System Settings → Keyboard → Dictation.`,
        );
      }
      return failure(
        "request_failed",
        `Apple Speech could not transcribe the recording: ${detail || `exit ${step.code ?? "by signal"}`}`,
      );
    }
  }
}

/** Compiling the helper failed: swiftc missing or broken is the Mac's to fix. */
export function compileFailure(detail: string): VoiceFailure {
  return failure(
    "service_unavailable",
    `Could not build the on-device transcriber with /usr/bin/swiftc: ${firstLines(detail) || "unknown error"}. Run: xcode-select --install`,
  );
}

/** stdout → one line of text, trimmed and capped. */
export function transcriptFrom(stdout: string): string {
  const text = stdout.replace(/\s+/g, " ").trim();
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text;
}

/** Milliseconds left before `deadline`, never negative. */
export const remainingMs = (deadline: number, now: number) => Math.max(0, deadline - now);

// ------------------------------------------------------------------ the helper

export const HELPER_NAME = "orchestrator-transcribe";
export const HELPER_BUNDLE_ID = "com.theorchestrator.transcribe";

/** Linked into the binary's __TEXT,__info_plist so TCC can name and describe it. */
export const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>The Orchestrator Transcriber</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>The Orchestrator transcribes what you say into the chat mic on this Mac.</string>
</dict>
</plist>
`;

/**
 * The CLI: `orchestrator-transcribe <file.wav> [locale]` prints the transcript
 * on stdout. Locale: the given one, else the Mac's if a model supports it,
 * else en-US. Exit codes match HELPER_EXIT; the reason goes to stderr.
 */
export const HELPER_SOURCE = String.raw`import AVFoundation
import Foundation
import Speech

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail(2, "usage: orchestrator-transcribe <file.wav> [locale]") }
let audioURL = URL(fileURLWithPath: arguments[1])
let wanted = arguments.count >= 3 ? Locale(identifier: arguments[2]) : Locale.current
let fallback = Locale(identifier: "en-US")

@available(macOS 26.0, *)
func analyzerTranscript() async throws -> String {
  guard SpeechTranscriber.isAvailable else { fail(4, "SpeechTranscriber is not available on this Mac") }
  var locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted)
  if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: fallback) }
  guard let locale else { fail(4, "no on-device speech model for \(wanted.identifier) or en-US") }
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
  } catch {
    fail(4, "could not install the \(locale.identifier) speech model: \(error.localizedDescription)")
  }
  let file: AVAudioFile
  do { file = try AVAudioFile(forReading: audioURL) } catch {
    fail(5, "could not read \(audioURL.path): \(error.localizedDescription)")
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  async let segments: [String] = transcriber.results.reduce(into: []) { parts, result in
    if result.isFinal { parts.append(String(result.text.characters)) }
  }
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await segments
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

func recognizerTranscript() async throws -> String {
  let status = await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
  }
  guard status == .authorized else { fail(3, "authorization status \(status.rawValue)") }
  guard let recognizer = SFSpeechRecognizer(locale: wanted) ?? SFSpeechRecognizer(locale: fallback),
        recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
    fail(4, "no on-device recognizer for \(wanted.identifier) or en-US")
  }
  let request = SFSpeechURLRecognitionRequest(url: audioURL)
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  return try await withCheckedThrowingContinuation { continuation in
    var finished = false
    _ = recognizer.recognitionTask(with: request) { result, error in
      if finished { return }
      if let error {
        finished = true
        continuation.resume(throwing: error)
      } else if let result, result.isFinal {
        finished = true
        continuation.resume(returning: result.bestTranscription.formattedString)
      }
    }
  }
}

Task {
  do {
    let text: String
    if #available(macOS 26.0, *) {
      text = try await analyzerTranscript()
    } else {
      text = try await recognizerTranscript()
    }
    print(text.trimmingCharacters(in: .whitespacesAndNewlines))
    exit(0)
  } catch {
    fail(5, error.localizedDescription)
  }
}
dispatchMain()
`;

/** swiftc: optimised, a private module cache, the Info.plist linked in. */
export function swiftcArgs(source: string, output: string, plist: string, moduleCache: string): string[] {
  return [
    "-O",
    "-module-cache-path",
    moduleCache,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    plist,
    "-o",
    output,
    source,
  ];
}

/** Ad hoc signature carrying the bundle id, so TCC sees one stable identity. */
export function codesignArgs(binary: string): string[] {
  return ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, binary];
}
