import { z } from 'zod'
import { parseStrictJson } from '../domain/strict-json'
import { desktopPlanSchema, type DesktopRequest } from '../../shared/desktop'
import { desktopPlannerPolicy, desktopRoutePolicy } from './desktop-tasks'
import type { BoardGateway } from '../infrastructure/board'

const routeSchema = z.object({ route: z.enum(['local', 'cloud', 'blocked']) }).strict()
interface Options {
  board: Pick<BoardGateway, 'privacyAgent'>
  cooperate: (
    input: string,
    signal: AbortSignal,
    forceCloud: boolean,
  ) => Promise<{ answer: string; cloudUsed: boolean }>
  onSource: (source: 'local' | 'cloud') => void
}

/** A desktop plan is structured action data, never a prose answer with entity prefixes. */
export async function planDesktopTask(
  request: DesktopRequest,
  input: string,
  signal: AbortSignal,
  options: Options,
): Promise<string> {
  let route: 'local' | 'cloud' | 'blocked' = request.planner === 'rk' ? 'local' : 'cloud'
  signal.throwIfAborted()
  if (request.planner === 'auto') {
    const raw = await options.board.privacyAgent(desktopRoutePolicy, input, signal, 32)
    signal.throwIfAborted()
    if (Buffer.byteLength(raw, 'utf8') > 256) throw new Error('INVALID_DESKTOP_ROUTE')
    route = routeSchema.parse(parseStrictJson(raw)).route
  }
  if (route === 'blocked') throw new Error('DESKTOP_ROUTE_BLOCKED')
  let answer: string
  if (route === 'local') {
    options.onSource('local')
    answer = await options.board.privacyAgent(desktopPlannerPolicy, input, signal, 512)
  } else {
    const result = await options.cooperate(input, signal, request.planner === 'auto')
    options.onSource(result.cloudUsed ? 'cloud' : 'local')
    answer = result.answer
  }
  signal.throwIfAborted()
  if (Buffer.byteLength(answer, 'utf8') > 8192) throw new Error('INVALID_DESKTOP_PLAN')
  return JSON.stringify(desktopPlanSchema.parse(parseStrictJson(answer)))
}
