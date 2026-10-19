/** Card-aware output body for the selected Tool call in details. */
import { DiffBlock, ReadBlock, SearchBlock, TerminalBlock, WebBlock } from 'coding-client-ui-primitives'
import type { ToolDetailsProps } from '../contract/slots.ts'
import { ToolResultImages } from './components/ToolResultImages.tsx'
import { diffCardModel } from './models/diff-card-model.ts'
import { readCardModel } from './models/read-card-model.ts'
import { searchCardModel } from './models/search-card-model.ts'
import { terminalBlockLabels, terminalCardModel } from './models/terminal-card-model.ts'
import { resultText } from './models/tool-call-model.ts'
import { imageAttachmentsIn } from './models/tool-result-images.ts'
import { webCardModel } from './models/web-card-model.ts'
import css from './ToolDetails.module.css'

/** Render selected Tool output and any returned images. */
export function ToolDetails({ block, cwd, useHostDescription, loadImage, t }: Pick<ToolDetailsProps, 'block' | 'cwd' | 'useHostDescription' | 't'> & { loadImage?: ((attachment: import('coding-attachment').ImageAttachmentRef) => Promise<string>) | undefined }) {
  const home = useHostDescription(description => description?.home)
  const images = 'kind' in block ? imageAttachmentsIn(block.content) : []
  const toolImages = loadImage !== undefined && images.length > 0 ? <ToolResultImages images={images} loadImage={loadImage} t={t} /> : null
  const terminal = terminalCardModel(block, cwd)
  if (terminal !== null) {
    return (
      <>
        {terminal.description !== undefined ? (
          <div className={css.description}>{terminal.description}</div>
        ) : null}
        {toolImages}
        <TerminalBlock {...terminal.card} labels={terminalBlockLabels(t)} className={css.cardBody} />
      </>
    )
  }
  const read = readCardModel(block, cwd, home)
  if (read !== null) return <>{toolImages}<ReadBlock {...read} className={css.read} /></>
  const diff = diffCardModel(block)
  if (diff !== null) return <>{toolImages}<DiffBlock {...diff.card} className={css.cardBody} /></>
  const search = searchCardModel(block)
  if (search !== null) {
    return (
      <>
        {toolImages}
        <SearchBlock {...search.card} className={css.cardBody} />
        {search.recovery !== undefined ? <div className={css.recovery}>{search.recovery}</div> : null}
      </>
    )
  }
  const web = webCardModel(block)
  if (web !== null) {
    const body = 'kind' in block ? resultText(block) : ''
    return (
      <>
        {toolImages}
        <WebBlock {...web} className={css.web} />
        {body !== '' ? <pre className={css.code}>{body}</pre> : null}
      </>
    )
  }
  if (!('kind' in block)) return <>{toolImages}<div className={css.empty}>{t('details.running')}</div></>
  return (
    <>
      {toolImages}
      <pre className={css.code} data-error={block.isError || undefined}>
        {resultText(block)}
      </pre>
    </>
  )
}
