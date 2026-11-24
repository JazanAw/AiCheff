import { execFile } from 'node:child_process';
import { ChildProcess, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendBackendDebugLog } from '../debug/debugLogStore';

const execFileAsync = promisify(execFile);

type ManagedProcessName = 'ollama' | 'app' | 'mobile';

interface OllamaPullState {
  running: boolean;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  lastOutput: string | null;
}

interface ProcessConfig {
  commandLine: string;
  cwd: string;
  description: string;
}

interface ProcessState {
  name: ManagedProcessName;
  description: string;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastStoppedAt: string | null;
  lastExitCode: number | null;
  lastSignal: string | null;
  lastError: string | null;
  mobileExpoUrl: string | null;
  mobileQrImageUrl: string | null;
  mobileQrUpdatedAt: string | null;
  recentLogs: string[];
}

const maxLogEntries = 120;

const processMap: Partial<Record<ManagedProcessName, ChildProcess>> =
  {};

const stateMap: Record<ManagedProcessName, ProcessState> = {
  ollama: {
    name: 'ollama',
    description: 'ollama serve',
    running: false,
    pid: null,
    startedAt: null,
    lastStoppedAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null,
    mobileExpoUrl: null,
    mobileQrImageUrl: null,
    mobileQrUpdatedAt: null,
    recentLogs: [],
  },
  app: {
    name: 'app',
    description: 'npm run dev:client',
    running: false,
    pid: null,
    startedAt: null,
    lastStoppedAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null,
    mobileExpoUrl: null,
    mobileQrImageUrl: null,
    mobileQrUpdatedAt: null,
    recentLogs: [],
  },
  mobile: {
    name: 'mobile',
    description: 'npm start -- --go --lan --port 8081 (mobile)',
    running: false,
    pid: null,
    startedAt: null,
    lastStoppedAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null,
    mobileExpoUrl: null,
    mobileQrImageUrl: null,
    mobileQrUpdatedAt: null,
    recentLogs: [],
  },
};

let ollamaPullProcess: ChildProcess | null = null;

const ollamaPullState: OllamaPullState = {
  running: false,
  model: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastOutput: null,
};

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function projectRoot(): string {
  return process.cwd();
}

function processConfig(name: ManagedProcessName): ProcessConfig {
  if (name === 'ollama') {
    return {
      commandLine: 'ollama serve',
      cwd: projectRoot(),
      description: 'ollama serve',
    };
  }

  if (name === 'mobile') {
    const mobileRoot = path.resolve(projectRoot(), 'mobile');
    const lanIp = resolvePrimaryIpv4();
    const hostEnv =
      process.platform === 'win32'
        ? lanIp
          ? `set REACT_NATIVE_PACKAGER_HOSTNAME=${lanIp}&& `
          : ''
        : lanIp
          ? `REACT_NATIVE_PACKAGER_HOSTNAME="${lanIp}" `
          : '';
    const startCommand =
      process.platform === 'win32'
        ? `${hostEnv}${npmCommand()} start -- --go --lan --port 8081`
        : `${hostEnv}${npmCommand()} start -- --go --lan --port 8081`;

    return {
      commandLine: startCommand,
      cwd: mobileRoot,
      description: 'npm start -- --go --lan --port 8081 (mobile)',
    };
  }

  return {
    commandLine: `${npmCommand()} run dev:client`,
    cwd: projectRoot(),
    description: 'npm run dev:client',
  };
}

function appendLog(name: ManagedProcessName, line: string): void {
  const state = stateMap[name];
  state.recentLogs.push(line);
  if (state.recentLogs.length > maxLogEntries) {
    state.recentLogs.splice(0, state.recentLogs.length - maxLogEntries);
  }
}

function stripAnsi(value: string): string {
  // ANSI-Escape-Sequenzen aus Logzeilen entfernen — das Steuerzeichen ist
  // hier bewusst Teil des Patterns, daher no-control-regex gezielt deaktiviert.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function resolvePrimaryIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function extractExpoUrl(line: string): string | null {
  const cleaned = stripAnsi(line);
  const match = cleaned.match(/\bexp(?:s)?:\/\/[^\s'"`<>]+/i);
  if (match) {
    return match[0];
  }

  const httpMatch = cleaned.match(/\bhttps?:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+):\d{2,5}(?:\/[^\s'"`<>]*)?/i);
  if (!httpMatch) {
    return null;
  }

  const httpUrl = httpMatch[0];
  const local = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(httpUrl);
  if (local) {
    const localMatch = httpUrl.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/i);
    if (!localMatch) {
      return null;
    }
    const port = localMatch[1];
    const lanIp = resolvePrimaryIpv4();
    if (!lanIp) {
      return null;
    }
    return `exp://${lanIp}:${port}`;
  }

  return httpUrl.replace(/^https?:\/\//i, 'exp://');
}

function buildQrImageUrl(payload: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payload)}`;
}

function captureMobileQr(name: ManagedProcessName, line: string): void {
  if (name !== 'mobile') {
    return;
  }

  const state = stateMap.mobile;
  const expoUrl = extractExpoUrl(line);
  if (!expoUrl) {
    return;
  }

  state.mobileExpoUrl = expoUrl;
  state.mobileQrImageUrl = buildQrImageUrl(expoUrl);
  state.mobileQrUpdatedAt = new Date().toISOString();
}

/**
 * Grund eines Fehlstarts aus den letzten Ausgabezeilen formulieren.
 *
 * Ein Fehlstart war bisher STUMM: `lastError` blieb null und das Admin zeigte
 * nur "gestoppt" ohne Grund. Realer Fall (2026-08-19): Port 8081 war belegt,
 * Expo fragte interaktiv "Use port 8082 instead?", lief aber non-interaktiv und
 * beendete sich mit Code 1 — ohne Dev-Server, ohne QR-Code und ohne sichtbare
 * Ursache im Admin.
 *
 * Zeitstempel-Zeilen des Managers selbst (`[2026-…] starting: …`) werden
 * übersprungen, die `[stdout]`/`[stderr]`-Präfixe entfernt. Pure.
 */
export function describeExitFailure(recentLogs: readonly string[], code: number): string {
  const tail = recentLogs
    .slice(-8)
    .map((entry) => entry.replace(/^\[(?:stdout|stderr)\]\s*/, '').trim())
    .filter((entry) => entry.length > 0 && !/^\[\d{4}-/.test(entry))
    .slice(-3);
  return tail.length > 0
    ? `Beendet mit Code ${code}: ${tail.join(' | ')}`
    : `Beendet mit Code ${code}.`;
}

function normalizeLine(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function cloneOllamaPullState(): OllamaPullState {
  return {
    running: ollamaPullState.running,
    model: ollamaPullState.model,
    startedAt: ollamaPullState.startedAt,
    finishedAt: ollamaPullState.finishedAt,
    lastError: ollamaPullState.lastError,
    lastOutput: ollamaPullState.lastOutput,
  };
}

export function getManagedProcessStatus(): Record<ManagedProcessName, ProcessState> {
  return {
    ollama: {
      ...stateMap.ollama,
      recentLogs: [...stateMap.ollama.recentLogs],
    },
    app: {
      ...stateMap.app,
      recentLogs: [...stateMap.app.recentLogs],
    },
    mobile: {
      ...stateMap.mobile,
      recentLogs: [...stateMap.mobile.recentLogs],
    },
  };
}

export function getOllamaPullStatus(): OllamaPullState {
  return cloneOllamaPullState();
}

export function startManagedProcess(name: ManagedProcessName): ProcessState {
  const current = processMap[name];
  const state = stateMap[name];

  if (current && !current.killed) {
    state.running = true;
    state.pid = current.pid ?? null;
    return {
      ...state,
      recentLogs: [...state.recentLogs],
    };
  }

  const config = processConfig(name);
  state.description = config.description;
  state.lastError = null;
  state.lastExitCode = null;
  state.lastSignal = null;
  if (name === 'mobile') {
    state.mobileExpoUrl = null;
    state.mobileQrImageUrl = null;
    state.mobileQrUpdatedAt = null;
  }
  appendLog(name, `[${new Date().toISOString()}] starting: ${config.commandLine}`);
  appendBackendDebugLog('info', `process.start requested`, {
    target: name,
    commandLine: config.commandLine,
  });

  let child: ChildProcess;
  try {
    const stdio =
      name === 'mobile'
        ? (['pipe', 'pipe', 'pipe'] as const)
        : (['ignore', 'pipe', 'pipe'] as const);
    child = spawn(config.commandLine, {
      cwd: config.cwd,
      env: process.env,
      shell: true,
      stdio,
    });
  } catch (error) {
    state.running = false;
    state.pid = null;
    state.lastError =
      error instanceof Error ? error.message : 'Start failed with unknown error.';
    appendLog(name, `[error] ${state.lastError}`);
    appendBackendDebugLog('error', 'process.start failed', {
      target: name,
      error: state.lastError,
    });
    return {
      ...state,
      recentLogs: [...state.recentLogs],
    };
  }
  processMap[name] = child;

  state.running = true;
  state.pid = child.pid ?? null;
  state.startedAt = new Date().toISOString();

  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = normalizeLine(chunk.toString('utf8'));
    lines.forEach((line) => {
      appendLog(name, `[stdout] ${line}`);
      captureMobileQr(name, line);
    });
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = normalizeLine(chunk.toString('utf8'));
    lines.forEach((line) => {
      appendLog(name, `[stderr] ${line}`);
      captureMobileQr(name, line);
    });
  });

  child.on('error', (error) => {
    state.lastError = error.message;
    appendLog(name, `[error] ${error.message}`);
    appendBackendDebugLog('error', 'process.runtime error', {
      target: name,
      error: error.message,
    });
  });

  child.on('close', (code, signal) => {
    state.running = false;
    state.pid = null;
    state.lastStoppedAt = new Date().toISOString();
    state.lastExitCode = code ?? null;
    state.lastSignal = signal ?? null;
    if (code !== 0 && code !== null && !state.lastError) {
      state.lastError = describeExitFailure(state.recentLogs, code);
    }
    appendLog(
      name,
      `[${new Date().toISOString()}] stopped: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
    );
    appendBackendDebugLog('info', 'process.stopped', {
      target: name,
      code: code ?? null,
      signal: signal ?? null,
    });
    delete processMap[name];
  });

  return {
    ...state,
    recentLogs: [...state.recentLogs],
  };
}

export function sendManagedProcessInput(
  name: ManagedProcessName,
  value: string,
): ProcessState {
  const child = processMap[name];
  const state = stateMap[name];
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    throw new Error('Leere Prozesseingabe ist nicht erlaubt.');
  }

  if (!child || child.killed || !state.running) {
    throw new Error(`Prozess "${name}" laeuft nicht.`);
  }

  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    throw new Error(`Prozess "${name}" akzeptiert aktuell keine Eingabe.`);
  }

  const payload = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  child.stdin.write(payload, 'utf8');
  appendLog(name, `[stdin] ${normalized}`);
  appendBackendDebugLog('info', 'process.stdin.sent', {
    target: name,
    input: normalized,
  });

  return {
    ...state,
    recentLogs: [...state.recentLogs],
  };
}

export function startOllamaPull(model: string): OllamaPullState {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    ollamaPullState.lastError = 'Kein Modellname angegeben.';
    return cloneOllamaPullState();
  }

  if (ollamaPullState.running && ollamaPullProcess && !ollamaPullProcess.killed) {
    return cloneOllamaPullState();
  }

  ollamaPullState.running = true;
  ollamaPullState.model = normalizedModel;
  ollamaPullState.startedAt = new Date().toISOString();
  ollamaPullState.finishedAt = null;
  ollamaPullState.lastError = null;
  ollamaPullState.lastOutput = null;

  appendBackendDebugLog('info', 'ollama.pull.start', {
    model: normalizedModel,
  });
  appendLog('ollama', `[${new Date().toISOString()}] pull start: ${normalizedModel}`);

  let child: ChildProcess;
  try {
    child = spawn(`ollama pull ${normalizedModel}`, {
      cwd: projectRoot(),
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    ollamaPullState.running = false;
    ollamaPullState.finishedAt = new Date().toISOString();
    ollamaPullState.lastError =
      error instanceof Error ? error.message : 'Ollama pull konnte nicht gestartet werden.';
    appendBackendDebugLog('error', 'ollama.pull.spawnFailed', {
      model: normalizedModel,
      error: ollamaPullState.lastError,
    });
    return cloneOllamaPullState();
  }

  ollamaPullProcess = child;
  const outputLines: string[] = [];

  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = normalizeLine(chunk.toString('utf8'));
    for (const line of lines) {
      const tagged = `[pull:${normalizedModel}] ${line}`;
      outputLines.push(tagged);
      appendLog('ollama', `[stdout] ${tagged}`);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = normalizeLine(chunk.toString('utf8'));
    for (const line of lines) {
      const tagged = `[pull:${normalizedModel}] ${line}`;
      outputLines.push(tagged);
      appendLog('ollama', `[stderr] ${tagged}`);
    }
  });

  child.on('error', (error) => {
    ollamaPullState.lastError = error.message;
    appendBackendDebugLog('error', 'ollama.pull.runtimeError', {
      model: normalizedModel,
      error: error.message,
    });
  });

  child.on('close', (code) => {
    ollamaPullState.running = false;
    ollamaPullState.finishedAt = new Date().toISOString();
    ollamaPullState.lastOutput = outputLines.slice(-40).join('\n');
    ollamaPullProcess = null;

    if (code !== 0) {
      ollamaPullState.lastError = `ollama pull beendet mit Exit-Code ${code ?? 'null'}.`;
      appendBackendDebugLog('error', 'ollama.pull.failed', {
        model: normalizedModel,
        code: code ?? null,
      });
      return;
    }

    ollamaPullState.lastError = null;
    appendBackendDebugLog('info', 'ollama.pull.completed', {
      model: normalizedModel,
      code: code ?? 0,
    });
  });

  return cloneOllamaPullState();
}

async function stopWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
}

export async function stopManagedProcess(name: ManagedProcessName): Promise<ProcessState> {
  const child = processMap[name];
  const state = stateMap[name];

  if (!child || child.killed || !state.running) {
    state.running = false;
    state.pid = null;
    return {
      ...state,
      recentLogs: [...state.recentLogs],
    };
  }

  const pid = child.pid;
  appendLog(name, `[${new Date().toISOString()}] stopping requested.`);
  appendBackendDebugLog('info', 'process.stop requested', { target: name });

  try {
    if (process.platform === 'win32' && pid) {
      await stopWindowsProcessTree(pid);
    } else {
      child.kill('SIGTERM');
    }
  } catch (error) {
    state.lastError =
      error instanceof Error ? error.message : 'Stop failed with unknown error.';
    appendLog(name, `[error] ${state.lastError}`);
    appendBackendDebugLog('error', 'process.stop failed', {
      target: name,
      error: state.lastError,
    });
  }

  return {
    ...state,
    recentLogs: [...state.recentLogs],
  };
}

export function openMobileCommandConsole(backendUrl: string): {
  ok: boolean;
  message: string;
} {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      message: 'Mobile Konsole wird aktuell nur unter Windows automatisch geoeffnet.',
    };
  }

  const scriptPath = path.resolve(
    backendRootPath(),
    'scripts',
    'mobile-remote-console.ps1',
  );
  const url = String(backendUrl || '').trim() || 'http://localhost:8787';

  try {
    const opener = spawn(
      'powershell.exe',
      [
        '-NoExit',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-BackendUrl',
        url,
      ],
      {
        cwd: projectRoot(),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    );
    opener.unref();

    appendBackendDebugLog('info', 'mobile.console.opened', {
      backendUrl: url,
      scriptPath,
    });
    return {
      ok: true,
      message: 'Mobile Kommandokonsole geoeffnet.',
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Mobile Kommandokonsole konnte nicht geoeffnet werden.';
    appendBackendDebugLog('error', 'mobile.console.open.failed', {
      backendUrl: url,
      error: message,
    });
    return {
      ok: false,
      message,
    };
  }
}

export function backendRootPath(): string {
  return path.resolve(projectRoot(), 'backend');
}
