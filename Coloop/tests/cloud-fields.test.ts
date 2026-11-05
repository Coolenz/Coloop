import { expect, it } from 'vitest'
import { CloudFields } from '../src/main/domain/cloud-fields'

const fields = () =>
  new CloudFields([
    { name: '订单号', type: 'identifier' },
    { name: '金额', type: 'number' },
  ])
it('projects only approved exact source fields and leaves notes and credentials local', () => {
  const source = fields()
  source.capture(
    '订单号：TEST-202611-001\r\n金额：￥387.00 元\r\n私人便笺：CANARY_PRIVATE_4827\r\napi_key: sk-synthetic-secret',
  )
  expect(source.facts()).toEqual([
    { field: '订单号', value: 'TEST-202611-001' },
    { field: '金额', value: 387 },
  ])
  expect(JSON.stringify(source.facts())).not.toContain('CANARY')
})
it('requires grounded unambiguous values and clears them after a changed requirement', () => {
  const source = fields()
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
  source.capture('订单号：TEST-001\n金额：387\n金额：999')
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
  source.capture('金额：387')
  expect(source.facts()[1].value).toBe(387)
  source.clear()
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
})
it('accepts exact structured CSV columns and rejects duplicate headers', () => {
  const source = fields()
  source.captureCsv(
    ['订单号', '金额', '私人便笺'],
    [{ cells: ['TEST-001', '387', 'CANARY_PRIVATE'] }],
  )
  expect(source.facts()).toHaveLength(2)
  source.captureCsv(['订单号', '金额', '金额'], [{ cells: ['TEST-001', '387', '999'] }])
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
})
it('retains a final credential and PII guard even for approved labels', () => {
  expect(() => new CloudFields([{ name: 'api_token', type: 'identifier' }])).toThrow(
    'SECRET_FIELD_CANNOT_BE_APPROVED',
  )
  const source = new CloudFields([{ name: '编号', type: 'identifier' }])
  source.capture('编号：13800138000')
  expect(() => source.facts()).toThrow('PRIVACY_UNSAFE_EGRESS')
  source.capture('编号：TEST-001 私人便笺CANARY')
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
  expect(new CloudFields([]).facts()).toEqual([])
})

it('takes an immutable snapshot of approved fields and isolates returned projections', () => {
  const approved = [{ name: '编号', type: 'identifier' as const }]
  const source = new CloudFields(approved)
  approved[0].name = '私人便笺'
  approved.push({ name: '新增字段', type: 'identifier' })
  source.definitions()[0].name = '另一个字段'
  source.capture('编号：TEST-001\n私人便笺：CANARY_PRIVATE')
  const facts = source.facts()
  facts[0].value = 'CALLER_MUTATION'
  facts.push({ field: '新增字段', value: 'CANARY' })
  expect(source.names()).toEqual(['编号'])
  expect(source.facts()).toEqual([{ field: '编号', value: 'TEST-001' }])
})

it('invalidates cached projection on new evidence, invalid evidence and clear', () => {
  const source = new CloudFields([{ name: '金额', type: 'number' }])
  source.capture('金额：387')
  expect(source.facts()).toEqual([{ field: '金额', value: 387 }])
  source.captureCsv(['金额'], [{ cells: ['450'] }])
  expect(source.facts()).toEqual([{ field: '金额', value: 450 }])
  source.capture('金额：invalid')
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
  source.capture('金额：999')
  expect(source.facts()).toEqual([{ field: '金额', value: 999 }])
  source.clear()
  expect(() => source.facts()).toThrow('APPROVED_FIELD_SOURCE_REQUIRED')
})

it('validates internal approvals and compatibility spellings before capturing data', () => {
  expect(() => new CloudFields([{ name: 'ｐａｓｓｗｏｒｄ', type: 'identifier' }])).toThrow(
    'SECRET_FIELD_CANNOT_BE_APPROVED',
  )
  expect(
    () =>
      new CloudFields([
        { name: '金额', type: 'number' },
        { name: ' 金额 ', type: 'number' },
      ]),
  ).toThrow('DUPLICATE_APPROVED_FIELDS')
  expect(() => new CloudFields([{ name: '金额', type: 'text' as never }])).toThrow()
  expect(
    () =>
      new CloudFields(
        Array.from({ length: 17 }, (_, i) => ({
          name: `field${i}`,
          type: 'number',
        })),
      ),
  ).toThrow()
})
