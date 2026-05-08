import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"

const file = path.join(Global.Path.data, "usage.json")
const epsilon = 0.0001
const creditsPerUsd = 25

export type RateLimitSnapshot = {
  usedPercent?: number
  windowMinutes?: number
  resetsAt?: number
}

export type UsageEntry = {
  email?: string
  totalCredits: number
  totalUsd: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  usedPercent?: number
  windowMinutes?: number
  resetsAt?: number
  updatedAt: number
}

type UsageState = {
  providers: Record<string, UsageEntry>
}

function key(providerID: string, email?: string) {
  return `${providerID}:${email ?? ""}`
}

function header(headers: Headers, name: string) {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase()) ?? undefined
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function loadState(): Promise<UsageState> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<UsageState>
    const providers = Object.fromEntries(
      Object.entries(parsed.providers ?? {}).map(([providerKey, entry]) => [
        providerKey,
        {
          ...entry,
          totalCredits: entry.totalCredits ?? entry.totalUsd * creditsPerUsd,
        } satisfies UsageEntry,
      ]),
    )
    return { providers }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { providers: {} }
    return { providers: {} }
  }
}

async function saveState(state: UsageState): Promise<void> {
  await mkdir(Global.Path.data, { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}

export function parseRateLimit(headers: Headers): RateLimitSnapshot | undefined {
  const usedPercent = parseNumber(header(headers, "x-codex-primary-used-percent"))
  const windowMinutes = parseNumber(header(headers, "x-codex-primary-window-minutes"))
  const resetsAt = parseNumber(header(headers, "x-codex-primary-reset-at"))
  if (usedPercent == null && windowMinutes == null && resetsAt == null) return undefined
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
  }
}

export const get = (providerID: string, email?: string) =>
  Effect.promise(() => loadState().then((state) => state.providers[key(providerID, email)]))

export const reset = (providerID: string, email?: string) =>
  Effect.promise(async () => {
      const state = await loadState()
      delete state.providers[key(providerID, email)]
      await saveState(state)
  })

export const recordTurn = (input: {
  providerID: string
  email?: string
  totalUsd: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  rateLimit?: RateLimitSnapshot
}) =>
  Effect.promise(async () => {
    const state = await loadState()
    const entryKey = key(input.providerID, input.email)
    const current = state.providers[entryKey]
    const previousPercent = current?.usedPercent
    const nextPercent = input.rateLimit?.usedPercent
    const resetRequested = nextPercent != null && previousPercent != null && nextPercent + epsilon < previousPercent

    state.providers[entryKey] = {
      email: input.email ?? current?.email,
      totalCredits: resetRequested ? input.totalUsd * creditsPerUsd : (current?.totalCredits ?? 0) + input.totalUsd * creditsPerUsd,
      totalUsd: resetRequested ? input.totalUsd : (current?.totalUsd ?? 0) + input.totalUsd,
      inputTokens: resetRequested ? input.inputTokens : (current?.inputTokens ?? 0) + input.inputTokens,
      cachedInputTokens: resetRequested ? input.cachedInputTokens : (current?.cachedInputTokens ?? 0) + input.cachedInputTokens,
      outputTokens: resetRequested ? input.outputTokens : (current?.outputTokens ?? 0) + input.outputTokens,
      usedPercent: nextPercent ?? current?.usedPercent,
      windowMinutes: input.rateLimit?.windowMinutes ?? current?.windowMinutes,
      resetsAt: input.rateLimit?.resetsAt ?? current?.resetsAt,
      updatedAt: Date.now(),
    }

    await saveState(state)
  })
