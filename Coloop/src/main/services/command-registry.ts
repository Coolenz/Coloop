import { z } from 'zod'
import { commandCatalog } from './command-catalog'

export class CommandRegistry {
  private actions = new Map<string, (...args: any[]) => unknown>()

  register(name: string, action: (...args: any[]) => unknown) {
    if (!Object.hasOwn(commandCatalog, name)) throw new Error(`COMMAND_CATALOG_MISSING: ${name}`)
    this.actions.set(name, action)
  }

  describe(name?: string) {
    return [...this.actions.keys()]
      .filter((key) => !name || key === name)
      .sort()
      .map((key) => {
        const spec = commandCatalog[key]
        return {
          name: key,
          description: spec?.description ?? key,
          sensitive: spec?.sensitive ?? false,
          inputSchema: spec?.input
            ? z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' })
            : null,
          inputRequired: spec?.input ? !spec.input.isOptional() : false,
        }
      })
  }

  async invoke(name: string, args: unknown[]) {
    const action = this.actions.get(name)
    if (!action) throw new Error('COMMAND_NOT_FOUND')
    const spec = commandCatalog[name]
    if (args.length > 1 || (!spec?.input && args.length)) throw new Error('INVALID_ARGUMENTS')
    if (spec?.input) {
      const parsed = spec.input.safeParse(args[0])
      // Validation messages may echo secrets. Publish the schema separately.
      if (!parsed.success) throw new Error('INVALID_ARGUMENTS')
      return await action(parsed.data)
    }
    return await action()
  }
}
