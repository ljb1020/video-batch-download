const APP_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/u;
const APP_CODE_PREFIXES = [
  "AUDIO_",
  "AUTH_",
  "CONTENT_",
  "FILESYSTEM_",
  "FFMPEG_",
  "INVALID_",
  "MEDIA_",
  "OPERATION_",
  "OUTPUT_",
  "PLATFORM_",
  "RATE_",
  "TARGET_",
  "TRANSCRIPTION_",
  "UNEXPECTED_",
  "UNSUPPORTED_",
  "VERIFICATION_",
];
const DETAIL_STRING_LIMIT = 1_500;

export const FFMPEG_UNAVAILABLE_USER_MESSAGE = "ffmpeg 不可用，请安装 ffmpeg，或通过 --ffmpeg-path 指定可执行文件路径。";
export const FFMPEG_UNAVAILABLE_SUGGESTION = "运行 node scripts/setup.mjs 或确认 ffmpeg/ffprobe 已加入 PATH。";

function truncateText(value, limit = DETAIL_STRING_LIMIT) {
  if (value == null) return value;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function ffmpegUnavailableError(message, options = {}) {
  return new ProcessingError(message, {
    code: "FFMPEG_UNAVAILABLE",
    category: "environment",
    retryable: false,
    userMessage: FFMPEG_UNAVAILABLE_USER_MESSAGE,
    suggestion: FFMPEG_UNAVAILABLE_SUGGESTION,
    ...options,
  });
}

function isAppCode(value) {
  const code = String(value ?? "");
  return APP_CODE_PATTERN.test(code)
    && !code.startsWith("ERR_")
    && APP_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function pickRetryable(permanent, retryable) {
  if (permanent) return false;
  return retryable ?? true;
}

export function operationInterruptedError(message = "Interrupted", options = {}) {
  return new ProcessingError(message, {
    code: "OPERATION_INTERRUPTED",
    category: "control",
    stage: "control",
    retryable: true,
    retryScope: "item",
    userMessage: "任务已中断，当前条目停止处理。",
    ...options,
  });
}

export class ProcessingError extends Error {
  constructor(message, {
    code = "UNEXPECTED_ERROR",
    category = "internal",
    stage = null,
    permanent = false,
    retryable,
    retryScope = null,
    userMessage = null,
    suggestion = null,
    details = null,
    candidateFailures = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProcessingError";
    this.code = code;
    this.category = category;
    this.stage = stage;
    this.permanent = Boolean(permanent);
    this.retryable = pickRetryable(this.permanent, retryable);
    this.retryScope = this.retryable ? (retryScope ?? "item") : "none";
    this.userMessage = userMessage;
    this.suggestion = suggestion;
    this.details = details;
    this.candidateFailures = candidateFailures;
  }
}

function isFfmpegSpawnError(error) {
  const text = `${error?.syscall ?? ""} ${error?.message ?? ""}`;
  return /ffmpeg|ffprobe/i.test(text) && error?.code === "ENOENT";
}

function mapSystemError(error, stage) {
  if (isFfmpegSpawnError(error)) {
    return {
      code: "FFMPEG_UNAVAILABLE",
      category: "environment",
      retryable: false,
      userMessage: FFMPEG_UNAVAILABLE_USER_MESSAGE,
      suggestion: FFMPEG_UNAVAILABLE_SUGGESTION,
    };
  }

  if (error?.code === "ENOSPC") {
    return {
      code: "FILESYSTEM_NO_SPACE",
      category: "output",
      retryable: false,
      userMessage: "磁盘空间不足，无法继续写入下载结果。",
      suggestion: "清理输出目录或切换到剩余空间更大的磁盘后重试。",
    };
  }

  if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
    return {
      code: "FILESYSTEM_PERMISSION_DENIED",
      category: "output",
      retryable: false,
      userMessage: "没有权限写入输出文件或访问本地媒体工具。",
      suggestion: "检查输出目录权限，或换一个可写目录。",
    };
  }

  if (["EBUSY", "EMFILE"].includes(error?.code)) {
    return {
      code: "FILESYSTEM_BUSY",
      category: "output",
      retryable: true,
      retryScope: "operation",
      userMessage: "文件暂时被占用，稍后可重试。",
    };
  }

  if (["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code)) {
    return {
      code: "MEDIA_NETWORK_ERROR",
      category: "network",
      retryable: true,
      retryScope: stage === "download" ? "candidate" : "item",
      userMessage: "网络连接临时失败，稍后会重试。",
    };
  }

  return null;
}

function appErrorOptions(error, fallbackStage) {
  const permanent = Boolean(error.permanent);
  return {
    code: isAppCode(error.code) ? error.code : "UNEXPECTED_ERROR",
    category: error.category ?? (permanent ? "content" : "internal"),
    stage: error.stage ?? fallbackStage,
    permanent,
    retryable: error.retryable,
    retryScope: error.retryScope,
    userMessage: error.userMessage ?? null,
    suggestion: error.suggestion ?? null,
    details: error.details ?? null,
    candidateFailures: error.candidateFailures ?? null,
    cause: error,
  };
}

export function normalizeError(error, {
  stage = null,
  code = null,
  category = null,
  retryable = null,
  retryScope = null,
  permanent = null,
  userMessage = null,
  suggestion = null,
} = {}) {
  if (error instanceof ProcessingError) {
    if (stage && !error.stage) error.stage = stage;
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const systemMapping = mapSystemError(error, stage);
  if (systemMapping) {
    return new ProcessingError(message, {
      ...systemMapping,
      stage,
      details: { systemCode: error?.code ?? null },
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (/ffmpeg is required but could not be run/i.test(message)) {
    return ffmpegUnavailableError(message, {
      stage,
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (error && typeof error === "object" && isAppCode(error.code)) {
    return new ProcessingError(message, {
      ...appErrorOptions(error, stage),
      ...(category ? { category } : {}),
      ...(code ? { code } : {}),
      ...(permanent != null ? { permanent } : {}),
      ...(retryable != null ? { retryable } : {}),
      ...(retryScope ? { retryScope } : {}),
      ...(userMessage ? { userMessage } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }

  const legacyPermanent = Boolean(error && typeof error === "object" && error.permanent);
  const nodeInternalError = Boolean(error && typeof error === "object" && String(error.code ?? "").startsWith("ERR_"));
  const transientStage = ["parse", "download"].includes(stage) && !nodeInternalError;
  const inferredRetryable = retryable ?? (!legacyPermanent && transientStage);
  return new ProcessingError(message, {
    code: code ?? (legacyPermanent ? "CONTENT_UNAVAILABLE" : "UNEXPECTED_ERROR"),
    category: category ?? (legacyPermanent ? "content" : transientStage ? "platform" : "internal"),
    stage,
    permanent: permanent != null ? permanent : legacyPermanent,
    retryable: inferredRetryable,
    retryScope: retryScope ?? (inferredRetryable ? "item" : "none"),
    userMessage,
    suggestion,
    cause: error instanceof Error ? error : undefined,
  });
}

export function normalizeTranscriptionError(error, { phase = "runtime", isStopping = false } = {}) {
  if (isStopping) {
    return operationInterruptedError(error?.message ?? "Interrupted", {
      details: { originalError: error?.message ?? String(error ?? "Unknown error") },
    });
  }
  if (error instanceof ProcessingError) {
    if (!error.stage) error.stage = phase === "audio_extract" ? "audio_extract" : "transcribe";
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const lower = message.toLowerCase();
  if (phase === "audio_extract") {
    return new ProcessingError(message, {
      code: /no audio|does not contain any stream|audio track/i.test(message)
        ? "MEDIA_AUDIO_TRACK_MISSING"
        : "AUDIO_EXTRACTION_FAILED",
      category: "media",
      stage: "audio_extract",
      retryable: false,
      userMessage: "音频提取失败，无法继续转写；视频和元数据已保留。",
      suggestion: "如果该视频没有音轨，可使用 --no-transcribe；否则请检查 ffmpeg 是否能正常读取该文件。",
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (/timeout/i.test(message)) {
    return new ProcessingError(message, {
      code: "TRANSCRIPTION_TIMEOUT",
      category: "transcription",
      stage: "transcribe",
      retryable: true,
      retryScope: "item",
      userMessage: "本地转写超时，视频和元数据已保留。",
      suggestion: "可以降低模型大小，例如 --model small，或增大 --transcribe-timeout。",
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (/cannot find python|python executable|transcribe_server spawn|enoent/.test(lower)) {
    return new ProcessingError(message, {
      code: "TRANSCRIPTION_SERVER_START_FAILED",
      category: "environment",
      stage: "transcribe",
      retryable: false,
      userMessage: "本地转写服务启动失败，视频和元数据已保留。",
      suggestion: "请确认 Python 环境和转写依赖已安装，或先使用 --no-transcribe 只下载视频。",
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (/model|no such file|not found/.test(lower)) {
    return new ProcessingError(message, {
      code: "TRANSCRIPTION_MODEL_UNAVAILABLE",
      category: "environment",
      stage: "transcribe",
      retryable: false,
      userMessage: "转写模型不可用，视频和元数据已保留。",
      suggestion: "请检查模型名称、模型文件缓存或网络环境。",
      cause: error instanceof Error ? error : undefined,
    });
  }

  return new ProcessingError(message, {
    code: "TRANSCRIPTION_RUNTIME_FAILED",
    category: "transcription",
    stage: "transcribe",
    retryable: false,
    userMessage: "本地转写运行失败，视频和元数据已保留。",
    suggestion: "可以尝试 --device cpu、降低模型大小，或查看错误详情定位本地运行环境问题。",
    cause: error instanceof Error ? error : undefined,
  });
}

function serializeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details ?? null;
  const output = {};
  for (const [key, value] of Object.entries(details)) {
    if (/url|token|signature|sign|auth/i.test(key)) continue;
    output[key] = typeof value === "string" ? truncateText(value) : value;
  }
  return output;
}

export function sanitizeCandidateFailure(failure) {
  const output = {
    alternativeIndex: failure.alternativeIndex,
    code: failure.code ?? "UNEXPECTED_ERROR",
    category: failure.category ?? "internal",
    stage: failure.stage ?? null,
    retryable: Boolean(failure.retryable),
    permanent: Boolean(failure.permanent),
    retryScope: failure.retryScope ?? null,
    message: truncateText(failure.message ?? failure.error ?? "Unknown error", 500),
  };
  if (failure.userMessage) output.userMessage = failure.userMessage;
  if (failure.suggestion) output.suggestion = failure.suggestion;
  if (failure.details) output.details = serializeDetails(failure.details);
  return output;
}

export function serializeErrorInfo(error) {
  const normalized = normalizeError(error);
  const output = {
    message: normalized.message,
    code: normalized.code,
    category: normalized.category,
    stage: normalized.stage,
    permanent: Boolean(normalized.permanent),
    retryable: Boolean(normalized.retryable),
    retryScope: normalized.retryScope,
  };
  if (normalized.userMessage) output.userMessage = normalized.userMessage;
  if (normalized.suggestion) output.suggestion = normalized.suggestion;
  if (normalized.details) output.details = serializeDetails(normalized.details);
  if (Array.isArray(normalized.candidateFailures)) {
    output.candidateFailures = normalized.candidateFailures.map(sanitizeCandidateFailure);
  }
  return output;
}

export function buildErrorStatePatch(error) {
  const info = serializeErrorInfo(error);
  return {
    lastError: info.message,
    lastErrorCode: info.code,
    lastErrorCategory: info.category,
    lastErrorStage: info.stage,
    lastUserMessage: info.userMessage ?? null,
    lastSuggestion: info.suggestion ?? null,
    retryable: info.retryable,
    permanent: info.permanent,
    candidateFailures: info.candidateFailures ?? null,
  };
}

export function clearErrorStatePatch() {
  return {
    lastError: null,
    lastErrorCode: null,
    lastErrorCategory: null,
    lastErrorStage: null,
    lastUserMessage: null,
    lastSuggestion: null,
    retryable: null,
    permanent: null,
    candidateFailures: null,
  };
}

export function buildFailureOutputMetadata(error, { attempts = null, errorType = null } = {}) {
  const info = serializeErrorInfo(error);
  return {
    error_type: errorType,
    error_code: info.code,
    error_category: info.category,
    error_stage: info.stage,
    retryable: info.retryable,
    permanent: info.permanent,
    attempts,
    user_message: info.userMessage ?? null,
    technical_error: info.userMessage && info.userMessage !== info.message ? info.message : null,
    suggestion: info.suggestion ?? null,
    content_type: info.details?.contentType ?? null,
    candidate_failures: info.candidateFailures ?? null,
    details: info.details ?? null,
  };
}
