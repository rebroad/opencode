import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt } from "@/util/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const directory = path.join(Global.Path.data, "auth.json.d")
const profileSuffix = ".json"

function encodeProfileKey(key: string) {
  return Buffer.from(key, "utf8").toString("base64url")
}

function decodeProfileKey(key: string) {
  return Buffer.from(key, "base64url").toString("utf8")
}

function profilePath(key: string) {
  return path.join(directory, `${encodeProfileKey(key)}${profileSuffix}`)
}

function profileKey(name: string) {
  return decodeProfileKey(name.slice(0, -profileSuffix.length))
}

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const loadFromFile = Effect.fn("Auth.loadFromFile")(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const loadFromDirectory = Effect.fn("Auth.loadFromDirectory")(function* () {
      const entries = yield* fsys.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
      const files = entries.filter((entry) => entry.type === "file" && entry.name.endsWith(profileSuffix))
      const raw = yield* Effect.all(
        files.map((entry) =>
          fsys.readJson(path.join(directory, entry.name)).pipe(
            Effect.map((value) => [profileKey(entry.name), value] as const),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        ),
      )
      return Record.filterMap(Record.fromEntries(raw.filter((value): value is readonly [string, unknown] => value !== undefined)), (value) =>
        Result.fromOption(decode(value), () => undefined),
      )
    })

    const writeDirectory = Effect.fn("Auth.writeDirectory")(function* (data: Record<string, Info>) {
      yield* fsys.ensureDir(directory).pipe(Effect.mapError(fail("Failed to write auth data")))
      const entries = yield* fsys.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
      const nextFiles = new Set(Object.keys(data).map((key) => `${encodeProfileKey(key)}${profileSuffix}`))

      yield* Effect.all(
        entries
          .filter((entry) => entry.type === "file" && entry.name.endsWith(profileSuffix) && !nextFiles.has(entry.name))
          .map((entry) => fsys.remove(path.join(directory, entry.name)).pipe(Effect.catch(() => Effect.void))),
      )

      yield* Effect.all(
        Object.entries(data).map(([key, value]) =>
          fsys.writeJson(profilePath(key), value, 0o600).pipe(Effect.mapError(fail("Failed to write auth data"))),
        ),
      )
    })

    const writeFile = Effect.fn("Auth.writeFile")(function* (data: Record<string, Info>) {
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = yield* loadFromFile()
      const profiles = yield* loadFromDirectory()
      return { ...data, ...profiles }
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      const next = { ...data, [norm]: info }
      yield* writeFile(next)
      yield* writeDirectory(next)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* writeFile(data)
      yield* writeDirectory(data)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
