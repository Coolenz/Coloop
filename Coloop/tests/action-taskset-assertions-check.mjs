// CPU evidence checks only. Does not import Electron or contact RK/cloud/USB/clipboard.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { actualSentActions, evaluateTask } from './action-taskset-assertions.mjs'
const taskset = JSON.parse(
  await readFile(new URL('./action-taskset.json', import.meta.url), 'utf8'),
)
const get = (id) => taskset.tasks.find((task) => task.id === id)
const clone = (value) => structuredClone(value)
const evidence = {
  checkbox: {
    initial: { checked: false, mouse_down_count: 0, mouse_up_count: 0 },
    final: { checked: true, mouse_down_count: 1, mouse_up_count: 1 },
    actions: [{ action: 'click', target_id: 1 }],
  },
  double_click: {
    initial: { doubleclick_count: 0, mouse_down_count: 0, mouse_up_count: 0 },
    final: { doubleclick_count: 1, mouse_down_count: 2, mouse_up_count: 2 },
    actions: [{ action: 'double_click', target_id: 1 }],
  },
  hover: {
    initial: { mouse_enter_count: 0, mouse_down_count: 0, mouse_up_count: 0, click_count: 0 },
    final: { mouse_enter_count: 1, mouse_down_count: 0, mouse_up_count: 0, click_count: 0 },
    actions: [{ action: 'move', target_id: 1 }],
  },
  scroll: {
    initial: {
      scroll: {
        first_visible_line: 0,
        line_count: 102,
        bottom_visible: false,
        native_scroll_count: 0,
      },
    },
    final: {
      scroll: {
        first_visible_line: 85,
        line_count: 102,
        bottom_visible: true,
        native_scroll_count: 4,
      },
    },
    actions: [{ action: 'scroll', target_id: 1, steps: -32 }],
  },
  two_fields: {
    initial: { fields: { a: 'old A', b: 'old B' } },
    final: { fields: { a: '订单甲-731', b: '项目乙-842' } },
    actions: [
      { action: 'paste', target_id: 1, text: '订单甲-731' },
      { action: 'paste', target_id: 2, text: '项目乙-842' },
    ],
  },
  replace_undo_redo: {
    initial: { sequence: 2, fields: { revision: 'Original revision' } },
    final: {
      fields: { revision: 'Revision Beta 中文' },
      events: [
        { seq: 3, type: 'text_changed', control: 'revision', value: 'Revision Beta 中文' },
        { seq: 4, type: 'undo_keydown', control: 'revision', value: 'Revision Beta 中文' },
        { seq: 5, type: 'text_changed', control: 'revision', value: 'Original revision' },
        { seq: 6, type: 'redo_keydown', control: 'revision', value: 'Original revision' },
        { seq: 7, type: 'text_changed', control: 'revision', value: 'Revision Beta 中文' },
      ],
    },
    actions: [
      { action: 'paste', target_id: 1, text: 'Revision Beta 中文' },
      { action: 'hotkey', target_id: 1, keys: 'CTRL+Z' },
      { action: 'hotkey', target_id: 1, keys: 'CTRL+Y' },
    ],
  },
}
function evaluate(id, change = () => {}, outcome = 'input_sent') {
  const row = clone(evidence[id])
  change(row)
  const group = 'cpu-evidence-' + id
  const validations = row.actions.map((action, index) => ({
    action_group_id: group,
    action_index: index,
    action,
  }))
  const receipts = row.actions.map((action, index) => ({
    action_group_id: group,
    index,
    action: action.action,
    outcome,
  }))
  const actions = actualSentActions([{ type: 'task.state', value: { receipts } }], validations)
  return evaluateTask(
    get(id),
    { task_id: id, ...row.initial },
    { task_id: id, ...row.final },
    actions,
  )
}
const results = []
for (const task of taskset.tasks) {
  const value = evaluate(task.id)
  assert.equal(value.passed, true, JSON.stringify(value))
  results.push({ check: 'positive_' + task.id, passed: true })
}
const negative = [
  [
    'claimed_success_without_sent_input',
    () => evaluate('checkbox', () => {}, 'not_sent'),
    'missing_action:click',
  ],
  [
    'unknown_input_not_counted_as_sent',
    () => evaluate('checkbox', () => {}, 'unknown'),
    'missing_action:click',
  ],
  [
    'hover_with_mouse_down',
    () =>
      evaluate('hover', (row) => {
        row.final.mouse_down_count = 1
      }),
    'fixture_mouse_down_count',
  ],
  [
    'hover_keyboard_click_is_not_hover_only',
    () =>
      evaluate('hover', (row) => {
        row.final.click_count = 1
      }),
    'hover_was_clicked',
  ],
  [
    'scroll_without_real_wheel',
    () =>
      evaluate('scroll', (row) => {
        row.final.scroll.native_scroll_count = 0
      }),
    'no_native_wheel_event',
  ],
  [
    'scroll_using_keyboard_jump',
    () =>
      evaluate('scroll', (row) => {
        row.actions.push({ action: 'hotkey', target_id: 1, keys: 'CTRL+END' })
      }),
    'scroll_used_keyboard_or_text_input',
  ],
  [
    'two_fields_cross_written',
    () =>
      evaluate('two_fields', (row) => {
        row.final.fields.b = '订单甲-731'
      }),
    'field_b_not_exact',
  ],
  [
    'redo_final_text_without_intermediate_original',
    () =>
      evaluate('replace_undo_redo', (row) => {
        row.final.events = row.final.events.filter((event) => event.seq !== 5)
      }),
    'replacement_undo_redo_text_sequence',
  ],
]
for (const [name, run, expected] of negative) {
  const value = run()
  assert.equal(value.passed, false, name)
  assert.ok(value.errors.includes(expected), name + ': ' + JSON.stringify(value))
  results.push({ check: name, passed: true, rejected_by: expected })
}
console.log(
  JSON.stringify(
    { ok: true, scope: 'CPU assertions only; no cloud/RK/USB', checks: results.length, results },
    null,
    2,
  ),
)
