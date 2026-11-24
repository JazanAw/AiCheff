import * as fs from 'node:fs';

export type BackendLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface BackendDebugLogEntry {
  id: number;
  level: BackendLogLevel;
  message: string;
  timestamp: string;
  context?: unknown;
}

const maxEntries = 1000;
let sequence = 0;
const entries: BackendDebugLogEntry[] = [];

const levelOrder: Record<BackendLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeConsoleLevel(raw: string | undefined): BackendLogLevel {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'warn';
}

const minConsoleLevel: BackendLogLevel = normalizeConsoleLevel(
  process.env.BACKEND_CONSOLE_LOG_LEVEL,
);

function shouldWriteToConsole(level: BackendLogLevel): boolean {
  return levelOrder[level] >= levelOrder[minConsoleLevel];
}

function stringifyContext(context: unknown): string {
  if (context === undefined) {
    return '';
  }

  if (typeof context === 'string') {
    return context;
  }

  try {
    return JSON.stringify(context);
  } catch {
    return String(context);
  }
}

function writeToConsole(entry: BackendDebugLogEntry): void {
  if (!shouldWriteToConsole(entry.level)) {
    return;
  }

  const line =
    `[AIChef Backend][${entry.timestamp}][${entry.level}] ${entry.message}` +
    (entry.context === undefined ? '' : ` ${stringifyContext(entry.context)}`);

  if (entry.level === 'error') {
    console.error(line);
    return;
  }
  if (entry.level === 'warn') {
    console.warn(line);
    return;
  }
  if (entry.level === 'info') {
    console.info(line);
    return;
  }
  console.debug(line);
}

// Optionaler, DIREKTER Datei-Sink. Gesetzt via BACKEND_LOG_FILE. Hintergrund:
// console.* landet nur über stdout/stderr in einer Datei, wenn der Launcher
// umleitet — und genau diese Umleitung (Start-Process -RedirectStandardOutput)
// war die Ursache der Konsolen-Vererbung, an der der Server beim Konsolen-Close
// starb. Der neue Launcher startet ENTKOPPELT (ohne Shell-Redirect); damit die
// vollständigen Logs trotzdem persistent bleiben, schreibt der Server sie hier
// SELBST synchron in eine Datei. Fehler werden geschluckt (Logging darf nie killen).
const backendLogFile: string | undefined =
  (process.env.BACKEND_LOG_FILE ?? '').trim() || undefined;

function writeToFile(entry: BackendDebugLogEntry): void {
  if (!backendLogFile) {
    return;
  }
  const line =
    `[${entry.timestamp}][${entry.level}] ${entry.message}` +
    (entry.context === undefined ? '' : ` ${stringifyContext(entry.context)}`) +
    '\n';
  try {
    fs.appendFileSync(backendLogFile, line);
  } catch {
    // Ein fehlschlagender Log-Write darf den Prozess nie beenden.
  }
}

export function appendBackendDebugLog(
  level: BackendLogLevel,
  message: string,
  context?: unknown,
): BackendDebugLogEntry {
  const entry: BackendDebugLogEntry = {
    id: ++sequence,
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  };

  entries.push(entry);
  if (entries.length > maxEntries) {
    entries.splice(0, entries.length - maxEntries);
  }
  writeToConsole(entry);
  writeToFile(entry);

  return entry;
}

export function readBackendDebugLogs(limit = 200): BackendDebugLogEntry[] {
  const cappedLimit = Math.max(1, Math.min(limit, maxEntries));
  return entries.slice(-cappedLimit);
}

export function clearBackendDebugLogs(): void {
  entries.splice(0, entries.length);
}
