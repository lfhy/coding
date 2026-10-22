/**
 * 内置渠道的只读卡片：连接事实与模型目录都由应用发布，这里只呈现 Host 当前为该
 * 路由服务的模型及其能力，不提供任何写入入口——端点、密钥、名称与模型都由
 * 提供方插件维护。
 */

import type { ReactNode } from 'react'
import type { CatalogModel } from './store.ts'
import { IconCheckOutline14, IconCloseOutline16, IconQuestionOutline14 } from 'coding-client-ui-icons'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** 一个能力声明在只读表格里的三态，与可编辑表格的徽标一致。 */
type Capability = 'supported' | 'unsupported' | 'unknown'

/** Props of {@link BuiltinChannelCard}. */
export interface BuiltinChannelCardProps {
  /** Host 当前为该路由服务的模型；目录读取失败时为空表。 */
  models: readonly CatalogModel[]
  /** 目录读取失败的诊断；读取成功（含空目录）时为 undefined。 */
  failure?: string
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** 视觉能力：wire 只在提供方声明了输入模态时回答，字段缺席表示未声明。 */
function visionCapability(model: CatalogModel): Capability {
  if (model.inputModalities === undefined) return 'unknown'
  return model.inputModalities.includes('image') ? 'supported' : 'unsupported'
}

/**
 * 推理档位：wire 只在模型提供可选档位时带上 `reasoning`，因此字段缺席表示
 * 该模型按提供方默认行为推理，而不是不能推理。
 */
function reasoningLevels(model: CatalogModel): readonly string[] {
  return (model.reasoning?.efforts ?? []).map(effort => effort.name)
}

/** 一个能力徽标：图标加可访问名称，只读表格里没有任何可点区域。 */
function CapabilityBadge(props: { capability: Capability; t: (key: keyof typeof en) => string }): ReactNode {
  const { capability, t } = props
  const label = t(capability === 'supported'
    ? 'visionSupport'
    : capability === 'unsupported' ? 'visionUnsupported' : 'visionUnspecified')
  return (
    <span role="img" aria-label={label} title={label}
      className={`${styles['capabilityBadge']} ${capability === 'supported'
        ? styles['capabilitySupported'] : capability === 'unknown' ? styles['capabilityUnknown'] : styles['capabilityUnsupported']}`}>
      <span aria-hidden="true">{capability === 'supported' ? <IconCheckOutline14 size={14} />
        : capability === 'unsupported' ? <IconCloseOutline16 size={14} /> : <IconQuestionOutline14 size={14} />}</span>
      <span className={styles['hiddenLabel']}>{label}</span>
    </span>
  )
}

/**
 * 绘制一条内置渠道的只读目录。外层间距由调用方的渠道字段容器提供，
 * 因此这里只返回字段内容本身。
 * @param props - Host 当前服务的模型、可选失败诊断与文案。
 * @returns 带诊断与空状态的只读模型表格。
 */
export function BuiltinChannelCard(props: BuiltinChannelCardProps): ReactNode {
  const { models, failure, t } = props
  return (
    <>
      {failure === undefined ? null : <p className={styles['error']}>
        {`${t('builtinChannelCatalogFailed')}: ${failure}`}
      </p>}
      {models.length === 0
        ? failure === undefined ? <p className={styles['modelEmpty']}>{t('builtinChannelEmpty')}</p> : null
        : (
          <div className={styles['modelTableScroller']} role="region" aria-label={t('models')} tabIndex={0}>
            <div className={`${styles['modelTableHead']} ${styles['builtinModelRow']}`} aria-hidden="true">
              <span>{t('modelId')}</span>
              <span>{t('modelName')}</span>
              <span title={t('visionSupport')}>{t('modelVisionColumn')}</span>
              <span title={t('reasoningLevels')}>{t('modelReasoningColumn')}</span>
            </div>
            <div className={styles['modelList']}>{models.map((model) => {
              const levels = reasoningLevels(model)
              return (
                <div key={model.id} className={styles['modelEntry']}>
                  <div className={`${styles['modelRow']} ${styles['builtinModelRow']}`}>
                    <span className={styles['builtinModelId']}>{model.id}</span>
                    <span className={styles['builtinModelName']}>{model.name}</span>
                    <CapabilityBadge capability={visionCapability(model)} t={t} />
                    <span className={styles['builtinReasoning']}>{levels.length === 0
                      ? <span className={styles['builtinMuted']}>{t('reasoningProviderDefault')}</span>
                      : levels.map(level => <span key={level} className={styles['reasoningChip']}>{level}</span>)}</span>
                  </div>
                </div>
              )
            })}</div>
          </div>
        )}
    </>
  )
}
