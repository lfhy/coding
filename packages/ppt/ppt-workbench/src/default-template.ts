/**
 * 默认整稿模板：从参考演示文稿提炼白底、蓝橘强调与页眉页脚节奏。
 * 只保留可替换内容和可编辑元素，不分发源稿的正文或讲者备注。
 */
import { newId, PPT_FORMAT, type PptDeck, type PptElement, type PptPage } from 'coding-ppt-model'

const COLORS = {
  background: '#ffffff', surface: '#f4f3ef', text: '#16181d', secondary: '#33363d',
  muted: '#6b6f76', blue: '#1d4ed8', orange: '#c2410c', border: '#e2e0d9',
} as const
const FONT = 'Arial'

type Frame = { x: number; y: number; w: number; h: number }

function text(content: string, box: Frame, size: number, color: string, bold = false): PptElement {
  return { id: newId(), kind: 'text', ...box,
    text: { content, size, color, bold, align: 'left', valign: 'middle', font: FONT } }
}

function rect(box: Frame, fill: string): PptElement {
  return { id: newId(), kind: 'rect', ...box, fill }
}

function line(x: number, y: number, w: number, color: string = COLORS.border, width = 2): PptElement {
  return { id: newId(), kind: 'line', x, y, w, h: 0, color, width }
}

function page(name: string, elements: PptElement[]): PptPage {
  return { id: newId(), name, background: null, transition: 'none', elements }
}

/** 常规页的固定页眉页脚可独立改字；设计无需外部媒体或母版解析。 */
function frame(section: string, title: string, index: number): PptElement[] {
  return [
    text(`${String(index).padStart(2, '0')} / ${section}`, { x: 96, y: 42, w: 880, h: 32 }, 18, COLORS.muted),
    text(title, { x: 96, y: 92, w: 1088, h: 76 }, 44, COLORS.text, true),
    line(96, 184, 1088),
    line(96, 668, 1088),
    text('演示文稿标题', { x: 96, y: 676, w: 860, h: 26 }, 15, COLORS.muted),
    text(`${String(index).padStart(2, '0')} / 06`, { x: 1080, y: 676, w: 104, h: 26 }, 15, COLORS.muted),
  ]
}

/**
 * 新建默认整稿；每次生成独立页面与元素 id，修改副本不会影响下一份稿。
 * @param title - 新工程标题；封面和文稿标题随之设置。
 * @returns 可编辑的白底 16:9 演示文稿，不含原稿业务数据。
 */
export function createDefaultDeck(title: string): PptDeck {
  return {
    format: PPT_FORMAT, title, size: '16:9', theme: 'inference', pages: [
      page('封面', [
        rect({ x: 96, y: 116, w: 8, h: 430 }, COLORS.blue),
        text('主题 / 汇报', { x: 136, y: 128, w: 900, h: 38 }, 18, COLORS.muted),
        text(title, { x: 136, y: 218, w: 1000, h: 116 }, 72, COLORS.text, true),
        text('在这里填写一句话概述', { x: 136, y: 362, w: 980, h: 62 }, 30, COLORS.secondary),
        line(136, 476, 180, COLORS.orange, 5),
        text('汇报人 · 日期', { x: 136, y: 500, w: 600, h: 40 }, 20, COLORS.muted),
        line(96, 668, 1088),
        text('01 / 06', { x: 1080, y: 676, w: 104, h: 26 }, 15, COLORS.muted),
      ]),
      page('核心观点', [
        ...frame('核心观点', '这里写本页结论', 2),
        text('一句话讲清核心观点', { x: 96, y: 222, w: 1088, h: 84 }, 42, COLORS.blue, true),
        rect({ x: 96, y: 338, w: 1088, h: 214 }, COLORS.surface),
        text('补充一个关键事实或例子', { x: 136, y: 376, w: 1008, h: 64 }, 30, COLORS.secondary),
        text('用简短说明承接上方结论', { x: 136, y: 458, w: 1008, h: 46 }, 24, COLORS.muted),
        text('本页结论或下一步', { x: 96, y: 588, w: 1088, h: 48 }, 28, COLORS.orange, true),
      ]),
      page('双栏对比', [
        ...frame('对比', '两个角度，一眼看懂', 3),
        rect({ x: 96, y: 228, w: 526, h: 328 }, COLORS.surface),
        rect({ x: 658, y: 228, w: 526, h: 328 }, COLORS.surface),
        rect({ x: 96, y: 228, w: 526, h: 7 }, COLORS.blue),
        rect({ x: 658, y: 228, w: 526, h: 7 }, COLORS.orange),
        text('第一种情况', { x: 128, y: 252, w: 452, h: 62 }, 32, COLORS.text, true),
        text('写下第一个要点\n补充一条简短说明', { x: 128, y: 336, w: 452, h: 148 }, 26, COLORS.secondary),
        text('第二种情况', { x: 690, y: 252, w: 452, h: 62 }, 32, COLORS.text, true),
        text('写下第二个要点\n补充一条简短说明', { x: 690, y: 336, w: 452, h: 148 }, 26, COLORS.secondary),
        text('用一句话说明对比的结论', { x: 96, y: 584, w: 1088, h: 54 }, 26, COLORS.blue, true),
      ]),
      page('分步说明', [
        ...frame('流程', '从起点到结果', 4),
        ...[0, 1, 2].flatMap((index) => {
          const x = 96 + index * 374
          return [
            text(`0${index + 1}`, { x, y: 240, w: 326, h: 92 }, 64, index === 1 ? COLORS.orange : COLORS.blue, true),
            line(x, 350, 326, index === 1 ? COLORS.orange : COLORS.blue, 4),
            text(['第一步', '第二步', '第三步'].at(index) ?? '', { x, y: 386, w: 326, h: 58 }, 32, COLORS.text, true),
            text('说明这一步的重点', { x, y: 462, w: 326, h: 82 }, 24, COLORS.secondary),
          ]
        }),
        rect({ x: 96, y: 588, w: 1088, h: 54 }, COLORS.surface),
        text('这里写串起三步的结论', { x: 120, y: 594, w: 1040, h: 42 }, 24, COLORS.text),
      ]),
      page('数据聚焦', [
        ...frame('数据', '用数字支撑结论', 5),
        text('关键指标', { x: 96, y: 248, w: 480, h: 44 }, 24, COLORS.muted),
        text('填写数据', { x: 96, y: 308, w: 600, h: 110 }, 64, COLORS.blue, true),
        text('说明统计口径和时间范围', { x: 96, y: 438, w: 600, h: 52 }, 24, COLORS.secondary),
        rect({ x: 716, y: 238, w: 468, h: 296 }, COLORS.surface),
        text('对比指标', { x: 748, y: 274, w: 400, h: 48 }, 24, COLORS.muted),
        text('填写对比', { x: 748, y: 348, w: 400, h: 78 }, 48, COLORS.orange, true),
        text('补充变化原因', { x: 748, y: 450, w: 400, h: 44 }, 24, COLORS.secondary),
        text('数据来源：请填写', { x: 96, y: 588, w: 1088, h: 42 }, 20, COLORS.muted),
      ]),
      page('结论与下一步', [
        ...frame('收束', '把重点带走', 6),
        rect({ x: 96, y: 224, w: 1088, h: 298 }, COLORS.surface),
        ...[0, 1, 2].flatMap(index => [
          text(`0${index + 1}`, { x: 132, y: 250 + index * 88, w: 94, h: 62 }, 38, COLORS.orange, true),
          text(['第一条结论', '第二条结论', '第三条结论'].at(index) ?? '',
            { x: 244, y: 250 + index * 88, w: 892, h: 62 }, 30, COLORS.text, true),
        ]),
        text('下一步：填写要采取的行动', { x: 96, y: 572, w: 1088, h: 66 }, 30, COLORS.blue, true),
      ]),
    ],
  }
}
