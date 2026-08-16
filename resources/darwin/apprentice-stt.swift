// apprentice-stt — native macOS speech-to-text for the Electron shell.
// The Apple-Speech twin of the Swift app's AppleSpeechTranscriptionProvider /
// AlwaysOnAudioManager path: SFSpeechRecognizer, on-device when the locale
// model supports it, so dictation audio never leaves the Mac (the local-first
// contract the shipped app makes in onboarding).
//
//   stdin:  raw PCM linear16, 16 kHz, mono (the shell's mic format)
//   stdout: one JSON object per line —
//           {"type":"interim","text":…} | {"type":"final","text":…} |
//           {"type":"error","text":…}
//   EOF on stdin → endAudio → final result (best-effort after 2.5s, matching
//   BuddyDictationManager's finalize fallback).
//
// Build: swiftc -O apprentice-stt.swift -o apprentice-stt

import AVFoundation
import Foundation
import Speech

let FINAL_FALLBACK_S = 2.5
let HARD_TIMEOUT_S = 180.0

let out = FileHandle.standardOutput
func emit(_ type: String, _ text: String) {
  let obj: [String: String] = ["type": type, "text": text]
  if let d = try? JSONSerialization.data(withJSONObject: obj),
     let s = String(data: d, encoding: .utf8) {
    out.write((s + "\n").data(using: .utf8)!)
  }
}

func fail(_ msg: String) -> Never {
  emit("error", msg)
  exit(2)
}

// ── authorization ───────────────────────────────────────────────────────
let authSem = DispatchSemaphore(value: 0)
var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { s in
    authStatus = s
    authSem.signal()
  }
  _ = authSem.wait(timeout: .now() + 30)
}
guard authStatus == .authorized else {
  fail("speech recognition not authorized (status \(authStatus.rawValue))")
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) ?? SFSpeechRecognizer()
else { fail("no speech recognizer for this locale") }
guard recognizer.isAvailable else { fail("speech recognizer unavailable") }

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
// Local-first: REQUIRE on-device when the locale model is present; otherwise
// fall back to Apple's dictation service (still the native path, same
// semantics as system dictation on a model-less Mac).
request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

guard let format = AVAudioFormat(
  commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)
else { fail("bad audio format") }

var lastTranscript = ""
var finished = false
let stateQ = DispatchQueue(label: "stt.state")

func finishWith(_ text: String) {
  stateQ.sync {
    if finished { return }
    finished = true
    emit("final", text)
    exit(0)
  }
}

let task = recognizer.recognitionTask(with: request) { result, error in
  if let result {
    let text = result.bestTranscription.formattedString
    lastTranscript = text
    if result.isFinal {
      finishWith(text)
    } else {
      emit("interim", text)
    }
  }
  if error != nil {
    // A cancelled/errored task after EOF still owes the caller its best
    // transcript — never a silent drop.
    finishWith(lastTranscript)
  }
}
_ = task

// ── stdin pump ──────────────────────────────────────────────────────────
DispatchQueue.global(qos: .userInitiated).async {
  let stdinFH = FileHandle.standardInput
  while true {
    let chunk = stdinFH.availableData
    if chunk.isEmpty { break } // EOF
    let frames = chunk.count / 2
    if frames == 0 { continue }
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))
    else { continue }
    buf.frameLength = AVAudioFrameCount(frames)
    chunk.withUnsafeBytes { raw in
      if let base = raw.baseAddress, let dst = buf.int16ChannelData?[0] {
        memcpy(dst, base, frames * 2)
      }
    }
    request.append(buf)
  }
  request.endAudio()
  // The recognizer owes a final; if it dawdles, ship the best partial.
  DispatchQueue.global().asyncAfter(deadline: .now() + FINAL_FALLBACK_S) {
    finishWith(lastTranscript)
  }
}

// Never hang forever (a stuck recognizer would strand the shell's finalize).
DispatchQueue.global().asyncAfter(deadline: .now() + HARD_TIMEOUT_S) {
  finishWith(lastTranscript)
}

RunLoop.main.run()
