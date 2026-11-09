/**
 * 默认整稿模板：按参考稿的白底、左上标题、细分隔线与页脚坐标组织可编辑页面。
 * 只保留可替换内容和可编辑元素，不分发源稿的正文或讲者备注。
 */
import { newId, PPT_FORMAT, type PptDeck, type PptElement, type PptPage } from 'coding-ppt-model'

const COLORS = {
  background: '#ffffff', surface: '#f4f3ef', text: '#16181d', secondary: '#33363d',
  muted: '#6b6f76', blue: '#1d4ed8', orange: '#c2410c', border: '#e2e0d9',
} as const
const FONT = 'Arial'

type Frame = { x: number; y: number; w: number; h: number }

function text(content: string, box: Frame, size: number, color: string, bold = false,
  align: 'left' | 'right' = 'left'): PptElement {
  return { id: newId(), kind: 'text', ...box,
    text: { content, size, color, bold, align, valign: 'top', font: FONT } }
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
    text(`${String(index).padStart(2, '0')} / ${section}`, { x: 95, y: 55, w: 880, h: 28 }, 18, COLORS.muted),
    text(title, { x: 94, y: 81, w: 1088, h: 68 }, 44, COLORS.text, true),
    line(96, 150, 1088, COLORS.text),
    text('演示文稿标题', { x: 95, y: 667, w: 860, h: 23 }, 15, COLORS.muted),
    text(`${String(index).padStart(2, '0')} / 06`, { x: 1130, y: 667, w: 54, h: 23 }, 15, COLORS.muted, false, 'right'),
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
        text('主题 / 汇报', { x: 95, y: 179, w: 500, h: 28 }, 18, COLORS.muted),
        text(title, { x: 94, y: 231, w: 1088, h: 110 }, 72, COLORS.text, true),
        line(96, 414, 1088, COLORS.text),
        text('在这里填写一句话概述', { x: 95, y: 441, w: 1088, h: 46 }, 30, COLORS.secondary),
        text('在这里补充一条说明', { x: 95, y: 495, w: 1088, h: 43 }, 28, COLORS.secondary),
        text('汇报人 · 日期', { x: 95, y: 651, w: 600, h: 23 }, 15, COLORS.muted),
        text('01 / 06', { x: 1130, y: 651, w: 54, h: 23 }, 15, COLORS.muted, false, 'right'),
      ]),
      page('核心观点', [
        ...frame('核心观点', '这里写本页结论', 2),
        text('一句话讲清核心观点', { x: 95, y: 195, w: 1088, h: 68 }, 44, COLORS.blue, true),
        rect({ x: 96, y: 280, w: 440, h: 150 }, COLORS.surface),
        text('补充一个关键事实或例子', { x: 119, y: 316, w: 400, h: 42 }, 24, COLORS.secondary),
        text('用简短说明承接结论', { x: 119, y: 370, w: 400, h: 38 }, 22, COLORS.muted),
        text('第二个可比较的要点', { x: 599, y: 310, w: 500, h: 42 }, 24, COLORS.secondary),
        text('补充一条判断依据', { x: 599, y: 366, w: 500, h: 38 }, 22, COLORS.muted),
        text('本页结论或下一步', { x: 95, y: 565, w: 1088, h: 43 }, 24, COLORS.orange, true),
      ]),
      page('双栏对比', [
        ...frame('对比', '两个角度，一眼看懂', 3),
        rect({ x: 96, y: 200, w: 526, h: 250 }, COLORS.surface),
        rect({ x: 658, y: 200, w: 526, h: 250 }, COLORS.surface),
        rect({ x: 96, y: 200, w: 526, h: 3 }, COLORS.blue),
        rect({ x: 658, y: 200, w: 526, h: 3 }, COLORS.orange),
        text('第一种情况', { x: 119, y: 232, w: 460, h: 50 }, 28, COLORS.text, true),
        text('写下第一个要点\n补充一条简短说明', { x: 119, y: 312, w: 460, h: 102 }, 24, COLORS.secondary),
        text('第二种情况', { x: 681, y: 232, w: 460, h: 50 }, 28, COLORS.text, true),
        text('写下第二个要点\n补充一条简短说明', { x: 681, y: 312, w: 460, h: 102 }, 24, COLORS.secondary),
        line(96, 490, 1088),
        text('用一句话说明对比的结论', { x: 95, y: 519, w: 1088, h: 42 }, 24, COLORS.blue, true),
      ]),
      page('分步说明', [
        ...frame('流程', '从起点到结果', 4),
        ...[0, 1, 2].flatMap((index) => {
          const x = 96 + index * 374
          return [
            rect({ x, y: 200, w: 326, h: 155 }, COLORS.surface),
            rect({ x, y: 200, w: 326, h: 3 }, index === 1 ? COLORS.orange : COLORS.blue),
            text(`0${index + 1}`, { x: x + 20, y: 215, w: 60, h: 28 }, 18, index === 1 ? COLORS.orange : COLORS.blue),
            text(['第一步', '第二步', '第三步'].at(index) ?? '',
              { x: x + 20, y: 245, w: 280, h: 42 }, 24, COLORS.text, true),
            text('说明这一步的重点', { x: x + 20, y: 300, w: 280, h: 38 }, 18, COLORS.secondary),
          ]
        }),
        line(96, 396, 1088),
        text('补充步骤之间的关系与判断依据', { x: 95, y: 430, w: 1088, h: 45 }, 24, COLORS.secondary),
        rect({ x: 96, y: 550, w: 1088, h: 76 }, COLORS.surface),
        text('这里写串起三步的结论', { x: 119, y: 565, w: 1040, h: 42 }, 24, COLORS.text),
      ]),
      page('数据聚焦', [
        ...frame('数据', '用数字支撑结论', 5),
        text('关键指标', { x: 95, y: 200, w: 480, h: 38 }, 18, COLORS.muted),
        text('填写数据', { x: 94, y: 230, w: 600, h: 85 }, 56, COLORS.blue, true),
        text('说明统计口径和时间范围', { x: 95, y: 330, w: 600, h: 42 }, 24, COLORS.secondary),
        text('对比指标', { x: 699, y: 200, w: 480, h: 38 }, 18, COLORS.muted),
        text('填写对比', { x: 699, y: 230, w: 480, h: 85 }, 56, COLORS.orange, true),
        text('补充变化原因', { x: 699, y: 330, w: 480, h: 42 }, 24, COLORS.secondary),
        rect({ x: 96, y: 465, w: 1088, h: 100 }, COLORS.surface),
        text('这里写数字背后的结论', { x: 119, y: 482, w: 1040, h: 44 }, 26, COLORS.text, true),
        text('数据来源：请填写', { x: 95, y: 593, w: 1088, h: 35 }, 18, COLORS.muted),
      ]),
      page('结论与下一步', [
        ...frame('收束', '把重点带走', 6),
        ...[0, 1, 2].flatMap(index => [
          line(96, 202 + index * 105, 604),
          text(['第一条结论', '第二条结论', '第三条结论'].at(index) ?? '',
            { x: 95, y: 218 + index * 105, w: 604, h: 43 }, 28, COLORS.text, true),
          text('补充一句简短说明', { x: 95, y: 260 + index * 105, w: 604, h: 34 }, 20, COLORS.orange),
        ]),
        text('下一步', { x: 779, y: 211, w: 360, h: 34 }, 18, COLORS.muted),
        text('列出可以直接执行的行动', { x: 779, y: 260, w: 400, h: 90 }, 26, COLORS.secondary),
        rect({ x: 96, y: 576, w: 1088, h: 56 }, COLORS.surface),
        text('用一句话收束整份演示', { x: 119, y: 588, w: 1040, h: 38 }, 24, COLORS.text, true),
      ]),
    ],
  }
}
