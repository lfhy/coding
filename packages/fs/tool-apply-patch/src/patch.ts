/**
 * Parser and applier for the Codex patch envelope (`*** Begin Patch` … `*** End Patch`).
 *
 * Pure text transformation: no filesystem access, no Cordis, so the grammar can be
 * unit-tested alone and the executor owns every side effect. The subset implemented
 * here is the Codex grammar minus the two operations a filesystem seam without a
 * delete primitive cannot honour — `*** Delete File` and `*** Move to` are parsed
 * and then refused by the executor with a model-facing diagnostic.
 *
 * @module coding-tool-apply-patch/patch
 */

/** One hunk of an Update File section. */
export interface PatchHunk {
  /** Optional `@@ <context>` anchor; the hunk's lines must match after that line. */
  readonly context?: string
  /** Lines the file must already contain, in order. */
  readonly oldLines: readonly string[]
  /** Replacement lines written in place of {@link oldLines}. */
  readonly newLines: readonly string[]
  /** `*** End of File`: the hunk must anchor at the end of the file. */
  readonly endOfFile?: boolean
}

/** One file section of a parsed patch. */
export type PatchFile =
  | { readonly kind: 'add'; readonly path: string; readonly content: string }
  | { readonly kind: 'update'; readonly path: string; readonly hunks: readonly PatchHunk[]; readonly moveTo?: string }
  | { readonly kind: 'delete'; readonly path: string }

/** One parsed patch envelope. */
export interface ParsedPatch {
  readonly files: readonly PatchFile[]
}

/** A patch the parser or applier refused, with a model-facing reason. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const UPDATE = '*** Update File: '
const DELETE = '*** Delete File: '
const MOVE = '*** Move to: '
const END_OF_FILE = '*** End of File'

/** Whether one trimmed line opens a new file section. */
function isSectionHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(UPDATE) || line.startsWith(DELETE)
}

/** Split the patch into trimmed-end lines, tolerating surrounding blank lines. */
function envelopeLines(patchText: string): string[] {
  const lines = patchText.replaceAll('\r\n', '\n').split('\n')
  const first = lines.findIndex(line => line.trim().length > 0)
  if (first < 0) throw new PatchError('the patch is empty')
  if (lines[first]?.trim() !== BEGIN) {
    throw new PatchError(`the patch must start with "${BEGIN}"`)
  }
  const lastFilled = lines.findLastIndex(line => line.trim().length > 0)
  if (lastFilled < 0 || lines[lastFilled]?.trim() !== END) {
    throw new PatchError(`the patch must end with "${END}"`)
  }
  return lines.slice(first + 1, lastFilled)
}

/** Require a non-empty operand for one section header. */
function operand(header: string, line: string): string {
  const value = line.slice(header.length).trim()
  if (value.length === 0) throw new PatchError(`"${header.trim()}" needs a file path`)
  return value
}

/**
 * Parse one Codex patch envelope.
 * @param patchText - the raw tool input, already known to be text.
 * @returns the file sections in patch order.
 * @throws {PatchError} naming the violated structural rule; the message is
 *   returned to the model verbatim after the tool's own prefix.
 */
export function parsePatch(patchText: string): ParsedPatch {
  const lines = envelopeLines(patchText)
  const files: PatchFile[] = []
  let index = 0
  while (index < lines.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      index++
      continue
    }
    if (trimmed.startsWith(ADD)) {
      const path = operand(ADD, trimmed)
      index++
      const content: string[] = []
      while (index < lines.length) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
        const body = lines[index]!
        if (isSectionHeader(body.trim()) || body.trim() === END) break
        if (!body.startsWith('+')) {
          throw new PatchError(`every "${ADD.trim()}" line must start with "+" (${path})`)
        }
        content.push(body.slice(1))
        index++
      }
      files.push({ kind: 'add', path, content: content.join('\n') + (content.length > 0 ? '\n' : '') })
      continue
    }
    if (trimmed.startsWith(DELETE)) {
      files.push({ kind: 'delete', path: operand(DELETE, trimmed) })
      index++
      continue
    }
    if (trimmed.startsWith(UPDATE)) {
      const path = operand(UPDATE, trimmed)
      index++
      let moveTo: string | undefined
      if (index < lines.length && lines[index]?.trim().startsWith(MOVE)) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by the bounds check above
        moveTo = operand(MOVE, lines[index]!.trim())
        index++
      }
      const hunks: PatchHunk[] = []
      while (index < lines.length) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
        const candidate = lines[index]!
        const marker = candidate.trim()
        if (isSectionHeader(marker) || marker === END) break
        if (marker === '') {
          index++
          continue
        }
        if (!marker.startsWith('@@')) {
          throw new PatchError(`unexpected line in "${UPDATE.trim()}" section for ${path}: ${JSON.stringify(candidate)}`)
        }
        const context = marker === '@@' ? undefined : marker.slice(2).trim()
        index++
        const oldLines: string[] = []
        const newLines: string[] = []
        let endOfFile = false
        while (index < lines.length) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
          const body = lines[index]!
          const bodyMarker = body.trim()
          if (bodyMarker === END_OF_FILE) {
            endOfFile = true
            index++
            break
          }
          if (bodyMarker.startsWith('@@') || isSectionHeader(bodyMarker) || bodyMarker === END) break
          const prefix = body.charAt(0)
          if (prefix === '+') newLines.push(body.slice(1))
          else if (prefix === '-') oldLines.push(body.slice(1))
          else if (prefix === ' ') {
            oldLines.push(body.slice(1))
            newLines.push(body.slice(1))
          } else if (bodyMarker === '') {
            // A bare empty line inside a hunk is context with no leading space.
            oldLines.push('')
            newLines.push('')
          } else {
            throw new PatchError(`every hunk line must start with " ", "-", or "+" (${path}): ${JSON.stringify(body)}`)
          }
          index++
        }
        if (oldLines.length === 0 && newLines.length === 0) {
          throw new PatchError(`the hunk for ${path} has no lines`)
        }
        hunks.push({
          ...context === undefined || context === '' ? {} : { context },
          oldLines,
          newLines,
          ...endOfFile ? { endOfFile: true } : {},
        })
      }
      if (hunks.length === 0) {
        throw new PatchError(`the "${UPDATE.trim()}" section for ${path} has no hunk; use "${ADD.trim()}" to create a file`)
      }
      files.push({ kind: 'update', path, hunks, ...moveTo === undefined ? {} : { moveTo } })
      continue
    }
    throw new PatchError(`unexpected line: ${JSON.stringify(candidate(line))}`)
  }
  if (files.length === 0) throw new PatchError('the patch contains no file section')
  return { files }
}

/** Render one offending line for a diagnostic without echoing an unbounded value. */
function candidate(line: string): string {
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

/**
 * Apply every hunk of one Update File section to its current text.
 * Hunks apply in order against a moving cursor, which is what lets several
 * `@@` sections in one file stay independent of each other.
 * @param path - the model-facing path, used in diagnostics.
 * @param content - the file's current text.
 * @param hunks - parsed hunks in patch order.
 * @returns the new file text.
 * @throws {PatchError} when a hunk no longer matches, naming the failed lines.
 */
export function applyPatchHunks(path: string, content: string, hunks: readonly PatchHunk[]): string {
  const hadTrailingNewline = content.endsWith('\n')
  const lines = hadTrailingNewline ? content.slice(0, -1).split('\n') : content.split('\n')
  let cursor = 0
  for (const hunk of hunks) {
    const anchor = hunk.context === undefined ? cursor : findLine(lines, hunk.context, cursor)
    if (anchor === undefined) {
      throw new PatchError(`the hunk context ${JSON.stringify(hunk.context)} was not found in ${path}`)
    }
    const start = hunk.context === undefined ? cursor : anchor + 1
    const match = findSequence(lines, hunk.oldLines, start)
    if (match === undefined) {
      throw new PatchError(
        `the hunk does not match ${path}; expected these lines:\n${hunk.oldLines.join('\n')}`,
      )
    }
    if (hunk.endOfFile === true && match + hunk.oldLines.length !== lines.length) {
      throw new PatchError(`the hunk marked "${END_OF_FILE}" does not reach the end of ${path}`)
    }
    lines.splice(match, hunk.oldLines.length, ...hunk.newLines)
    cursor = match + hunk.newLines.length
  }
  const joined = lines.join('\n')
  return hadTrailingNewline || hunks.some(hunk => hunk.newLines.length > 0) ? `${joined}\n` : joined
}

/** Locate the first line equal to `needle` at or after `from`. */
function findLine(lines: readonly string[], needle: string, from: number): number | undefined {
  for (let index = Math.max(0, from); index < lines.length; index++) {
    if (lines[index] === needle) return index
  }
  return undefined
}

/** Locate the first contiguous occurrence of `sequence` at or after `from`. */
function findSequence(lines: readonly string[], sequence: readonly string[], from: number): number | undefined {
  if (sequence.length === 0) return Math.min(Math.max(0, from), lines.length)
  const limit = lines.length - sequence.length
  for (let index = Math.max(0, from); index <= limit; index++) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) return index
  }
  return undefined
}
