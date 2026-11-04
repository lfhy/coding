/**
 * `subset-font` 没有自带类型声明；这里只声明本包用到的调用形状。
 * @module coding-ppt-workbench/subset-font
 */
declare module 'subset-font' {
  /**
   * 按指定字符把字体子集化。
   * @param font - 原始字体字节。
   * @param text - 需要保留的字符。
   * @param options - 目标格式等选项。
   * @returns 子集字体字节。
   */
  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype' },
  ): Promise<Buffer>
}
