// Independent fixture evidence + sent-input receipts. Model claims are never business evidence.
export function actualSentActions(events, validations) {
  const states = events.filter(
    (event) => event.type === 'task.state' && Array.isArray(event.value?.receipts),
  )
  const receipts = states.at(-1)?.value.receipts ?? []
  return receipts
    .filter((row) => row.outcome === 'input_sent')
    .map((row) => {
      const sent = validations.find(
        (value) =>
          value.action_group_id === row.action_group_id && value.action_index === row.index,
      )
      return sent
        ? { ...sent.action, action_group_id: row.action_group_id, index: row.index }
        : { action: row.action, unresolved: true }
    })
}

export function evaluateTask(task, initial, final, actions) {
  const errors = []
  const require = (value, message) => {
    if (!value) errors.push(message)
  }
  require(initial?.task_id === task.id && final?.task_id === task.id, 'fixture_identity')
  const coverage = Object.fromEntries(
    [...new Set(actions.map((action) => action.action))].map((name) => [
      name,
      actions.filter((action) => action.action === name).length,
    ]),
  )
  for (const name of task.required_actions)
    require((coverage[name] ?? 0) > 0, 'missing_action:' + name)
  require(!actions.some((action) => action.unresolved), 'missing_sent_action_binding')
  const expected = task.expected
  for (const key of ['checked', 'mouse_down_count', 'mouse_up_count', 'doubleclick_count'])
    if (key in expected) require(final?.[key] === expected[key], 'fixture_' + key)
  if (task.id === 'hover') {
    require(final.mouse_enter_count > initial.mouse_enter_count, 'no_new_mouse_enter')
    require((final.click_count ?? 0) === 0, 'hover_was_clicked')
  }
  if (task.id === 'scroll') {
    require(final.scroll?.bottom_visible === true, 'not_at_document_bottom')
    require(final.scroll?.first_visible_line >
      initial.scroll?.first_visible_line, 'no_scroll_progress')
    require(final.scroll?.native_scroll_count >
      initial.scroll?.native_scroll_count, 'no_native_wheel_event')
    require(!actions.some(
      (action) => action.action === 'hotkey' || action.action === 'paste',
    ), 'scroll_used_keyboard_or_text_input')
    if (Number.isInteger(initial.scroll?.line_count))
      require(final.scroll?.line_count === initial.scroll.line_count, 'scroll_document_was_changed')
  }
  if (expected.fields)
    for (const [name, value] of Object.entries(expected.fields))
      require(final.fields?.[name] === value, 'field_' + name + '_not_exact')
  if (expected.minimum_pastes)
    require((coverage.paste ?? 0) >= expected.minimum_pastes, 'insufficient_paste_actions')
  if (task.id === 'replace_undo_redo') {
    require(initial.fields?.revision === expected.initial_revision, 'revision_initial_text')
    require(final.fields?.revision === expected.final_revision, 'revision_final_text')
    const texts = (final.events ?? [])
      .filter(
        (event) =>
          event.seq > initial.sequence &&
          event.type === 'text_changed' &&
          event.control === 'revision',
      )
      .map((event) => event.value)
    let at = 0
    for (const text of texts) if (text === expected.text_sequence[at]) at++
    require(at === expected.text_sequence.length, 'replacement_undo_redo_text_sequence')
    for (const keys of expected.required_hotkeys)
      require(actions.some(
        (action) => action.action === 'hotkey' && action.keys === keys,
      ), 'missing_hotkey:' + keys)
    require((final.events ?? []).some(
      (event) => event.type === 'undo_keydown',
    ), 'no_fixture_undo_keydown')
    require((final.events ?? []).some(
      (event) => event.type === 'redo_keydown',
    ), 'no_fixture_redo_keydown')
  }
  return { passed: errors.length === 0, errors, coverage }
}
