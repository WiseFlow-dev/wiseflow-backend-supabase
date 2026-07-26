export const GEMINI_FLASH_MODEL = "gemini-2.5-flash";
export const GEMINI_FLASH_LITE_MODEL = "gemini-2.5-flash-lite";

const TEMPORARY_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

export type GeminiApiKey = {
  slot: string;
  value: string;
};

export type GeminiRetryLogEvent = {
  event:
    | "attempt_started"
    | "attempt_failed"
    | "attempt_succeeded"
    | "delay_started"
    | "retry_exhausted";
  operation: string;
  attempt: number;
  model: string;
  keySlot: string | null;
  reason: string;
  status: number | null;
  delayMs: number | null;
};

type GeminiRequestWithResilienceOptions = {
  operation: string;
  hasOutputStarted?: () => boolean;
  log?: (event: GeminiRetryLogEvent) => void;
  sleep?: (delayMs: number) => Promise<void>;
};

export type GeminiRequestWithResilienceResult =
  | {
    outcome: "response";
    response: Response;
    modelUsed: string;
    keySlot: string;
    attempts: number;
  }
  | {
    outcome: "exhausted";
    reason: "temporary_unavailable" | "keys_exhausted" | "output_started";
    attempts: number;
    lastStatus: number | null;
  };

type FailureKind = "temporary" | "key_specific" | "terminal";

type ModelAttemptResult =
  | {
    outcome: "response";
    response: Response;
    modelUsed: string;
    keySlot: string;
  }
  | {
    outcome: "temporary";
    status: number | null;
  }
  | {
    outcome: "keys_exhausted";
    status: number | null;
  }
  | {
    outcome: "output_started";
    status: null;
  };

export function loadGeminiApiKeys(
  entries: Array<{ slot: string; value: string | null | undefined }>,
): GeminiApiKey[] {
  const seen = new Set<string>();
  const keys: GeminiApiKey[] = [];

  for (const entry of entries) {
    const value = String(entry.value || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    keys.push({ slot: entry.slot, value });
  }

  return keys;
}

export function isTemporaryGeminiStatus(status: number): boolean {
  return TEMPORARY_GEMINI_STATUSES.has(status);
}

export function isGeminiNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

export async function classifyGeminiResponse(
  response: Response,
): Promise<FailureKind> {
  if (isTemporaryGeminiStatus(response.status)) return "temporary";
  return "terminal";
}

function alternateModel(model: string): string {
  return model === GEMINI_FLASH_LITE_MODEL
    ? GEMINI_FLASH_MODEL
    : GEMINI_FLASH_LITE_MODEL;
}

function failureReason(
  kind: FailureKind | "network_error",
  status: number | null,
): string {
  if (kind === "network_error") return "network_error";
  return status == null ? kind : `${kind}_http_${status}`;
}

export async function requestGeminiWithResilience(
  preferredModel: string,
  keys: GeminiApiKey[],
  request: (model: string, key: GeminiApiKey) => Promise<Response>,
  options: GeminiRequestWithResilienceOptions,
): Promise<GeminiRequestWithResilienceResult> {
  const outputStarted = () => options.hasOutputStarted?.() === true;
  const sleep = options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const disabledKeySlots = new Set<string>();
  let attempts = 0;
  let lastStatus: number | null = null;

  const log = (
    event: GeminiRetryLogEvent["event"],
    model: string,
    keySlot: string | null,
    reason: string,
    status: number | null = null,
    delayMs: number | null = null,
  ) => {
    options.log?.({
      event,
      operation: options.operation,
      attempt: attempts,
      model,
      keySlot,
      reason,
      status,
      delayMs,
    });
  };

  const attemptModel = async (
    model: string,
    oneKeyOnly = false,
  ): Promise<ModelAttemptResult> => {
    const healthyKeys = keys.filter((key) => !disabledKeySlots.has(key.slot));
    if (healthyKeys.length === 0) {
      return { outcome: "keys_exhausted", status: lastStatus };
    }

    for (const key of oneKeyOnly ? healthyKeys.slice(0, 1) : healthyKeys) {
      if (outputStarted()) {
        return { outcome: "output_started", status: null };
      }

      attempts++;
      log("attempt_started", model, key.slot, "request");

      let response: Response;
      try {
        response = await request(model, key);
      } catch (error) {
        if (!isGeminiNetworkError(error)) throw error;
        log("attempt_failed", model, key.slot, "network_error");
        return { outcome: "temporary", status: null };
      }

      lastStatus = response.status;
      if (response.ok) {
        log("attempt_succeeded", model, key.slot, "ok", response.status);
        return {
          outcome: "response",
          response,
          modelUsed: model,
          keySlot: key.slot,
        };
      }

      const failureKind = await classifyGeminiResponse(response);
      log(
        "attempt_failed",
        model,
        key.slot,
        failureReason(failureKind, response.status),
        response.status,
      );

      if (failureKind === "key_specific") {
        disabledKeySlots.add(key.slot);
        if (oneKeyOnly) {
          return { outcome: "keys_exhausted", status: response.status };
        }
        continue;
      }

      if (failureKind === "temporary") {
        return { outcome: "temporary", status: response.status };
      }

      return {
        outcome: "response",
        response,
        modelUsed: model,
        keySlot: key.slot,
      };
    }

    return { outcome: "keys_exhausted", status: lastStatus };
  };

  if (keys.length === 0) {
    log("retry_exhausted", preferredModel, null, "keys_exhausted");
    return {
      outcome: "exhausted",
      reason: "keys_exhausted",
      attempts,
      lastStatus,
    };
  }

  const preferredAttempt = await attemptModel(preferredModel);
  if (preferredAttempt.outcome === "response") {
    return { ...preferredAttempt, attempts };
  }
  if (preferredAttempt.outcome === "output_started") {
    return {
      outcome: "exhausted",
      reason: "output_started",
      attempts,
      lastStatus,
    };
  }
  if (disabledKeySlots.size >= keys.length) {
    log("retry_exhausted", preferredModel, null, "keys_exhausted", lastStatus);
    return {
      outcome: "exhausted",
      reason: "keys_exhausted",
      attempts,
      lastStatus,
    };
  }

  log("delay_started", preferredModel, null, "model_switch", lastStatus, 1000);
  await sleep(1000);
  if (outputStarted()) {
    return {
      outcome: "exhausted",
      reason: "output_started",
      attempts,
      lastStatus,
    };
  }

  const fallbackModel = alternateModel(preferredModel);
  const fallbackAttempt = await attemptModel(fallbackModel);
  if (fallbackAttempt.outcome === "response") {
    return { ...fallbackAttempt, attempts };
  }
  if (fallbackAttempt.outcome === "output_started") {
    return {
      outcome: "exhausted",
      reason: "output_started",
      attempts,
      lastStatus,
    };
  }
  if (disabledKeySlots.size >= keys.length) {
    log("retry_exhausted", fallbackModel, null, "keys_exhausted", lastStatus);
    return {
      outcome: "exhausted",
      reason: "keys_exhausted",
      attempts,
      lastStatus,
    };
  }

  log("delay_started", fallbackModel, null, "final_retry", lastStatus, 3000);
  await sleep(3000);
  if (outputStarted()) {
    return {
      outcome: "exhausted",
      reason: "output_started",
      attempts,
      lastStatus,
    };
  }

  const finalAttempt = await attemptModel(preferredModel, true);
  if (finalAttempt.outcome === "response" && finalAttempt.response.ok) {
    return { ...finalAttempt, attempts };
  }
  if (
    finalAttempt.outcome === "response" &&
    !isTemporaryGeminiStatus(finalAttempt.response.status)
  ) {
    return { ...finalAttempt, attempts };
  }

  log(
    "retry_exhausted",
    preferredModel,
    null,
    "temporary_unavailable",
    lastStatus,
  );
  return {
    outcome: "exhausted",
    reason: "temporary_unavailable",
    attempts,
    lastStatus,
  };
}

const BUSY_MESSAGES: Record<string, string> = {
  en: "Wisey is temporarily busy. Please try again in a moment.",
  fr: "Wisey est temporairement occupé. Réessayez dans un instant.",
  es: "Wisey está ocupado temporalmente. Inténtalo de nuevo en un momento.",
  de:
    "Wisey ist vorübergehend beschäftigt. Bitte versuche es gleich noch einmal.",
  ru: "Wisey временно занят. Повторите попытку через мгновение.",
  tr: "Wisey şu anda meşgul. Lütfen birazdan tekrar deneyin.",
  cs: "Wisey je dočasně zaneprázdněný. Zkuste to prosím za chvíli znovu.",
  el: "Το Wisey είναι προσωρινά απασχολημένο. Δοκιμάστε ξανά σε λίγο.",
  sv: "Wisey är tillfälligt upptagen. Försök igen om en stund.",
  fi: "Wisey on tilapäisesti varattu. Yritä hetken kuluttua uudelleen.",
  hu: "A Wisey átmenetileg elfoglalt. Próbáld újra egy pillanat múlva.",
  uk: "Wisey тимчасово зайнятий. Спробуйте ще раз за мить.",
  da: "Wisey er midlertidigt optaget. Prøv igen om et øjeblik.",
  id: "Wisey sedang sibuk untuk sementara. Coba lagi sebentar lagi.",
  it: "Wisey è temporaneamente occupato. Riprova tra un momento.",
  nl: "Wisey is tijdelijk bezet. Probeer het over een moment opnieuw.",
  pl: "Wisey jest chwilowo zajęty. Spróbuj ponownie za moment.",
  pt: "O Wisey está temporariamente ocupado. Tente novamente em instantes.",
  ro: "Wisey este ocupat temporar. Încearcă din nou peste puțin timp.",
  zh: "Wisey 暂时繁忙，请稍后再试。",
  ja: "Wiseyは一時的に混み合っています。少し待ってからもう一度お試しください。",
};

const INTERRUPTED_MESSAGES: Record<string, string> = {
  en: "Wisey lost the connection. Please try again.",
  fr: "Wisey a perdu la connexion. Veuillez réessayer.",
  es: "Wisey perdió la conexión. Inténtalo de nuevo.",
  de: "Wisey hat die Verbindung verloren. Bitte versuche es erneut.",
  ru: "Wisey потерял соединение. Повторите попытку.",
  tr: "Wisey bağlantıyı kaybetti. Lütfen tekrar deneyin.",
  cs: "Wisey ztratil připojení. Zkuste to prosím znovu.",
  el: "Το Wisey έχασε τη σύνδεση. Δοκιμάστε ξανά.",
  sv: "Wisey tappade anslutningen. Försök igen.",
  fi: "Wisey menetti yhteyden. Yritä uudelleen.",
  hu: "A Wisey elvesztette a kapcsolatot. Próbáld újra.",
  uk: "Wisey втратив з’єднання. Спробуйте ще раз.",
  da: "Wisey mistede forbindelsen. Prøv igen.",
  id: "Koneksi Wisey terputus. Coba lagi.",
  it: "Wisey ha perso la connessione. Riprova.",
  nl: "Wisey verloor de verbinding. Probeer het opnieuw.",
  pl: "Wisey utracił połączenie. Spróbuj ponownie.",
  pt: "O Wisey perdeu a ligação. Tente novamente.",
  ro: "Wisey a pierdut conexiunea. Încearcă din nou.",
  zh: "Wisey 连接中断，请重试。",
  ja: "Wiseyの接続が切れました。もう一度お試しください。",
};

export function getWiseyBusyMessage(languageCode: string): string {
  return BUSY_MESSAGES[languageCode] || BUSY_MESSAGES.en;
}

export function getWiseyInterruptedMessage(languageCode: string): string {
  return INTERRUPTED_MESSAGES[languageCode] || INTERRUPTED_MESSAGES.en;
}

export function shouldPersistWiseyResponse(
  availabilityFallback: boolean | undefined,
): boolean {
  return availabilityFallback !== true;
}
