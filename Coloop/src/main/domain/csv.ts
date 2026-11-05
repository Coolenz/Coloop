/** Parse literal fields while retaining physical source lines, including quoted newlines. */
export function parseCsv(text: string, delimiter: string) {
  const rows: { cells: string[]; start_line: number; end_line: number }[] = []
  let cells: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  let line = 1
  let startLine = 1
  const finishField = () => {
    cells.push(field)
    field = ''
    closedQuote = false
  }
  const finishRow = () => {
    finishField()
    if (cells.length > 256 || rows.length >= 5001)
      throw new Error('CSV_EXCEEDS_SUPPORTED_DIMENSIONS')
    rows.push({ cells, start_line: startLine, end_line: line })
    cells = []
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
          closedQuote = true
        }
      } else {
        field += character
        if (character === '\n' || (character === '\r' && text[index + 1] !== '\n')) line++
      }
    } else if (character === delimiter) finishField()
    else if (character === '\r' || character === '\n') {
      finishRow()
      if (character === '\r' && text[index + 1] === '\n') index++
      line++
      startLine = line
    } else if (character === '"' && field === '' && !closedQuote) quoted = true
    else {
      if (closedQuote || character === '"') throw new Error('CSV_QUOTE_SYNTAX_INVALID')
      field += character
    }
  }
  if (quoted) throw new Error('CSV_QUOTE_NOT_CLOSED')
  if (field !== '' || cells.length || closedQuote) finishRow()
  return rows
}
