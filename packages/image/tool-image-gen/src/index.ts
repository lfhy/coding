/** 模型图像工具：标准三工具或 Codex 单工具，注册选择严格互斥。@module coding-tool-image-gen */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from 'coding-tools'
import type { ContentBlock } from 'coding-llm'
import type { GalleryItem } from 'coding-image-gen'
import { summarizeCanvas } from './canvas.ts'

/** 工具注册是当前 Agent 作用域内的效果。 */
export const name = 'tool-image-gen'
export const inject = ['tools', 'imageGeneration']

/** Codex 单工具和普通三工具只可择一。 */
export interface Config {
  /** 默认 standard；codex 只注册 `image_gen`，不注册标准工具。 */
  variant?: 'standard' | 'codex'
}
export const Config: z<Config> = z.object({ variant: z.union(['standard', 'codex']).default('standard') })

const promptParam = { type: 'string', required: true, description: 'Describe the image to create or edit.' } as const
const itemOutput = { type: 'object', additionalProperties: true } as const
const result = (item: GalleryItem): Record<string, string | number> => ({
  id: item.id, attachmentId: item.attachmentId, prompt: item.prompt,
  model: item.model, createdAt: item.createdAt, bytes: item.bytes,
  mediaType: item.mediaType, width: item.width, height: item.height,
  ...item.sourceImageId === undefined ? {} : { sourceImageId: item.sourceImageId },
})
/** 成功图像以持久引用进入工具结果，会话回放和后续模型请求均可重建该图片。 */
function renderItem(item: Record<string, unknown>): ContentBlock[] {
  if (typeof item.id !== 'string' || typeof item.attachmentId !== 'string'
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mediaType))
    || typeof item.bytes !== 'number' || typeof item.width !== 'number' || typeof item.height !== 'number') {
    throw new TypeError('生成图像的附件元数据无效')
  }
  return [
    { type: 'text', text: `Image created. ID: ${item.id}. Use this session's gallery to view it.` },
    { type: 'image', attachment: { attachmentId: item.attachmentId as never,
      mediaType: item.mediaType as 'image/png', bytes: item.bytes, width: item.width, height: item.height } },
  ]
}

/** 仅使用当前调用的 Agent Session，不从模型参数采纳 sessionId。 */
function registerVariant(
  ctx: Context, config: Config,
  register: (definition: Parameters<Context['tools']['register']>[0]) => void,
): void {
  if (config.variant === 'codex') {
    register(defineTool({
      name: 'image_gen',
      description: 'Generate or edit an image in this session. Recent images may be used as references; filesystem paths are not accepted.',
      parameters: {
        prompt: promptParam,
        transparent_background: { type: 'boolean', description: 'True is unsupported by this image provider.' },
        referenced_image_paths: { type: 'array', items: { type: 'string' }, description: 'Unsupported: local paths cannot be used as references.' },
        num_last_images_to_include: { type: 'integer', description: 'Use 1 to 10 most recent images in this session as references.' },
      },
      output: { schema: itemOutput, render: (_args, item) => renderItem(item) },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (!session) throw new Error('This image tool requires an active session.')
        if (args.referenced_image_paths !== undefined) {
          throw new Error('Local image paths are not supported. Use num_last_images_to_include for this session’s gallery.')
        }
        if (args.transparent_background === true) {
          throw new Error('Transparent background is not supported by the configured image service.')
        }
        const count = args.num_last_images_to_include
        const sources = count === undefined ? [] : ctx.imageGeneration.latestImages(session.events, count).map(image => image.id)
        if (count !== undefined && sources.length !== count) throw new Error('This session does not have enough recent images.')
        return result(await ctx.imageGeneration.create(session, args.prompt, sources, exec.signal))
      },
    }))
    return
  }
  register(defineTool({
    name: 'generate_image',
    description: 'Generate one image and save it to this session’s gallery.',
    parameters: { prompt: promptParam },
    output: { schema: itemOutput, render: (_args, item) => renderItem(item) },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('This image tool requires an active session.')
      return result(await ctx.imageGeneration.create(exec.agent.session, args.prompt, [], exec.signal))
    },
  }))
  register(defineTool({
    name: 'generate_images',
    description: 'Generate up to 10 images; each item succeeds or fails independently.',
    parameters: { prompts: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value): ContentBlock[] => {
        const images = Array.isArray(value.images) ? value.images : []
        const failures = Array.isArray(value.failures) ? value.failures : []
        const blocks: ContentBlock[] = [{ type: 'text', text: `${images.length} images created; ${failures.length} failed.` }]
        for (const image of images) {
          if (!image || typeof image !== 'object' || Array.isArray(image)) throw new TypeError('批次图片元数据无效')
          blocks.push(...renderItem(image))
        }
        return blocks
      } },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('This image tool requires an active session.')
      if (args.prompts.length < 1 || args.prompts.length > 10) throw new Error('Provide 1 to 10 prompts.')
      const images: (Record<string, string | number> & { index: number })[] = []
      const failures: { index: number; error: string }[] = []
      for (const [index, prompt] of args.prompts.entries()) {
        exec.signal.throwIfAborted()
        try { images.push({ index, ...result(await ctx.imageGeneration.create(exec.agent.session, prompt, [], exec.signal)) }) }
        catch (error) {
          exec.signal.throwIfAborted()
          failures.push({ index, error: error instanceof Error && error.constructor.name === 'ImageGenerationUnavailableError'
            ? 'Image generation is unavailable. Check settings and credentials.' : 'Image generation failed for this item.' })
        }
      }
      return { images, failures }
    },
  }))
  register(defineTool({
    name: 'canvas_state',
    description: 'Read the current session canvas node summary, including image IDs usable with edit_image. Brush pixels are not visible.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) {
      if (!exec.agent) return Promise.reject(new Error('This canvas tool requires an active session.'))
      return Promise.resolve(summarizeCanvas(ctx.imageGeneration.canvas(exec.agent.session.events)))
    },
  }))
  register(defineTool({
    name: 'edit_image',
    description: 'Edit an image in this session’s gallery using a text prompt.',
    parameters: { prompt: promptParam, imageId: { type: 'string', required: true, description: 'ID of an image in this session’s gallery.' } },
    output: { schema: itemOutput, render: (_args, item) => renderItem(item) },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('This image tool requires an active session.')
      return result(await ctx.imageGeneration.create(exec.agent.session, args.prompt, [args.imageId], exec.signal))
    },
  }))
}

/** 注册可用的工具集合；任一注册失败时撤销已完成的注册。 */
function registerImageTools(ctx: Context, config: Config): () => void {
  const releases: (() => void)[] = []
  const release = (): void => { for (const dispose of releases.splice(0).reverse()) dispose() }
  try {
    registerVariant(ctx, config, (definition) => { releases.push(ctx.tools.register(definition)) })
  } catch (error) {
    release()
    throw error
  }
  return release
}

/**
 * 仅在图像服务可用时向当前 Agent 作用域注册画图工具；配置与凭据提交后重新判定。
 * 工具执行仍由图像服务再次检查，避免设置变动与调用之间的竞态。
 * @param ctx - 拥有工具注册效果的上下文。
 * @param config - 标准模式或 Codex 模式的互斥工具集合。
 * @returns 首次可用性判定完成后结算。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  let generation = 0
  let disposed = false
  let releaseTools: (() => void) | undefined

  const refresh = async (): Promise<void> => {
    const current = ++generation
    let available = false
    try {
      available = (await ctx.imageGeneration.status()).available
    } catch (error) {
      ctx.logger.warn('tool-image-gen: image availability check failed; omitting tools', error)
    }
    if (disposed || current !== generation || available === (releaseTools !== undefined)) return
    releaseTools?.()
    releaseTools = available ? registerImageTools(ctx, config) : undefined
  }
  const refreshOnChange = (): void => {
    void refresh().catch((error: unknown) => {
      ctx.logger.warn('tool-image-gen: failed to update image tools', error)
    })
  }

  ctx.effect(() => () => {
    disposed = true
    generation++
    releaseTools?.()
    releaseTools = undefined
  }, 'tool-image-gen: availability and registrations')
  ctx.effect(() => ctx.imageGeneration.watchAvailability(refreshOnChange), 'tool-image-gen: availability notifications')
  await refresh()
}
