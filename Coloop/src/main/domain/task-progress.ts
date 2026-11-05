import type { ScheduledTask, Task } from '../../shared/contracts'
import { z } from 'zod'

const uuid = z.string().uuid()

/** Stable task identifiers let a paired handset refresh without duplicating completion notices. */
export function projectTaskProgress(tasks: Task[], schedules: ScheduledTask[]) {
  const entries = tasks
    .filter((task) => uuid.safeParse(task.id).success)
    .map((task) => ({
      sessionHandle: task.id,
      text: [`任务 ${task.id}`, `状态 ${task.status}`, task.answer || task.error || task.stage]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
      at: task.finishedAt ?? task.createdAt,
    }))
  const known = new Set(tasks.map((task) => task.id))
  for (const schedule of schedules) {
    if (known.has(schedule.taskId)) continue
    entries.push({
      sessionHandle: schedule.taskId,
      text: `定时任务 ${schedule.id}\n执行编号 ${schedule.taskId}\n触发时刻 ${schedule.runAt} ${schedule.timezone}\n状态 ${schedule.status}`,
      at: schedule.finishedAt ?? schedule.startedAt ?? schedule.createdAt,
    })
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 64)
}
