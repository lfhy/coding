/** 把当前会话图库的图片复制进演示稿工程；附件身份由图库服务复核。@module coding-tool-ppt/gallery-image */
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-agent'
import type {} from 'coding-image-gen'
import { defineTool } from 'coding-tools'
import type { ObjectValueSchemaSpec } from 'coding-tools'
import type { PptProjectsFace } from './index.ts'

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

/**
 * 注册图库到工程媒体的工具；只复制字节，不编辑页面，冲突后的未引用媒体可留在工程。
 * @param ctx - 提供工具注册表和可选图库服务的作用域。
 * @param projects - 工程服务；上传仍由服务端验证格式、大小及工程目录。
 * @returns 无返回值；注册随所属作用域释放。
 */
export function registerGalleryImageTool(ctx: Context, projects: () => PptProjectsFace): void {
  const output = {
    type: 'object', additionalProperties: false,
    properties: { source: { type: 'string', required: true } },
  } as const satisfies ObjectValueSchemaSpec
  ctx.tools.register(defineTool({
    name: 'ppt_attach_gallery_image',
    description: 'Copy an image from this session gallery into the open presentation project. '
      + 'Pass the gallery image ID returned by generate_image or edit_image, not an attachment ID or a path. '
      + 'Returns a media source; use ppt_read to locate a page and ppt_edit with base_revision to place '
      + 'an image element. This does not change the deck or insert an image automatically.',
    parameters: {
      imageId: { type: 'string', required: true, description: 'Image ID from this session gallery.' },
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
    },
    output: { schema: output, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error('此工具需要当前会话')
      const images = ctx.get('imageGeneration')
      if (!images) throw new Error('当前无法读取会话图库')
      const stored = await images.readImage(session.events, args.imageId)
      if (!stored) throw new Error('当前会话找不到这张图片，请先生成或选择图库图片')
      const ext = EXTENSIONS[stored.ref.mediaType]
      if (!ext) throw new Error('图片格式不受支持')
      const source = await projects().upload(session.header.id, args.dir, `gallery.${ext}`, stored.data)
      return { source }
    },
    presentCall: () => ({ card: 'generic', title: 'Add gallery image', kind: 'other' }),
  }))
}
