import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderError } from "./types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const USAGE_FILE = resolve(DATA_DIR, "usage.json");

const MAX_WAIT_MS = 3 * 60 * 1000;

export interface GateLimits {
  rpm: number;
  rpd: number;
  tpm?: number;
  tpd?: number;
}

export interface GateSnapshot {
  day: string;
  requestsToday: number;
  tokensToday: number;
  requestsDailyCap: number;
  tokensDailyCap: number | null;
  requestsPerMinuteCap: number;
  tokensPerMinuteCap: number | null;
}

interface DayCounter {
  day: string;
  requests: number;
  tokens: number;
}

// ---------------------------------------------------------------
// Armazenamento persistente dos contadores diários (data/usage.json)
// ---------------------------------------------------------------

const counters = new Map<string, DayCounter>();
let loaded = false;
let persistQueue: Promise<void> = Promise.resolve();

async function loadCounters(): Promise<void> {
  if (loaded) return;
  loaded = true;

  try {
    const raw = await readFile(USAGE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, "").trim() || "{}");

    if (typeof parsed === "object" && parsed !== null) {
      for (const [id, value] of Object.entries(parsed)) {
        const v = value as Partial<DayCounter>;
        if (
          typeof v.day === "string" &&
          typeof v.requests === "number" &&
          typeof v.tokens === "number"
        ) {
          counters.set(id, { day: v.day, requests: v.requests, tokens: v.tokens });
        }
      }
    }
  } catch {
    // Arquivo ausente ou inválido: começa do zero.
  }
}

function schedulePersist(): void {
  persistQueue = persistQueue
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });

      const snapshot = Object.fromEntries(counters.entries());
      const tmp = `${USAGE_FILE}.${process.pid}.${randomUUID()}.tmp`;

      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
        await rename(tmp, USAGE_FILE);
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    })
    .catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ---------------------------------------------------------------
// Gate
// ---------------------------------------------------------------

export interface UsageTicket {
  /** Informa o consumo real de tokens (0 se a chamada falhou). */
  settle(actualTokens?: number): void;
}

export class UsageGate {
  private events: Array<{ at: number; tokens: number }> = [];
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly id: string,
    private readonly limits: GateLimits,
    private readonly dayTimeZone: string = "UTC",
    private readonly safety: number = 0.9
  ) {}

  private effective(value: number): number {
    return Math.max(1, Math.floor(value * this.safety));
  }

  private today(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.dayTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  }

  private counter(): DayCounter {
    const day = this.today();
    const current = counters.get(this.id);

    if (!current || current.day !== day) {
      const fresh: DayCounter = { day, requests: 0, tokens: 0 };
      counters.set(this.id, fresh);
      return fresh;
    }

    return current;
  }

  async snapshot(): Promise<GateSnapshot> {
    await loadCounters();
    const counter = this.counter();

    return {
      day: counter.day,
      requestsToday: counter.requests,
      tokensToday: counter.tokens,
      requestsDailyCap: this.effective(this.limits.rpd),
      tokensDailyCap: this.limits.tpd ? this.effective(this.limits.tpd) : null,
      requestsPerMinuteCap: this.effective(this.limits.rpm),
      tokensPerMinuteCap: this.limits.tpm ? this.effective(this.limits.tpm) : null
    };
  }

  /**
   * Reserva uma chamada. Espera se o limite por minuto estiver cheio e
   * falha (quota_exhausted) se o limite diário já foi atingido.
   */
  acquire(estimatedTokens: number): Promise<UsageTicket> {
    const run = this.mutex.then(() => this.acquireInner(estimatedTokens));
    this.mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async acquireInner(estimatedTokens: number): Promise<UsageTicket> {
    await loadCounters();

    const counter = this.counter();
    const requestCap = this.effective(this.limits.rpd);
    const dailyTokenCap = this.limits.tpd ? this.effective(this.limits.tpd) : null;

    if (counter.requests >= requestCap) {
      throw new ProviderError(
        "quota_exhausted",
        `Limite diário de requisições de ${this.id} atingido (${counter.requests}/${requestCap}). Aguarde o dia virar ou ajuste os limites no .env.`
      );
    }

    if (dailyTokenCap !== null && counter.tokens + estimatedTokens > dailyTokenCap) {
      throw new ProviderError(
        "quota_exhausted",
        `Limite diário de tokens de ${this.id} atingido (${counter.tokens}/${dailyTokenCap}). Aguarde o dia virar ou ajuste os limites no .env.`
      );
    }

    const rpmCap = this.effective(this.limits.rpm);
    const tpmCap = this.limits.tpm ? this.effective(this.limits.tpm) : Infinity;
    const need = Math.min(estimatedTokens, tpmCap);
    const startedWaiting = Date.now();

    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((event) => now - event.at < 60_000);

      const usedTokens = this.events.reduce((sum, event) => sum + event.tokens, 0);

      if (this.events.length < rpmCap && usedTokens + need <= tpmCap) {
        break;
      }

      if (now - startedWaiting > MAX_WAIT_MS) {
        throw new ProviderError(
          "rate_limit",
          `Espera excessiva pelo limite por minuto de ${this.id}.`
        );
      }

      const oldest = this.events[0];
      const waitMs = oldest
        ? Math.max(250, 60_000 - (now - oldest.at) + 50)
        : 500;

      await sleep(Math.min(waitMs, 15_000));
    }

    const event = { at: Date.now(), tokens: need };
    this.events.push(event);

    counter.requests += 1;
    counter.tokens += estimatedTokens;
    schedulePersist();

    let settled = false;

    return {
      settle: (actualTokens?: number) => {
        if (settled) return;
        settled = true;

        if (actualTokens === undefined) return;

        const current = this.counter();
        current.tokens = Math.max(0, current.tokens - estimatedTokens + actualTokens);
        event.tokens = actualTokens;
        schedulePersist();
      }
    };
  }
}
