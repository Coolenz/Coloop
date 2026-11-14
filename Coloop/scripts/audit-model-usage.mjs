import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Read-only companion to ModelUsageLedger. Never print raw settings, log rows,
// task IDs, provider request IDs, URLs, model names, or filesystem error text.
const hash = (value) => createHash('sha256').update(value).digest('hex')
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v) => Number.isSafeInteger(v) && v >= 0
const date = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const defaults = {
  usageBudgetEnabled: false,
  costLimitEnabled: false,
  maxRequestsPerTask: 64,
  maxRequestsPerDay: 128,
  maxTokenUnitsPerTask: 250000,
  maxTokenUnitsPerDay: 1000000,
  maxInputBytes: 96000,
  maxOutputTokens: 8192,
  minRequestIntervalMs: 1000,
  maxNoProgressRequests: 6,
}
const ranges = {
  maxRequestsPerTask: [1, 256],
  maxRequestsPerDay: [1, 10000],
  maxTokenUnitsPerTask: [1000, 10000000],
  maxTokenUnitsPerDay: [1000, 100000000],
  maxInputBytes: [1000, 1000000],
  maxOutputTokens: [512, 1048576],
  minRequestIntervalMs: [0, 60000],
  maxNoProgressRequests: [2, 32],
}
const stamp = (s) => `${s.size}:${s.mtimeMs}:${s.ino}`
async function readSource(directory, name) {
  try {
    const before = await stat(join(directory, name))
    if (!before.isFile() || before.size > 64 * 1024 * 1024) return { status: 'unreadable' }
    const text = await readFile(join(directory, name), 'utf8')
    const after = await stat(join(directory, name))
    return {
      status: stamp(before) === stamp(after) ? 'ready' : 'unstable',
      text,
      stamp: stamp(after),
    }
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}
function json(source) {
  if (source.status !== 'ready') return undefined
  try {
    return JSON.parse(source.text)
  } catch {
    source.status = 'invalid'
    return undefined
  }
}
function configuration(source) {
  const state = json(source)
  if (!state) return { status: source.status, effectiveLimits: null }
  if (!object(state.settings)) return { status: 'invalid', effectiveLimits: null }
  const raw = state.settings.modelLimits
  if (raw !== undefined && !object(raw)) return { status: 'invalid', effectiveLimits: null }
  const limits = { ...defaults }
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (name === 'mode') {
      if (!['unlimited', 'custom'].includes(value))
        return { status: 'invalid', effectiveLimits: null }
      limits.mode = value
    } else if (['usageBudgetEnabled', 'costLimitEnabled', 'inputLimitEnabled'].includes(name)) {
      if (typeof value !== 'boolean') return { status: 'invalid', effectiveLimits: null }
      limits[name] = value
    } else if (Object.hasOwn(ranges, name)) {
      const [min, max] = ranges[name]
      if (!Number.isInteger(value) || value < min || value > max)
        return { status: 'invalid', effectiveLimits: null }
      limits[name] = value
    } else if (
      [
        'maxCostYuanPerTask',
        'maxCostYuanPerDay',
        'inputYuanPerMillion',
        'outputYuanPerMillion',
      ].includes(name)
    ) {
      const minimum = name.startsWith('maxCost') ? 0.01 : 0
      const maximum =
        name === 'maxCostYuanPerTask' ? 10000 : name === 'maxCostYuanPerDay' ? 100000 : 1000000
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
      )
        return { status: 'invalid', effectiveLimits: null }
    }
  }
  limits.mode ??=
    limits.usageBudgetEnabled || limits.costLimitEnabled || limits.inputLimitEnabled
      ? 'custom'
      : 'unlimited'
  limits.inputLimitEnabled = limits.mode === 'custom' && (limits.inputLimitEnabled ?? true)
  limits.usageBudgetEnabled = limits.mode === 'custom' && limits.usageBudgetEnabled
  limits.costLimitEnabled = limits.mode === 'custom' && limits.costLimitEnabled
  if (limits.mode === 'unlimited') limits.minRequestIntervalMs = 0
  return {
    status: 'ready',
    origin: raw === undefined ? 'defaults' : 'profile',
    effectiveLimits: limits,
    pricingConfigured:
      typeof raw?.inputYuanPerMillion === 'number' && typeof raw?.outputYuanPerMillion === 'number',
  }
}
const counter = (value) => object(value) && count(value.requests) && count(value.tokenUnits)
function ledger(source) {
  const value = json(source)
  if (!value) return { status: source.status, days: null, tasks: null }
  if (
    value.version !== 1 ||
    !object(value.days) ||
    !object(value.tasks) ||
    !Object.entries(value.days).every(([day, row]) => date(day) && counter(row)) ||
    !Object.values(value.tasks).every((row) => counter(row) && date(row.day))
  )
    return { status: 'invalid', days: null, tasks: null }
  return {
    status: 'ready',
    days: Object.entries(value.days)
      .sort()
      .map(([day, row]) => ({ day, requests: row.requests, tokenUnits: row.tokenUnits })),
    tasks: Object.entries(value.tasks).map(([id, row]) => ({
      taskHash: hash(id),
      requests: row.requests,
      tokenUnits: row.tokenUnits,
    })),
  }
}
function log(source) {
  if (source.status !== 'ready')
    return { status: source.status, summary: null, days: null, tasks: null }
  let invalidLines = 0,
    blockedEvents = 0,
    requestRows = 0,
    responseRows = 0
  let duplicateRequestIds = 0,
    duplicateResponseIds = 0,
    unknownEvents = 0
  const requests = new Map(),
    responses = new Map()
  for (const line of source.text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      invalidLines++
      continue
    }
    if (!object(entry)) {
      invalidLines++
      continue
    }
    if (
      entry.type === 'cooldown' &&
      Number.isFinite(entry.until) &&
      entry.until >= entry.at &&
      (entry.status === 429 || entry.status >= 500)
    )
      continue
    if (entry.type === 'blocked') {
      blockedEvents++
      continue
    }
    if (!['request', 'response'].includes(entry.type)) {
      unknownEvents++
      continue
    }
    if (
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.taskId !== 'string' ||
      !entry.taskId
    ) {
      invalidLines++
      continue
    }
    if (entry.type === 'request') {
      if (!date(entry.day) || !count(entry.reservedTokenUnits)) {
        invalidLines++
        continue
      }
      requestRows++
      if (requests.has(entry.id)) duplicateRequestIds++
      else
        requests.set(entry.id, {
          taskHash: hash(entry.taskId),
          day: entry.day,
          units: entry.reservedTokenUnits,
        })
    } else {
      if (
        !count(entry.chargedTokenUnits) ||
        !['provider', 'conservative_reservation'].includes(entry.usageSource)
      ) {
        invalidLines++
        continue
      }
      responseRows++
      if (responses.has(entry.id)) duplicateResponseIds++
      else
        responses.set(entry.id, {
          taskHash: hash(entry.taskId),
          units: entry.chargedTokenUnits,
          source: entry.usageSource,
          aborted: entry.aborted === true,
          providerHash:
            typeof entry.providerRequestId === 'string' && entry.providerRequestId
              ? hash(
                  entry.taskId +
                    '\0' +
                    String(entry.provider ?? '') +
                    '\0' +
                    entry.providerRequestId,
                )
              : undefined,
        })
    }
  }
  const days = new Map(),
    tasks = new Map(),
    providerIds = new Map()
  let unsettledRequests = 0,
    unsettledReservedTokenUnits = 0,
    conservativeResponses = 0,
    conservativeResponseTokenUnits = 0,
    providerUsageResponses = 0,
    abortedResponses = 0,
    orphanResponses = 0,
    identityMismatches = 0
  const add = (map, key, units) => {
    const item = map.get(key) ?? { requests: 0, tokenUnits: 0 }
    item.requests++
    item.tokenUnits += units
    map.set(key, item)
  }
  for (const [id, request] of requests) {
    const response = responses.get(id)
    const matched = response?.taskHash === request.taskHash ? response : undefined
    if (response && !matched) identityMismatches++
    const units = matched?.units ?? request.units
    add(days, request.day, units)
    add(tasks, request.taskHash, units)
    if (!matched) {
      unsettledRequests++
      unsettledReservedTokenUnits += request.units
    }
  }
  for (const [id, response] of responses) {
    if (!requests.has(id)) orphanResponses++
    if (response.source === 'conservative_reservation') {
      conservativeResponses++
      conservativeResponseTokenUnits += response.units
    } else providerUsageResponses++
    if (response.aborted) abortedResponses++
    if (response.providerHash)
      providerIds.set(response.providerHash, (providerIds.get(response.providerHash) ?? 0) + 1)
  }
  const providerRequestIdReuse = [...providerIds.entries()]
    .filter(([, n]) => n > 1)
    .map(([groupHash, responseCount]) => ({ groupHash, responseCount }))
  return {
    status: invalidLines || unknownEvents ? 'partial' : 'ready',
    summary: {
      requestRows,
      responseRows,
      uniqueRequests: requests.size,
      uniqueResponses: responses.size,
      duplicateRequestIds,
      duplicateResponseIds,
      unsettledRequests,
      unsettledReservedTokenUnits,
      conservativeResponses,
      conservativeResponseTokenUnits,
      providerUsageResponses,
      abortedResponses,
      orphanResponses,
      identityMismatches,
      blockedEvents,
      invalidLines,
      unknownEvents,
      providerRequestIdReuse,
    },
    days: [...days].sort().map(([day, row]) => ({ day, ...row })),
    tasks: [...tasks].map(([taskHash, row]) => ({ taskHash, ...row })),
  }
}

/** A snapshot of one profile, not an account-wide or live enforcement mechanism. */
export async function auditProfile(profile) {
  const directory = resolve(profile)
  const names = ['state.json', 'model-usage-state.json', 'model-usage.jsonl']
  const sources = await Promise.all(names.map((name) => readSource(directory, name)))
  // Catch writes between the separate reads. The files are not an atomic snapshot.
  await Promise.all(
    sources.map(async (source, i) => {
      if (!source.stamp) return
      try {
        if (stamp(await stat(join(directory, names[i]))) !== source.stamp)
          source.status = 'unstable'
      } catch {
        source.status = 'unstable'
      }
    }),
  )
  const config = configuration(sources[0]),
    state = ledger(sources[1]),
    events = log(sources[2])
  const warnings = [],
    violations = []
  const limits = config.effectiveLimits
  if (!limits) warnings.push('CONFIGURATION_UNKNOWN')
  if (state.status !== 'ready') warnings.push('LEDGER_' + state.status.toUpperCase())
  if (events.status !== 'ready') warnings.push('LOG_' + events.status.toUpperCase())
  const compare = (a, b, key) => {
    const left = new Map(a.map((r) => [r[key], r])),
      right = new Map(b.map((r) => [r[key], r]))
    return [...new Set([...left.keys(), ...right.keys()])].filter((id) => {
      const x = left.get(id) ?? { requests: 0, tokenUnits: 0 },
        y = right.get(id) ?? { requests: 0, tokenUnits: 0 }
      return x.requests !== y.requests || x.tokenUnits !== y.tokenUnits
    }).length
  }
  const consistency =
    state.status === 'ready' && events.status === 'ready'
      ? {
          status: 'checked',
          mismatchedDays: compare(state.days, events.days, 'day'),
          mismatchedTasks: compare(state.tasks, events.tasks, 'taskHash'),
        }
      : { status: 'unknown', mismatchedDays: null, mismatchedTasks: null }
  if (consistency.mismatchedDays || consistency.mismatchedTasks)
    warnings.push('LEDGER_LOG_MISMATCH')
  if (
    events.summary?.duplicateRequestIds ||
    events.summary?.duplicateResponseIds ||
    events.summary?.identityMismatches ||
    events.summary?.orphanResponses
  )
    warnings.push('LOG_IDENTITY_ANOMALY')
  if (events.summary?.providerRequestIdReuse.length) warnings.push('PROVIDER_REQUEST_ID_REUSED')
  const cap = (used, maximum, enabled) => ({
    used,
    maximum,
    enforced: enabled,
    exceeded: used > maximum,
    remaining: Math.max(0, maximum - used),
  })
  const days =
    state.days?.map((r) => ({
      ...r,
      ...(limits
        ? {
            requestsCap: cap(r.requests, limits.maxRequestsPerDay, limits.usageBudgetEnabled),
            tokenUnitsCap: cap(r.tokenUnits, limits.maxTokenUnitsPerDay, limits.usageBudgetEnabled),
          }
        : {}),
    })) ?? null
  const tasks =
    state.tasks?.map((r) => ({
      ...r,
      ...(limits
        ? {
            requestsCap: cap(r.requests, limits.maxRequestsPerTask, true),
            tokenUnitsCap: cap(
              r.tokenUnits,
              limits.maxTokenUnitsPerTask,
              limits.usageBudgetEnabled,
            ),
          }
        : {}),
    })) ?? null
  for (const r of [...(days ?? []), ...(tasks ?? [])]) {
    if (r.requestsCap?.exceeded) violations.push('REQUEST_CAP_EXCEEDED')
    if (r.tokenUnitsCap?.exceeded) violations.push('TOKEN_UNIT_CAP_EXCEEDED')
  }
  return {
    version: 1,
    profileHash: hash(directory),
    readOnly: true,
    status: violations.length ? 'attention' : warnings.length ? 'inconclusive' : 'within_limits',
    configuration: config,
    ledger: { status: state.status, days, tasks },
    log: { status: events.status, summary: events.summary },
    consistency,
    warnings: [...new Set(warnings)],
    violations: [...new Set(violations)],
    notes: [
      'One profile only; missing evidence does not prove zero requests.',
      'Reservations are conservative token units, not exact billable tokens.',
      'Provider request ID reuse is a diagnostic, not proof of duplicate billing.',
      'Current configuration cannot prove which limits were active for past requests.',
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.log(
      JSON.stringify({
        status: 'invalid_arguments',
        usage: 'node scripts/audit-model-usage.mjs <profile>',
      }),
    )
    process.exitCode = 2
  } else {
    try {
      const report = await auditProfile(process.argv[2])
      console.log(JSON.stringify(report, null, 2))
      process.exitCode =
        report.status === 'within_limits' ? 0 : report.status === 'attention' ? 1 : 2
    } catch {
      console.log(JSON.stringify({ status: 'inconclusive', error: 'AUDIT_UNAVAILABLE' }))
      process.exitCode = 2
    }
  }
}
