import { appConfig } from '../config/env';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  temperature?: number;
}

class OllamaServiceError extends Error {
  public readonly retryable: boolean;

  public constructor(message: string, retryable = false) {
    super(message);
    this.name = 'OllamaServiceError';
    this.retryable = retryable;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cleanHost(host: string): string {
  return host.replace(/\/+$/, '');
}

async function requestOllamaApiChat(
  host: string,
  model: string,
  temperature: number,
  messages: OllamaMessage[],
  signal: AbortSignal,
): Promise<{ content: string | null; notFound: boolean }> {
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature },
      messages,
    }),
    signal,
  });

  if (response.status === 404) {
    return { content: null, notFound: true };
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new OllamaServiceError(
      `Ollama Fehler (${response.status}): ${responseText || 'Unbekannte Antwort'}`,
      response.status >= 500,
    );
  }

  const payload = (await response.json()) as {
    message?: { content?: string };
  };
  return {
    content: payload.message?.content?.trim() ?? null,
    notFound: false,
  };
}

async function requestOllamaOpenAiCompat(
  host: string,
  model: string,
  temperature: number,
  messages: OllamaMessage[],
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`${host}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new OllamaServiceError(
      `Ollama Kompatibilitaets-Fehler (${response.status}): ${
        responseText || 'Unbekannte Antwort'
      }`,
      response.status >= 500,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return payload.choices?.[0]?.message?.content?.trim() ?? null;
}

export async function ollamaChat(
  messages: OllamaMessage[],
  options: OllamaChatOptions = {},
): Promise<string> {
  const host = cleanHost(options.host ?? appConfig.ollamaHost);
  const model = options.model ?? appConfig.ollamaModel;
  const timeoutMs = options.timeoutMs ?? appConfig.ollamaTimeoutMs;
  const retries = options.retries ?? 2;
  const temperature = options.temperature ?? 0.2;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const primary = await requestOllamaApiChat(
        host,
        model,
        temperature,
        messages,
        abortController.signal,
      );

      let content = primary.content;
      if (!content && primary.notFound) {
        content = await requestOllamaOpenAiCompat(
          host,
          model,
          temperature,
          messages,
          abortController.signal,
        );
      }

      if (!content) {
        throw new OllamaServiceError(
          'Ollama hat eine leere Antwort geliefert.',
          false,
        );
      }

      return content;
    } catch (error) {
      const isAbortError =
        error instanceof DOMException && error.name === 'AbortError';
      if (isAbortError) {
        lastError = new OllamaServiceError(
          `Ollama Timeout nach ${timeoutMs}ms (${host})`,
          true,
        );
      } else if (error instanceof OllamaServiceError) {
        lastError = error;
      } else {
        lastError = new OllamaServiceError(
          `Ollama ist nicht erreichbar unter ${host}.`,
          true,
        );
      }

      const shouldRetry =
        attempt < retries &&
        lastError instanceof OllamaServiceError &&
        lastError.retryable;

      if (!shouldRetry) {
        break;
      }

      await wait(300 * (attempt + 1));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new OllamaServiceError('Unbekannter Ollama Fehler.');
}
