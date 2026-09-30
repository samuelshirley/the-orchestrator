import { describe, expect, it } from "vitest";
import {
  FFMPEG_MISSING,
  HELPER_EXIT,
  HELPER_INFO_PLIST,
  HELPER_SOURCE,
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
  SPEECH_PERMISSION,
  VOICE_MODEL,
  VOICE_SERVICE_ID,
  audioExtension,
  base64ByteLength,
  codesignArgs,
  compileFailure,
  ffmpegArgs,
  ffmpegCandidates,
  ffmpegFailure,
  helperOutcome,
  remainingMs,
  swiftcArgs,
  timeoutFailure,
  transcriptFrom,
  voiceRequestProblem,
} from "./voice";
import { aiServicesHostContract } from "./contract";

const outputSchema = aiServicesHostContract["ai.voice.transcribe"].output;

const request = (audioBase64 = Buffer.from("opus bytes").toString("base64")) => ({
  serviceId: VOICE_SERVICE_ID,
  model: VOICE_MODEL,
  audioBase64,
  mimeType: "audio/webm;codecs=opus",
  filename: "recording.webm",
  prompt: null,
  timeoutMs: 30_000,
});

describe("the service", () => {
  it("is local/apple: a lowercase id", () => {
    expect(`${VOICE_SERVICE_ID}/${VOICE_MODEL}`).toBe("local/apple");
    expect(VOICE_SERVICE_ID).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("base64ByteLength", () => {
  it("matches the decoded length, padding or not", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1000, 1001, 1002]) {
      const encoded = Buffer.alloc(size, 7).toString("base64");
      expect(base64ByteLength(encoded)).toBe(size);
    }
  });

  it("ignores line breaks in the encoding", () => {
    expect(base64ByteLength("AAAA\nAAAA\n")).toBe(6);
  });
});

describe("voiceRequestProblem", () => {
  it("lets a local/apple recording through", () => {
    expect(voiceRequestProblem(request())).toBeNull();
  });

  it("refuses another service id or model", () => {
    expect(voiceRequestProblem({ ...request(), serviceId: "codex" })).toMatchObject({
      ok: false,
      code: "request_failed",
    });
    expect(voiceRequestProblem({ ...request(), model: "gpt-transcribe" })).toMatchObject({
      ok: false,
      code: "request_failed",
      message: expect.stringContaining("local/apple"),
    });
  });

  it("refuses an empty recording", () => {
    expect(voiceRequestProblem(request(""))).toMatchObject({ code: "request_failed", message: /empty/ });
  });

  it("caps the size at MAX_AUDIO_BYTES, inclusive", () => {
    const at = Buffer.alloc(MAX_AUDIO_BYTES).toString("base64");
    expect(base64ByteLength(at)).toBe(MAX_AUDIO_BYTES);
    expect(voiceRequestProblem(request(at))).toBeNull();
    const over = Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64");
    expect(voiceRequestProblem(request(over))).toMatchObject({ code: "request_failed", message: /at most 25 MB/ });
  });
});

describe("audioExtension", () => {
  it("reads the MIME type, ignoring codecs and case", () => {
    expect(audioExtension("audio/webm;codecs=opus", "x")).toBe("webm");
    expect(audioExtension("Audio/MP4", "x")).toBe("m4a");
    expect(audioExtension("audio/ogg; codecs=opus", "x")).toBe("ogg");
    expect(audioExtension("audio/wav", "x")).toBe("wav");
    expect(audioExtension("audio/mpeg", "x")).toBe("mp3");
  });

  it("falls back to a known filename extension", () => {
    expect(audioExtension("application/octet-stream", "voice.M4A")).toBe("m4a");
    expect(audioExtension("", "clip.flac")).toBe("flac");
  });

  it("never takes an unknown or unsafe extension from the filename", () => {
    expect(audioExtension("", "evil.sh")).toBe("bin");
    expect(audioExtension("", "../../x/y.webm/..")).toBe("bin");
    expect(audioExtension("", "noextension")).toBe("bin");
  });
});

describe("ffmpegCandidates", () => {
  it("tries Homebrew first, then PATH, without repeats", () => {
    expect(ffmpegCandidates("/usr/bin:/opt/homebrew/bin/:relative:/bin")).toEqual([
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
      "/bin/ffmpeg",
    ]);
  });

  it("still has Homebrew with no PATH", () => {
    expect(ffmpegCandidates(undefined)).toEqual(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
  });
});

describe("ffmpegArgs", () => {
  it("writes 16 kHz mono PCM WAV from the input, audio only", () => {
    const args = ffmpegArgs("/t/in.webm", "/t/out.wav");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/t/in.webm"]);
    expect(args.join(" ")).toContain("-vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav /t/out.wav");
    expect(args.at(-1)).toBe("/t/out.wav");
    expect(args).toContain("-nostdin");
  });
});

describe("ffmpegFailure", () => {
  it("passes a finished conversion", () => {
    expect(ffmpegFailure({ kind: "ok", stdout: "" }, 30_000, "audio/webm")).toBeNull();
  });

  it("says to install ffmpeg when it is missing", () => {
    expect(ffmpegFailure({ kind: "missing" }, 30_000, "audio/webm")).toEqual({
      ok: false,
      code: "service_unavailable",
      message: FFMPEG_MISSING,
    });
    expect(FFMPEG_MISSING).toContain("brew install ffmpeg");
  });

  it("is a timeout when the deadline passes", () => {
    expect(ffmpegFailure({ kind: "timeout" }, 30_000, "audio/webm")).toMatchObject({
      code: "timeout",
      message: expect.stringContaining("30 s"),
    });
  });

  it("blames the recording when ffmpeg cannot decode it", () => {
    expect(
      ffmpegFailure({ kind: "exit", code: 187, stderr: "Invalid data found\nmore" }, 30_000, "audio/webm"),
    ).toMatchObject({ code: "request_failed", message: expect.stringContaining("audio/webm): Invalid data found") });
  });
});

describe("helperOutcome", () => {
  it("returns the transcript as model apple", () => {
    expect(helperOutcome({ kind: "ok", stdout: "  hello from patches\n" }, 30_000)).toEqual({
      ok: true,
      model: "apple",
      text: "hello from patches",
    });
  });

  it("returns silence as ok with empty text, not invalid_response", () => {
    expect(helperOutcome({ kind: "ok", stdout: "\n" }, 30_000)).toEqual({ ok: true, model: "apple", text: "" });
  });

  it("says where to allow speech recognition when TCC refuses", () => {
    const out = helperOutcome({ kind: "exit", code: HELPER_EXIT.notAuthorized, stderr: "status 1" }, 30_000);
    expect(out).toMatchObject({ ok: false, code: "service_unavailable" });
    expect(!out.ok && out.message).toContain(SPEECH_PERMISSION);
    expect(SPEECH_PERMISSION).toContain("Privacy & Security → Speech Recognition");
  });

  it("says what to check when the model or locale is unavailable", () => {
    const out = helperOutcome({ kind: "exit", code: HELPER_EXIT.unavailable, stderr: "no model for en_ES" }, 30_000);
    expect(out).toMatchObject({ ok: false, code: "service_unavailable" });
    expect(!out.ok && out.message).toMatch(/no model for en_ES.*Dictation/);
  });

  it("maps a recognition failure or crash to request_failed", () => {
    expect(helperOutcome({ kind: "exit", code: HELPER_EXIT.failed, stderr: "bad audio" }, 30_000)).toMatchObject({
      code: "request_failed",
      message: expect.stringContaining("bad audio"),
    });
    expect(helperOutcome({ kind: "exit", code: null, stderr: "" }, 30_000)).toMatchObject({
      code: "request_failed",
      message: expect.stringContaining("by signal"),
    });
  });

  it("maps a timeout and a missing binary", () => {
    expect(helperOutcome({ kind: "timeout" }, 12_000)).toEqual(timeoutFailure(12_000));
    expect(helperOutcome({ kind: "missing" }, 12_000)).toMatchObject({ code: "service_unavailable" });
  });

  it("always satisfies the contract's output schema", () => {
    const steps = [
      { kind: "ok", stdout: "" },
      { kind: "ok", stdout: "words" },
      { kind: "timeout" },
      { kind: "missing" },
      { kind: "exit", code: 3, stderr: "" },
      { kind: "exit", code: 4, stderr: "" },
      { kind: "exit", code: 5, stderr: "" },
      { kind: "exit", code: null, stderr: "" },
    ] as const;
    for (const step of steps) {
      expect(outputSchema.safeParse(helperOutcome(step, 1_000)).success).toBe(true);
    }
    expect(outputSchema.safeParse(compileFailure("")).success).toBe(true);
    expect(
      outputSchema.safeParse(ffmpegFailure({ kind: "exit", code: 1, stderr: "" }, 1, ""))
        .success,
    ).toBe(true);
  });
});

describe("transcriptFrom", () => {
  it("joins lines and caps the length", () => {
    expect(transcriptFrom("one\ntwo  three\n")).toBe("one two three");
    expect(transcriptFrom("a".repeat(MAX_TRANSCRIPT_CHARS + 10))).toHaveLength(MAX_TRANSCRIPT_CHARS);
  });
});

describe("compileFailure", () => {
  it("is service_unavailable and says to install the command line tools", () => {
    expect(compileFailure("error: no such module 'Speech'")).toMatchObject({
      code: "service_unavailable",
      message: expect.stringMatching(/no such module 'Speech'.*xcode-select --install/),
    });
  });
});

describe("remainingMs", () => {
  it("counts down to zero, never below", () => {
    expect(remainingMs(1_000, 400)).toBe(600);
    expect(remainingMs(1_000, 1_000)).toBe(0);
    expect(remainingMs(1_000, 5_000)).toBe(0);
  });
});

describe("the helper", () => {
  it("stays on-device on both paths", () => {
    expect(HELPER_SOURCE).toContain("SpeechAnalyzer(modules: [transcriber])");
    expect(HELPER_SOURCE).toContain("AssetInventory.assetInstallationRequest");
    expect(HELPER_SOURCE).toContain("request.requiresOnDeviceRecognition = true");
    expect(HELPER_SOURCE).toContain('Locale(identifier: "en-US")');
  });

  it("keeps Swift's interpolation intact in the embedded source", () => {
    expect(HELPER_SOURCE).toContain(String.raw`\(wanted.identifier)`);
    expect(HELPER_SOURCE).toContain(String.raw`"\n"`);
  });

  it("exits with the codes helperOutcome maps", () => {
    expect(HELPER_SOURCE).toContain(`fail(${HELPER_EXIT.usage},`);
    expect(HELPER_SOURCE).toContain(`fail(${HELPER_EXIT.notAuthorized},`);
    expect(HELPER_SOURCE).toContain(`fail(${HELPER_EXIT.unavailable},`);
    expect(HELPER_SOURCE).toContain(`fail(${HELPER_EXIT.failed},`);
  });

  it("carries a speech usage description, linked into the binary", () => {
    expect(HELPER_INFO_PLIST).toContain("<key>NSSpeechRecognitionUsageDescription</key>");
    const args = swiftcArgs("/c/main.swift", "/c/out", "/c/Info.plist", "/c/mc");
    expect(args.join(" ")).toContain("-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker /c/Info.plist");
    expect(args.join(" ")).toContain("-module-cache-path /c/mc");
    expect(args.slice(-3)).toEqual(["-o", "/c/out", "/c/main.swift"]);
    expect(codesignArgs("/c/out")).toEqual(["--force", "--sign", "-", "--identifier", "com.theorchestrator.transcribe", "/c/out"]);
  });
});
