import { Effect } from "effect"
import { Auth } from "@/auth"
import { get, reset } from "@/status/usage"
import { effectCmd } from "../effect-cmd"

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
}

function pct(value?: number) {
  if (value == null) return "unknown"
  return `${value.toFixed(1)}%`
}

export const StatusCommand = effectCmd({
  command: "status",
  describe: "show account usage status",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("provider", {
        type: "string",
        default: "openai",
        describe: "provider to inspect",
      })
      .option("reset", {
        type: "boolean",
        default: false,
        describe: "clear the stored usage snapshot",
      }),
  handler: Effect.fn("Cli.status")(function* (args) {
    const auth = yield* Auth.Service
    const authInfo = yield* auth.get(args.provider).pipe(Effect.orDie)
    const email = authInfo?.type === "oauth" ? authInfo.email : undefined
    const accountId = authInfo && "accountId" in authInfo ? authInfo.accountId : undefined

    if (args.reset) {
      yield* reset(args.provider, email).pipe(Effect.orDie)
    }

    const snapshot = yield* get(args.provider, email).pipe(Effect.orDie)

    process.stdout.write(`Provider: ${args.provider}\n`)
    process.stdout.write(`Account: ${email ?? accountId ?? authInfo?.type ?? "unknown"}\n`)
    process.stdout.write(`Backend used_percent: ${pct(snapshot?.usedPercent)}\n`)
    process.stdout.write(`Usage credits: ${snapshot ? snapshot.totalCredits.toFixed(2) : "0.00"}\n`)
    process.stdout.write(`Usage USD: ${money(snapshot?.totalUsd ?? 0)}\n`)
    process.stdout.write(`Input tokens: ${snapshot?.inputTokens ?? 0}\n`)
    process.stdout.write(`Cached input: ${snapshot?.cachedInputTokens ?? 0}\n`)
    process.stdout.write(`Output tokens: ${snapshot?.outputTokens ?? 0}\n`)
    if (snapshot?.resetsAt) {
      process.stdout.write(`Resets at: ${new Date(snapshot.resetsAt * 1000).toISOString()}\n`)
    }
  }),
})
